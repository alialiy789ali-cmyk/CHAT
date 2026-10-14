import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServiceContainer } from '../services/container.js';
import { AppError } from '../lib/errors.js';
import { metrics, metricsAccess } from '../lib/metrics.js';

/**
 * `GET /api/metrics` — the scrape endpoint for Prometheus (or anything that speaks its format).
 *
 * Disabled unless `METRICS_TOKEN` is set, in which case a wrong or missing token is refused with the
 * same 404 an unconfigured server returns, so probing cannot tell the difference between "off" and
 * "not for you". See `docs/deploy.md` for a scrape configuration and the alerts worth having.
 */
export async function registerMetricsRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { cfg } = container.deps;

  app.get('/metrics', { schema: { tags: ['ops'] } }, async (request, reply) => {
    const provided = readToken(request);
    const access = metricsAccess(cfg.METRICS_TOKEN, provided);
    if (access === 'disabled') throw new AppError('not_found', 'unknown_route');
    if (access === 'denied') throw new AppError('unauthenticated', 'metrics_token_required');

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return metrics.render(gauges(container));
  });
}

/** Header first (a scraper can set one), then `?token=` for the simplest possible wiring. */
function readToken(request: FastifyRequest): string | null {
  const header = request.headers['x-metrics-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = request.query as Record<string, unknown> | undefined;
  return typeof query?.token === 'string' && query.token.length > 0 ? query.token : null;
}

/**
 * Point-in-time values that cannot be counted — they exist once per scrape.
 *
 * Everything here is an operational number: how much memory this process holds, how many database
 * connections are busy, how many sockets are open. None of it identifies a user or a conversation.
 */
function gauges(container: ServiceContainer): Array<{ name: string; help: string; value: number }> {
  const pool = container.deps.db.raw();
  const memory = process.memoryUsage();
  return [
    { name: 'process_resident_memory_bytes', help: 'Resident memory of the API process', value: memory.rss },
    { name: 'process_heap_bytes', help: 'V8 heap in use', value: memory.heapUsed },
    { name: 'process_uptime_seconds', help: 'Seconds since this process started', value: process.uptime() },
    {
      name: 'sovereign_realtime_connections',
      help: 'Live WebSocket connections held by this instance',
      value: container.realtime.connectionCount(),
    },
    { name: 'sovereign_db_pool_total', help: 'Connections in the PostgreSQL pool', value: pool.totalCount },
    { name: 'sovereign_db_pool_idle', help: 'Idle connections in the pool', value: pool.idleCount },
    { name: 'sovereign_db_pool_waiting', help: 'Requests waiting for a pool connection', value: pool.waitingCount },
  ];
}
