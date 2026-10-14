import type { FastifyInstance } from 'fastify';
import type { ServiceContainer } from '../services/container.js';
import { describeConfig } from '../config/index.js';

/** Liveness/readiness probes used by the reverse proxy, CI and the deployment docs. */

export async function registerHealthRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { deps } = container;
  const startedAt = Date.now();

  app.get('/health/live', { schema: { tags: ['health'] } }, async () => ({ status: 'ok', uptimeMs: Date.now() - startedAt }));

  app.get('/health', { schema: { tags: ['health'] } }, async (request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string; latencyMs?: number }> = {};

    const dbStart = Date.now();
    try {
      await deps.db.query('select 1');
      checks.database = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message };
    }

    const cacheStart = Date.now();
    try {
      const probe = `health:${Date.now()}`;
      await deps.cache.set(probe, '1', 5);
      const value = await deps.cache.get<string>(probe);
      checks.cache = { ok: value === '1', latencyMs: Date.now() - cacheStart, detail: deps.cache.driver };
    } catch (err) {
      checks.cache = { ok: false, detail: (err as Error).message };
    }

    const storageStart = Date.now();
    try {
      const key = `health/probe-${Date.now()}.txt`;
      await deps.storage.put(key, Buffer.from('ok'), 'text/plain');
      checks.storage = { ok: await deps.storage.exists(key), latencyMs: Date.now() - storageStart, detail: deps.storage.driver };
      await deps.storage.delete(key);
    } catch (err) {
      checks.storage = { ok: false, detail: (err as Error).message };
    }

    checks.realtime = { ok: true, detail: `${container.realtime.connectionCount()} open connections` };

    const healthy = Object.values(checks).every((check) => check.ok);
    reply.status(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeMs: Date.now() - startedAt,
      checks,
      config: describeConfig(deps.cfg),
    };
  });
}
