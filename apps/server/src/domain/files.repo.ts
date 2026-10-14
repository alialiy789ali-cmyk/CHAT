import type { Db } from '../db/pool.js';
import type { AttachmentRow } from './messages.repo.js';

/** Attachment metadata (the bytes live in the storage driver, keyed by SHA-256). */

export interface AttachmentWithContext extends AttachmentRow {
  message_conversation_id: string | null;
  post_author_id: string | null;
  channel_id: string | null;
}

const ATTACHMENT_COLUMNS = `
  a.id, a.uploader_id, a.message_id, a.post_id, a.channel_post_id, a.storage_key, a.file_name,
  a.mime_type, a.size_bytes, a.sha256, a.width, a.height, a.duration_ms, a.scan_status,
  a.is_encrypted, a.created_at, a.deleted_at
`;

export class FilesRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    uploaderId: string;
    storageKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    scanStatus?: 'pending' | 'clean' | 'skipped';
    isEncrypted?: boolean;
  }): Promise<AttachmentRow> {
    return this.db.oneOrFail<AttachmentRow>(
      `insert into attachments (uploader_id, storage_key, file_name, mime_type, size_bytes, sha256, width, height, duration_ms, scan_status, is_encrypted)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning *`,
      [
        input.uploaderId,
        input.storageKey,
        input.fileName,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        input.scanStatus ?? 'pending',
        input.isEncrypted ?? false,
      ],
      'storage_error',
    );
  }

  findById(id: string): Promise<AttachmentRow | null> {
    return this.db.one<AttachmentRow>(`select ${ATTACHMENT_COLUMNS} from attachments a where a.id = $1 and a.deleted_at is null`, [id]);
  }

  listForMessage(messageId: string): Promise<AttachmentRow[]> {
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a where a.message_id = $1 and a.deleted_at is null order by a.created_at`,
      [messageId],
    );
  }

  listForMessages(messageIds: string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a where a.message_id = any($1::uuid[]) and a.deleted_at is null order by a.created_at`,
      [messageIds],
    );
  }

  listForPost(postId: string): Promise<AttachmentRow[]> {
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a where a.post_id = $1 and a.deleted_at is null order by a.created_at`,
      [postId],
    );
  }

  listForPosts(postIds: string[]): Promise<AttachmentRow[]> {
    if (postIds.length === 0) return Promise.resolve([]);
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a where a.post_id = any($1::uuid[]) and a.deleted_at is null order by a.created_at`,
      [postIds],
    );
  }

  listForChannelPost(channelPostId: string): Promise<AttachmentRow[]> {
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a where a.channel_post_id = $1 and a.deleted_at is null order by a.created_at`,
      [channelPostId],
    );
  }

  /**
   * Access check for downloading: allowed when the viewer uploaded it, is a member of
   * the conversation it was posted in, or the post is public.
   */
  async canAccess(attachmentId: string, viewerId: string): Promise<boolean> {
    const row = await this.db.one<{ allowed: boolean; uploader_id: string; storage_key: string; file_name: string; mime_type: string; size_bytes: string }>(
      `select
         (a.uploader_id = $2
          or exists (select 1 from conversation_members cm where cm.conversation_id = m.conversation_id and cm.user_id = $2 and cm.left_at is null)
          or exists (select 1 from posts p where p.id = a.post_id and p.deleted_at is null and p.visibility = 'public')
          or exists (select 1 from channel_members chm where chm.channel_id = cp.channel_id and chm.user_id = $2)
          or exists (select 1 from channels c2 join channel_posts cp2 on cp2.channel_id = c2.id where cp2.id = a.channel_post_id and c2.visibility = 'public')
         ) as allowed,
         a.uploader_id, a.storage_key, a.file_name, a.mime_type, a.size_bytes
       from attachments a
       left join messages m on m.id = a.message_id
       left join channel_posts cp on cp.id = a.channel_post_id
       where a.id = $1 and a.deleted_at is null`,
      [attachmentId, viewerId],
    );
    return Boolean(row?.allowed);
  }

  /**
   * Deduplication lookup.
   *
   * `is_encrypted` is part of the match: the same bytes cannot legitimately be both a readable file
   * and ciphertext, so a row found under the other mode is a different thing and must not be reused
   * (its stored name, type and scan status answer a different question).
   */
  findBySha(sha256: string, uploaderId: string, isEncrypted = false): Promise<AttachmentRow | null> {
    return this.db.one<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a
        where a.sha256 = $1 and a.uploader_id = $2 and a.is_encrypted = $3 and a.deleted_at is null limit 1`,
      [sha256, uploaderId, isEncrypted],
    );
  }

  /** Attachments owned by `uploaderId` with the given ids (used to validate a send). */
  async listOwnedByIds(ids: string[], uploaderId: string): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    return this.db.many<AttachmentRow>(
      `select ${ATTACHMENT_COLUMNS} from attachments a
        where a.uploader_id = $1 and a.deleted_at is null and a.id = any($2::uuid[])`,
      [uploaderId, ids],
    );
  }

  async totalBytesForUser(userId: string): Promise<number> {
    const row = await this.db.one<{ total: string }>(
      'select coalesce(sum(size_bytes), 0)::text as total from attachments where uploader_id = $1 and deleted_at is null',
      [userId],
    );
    return Number(row?.total ?? 0);
  }

  /** Removes attachments that were never attached to anything (orphaned uploads). */
  async pruneOrphans(olderThanMinutes = 60): Promise<number> {
    const res = await this.db.query(
      `delete from attachments
       where message_id is null and post_id is null and channel_post_id is null
         and created_at < now() - ($1 || ' minutes')::interval`,
      [String(olderThanMinutes)],
    );
    return res.rowCount ?? 0;
  }
}
