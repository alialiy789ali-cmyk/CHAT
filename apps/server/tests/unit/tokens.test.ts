import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { TokenService } from '../../src/services/tokens.service.js';
import { AppError } from '../../src/lib/errors.js';
import type { AppConfig } from '../../src/config/index.js';

/**
 * Token unit tests.
 *
 * These pin the *separation of privilege* between the three token kinds: an access token,
 * a realtime ticket and a media token must never be interchangeable. A regression here would
 * be a security bug (e.g. a media token — which travels in query strings — mutating data).
 */

const ACCESS_SECRET = 'unit-test-access-secret-with-enough-entropy';
const TICKET_SECRET = 'unit-test-ticket-secret-with-enough-entropy';

const cfg = {
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
  MEDIA_TOKEN_TTL_SECONDS: 300,
  secrets: {
    accessTokenSecret: ACCESS_SECRET,
    ticketSecret: TICKET_SECRET,
  },
} as unknown as AppConfig;

const tokens = new TokenService(cfg);
const identity = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };

function expectAppError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('access tokens', () => {
  it('round-trips and carries the session id', async () => {
    const { token, expiresAt } = await tokens.issueAccessToken({ ...identity, role: 'user' });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims.sub).toBe(identity.userId);
    expect(claims.sid).toBe(identity.sessionId);
    expect(claims.typ).toBe('access');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a tampered signature', async () => {
    const { token } = await tokens.issueAccessToken({ ...identity, role: 'user' });
    const tampered = `${token.slice(0, -3)}xyz`;
    await expect(tokens.verifyAccessToken(tampered)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
  });

  it('reports expiry distinctly from invalidity', async () => {
    const expired = await new SignJWT({ sid: identity.sessionId, roles: 'user', typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(identity.userId)
      .setIssuer('sovereign')
      .setAudience('sovereign-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(ACCESS_SECRET));
    await expect(tokens.verifyAccessToken(expired)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'token_expired');
      return true;
    });
  });
});

describe('media tokens', () => {
  it('are short-lived, read-only and scoped to files', async () => {
    const { token, expiresAt } = await tokens.issueMediaToken(identity);
    const claims = await tokens.verifyMediaToken(token);
    expect(claims.typ).toBe('media');
    expect(claims.scope).toBe('files:read');
    expect(claims.sub).toBe(identity.userId);
    const ttlSeconds = Math.round((expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeGreaterThan(250);
    expect(ttlSeconds).toBeLessThanOrEqual(300);
  });

  it('cannot be used as an access token (audience separation)', async () => {
    const { token } = await tokens.issueMediaToken(identity);
    await expect(tokens.verifyAccessToken(token)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
  });

  it('cannot be faked by re-labelling an access token', async () => {
    const { token } = await tokens.issueAccessToken({ ...identity, role: 'user' });
    await expect(tokens.verifyMediaToken(token)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
  });

  it('expires quickly', async () => {
    const expired = await new SignJWT({ sid: identity.sessionId, typ: 'media', scope: 'files:read' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(identity.userId)
      .setIssuer('sovereign')
      .setAudience('sovereign-media')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(new TextEncoder().encode(ACCESS_SECRET));
    await expect(tokens.verifyMediaToken(expired)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'token_expired');
      return true;
    });
  });
});

describe('realtime tickets', () => {
  it('are bound to the realtime audience and rejected elsewhere', async () => {
    const ticket = await tokens.issueRealtimeTicket({ ...identity, deviceId: null });
    const claims = await tokens.verifyRealtimeTicket(ticket);
    expect(claims.typ).toBe('ws');
    expect(claims.sid).toBe(identity.sessionId);
    await expect(tokens.verifyAccessToken(ticket)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
    await expect(tokens.verifyMediaToken(ticket)).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
  });

  it('rejects garbage', async () => {
    await expect(tokens.verifyRealtimeTicket('not-a-jwt')).rejects.toSatisfy((err: unknown) => {
      expectAppError(err, 'invalid_token');
      return true;
    });
  });
});

describe('refresh tokens', () => {
  it('are opaque and stored only as a hash', () => {
    const { token, hash, expiresAt } = tokens.issueRefreshToken();
    expect(token).not.toContain('.');
    expect(hash).toHaveLength(64);
    expect(tokens.hashRefreshToken(token)).toBe(hash);
    expect(tokens.hashRefreshToken(token)).not.toBe(token);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
  });
});
