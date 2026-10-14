/**
 * Database CLI: `npm run db:up | db:down | db:status | db:migrate | db:reset`
 *
 * Development uses an embedded PostgreSQL (no Docker needed); production uses the
 * DATABASE_URL provided by the operator.
 */
import { loadConfig, loadEnvFile } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { createDatabase } from '../src/db/pool.js';
import { embeddedDatabaseUrl, isEmbeddedRunning, startEmbedded, stopEmbedded } from '../src/db/embedded.js';
import { runMigrations } from '../src/db/migrate.js';

loadEnvFile('apps/server/.env');
const cfg = loadConfig();
const logger = createLogger(cfg);
const command = process.argv[2] ?? 'status';

async function main(): Promise<void> {
  switch (command) {
    case 'up': {
      if (cfg.DATABASE_URL) {
        console.log('DATABASE_URL is set; skipping embedded PostgreSQL (production mode).');
        return;
      }
      const running = await isEmbeddedRunning(cfg);
      if (running) {
        console.log(`Embedded PostgreSQL already running on port ${cfg.EMBEDDED_PG_PORT}`);
        return;
      }
      await startEmbedded(cfg, { createDatabase: 'sovereign' });
      console.log(`Embedded PostgreSQL started on port ${cfg.EMBEDDED_PG_PORT} (data: ${cfg.EMBEDDED_PG_DATA_DIR})`);
      return;
    }
    case 'down': {
      await stopEmbedded();
      console.log('Embedded PostgreSQL stopped.');
      return;
    }
    case 'status': {
      const running = await isEmbeddedRunning(cfg);
      console.log(
        JSON.stringify(
          {
            mode: cfg.DATABASE_URL ? 'external' : 'embedded',
            port: cfg.EMBEDDED_PG_PORT,
            running,
            dataDir: cfg.EMBEDDED_PG_DATA_DIR,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'migrate': {
      const connectionString = cfg.DATABASE_URL ?? embeddedDatabaseUrl(cfg);
      if (!cfg.DATABASE_URL) {
        const running = await isEmbeddedRunning(cfg);
        if (!running) await startEmbedded(cfg, { createDatabase: 'sovereign' });
      }
      const handle = await createDatabase(cfg, logger, connectionString);
      const result = await runMigrations(handle.pool, logger);
      console.log(`Migrations: ${result.applied.length} applied, ${result.skipped.length} already applied.`);
      await handle.close();
      return;
    }
    case 'reset': {
      if (cfg.DATABASE_URL) {
        throw new Error('db:reset refuses to run against an external DATABASE_URL. Drop the database manually.');
      }
      const connectionString = embeddedDatabaseUrl(cfg);
      const running = await isEmbeddedRunning(cfg);
      if (!running) await startEmbedded(cfg, { createDatabase: 'sovereign' });
      const handle = await createDatabase(cfg, logger, connectionString);
      await handle.pool.query(`
        drop schema if exists public cascade;
        create schema public;
        grant all on schema public to public;
      `);
      const result = await runMigrations(handle.pool, logger);
      console.log(`Database reset: ${result.applied.length} migrations applied.`);
      await handle.close();
      return;
    }
    default: {
      console.log('Usage: npm run db:up | db:down | db:status | db:migrate | db:reset');
      process.exitCode = 1;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
