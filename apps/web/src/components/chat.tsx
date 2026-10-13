'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { realtime, newClientMessageId, newRequestId } from '@/lib/realtime';
import { Avatar, Badge, Button, EmptyState, Spinner, formatTime } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { ServerFrame } from '@sovereign/shared/protocol';

/** Chat building blocks: conversation list, message thread and composer. */

export interface Conversation {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
  avatarUrl: string | null;
  peerUsername: string | null;
  memberCount: number;
  unreadCount: number;
  isEncrypted: boolean;
  lastMessage: { id: string; body: string | null; type: string; isMine: boolean } | null;
  lastMessageAt: string | null;
  myRole: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  body: string | null;
  type: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  state: 'sent' | 'delivered' | 'read';
  sender: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  attachments: Array<{ id: string; url: string; mimeType: string; fileName: string; sizeBytes: number; width: number | null; height: number | null; durationMs: number | null }>;
  replyTo: { id: string; body: string | null; senderUsername: string | null } | null;
}

/* ------------------------------------------------------------------ list */

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  loading,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
  loading: boolean;
}) {
  const tr = useT();
  if (loading) {
    return (
      <div className="grid place-items-center p-8">
        <Spinner />
      </div>
    );
  }
  if (conversations.length === 0) {
    return <EmptyState title={tr('empty')} description="ابدأ محادثة جديدة من الزر بالأعلى." icon="💬" />;
  }
  return (
    <ul className="scroll-area h-full divide-y" style={{ borderColor: 'var(--border)' }}>
      {conversations.map((conversation) => {
        const active = conversation.id === activeId;
        return (
          <li key={conversation.id}>
            <button
              onClick={() => onSelect(conversation)}
              aria-current={active ? 'true' : undefined}
              className="flex w-full items-center gap-3 px-3 py-3 text-start transition hover:bg-[var(--surface-sunken)]"
              style={active ? { background: 'var(--surface-sunken)' } : undefined}
            >
              <Avatar
                name={conversation.title ?? 'Direct'}
                src={conversation.avatarUrl}
                size={44}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold">{conversation.title ?? 'محادثة'}</span>
                  {conversation.type === 'group' && <Badge>{conversation.memberCount}</Badge>}
                  {conversation.isEncrypted && <Badge tone="brand">E2EE</Badge>}
                </span>
                <span className="muted flex items-center gap-2 truncate text-xs">
                  {conversation.lastMessage?.isMine && <span>أنت:</span>}
                  <span className="truncate">{conversation.lastMessage?.body ?? 'لا رسائل بعد'}</span>
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                {conversation.lastMessageAt && <span className="muted text-[10px]">{formatTime(conversation.lastMessageAt)}</span>}
                {conversation.unreadCount > 0 && (
                  <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
                    {conversation.unreadCount}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ thread */

function AttachmentView({ attachment }: { attachment: ChatMessage['attachments'][number] }) {
  const isImage = attachment.mimeType.startsWith('image/');
  const isVideo = attachment.mimeType.startsWith('video/');
  const isAudio = attachment.mimeType.startsWith('audio/');
  if (isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={attachment.url}
        alt={attachment.fileName}
        className="max-h-72 w-auto rounded-xl"
        loading="lazy"
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
      />
    );
  }
  if (isVideo) {
    return <video src={attachment.url} controls className="max-h-72 rounded-xl" preload="metadata" />;
  }
  if (isAudio) {
    return <audio src={attachment.url} controls className="w-64" preload="metadata" />;
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-xl border p-2 text-sm underline"
      style={{ borderColor: 'currentColor' }}
    >
      📎 {attachment.fileName}
      <span className="opacity-70">({Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB)</span>
    </a>
  );
}

export function MessageThread({
  messages,
  viewerId,
  typingUsers,
  peerIsOnline,
  loading,
  onReply,
  onEdit,
  onDelete,
}: {
  messages: ChatMessage[];
  viewerId: string;
  typingUsers: string[];
  peerIsOnline: boolean | null;
  loading: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
}) {
  const tr = useT();
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, typingUsers.length]);

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (messages.length === 0) {
    return <EmptyState title="ابدأ المحادثة" description="أرسل أول رسالة — ستظهر فوراً للطرف الآخر." icon="👋" />;
  }

  return (
    <div className="scroll-area flex-1 space-y-2 p-3">
      {messages.map((message) => {
        const mine = message.sender?.id === viewerId;
        if (message.type === 'system') {
          return (
            <p key={message.id} className="muted text-center text-xs">
              {message.body}
            </p>
          );
        }
        return (
          <div key={message.id} className={`group flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
            {!mine && <Avatar name={message.sender?.displayName ?? '?'} src={message.sender?.avatarUrl} size={30} />}
            <div className={`max-w-[78%] space-y-1 ${mine ? 'items-end text-end' : ''}`}>
              {!mine && (
                <p className="muted text-[11px]">
                  {message.sender?.displayName}
                  {peerIsOnline !== null && !mine && message.sender?.id && <span> · {peerIsOnline ? tr('online') : tr('offline')}</span>}
                </p>
              )}
              <div
                className={`space-y-1 rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? 'bubble-out' : 'bubble-in'}`}
                style={{ borderStartEndRadius: mine ? 4 : undefined }}
              >
                {message.replyTo && (
                  <p className="border-s-2 ps-2 text-[11px] opacity-80" style={{ borderColor: 'currentColor' }}>
                    رداً على {message.replyTo.senderUsername ?? 'رسالة'}: {message.replyTo.body?.slice(0, 60)}
                  </p>
                )}
                {message.deletedAt ? (
                  <em className="opacity-70">حُذفت هذه الرسالة</em>
                ) : (
                  <>
                    {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
                    {message.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {message.attachments.map((attachment) => (
                          <AttachmentView key={attachment.id} attachment={attachment} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <p className="muted text-[10px]">
                {formatTime(message.createdAt)}
                {message.editedAt && ' · عُدّلت'}
                {mine && !message.deletedAt && ` · ${message.state === 'read' ? 'قُرئت' : message.state === 'delivered' ? 'وصلت' : 'أُرسلت'}`}
              </p>
            </div>
            {!message.deletedAt && (
              <div className="flex items-start gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => onReply(message)}>
                  {tr('reply')}
                </button>
                {mine && (
                  <>
                    <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => onEdit(message)}>
                      {tr('edit')}
                    </button>
                    <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => onDelete(message)}>
                      {tr('delete')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {typingUsers.length > 0 && (
        <p className="muted text-xs" aria-live="polite">
          {typingUsers.join('، ')} {tr('typing')}
        </p>
      )}
      <div ref={bottom} />
    </div>
  );
}

/* ------------------------------------------------------------------ composer */

export function Composer({
  conversationId,
  onSent,
  replyingTo,
  onCancelReply,
  disabled,
}: {
  conversationId: string;
  onSent: (message: ChatMessage, duplicated: boolean) => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<ChatMessage['attachments']>([]);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<number | null>(null);

  const notifyTyping = () => {
    realtime.send({ t: 'typing', conversationId, isTyping: true });
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      realtime.send({ t: 'typing', conversationId, isTyping: false });
    }, 2500);
  };

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const body = text.trim();
    if (!body && attachments.length === 0) return;
    const clientMessageId = newClientMessageId();
    const attachmentIds = attachments.map((attachment) => attachment.id);
    setText('');
    setAttachments([]);
    onCancelReply();

    // Optimistic send over the socket when connected, REST as the fallback.
    try {
      const response = await realtime.request<{ data: { message: ChatMessage; duplicated: boolean } }>(
        {
          t: 'message.send',
          rid: newRequestId('msg'),
          clientMessageId,
          conversationId,
          body,
          replyToId: replyingTo?.id ?? null,
        },
        8000,
      );
      onSent(response.data.message, response.data.duplicated);
    } catch {
      try {
        const result = await api.post<{ message: ChatMessage; duplicated: boolean }>(
          `/api/conversations/${conversationId}/messages`,
          { clientMessageId, body, attachmentIds, replyToId: replyingTo?.id ?? null },
        );
        onSent(result.message, result.duplicated);
      } catch (err) {
        setText(body);
        console.error('send failed', err);
      }
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        const form = new FormData();
        form.append('file', file);
        const result = await api.upload<{ attachment: ChatMessage['attachments'][number] }>('/api/files', form);
        setAttachments((current) => [...current, result.attachment]);
      }
    } catch (err) {
      console.error('upload failed', err);
      alert('تعذّر رفع الملف (النوع أو الحجم غير مسموح).');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('file', new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }));
        setUploading(true);
        try {
          const result = await api.upload<{ attachment: ChatMessage['attachments'][number] }>('/api/files', form);
          setAttachments((current) => [...current, result.attachment]);
        } finally {
          setUploading(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      alert('تعذّر الوصول إلى الميكروفون.');
    }
  }

  return (
    <form onSubmit={send} className="space-y-2 border-t p-3" style={{ borderColor: 'var(--border)' }}>
      {replyingTo && (
        <div className="flex items-center justify-between rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--surface-sunken)' }}>
          <span className="truncate">
            رداً على {replyingTo.sender?.username}: {replyingTo.body?.slice(0, 60)}
          </span>
          <button type="button" onClick={onCancelReply} aria-label="cancel reply">
            ✕
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="pill">
              {attachment.fileName}
              <button type="button" onClick={() => setAttachments((current) => current.filter((a) => a.id !== attachment.id))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          className="input min-h-[44px] flex-1 resize-none"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={tr('messagePlaceholder')}
          aria-label={tr('messagePlaceholder')}
          onChange={(event) => {
            setText(event.target.value);
            notifyTyping();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(event);
            }
          }}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept="image/*,video/*,audio/*,application/pdf,text/plain,.zip"
          onChange={(event) => void upload(event.target.files)}
        />
        <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label={tr('uploadFile')}>
          {uploading ? <Spinner size={14} /> : '📎'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void toggleRecording()}
          aria-label={recording ? tr('stopRecording') : tr('startRecording')}
          style={recording ? { color: 'var(--danger)' } : undefined}
        >
          {recording ? '⏹' : '🎙'}
        </Button>
        <Button type="submit" disabled={disabled || uploading || (!text.trim() && attachments.length === 0)}>
          {tr('send')}
        </Button>
      </div>
    </form>
  );
}

/** Merges an incoming realtime frame into the message list (dedup + ordering by time). */
export function applyMessageFrame(messages: ChatMessage[], frame: ServerFrame): ChatMessage[] {
  if (frame.t !== 'message' && frame.t !== 'ack') return messages;
  const payload = frame.t === 'ack' ? (frame.data as { message?: ChatMessage } | undefined)?.message : (frame.message as ChatMessage | undefined);
  if (!payload || !payload.id) return messages;
  const merged = messages.some((message) => message.id === payload.id)
    ? messages.map((message) => (message.id === payload.id ? { ...message, ...payload } : message))
    : [...messages, payload];
  return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function useConversationMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const reload = useMemo(
    () => async (id: string) => {
      setLoading(true);
      try {
        const result = await api.get<{ items: ChatMessage[] }>(`/api/conversations/${id}/messages?limit=50`);
        setMessages([...result.items].reverse());
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    void reload(conversationId);
    realtime.subscribe([conversationId]);
    return () => realtime.unsubscribe([conversationId]);
  }, [conversationId, reload]);

  useEffect(() => {
    const unsubscribed = realtime.onFrame((frame) => {
      if (frame.t === 'message' && frame.conversationId === conversationId) {
        setMessages((current) => applyMessageFrame(current, frame));
      }
      if (frame.t === 'message.updated' && frame.conversationId === conversationId) {
        setMessages((current) => applyMessageFrame(current, frame));
      }
      if (frame.t === 'message.deleted' && frame.conversationId === conversationId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === frame.messageId ? { ...message, deletedAt: frame.deletedAt, body: null, attachments: [] } : message,
          ),
        );
      }
      if (frame.t === 'receipt' && frame.conversationId === conversationId) {
        setMessages((current) =>
          current.map((message) => (message.id === frame.messageId ? { ...message, state: frame.state } : message)),
        );
      }
      if (frame.t === 'typing' && frame.conversationId === conversationId) {
        setTypingUsers((current) => {
          if (frame.isTyping) return current.includes(frame.userId) ? current : [...current, frame.userId];
          return current.filter((id) => id !== frame.userId);
        });
      }
    });
    return () => {
      unsubscribed();
    };
  }, [conversationId]);

  return { messages, setMessages, loading, typingUsers };
}
