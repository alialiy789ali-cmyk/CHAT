import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { ADVISORY_LOCKS } from './pool.js';
import type { Logger } from '../lib/logger.js';

/**
 * Minimal, dependency-free migration runner.
 *
 * Guarantees:
 *  - migrations run inside a transaction: a failing migration leaves no partial schema,
 *  - a PostgreSQL advisory lock prevents two app instances from migrating concurrently,
 *  - checksums are stored and verified, so an already-applied migration cannot be edited
 *    silently (the runner fails loudly instead).
 */

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((file) => {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const match = /^(\d+)[-_](.*)\.sql$/.exec(file);
    if (!match) throw new Error(`Migration filename must be <version>_<name>.sql: ${file}`);
    return {
      version: match[1] as string,
      name: (match[2] as string).replace(/[-_]/g, ' '),
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  checked: number;
}

export async function runMigrations(pool: Pool, logger: Logger, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCKS.migrations]);
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now(),
        duration_ms integer not null default 0
      )
    `);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'select version, checksum from schema_migrations',
    );
    const appliedMap = new Map(rows.map((r) => [r.version, r.checksum]));

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      const existingChecksum = appliedMap.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.file} was modified after being applied ` +
              `(stored checksum ${existingChecksum.slice(0, 12)}, current ${migration.checksum.slice(0, 12)}). ` +
              'Create a new migration instead of editing an applied one.',
          );
        }
        skipped.push(migration.version);
        continue;
      }
      const started = Date.now();
      logger.info({ migration: migration.file }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        const duration = Date.now() - started;
        await client.query(
          'insert into schema_migrations (version, name, checksum, duration_ms) values ($1, $2, $3, $4)',
          [migration.version, migration.name, migration.checksum, duration],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
        logger.info({ migration: migration.file, durationMs: duration }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${migration.file} failed: ${(err as Error).message}`);
      }
    }
    return { applied, skipped, checked: migrations.length };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCKS.migrations]).catch(() => {});
    client.release();
  }
}
