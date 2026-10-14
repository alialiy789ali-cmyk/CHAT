import type { FastifyInstance, FastifyRequest } from 'fastify';
import { moderationActionSchema, reportSchema } from '@sovereign/shared/validation';
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

/** Reporting from users + the staff review queue and audit trail. */
export async function registerModerationRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { moderation } = container;

  app.post('/reports', { preHandler: [app.authenticate], config: { rateLimit: container.deps.cfg.isTest ? { max: 100_000, timeWindow: '1 minute' } : { max: 30, timeWindow: '10 minutes' } }, schema: { tags: ['moderation'] } }, async (request, reply) => {
    const body = reportSchema.parse(request.body ?? {});
    const result = await moderation.report(request.auth!.userId, body, ctxOf(request));
    reply.status(result.duplicated ? 200 : 201);
    return result;
  });

  app.get('/moderation/reports', { preHandler: [app.authenticate], schema: { tags: ['moderation'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return moderation.queue(request.auth!.userId, {
      status: (query.status as 'open' | 'reviewing' | 'resolved' | undefined) ?? undefined,
      limit: Math.min(Number(query.limit ?? 50) || 50, 100),
      offset: Number(query.offset ?? 0) || 0,
    });
  });

  app.post('/moderation/reports/:reportId/resolve', { preHandler: [app.authenticate], schema: { tags: ['moderation'] } }, async (request) => {
    const { reportId } = request.params as { reportId: string };
    const body = moderationActionSchema.parse(request.body ?? {});
    return moderation.resolve(request.auth!.userId, reportId, body, ctxOf(request));
  });

  app.get('/moderation/audit', { preHandler: [app.authenticate], schema: { tags: ['moderation'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return moderation.auditTrail(request.auth!.userId, {
      action: query.action,
      actorId: query.actorId,
      limit: Math.min(Number(query.limit ?? 100) || 100, 500),
      offset: Number(query.offset ?? 0) || 0,
    });
  });
}
