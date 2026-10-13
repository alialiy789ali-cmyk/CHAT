import type { Db } from '../db/pool.js';

/**
 * Devices, sessions, one-time auth tokens and login-attempt bookkeeping.
 * Refresh tokens are stored as SHA-256 hashes only (a database leak must not
 * be enough to impersonate a user).
 */

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: 'web' | 'android' | 'ios' | 'desktop' | 'unknown';
  push_token: string | null;
  /** Small JSON bag for public device metadata (e.g. the published Kyber prekey). */
  metadata?: Record<string, unknown>;
  last_seen_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  refresh_token_hash: string;
  refresh_token_family: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  async createDevice(input: {
    userId: string;
    name: string;
    platform: DeviceRow['platform'];
  }): Promise<DeviceRow> {
    return this.db.oneOrFail<DeviceRow>(
      `insert into devices (user_id, name, platform) values ($1, $2, $3)
       returning id, user_id, name, platform, push_token, last_seen_at, created_at, revoked_at`,
      [input.userId, input.name, input.platform],
      'service_unavailable',
    );
  }

  listDevices(userId: string): Promise<DeviceRow[]> {
    return this.db.many<DeviceRow>(
      `select id, user_id, name, platform, push_token, metadata, last_seen_at, created_at, revoked_at
       from devices where user_id = $1 and revoked_at is null order by last_seen_at desc`,
      [userId],
    );
  }

  async revokeDevice(userId: string, deviceId: string): Promise<number> {
    const res = await this.db.query(
      'update devices set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
      [deviceId, userId],
    );
    await this.db.query('delete from device_keys where device_id = $1', [deviceId]);
    return res.rowCount ?? 0;
  }

  findDevice(deviceId: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>(
      'select id, user_id, name, platform, push_token, metadata, last_seen_at, created_at, revoked_at from devices where id = $1',
      [deviceId],
    );
  }

  /** Public per-device metadata (today: the current Kyber prekey). Never holds private keys. */
  async setDeviceMetadata(deviceId: string, patch: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `update devices set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb where id = $1`,
      [deviceId, JSON.stringify(patch)],
    );
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.db.query('update devices set last_seen_at = now() where id = $1', [deviceId]);
  }

  async createSession(input: {
    userId: string;
    deviceId: string | null;
    refreshTokenHash: string;
    family?: string;
    ip: string | null;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<SessionRow> {
    return this.db.oneOrFail<SessionRow>(
      `insert into sessions (user_id, device_id, refresh_token_hash, refresh_token_family, ip, user_agent, expires_at)
       values ($1, $2, $3, coalesce($4::uuid, gen_random_uuid()), $5, $6, $7)
       returning *`,
      [
        input.userId,
        input.deviceId,
        input.refreshTokenHash,
        input.family ?? null,
        input.ip,
        input.userAgent,
        input.expiresAt,
      ],
      'service_unavailable',
    );
  }

  findSession(id: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>('select * from sessions where id = $1', [id]);
  }

  findByRefreshHash(hash: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>('select * from sessions where refresh_token_hash = $1', [hash]);
  }

  countActiveSessions(userId: string): Promise<number> {
    return this.db
      .one<{ count: string }>(
        'select count(*)::text as count from sessions where user_id = $1 and revoked_at is null and expires_at > now()',
        [userId],
      )
      .then((row) => Number(row?.count ?? 0));
  }

  async rotateSession(sessionId: string, refreshTokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      'update sessions set refresh_token_hash = $2, expires_at = $3, last_used_at = now() where id = $1',
      [sessionId, refreshTokenHash, expiresAt],
    );
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db.query(
      'update sessions set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null',
      [sessionId, reason],
    );
  }

  /** Reuse detection: revoke every session that shares the token family. */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const res = await this.db.query(
      'update sessions set revoked_at = now(), revoked_reason = $2 where refresh_token_family = $1 and revoked_at is null',
      [familyId, reason],
    );
    return res.rowCount ?? 0;
  }

  async listSessions(userId: string): Promise<Array<SessionRow & { device_name: string | null; device_platform: string | null }>> {
    return this.db.many(
      `select s.*, d.name as device_name, d.platform as device_platform
       from sessions s left join devices d on d.id = s.device_id
       where s.user_id = $1 and s.revoked_at is null and s.expires_at > now()
       order by s.last_used_at desc`,
      [userId],
    );
  }

  async pruneExpiredSessions(): Promise<number> {
    const res = await this.db.query(
      "delete from sessions where expires_at < now() - interval '7 days' or (revoked_at is not null and revoked_at < now() - interval '30 days')",
    );
    return res.rowCount ?? 0;
  }

  /** ------------------------------------------------------------- one-time tokens */

  async createAuthToken(input: {
    userId: string;
    kind: 'email_verify' | 'password_reset' | 'invite' | 'login_2fa';
    tokenHash: string;
    expiresAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Invalidate previous unused tokens of the same kind to avoid token sprawl.
    await this.db.query(
      'update auth_tokens set used_at = now() where user_id = $1 and kind = $2 and used_at is null',
      [input.userId, input.kind],
    );
    await this.db.query(
      'insert into auth_tokens (user_id, kind, token_hash, expires_at, metadata) values ($1, $2, $3, $4, $5)',
      [input.userId, input.kind, input.tokenHash, input.expiresAt, JSON.stringify(input.metadata ?? {})],
    );
  }

  async consumeAuthToken(tokenHash: string, kind: 'email_verify' | 'password_reset' | 'invite' | 'login_2fa') {
    const row = await this.db.one<{
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
      metadata: Record<string, unknown>;
    }>('select user_id, expires_at, used_at, metadata from auth_tokens where token_hash = $1 and kind = $2', [
      tokenHash,
      kind,
    ]);
    // A single, fully-populated result shape keeps call sites type-safe.
    if (!row) return null;
    const reused = row.used_at !== null;
    const expired = row.expires_at.getTime() < Date.now();
    if (!reused && !expired) {
      await this.db.query('update auth_tokens set used_at = now() where token_hash = $1', [tokenHash]);
    }
    return { user_id: row.user_id, metadata: row.metadata, reused, expired };
  }

  /** ------------------------------------------------------------- login attempts */

  async recordLoginAttempt(input: { identifier: string; ip: string | null; succeeded: boolean }): Promise<void> {
    await this.db.query('insert into login_attempts (identifier, ip, succeeded) values ($1, $2, $3)', [
      input.identifier.toLowerCase(),
      input.ip,
      input.succeeded,
    ]);
    if (input.succeeded) {
      await this.db.query('delete from login_attempts where identifier = $1', [input.identifier.toLowerCase()]);
    }
  }

  async recentFailures(identifier: string, windowMinutes = 15): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `select count(*)::text as count from login_attempts
       where identifier = $1 and succeeded = false and created_at > now() - ($2 || ' minutes')::interval`,
      [identifier.toLowerCase(), String(windowMinutes)],
    );
    return Number(row?.count ?? 0);
  }

  async recentFailuresByIp(ip: string, windowMinutes = 15): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `select count(*)::text as count from login_attempts
       where ip = $1 and succeeded = false and created_at > now() - ($2 || ' minutes')::interval`,
      [ip, String(windowMinutes)],
    );
    return Number(row?.count ?? 0);
  }
}
