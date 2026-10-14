'use client';

import { useEffect, useState } from 'react';
import { useMediaUrl } from '@/lib/media';
import { openAsBlob, type EncryptedFileDescriptor } from '@/lib/e2ee/content';
import { useT } from '@/lib/i18n';

/**
 * Media elements that can actually load private files.
 *
 * Every attachment in the product lives behind `GET /api/files/:id`, which requires
 * authorisation. These wrappers append the short-lived media token (see lib/media.ts) so
 * images, video, audio and downloads work in the browser without weakening the API.
 */

export interface MediaItem {
  id: string;
  url: string;
  mimeType: string;
  fileName: string;
  sizeBytes?: number;
  width?: number | null;
  height?: number | null;
  /** True when the stored bytes are ciphertext (encrypted conversation). */
  isEncrypted?: boolean;
}

export function MediaThumb({ item, className = 'max-h-72 rounded-xl object-cover', maxHeight }: { item: MediaItem; className?: string; maxHeight?: number }) {
  const url = useMediaUrl(item.url);
  if (!url) return null;
  if (item.mimeType.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={item.fileName}
        className={className}
        style={maxHeight ? { maxHeight } : undefined}
        loading="lazy"
        width={item.width ?? undefined}
        height={item.height ?? undefined}
      />
    );
  }
  if (item.mimeType.startsWith('video/')) {
    return <video src={url} controls className={className} style={maxHeight ? { maxHeight } : undefined} preload="metadata" />;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="pill">
      📎 {item.fileName}
    </a>
  );
}

/** A single attachment inside a message: images/video inline, everything else as a hand-off. */
export function AttachmentView({ attachment }: { attachment: MediaItem }) {
  // Encrypted attachments must go through EncryptedAttachmentView: they have no readable name or
  // type until the message is decrypted, so rendering this path for them would show a lie.
  if (attachment.isEncrypted) return null;
  const url = useMediaUrl(attachment.url);
  if (!url) return null;

  if (attachment.mimeType.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={attachment.fileName}
        className="max-h-72 w-auto rounded-xl"
        loading="lazy"
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
      />
    );
  }
  if (attachment.mimeType.startsWith('video/')) {
    return <video src={url} controls className="max-h-72 rounded-xl" preload="metadata" />;
  }
  if (attachment.mimeType.startsWith('audio/')) {
    return <audio src={url} controls className="w-64" preload="metadata" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-xl border p-2 text-sm underline"
      style={{ borderColor: 'currentColor' }}
    >
      📎 {attachment.fileName}
      {typeof attachment.sizeBytes === 'number' && (
        <span className="opacity-70">({Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB)</span>
      )}
    </a>
  );
}


/**
 * One attachment inside an encrypted conversation.
 *
 * The server holds ciphertext and a neutral placeholder name, so nothing here can be rendered before
 * the message itself is decrypted: the real name, type and key all arrive *with the text*. That is
 * why this component takes the descriptor from the decrypted payload rather than from the row — if
 * the descriptor is missing (this device could not read the message), the honest thing to show is a
 * locked placeholder, not a broken image.
 *
 * Decryption happens in the browser and the result lives in an object URL that is revoked when the
 * component goes away: an opened file is never re-uploaded, never cached by the service worker, and
 * never given a token that outlives the view.
 */
export function EncryptedAttachmentView({
  attachment,
  descriptor,
}: {
  attachment: MediaItem;
  descriptor?: EncryptedFileDescriptor | null;
}) {
  const tr = useT();
  const url = useMediaUrl(attachment.url);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    // A new descriptor (another message, another file) invalidates the previously opened bytes.
    setObjectUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setError(null);
  }, [descriptor?.id, descriptor?.key]);

  useEffect(() => () => {
    setObjectUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  async function open() {
    if (!url || !descriptor) return;
    setOpening(true);
    setError(null);
    try {
      const blob = await openAsBlob(url, descriptor);
      setObjectUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
    } catch (cause) {
      console.warn('encrypted attachment failed to open', attachment.id, cause);
      setError(tr('attachmentOpenFailed'));
    } finally {
      setOpening(false);
    }
  }

  if (!descriptor) {
    return (
      <span className="flex items-center gap-2 rounded-xl border p-2 text-xs opacity-80" style={{ borderColor: 'currentColor' }}>
        <span aria-hidden>🔒</span>
        {tr('attachmentLocked')}
      </span>
    );
  }

  const name = descriptor.name || attachment.fileName;
  const sizeKb = Math.max(1, Math.round(descriptor.size / 1024));

  if (objectUrl && descriptor.type.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={objectUrl} alt={name} className="max-h-72 w-auto rounded-xl" />
    );
  }
  if (objectUrl && descriptor.type.startsWith('video/')) {
    return <video src={objectUrl} controls className="max-h-72 rounded-xl" preload="metadata" />;
  }
  if (objectUrl && descriptor.type.startsWith('audio/')) {
    return <audio src={objectUrl} controls className="w-64" preload="metadata" />;
  }
  if (objectUrl) {
    return (
      <a
        href={objectUrl}
        download={name}
        className="flex items-center gap-2 rounded-xl border p-2 text-sm underline"
        style={{ borderColor: 'currentColor' }}
      >
        🔓 {name} <span className="opacity-70">({sizeKb} KB)</span>
      </a>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <button type="button" className="pill flex items-center gap-2" onClick={open} disabled={opening || !url}>
        <span aria-hidden>🔒</span>
        {opening ? tr('decrypting') : `${tr('openEncryptedAttachment')} · ${name}`}
        <span className="opacity-70">({sizeKb} KB)</span>
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: 'var(--danger, #b91c1c)' }}>
          {error}
        </span>
      )}
    </span>
  );
}

/** Grid used by posts and channel posts. */
export function MediaGrid({ items, maxHeight = 288 }: { items: MediaItem[]; maxHeight?: number }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <MediaThumb key={item.id} item={item} maxHeight={maxHeight} />
      ))}
    </div>
  );
}
