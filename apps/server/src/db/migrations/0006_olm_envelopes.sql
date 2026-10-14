-- ============================================================================
-- 0006 — Matrix Olm devices and per-device ciphertext envelopes
--
-- Two changes that belong together:
--
--  1. A second, equally audited E2EE scheme for the web client: Matrix Olm
--     (the reference double-ratchet implementation). It publishes a Curve25519 identity
--     key signed by an Ed25519 *signing* key, plus one-time keys — so device_keys needs
--     room for the signing key and that signature.
--
--  2. Multi-device correctness: one message row can no longer carry exactly one envelope,
--     because every recipient *device* needs its own copy (Olm/Signal sessions are
--     pairwise). Envelopes therefore live in their own table, and a client only ever
--     receives the envelope addressed to the device that asked.
-- ============================================================================

-- ---------------------------------------------------------------- schemes
alter table device_keys drop constraint if exists device_keys_algorithm_check;
alter table device_keys
  add constraint device_keys_algorithm_check check (algorithm in ('libsignal-v1', 'olm-v1'));

alter table messages drop constraint if exists messages_encryption_scheme_check;
alter table messages
  add constraint messages_encryption_scheme_check check (encryption_scheme in ('none', 'libsignal-v1', 'olm-v1'));

-- Public Ed25519 signing key of an Olm device and its signature over the identity key.
-- Both are public material; the private halves never leave the device.
alter table device_keys add column if not exists signing_key_public text;
alter table device_keys add column if not exists identity_signature text;

-- A signed prekey (X3DH) is a Signal-protocol concept with no Olm equivalent, so the columns
-- become nullable — but a Signal device must still have them, which the check below enforces.
-- Storing empty strings for an Olm device would be a lie the schema can avoid telling.
alter table device_keys alter column signed_prekey_public drop not null;
alter table device_keys alter column signed_prekey_signature drop not null;
alter table device_keys drop constraint if exists device_keys_prekey_shape_check;
alter table device_keys add constraint device_keys_prekey_shape_check check (
  (algorithm = 'libsignal-v1'
    and signed_prekey_public is not null and signed_prekey_signature is not null)
  or (algorithm = 'olm-v1'
    and signing_key_public is not null and identity_signature is not null)
);

-- The original rule from 0002 required the payload to sit on the message row itself. With one
-- envelope per recipient device that is no longer true: a multi-device message carries its
-- ciphertext in message_envelopes and nothing in messages.ciphertext. The constraint is relaxed
-- just far enough to allow an encrypted message with no inline payload — plaintext messages still
-- have to contain something, so an empty bubble can never be stored.
alter table messages drop constraint if exists message_has_content;
alter table messages add constraint message_has_content check (
  deleted_at is not null
  or type = 'system'
  or encryption_scheme <> 'none'
  or ciphertext is not null
  or (body is not null and char_length(body) > 0)
);

-- ---------------------------------------------------------------- envelopes
create table if not exists message_envelopes (
  message_id uuid not null references messages(id) on delete cascade,
  -- The recipient device this envelope was encrypted for.
  device_id uuid not null references devices(id) on delete cascade,
  scheme text not null check (scheme in ('libsignal-v1', 'olm-v1')),
  -- Opaque ciphertext (base64/JSON of the library message). The server cannot read it.
  ciphertext text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, device_id)
);

create index if not exists message_envelopes_device_idx on message_envelopes (device_id, created_at desc);
