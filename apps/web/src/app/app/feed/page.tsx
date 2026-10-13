'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button, EmptyState, Tabs } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { PostComposer, type Post } from '@/components/post';
import { PostCard } from '@/components/post-card';

/** Public timeline: chronological "following" feed plus a global "for you" firehose. */

export default function FeedPage() {
  const { viewer } = useSession();
  const tr = useT();
  const [tab, setTab] = useState<'following' | 'for-you'>('following');
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (which: 'following' | 'for-you', append = false, nextCursor?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ tab: which, limit: '20' });
      if (nextCursor) query.set('cursor', nextCursor);
      const result = await api.get<{ items: Post[]; nextCursor: string | null }>(`/api/feed?${query.toString()}`);
      setPosts((current) => (append ? [...current, ...result.items] : result.items));
      setCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.message : 'تعذّر تحميل الموجز.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'following', label: tr('following') },
          { id: 'for-you', label: tr('forYou') },
        ]}
      />

      <PostComposer onCreated={(post) => setPosts((current) => [post, ...current])} />

      {error && (
        <p className="card p-3 text-sm" style={{ color: 'var(--danger)' }} role="alert">
          {error}{' '}
          <button className="underline" onClick={() => void load(tab)}>
            إعادة المحاولة
          </button>
        </p>
      )}

      {loading && posts.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="card skeleton h-28" />
          ))}
        </div>
      )}

      {!loading && posts.length === 0 && !error && (
        <EmptyState
          title={tab === 'following' ? 'لا منشورات من متابعاتك بعد' : 'لا منشورات عامة بعد'}
          description="تابع مستخدمين آخرين أو انشر أول تحديث لك."
          icon="🌐"
        />
      )}

      <ul className="space-y-3">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            viewerId={viewer?.id ?? ''}
            onChange={(next) => setPosts((current) => current.map((item) => (item.id === next.id ? next : item)))}
            onRemoved={(id) => setPosts((current) => current.filter((item) => item.id !== id))}
          />
        ))}
      </ul>

      {cursor && (
        <div className="grid place-items-center pb-6">
          <Button variant="ghost" loading={loading} onClick={() => void load(tab, true, cursor)}>
            المزيد
          </Button>
        </div>
      )}
    </div>
  );
}
