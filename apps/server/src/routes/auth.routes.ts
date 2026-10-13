import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  twoFactorEnableSchema,
  twoFactorVerifySchema,
  verifyEmailSchema,
} from '@sovereign/shared/validation';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';
import { AppError } from '../lib/errors.js';

/**
 * Authentication routes.
 *
 * The refresh token is set as an httpOnly cookie *and* returned in the body:
 * browsers use the cookie (XSS cannot read it), mobile clients use the body token.
 */

const REFRESH_COOKIE = 'sovereign_refresh';

function makeCtx(request: FastifyRequest, userId?: string, sessionId?: string): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId,
    sessionId,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { deps, auth } = container;
  /**
   * Brute-force protection on credential endpoints. Relaxed in the test profile so
   * the acceptance suite (which creates many accounts) is not throttled; production
   * keeps the strict values.
   */
  const limit = (max: number, timeWindow: string) =>
    deps.cfg.isTest ? { max: 100_000, timeWindow: '1 minute' } : { max, timeWindow };

  const setRefreshCookie = (reply: FastifyReply, token: string, expiresAt: string) => {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cfg.isProduction,
      path: '/api/auth',
      expires: new Date(expiresAt),
    });
  };

  app.post(
    '/auth/register',
    { config: { rateLimit: limit(10, '10 minutes') }, schema: { tags: ['auth'] } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body ?? {});
      const result = await auth.register(body, makeCtx(request));
      setRefreshCookie(reply, result.refreshToken, result.refreshTokenExpiresAt);
      reply.status(201);
      return {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        sessionId: result.sessionId,
        deviceId: result.deviceId,
      };
    },
  );

  /**
   * Mints a short-lived, read-only media token for `<img>`, `<video>` and download links —
   * browsers cannot attach an Authorization header to those. It never rotates the refresh
   * token (unlike /auth/refresh) and never grants write access.
   */
  app.post(
    '/auth/media-token',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit(240, '5 minutes') },
      schema: { tags: ['auth'] },
    },
    async (request) => {
      const issued = await deps.tokens.issueMediaToken({
        userId: request.auth!.userId,
        sessionId: request.auth!.sessionId,
      });
      return { token: issued.token, expiresIn: Math.max(1, Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000)) };
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: limit(20, '5 minutes') }, schema: { tags: ['auth'] } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body ?? {});
      const result = await auth.login(body, makeCtx(request));
      setRefreshCookie(reply, result.refreshToken, result.refreshTokenExpiresAt);
      return {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        sessionId: result.sessionId,
        deviceId: result.deviceId,
      };
    },
  );

  app.post('/auth/refresh', { config: { rateLimit: limit(120, '5 minutes') }, schema: { tags: ['auth'] } }, async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    const fromCookie = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    const token = body.refreshToken ?? fromCookie;
    if (!token) throw new AppError('unauthenticated', 'refresh_token_missing');
    const result = await auth.refresh(token, makeCtx(request));
    setRefreshCookie(reply, result.refreshToken, result.refreshTokenExpiresAt);
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      sessionId: result.sessionId,
    };
  });

  app.post('/auth/logout', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request, reply) => {
    const ctx = makeCtx(request, request.auth!.userId, request.auth!.sessionId);
    await auth.logout(request.auth!.sessionId, ctx);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { loggedOut: true };
  });

  app.post('/auth/logout-all', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request, reply) => {
    const count = await auth.logoutAll(request.auth!.userId, makeCtx(request, request.auth!.userId));
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { revokedSessions: count };
  });

  /** Issues the short-lived ticket used for the WebSocket handshake. */
  app.post('/auth/realtime-ticket', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const body = (request.body ?? {}) as { deviceId?: string };
    const session = await deps.repos.sessions.findSession(request.auth!.sessionId);
    const ticket = await deps.tokens.issueRealtimeTicket({
      userId: request.auth!.userId,
      sessionId: request.auth!.sessionId,
      deviceId: body.deviceId ?? session?.device_id ?? null,
    });
    return { ticket, expiresInSeconds: 90, url: '/ws' };
  });

  app.get('/auth/sessions', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) =>
    auth.listSessions(request.auth!.userId, request.auth!.sessionId),
  );

  app.delete('/auth/sessions/:sessionId', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    await auth.revokeSession(request.auth!.userId, sessionId, makeCtx(request, request.auth!.userId));
    return { revoked: true };
  });

  app.post('/auth/verify-email', { config: { rateLimit: limit(20, '15 minutes') }, schema: { tags: ['auth'] } }, async (request) => {
    const body = verifyEmailSchema.parse(request.body ?? {});
    return auth.verifyEmail(body.token, makeCtx(request));
  });

  app.post('/auth/resend-verification', { config: { rateLimit: limit(5, '15 minutes') }, schema: { tags: ['auth'] } }, async (request) => {
    const body = (request.body ?? {}) as { identifier?: string; email?: string };
    const identifier = body.identifier ?? body.email;
    if (!identifier) throw new AppError('validation_error', 'identifier_required');
    await auth.resendVerification(identifier);
    return { sent: true };
  });

  app.post('/auth/password/request-reset', { config: { rateLimit: limit(5, '15 minutes') }, schema: { tags: ['auth'] } }, async (request) => {
    const body = requestPasswordResetSchema.parse(request.body ?? {});
    await auth.requestPasswordReset(body.email, makeCtx(request));
    // Always the same answer: no account enumeration.
    return { sent: true };
  });

  app.post('/auth/password/reset', { config: { rateLimit: limit(10, '15 minutes') }, schema: { tags: ['auth'] } }, async (request) => {
    const body = resetPasswordSchema.parse(request.body ?? {});
    await auth.resetPassword(body.token, body.newPassword, makeCtx(request));
    return { reset: true };
  });

  app.post('/auth/password/change', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const body = changePasswordSchema.parse(request.body ?? {});
    await auth.changePassword(request.auth!.userId, body.currentPassword, body.newPassword, makeCtx(request, request.auth!.userId));
    return { changed: true };
  });

  /** ------------------------------------------------------------- two-factor */

  app.post('/auth/2fa/setup', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) =>
    auth.setupTwoFactor(request.auth!.userId),
  );

  app.post('/auth/2fa/enable', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const body = twoFactorEnableSchema.parse(request.body ?? {});
    return auth.enableTwoFactor(request.auth!.userId, body.code, makeCtx(request, request.auth!.userId));
  });

  app.post('/auth/2fa/verify', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const body = twoFactorVerifySchema.parse(request.body ?? {});
    // Reuse of enable() would be wrong; verification of an active secret is a check only.
    const user = await deps.repos.users.findById(request.auth!.userId);
    if (!user?.two_factor_enabled_at) throw new AppError('two_factor_not_enabled');
    const ok = await auth.verifyTwoFactorCode(user.id, body.code).catch(() => false);
    return { valid: ok };
  });

  app.post('/auth/2fa/disable', { preHandler: [app.authenticate], schema: { tags: ['auth'] } }, async (request) => {
    const body = (request.body ?? {}) as { password?: string };
    if (!body.password) throw new AppError('validation_error', 'password_required');
    await auth.disableTwoFactor(request.auth!.userId, body.password, makeCtx(request, request.auth!.userId));
    return { disabled: true };
  });
}
