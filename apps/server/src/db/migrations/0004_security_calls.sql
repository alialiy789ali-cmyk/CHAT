-- 0004_security_calls.sql — device identity keys (E2EE groundwork), push subscriptions,
-- calls/signalling history and live rooms.
--
-- IMPORTANT: the tables below reserve the *shape* of end-to-end encryption (device identity
-- keys + prekeys) so that clients can start publishing keys. The server NEVER claims E2EE
-- unless the flags `users.e2ee_ready` / `conversations.is_encrypted` are set by a verified
-- client session and the enforcement rules in docs/SECURITY.md are met.

-- ---------------------------------------------------------------- E2EE device keys
create table device_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  -- Long-term identity public key (curve25519, base64) produced by the client.
  identity_key_public text not null,
  -- Signed prekey and its signature (created by an audited library on the client).
  signed_prekey_public text not null,
  signed_prekey_signature text not null,
  -- One-time prekeys available for X3DH-style session setup.
  one_time_prekeys jsonb not null default '[]'::jsonb,
  registration_id integer not null,
  algorithm text not null default 'libsignal-v1' check (algorithm in ('libsignal-v1')),
  verified_at timestamptz,
  verification_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id),
  unique (user_id, identity_key_public)
);
create index device_keys_user_idx on device_keys (user_id);

alter table users add column if not exists e2ee_ready boolean not null default false;
alter table devices add column if not exists identity_key_fingerprint text;

-- ---------------------------------------------------------------- push subscriptions
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  provider text not null check (provider in ('webpush', 'fcm', 'apns', 'none')),
  endpoint text not null,
  keys jsonb not null default '{}'::jsonb,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (provider, endpoint)
);
create index push_subscriptions_user_idx on push_subscriptions (user_id) where revoked_at is null;

-- ---------------------------------------------------------------- WebRTC calls
create table calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  initiator_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('audio', 'video')),
  state text not null default 'ringing' check (state in ('ringing', 'active', 'ended', 'missed', 'declined', 'failed')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  ended_by uuid references users(id) on delete set null,
  duration_ms integer
);
create index calls_conversation_idx on calls (conversation_id, started_at desc);
create index calls_state_idx on calls (state) where state in ('ringing', 'active');

create table call_participants (
  call_id uuid not null references calls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state text not null default 'invited' check (state in ('invited', 'joined', 'declined', 'missed', 'left')),
  joined_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);
create index call_participants_user_idx on call_participants (user_id, joined_at desc);

-- ---------------------------------------------------------------- live rooms (audio spaces / group calls)
create table live_rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  title text not null,
  topic text,
  kind text not null default 'audio_space' check (kind in ('audio_space', 'group_call')),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  state text not null default 'live' check (state in ('scheduled', 'live', 'ended')),
  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint live_room_title_len check (char_length(title) between 1 and 120)
);
create index live_rooms_state_idx on live_rooms (state, started_at desc);

create table live_room_participants (
  room_id uuid not null references live_rooms(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'listener' check (role in ('host', 'speaker', 'listener')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (room_id, user_id)
);
