import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import type { AppDeps } from '../services/context.js';

/**
 * Authentication guards.
 *
 * Access tokens are verified with an HMAC signature *and* the session row is checked so a
 * revoked session stops working immediately (requirement: session management). The check is
 * cached for a few seconds so the hot path stays fast without turning a logout into a no-op.
 *
 * Three guards are exposed:
 *  - `authenticate`      : header (`Authorization: Bearer`) or, for GETs only, `?access_token=`
 *                          (browsers cannot set headers on a WebSocket upgrade or an <img>).
 *  - `optionalAuth`      : same, but anonymous requests pass through.
 *  - `authenticateMedia` : `authenticate` plus a short-lived *media token* (`?token=`) which is
 *                          strictly read-only and only wired into GET /files/:id.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      userId: string;
      sessionId: string;
      role: string;
      /** How the caller proved identity — useful for audit trails and rate-limit policy. */
      via?: 'header' | 'query' | 'media-token';
    };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateMedia: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    deps: AppDeps;
  }
}

export interface AuthPluginOptions {
  deps: AppDeps;
}

interface ResolveOptions {
  /** `?access_token=` is accepted for GETs (WS handshake, legacy <img> URLs). */
  allowQueryAccessToken?: boolean;
  /** `?token=` media token: read-only, checked against the media audience. */
  allowMediaToken?: boolean;
}

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { deps } = opts;

  /** Session liveness with a short cache so revocation lands within seconds, not instantly-queried. */
  const sessionIsActive = async (claims: { sub: string; sid: string }): Promise<void> => {
    const cacheKey = `session:active:${claims.sid}`;
    const cached = await deps.cache.get<{ userId: string; revoked: boolean }>(cacheKey);
    if (cached) {
      if (cached.revoked) throw new AppError('session_revoked');
      return;
    }
    const session = await deps.repos.sessions.findSession(claims.sid);
    if (!session || session.user_id !== claims.sub) throw new AppError('invalid_token', 'session_unknown');
    const revoked = session.revoked_at !== null || session.expires_at.getTime() < Date.now();
    await deps.cache.set(cacheKey, { userId: session.user_id, revoked }, 10);
    if (revoked) throw new AppError('session_revoked');
  };

  const resolve = async (request: FastifyRequest, options: ResolveOptions = {}): Promise<void> => {
    const header = request.headers.authorization;
    let token: string | null = null;
    let via: 'header' | 'query' | 'media-token' = 'header';
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    } else if (typeof request.query === 'object' && request.query) {
      const query = request.query as Record<string, unknown>;
      // Query credentials are only tolerated on GETs: a mutation must never be authorised
      // by a link the user can be tricked into opening.
      const queryAllowed = options.allowQueryAccessToken !== false && request.method === 'GET';
      if (queryAllowed && typeof query.access_token === 'string') {
        token = query.access_token;
        via = 'query';
      }
    }

    if (!token && options.allowMediaToken && typeof request.query === 'object' && request.query) {
      const query = request.query as Record<string, unknown>;
      if (typeof query.token === 'string' && query.token.length > 0) {
        const claims = await deps.tokens.verifyMediaToken(query.token);
        await sessionIsActive(claims);
        request.auth = { userId: claims.sub, sessionId: claims.sid, role: 'user', via: 'media-token' };
        return;
      }
    }

    if (!token) return;

    const claims = await deps.tokens.verifyAccessToken(token);
    await sessionIsActive(claims);
    request.auth = { userId: claims.sub, sessionId: claims.sid, role: String(claims.roles ?? 'user'), via };
  };

  /** Suspension must take effect immediately, so the account status is checked on every call. */
  const requireActiveAccount = async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;
    if (!auth) return;
    const statusKey = `user:status:${auth.userId}`;
    const cachedStatus = await deps.cache.get<string>(statusKey);
    const status = cachedStatus ?? (await deps.repos.users.findById(auth.userId))?.status;
    if (cachedStatus === undefined) await deps.cache.set(statusKey, status ?? 'missing', 15);
    if (status === 'suspended') throw new AppError('account_suspended');
    if (status !== 'active' && status !== undefined) throw new AppError('account_deactivated');
  };

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    await resolve(request);
    if (!request.auth) throw new AppError('unauthenticated', 'authentication_required');
    await requireActiveAccount(request);
  });

  app.decorate('optionalAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    await resolve(request);
  });

  app.decorate('authenticateMedia', async (request: FastifyRequest, _reply: FastifyReply) => {
    await resolve(request, { allowMediaToken: true });
    if (!request.auth) throw new AppError('unauthenticated', 'authentication_required');
    await requireActiveAccount(request);
  });
}

export default fp(authPlugin, { name: 'auth' });
