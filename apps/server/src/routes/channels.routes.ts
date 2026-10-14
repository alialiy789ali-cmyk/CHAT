import type { FastifyInstance, FastifyRequest } from 'fastify';
import { channelInviteSchema, createChannelPostSchema, createChannelSchema, paginationSchema } from '@sovereign/shared/validation';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';

function ctxOf(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId: request.auth?.userId,
  };
}

/** Broadcast channels: discovery, subscriptions, invites, posts and roles. */
export async function registerChannelRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { channels } = container;

  app.post('/channels', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request, reply) => {
    const body = createChannelSchema.parse(request.body ?? {});
    const channel = await channels.create(request.auth!.userId, body, ctxOf(request));
    reply.status(201);
    return { channel };
  });

  app.get('/channels/discover', { preHandler: [app.optionalAuth], schema: { tags: ['channels'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query.limit ?? 20) || 20, 50);
    return { channels: await channels.discover(request.auth?.userId ?? '00000000-0000-0000-0000-000000000000', query.q ?? null, limit) };
  });

  app.get('/channels/subscribed', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => ({
    channels: await channels.subscribed(request.auth!.userId),
  }));

  app.post('/channels/join/:code', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { code } = request.params as { code: string };
    return channels.joinByInvite(code, request.auth!.userId, ctxOf(request));
  });

  app.get('/channels/:slug', { preHandler: [app.optionalAuth], schema: { tags: ['channels'] } }, async (request) => {
    const { slug } = request.params as { slug: string };
    return channels.getBySlug(slug, request.auth?.userId ?? null);
  });

  app.patch('/channels/:channelId', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    const body = createChannelSchema.partial().parse(request.body ?? {});
    return { channel: await channels.update(channelId, request.auth!.userId, body, ctxOf(request)) };
  });

  app.post('/channels/:channelId/subscribe', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    return channels.subscribe(channelId, request.auth!.userId, ctxOf(request));
  });

  app.delete('/channels/:channelId/subscribe', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    return channels.unsubscribe(channelId, request.auth!.userId);
  });

  app.post('/channels/:channelId/invites', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const body = channelInviteSchema.parse(request.body ?? {});
    const invite = await channels.createInvite(
      channelId,
      request.auth!.userId,
      { role: body.role, maxUses: body.maxUses, ttlHours: body.ttlHours },
      ctxOf(request),
    );
    reply.status(201);
    return { invite };
  });

  app.get('/channels/:channelId/invites', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    return channels.listInvites(channelId, request.auth!.userId);
  });

  app.delete('/channels/:channelId/invites/:inviteId', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId, inviteId } = request.params as { channelId: string; inviteId: string };
    return channels.revokeInvite(channelId, request.auth!.userId, inviteId);
  });

  app.post('/channels/:channelId/members/:userId/role', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId, userId } = request.params as { channelId: string; userId: string };
    const body = (request.body ?? {}) as { role?: 'admin' | 'moderator' | 'subscriber' };
    if (!body.role) return { error: { code: 'validation_error', message: 'role_required' } };
    return channels.setMemberRole(channelId, request.auth!.userId, userId, body.role, ctxOf(request));
  });

  app.get('/channels/:channelId/audit', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    const query = request.query as Record<string, string | undefined>;
    return channels.auditLog(channelId, request.auth!.userId, {
      limit: Math.min(Number(query.limit ?? 50) || 50, 200),
      offset: Math.max(Number(query.offset ?? 0) || 0, 0),
    });
  });

  app.get('/channels/:channelId/posts', { preHandler: [app.optionalAuth], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId } = request.params as { channelId: string };
    const query = request.query as Record<string, string | undefined>;
    const { limit, cursor } = paginationSchema.parse(query);
    return channels.listPosts(channelId, request.auth?.userId ?? null, { limit, cursor, search: query.q });
  });

  app.post('/channels/:channelId/posts', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const body = createChannelPostSchema.parse(request.body ?? {});
    const post = await channels.createPost(channelId, request.auth!.userId, body, ctxOf(request));
    reply.status(201);
    return { post };
  });

  app.post('/channels/:channelId/posts/:postId/pin', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId, postId } = request.params as { channelId: string; postId: string };
    const body = (request.body ?? {}) as { pinned?: boolean };
    return channels.pinPost(channelId, postId, request.auth!.userId, body.pinned !== false);
  });

  app.delete('/channels/:channelId/posts/:postId', { preHandler: [app.authenticate], schema: { tags: ['channels'] } }, async (request) => {
    const { channelId, postId } = request.params as { channelId: string; postId: string };
    return channels.deletePost(channelId, postId, request.auth!.userId, ctxOf(request));
  });
}
