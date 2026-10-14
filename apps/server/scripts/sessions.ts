/**
 * Session operator tool: `npm run sessions -w @sovereign/server -- <command> <username>`
 *
 * Why this exists: the platform caps how many devices can be signed in at once, and it *refuses*
 * a login beyond that cap rather than silently evicting a live session (see
 * `docs/feature-log.md`). Refusing is the safer choice, but it leaves a hole for a self-hosting
 * owner: an account whose slots are held by phones that no longer exist cannot sign in at all.
 *
 * The account owner can always recover through a password reset (which revokes every session), but
 * an operator should not have to depend on a mail round-trip to unblock their own server. This tool
 * does the same thing on the command line, against the database directly:
 *
 *   list   <username>                      every non-expired session, newest use last
 *   revoke <username> [--keep <sessionId>] revoke all of them, optionally keeping one (a device the
 *                                          owner still has), recording who did it and why
 *
 * It runs against the same database as the server (embedded in development, `DATABASE_URL` in
 * production) and touches nothing but `sessions` — keys, history and messages stay untouched.
 */
import { loadConfig, loadEnvFile } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { createDatabase } from '../src/db/pool.js';
import { embeddedDatabaseUrl, isEmbeddedRunning, startEmbedded } from '../src/db/embedded.js';

loadEnvFile('apps/server/.env');
const cfg = loadConfig();
const logger = createLogger(cfg);

const [, , command, username, ...rest] = process.argv;
const keepIndex = rest.indexOf('--keep');
const keep = keepIndex >= 0 ? rest[keepIndex + 1] : undefined;
const reasonIndex = rest.indexOf('--reason');
const reason = reasonIndex >= 0 ? rest.slice(reasonIndex + 1).join(' ') : 'operator_revoked';

async function main(): Promise<void> {
  if (!command || !username) {
    console.error('usage: npm run sessions -w @sovereign/server -- list|revoke <username> [--keep <sessionId>] [--reason <text>]');
    process.exitCode = 1;
    return;
  }

  const connectionString = cfg.DATABASE_URL ?? embeddedDatabaseUrl(cfg);
  if (!cfg.DATABASE_URL && !(await isEmbeddedRunning(cfg))) {
    await startEmbedded(cfg, { createDatabase: 'sovereign' });
  }
  const handle = await createDatabase(cfg, logger, connectionString);
  const client = await handle.pool.connect();
  try {
    const user = await client.query<{ id: string; username: string; status: string }>(
      'select id, username, status from users where lower(username) = lower($1) or lower(email) = lower($1)',
      [username],
    );
    if (user.rowCount === 0) {
      console.error(`no account matches "${username}"`);
      process.exitCode = 1;
      return;
    }
    const account = user.rows[0]!;

    if (command === 'list') {
      const rows = await client.query<{
        id: string;
        device_name: string | null;
        device_platform: string | null;
        ip: string | null;
        created_at: Date;
        last_used_at: Date;
        expires_at: Date;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>(
        `select s.id, d.name as device_name, d.platform as device_platform, s.ip, s.created_at,
                s.last_used_at, s.expires_at, s.revoked_at, s.revoked_reason
           from sessions s
           left join devices d on d.id = s.device_id
          where s.user_id = $1
          order by s.created_at`,
        [account.id],
      );
      const live = rows.rows.filter((row) => !row.revoked_at && row.expires_at.getTime() > Date.now());
      console.log(`${account.username} (${account.status}): ${rows.rowCount} sessions, ${live.length} active`);
      for (const row of rows.rows) {
        console.log(
          [
            row.revoked_at ? 'revoked' : row.expires_at.getTime() > Date.now() ? 'active ' : 'expired',
            row.id,
            row.device_name ?? 'unknown device',
            row.device_platform ?? '',
            row.ip ?? '',
            `created ${row.created_at.toISOString().slice(0, 16)}`,
            `last used ${row.last_used_at.toISOString().slice(0, 16)}`,
            row.revoked_reason ? `(${row.revoked_reason})` : '',
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
      return;
    }

    if (command === 'revoke') {
      if (keep && !/^[0-9a-f-]{36}$/i.test(keep)) {
        console.error('--keep expects a session id (uuid)');
        process.exitCode = 1;
        return;
      }
      const result = await client.query(
        `update sessions
            set revoked_at = now(), revoked_reason = $2
          where user_id = $1 and revoked_at is null and ($3::uuid is null or id <> $3::uuid)
          returning id`,
        [account.id, `operator:${reason}`, keep ?? null],
      );
      await client.query(
        `insert into audit_logs (actor_id, action, target_type, target_id, metadata)
         values (null, 'admin.sessions_revoked_offline', 'user', $1, $2::jsonb)`,
        [account.id, JSON.stringify({ revoked: result.rowCount, keep: keep ?? null, reason })],
      );
      console.log(`revoked ${result.rowCount} session(s) for ${account.username}${keep ? ` (kept ${keep})` : ''}`);
      return;
    }

    console.error(`unknown command "${command}"`);
    process.exitCode = 1;
  } finally {
    client.release();
    await handle.close();
  }
}

main().catch((error) => {
  logger.error({ error }, 'sessions tool failed');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
