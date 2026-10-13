'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar, Button, Modal, Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';

/**
 * Social post model — mirrors the server DTO exactly (services/serializers.ts →
 * postToDto). The client never invents fields the API does not return.
 */

export interface PostAuthor {
  id: string;
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl: string | null;
  isVerified?: boolean;
  createdAt?: string;
}

export interface PostMedia {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export interface Post {
  id: string;
  author: PostAuthor;
  body: string | null;
  visibility: 'public' | 'followers' | 'private';
  media: PostMedia[];
  hashtags: string[];
  mentionUsernames: string[];
  replyToId: string | null;
  repostOfId: string | null;
  quoteOfId: string | null;
  repostOf: { id: string; body: string | null; createdAt: string | null; author: { username: string; displayName: string; avatarUrl: string | null } } | null;
  counts: { likes: number; comments: number; reposts: number };
  viewer: { liked: boolean; reposted: boolean; following: boolean; isMine: boolean };
  editedAt: string | null;
  createdAt: string;
}

/** Composer shared by the timeline and the channel pages. */
export function PostComposer({
  onCreated,
  channelId,
  placeholder,
}: {
  onCreated: (post: Post) => void;
  channelId?: string;
  placeholder?: string;
}) {
  const { viewer } = useSession();
  const tr = useT();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Post['visibility']>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [media, setMedia] = useState<PostMedia[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const limit = 5000;

  async function upload(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 4)) {
      const form = new FormData();
      form.append('file', file);
      try {
        const result = await api.upload<{ attachment: PostMedia }>('/api/files', form);
        setMedia((current) => [...current, result.attachment]);
      } catch {
        setError('تعذّر رفع الملف (النوع أو الحجم غير مسموح).');
      }
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() && media.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { body: body.trim(), attachmentIds: media.map((item) => item.id) };
      const result = channelId
        ? await api.post<{ post: Post }>(`/api/channels/${channelId}/posts`, payload)
        : await api.post<{ post: Post }>('/api/posts', { ...payload, visibility });
      onCreated(result.post);
      setBody('');
      setMedia([]);
      setOpen(false);
    } catch {
      setError('تعذّر النشر. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card flex items-center gap-3 p-3">
        <Avatar name={viewer?.displayName ?? ''} src={viewer?.avatarUrl} size={38} />
        <button className="input muted flex-1 text-start" onClick={() => setOpen(true)} type="button">
          {placeholder ?? tr('whatIsHappening')}
        </button>
        <Button onClick={() => setOpen(true)}>{tr('post')}</Button>
      </div>

      <Modal open={open} title={tr('post')} onClose={() => setOpen(false)}>
        <form onSubmit={submit} className="space-y-3">
          <textarea
            className="input min-h-32 resize-y"
            value={body}
            maxLength={limit}
            autoFocus
            onChange={(event) => setBody(event.target.value)}
            placeholder={tr('whatIsHappening')}
            aria-label={tr('whatIsHappening')}
          />
          <div className="muted flex items-center justify-between text-xs">
            <span>
              {body.length}/{limit}
            </span>
            {!channelId && (
              <label className="flex items-center gap-2">
                من يرى المنشور؟
                <select
                  className="input w-auto px-2 py-1 text-xs"
                  value={visibility}
                  onChange={(event) => setVisibility(event.target.value as Post['visibility'])}
                >
                  <option value="public">عام</option>
                  <option value="followers">المتابعون</option>
                  <option value="private">أنا فقط</option>
                </select>
              </label>
            )}
          </div>

          {media.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {media.map((item) => (
                <span key={item.id} className="pill">
                  {item.fileName}
                  <button type="button" onClick={() => setMedia((current) => current.filter((entry) => entry.id !== item.id))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {error && (
            <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between">
            <div>
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept="image/*,video/*,application/pdf,.txt,.zip"
                onChange={(event) => void upload(event.target.files)}
              />
              <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}>
                📎 {tr('uploadFile')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {busy && <Spinner size={14} />}
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {tr('cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={!body.trim() && media.length === 0}>
                {tr('post')}
              </Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}
