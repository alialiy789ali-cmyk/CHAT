import type { Db } from '../db/pool.js';
import { decodeCursor, encodeCursor } from '../lib/crypto.js';
import type { MemberRole } from '@sovereign/shared/types';

/**
 * Conversations, membership and the queries that power the chat list.
 * The direct-message `direct_key` is a deterministic hash of both user ids so a
 * pair can never end up with two parallel threads.
 */

export interface ConversationRow {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
  description: string | null;
  avatar_url: string | null;
  visibility: 'private' | 'public';
  owner_id: string | null;
  direct_key: string | null;
  is_encrypted: boolean;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ConversationSummaryRow extends ConversationRow {
  member_count: string;
  my_role: MemberRole | null;
  last_read_message_id: string | null;
  unread_count: string;
  last_message_id: string | null;
  last_message_body: string | null;
  last_message_type: string | null;
  last_message_at_effective: Date | null;
  last_message_sender_id: string | null;
}

export const directKeyFor = (a: string, b: string): string => [a, b].sort().join(':');

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    type: 'direct' | 'group' | 'channel';
    title?: string | null;
    description?: string | null;
    visibility?: 'private' | 'public';
    ownerId: string;
    directKey?: string | null;
  }): Promise<ConversationRow> {
    return this.db.oneOrFail<ConversationRow>(
      `insert into conversations (type, title, description, visibility, owner_id, direct_key)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        input.type,
        input.title ?? null,
        input.description ?? null,
        input.visibility ?? 'private',
        input.ownerId,
        input.directKey ?? null,
      ],
      'service_unavailable',
    );
  }

  findById(id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>('select * from conversations where id = $1 and deleted_at is null', [id]);
  }

  findDirectByKey(key: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      'select * from conversations where direct_key = $1 and deleted_at is null',
      [key],
    );
  }

  /** Creates a direct conversation atomically; safe under concurrent requests. */
  async ensureDirect(input: { userA: string; userB: string }): Promise<{ conversation: ConversationRow; created: boolean }> {
    const key = directKeyFor(input.userA, input.userB);
    const existing = await this.findDirectByKey(key);
    if (existing) return { conversation: existing, created: false };
    const created = await this.db
      .oneOrFail<ConversationRow>(
        `insert into conversations (type, direct_key, owner_id, visibility)
         values ('direct', $1, $2, 'private')
         on conflict (direct_key) do update set direct_key = excluded.direct_key
         returning *`,
        [key, input.userA],
        'service_unavailable',
      );
    const wasCreated = created.created_at.getTime() > Date.now() - 5000;
    return { conversation: created, created: wasCreated };
  }

  async addMember(input: {
    conversationId: string;
    userId: string;
    role?: MemberRole;
    addedBy?: string | null;
  }): Promise<void> {
    await this.db.query(
      `insert into conversation_members (conversation_id, user_id, role)
       values ($1, $2, $3)
       on conflict (conversation_id, user_id) do update set left_at = null, role = conversation_members.role`,
      [input.conversationId, input.userId, input.role ?? 'member'],
    );
  }

  async addMembers(conversationId: string, userIds: string[], role: MemberRole = 'member'): Promise<void> {
    if (userIds.length === 0) return;
    await this.db.query(
      `insert into conversation_members (conversation_id, user_id, role)
       select $1, unnest($2::uuid[]), $3
       on conflict (conversation_id, user_id) do update set left_at = null`,
      [conversationId, userIds, role],
    );
  }

  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.db.query(
      'update conversation_members set left_at = now() where conversation_id = $1 and user_id = $2',
      [conversationId, userId],
    );
  }

  async setMemberRole(conversationId: string, userId: string, role: MemberRole): Promise<void> {
    await this.db.query(
      'update conversation_members set role = $3 where conversation_id = $1 and user_id = $2 and left_at is null',
      [conversationId, userId, role],
    );
  }

  async member(conversationId: string, userId: string) {
    return this.db.one<{ role: MemberRole; last_read_message_id: string | null; left_at: Date | null }>(
      'select role, last_read_message_id, left_at from conversation_members where conversation_id = $1 and user_id = $2',
      [conversationId, userId],
    );
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ exists: boolean }>(
      `select exists(select 1 from conversation_members where conversation_id = $1 and user_id = $2 and left_at is null) as exists`,
      [conversationId, userId],
    );
    return Boolean(row?.exists);
  }

  /** Active members with their role, used for E2EE readiness and fan-out decisions. */
  async members(conversationId: string): Promise<Array<{ user_id: string; role: MemberRole }>> {
    return this.db.many<{ user_id: string; role: MemberRole }>(
      'select user_id, role from conversation_members where conversation_id = $1 and left_at is null',
      [conversationId],
    );
  }

  /** Flips the E2EE flag. Ciphertext envelopes are rejected while it is false (see messaging service). */
  async setEncrypted(conversationId: string, encrypted: boolean): Promise<void> {
    await this.db.query('update conversations set is_encrypted = $2 where id = $1', [conversationId, encrypted]);
  }

  async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      'select user_id from conversation_members where conversation_id = $1 and left_at is null',
      [conversationId],
    );
    return rows.map((r) => r.user_id);
  }

  async membersWithRoles(conversationId: string) {
    return this.db.many<{
      user_id: string;
      role: MemberRole;
      joined_at: Date;
      username: string;
      display_name: string;
      avatar_url: string | null;
      last_seen_at: Date | null;
    }>(
      `select m.user_id, m.role, m.joined_at, u.username, u.display_name, u.avatar_url, u.last_seen_at
       from conversation_members m join users u on u.id = m.user_id
       where m.conversation_id = $1 and m.left_at is null
       order by case m.role when 'owner' then 0 when 'admin' then 1 when 'moderator' then 2 else 3 end, u.username`,
      [conversationId],
    );
  }

  async update(
    id: string,
    patch: { title?: string; description?: string | null; avatarUrl?: string | null; visibility?: 'private' | 'public' },
  ): Promise<ConversationRow> {
    return this.db.oneOrFail<ConversationRow>(
      `update conversations set
         title = coalesce($2, title),
         description = coalesce($3, description),
         avatar_url = coalesce($4, avatar_url),
         visibility = coalesce($5, visibility)
       where id = $1 and deleted_at is null returning *`,
      [id, patch.title ?? null, patch.description === undefined ? null : patch.description, patch.avatarUrl === undefined ? null : patch.avatarUrl, patch.visibility ?? null],
      'conversation_not_found',
    );
  }

  async softDelete(id: string): Promise<void> {
    await this.db.query('update conversations set deleted_at = now() where id = $1', [id]);
  }

  /**
   * Chat list for a user: one row per conversation with the latest message and an
   * unread counter that ignores the user's own messages.
   */
  async listForUser(userId: string, limit: number, cursor?: string): Promise<{ items: ConversationSummaryRow[]; nextCursor: string | null }> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = await this.db.many<ConversationSummaryRow>(
      `with mine as (
         select c.*, m.role as my_role, m.last_read_message_id
         from conversation_members m
         join conversations c on c.id = m.conversation_id
         where m.user_id = $1 and m.left_at is null and c.deleted_at is null
       ),
       last_msg as (
         select distinct on (conversation_id) conversation_id, id, body, type, created_at, sender_id, deleted_at
         from messages
         order by conversation_id, created_at desc, id desc
       )
       select mine.*,
         (select count(*)::text from conversation_members cm where cm.conversation_id = mine.id and cm.left_at is null) as member_count,
         coalesce(lm.created_at, mine.created_at) as last_message_at_effective,
         lm.id as last_message_id,
         case when lm.deleted_at is not null then null else lm.body end as last_message_body,
         lm.type as last_message_type,
         lm.sender_id as last_message_sender_id,
         (select count(*)::text from messages m2
            where m2.conversation_id = mine.id
              and m2.deleted_at is null
              and m2.sender_id is distinct from $1
              and (mine.last_read_message_id is null
                   or (m2.created_at, m2.id) > (select m3.created_at, m3.id from messages m3 where m3.id = mine.last_read_message_id))
         ) as unread_count
       from mine
       left join last_msg lm on lm.conversation_id = mine.id
       where ($2::timestamptz is null or coalesce(lm.created_at, mine.created_at) < $2::timestamptz)
       order by coalesce(lm.created_at, mine.created_at) desc
       limit $3`,
      [userId, decoded?.c ?? null, limit],
    );
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last
        ? encodeCursor({ c: (last.last_message_at_effective ?? last.created_at).toISOString(), i: last.id })
        : null;
    return { items: rows, nextCursor };
  }

  /** Public groups/channels that a user can discover and join. */
  async discover(type: 'group' | 'channel', term: string | null, limit: number) {
    return this.db.many<ConversationRow & { member_count: string }>(
      `select c.*, (select count(*)::text from conversation_members m where m.conversation_id = c.id and m.left_at is null) as member_count
       from conversations c
       where c.type = $1 and c.visibility = 'public' and c.deleted_at is null
         and ($2::text is null or c.title ilike '%' || $2 || '%')
       order by c.last_message_at desc nulls last, c.created_at desc
       limit $3`,
      [type, term, limit],
    );
  }
}
