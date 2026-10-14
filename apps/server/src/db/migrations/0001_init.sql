-- 0001_init.sql — core identity, sessions and social graph.
-- Conventions used across the whole schema:
--   * uuid primary keys generated in the database (gen_random_uuid, pgcrypto/PG13+ builtin),
--   * timestamptz everywhere, always UTC,
--   * soft delete via deleted_at where audit/history matters,
--   * every user-supplied string has an explicit length limit.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------- users
create table users (
  id uuid primary key default gen_random_uuid(),
  username citext not null unique,
  email citext not null unique,
  password_hash text not null,
  display_name text not null,
  bio text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'moderator', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'deactivated', 'deleted')),
  email_verified_at timestamptz,
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  two_factor_secret_encrypted text,
  two_factor_enabled_at timestamptz,
  privacy_settings jsonb not null default '{"whoCanMessage":"everyone","whoCanSeeProfile":"everyone","readReceipts":true,"showOnlineStatus":true}'::jsonb,
  notification_settings jsonb not null default '{"conversationNotifications":"all","pushEnabled":false}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint username_format check (username ~ '^[a-z][a-z0-9_]{2,23}$'),
  constraint display_name_len check (char_length(display_name) between 1 and 60),
  constraint bio_len check (bio is null or char_length(bio) <= 300)
);
create index users_created_idx on users (created_at desc);
create index users_search_idx on users using gin (to_tsvector('simple', username::text || ' ' || display_name));

-- ---------------------------------------------------------------- devices & sessions
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null default 'Unknown device',
  platform text not null default 'unknown' check (platform in ('web', 'android', 'ios', 'desktop', 'unknown')),
  push_token text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index devices_user_idx on devices (user_id) where revoked_at is null;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid references devices(id) on delete set null,
  refresh_token_hash text not null,
  refresh_token_family uuid not null default gen_random_uuid(),
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;
create index sessions_hash_idx on sessions (refresh_token_hash);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('email_verify', 'password_reset', 'invite', 'login_2fa')),
  token_hash text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_user_idx on auth_tokens (user_id, kind);

-- ---------------------------------------------------------------- social graph
create table follows (
  follower_id uuid not null references users(id) on delete cascade,
  following_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self check (follower_id <> following_id)
);
create index follows_following_idx on follows (following_id);

create table blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on blocks (blocked_id);

-- ---------------------------------------------------------------- attachments (metadata)
create table attachments (
  id uuid primary key default gen_random_uuid(),
  uploader_id uuid not null references users(id) on delete cascade,
  message_id uuid,
  post_id uuid,
  storage_key text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  width integer,
  height integer,
  duration_ms integer,
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected', 'skipped')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index attachments_uploader_idx on attachments (uploader_id, created_at desc);
create index attachments_message_idx on attachments (message_id) where message_id is not null;

-- ---------------------------------------------------------------- audit trail
create table audit_logs (
  id bigserial primary key,
  actor_id uuid references users(id) on delete set null,
  actor_ip text,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id, created_at desc);
create index audit_logs_action_idx on audit_logs (action, created_at desc);

-- ---------------------------------------------------------------- rate limiting / attempt tracking
create table login_attempts (
  id bigserial primary key,
  identifier text not null,
  ip text,
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);
create index login_attempts_identifier_idx on login_attempts (identifier, created_at desc);

-- ---------------------------------------------------------------- updated_at helper
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_set_updated_at before update on users
for each row execute function set_updated_at();
