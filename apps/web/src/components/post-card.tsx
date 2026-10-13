'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Avatar, Badge, Button, formatTime } from '@/components/ui';
import { MediaGrid } from '@/components/media';
import { useT } from '@/lib/i18n';
import type { Post } from '@/components/post';

/**
 * Post card — shared by the timeline, profiles, search results and the single-post view.
 * Lives in components/ (not inside a page module) because Next.js route files may only
 * export the route symbols themselves.
 */

export function PostCard({
  post,
  viewerId,
  onChange,
  onRemoved,
}: {
  post: Post;
  viewerId: string;
  onChange: (post: Post) => void;
  onRemoved: (id: string) => void;
}) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Post[]>([]);
  const [commentText, setCommentText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function like() {
    setBusy(true);
    setError(null);
    try {
      if (post.viewer.liked) {
        await api.del(`/api/posts/${post.id}/like`);
        onChange({ ...post, viewer: { ...post.viewer, liked: false }, counts: { ...post.counts, likes: Math.max(0, post.counts.likes - 1) } });
      } else {
        await api.post(`/api/posts/${post.id}/like`);
        onChange({ ...post, viewer: { ...post.viewer, liked: true }, counts: { ...post.counts, likes: post.counts.likes + 1 } });
      }
    } catch {
      setError('تعذّر تنفيذ الإعجاب.');
    } finally {
      setBusy(false);
    }
  }

  async function repost() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ reposted: boolean }>(`/api/posts/${post.id}/repost`);
      onChange({
        ...post,
        viewer: { ...post.viewer, reposted: result.reposted },
        counts: { ...post.counts, reposts: post.counts.reposts + (result.reposted ? 1 : -1) },
      });
    } catch {
      setError('تعذّرت إعادة النشر.');
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    setBusy(true);
    setError(null);
    try {
      if (post.viewer.following) await api.del(`/api/users/${post.author.username}/follow`);
      else await api.post(`/api/users/${post.author.username}/follow`);
      onChange({ ...post, viewer: { ...post.viewer, following: !post.viewer.following } });
    } catch {
      setError('تعذّرت المتابعة.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleComments() {
    const next = !showComments;
    setShowComments(next);
    if (next && comments.length === 0) {
      const result = await api.get<{ items: Post[] }>(`/api/posts/${post.id}/comments?limit=50`);
      setComments(result.items);
    }
  }

  async function submitComment(event: React.FormEvent) {
    event.preventDefault();
    if (!commentText.trim()) return;
    const created = await api.post<{ post: Post }>(`/api/posts/${post.id}/comments`, { body: commentText.trim() });
    setComments((current) => [created.post, ...current]);
    setCommentText('');
    onChange({ ...post, counts: { ...post.counts, comments: post.counts.comments + 1 } });
  }

  async function report() {
    const reason = window.prompt('سبب الإبلاغ (spam, harassment, hate, violence, self_harm, sexual, misinformation, other)', 'spam');
    if (!reason) return;
    await api.post('/api/reports', { targetType: 'post', targetId: post.id, reason, details: null });
    window.alert('شكراً — تم إرسال البلاغ إلى فريق الإشراف.');
  }

  async function remove() {
    if (!window.confirm('حذف المنشور نهائياً؟')) return;
    await api.del(`/api/posts/${post.id}`);
    onRemoved(post.id);
  }

  const display = post.repostOf ?? post;

  return (
    <li className="card space-y-3 p-4">
      <div className="flex items-start gap-3">
        <Link href={`/app/profile/${post.author.username}`}>
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} size={42} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {post.repostOf && <span className="muted text-xs">🔁 أعاد النشر · </span>}
            <Link href={`/app/profile/${post.author.username}`} className="font-semibold hover:underline">
              {post.author.displayName}
            </Link>
            <span className="muted text-xs">@{post.author.username}</span>
            <span className="muted text-xs">· {formatTime(post.createdAt)}</span>
            {post.visibility !== 'public' && <Badge>{post.visibility === 'followers' ? 'متابعون' : 'خاص'}</Badge>}
          </div>

          {display.body && <p className="mt-1 whitespace-pre-wrap break-words">{linkify(display.body)}</p>}

          <MediaGrid items={post.media} />

          {post.quoteOfId && !post.repostOf && (
            <p className="muted mt-2 text-xs">منشور مقتبس · <Link className="underline" href={`/app/post/${post.quoteOfId}`}>{post.quoteOfId.slice(0, 8)}…</Link></p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1 text-xs">
            <button className="btn btn-ghost gap-1 px-2 py-1" disabled={busy} onClick={() => void like()} aria-pressed={post.viewer.liked}>
              {post.viewer.liked ? '❤️' : '🤍'} {post.counts.likes}
            </button>
            <button className="btn btn-ghost gap-1 px-2 py-1" onClick={() => void toggleComments()} aria-expanded={showComments}>
              💬 {post.counts.comments}
            </button>
            <button className="btn btn-ghost gap-1 px-2 py-1" disabled={busy || post.viewer.reposted} onClick={() => void repost()}>
              🔁 {post.counts.reposts}
            </button>
            {post.author.id !== viewerId && (
              <button className="btn btn-ghost gap-1 px-2 py-1" disabled={busy} onClick={() => void follow()}>
                {post.viewer.following ? tr('unfollow') : tr('follow')}
              </button>
            )}
            {post.viewer.isMine ? (
              <button className="btn btn-ghost px-2 py-1" onClick={() => void remove()}>
                {tr('delete')}
              </button>
            ) : (
              <button className="btn btn-ghost px-2 py-1" onClick={() => void report()}>
                {tr('report')}
              </button>
            )}
          </div>

          {error && (
            <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}

          {showComments && (
            <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <form onSubmit={submitComment} className="flex gap-2">
                <input
                  className="input"
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  placeholder={tr('comment')}
                  aria-label={tr('comment')}
                />
                <Button type="submit" disabled={!commentText.trim()}>
                  {tr('reply')}
                </Button>
              </form>
              {comments.length === 0 && <p className="muted text-xs">كن أول من يعلّق.</p>}
              <ul className="space-y-2">
                {comments.map((comment) => (
                  <li key={comment.id} className="flex gap-2">
                    <Avatar name={comment.author.displayName} src={comment.author.avatarUrl} size={28} />
                    <div className="min-w-0">
                      <p className="text-xs">
                        <span className="font-semibold">{comment.author.displayName}</span>{' '}
                        <span className="muted">
                          @{comment.author.username} · {formatTime(comment.createdAt)}
                        </span>
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Turns #hashtags and @mentions into search links. */
function linkify(body: string): React.ReactNode[] {
  return body.split(/(\s+)/).map((chunk, index) => {
    if (/^#[\p{L}\p{N}_]+$/u.test(chunk)) {
      return (
        <Link key={index} href={`/app/search?q=${encodeURIComponent(chunk.slice(1))}`} className="text-brand-500 hover:underline">
          {chunk}
        </Link>
      );
    }
    if (/^@[a-z0-9_]+$/i.test(chunk)) {
      return (
        <Link key={index} href={`/app/profile/${chunk.slice(1).toLowerCase()}`} className="text-brand-500 hover:underline">
          {chunk}
        </Link>
      );
    }
    return <span key={index}>{chunk}</span>;
  });
}
