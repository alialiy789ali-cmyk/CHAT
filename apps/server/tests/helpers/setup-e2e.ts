import { appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { stopEmbedded } from '../../src/db/embedded.js';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end harness: boots the real API (embedded PostgreSQL, filesystem storage,
 * in-memory cache, memory mailer) on an ephemeral port, so tests exercise the same
 * code path as production minus the network hop to a managed database.
 */

export interface E2EContext {
  app: FastifyInstance;
  runtime: Runtime;
  baseUrl: string;
  wsUrl: string;
}

let context: E2EContext | null = null;

export function e2e(): E2EContext {
  if (!context) throw new Error('e2e context not initialised');
  return context;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CACHE_DRIVER = 'memory';
  process.env.STORAGE_DRIVER = 'local';
  process.env.MAIL_DRIVER = 'memory';
  process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'silent';
  process.env.EMBEDDED_PG_PORT = process.env.EMBEDDED_PG_PORT ?? '54331';
  process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-value-32-chars-min';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-value-32-chars';
  process.env.REALTIME_TICKET_SECRET = 'test-realtime-ticket-secret-32-chars-min';
  process.env.FIELD_ENCRYPTION_KEY = 'test-field-encryption-key-32-chars-minimum';
  process.env.SESSION_SECRET = 'test-session-secret-value-32-chars-minimum';
  process.env.RATE_LIMIT_GLOBAL_MAX = '100000';
  // Acceptance 22 exercises the real E2EE path (keys published by clients, ciphertext relayed
  // untouched). With the flag off the server correctly *rejects* ciphertext — also asserted.
  process.env.E2EE_ENABLED = 'true';

  // Hermetic database: a dedicated data directory that is wiped before and after the
  // run, so a leftover postmaster from an earlier test run can never be reused.
  const dataDir = path.resolve(import.meta.dirname, '../../var/pgdata-e2e');
  process.env.EMBEDDED_PG_DATA_DIR = dataDir;
  rmSync(dataDir, { recursive: true, force: true });

  const runtime = await createRuntime();
  const app = await buildApp({ deps: runtime.deps, container: runtime.container, testMode: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  context = { app, runtime, baseUrl, wsUrl: `ws://127.0.0.1:${address.port}/ws` };
}, 120_000);

afterAll(async () => {
  if (!context) return;
  const debug = process.env.E2E_DEBUG_TEARDOWN === 'true';
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const started = Date.now();
    await fn();
    if (debug) {
      appendFileSync('/tmp/teardown.log', `[teardown] ${name}: ${Date.now() - started}ms\n`);
      console.log(`[teardown] ${name}: ${Date.now() - started}ms`);
    }
  };
  await step('close-all-connections', () => context!.app.server.closeAllConnections?.());
  await step('app.close', () => context!.app.close());
  await step('runtime.close', () => context!.runtime.close());
  await step('stop-embedded', () => stopEmbedded());
  context = null;
}, 60_000);
