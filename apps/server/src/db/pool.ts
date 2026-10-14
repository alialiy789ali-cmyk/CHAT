import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '../config/index.js';
import { describeConfig } from '../config/index.js';
import type { Logger } from '../lib/logger.js';

/**
 * Database access layer.
 *
 * Rules enforced here:
 *  - every query is parameterised ($1, $2, ...) — no string interpolation of user input,
 *  - transactions always run on a *dedicated* connection (acquired from the pool), so
 *    `BEGIN`/`COMMIT` can never span different backends,
 *  - `statement_timeout` is applied server-side to protect the pool from runaway queries.
 */

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  one<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<R | null>;
  many<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<R[]>;
  /** Throws when no row matches — use for "must exist" lookups. */
  oneOrFail<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
    notFoundMessage?: string,
  ): Promise<R>;
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null>;
  close(): Promise<void>;
  raw(): Pool;
}

type Executor = Pick<Pool, 'query'> & Partial<Pick<PoolClient, 'release'>>;

function wrap(base: Executor, statementTimeoutMs: number): Db {
  /** Acquires a dedicated connection when the executor is a pool. */
  const acquire = async (): Promise<{ conn: PoolClient | Pool; release: () => void }> => {
    if (typeof (base as PoolClient).release === 'function') {
      return { conn: base as PoolClient, release: () => {} };
    }
    const client = await (base as Pool).connect();
    return { conn: client, release: () => client.release() };
  };

  const query = async <R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
    const started = process.hrtime.bigint();
    const res = await (base as Pool).query<R>(text, params as never[]);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (durationMs > 500) {
      // Slow-query visibility without leaking parameter values.
      const store = ((globalThis as Record<string, unknown>).__sovereignSlowQueries ??= []) as unknown[];
      store.push({ sql: text.replace(/\s+/g, ' ').slice(0, 160), durationMs: Math.round(durationMs) });
    }
    return res;
  };

  const api: Db = {
    query,
    one: async <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => {
      const res = await query<R>(text, params);
      return (res.rows[0] ?? null) as R | null;
    },
    many: async <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => {
      const res = await query<R>(text, params);
      return res.rows as R[];
    },
    oneOrFail: async <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[], message = 'not_found') => {
      const res = await query<R>(text, params);
      const row = res.rows[0];
      if (!row) {
        const err = new Error(message) as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = message;
        throw err;
      }
      return row;
    },
    withTransaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const { conn, release } = await acquire();
      try {
        await conn.query('BEGIN');
        // Nested withTransaction() calls reuse the same connection (savepoints are not
        // needed because services only nest read-modify-write sequences).
        const tx = wrap(conn, statementTimeoutMs);
        const result = await fn(tx);
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        release();
      }
    },
    withAdvisoryLock: async <T>(key: number, fn: () => Promise<T>): Promise<T | null> => {
      const { conn, release } = await acquire();
      try {
        const res = await conn.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [key]);
        if (!res.rows[0]?.locked) return null;
        try {
          return await fn();
        } finally {
          await conn.query('select pg_advisory_unlock($1)', [key]);
        }
      } finally {
        release();
      }
    },
    close: async () => {
      /* pool lifecycle is owned by the runtime, not by wrapped clients */
    },
    raw: () => base as Pool,
  };
  return api;
}

export interface DatabaseHandle {
  db: Db;
  pool: Pool;
  close: () => Promise<void>;
}

export async function createDatabase(
  cfg: AppConfig,
  logger: Logger,
  connectionString: string,
): Promise<DatabaseHandle> {
  const pool = new Pool({
    connectionString,
    max: cfg.DATABASE_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'sovereign-api',
    options: `-c statement_timeout=${cfg.DATABASE_STATEMENT_TIMEOUT_MS}`,
  });
  pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

  // Fail fast with a clear message instead of a confusing partial boot.
  const probe = await pool.connect();
  try {
    await probe.query('select 1');
  } finally {
    probe.release();
  }
  const version = await pool.query<{ version: string }>('select version() as version');
  logger.info(
    {
      database: version.rows[0]?.version?.split(' ').slice(0, 2).join(' '),
      config: describeConfig(cfg),
    },
    'database connected',
  );
  return { db: wrap(pool, cfg.DATABASE_STATEMENT_TIMEOUT_MS), pool, close: async () => pool.end() };
}

/** Well-known advisory lock keys (avoid collisions across subsystems). */
export const ADVISORY_LOCKS = {
  migrations: 0x50_4f_56_01,
  maintenance: 0x50_4f_56_02,
} as const;
