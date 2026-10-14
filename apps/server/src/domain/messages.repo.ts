import type { Db } from '../db/pool.js';
import { decodeCursor, encodeCursor } from '../lib/crypto.js';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  client_message_id: string | null;
  type: 'text' | 'image' | 'video' | 'audio' | 'voice' | 'file' | 'system';
  body: string | null;
  reply_to_id: string | null;
  forwarded_from_id: string | null;
  mentions: string[];
  metadata: Record<string, unknown>;
  ciphertext: string | null;
  encryption_scheme: 'none' | 'libsignal-v1' | 'olm-v1';
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface MessageWithContextRow extends MessageRow {
  sender_username: string | null;
  sender_display_name: string | null;
  sender_avatar_url: string | null;
  reply_body: string | null;
  reply_type: string | null;
  reply_sender_username: string | null;
}

export interface AttachmentRow {
  id: string;
  uploader_id: string;
  message_id: string | null;
  post_id: string | null;
  channel_post_id: string | null;
  storage_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  scan_status: 'pending' | 'clean' | 'infected' | 'skipped';
  created_at: Date;
  deleted_at: Date | null;
}

export class MessagesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert a message. `on conflict` makes the send idempotent for retries with the
   * same clientMessageId, which is what protects mobile clients on flaky networks.
   */
  async insert(input: {
    conversationId: string;
    senderId: string;
    clientMessageId: string | null;
    type: MessageRow['type'];
    body: string | null;
    replyToId?: string | null;
    forwardedFromId?: string | null;
    mentions?: string[];
    metadata?: Record<string, unknown>;
    ciphertext?: string | null;
    encryptionScheme?: 'none' | 'libsignal-v1' | 'olm-v1';
  }): Promise<{ message: MessageRow; duplicated: boolean }> {
    const inserted = await this.db.one<MessageRow>(
      `insert into messages (conversation_id, sender_id, client_message_id, type, body, reply_to_id, forwarded_from_id, mentions, metadata, ciphertext, encryption_scheme)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (conversation_id, sender_id, client_message_id) where client_message_id is not null
       do nothing
       returning *`,
      [
        input.conversationId,
        input.senderId,
        input.clientMessageId,
        input.type,
        input.body,
        input.replyToId ?? null,
        input.forwardedFromId ?? null,
        input.mentions ?? [],
        JSON.stringify(input.metadata ?? {}),
        input.ciphertext ?? null,
        input.encryptionScheme ?? 'none',
      ],
    );

    if (inserted) return { message: inserted, duplicated: false };

    // Conflict: return the row that already exists so the client can reconcile.
    const existing = await this.db.oneOrFail<MessageRow>(
      `select * from messages where conversation_id = $1 and sender_id = $2 and client_message_id = $3`,
      [input.conversationId, input.senderId, input.clientMessageId],
      'message_not_found',
    );
    return { message: existing, duplicated: true };
  }

  attachMessageToAttachments(messageId: string, attachmentIds: string[], uploaderId: string): Promise<number> {
    if (attachmentIds.length === 0) return Promise.resolve(0);
    return this.db
      .query(
        `update attachments set message_id = $1
         where id = any($2::uuid[]) and uploader_id = $3 and message_id is null and deleted_at is null`,
        [messageId, attachmentIds, uploaderId],
      )
      .then((res) => res.rowCount ?? 0);
  }

  /**
   * Stores one ciphertext per recipient device. Replacing on conflict keeps a retried send
   * idempotent (same client message id → same envelope set).
   */
  async insertEnvelopes(
    messageId: string,
    envelopes: Array<{ deviceId: string; scheme: 'libsignal-v1' | 'olm-v1'; ciphertext: string }>,
  ): Promise<void> {
    for (const envelope of envelopes) {
      await this.db.query(
        `insert into message_envelopes (message_id, device_id, scheme, ciphertext)
         values ($1, $2, $3, $4)
         on conflict (message_id, device_id) do update set ciphertext = excluded.ciphertext, scheme = excluded.scheme`,
        [messageId, envelope.deviceId, envelope.scheme, envelope.ciphertext],
      );
    }
  }

  /**
   * Envelopes addressed to *one* device. A client never receives ciphertext for other
   * devices — it could not decrypt it, and there is no reason to hand it over.
   */
  envelopesForDevice(messageIds: string[], deviceId: string) {
    if (messageIds.length === 0) return Promise.resolve([] as Array<{ message_id: string; scheme: string; ciphertext: string }>);
    return this.db.many<{ message_id: string; scheme: string; ciphertext: string }>(
      `select message_id, scheme, ciphertext from message_envelopes
       where device_id = $1 and message_id = any($2::uuid[])`,
      [deviceId, messageIds],
    );
  }

  /** Devices that already have an envelope for a message (used to detect delivery gaps). */
  envelopeDeviceIds(messageId: string) {
    return this.db.many<{ device_id: string }>('select device_id from message_envelopes where message_id = $1', [messageId]);
  }

  findById(id: string): Promise<MessageWithContextRow | null> {
    return this.db.one<MessageWithContextRow>(
      `${MESSAGE_SELECT} where m.id = $1`,
      [id],
    );
  }

  findByClientId(conversationId: string, senderId: string, clientMessageId: string): Promise<MessageRow | null> {
    return this.db.one<MessageRow>(
      'select * from messages where conversation_id = $1 and sender_id = $2 and client_message_id = $3',
      [conversationId, senderId, clientMessageId],
    );
  }

  /** Paginated history, newest first, stable ordering by (created_at, id). */
  async list(input: {
    conversationId: string;
    limit: number;
    cursor?: string | null;
    before?: string | null;
    after?: string | null;
    search?: string | null;
  }): Promise<{ items: MessageWithContextRow[]; nextCursor: string | null; hasMore: boolean }> {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db.many<MessageWithContextRow>(
      `${MESSAGE_SELECT}
       where m.conversation_id = $1
         and ($2::timestamptz is null or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
         and ($4::text is null or m.body ilike '%' || $4 || '%')
       order by m.created_at desc, m.id desc
       limit $5`,
      [input.conversationId, decoded?.c ?? null, decoded?.i ?? null, input.search ?? null, input.limit],
    );
    const hasMore = rows.length === input.limit;
    const last = rows[rows.length - 1];
    return {
      items: rows,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ c: last.created_at.toISOString(), i: last.id }) : null,
    };
  }

  async updateBody(id: string, senderId: string, body: string): Promise<MessageWithContextRow | null> {
    const updated = await this.db.one<MessageRow>(
      `update messages set body = $3, edited_at = now()
       where id = $1 and sender_id = $2 and deleted_at is null
       returning *`,
      [id, senderId, body],
    );
    if (!updated) return null;
    return this.findById(id);
  }

  async softDelete(id: string, actorId: string | null): Promise<MessageWithContextRow | null> {
    // Authors may delete their own messages; the server checks the privileged path
    // separately (moderators/admins) before calling this with actorId = null.
    const updated = await this.db.one<MessageRow>(
      `update messages set deleted_at = now(), body = null, ciphertext = null
       where id = $1 and ($2::uuid is null or sender_id = $2) and deleted_at is null
       returning *`,
      [id, actorId],
    );
    if (!updated) return null;
    await this.db.query('update attachments set deleted_at = now() where message_id = $1', [id]);
    return this.findById(id);
  }

  async recipientsForDelivery(conversationId: string, excludeUserId: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      'select user_id from conversation_members where conversation_id = $1 and left_at is null and user_id <> $2',
      [conversationId, excludeUserId],
    );
    return rows.map((r) => r.user_id);
  }

  /** Bulk receipt write; returns only the newly transitioned receipts for fan-out. */
  async recordReceipts(messageIds: string[], userId: string, state: 'delivered' | 'read'): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db.many<{ message_id: string }>(
      `insert into message_receipts (message_id, user_id, state)
       select unnest($1::uuid[]), $2, $3
       on conflict (message_id, user_id) do update
         set state = case when message_receipts.state = 'read' then 'read' else excluded.state end,
             at = now()
       where message_receipts.state is distinct from 'read'
       returning message_id`,
      [messageIds, userId, state],
    );
    return rows.map((r) => r.message_id);
  }

  /** Marks everything up to `messageId` as read for the given user. */
  async markReadUpTo(conversationId: string, userId: string, messageId: string): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `with target as (select created_at, id from messages where id = $3 and conversation_id = $1)
       select m.id from messages m, target t
       where m.conversation_id = $1
         and m.sender_id is distinct from $2
         and m.deleted_at is null
         and (m.created_at, m.id) <= (t.created_at, t.id)`,
      [conversationId, userId, messageId],
    );
    const ids = rows.map((r) => r.id);
    await this.db.query(
      `update conversation_members set last_read_message_id = $3, last_read_at = now()
       where conversation_id = $1 and user_id = $2`,
      [conversationId, userId, messageId],
    );
    await this.recordReceipts(ids, userId, 'read');
    return ids;
  }

  async receiptsFor(messageIds: string[]) {
    if (messageIds.length === 0) return [];
    return this.db.many<{ message_id: string; user_id: string; state: 'delivered' | 'read'; at: Date }>(
      'select message_id, user_id, state, at from message_receipts where message_id = any($1::uuid[])',
      [messageIds],
    );
  }

  async searchAcrossConversations(userId: string, term: string, limit: number) {
    return this.db.many<MessageWithContextRow & { conversation_title: string | null }>(
      `select m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar_url,
              null::text as reply_body, null::text as reply_type, null::text as reply_sender_username,
              c.title as conversation_title
       from messages m
       join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $1 and cm.left_at is null
       join conversations c on c.id = m.conversation_id
       left join users u on u.id = m.sender_id
       where m.deleted_at is null and m.body ilike '%' || $2 || '%'
       order by m.created_at desc limit $3`,
      [userId, term, limit],
    );
  }

  async countUnreadTotal(userId: string): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `select count(*)::text as count
       from messages m
       join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $1 and cm.left_at is null
       where m.deleted_at is null and m.sender_id is distinct from $1
         and (cm.last_read_message_id is null
              or (m.created_at, m.id) > (select created_at, id from messages where id = cm.last_read_message_id))`,
      [userId],
    );
    return Number(row?.count ?? 0);
  }
}

export const MESSAGE_SELECT = `
  select m.*,
         u.username as sender_username,
         u.display_name as sender_display_name,
         u.avatar_url as sender_avatar_url,
         r.body as reply_body,
         r.type as reply_type,
         ru.username as reply_sender_username
  from messages m
  left join users u on u.id = m.sender_id
  left join messages r on r.id = m.reply_to_id
  left join users ru on ru.id = r.sender_id
`;
