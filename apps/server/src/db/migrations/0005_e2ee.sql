-- ============================================================================
-- 0005 — End-to-end encryption: device verification
--
-- The key material itself (identity key, signed prekey, one-time prekeys) already
-- lives in device_keys (0004). What is missing there is the *verification* state:
-- a safety-number check is a judgement made by one user about another user's
-- device, so it must be stored per verifier, never globally on the device row.
--
-- Nothing here lets the server read message contents: ciphertext columns already
-- exist on messages and are opaque blobs to the API.
-- ============================================================================

create table if not exists device_verifications (
  verifier_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  -- The fingerprint the verifier compared (they computed it from the public keys).
  fingerprint text not null,
  verified_at timestamptz not null default now(),
  primary key (verifier_id, device_id)
);

create index if not exists device_verifications_device_idx on device_verifications (device_id);

-- Fast lookup of "which devices of user X have published key material", used when a
-- client asks for a bundle and when a conversation is switched to encrypted mode.
create index if not exists device_keys_device_idx on device_keys (device_id);

-- Public per-device metadata: today the current Kyber (post-quantum) prekey published by the
-- device. Public keys only — private material never leaves the device.
alter table devices add column if not exists metadata jsonb not null default '{}'::jsonb;

-- The signed prekey id must round-trip to clients so they can reference the right record.
alter table device_keys add column if not exists signed_prekey_id integer not null default 0;
alter table device_keys add column if not exists kyber_prekey_id integer;
alter table device_keys add column if not exists kyber_prekey_public text;
alter table device_keys add column if not exists kyber_prekey_signature text;
