import type { Db } from '../db/pool.js';
import { decodeCursor, encodeCursor } from '../lib/crypto.js';

/** Broadcast channels: public/private, admin roles, pinned posts, invite links. */

export interface ChannelRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  avatar_url: string | null;
  visibility: 'public' | 'private';
  subscriber_count: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ChannelPostRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  pinned_at: Date | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface ChannelMemberRow {
  channel_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'moderator' | 'subscriber';
  joined_at: Date;
  last_read_post_at: Date | null;
}

export class ChannelsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    ownerId: string;
    name: string;
    slug: string;
    description?: string | null;
    visibility: 'public' | 'private';
  }): Promise<ChannelRow> {
    return this.db.withTransaction(async (tx) => {
      const channel = await tx.oneOrFail<ChannelRow>(
        `insert into channels (owner_id, name, slug, description, visibility)
         values ($1, $2, $3, $4, $5) returning *`,
        [input.ownerId, input.name, input.slug, input.description ?? null, input.visibility],
        'service_unavailable',
      );
      await tx.query(
        `insert into channel_members (channel_id, user_id, role) values ($1, $2, 'owner')
         on conflict do nothing`,
        [channel.id, input.ownerId],
      );
      await tx.query('update channels set subscriber_count = 1 where id = $1', [channel.id]);
      return { ...channel, subscriber_count: 1 };
    });
  }

  findById(id: string): Promise<ChannelRow | null> {
    return this.db.one<ChannelRow>('select * from channels where id = $1 and deleted_at is null', [id]);
  }

  findBySlug(slug: string): Promise<ChannelRow | null> {
    return this.db.one<ChannelRow>('select * from channels where slug = $1 and deleted_at is null', [slug]);
  }

  update(id: string, patch: { name?: string; description?: string | null; avatarUrl?: string | null; visibility?: 'public' | 'private' }): Promise<ChannelRow> {
    return this.db.oneOrFail<ChannelRow>(
      `update channels set
         name = coalesce($2, name),
         description = coalesce($3, description),
         avatar_url = coalesce($4, avatar_url),
         visibility = coalesce($5, visibility)
       where id = $1 and deleted_at is null returning *`,
      [id, patch.name ?? null, patch.description === undefined ? null : patch.description, patch.avatarUrl === undefined ? null : patch.avatarUrl, patch.visibility ?? null],
      'channel_not_found',
    );
  }

  member(channelId: string, userId: string): Promise<ChannelMemberRow | null> {
    return this.db.one<ChannelMemberRow>('select * from channel_members where channel_id = $1 and user_id = $2', [
      channelId,
      userId,
    ]);
  }

  async join(channelId: string, userId: string, role: ChannelMemberRow['role'] = 'subscriber'): Promise<boolean> {
    const res = await this.db.query(
      `insert into channel_members (channel_id, user_id, role) values ($1, $2, $3) on conflict do nothing`,
      [channelId, userId, role],
    );
    const created = (res.rowCount ?? 0) > 0;
    if (created) await this.db.query('update channels set subscriber_count = subscriber_count + 1 where id = $1', [channelId]);
    return created;
  }

  async leave(channelId: string, userId: string): Promise<boolean> {
    const res = await this.db.query('delete from channel_members where channel_id = $1 and user_id = $2 and role <> $3', [
      channelId,
      userId,
      'owner',
    ]);
    const removed = (res.rowCount ?? 0) > 0;
    if (removed) await this.db.query('update channels set subscriber_count = greatest(0, subscriber_count - 1) where id = $1', [channelId]);
    return removed;
  }

  async setRole(channelId: string, userId: string, role: ChannelMemberRow['role']): Promise<void> {
    await this.db.query('update channel_members set role = $3 where channel_id = $1 and user_id = $2', [channelId, userId, role]);
  }

  async members(channelId: string, limit = 100) {
    return this.db.many<{
      user_id: string;
      role: ChannelMemberRow['role'];
      joined_at: Date;
      username: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      `select m.user_id, m.role, m.joined_at, u.username, u.display_name, u.avatar_url
       from channel_members m join users u on u.id = m.user_id
       where m.channel_id = $1
       order by case m.role when 'owner' then 0 when 'admin' then 1 when 'moderator' then 2 else 3 end, m.joined_at
       limit $2`,
      [channelId, limit],
    );
  }

  async createPost(input: { channelId: string; authorId: string; body: string }): Promise<ChannelPostRow> {
    return this.db.oneOrFail<ChannelPostRow>(
      `insert into channel_posts (channel_id, author_id, body) values ($1, $2, $3) returning *`,
      [input.channelId, input.authorId, input.body],
      'service_unavailable',
    );
  }

  async attachMedia(postId: string, attachmentIds: string[], uploaderId: string): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    const res = await this.db.query(
      `update attachments set channel_post_id = $1
       where id = any($2::uuid[]) and uploader_id = $3 and channel_post_id is null and message_id is null and post_id is null and deleted_at is null`,
      [postId, attachmentIds, uploaderId],
    );
    return res.rowCount ?? 0;
  }

  async listPosts(input: { channelId: string; limit: number; cursor?: string | null; search?: string | null }) {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db.many<ChannelPostRow & { author_username: string | null; author_display_name: string | null; author_avatar_url: string | null }>(
      `select cp.*, u.username as author_username, u.display_name as author_display_name, u.avatar_url as author_avatar_url
       from channel_posts cp left join users u on u.id = cp.author_id
       where cp.channel_id = $1 and cp.deleted_at is null
         and ($2::timestamptz is null or (cp.created_at, cp.id) < ($2::timestamptz, $3::uuid))
         and ($4::text is null or cp.body ilike '%' || $4 || '%')
       order by cp.pinned_at desc nulls last, cp.created_at desc, cp.id desc
       limit $5`,
      [input.channelId, decoded?.c ?? null, decoded?.i ?? null, input.search ?? null, input.limit],
    );
    const hasMore = rows.length === input.limit;
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: hasMore && last ? encodeCursor({ c: last.created_at.toISOString(), i: last.id }) : null,
    };
  }

  async findPost(postId: string) {
    return this.db.one<ChannelPostRow>('select * from channel_posts where id = $1 and deleted_at is null', [postId]);
  }

  async setPinned(postId: string, pinned: boolean): Promise<void> {
    await this.db.query(`update channel_posts set pinned_at = ${pinned ? 'now()' : 'null'} where id = $1`, [postId]);
  }

  async deletePost(postId: string): Promise<boolean> {
    const res = await this.db.query('update channel_posts set deleted_at = now() where id = $1 and deleted_at is null', [postId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** ------------------------------------------------------------- invites */

  async createInvite(input: {
    channelId: string;
    code: string;
    createdBy: string;
    role: 'admin' | 'moderator' | 'subscriber';
    maxUses?: number | null;
    expiresAt?: Date | null;
  }) {
    return this.db.oneOrFail<{ id: string; code: string; role: string; max_uses: number | null; uses: number; expires_at: Date | null }>(
      `insert into channel_invites (channel_id, code, created_by, role, max_uses, expires_at)
       values ($1, $2, $3, $4, $5, $6) returning id, code, role, max_uses, uses, expires_at`,
      [input.channelId, input.code, input.createdBy, input.role, input.maxUses ?? null, input.expiresAt ?? null],
      'service_unavailable',
    );
  }

  findInvite(code: string) {
    return this.db.one<{
      id: string;
      channel_id: string;
      code: string;
      role: 'admin' | 'moderator' | 'subscriber';
      max_uses: number | null;
      uses: number;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>('select * from channel_invites where code = $1', [code]);
  }

  async consumeInvite(inviteId: string): Promise<void> {
    await this.db.query('update channel_invites set uses = uses + 1 where id = $1', [inviteId]);
  }

  async listInvites(channelId: string) {
    return this.db.many(
      'select id, code, role, max_uses, uses, expires_at, revoked_at, created_at from channel_invites where channel_id = $1 and revoked_at is null order by created_at desc',
      [channelId],
    );
  }

  async revokeInvite(channelId: string, inviteId: string): Promise<void> {
    await this.db.query('update channel_invites set revoked_at = now() where id = $1 and channel_id = $2', [inviteId, channelId]);
  }

  /** Discovery list with subscription state for the viewer. */
  async discover(input: { viewerId: string; term: string | null; limit: number; onlySubscribed?: boolean }) {
    return this.db.many<ChannelRow & { is_subscribed: boolean; my_role: string | null }>(
      `select c.*,
              (m.user_id is not null) as is_subscribed,
              m.role as my_role
       from channels c
       left join channel_members m on m.channel_id = c.id and m.user_id = $1
       where c.deleted_at is null
         and (c.visibility = 'public' or m.user_id is not null)
         and ($2::text is null or c.name ilike '%' || $2 || '%' or c.slug ilike '%' || $2 || '%')
         and ($3::boolean is not true or m.user_id is not null)
       order by c.subscriber_count desc, c.created_at desc
       limit $4`,
      [input.viewerId, input.term, input.onlySubscribed ?? false, input.limit],
    );
  }

  async subscribedFor(viewerId: string) {
    return this.db.many<ChannelRow & { my_role: string; last_read_post_at: Date | null }>(
      `select c.*, m.role as my_role, m.last_read_post_at
       from channel_members m join channels c on c.id = m.channel_id
       where m.user_id = $1 and c.deleted_at is null
       order by c.subscriber_count desc`,
      [viewerId],
    );
  }

  async markRead(channelId: string, userId: string): Promise<void> {
    await this.db.query('update channel_members set last_read_post_at = now() where channel_id = $1 and user_id = $2', [channelId, userId]);
  }
}
