-- 0003_social.sql — public posts (X-like timeline), feeds, hashtags, moderation.

create table posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references users(id) on delete cascade,
  body text not null,
  visibility text not null default 'public' check (visibility in ('public', 'followers')),
  reply_to_id uuid references posts(id) on delete cascade,
  repost_of_id uuid references posts(id) on delete cascade,
  quote_of_id uuid references posts(id) on delete set null,
  hashtags text[] not null default '{}',
  mentions text[] not null default '{}',
  like_count integer not null default 0,
  comment_count integer not null default 0,
  repost_count integer not null default 0,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint post_body_len check (char_length(body) <= 4000),
  constraint post_has_content check (
    deleted_at is not null or char_length(body) > 0 or repost_of_id is not null
  ),
  constraint post_repost_exclusive check (not (repost_of_id is not null and quote_of_id is not null))
);
-- A user can repost a given post at most once (regular repost; quotes are separate posts).
create unique index posts_unique_repost on posts (author_id, repost_of_id) where repost_of_id is not null and deleted_at is null;
create index posts_author_created_idx on posts (author_id, created_at desc) where deleted_at is null;
create index posts_created_idx on posts (created_at desc) where deleted_at is null and repost_of_id is null;
create index posts_reply_idx on posts (reply_to_id) where reply_to_id is not null;
create index posts_hashtags_idx on posts using gin (hashtags);
create index posts_body_search_idx on posts using gin (to_tsvector('simple', body));

alter table attachments
  add constraint attachments_post_fk foreign key (post_id) references posts(id) on delete cascade;

create table post_likes (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index post_likes_user_idx on post_likes (user_id, created_at desc);

-- ---------------------------------------------------------------- channels (Telegram-like)
create table channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  slug citext not null unique,
  description text,
  avatar_url text,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  subscriber_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint channel_name_len check (char_length(name) between 3 and 60),
  constraint channel_slug_format check (slug ~ '^[a-z][a-z0-9_]{2,39}$')
);
create index channels_visibility_idx on channels (visibility, subscriber_count desc) where deleted_at is null;

create table channel_members (
  channel_id uuid not null references channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'subscriber' check (role in ('owner', 'admin', 'moderator', 'subscriber')),
  joined_at timestamptz not null default now(),
  last_read_post_at timestamptz,
  primary key (channel_id, user_id)
);
create index channel_members_user_idx on channel_members (user_id);

create table channel_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  pinned_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint channel_post_body_len check (char_length(body) between 1 and 8000)
);
create index channel_posts_channel_idx on channel_posts (channel_id, created_at desc) where deleted_at is null;

alter table attachments add column if not exists channel_post_id uuid;
alter table attachments
  add constraint attachments_channel_post_fk foreign key (channel_post_id) references channel_posts(id) on delete cascade;

create table channel_invites (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  code text not null unique,
  created_by uuid references users(id) on delete set null,
  role text not null default 'subscriber' check (role in ('admin', 'moderator', 'subscriber')),
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index channel_invites_channel_idx on channel_invites (channel_id) where revoked_at is null;

-- ---------------------------------------------------------------- moderation
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references users(id) on delete set null,
  target_type text not null check (target_type in ('user', 'post', 'message', 'channel', 'comment')),
  target_id text not null,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved')),
  decision text check (decision in ('dismissed', 'hidden', 'removed', 'user_warned', 'user_suspended')),
  handled_by uuid references users(id) on delete set null,
  handled_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index reports_status_idx on reports (status, created_at desc);
create unique index reports_one_per_reporter on reports (reporter_id, target_type, target_id) where status = 'open';

create table moderation_actions (
  id bigserial primary key,
  moderator_id uuid references users(id) on delete set null,
  target_type text not null,
  target_id text not null,
  action text not null,
  reason text,
  report_id uuid references reports(id) on delete set null,
  created_at timestamptz not null default now()
);
create index moderation_actions_target_idx on moderation_actions (target_type, target_id);

-- ---------------------------------------------------------------- notifications
create table notifications (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  actor_id uuid references users(id) on delete set null,
  conversation_id uuid references conversations(id) on delete cascade,
  post_id uuid references posts(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, read_at, created_at desc);

create trigger channels_set_updated_at before update on channels
for each row execute function set_updated_at();

-- Extract hashtags and mentions into arrays at write time (application passes them, DB validates shape).
create or replace function posts_normalise_arrays() returns trigger as $$
begin
  select array(select distinct lower(h) from unnest(new.hashtags) as h where h <> '')
    into new.hashtags;
  select array(select distinct lower(m) from unnest(new.mentions) as m where m <> '')
    into new.mentions;
  return new;
end;
$$ language plpgsql;

create trigger posts_normalise before insert or update of hashtags, mentions on posts
for each row execute function posts_normalise_arrays();
