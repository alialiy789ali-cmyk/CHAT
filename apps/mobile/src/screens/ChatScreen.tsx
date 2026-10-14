import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { newClientMessageId, newRequestId, realtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { useE2ee } from '../lib/e2ee/provider';
import { Avatar, Button, ConnectionBanner } from '../components/ui';
import { formatTime, spacing, typography, useTheme } from '../lib/theme';
import type { Conversation } from './ChatListScreen';

interface Message {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  /** Empty for an encrypted message: the server holds ciphertext only. */
  body: string | null;
  /** 'none' or the scheme of the envelopes attached to this row. */
  encryptionScheme?: 'none' | 'libsignal-v1' | 'olm-v1';
  type: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  state: 'sent' | 'delivered' | 'read';
  sender: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  attachments: Array<{ id: string; url: string; mimeType: string; fileName: string; width?: number | null; height?: number | null }>;
}

/**
 * Message thread.
 *
 * Offline behaviour: sending while the socket is down queues the message locally and
 * retries over HTTP, so a dropped connection never silently loses a message.
 *
 * Encrypted conversations take a different path on purpose: the phone encrypts once per
 * recipient device and posts the envelopes over HTTP, because a WebSocket frame reaches every
 * device of every member while each device needs its own ciphertext. A message that cannot be
 * addressed to every member is refused rather than sent as unreadable ciphertext.
 */
export function ChatScreen({ conversation, onBack }: { conversation: Conversation; onBack: () => void }) {
  const theme = useTheme();
  const { viewer, connection } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<Array<{ clientMessageId: string; body: string; createdAt: string }>>([]);
  /** Messages this device could not open, with the reason, so the bubble can say why. */
  const [decryptErrors, setDecryptErrors] = useState<Record<string, string>>({});
  const listRef = useRef<FlatList<Message>>(null);
  const { engine: e2ee, status: e2eeStatus, identityKey, plaintextFor, rememberPlaintext, decryptMessage } = useE2ee();

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

  /**
   * Opens every encrypted message this device has not read yet.
   *
   * The envelope is fetched for *this* device only; a message whose ciphertext cannot be opened is
   * reported instead of being rendered as empty text, because "no key for this device" and "the
   * ciphertext did not authenticate" are different facts and the user should not have to guess.
   */
  useEffect(() => {
    if (e2eeStatus !== 'ready' || !viewer?.id) return;
    const pending = messages.filter(
      (message) =>
        message.encryptionScheme && message.encryptionScheme !== 'none' &&
        message.sender?.id !== viewer.id &&
        plaintextFor(message.id) === null &&
        !decryptErrors[message.id],
    );
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const message of pending) {
        try {
          await decryptMessage({ messageId: message.id, senderUserId: message.sender!.id });
        } catch (cause) {
          if (cancelled) return;
          const reason = cause instanceof Error ? cause.message : String(cause);
          setDecryptErrors((current) => ({ ...current, [message.id]: reason }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, e2eeStatus, viewer?.id, plaintextFor, decryptErrors, decryptMessage]);

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

  /**
   * Sends one encrypted message.
   *
   * Nothing is queued for later on failure: encrypting needs the recipient's current devices and,
   * for a new device, a one-time prekey — all of which must be fetched live. Pretending the message
   * is "pending" while it sits in a queue with a stale ratchet would be worse than saying it failed,
   * so the text stays in the composer and the reason is shown.
   */
  async function sendEncrypted(body: string, clientMessageId: string) {
    if (!e2ee || e2eeStatus !== 'ready') {
      Alert.alert('التشفير غير جاهز', 'لم تُنشر مفاتيح هذا الجهاز بعد، فلا يمكن إرسال رسالة مشفّرة الآن.');
      return;
    }
    setSending(true);
    try {
      const status = await api.get<{
        isEncrypted: boolean;
        ready: boolean;
        participants: Array<{ userId: string; ready: boolean; devicesWithKeys: number }>;
      }>(`/api/conversations/${conversation.id}/encryption`);
      const { envelopes, skipped, unreachable, schemeMismatches } = await e2ee.encryptForConversation(status, body);
      if (skipped.length > 0 || envelopes.length === 0) {
        Alert.alert(
          'تعذّر التشفير لكل الأعضاء',
          `لا يمكن الوصول إلى: ${skipped.map((entry) => entry.reason).join(', ') || 'لا أجهزة قابلة للتوجيه'}. لم تُرسل الرسالة.`,
        );
        return;
      }

      const result = await api.post<{ message: Message }>(`/api/conversations/${conversation.id}/messages`, {
        clientMessageId,
        body: '',
        replyToId: null,
        encryptionScheme: 'libsignal-v1',
        envelopes,
      });
      // This phone keeps its own plaintext: it must not have to decrypt its own message, and the
      // ratchet must not be spent on a device that already holds the text.
      await rememberPlaintext(result.message.id, body);
      setText('');
      setMessages((current) => (current.some((m) => m.id === result.message.id) ? current : [...current, result.message]));
      if (unreachable.length > 0 || schemeMismatches.length > 0) {
        Alert.alert(
          'أُرسلت، لكن ليس لكل الأجهزة',
          `${unreachable.length + schemeMismatches.length} جهازاً لن يقرأ هذه الرسالة (جهاز قديم أو تطبيق بمخطط تشفير آخر).`,
        );
      }
    } catch (cause) {
      Alert.alert('لم تُرسل', cause instanceof Error ? cause.message : 'تعذّر إرسال الرسالة المشفّرة.');
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    const clientMessageId = newClientMessageId();

    // Encrypted conversations never take the socket path: a frame reaches every device of every
    // member, while each device needs its own ciphertext.
    if (conversation.isEncrypted) {
      await sendEncrypted(body, clientMessageId);
      return;
    }

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
          encryptionScheme: 'none' as const,
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
        <Avatar name={conversation.title ?? 'محادثة'} src={conversation.avatarUrl} size={38} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontWeight: '700' }} numberOfLines={1}>
            {conversation.title ?? 'محادثة'}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 11 }}>
            {conversation.type === 'direct' ? 'محادثة فردية' : `${conversation.memberCount} عضو`}
            {conversation.isEncrypted
              ? e2eeStatus === 'ready'
                ? ' · مشفّرة طرفياً (هذا الجهاز جاهز)'
                : e2eeStatus === 'error'
                  ? ' · مشفّرة طرفياً — تعذّر تجهيز هذا الجهاز'
                  : ' · مشفّرة طرفياً — جارٍ تجهيز الجهاز…'
              : ''}
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
            const encrypted = Boolean(item.encryptionScheme && item.encryptionScheme !== 'none');
            // This device's own plaintext (it wrote it, or it decrypted it) — never the server's.
            const readable = plaintextFor(item.id) ?? item.body;
            const unreadable = encrypted && !readable;
            const failed = unreadable && Boolean(decryptErrors[item.id]);
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
                  <Text
                    style={{
                      color: mine ? theme.bubbleOutText : theme.bubbleInText,
                      fontStyle: unreadable ? 'italic' : 'normal',
                    }}
                  >
                    {item.deletedAt
                      ? 'حُذفت هذه الرسالة'
                      : readable ??
                        (failed ? 'تعذّر فك تشفير هذه الرسالة على هذا الجهاز.' : 'جارٍ فك التشفير…')}
                  </Text>
                  {item.attachments.map((attachment) =>
                    attachment.mimeType.startsWith('image/') ? (
                      <Image
                        key={attachment.id}
                        source={api.mediaSource(attachment.url)}
                        accessibilityLabel={attachment.fileName}
                        style={{ width: 200, height: 150, borderRadius: 12, marginTop: spacing.xs }}
                        resizeMode="cover"
                      />
                    ) : (
                      <Text
                        key={attachment.id}
                        style={{ color: mine ? theme.bubbleOutText : theme.bubbleInText, fontSize: typography.caption.fontSize }}
                      >
                        📎 {attachment.fileName}
                      </Text>
                    ),
                  )}
                </View>
                <Text style={{ color: theme.textMuted, fontSize: 10, alignSelf: mine ? 'flex-end' : 'flex-start' }}>
                  {encrypted ? '🔒 ' : ''}
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
