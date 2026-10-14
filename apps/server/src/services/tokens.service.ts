import { errors as joseErrors, SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

/**
 * Token strategy.
 *
 *  - Access token  : short-lived JWT (HS256, 15 min by default) sent as `Authorization: Bearer`.
 *                    Stateless so the API can scale horizontally; it carries the session id so
 *                    a revoked session is rejected on the next request (cheap cache lookup).
 *  - Refresh token : opaquely random (256 bits), stored only as a SHA-256 hash,
 *                    rotated on every use with reuse detection (token families).
 *  - Realtime ticket: very short-lived (60 s) signed token used to authenticate the WebSocket
 *                    handshake, because browsers cannot set headers on a WS upgrade request.
 *
 * No secret is ever logged or returned in a response body except the tokens themselves.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string; // user id
  sid: string; // session id
  roles?: string;
  typ: 'access';
}

export interface TicketClaims extends JWTPayload {
  sub: string;
  sid: string;
  did?: string; // device id
  typ: 'ws';
}

export interface MediaTokenClaims extends JWTPayload {
  sub: string;
  sid: string;
  typ: 'media';
  /** Media tokens are read-only: the file route is the only consumer. */
  scope: 'files:read';
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

const encoder = new TextEncoder();

function key(secret: string) {
  return encoder.encode(secret);
}

/**
 * jose reports expiry as `JWTExpired` whose *message* does not contain the word "expired"
 * ("\"exp\" claim timestamp check failed"), so class/code inspection is the reliable test.
 * Clients branch on `token_expired` to refresh and retry; getting this wrong made every
 * expired token look like a malformed one.
 */
function isExpiredError(err: unknown): boolean {
  return (
    err instanceof joseErrors.JWTExpired ||
    (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ERR_JWT_EXPIRED')
  );
}

export class TokenService {
  constructor(private readonly cfg: AppConfig) {}

  /**
   * A media token grants read access to files the user is already allowed to read, for a
   * very short window. It exists because browsers cannot attach headers to `<img>`, `<video>`
   * or `<a download>` requests; the API therefore accepts it as `?token=` on GET /files/:id
   * *only*. Session revocation still applies (the session id is re-checked server side).
   */
  async issueMediaToken(input: { userId: string; sessionId: string }): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.cfg.MEDIA_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: input.sessionId, typ: 'media', scope: 'files:read' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setIssuer('sovereign')
      .setAudience('sovereign-media')
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(key(this.cfg.secrets.accessTokenSecret));
    return { token, expiresAt };
  }

  async verifyMediaToken(token: string): Promise<MediaTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, key(this.cfg.secrets.accessTokenSecret), {
        issuer: 'sovereign',
        audience: 'sovereign-media',
      });
      if (payload.typ !== 'media' || payload.scope !== 'files:read' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new AppError('invalid_token', 'malformed_media_token');
      }
      return payload as MediaTokenClaims;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isExpiredError(err)) throw new AppError('token_expired', 'media_token_expired');
      throw new AppError('invalid_token', 'media_token_invalid');
    }
  }

  async issueAccessToken(input: { userId: string; sessionId: string; role: string }): Promise<{
    token: string;
    expiresAt: Date;
  }> {
    const expiresAt = new Date(Date.now() + this.cfg.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: input.sessionId, roles: input.role, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setIssuer('sovereign')
      .setAudience('sovereign-api')
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(key(this.cfg.secrets.accessTokenSecret));
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, key(this.cfg.secrets.accessTokenSecret), {
        issuer: 'sovereign',
        audience: 'sovereign-api',
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new AppError('invalid_token', 'malformed_access_token');
      }
      return payload as AccessTokenClaims;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isExpiredError(err)) throw new AppError('token_expired', 'access_token_expired');
      throw new AppError('invalid_token', 'access_token_invalid');
    }
  }

  /** Refresh tokens are opaque: the database only ever sees their SHA-256 hash. */
  issueRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomToken(32);
    return {
      token,
      hash: sha256Hex(token),
      expiresAt: new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
  }

  hashRefreshToken(token: string): string {
    return sha256Hex(token);
  }

  async issueRealtimeTicket(input: { userId: string; sessionId: string; deviceId?: string | null }): Promise<string> {
    return new SignJWT({ sid: input.sessionId, did: input.deviceId ?? undefined, typ: 'ws' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setIssuer('sovereign')
      .setAudience('sovereign-realtime')
      .setIssuedAt()
      .setExpirationTime('90s')
      .sign(key(this.cfg.secrets.ticketSecret));
  }

  async verifyRealtimeTicket(ticket: string): Promise<TicketClaims> {
    try {
      const { payload } = await jwtVerify(ticket, key(this.cfg.secrets.ticketSecret), {
        issuer: 'sovereign',
        audience: 'sovereign-realtime',
      });
      if (payload.typ !== 'ws' || typeof payload.sub !== 'string') throw new Error('bad_ticket');
      return payload as TicketClaims;
    } catch {
      throw new AppError('invalid_token', 'realtime_ticket_invalid');
    }
  }
}
