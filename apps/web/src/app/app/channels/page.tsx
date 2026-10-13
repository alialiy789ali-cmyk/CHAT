'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Spinner, formatTime } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { PostComposer } from '@/components/post';

/**
 * Broadcast channels: public discovery, subscriptions, the owner's publishing console,
 * member/role management and invite links. Endpoints mirror routes/channels.routes.ts.
 */

interface Channel {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  visibility: 'public' | 'private';
  ownerId: string;
  subscriberCount: number;
  isSubscribed: boolean;
  myRole: 'owner' | 'admin' | 'moderator' | 'subscriber' | null;
  createdAt: string;
}

interface ChannelMember {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'admin' | 'moderator' | 'subscriber';
  joinedAt: string;
}

interface ChannelPost {
  id: string;
  channelId: string;
  author: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  body: string | null;
  media: Array<{ id: string; url: string; mimeType: string; fileName: string }>;
  pinnedAt: string | null;
  editedAt: string | null;
  createdAt: string;
}

export default function ChannelsPage() {
  const { viewer } = useSession();
  const tr = useT();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Channel | null>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [invite, setInvite] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadChannels = useCallback(async (term?: string) => {
    setLoading(true);
    try {
      const [discover, subscribed] = await Promise.all([
        api.get<{ channels: Channel[] }>(`/api/channels/discover?limit=30${term ? `&q=${encodeURIComponent(term)}` : ''}`),
        api.get<{ channels: Channel[] }>('/api/channels/subscribed'),
      ]);
      const merged = new Map<string, Channel>();
      for (const channel of [...subscribed.channels, ...discover.channels]) merged.set(channel.id, channel);
      setChannels([...merged.values()].sort((a, b) => Number(b.isSubscribed) - Number(a.isSubscribed)));
    } finally {
      setLoading(false);
    }
  }, []);

  const openChannel = useCallback(async (channel: Channel) => {
    setActive(channel);
    setLoadingPosts(true);
    try {
      const detail = await api.get<{ channel: Channel; members: ChannelMember[] }>(`/api/channels/${channel.slug}`);
      setActive(detail.channel);
      setMembers(detail.members);
      const list = await api.get<{ items: ChannelPost[]; nextCursor: string | null }>(`/api/channels/${detail.channel.id}/posts?limit=50`);
      setPosts(list.items);
    } catch {
      setError('تعذّر فتح القناة (قد تكون خاصة وتتطلب دعوة).');
    } finally {
      setLoadingPosts(false);
    }
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  // Deep link: /app/channels?join=<code> redeems an invite immediately.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join');
    if (!code) return;
    void api
      .post<{ joined: boolean; channelId?: string }>(`/api/channels/join/${encodeURIComponent(code)}`)
      .then(async (result) => {
        setNotice('تم الانضمام إلى القناة.');
        await loadChannels();
        if (result.channelId) {
          const detail = await api.get<{ channel: Channel }>(`/api/channels/${result.channelId}`);
          void openChannel(detail.channel);
        }
      })
      .catch(() => setError('رابط الدعوة غير صالح أو استُهلك.'));
    window.history.replaceState(null, '', '/app/channels');
  }, [loadChannels, openChannel]);

  async function toggleSubscription(channel: Channel) {
    setError(null);
    try {
      if (channel.isSubscribed) {
        await api.del(`/api/channels/${channel.id}/subscribe`);
      } else {
        await api.post(`/api/channels/${channel.id}/subscribe`);
      }
      await loadChannels(query || undefined);
      if (active?.id === channel.id) {
        setActive({ ...channel, isSubscribed: !channel.isSubscribed, subscriberCount: channel.subscriberCount + (channel.isSubscribed ? -1 : 1) });
      }
    } catch {
      setError('تعذّرت العملية — القنوات الخاصة تتطلب رابط دعوة.');
    }
  }

  const canPublish = active?.myRole === 'owner' || active?.myRole === 'admin' || active?.myRole === 'moderator';

  return (
    <div className="mx-auto grid h-[calc(100dvh-3.25rem)] max-w-7xl gap-4 p-4 md:grid-cols-[20rem_1fr]">
      <aside className="card flex min-h-0 flex-col overflow-hidden">
        <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <h1 className="flex-1 font-bold">{tr('channels')}</h1>
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setShowCreate(true)}>
              ✚ {tr('createChannel')}
            </Button>
          </div>
          <input
            className="input text-sm"
            placeholder="ابحث في القنوات العامة…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              void loadChannels(event.target.value);
            }}
            aria-label="channel search"
          />
        </div>
        <div className="scroll-area flex-1">
          {loading ? (
            <div className="grid place-items-center p-6">
              <Spinner />
            </div>
          ) : channels.length === 0 ? (
            <EmptyState title="لا قنوات بعد" description="أنشئ قناة عامة وابدأ البث." icon="📣" />
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    onClick={() => void openChannel(channel)}
                    className="flex w-full items-center gap-3 p-3 text-start hover:bg-[var(--surface-sunken)]"
                    style={active?.id === channel.id ? { background: 'var(--surface-sunken)' } : undefined}
                  >
                    <Avatar name={channel.name} src={channel.avatarUrl} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-semibold">{channel.name}</span>
                        {channel.visibility === 'private' && <Badge>خاصة</Badge>}
                        {channel.isSubscribed && <Badge tone="brand">مشترك</Badge>}
                      </span>
                      <span className="muted block truncate text-xs">
                        @{channel.slug} · {channel.subscriberCount} مشترك
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="card flex min-h-0 flex-col overflow-hidden">
        {!active ? (
          <EmptyState title="اختر قناة" description="تصفح القنوات العامة أو أنشئ قناتك الخاصة." icon="📣" />
        ) : (
          <>
            <header className="space-y-2 border-b p-4" style={{ borderColor: 'var(--border)' }}>
              <div className="flex flex-wrap items-center gap-3">
                <Avatar name={active.name} src={active.avatarUrl} size={44} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{active.name}</p>
                  <p className="muted truncate text-xs">
                    @{active.slug} · {active.subscriberCount} مشترك {active.myRole ? `· دورك: ${active.myRole}` : ''}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => setShowMembers(true)}>
                  {tr('members')} ({members.length})
                </Button>
                <Button variant={active.isSubscribed ? 'ghost' : 'primary'} onClick={() => void toggleSubscription(active)}>
                  {active.isSubscribed ? tr('unsubscribe') : tr('subscribe')}
                </Button>
                {(active.myRole === 'owner' || active.myRole === 'admin') && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const result = await api.post<{ invite: { code: string } }>(`/api/channels/${active.id}/invites`, {
                        role: 'subscriber',
                        maxUses: 100,
                        ttlHours: 168,
                      });
                      setInvite({ code: result.invite.code, url: `${window.location.origin}/app/channels?join=${result.invite.code}` });
                    }}
                  >
                    رابط دعوة
                  </Button>
                )}
              </div>
              {active.description && <p className="muted text-sm">{active.description}</p>}
              {error && (
                <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">
                  {error}
                </p>
              )}
              {notice && <p className="text-xs">{notice}</p>}
            </header>

            {canPublish && (
              <div className="border-b p-3" style={{ borderColor: 'var(--border)' }}>
                <PostComposer
                  channelId={active.id}
                  placeholder="أعلن شيئاً لمشتركي القناة…"
                  onCreated={(post) =>
                    setPosts((current) => [
                      {
                        id: post.id,
                        channelId: active.id,
                        author: { id: viewer?.id ?? '', username: viewer?.username ?? '', displayName: viewer?.displayName ?? '', avatarUrl: viewer?.avatarUrl ?? null },
                        body: post.body,
                        media: post.media,
                        pinnedAt: null,
                        editedAt: null,
                        createdAt: post.createdAt,
                      },
                      ...current,
                    ])
                  }
                />
              </div>
            )}

            <div className="scroll-area flex-1 space-y-3 p-4">
              {loadingPosts ? (
                <div className="grid place-items-center p-6">
                  <Spinner />
                </div>
              ) : posts.length === 0 ? (
                <EmptyState title="لا منشورات بعد" description="سيظهر هنا كل ما ينشره مالك القناة." icon="📰" />
              ) : (
                posts.map((post) => (
                  <article key={post.id} className="card space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {post.author && <Avatar name={post.author.displayName} src={post.author.avatarUrl} size={30} />}
                      <span className="text-sm font-semibold">{post.author?.displayName ?? 'القناة'}</span>
                      <span className="muted text-xs">
                        {post.author ? `@${post.author.username} · ` : ''}
                        {formatTime(post.createdAt)}
                      </span>
                      {post.pinnedAt && <Badge tone="brand">مثبّت</Badge>}
                      {post.editedAt && <Badge>معدّل</Badge>}
                      {post.author?.id === viewer?.id && (
                        <button
                          className="btn btn-ghost ms-auto px-2 py-1 text-xs"
                          onClick={async () => {
                            if (!window.confirm('حذف المنشور من القناة؟')) return;
                            await api.del(`/api/channels/${active.id}/posts/${post.id}`);
                            setPosts((current) => current.filter((item) => item.id !== post.id));
                          }}
                        >
                          {tr('delete')}
                        </button>
                      )}
                      {(active.myRole === 'owner' || active.myRole === 'admin') && (
                        <button
                          className="btn btn-ghost ms-auto px-2 py-1 text-xs"
                          onClick={async () => {
                            const pinned = post.pinnedAt === null;
                            await api.post(`/api/channels/${active.id}/posts/${post.id}/pin`, { pinned });
                            setPosts((current) =>
                              current.map((item) => (item.id === post.id ? { ...item, pinnedAt: pinned ? new Date().toISOString() : null } : item)),
                            );
                          }}
                        >
                          {post.pinnedAt ? 'إلغاء التثبيت' : 'تثبيت'}
                        </button>
                      )}
                    </div>
                    {post.body && <p className="whitespace-pre-wrap break-words">{post.body}</p>}
                    {post.media.map((item) =>
                      item.mimeType.startsWith('image/') ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={item.id} src={item.url} alt={item.fileName} className="max-h-80 rounded-xl" loading="lazy" />
                      ) : (
                        <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="pill">
                          📎 {item.fileName}
                        </a>
                      ),
                    )}
                  </article>
                ))
              )}
            </div>
          </>
        )}
      </section>

      <CreateChannelModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={async (channel) => {
          setShowCreate(false);
          await loadChannels();
          void openChannel(channel);
        }}
      />

      <Modal open={showMembers} title={`${tr('members')} — ${active?.name ?? ''}`} onClose={() => setShowMembers(false)}>
        <ul className="scroll-area max-h-80 space-y-2">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3">
              <Avatar name={member.displayName} src={member.avatarUrl} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{member.displayName}</span>
                <span className="muted block text-xs">@{member.username} · {member.role}</span>
              </span>
              {(active?.myRole === 'owner' || active?.myRole === 'admin') && member.role !== 'owner' && (
                <select
                  className="input w-auto px-2 py-1 text-xs"
                  value={member.role}
                  aria-label={`role of ${member.username}`}
                  onChange={async (event) => {
                    const role = event.target.value as ChannelMember['role'];
                    await api.post(`/api/channels/${active!.id}/members/${member.id}/role`, { role });
                    setMembers((current) => current.map((item) => (item.id === member.id ? { ...item, role } : item)));
                  }}
                >
                  <option value="subscriber">مشترك</option>
                  <option value="moderator">مشرف محتوى</option>
                  <option value="admin">مدير</option>
                </select>
              )}
            </li>
          ))}
        </ul>
      </Modal>

      <Modal open={Boolean(invite)} title="رابط الدعوة" onClose={() => setInvite(null)}>
        <p className="muted text-sm">كل من يفتح هذا الرابط ينضم للقناة (حتى 100 استخدام، صالح 7 أيام).</p>
        <code className="block break-all rounded-lg p-3 text-sm" style={{ background: 'var(--surface-sunken)' }}>
          {invite?.url}
        </code>
        <Button onClick={() => void navigator.clipboard.writeText(invite?.url ?? '')}>نسخ</Button>
      </Modal>
    </div>
  );
}

function CreateChannelModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (channel: Channel) => void;
}) {
  const [form, setForm] = useState({ name: '', slug: '', description: '', visibility: 'public' as 'public' | 'private' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open={open} title="إنشاء قناة" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const result = await api.post<{ channel: Channel }>('/api/channels', {
              name: form.name,
              slug: form.slug || form.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || undefined,
              description: form.description || null,
              visibility: form.visibility,
            });
            onCreated(result.channel);
          } catch {
            setError('تعذّر إنشاء القناة — قد يكون المعرّف مستخدماً.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="اسم القناة" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <Field
          label="المعرّف (بالإنجليزية)"
          value={form.slug}
          onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase() })}
          hint="مثال: tech_news — يُستخدم في الرابط"
        />
        <Field label="الوصف" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">الخصوصية</span>
          <select
            className="input"
            value={form.visibility}
            onChange={(event) => setForm({ ...form, visibility: event.target.value as 'public' | 'private' })}
          >
            <option value="public">عامة — يمكن لأي شخص الانضمام</option>
            <option value="private">خاصة — بالدعوة فقط</option>
          </select>
        </label>
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" loading={busy} disabled={!form.name.trim()}>
            إنشاء
          </Button>
        </div>
      </form>
    </Modal>
  );
}
