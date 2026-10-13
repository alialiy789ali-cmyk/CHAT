'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Avatar, Button, EmptyState, Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { PostCard } from '@/components/post-card';
import type { Post } from '@/components/post';

/** Unified search: users, public posts and channels — plus trending hashtags. */

interface SearchResults {
  users: Array<{ id: string; username: string; displayName: string; avatarUrl: string | null; bio: string | null }>;
  posts: Post[];
  channels: Array<{ id: string; name: string; slug: string; subscriberCount: number; isSubscribed: boolean }>;
}

export default function SearchPage() {
  const { viewer } = useSession();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'users' | 'posts' | 'channels'>('all');
  const [results, setResults] = useState<SearchResults>({ users: [], posts: [], channels: [] });
  const [trending, setTrending] = useState<Array<{ tag: string; uses: string; likes: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('q');
    if (initial) setQuery(initial);
  }, []);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults({ users: [], posts: [], channels: [] });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const path = `/api/search?q=${encodeURIComponent(query)}${tab === 'all' ? '' : `&type=${tab}`}&limit=20`;
        const result = await api.get<SearchResults>(path);
        if (!controller.signal.aborted) {
          setResults({ users: result.users ?? [], posts: result.posts ?? [], channels: result.channels ?? [] });
        }
      } catch {
        if (!controller.signal.aborted) setError('تعذّر تنفيذ البحث.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, tab]);

  // Trending hashtags are shown before anything is typed.
  useEffect(() => {
    if (query.trim().length > 0) return;
    void api
      .get<{ hashtags: Array<{ tag: string; uses: string; likes: string }> }>('/api/hashtags/trending')
      .then((result) => setTrending(result.hashtags))
      .catch(() => {});
  }, [query]);

  const empty = results.users.length === 0 && results.posts.length === 0 && results.channels.length === 0;

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <input
        className="input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ابحث عن مستخدمين أو منشورات أو قنوات أو #وسم"
        aria-label="search"
        autoFocus
      />

      <div className="flex flex-wrap gap-1">
        {(
          [
            ['all', 'الكل'],
            ['users', 'مستخدمون'],
            ['posts', 'منشورات'],
            ['channels', 'قنوات'],
          ] as const
        ).map(([id, label]) => (
          <Button key={id} variant={tab === id ? 'primary' : 'ghost'} className="px-3 py-1 text-xs" onClick={() => setTab(id)}>
            {label}
          </Button>
        ))}
      </div>

      {loading && (
        <div className="grid place-items-center p-4">
          <Spinner />
        </div>
      )}

      {!loading && query.trim().length === 0 && trending.length > 0 && (
        <section className="card space-y-2 p-4">
          <h2 className="font-semibold">الأكثر تداولاً هذا الأسبوع</h2>
          <ul className="space-y-1 text-sm">
            {trending.map((trend) => (
              <li key={trend.tag}>
                <button className="hover:underline" onClick={() => setQuery(trend.tag)}>
                  #{trend.tag}
                </button>
                <span className="muted text-xs"> · {trend.uses} منشور · {trend.likes} إعجاب</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!loading && query.trim().length > 0 && empty && (
        <EmptyState title="لا نتائج" description="جرّب كلمات مختلفة أو وسماً شائعاً." icon="🔍" />
      )}

      {error && (
        <p className="card p-3 text-sm" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </p>
      )}

      {results.users.length > 0 && (
        <section className="card p-0">
          <h2 className="p-3 font-semibold">مستخدمون</h2>
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {results.users.map((user) => (
              <li key={user.id}>
                <Link href={`/app/profile/${user.username}`} className="flex items-center gap-3 p-3 hover:bg-[var(--surface-sunken)]">
                  <Avatar name={user.displayName} src={user.avatarUrl} size={40} />
                  <span className="min-w-0">
                    <span className="block font-medium">{user.displayName}</span>
                    <span className="muted block truncate text-xs">
                      @{user.username} {user.bio ? `· ${user.bio}` : ''}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.channels.length > 0 && (
        <section className="card p-3">
          <h2 className="mb-2 font-semibold">قنوات</h2>
          <ul className="space-y-2">
            {results.channels.map((channel) => (
              <li key={channel.id}>
                <Link href="/app/channels" className="block rounded-lg p-2 hover:bg-[var(--surface-sunken)]">
                  <span className="block font-medium">{channel.name}</span>
                  <span className="muted block text-xs">
                    @{channel.slug} · {channel.subscriberCount} مشترك {channel.isSubscribed ? '· مشترك' : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.posts.length > 0 && (
        <ul className="space-y-3">
          {results.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              viewerId={viewer?.id ?? ''}
              onChange={(next) => setResults((current) => ({ ...current, posts: current.posts.map((item) => (item.id === next.id ? next : item)) }))}
              onRemoved={(id) => setResults((current) => ({ ...current, posts: current.posts.filter((item) => item.id !== id) }))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
