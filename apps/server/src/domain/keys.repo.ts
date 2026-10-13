import type { Db } from '../db/pool.js';

/**
 * E2EE key material published by clients (identity key, signed prekey, one-time prekeys)
 * and push subscriptions.
 *
 * The server stores **public** keys only. Private keys never leave the device
 * (see docs/SECURITY.md for the threat model and current implementation status).
 */

export interface DeviceKeyRow {
  id: string;
  user_id: string;
  device_id: string;
  identity_key_public: string;
  signed_prekey_public: string;
  signed_prekey_signature: string;
  one_time_prekeys: Array<{ id: number; key: string }>;
  registration_id: number;
  algorithm: 'libsignal-v1';
  verified_at: Date | null;
  verification_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
}

export class KeysRepo {
  constructor(private readonly db: Db) {}

  async publish(input: {
    userId: string;
    deviceId: string;
    identityKeyPublic: string;
    signedPrekeyPublic: string;
    signedPrekeySignature: string;
    oneTimePrekeys: Array<{ id: number; key: string }>;
    registrationId: number;
  }): Promise<DeviceKeyRow> {
    return this.db.oneOrFail<DeviceKeyRow>(
      `insert into device_keys (user_id, device_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekeys, registration_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (device_id) do update set
         identity_key_public = excluded.identity_key_public,
         signed_prekey_public = excluded.signed_prekey_public,
         signed_prekey_signature = excluded.signed_prekey_signature,
         one_time_prekeys = excluded.one_time_prekeys,
         registration_id = excluded.registration_id,
         updated_at = now()
       returning *`,
      [
        input.userId,
        input.deviceId,
        input.identityKeyPublic,
        input.signedPrekeyPublic,
        input.signedPrekeySignature,
        JSON.stringify(input.oneTimePrekeys),
        input.registrationId,
      ],
      'service_unavailable',
    );
  }

  forUser(userId: string) {
    return this.db.many<{
      device_id: string;
      identity_key_public: string;
      signed_prekey_public: string;
      signed_prekey_signature: string;
      registration_id: number;
      verification_fingerprint: string | null;
      verified_at: Date | null;
      device_name: string | null;
      platform: string | null;
    }>(
      `select k.device_id, k.identity_key_public, k.signed_prekey_public, k.signed_prekey_signature, k.registration_id,
              k.verification_fingerprint, k.verified_at, d.name as device_name, d.platform
       from device_keys k join devices d on d.id = k.device_id
       where k.user_id = $1 and d.revoked_at is null`,
      [userId],
    );
  }

  /**
   * Atomically pops one one-time prekey for session setup. `FOR UPDATE SKIP LOCKED`
   * keeps concurrent X3DH handshakes from consuming the same key.
   */
  async takeOneTimePrekey(deviceId: string): Promise<{ id: number; key: string } | null> {
    return this.db.withTransaction(async (tx) => {
      const row = await tx.one<{ one_time_prekeys: Array<{ id: number; key: string }> }>(
        'select one_time_prekeys from device_keys where device_id = $1 for update',
        [deviceId],
      );
      if (!row || row.one_time_prekeys.length === 0) return null;
      const [first, ...rest] = row.one_time_prekeys;
      await tx.query('update device_keys set one_time_prekeys = $2 where device_id = $1', [deviceId, JSON.stringify(rest)]);
      return first ?? null;
    });
  }

  async remainingPrekeyCount(deviceId: string): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      'select jsonb_array_length(one_time_prekeys)::text as count from device_keys where device_id = $1',
      [deviceId],
    );
    return Number(row?.count ?? 0);
  }

  async setVerification(deviceId: string, fingerprint: string, verified: boolean): Promise<void> {
    await this.db.query(
      'update device_keys set verification_fingerprint = $2, verified_at = case when $3 then now() else null end where device_id = $1',
      [deviceId, fingerprint, verified],
    );
    await this.db.query('update devices set identity_key_fingerprint = $2 where id = $1', [deviceId, fingerprint]);
  }

  async markUserE2eeReady(userId: string, ready: boolean): Promise<void> {
    await this.db.query('update users set e2ee_ready = $2 where id = $1', [userId, ready]);
  }

  /** ------------------------------------------------------------- push subscriptions */

  async savePushSubscription(input: {
    userId: string;
    deviceId?: string | null;
    provider: 'webpush' | 'fcm' | 'apns' | 'none';
    endpoint: string;
    keys?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `insert into push_subscriptions (user_id, device_id, provider, endpoint, keys)
       values ($1, $2, $3, $4, $5)
       on conflict (provider, endpoint) do update set user_id = excluded.user_id, device_id = excluded.device_id, keys = excluded.keys, revoked_at = null`,
      [input.userId, input.deviceId ?? null, input.provider, input.endpoint, JSON.stringify(input.keys ?? {})],
    );
  }

  activePushEndpoints(userId: string) {
    return this.db.many<{ id: string; provider: string; endpoint: string; keys: Record<string, unknown> }>(
      'select id, provider, endpoint, keys from push_subscriptions where user_id = $1 and revoked_at is null',
      [userId],
    );
  }

  async revokePushEndpoint(userId: string, endpoint: string): Promise<void> {
    await this.db.query('update push_subscriptions set revoked_at = now() where user_id = $1 and endpoint = $2', [userId, endpoint]);
  }
}
