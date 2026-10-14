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
  algorithm: 'libsignal-v1' | 'olm-v1';
  identity_key_public: string;
  signing_key_public: string | null;
  identity_signature: string | null;
  signed_prekey_id: number;
  /** Null for Olm devices: the field belongs to the Signal protocol only. */
  signed_prekey_public: string | null;
  signed_prekey_signature: string | null;
  kyber_prekey_id: number | null;
  kyber_prekey_public: string | null;
  kyber_prekey_signature: string | null;
  one_time_prekeys: Array<{ id: number; key: string }>;
  registration_id: number;
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
    signedPrekeyId?: number;
    signedPrekeyPublic: string;
    signedPrekeySignature: string;
    kyberPrekey?: { id: number; publicKey: string; signature: string } | null;
    oneTimePrekeys: Array<{ id: number; key: string }>;
    registrationId: number;
  }): Promise<DeviceKeyRow> {
    return this.db.oneOrFail<DeviceKeyRow>(
      `insert into device_keys (user_id, device_id, identity_key_public, signed_prekey_id, signed_prekey_public, signed_prekey_signature,
                                kyber_prekey_id, kyber_prekey_public, kyber_prekey_signature, one_time_prekeys, registration_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (device_id) do update set
         identity_key_public = excluded.identity_key_public,
         signed_prekey_id = excluded.signed_prekey_id,
         signed_prekey_public = excluded.signed_prekey_public,
         signed_prekey_signature = excluded.signed_prekey_signature,
         kyber_prekey_id = excluded.kyber_prekey_id,
         kyber_prekey_public = excluded.kyber_prekey_public,
         kyber_prekey_signature = excluded.kyber_prekey_signature,
         one_time_prekeys = excluded.one_time_prekeys,
         registration_id = excluded.registration_id,
         updated_at = now()
       returning *`,
      [
        input.userId,
        input.deviceId,
        input.identityKeyPublic,
        input.signedPrekeyId ?? 0,
        input.signedPrekeyPublic,
        input.signedPrekeySignature,
        input.kyberPrekey?.id ?? null,
        input.kyberPrekey?.publicKey ?? null,
        input.kyberPrekey?.signature ?? null,
        JSON.stringify(input.oneTimePrekeys),
        input.registrationId,
      ],
      'service_unavailable',
    );
  }

  /**
   * Publishes a Matrix Olm device: Curve25519 identity key, the Ed25519 key that signs it,
   * that signature, and a fresh batch of one-time keys. Olm keys have no signed prekey or
   * Kyber key (they are not part of that protocol), so those columns stay empty.
   */
  async publishOlm(input: {
    userId: string;
    deviceId: string;
    identityKey: string;
    signingKey: string;
    signature: string;
    oneTimeKeys: Array<{ id: string; key: string }>;
  }): Promise<DeviceKeyRow> {
    return this.db.oneOrFail<DeviceKeyRow>(
      `insert into device_keys (user_id, device_id, algorithm, identity_key_public, signing_key_public, identity_signature,
                                one_time_prekeys, registration_id)
       values ($1, $2, 'olm-v1', $3, $4, $5, $6, 0)
       on conflict (device_id) do update set
         algorithm = 'olm-v1',
         identity_key_public = excluded.identity_key_public,
         signing_key_public = excluded.signing_key_public,
         identity_signature = excluded.identity_signature,
         one_time_prekeys = excluded.one_time_prekeys,
         signed_prekey_id = 0,
         signed_prekey_public = null,
         signed_prekey_signature = null,
         kyber_prekey_id = null,
         kyber_prekey_public = null,
         kyber_prekey_signature = null,
         updated_at = now()
       returning *`,
      [
        input.userId,
        input.deviceId,
        input.identityKey,
        input.signingKey,
        input.signature,
        JSON.stringify(input.oneTimeKeys.map((entry) => ({ id: entry.id, key: entry.key }))),
      ],
      'service_unavailable',
    );
  }

  /** Adds one-time keys to an Olm device without touching its identity (the normal top-up). */
  async appendOlmOneTimeKeys(deviceId: string, keys: Array<{ id: string; key: string }>): Promise<number> {
    const row = await this.db.oneOrFail<{ one_time_prekeys: Array<{ id: string; key: string }> }>(
      `update device_keys
       set one_time_prekeys = one_time_prekeys || $2::jsonb, updated_at = now()
       where device_id = $1 and algorithm = 'olm-v1'
       returning one_time_prekeys`,
      [deviceId, JSON.stringify(keys)],
      'not_found',
    );
    return row.one_time_prekeys.length;
  }

  findByDevice(deviceId: string): Promise<DeviceKeyRow | null> {
    return this.db.one<DeviceKeyRow>('select * from device_keys where device_id = $1', [deviceId]);
  }

  /** Per-device prekey inventory, used by the client to know when to replenish. */
  async inventory(userId: string) {
    const rows = await this.db.many<{
      device_id: string;
      remaining: string;
      identity_key_public: string;
      verified_at: Date | null;
      algorithm: 'libsignal-v1' | 'olm-v1';
      signing_key_public: string | null;
    }>(
      `select device_id, jsonb_array_length(one_time_prekeys)::text as remaining, identity_key_public, verified_at,
              algorithm, signing_key_public
       from device_keys where user_id = $1`,
      [userId],
    );
    return rows.map((row) => ({
      deviceId: row.device_id,
      // The owning client needs the scheme to know which ratchet to load for this device.
      algorithm: row.algorithm,
      signingKey: row.signing_key_public,
      remainingOneTimePreKeys: Number(row.remaining),
      identityKey: row.identity_key_public,
      verifiedAt: row.verified_at,
    }));
  }

  async appendOneTimePrekeys(deviceId: string, keys: Array<{ id: number; key: string }>): Promise<number> {
    const row = await this.db.oneOrFail<{ one_time_prekeys: Array<{ id: number; key: string }> }>(
      `update device_keys
       set one_time_prekeys = one_time_prekeys || $2::jsonb, updated_at = now()
       where device_id = $1
       returning one_time_prekeys`,
      [deviceId, JSON.stringify(keys)],
      'not_found',
    );
    return row.one_time_prekeys.length;
  }

  forUser(userId: string) {
    return this.db.many<{
      device_id: string;
      algorithm: 'libsignal-v1' | 'olm-v1';
      identity_key_public: string;
      signing_key_public: string | null;
      identity_signature: string | null;
      signed_prekey_id: number;
      signed_prekey_public: string | null;
      signed_prekey_signature: string | null;
      kyber_prekey_id: number | null;
      kyber_prekey_public: string | null;
      kyber_prekey_signature: string | null;
      registration_id: number;
      verification_fingerprint: string | null;
      verified_at: Date | null;
      device_name: string | null;
      platform: string | null;
    }>(
      `select k.device_id, k.algorithm, k.identity_key_public, k.signing_key_public, k.identity_signature,
              k.signed_prekey_id, k.signed_prekey_public, k.signed_prekey_signature,
              k.kyber_prekey_id, k.kyber_prekey_public, k.kyber_prekey_signature, k.registration_id,
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
  async takeOneTimePrekey(deviceId: string): Promise<{ id: number | string; key: string } | null> {
    return this.db.withTransaction(async (tx) => {
      const row = await tx.one<{ one_time_prekeys: Array<{ id: number | string; key: string }> }>(
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

  async markUserE2eeReady(userId: string, ready: boolean): Promise<void> {
    await this.db.query('update users set e2ee_ready = $2 where id = $1', [userId, ready]);
  }

  /** ------------------------------------------------------- device verification */

  /**
   * Records that `verifierId` compared the safety number of one specific device.
   * `verified: false` removes the mark (an unverified device must never look verified).
   */
  async setVerification(input: {
    verifierId: string;
    deviceId: string;
    fingerprint: string;
    verified: boolean;
  }): Promise<void> {
    if (!input.verified) {
      await this.db.query('delete from device_verifications where verifier_id = $1 and device_id = $2', [
        input.verifierId,
        input.deviceId,
      ]);
      return;
    }
    await this.db.query(
      `insert into device_verifications (verifier_id, device_id, fingerprint, verified_at)
       values ($1, $2, $3, now())
       on conflict (verifier_id, device_id) do update set fingerprint = excluded.fingerprint, verified_at = now()`,
      [input.verifierId, input.deviceId, input.fingerprint],
    );
    // Cache the fingerprint on the device row so other members can display "verified by N people"
    // without joining every verification row.
    await this.db.query('update devices set identity_key_fingerprint = $2 where id = $1', [input.deviceId, input.fingerprint]);
    await this.db.query(
      'update device_keys set verification_fingerprint = $2, verified_at = now() where device_id = $1',
      [input.deviceId, input.fingerprint],
    );
  }

  /** Verification state of every key-publishing device of `userId`, as seen by `verifierId`. */
  async verificationsFor(verifierId: string, userId: string) {
    const rows = await this.db.many<{
      device_id: string;
      fingerprint: string;
      verified_at: Date | null;
      device_name: string | null;
      platform: string | null;
    }>(
      `select k.device_id,
              coalesce(v.fingerprint, k.identity_key_public) as fingerprint,
              v.verified_at,
              d.name as device_name,
              d.platform
       from device_keys k
       join devices d on d.id = k.device_id
       left join device_verifications v on v.device_id = k.device_id and v.verifier_id = $1
       where k.user_id = $2 and d.revoked_at is null
       order by d.created_at asc`,
      [verifierId, userId],
    );
    return rows.map((row) => ({
      deviceId: row.device_id,
      fingerprint: row.fingerprint,
      verified: row.verified_at !== null,
      verifiedAt: row.verified_at,
      deviceName: row.device_name,
      platform: row.platform,
    }));
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
