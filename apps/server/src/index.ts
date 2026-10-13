import { buildApp } from './app.js';
import { createRuntime } from './runtime.js';
import { stopEmbedded } from './db/embedded.js';
import { loadEnvFile } from './config/index.js';

/**
 * Server entry point.
 *
 * Startup order: env file → runtime (db, migrations, cache, storage, mail) →
 * HTTP app → listen → graceful shutdown on SIGTERM/SIGINT with a drain period.
 */

loadEnvFile('apps/server/.env');

const runtime = await createRuntime();
const app = await buildApp({ deps: runtime.deps, container: runtime.container });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.logger.info({ signal }, 'shutting down');
  // After a short drain period, force-close lingering keep-alive connections so the
  // process can exit promptly; the hard deadline is the last resort.
  const drain = setTimeout(() => {
    runtime.logger.warn('forcing close of remaining connections');
    app.server.closeAllConnections?.();
  }, 8_000);
  const deadline = setTimeout(() => {
    runtime.logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15_000);
  drain.unref();
  deadline.unref();
  try {
    await app.close();
    await runtime.close();
    await stopEmbedded();
    clearTimeout(deadline);
    clearTimeout(drain);
    runtime.logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    runtime.logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  runtime.logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  runtime.logger.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});

try {
  await app.listen({ port: runtime.cfg.PORT, host: runtime.cfg.HOST });
  runtime.logger.info(
    {
      port: runtime.cfg.PORT,
      host: runtime.cfg.HOST,
      profile: runtime.cfg.profile,
      websocket: '/ws',
      health: '/api/health',
    },
    `${runtime.cfg.APP_NAME} API listening`,
  );
} catch (err) {
  runtime.logger.fatal({ err }, 'failed to start server');
  await runtime.close().catch(() => {});
  process.exit(1);
}
