import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createPostSchema, feedQuerySchema, paginationSchema } from '@sovereign/shared/validation';
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

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Public posts, feed, likes, comments, reposts, hashtags and notifications. */
export async function registerSocialRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { social } = container;

  app.get('/feed', { preHandler: [app.optionalAuth], schema: { tags: ['social'] } }, async (request) => {
    const { tab, limit, cursor } = feedQuerySchema.parse(request.query ?? {});
    const viewerId = request.auth?.userId ?? NIL_UUID;
    return social.feed(viewerId, { tab, limit: Math.min(limit, 50), cursor });
  });

  app.post('/posts', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request, reply) => {
    const body = createPostSchema.parse(request.body ?? {});
    const post = await social.createPost(
      request.auth!.userId,
      {
        body: body.body,
        visibility: body.visibility,
        attachmentIds: body.attachmentIds,
        replyToId: body.replyToId ?? null,
        quoteOfId: body.quoteOfId ?? null,
      },
      ctxOf(request),
    );
    reply.status(201);
    return { post };
  });

  app.get('/posts/:postId', { preHandler: [app.optionalAuth], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return { post: await social.getPost(postId, request.auth?.userId ?? null) };
  });

  app.delete('/posts/:postId', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return social.deletePost(postId, request.auth!.userId, ctxOf(request));
  });

  app.post('/posts/:postId/like', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return social.like(postId, request.auth!.userId);
  });

  app.delete('/posts/:postId/like', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return social.unlike(postId, request.auth!.userId);
  });

  app.get('/posts/:postId/likes', { preHandler: [app.optionalAuth], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return social.likers(postId);
  });

  app.post('/posts/:postId/repost', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    return social.repost(postId, request.auth!.userId);
  });

  app.get('/posts/:postId/comments', { preHandler: [app.optionalAuth], schema: { tags: ['social'] } }, async (request) => {
    const { postId } = request.params as { postId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query.limit ?? 30) || 30, 50);
    return social.comments(postId, request.auth?.userId ?? null, { limit, cursor: query.cursor });
  });

  app.post('/posts/:postId/comments', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request, reply) => {
    const { postId } = request.params as { postId: string };
    const body = createPostSchema.parse(request.body ?? {});
    const post = await social.createPost(
      request.auth!.userId,
      {
        body: body.body,
        visibility: 'public',
        attachmentIds: body.attachmentIds,
        replyToId: postId,
      },
      ctxOf(request),
    );
    reply.status(201);
    return { post };
  });

  app.get('/hashtags/trending', { schema: { tags: ['social'] } }, async () => ({
    hashtags: await social.trendingHashtags(12),
  }));

  app.get('/hashtags/:tag', { preHandler: [app.optionalAuth], schema: { tags: ['social'] } }, async (request) => {
    const { tag } = request.params as { tag: string };
    const { limit, cursor } = paginationSchema.parse(request.query ?? {});
    return social.byHashtag(tag, request.auth?.userId ?? NIL_UUID, { limit, cursor });
  });

  app.get('/notifications', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query.limit ?? 30) || 30, 100);
    return social.notifications(request.auth!.userId, limit, query.unread === 'true');
  });

  app.post('/notifications/read', { preHandler: [app.authenticate], schema: { tags: ['social'] } }, async (request) => {
    const body = (request.body ?? {}) as { ids?: string[] };
    return social.markNotificationsRead(request.auth!.userId, body.ids);
  });
}
