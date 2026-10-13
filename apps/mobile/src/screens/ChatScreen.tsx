import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { newClientMessageId, newRequestId, realtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { Avatar, Button, ConnectionBanner } from '../components/ui';
import { formatTime, spacing, typography, useTheme } from '../lib/theme';
import type { Conversation } from './ChatListScreen';

interface Message {
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
  attachments: Array<{ id: string; url: string; mimeType: string; fileName: string }>;
}

/**
 * Message thread.
 *
 * Offline behaviour: sending while the socket is down queues the message locally and
 * retries over HTTP, so a dropped connection never silently loses a message.
 */
export function ChatScreen({ conversation, onBack }: { conversation: Conversation; onBack: () => void }) {
  const theme = useTheme();
  const { viewer, connection } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<Array<{ clientMessageId: string; body: string; createdAt: string }>>([]);
  const listRef = useRef<FlatList<Message>>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ items: Message[] }>(`/api/conversations/${conversation.id}/messages?limit=50`);
      setMessages([...result.items].reverse());
    } catch {
      Alert.alert('تعذّر التحميل', 'تحقق من الاتصال بالخادم ثم أعد المحاولة.');
    } finally {
      setLoading(false);
    }
  }, [conversation.id]);

  useEffect(() => {
    void load();
    realtime.subscribe([conversation.id]);
    return () => realtime.unsubscribe([conversation.id]);
  }, [conversation.id, load]);

  // Delivery receipts for everything we just loaded (the server authorises membership).
  useEffect(() => {
    const incoming = messages.filter((message) => message.sender?.id !== viewer?.id).map((message) => message.id);
    if (incoming.length === 0) return;
    realtime.send({ t: 'message.delivered', messageIds: incoming.slice(-50) });
  }, [messages, viewer?.id]);

  useEffect(() => {
    const off = realtime.onFrame((frame) => {
      if (frame.t === 'message' && frame.conversationId === conversation.id) {
        const incoming = (frame as unknown as { message: Message }).message;
        setMessages((current) => (current.some((m) => m.id === incoming.id) ? current : [...current, incoming]));
        // Tell the sender we received it.
        if (incoming.sender?.id !== viewer?.id) {
          realtime.send({ t: 'message.read', conversationId: conversation.id, messageId: incoming.id });
        }
      }
      if (frame.t === 'message.updated' && frame.conversationId === conversation.id) {
        const updated = (frame as unknown as { message: Message }).message;
        setMessages((current) => current.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)));
      }
      if (frame.t === 'message.deleted' && frame.conversationId === conversation.id) {
        setMessages((current) =>
          current.map((m) => (m.id === frame.messageId ? { ...m, deletedAt: frame.deletedAt, body: null, attachments: [] } : m)),
        );
      }
      if (frame.t === 'receipt' && frame.conversationId === conversation.id) {
        setMessages((current) => current.map((m) => (m.id === frame.messageId ? { ...m, state: frame.state } : m)));
      }
    });
    return () => {
      off();
    };
  }, [conversation.id, viewer?.id]);

  // Retry queued messages whenever the socket comes back.
  useEffect(() => {
    if (connection !== 'open' || queued.length === 0) return;
    const pending = [...queued];
    setQueued([]);
    for (const item of pending) {
      realtime
        .request({ t: 'message.send', rid: newRequestId('queued'), clientMessageId: item.clientMessageId, conversationId: conversation.id, body: item.body })
        .catch(() => setQueued((current) => [...current, item]));
    }
  }, [connection, queued, conversation.id]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    const clientMessageId = newClientMessageId();
    setText('');
    setSending(true);
    if (connection !== 'open') {
      // Optimistic local echo + queue; HTTP fallback runs immediately as well.
      setQueued((current) => [...current, { clientMessageId, body, createdAt: new Date().toISOString() }]);
      try {
        const result = await api.post<{ message: Message }>(`/api/conversations/${conversation.id}/messages`, { clientMessageId, body });
        setMessages((current) => (current.some((m) => m.id === result.message.id) ? current : [...current, result.message]));
        setQueued((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
      } catch {
        /* stays queued until the socket returns */
      } finally {
        setSending(false);
      }
      return;
    }

    try {
      const response = await realtime.request<{ data: { message: Message } }>({
        t: 'message.send',
        rid: newRequestId('msg'),
        clientMessageId,
        conversationId: conversation.id,
        body,
      });
      setMessages((current) => (current.some((m) => m.id === response.data.message.id) ? current : [...current, response.data.message]));
    } catch {
      try {
        const result = await api.post<{ message: Message }>(`/api/conversations/${conversation.id}/messages`, { clientMessageId, body });
        setMessages((current) => (current.some((m) => m.id === result.message.id) ? current : [...current, result.message]));
      } catch {
        setQueued((current) => [...current, { clientMessageId, body, createdAt: new Date().toISOString() }]);
        Alert.alert('لم تُرسل', 'الرسالة محفوظة محلياً وستُرسل عند عودة الاتصال.');
      }
    } finally {
      setSending(false);
    }
  }

  const rows = useMemo(
    () =>
      [
        ...messages,
        ...queued.map((item) => ({
          id: `queued-${item.clientMessageId}`,
          conversationId: conversation.id,
          clientMessageId: item.clientMessageId,
          body: item.body,
          type: 'text',
          createdAt: item.createdAt,
          editedAt: null,
          deletedAt: null,
          attachments: [] as Message['attachments'],
          state: 'sent' as const,
          sender: viewer ? { id: viewer.id, username: viewer.username, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl } : null,
        })),
      ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages, queued, conversation.id, viewer],
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.surface }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: theme.border }}>
        <Pressable onPress={onBack} accessibilityLabel="رجوع">
          <Text style={{ color: theme.accent, fontSize: 20 }}>←</Text>
        </Pressable>
        <Avatar name={conversation.title ?? 'محادثة'} size={38} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontWeight: '700' }} numberOfLines={1}>
            {conversation.title ?? 'محادثة'}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 11 }}>
            {conversation.type === 'direct' ? 'محادثة فردية' : `${conversation.memberCount} عضو`}
            {conversation.isEncrypted ? ' · مشفّرة طرفياً' : ''}
          </Text>
        </View>
      </View>

      <ConnectionBanner state={connection} />

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            const mine = item.sender?.id === viewer?.id;
            return (
              <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', gap: 2 }}>
                {!mine && item.sender ? (
                  <Text style={{ color: theme.textMuted, fontSize: 11 }}>{item.sender.displayName}</Text>
                ) : null}
                <View
                  style={{
                    backgroundColor: mine ? theme.bubbleOut : theme.bubbleIn,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    borderRadius: 16,
                  }}
                >
                  <Text style={{ color: mine ? theme.bubbleOutText : theme.bubbleInText }}>
                    {item.deletedAt ? 'حُذفت هذه الرسالة' : item.body}
                  </Text>
                  {item.attachments.length > 0 && (
                    <Text style={{ color: mine ? theme.bubbleOutText : theme.bubbleInText, fontSize: typography.caption.fontSize }}>
                      📎 {item.attachments.map((a) => a.fileName).join('، ')}
                    </Text>
                  )}
                </View>
                <Text style={{ color: theme.textMuted, fontSize: 10, alignSelf: mine ? 'flex-end' : 'flex-start' }}>
                  {formatTime(item.createdAt)}
                  {item.editedAt ? ' · عُدّلت' : ''}
                  {mine ? ` · ${item.state === 'read' ? 'قُرئت' : item.state === 'delivered' ? 'وصلت' : item.id.startsWith('queued-') ? 'بالانتظار' : 'أُرسلت'}` : ''}
                </Text>
              </View>
            );
          }}
        />
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, padding: spacing.md, borderTopWidth: 1, borderTopColor: theme.border }}>
        <TextInput
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 12,
            paddingHorizontal: spacing.md,
            color: theme.text,
            backgroundColor: theme.surfaceRaised,
          }}
          value={text}
          onChangeText={setText}
          placeholder="اكتب رسالة…"
          placeholderTextColor={theme.textMuted}
          multiline
          accessibilityLabel="نص الرسالة"
        />
        <Button title="إرسال" onPress={() => void send()} loading={sending} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}
