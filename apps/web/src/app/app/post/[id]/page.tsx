'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { PostCard } from '@/components/post-card';
import type { Post } from '@/components/post';

/** Single post view: the post, its replies and a link back to the author's profile. */

export default function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { viewer } = useSession();
  const [post, setPost] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [{ post: fetched }, comments] = await Promise.all([
          api.get<{ post: Post }>(`/api/posts/${id}`),
          api.get<{ items: Post[] }>(`/api/posts/${id}/comments?limit=50`),
        ]);
        if (cancelled) return;
        setPost(fetched);
        setReplies(comments.items);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? 'المنشور غير موجود أو حُذف.' : 'تعذّر تحميل المنشور.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="grid min-h-[50dvh] place-items-center">
        <Spinner size={28} />
      </div>
    );
  }
  if (!post) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState title="تعذّر عرض المنشور" description={error ?? undefined} icon="🔍" />
        <div className="grid place-items-center pt-2">
          <Link className="btn btn-ghost" href="/app/feed">
            العودة إلى الموجز
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <Link className="text-sm underline" href={`/app/profile/${post.author.username}`}>
        ← @{post.author.username}
      </Link>
      <ul>
        <PostCard
          post={post}
          viewerId={viewer?.id ?? ''}
          onChange={setPost}
          onRemoved={() => setPost(null)}
        />
      </ul>

      <h2 className="font-semibold">الردود ({replies.length})</h2>
      {replies.length === 0 ? (
        <EmptyState title="لا ردود بعد" icon="💬" />
      ) : (
        <ul className="space-y-3">
          {replies.map((reply) => (
            <PostCard
              key={reply.id}
              post={reply}
              viewerId={viewer?.id ?? ''}
              onChange={(next) => setReplies((current) => current.map((item) => (item.id === next.id ? next : item)))}
              onRemoved={(removedId) => setReplies((current) => current.filter((item) => item.id !== removedId))}
            />
          ))}
        </ul>
      )}

      {replies.length > 0 && (
        <div className="grid place-items-center">
          <Button variant="ghost" onClick={() => window.location.reload()}>
            تحديث الردود
          </Button>
        </div>
      )}
    </div>
  );
}
