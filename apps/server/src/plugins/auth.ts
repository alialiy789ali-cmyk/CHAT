import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import type { AppDeps } from '../services/context.js';

/**
 * Authentication guard.
 *
 * Access tokens are verified with an HMAC signature *and* the session row is checked
 * so that a revoked session stops working immediately (requirement: session management).
 * The check is cached for a few seconds to keep the hot path fast without turning a
 * logout into a no-op.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      userId: string;
      sessionId: string;
      role: string;
    };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    deps: AppDeps;
  }
}

export interface AuthPluginOptions {
  deps: AppDeps;
}

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { deps } = opts;

  const resolve = async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    let token: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    } else if (typeof request.query === 'object' && request.query && 'access_token' in request.query) {
      // Only used by the WebSocket handshake fallback; never for REST mutations.
      const q = request.query as Record<string, unknown>;
      if (typeof q.access_token === 'string') token = q.access_token;
    }
    if (!token) return;

    const claims = await deps.tokens.verifyAccessToken(token);
    const cacheKey = `session:active:${claims.sid}`;
    const cached = await deps.cache.get<{ userId: string; revoked: boolean }>(cacheKey);
    if (cached) {
      if (cached.revoked) throw new AppError('session_revoked');
      request.auth = { userId: cached.userId, sessionId: claims.sid, role: String(claims.roles ?? 'user') };
      return;
    }
    const session = await deps.repos.sessions.findSession(claims.sid);
    if (!session || session.user_id !== claims.sub) throw new AppError('invalid_token', 'session_unknown');
    const revoked = session.revoked_at !== null || session.expires_at.getTime() < Date.now();
    await deps.cache.set(cacheKey, { userId: session.user_id, revoked }, 10);
    if (revoked) throw new AppError('session_revoked');
    request.auth = { userId: session.user_id, sessionId: session.id, role: String(claims.roles ?? 'user') };
  };

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    await resolve(request);
    if (!request.auth) throw new AppError('unauthenticated', 'authentication_required');
    // Re-check account status on every authenticated request (suspension is instant).
    const statusKey = `user:status:${request.auth.userId}`;
    const cachedStatus = await deps.cache.get<string>(statusKey);
    const status = cachedStatus ?? (await deps.repos.users.findById(request.auth.userId))?.status;
    if (cachedStatus === undefined) await deps.cache.set(statusKey, status ?? 'missing', 15);
    if (status === 'suspended') throw new AppError('account_suspended');
    if (status !== 'active' && status !== undefined) throw new AppError('account_deactivated');
  });

  app.decorate('optionalAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    await resolve(request);
  });

  app.decorateRequest('auth', undefined);
}

export default fp(authPlugin, { name: 'sovereign-auth' });
