import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  notificationSettingsSchema,
  paginationSchema,
  privacySettingsSchema,
  searchQuerySchema,
  updateProfileSchema,
  usernameSchema,
} from '@sovereign/shared/validation';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';

function ctxOf(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId: request.auth?.userId,
    sessionId: request.auth?.sessionId,
  };
}

/** Profiles, privacy, follows, blocks, sessions/devices and account lifecycle. */
export async function registerUserRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { users, auth, uploads } = container;
  const { deps } = container;

  app.get('/users/me', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) =>
    users.me(request.auth!.userId),
  );

  app.patch('/users/me', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const body = updateProfileSchema.parse(request.body ?? {});
    return users.updateProfile(request.auth!.userId, body);
  });

  app.patch('/users/me/privacy', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const body = privacySettingsSchema.parse(request.body ?? {});
    return users.updatePrivacy(request.auth!.userId, body);
  });

  app.patch('/users/me/notifications', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const body = notificationSettingsSchema.parse(request.body ?? {});
    return users.updateNotificationSettings(request.auth!.userId, body);
  });

  /** Avatar upload: multipart form with a single `file` part. */
  app.post('/users/me/avatar', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const file = await request.file();
    if (!file) throw new Error('avatar_file_required');
    const data = await file.toBuffer();
    return uploads.setAvatar(request.auth!.userId, { fileName: file.filename, mimeType: file.mimetype, data }, ctxOf(request));
  });

  app.get('/users/me/export', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request, reply) => {
    const data = await users.exportData(request.auth!.userId, ctxOf(request));
    reply.header('content-disposition', `attachment; filename="sovereign-export-${Date.now()}.json"`);
    return data;
  });

  app.delete('/users/me', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) =>
    users.deleteAccount(request.auth!.userId, ctxOf(request)),
  );

  app.get('/users/me/devices', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const devices = await deps.repos.sessions.listDevices(request.auth!.userId);
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastSeenAt: d.last_seen_at.toISOString(),
      createdAt: d.created_at.toISOString(),
    }));
  });

  app.delete('/users/me/devices/:deviceId', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { deviceId } = request.params as { deviceId: string };
    const count = await deps.repos.sessions.revokeDevice(request.auth!.userId, deviceId);
    return { revoked: count > 0 };
  });

  app.get('/users/me/blocks', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) =>
    users.blockList(request.auth!.userId),
  );

  app.get('/users/suggestions', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { limit } = paginationSchema.parse(request.query ?? {});
    return users.suggestions(request.auth!.userId, limit);
  });

  app.get('/users/:username', { preHandler: [app.optionalAuth], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    return users.publicProfile(username, request.auth?.userId ?? null);
  });

  app.post('/users/:username/follow', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    return users.follow(request.auth!.userId, username);
  });

  app.delete('/users/:username/follow', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    return users.unfollow(request.auth!.userId, username);
  });

  app.post('/users/:username/block', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    return users.block(request.auth!.userId, username);
  });

  app.delete('/users/:username/block', { preHandler: [app.authenticate], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    return users.unblock(request.auth!.userId, username);
  });

  app.get('/users/:username/followers', { preHandler: [app.optionalAuth], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    const { limit } = paginationSchema.parse(request.query ?? {});
    const offset = Number((request.query as Record<string, string>).offset ?? 0);
    return users.followers(username, limit, Number.isFinite(offset) ? offset : 0);
  });

  app.get('/users/:username/following', { preHandler: [app.optionalAuth], schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    const { limit } = paginationSchema.parse(request.query ?? {});
    const offset = Number((request.query as Record<string, string>).offset ?? 0);
    return users.following(username, limit, Number.isFinite(offset) ? offset : 0);
  });

  /** Global search across users, posts and channels. */
  app.get('/search', { preHandler: [app.optionalAuth], schema: { tags: ['search'] } }, async (request) => {
    const { q, type, limit } = searchQuerySchema.parse(request.query ?? {});
    return container.social.search(request.auth?.userId ?? '00000000-0000-0000-0000-000000000000', q, type, limit);
  });

  app.get('/users/:username/validate', { schema: { tags: ['users'] } }, async (request) => {
    const { username } = request.params as { username: string };
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) return { valid: false, reason: parsed.error.issues[0]?.message };
    const existing = await deps.repos.users.findByUsername(username);
    return { valid: !existing, reason: existing ? 'username_taken' : null };
  });

  void auth;
}
