import type { FastifyInstance, FastifyRequest } from 'fastify';
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

/** Signalling for WebRTC calls + ICE configuration + live rooms (requirement 2.F). */
export async function registerCallRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { calls } = container;

  app.get('/calls/capabilities', { schema: { tags: ['calls'] } }, async () => calls.capabilities());

  app.get('/calls/ice', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) =>
    calls.iceConfiguration(request.auth!.userId),
  );

  app.post('/calls', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request, reply) => {
    const body = (request.body ?? {}) as { conversationId?: string; kind?: 'audio' | 'video' };
    if (!body.conversationId) return reply.status(400).send({ error: { code: 'validation_error', message: 'conversationId_required' } });
    const result = await calls.initiate(
      request.auth!.userId,
      { conversationId: body.conversationId, kind: body.kind === 'video' ? 'video' : 'audio' },
      ctxOf(request),
    );
    reply.status(201);
    return result;
  });

  app.get('/calls/history', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return { calls: await calls.history(request.auth!.userId, limit) };
  });

  app.get('/calls/ringing', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => ({
    calls: await calls.ringing(request.auth!.userId),
  }));

  app.get('/calls/:callId', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const { callId } = request.params as { callId: string };
    return calls.get(request.auth!.userId, callId);
  });

  app.post('/calls/:callId/answer', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const { callId } = request.params as { callId: string };
    return calls.answer(request.auth!.userId, callId);
  });

  app.post('/calls/:callId/decline', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const { callId } = request.params as { callId: string };
    return calls.decline(request.auth!.userId, callId);
  });

  app.post('/calls/:callId/end', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const { callId } = request.params as { callId: string };
    const body = (request.body ?? {}) as { reason?: string };
    return calls.end(request.auth!.userId, callId, body.reason ?? 'ended_by_user');
  });

  /** ------------------------------------------------------------- live rooms */

  app.get('/live-rooms', { preHandler: [app.optionalAuth], schema: { tags: ['calls'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query.limit ?? 20) || 20, 50);
    return { rooms: await calls.listRooms(limit) };
  });

  app.post('/live-rooms', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; topic?: string; kind?: 'audio_space' | 'group_call'; visibility?: 'public' | 'private' };
    if (!body.title) return reply.status(400).send({ error: { code: 'validation_error', message: 'title_required' } });
    const result = await calls.createRoom(request.auth!.userId, {
      title: body.title,
      topic: body.topic,
      kind: body.kind === 'group_call' ? 'group_call' : 'audio_space',
      visibility: body.visibility === 'private' ? 'private' : 'public',
    });
    reply.status(201);
    return result;
  });

  app.post('/live-rooms/:roomId/join', { preHandler: [app.authenticate], schema: { tags: ['calls'] } }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    return calls.joinRoom(request.auth!.userId, roomId);
  });
}
