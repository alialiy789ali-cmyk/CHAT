-- 0002_messaging.sql — conversations, members, messages, receipts and reactions.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group', 'channel')),
  title text,
  description text,
  avatar_url text,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  owner_id uuid references users(id) on delete set null,
  -- Deterministic key for direct conversations so the same pair can never create two threads.
  direct_key text unique,
  -- Only set to true once a real, audited E2EE implementation is enabled (see docs/SECURITY.md).
  is_encrypted boolean not null default false,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint conversation_title_len check (title is null or char_length(title) between 1 and 80),
  constraint direct_requires_key check ((type = 'direct') = (direct_key is not null))
);
create index conversations_last_message_idx on conversations (last_message_at desc nulls last);

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'moderator', 'member', 'subscriber')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  muted_until timestamptz,
  notifications text not null default 'all' check (notifications in ('all', 'mentions', 'none')),
  last_read_message_id uuid,
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on conversation_members (user_id) where left_at is null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid references users(id) on delete set null,
  client_message_id text,
  type text not null default 'text' check (type in ('text', 'image', 'video', 'audio', 'voice', 'file', 'system')),
  body text,
  reply_to_id uuid references messages(id) on delete set null,
  forwarded_from_id uuid references messages(id) on delete set null,
  mentions uuid[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  -- E2EE envelope columns: unused while is_encrypted = false. Documented in docs/SECURITY.md.
  ciphertext text,
  encryption_scheme text not null default 'none' check (encryption_scheme in ('none', 'libsignal-v1')),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint message_body_len check (body is null or char_length(body) <= 8000),
  constraint message_has_content check (
    deleted_at is not null
    or type = 'system'
    or ciphertext is not null
    or (body is not null and char_length(body) > 0)
  )
);
-- Idempotent sends: a client retrying the same clientMessageId cannot duplicate the row.
create unique index messages_client_id_unique on messages (conversation_id, sender_id, client_message_id)
  where client_message_id is not null;
create index messages_conversation_created_idx on messages (conversation_id, created_at desc, id desc);
create index messages_sender_idx on messages (sender_id, created_at desc);
create index messages_body_search_idx on messages using gin (to_tsvector('simple', coalesce(body, '')));

create table message_receipts (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state text not null check (state in ('delivered', 'read')),
  at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_receipts_user_idx on message_receipts (user_id, at desc);

create table message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji),
  constraint reaction_emoji_len check (char_length(emoji) <= 16)
);

-- Conversations are soft-deleted but messages inside them are hard-linked; catalogue them for search.
create index conversations_visibility_idx on conversations (visibility) where deleted_at is null;

create trigger conversations_set_updated_at before update on conversations
for each row execute function set_updated_at();

-- Keep conversations.last_message_at in sync without an application round-trip.
create or replace function touch_conversation_last_message() returns trigger as $$
begin
  update conversations set last_message_at = new.created_at, updated_at = now() where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

create trigger messages_touch_conversation after insert on messages
for each row execute function touch_conversation_last_message();

-- Attachment ownership: an attachment may only be attached to a message once.
alter table attachments
  add constraint attachments_message_fk foreign key (message_id) references messages(id) on delete cascade;
