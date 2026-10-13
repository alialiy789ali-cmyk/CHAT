'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { realtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { Avatar, Badge, Button, Field, Modal, Spinner } from '@/components/ui';
import {
  Composer,
  ConversationList,
  MessageThread,
  type ChatMessage,
  type Conversation,
  useConversationMessages,
} from '@/components/chat';
import { CallOverlay, useCall } from '@/components/call';

/** Messaging workspace: conversation list, active thread, composer and call controls. */

export default function ChatsPage() {
  const { viewer } = useSession();
  const tr = useT();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [peerOnline, setPeerOnline] = useState<boolean | null>(null);

  const call = useCall();
  const { messages, setMessages, loading: messagesLoading, typingUsers } = useConversationMessages(activeId);

  const active = useMemo(() => conversations.find((conversation) => conversation.id === activeId) ?? null, [conversations, activeId]);

  const loadConversations = useCallback(async () => {
    const result = await api.get<{ items: Conversation[] }>('/api/conversations');
    setConversations(result.items);
    setLoading(false);
    return result.items;
  }, []);

  useEffect(() => {
    void loadConversations().then((items) => {
      // Preselect from ?c=<id> or the first conversation on wide screens.
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('c');
      setActiveId((current) => current ?? (requested && items.some((c) => c.id === requested) ? requested : items[0]?.id ?? null));
    });
  }, [loadConversations]);

  // Live conversation list updates.
  useEffect(() => {
    const off = realtime.onFrame((frame) => {
      if (frame.t === 'message' || frame.t === 'message.updated') {
        setConversations((current) => {
          const index = current.findIndex((conversation) => conversation.id === frame.conversationId);
          if (index === -1) {
            void loadConversations();
            return current;
          }
          const message = (frame as { message?: ChatMessage }).message;
          const updated: Conversation = {
            ...current[index],
            lastMessage: message
              ? { id: message.id, body: message.deletedAt ? null : message.body, type: message.type, isMine: message.sender?.id === viewer?.id }
              : current[index].lastMessage,
            lastMessageAt: message?.createdAt ?? current[index].lastMessageAt,
            unreadCount:
              frame.t === 'message' && message?.sender?.id !== viewer?.id && message?.conversationId !== activeId
                ? current[index].unreadCount + 1
                : current[index].unreadCount,
          };
          const rest = current.filter((_, i) => i !== index);
          return [updated, ...rest];
        });
      }
      if (frame.t === 'conversation.updated') void loadConversations();
      if (frame.t === 'message.deleted') {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.lastMessage?.id === frame.messageId
              ? { ...conversation, lastMessage: { ...conversation.lastMessage, body: null } }
              : conversation,
          ),
        );
      }
    });
    return () => {
      off();
    };
  }, [activeId, loadConversations, viewer?.id]);

  // Clear the unread badge when a conversation is opened + tell the sender it was read.
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    setConversations((current) => current.map((c) => (c.id === activeId ? { ...c, unreadCount: 0 } : c)));
    const lastOther = [...messages].reverse().find((message) => message.sender?.id !== viewer?.id);
    if (lastOther) realtime.send({ t: 'message.read', conversationId: activeId, messageId: lastOther.id });
  }, [activeId, messages, viewer?.id]);

  // Presence for a direct conversation.
  useEffect(() => {
    setPeerOnline(null);
    if (!active || active.type !== 'direct') return;
    // The hub pushes presence for DM partners automatically — just listen.
    const off = realtime.onFrame((frame) => {
      if (frame.t === 'presence' && frame.userId !== viewer?.id) setPeerOnline(frame.online);
    });
    return () => {
      off();
    };
  }, [active, viewer?.id]);

  function selectConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    setReplyTo(null);
    setMessages([]);
    window.history.replaceState(null, '', `/app?c=${conversation.id}`);
  }

  async function startDirect(userId: string) {
    const result = await api.post<{ conversation: { id: string } }>('/api/conversations/direct', { userId });
    const items = await loadConversations();
    const target = items.find((conversation) => conversation.id === result.conversation.id);
    if (target) selectConversation(target);
    setShowNew(false);
  }

  async function startGroup(title: string, memberIds: string[]) {
    const result = await api.post<{ conversation: { id: string } }>('/api/conversations/group', { title, memberIds });
    const items = await loadConversations();
    const target = items.find((conversation) => conversation.id === result.conversation.id);
    if (target) selectConversation(target);
    setShowNew(false);
  }

  return (
    <div className="mx-auto grid h-[calc(100dvh-var(--app-header,0px)-3.25rem)] max-w-7xl gap-0 md:grid-cols-[20rem_1fr] md:gap-4 md:p-4">
      {/* list column */}
      <aside
        className={`card flex min-h-0 flex-col overflow-hidden ${active ? 'hidden md:flex' : 'flex'}`}
        aria-label={tr('chats')}
      >
        <div className="flex items-center gap-2 border-b p-3" style={{ borderColor: 'var(--border)' }}>
          <h1 className="flex-1 font-bold">{tr('chats')}</h1>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setShowNew(true)}>
            ✚ {tr('newConversation')}
          </Button>
        </div>
        <ConversationList conversations={conversations} activeId={activeId} onSelect={selectConversation} loading={loading} />
      </aside>

      {/* thread column */}
      <section className={`card flex min-h-0 flex-col overflow-hidden ${active ? 'flex' : 'hidden md:flex'}`}>
        {active ? (
          <>
            <header className="flex items-center gap-3 border-b p-3" style={{ borderColor: 'var(--border)' }}>
              <button className="btn btn-ghost px-2 py-1 md:hidden" onClick={() => setActiveId(null)} aria-label="back">
                ←
              </button>
              <Avatar name={active.title ?? 'Direct'} src={active.avatarUrl} size={40} online={peerOnline ?? undefined} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{active.title ?? 'محادثة'}</p>
                <p className="muted truncate text-xs">
                  {peerOnline !== null ? (peerOnline ? tr('online') : tr('offline')) : `${active.memberCount} ${tr('members')}`}
                  {active.isEncrypted && ' · E2EE'}
                </p>
              </div>
              {active.type === 'direct' && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" className="px-2 py-1" onClick={() => void call.start(active.id, 'audio')} aria-label={tr('audioCall')}>
                    📞
                  </Button>
                  <Button variant="ghost" className="px-2 py-1" onClick={() => void call.start(active.id, 'video')} aria-label={tr('videoCall')}>
                    🎥
                  </Button>
                </div>
              )}
            </header>

            <MessageThread
              messages={messages}
              viewerId={viewer?.id ?? ''}
              typingUsers={typingUsers}
              peerIsOnline={active.type === 'direct' ? peerOnline : null}
              loading={messagesLoading}
              onReply={setReplyTo}
              onEdit={async (message) => {
                const next = window.prompt('تعديل الرسالة', message.body ?? '');
                if (next === null || next.trim() === message.body) return;
                await api.patch(`/api/messages/${message.id}`, { body: next.trim() });
              }}
              onDelete={async (message) => {
                if (!window.confirm('حذف الرسالة للجميع؟')) return;
                await api.del(`/api/messages/${message.id}`);
                setMessages((current) =>
                  current.map((item) =>
                    item.id === message.id ? { ...item, deletedAt: new Date().toISOString(), body: null, attachments: [] } : item,
                  ),
                );
              }}
            />

            <Composer
              conversationId={active.id}
              replyingTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onSent={(message) => setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]))}
            />
          </>
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div className="space-y-2">
              <Spinner />
              <p className="muted text-sm">{loading ? tr('loading') : 'اختر محادثة أو ابدأ واحدة جديدة.'}</p>
            </div>
          </div>
        )}
      </section>

      <NewConversationModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onDirect={startDirect}
        onGroup={startGroup}
      />

      <CallOverlay call={call} title={active?.title ?? 'مكالمة'} />
    </div>
  );
}

/* ------------------------------------------------------------ new chat modal */

function NewConversationModal({
  open,
  onClose,
  onDirect,
  onGroup,
}: {
  open: boolean;
  onClose: () => void;
  onDirect: (userId: string) => Promise<void>;
  onGroup: (title: string, memberIds: string[]) => Promise<void>;
}) {
  const tr = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; username: string; displayName: string; avatarUrl: string | null }>>([]);
  const [selected, setSelected] = useState<typeof results>([]);
  const [title, setTitle] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get<{ users: typeof results }>(`/api/search?q=${encodeURIComponent(query)}&type=users&limit=8`);
        setResults(res.users.filter((user) => !selected.some((s) => s.id === user.id)));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, open, selected]);

  return (
    <Modal open={open} title={tr('newConversation')} onClose={onClose}>
      <Field label={tr('search')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="@username أو اسم ظاهر" />
      {searching && <Spinner size={14} />}
      <ul className="scroll-area max-h-56 space-y-1">
        {results.map((user) => (
          <li key={user.id}>
            <button
              className="flex w-full items-center gap-3 rounded-lg p-2 text-start hover:bg-[var(--surface-sunken)]"
              onClick={() => {
                setSelected((current) => [...current, user]);
                setQuery('');
                setResults([]);
              }}
            >
              <Avatar name={user.displayName} src={user.avatarUrl} size={32} />
              <span>
                <span className="block text-sm font-medium">{user.displayName}</span>
                <span className="muted block text-xs">@{user.username}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {selected.map((user) => (
              <span key={user.id} className="pill">
                @{user.username}
                <button onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))}>✕</button>
              </span>
            ))}
          </div>
          {selected.length > 1 && <Field label={tr('newGroup')} value={title} onChange={(event) => setTitle(event.target.value)} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {tr('cancel')}
            </Button>
            <Button
              onClick={() =>
                selected.length === 1
                  ? void onDirect(selected[0].id)
                  : void onGroup(title.trim() || 'مجموعة جديدة', selected.map((user) => user.id))
              }
            >
              {selected.length === 1 ? tr('send') : tr('newGroup')}
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Badge tone="brand">اختر أكثر من مستخدم لإنشاء مجموعة</Badge>
      </div>
    </Modal>
  );
}
