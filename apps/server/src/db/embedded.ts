import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { absolutePath, type AppConfig } from '../config/index.js';

/**
 * Embedded PostgreSQL for local development and tests.
 *
 * Why: the project must be runnable end-to-end on a machine without Docker,
 * while production uses a real PostgreSQL cluster (see infra/docker-compose.yml).
 * Both paths speak the same wire protocol, so application code is identical.
 */

const PGDATA_MARKER = 'PG_VERSION';

export interface EmbeddedHandle {
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
  alreadyRunning: boolean;
}

let active: EmbeddedHandle | null = null;

function createInstance(cfg: AppConfig) {
  const dataDir = absolutePath(cfg, cfg.EMBEDDED_PG_DATA_DIR);
  mkdirSync(path.dirname(dataDir), { recursive: true });
  return {
    dataDir,
    instance: new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'sovereign',
      password: 'sovereign_local_dev',
      port: cfg.EMBEDDED_PG_PORT,
      persistent: true,
      onLog: () => {
        /* postgres emits very chatty logs; keep them out of the app log stream */
      },
    }),
  };
}

export function embeddedDatabaseUrl(cfg: AppConfig): string {
  return `postgresql://sovereign:sovereign_local_dev@127.0.0.1:${cfg.EMBEDDED_PG_PORT}/sovereign`;
}

export async function isEmbeddedRunning(cfg: AppConfig): Promise<boolean> {
  const dataDir = absolutePath(cfg, cfg.EMBEDDED_PG_DATA_DIR);
  const { Client } = await import('pg');
  const client = new Client({ connectionString: embeddedDatabaseUrl(cfg), connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    const res = await client.query('select 1 as ok');
    return res.rows.length === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function startEmbedded(cfg: AppConfig, opts: { createDatabase?: string } = {}): Promise<EmbeddedHandle> {
  if (active) return active;
  const { dataDir, instance } = createInstance(cfg);
  const fresh = !existsSync(path.join(dataDir, PGDATA_MARKER));
  if (fresh) {
    await instance.initialise();
  }
  try {
    await instance.start();
  } catch (err) {
    // If another process (e.g. a previous `npm run dev`) already holds the port,
    // reuse it instead of failing the whole app boot.
    if (await isEmbeddedRunning(cfg)) {
      active = {
        port: cfg.EMBEDDED_PG_PORT,
        dataDir,
        alreadyRunning: true,
        stop: async () => {},
      };
      return active;
    }
    throw err;
  }
  if (opts.createDatabase) {
    try {
      await instance.createDatabase(opts.createDatabase);
    } catch {
      /* database already exists */
    }
  }
  active = {
    port: cfg.EMBEDDED_PG_PORT,
    dataDir,
    alreadyRunning: false,
    stop: async () => {
      await instance.stop().catch(() => {});
      active = null;
    },
  };
  return active;
}

export async function stopEmbedded(): Promise<void> {
  if (!active) return;
  await active.stop();
  active = null;
}

export function isFreshDataDir(cfg: AppConfig): boolean {
  return !existsSync(path.join(absolutePath(cfg, cfg.EMBEDDED_PG_DATA_DIR), PGDATA_MARKER));
}
