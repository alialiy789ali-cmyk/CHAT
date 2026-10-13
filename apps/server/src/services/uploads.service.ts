import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError, assert } from '../lib/errors.js';
import { contentKey } from '../lib/storage.js';
import { extensionOf as ext, safeFileName } from '../lib/crypto.js';
import type { AppDeps, RequestContext } from './context.js';
import { attachmentToDto } from './serializers.js';

/**
 * File uploads.
 *
 * Controls applied here (defence in depth for requirement 6):
 *  - strict MIME allow-list and per-user/global size limits,
 *  - the client-provided filename is sanitised; the storage key is derived from the
 *    content hash, never from user input (path traversal is impossible),
 *  - downloads always go through an authorisation check, never a public bucket URL,
 *  - uploads are attributed to the uploader and reusable only by them until attached,
 *  - images/videos are marked `pending` scan status so an external scanner can hook in.
 */

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/opus',
]);
const DOC_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export class UploadsService {
  constructor(private readonly deps: AppDeps) {}

  isAllowed(mimeType: string): boolean {
    return (
      IMAGE_TYPES.has(mimeType) ||
      VIDEO_TYPES.has(mimeType) ||
      AUDIO_TYPES.has(mimeType) ||
      DOC_TYPES.has(mimeType)
    );
  }

  classify(mimeType: string, durationMs?: number | null): 'image' | 'video' | 'audio' | 'voice' | 'file' {
    if (IMAGE_TYPES.has(mimeType)) return 'image';
    if (VIDEO_TYPES.has(mimeType)) return 'video';
    if (AUDIO_TYPES.has(mimeType)) return durationMs !== undefined && durationMs !== null && durationMs > 0 ? 'voice' : 'audio';
    return 'file';
  }

  async upload(
    userId: string,
    input: { fileName: string; mimeType: string; data: Readable | Buffer; sizeBytes?: number; durationMs?: number | null },
    ctx: RequestContext,
  ) {
    const cfg = this.deps.cfg;
    assert(this.isAllowed(input.mimeType), 'unsupported_media_type', `mime_type_not_allowed:${input.mimeType}`);

    const data = Buffer.isBuffer(input.data) ? input.data : await streamToBuffer(input.data, cfg.UPLOAD_MAX_BYTES);
    assert(data.byteLength <= cfg.UPLOAD_MAX_BYTES, 'payload_too_large', 'file_exceeds_limit');
    assert(data.byteLength > 0, 'validation_error', 'empty_file');

    const fileName = safeFileName(input.fileName);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = contentKey(sha256, ext(fileName) || mimeExtension(input.mimeType));

    // Deduplicate: the same bytes uploaded by the same user reuse the metadata row.
    const existing = await this.deps.repos.files.findBySha(sha256, userId);
    if (existing) return attachmentToDto(existing);

    const stored = await this.deps.storage.put(key, data, input.mimeType);
    assert(stored.sha256 === sha256, 'storage_error', 'checksum_mismatch');

    const row = await this.deps.repos.files.create({
      uploaderId: userId,
      storageKey: stored.key,
      fileName,
      mimeType: input.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256,
      durationMs: input.durationMs ?? null,
      scanStatus: 'pending',
    });

    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'file.uploaded',
      targetType: 'attachment',
      targetId: row.id,
      metadata: { mimeType: input.mimeType, sizeBytes: stored.sizeBytes },
    });

    this.deps.logger.info(
      { userId, attachmentId: row.id, mimeType: input.mimeType, sizeBytes: stored.sizeBytes },
      'file uploaded',
    );
    return attachmentToDto(row);
  }

  /** Streams a file after an authorisation check. */
  async download(attachmentId: string, userId: string) {
    const allowed = await this.deps.repos.files.canAccess(attachmentId, userId);
    if (!allowed) {
      // Same error for "missing" and "forbidden" so ids cannot be probed.
      throw new AppError('not_found', 'file_not_found');
    }
    const row = await this.deps.repos.files.findById(attachmentId);
    if (!row) throw new AppError('not_found', 'file_not_found');
    const stream = await this.deps.storage.getStream(row.storage_key);
    return {
      stream,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
    };
  }

  /** Removes an upload that has not been attached to a message/post yet. */
  async deleteUpload(attachmentId: string, userId: string): Promise<void> {
    const row = await this.deps.repos.files.findById(attachmentId);
    if (!row) throw new AppError('not_found', 'file_not_found');
    if (row.uploader_id !== userId) throw new AppError('forbidden');
    if (row.message_id || row.post_id || row.channel_post_id) {
      throw new AppError('conflict', 'attached_files_cannot_be_deleted_directly');
    }
    await this.deps.db.query('update attachments set deleted_at = now() where id = $1', [attachmentId]);
    await this.deps.storage.delete(row.storage_key).catch(() => {});
  }

  /**
   * Sets the profile avatar. The image is stored like any other upload and the
   * public URL points at the authenticated file endpoint (no public bucket).
   */
  async setAvatar(userId: string, input: { fileName: string; mimeType: string; data: Buffer }, ctx: RequestContext) {
    assert(IMAGE_TYPES.has(input.mimeType), 'unsupported_media_type', 'avatar_must_be_image');
    assert(input.data.byteLength <= 5 * 1024 * 1024, 'payload_too_large', 'avatar_too_large');
    const attachment = await this.upload(userId, input, ctx);
    await this.deps.repos.users.updateProfile(userId, { avatarUrl: attachment.url });
    return { avatarUrl: attachment.url };
  }

  async usage(userId: string) {
    const bytes = await this.deps.repos.files.totalBytesForUser(userId);
    return { bytes, limit: 1024 * 1024 * 1024 };
  }

  storageDescription(): string {
    return this.deps.storage.describe();
  }
}

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.byteLength;
    if (total > maxBytes) throw new AppError('payload_too_large', 'file_exceeds_limit');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function mimeExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/webm': '.weba', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/opus': '.opus',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json',
    'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
  };
  return map[mimeType] ?? '';
}

export const ALLOWED_MIME_TYPES = {
  image: [...IMAGE_TYPES],
  video: [...VIDEO_TYPES],
  audio: [...AUDIO_TYPES],
  document: [...DOC_TYPES],
};
