'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Avatar, Badge, Button, EmptyState, Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { PostCard } from '@/app/app/feed/page';
import type { Post } from '@/components/post';

interface ProfilePayload {
  user: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    isVerified: boolean;
    createdAt: string;
  };
  stats: { followers: number; following: number; posts: number };
  viewer: { following: boolean; followedBy: boolean; blocked: boolean; isSelf: boolean } | null;
  posts: Post[];
  online: boolean;
}

export default function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const { viewer } = useSession();
  const tr = useT();
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.get<ProfilePayload>(`/api/users/${encodeURIComponent(username)}`);
        if (!cancelled) setProfile(result);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 403
            ? 'هذا الملف الشخصي مقصور على المتابعين.'
            : 'لم يتم العثور على هذا المستخدم.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (loading) {
    return (
      <div className="grid min-h-[50dvh] place-items-center">
        <Spinner size={28} />
      </div>
    );
  }

  if (error || !profile) {
    return <EmptyState title="تعذّر عرض الملف" description={error ?? undefined} icon="🔒" />;
  }

  const { user, stats, viewer: relation } = profile;
  const isSelf = relation?.isSelf ?? user.id === viewer?.id;

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <header className="card space-y-4 p-5">
        <div className="flex items-start gap-4">
          <Avatar name={user.displayName} src={user.avatarUrl} size={72} online={profile.online} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold">{user.displayName}</h1>
              {user.isVerified && <Badge tone="success">موثّق</Badge>}
              {relation?.followedBy && !isSelf && <Badge>يتابعك</Badge>}
            </div>
            <p className="muted text-sm">@{user.username}</p>
            {user.bio && <p className="text-sm">{user.bio}</p>}
            <p className="muted text-xs">عضو منذ {new Date(user.createdAt).toLocaleDateString('ar-EG')}</p>
          </div>
        </div>

        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="muted">منشورات</dt>
            <dd className="font-semibold">{stats.posts}</dd>
          </div>
          <div>
            <dt className="muted">متابِعون</dt>
            <dd className="font-semibold">{stats.followers}</dd>
          </div>
          <div>
            <dt className="muted">يتابع</dt>
            <dd className="font-semibold">{stats.following}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          {isSelf ? (
            <Link className="btn btn-ghost" href="/app/settings">
              {tr('settings')}
            </Link>
          ) : (
            <>
              <Button
                variant={relation?.following ? 'ghost' : 'primary'}
                onClick={async () => {
                  const wasFollowing = relation?.following ?? false;
                  if (wasFollowing) await api.del(`/api/users/${user.username}/follow`);
                  else await api.post(`/api/users/${user.username}/follow`);
                  setProfile({
                    ...profile,
                    viewer: {
                      following: !wasFollowing,
                      followedBy: relation?.followedBy ?? false,
                      blocked: relation?.blocked ?? false,
                      isSelf: false,
                    },
                    stats: { ...stats, followers: stats.followers + (wasFollowing ? -1 : 1) },
                  });
                }}
              >
                {relation?.following ? tr('unfollow') : tr('follow')}
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const result = await api.post<{ conversation: { id: string } }>('/api/conversations/direct', { userId: user.id });
                  window.location.href = `/app?c=${result.conversation.id}`;
                }}
              >
                💬 {tr('send')}
              </Button>
              <Button
                variant={relation?.blocked ? 'ghost' : 'danger'}
                onClick={async () => {
                  const blocked = !(relation?.blocked ?? false);
                  if (blocked) await api.post(`/api/users/${user.username}/block`);
                  else await api.del(`/api/users/${user.username}/block`);
                  setProfile({
                    ...profile,
                    viewer: { following: false, followedBy: false, blocked, isSelf: false },
                  });
                }}
              >
                {relation?.blocked ? tr('unblock') : tr('block')}
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const reason = window.prompt('سبب الإبلاغ (spam, harassment, hate, violence, self_harm, sexual, misinformation, other)', 'harassment');
                  if (!reason) return;
                  await api.post('/api/reports', { targetType: 'user', targetId: user.id, reason, details: null });
                  window.alert('تم إرسال البلاغ إلى فريق الإشراف.');
                }}
              >
                {tr('report')}
              </Button>
            </>
          )}
        </div>
      </header>

      {profile.posts.length === 0 ? (
        <EmptyState title="لا منشورات عامة" description={isSelf ? 'انشر أول تحديث لك من الموجز.' : undefined} icon="📝" />
      ) : (
        <ul className="space-y-3">
          {profile.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              viewerId={viewer?.id ?? ''}
              onChange={(next) => setProfile({ ...profile, posts: profile.posts.map((item) => (item.id === next.id ? next : item)) })}
              onRemoved={(id) => setProfile({ ...profile, posts: profile.posts.filter((item) => item.id !== id) })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
