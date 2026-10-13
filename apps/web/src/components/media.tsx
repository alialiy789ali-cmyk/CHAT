'use client';

import { useMediaUrl } from '@/lib/media';

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
