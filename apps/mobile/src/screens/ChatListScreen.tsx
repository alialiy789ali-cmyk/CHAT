import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { Avatar, Badge, ConnectionBanner, EmptyState } from '../components/ui';
import { formatTime, spacing, typography, useTheme } from '../lib/theme';

export interface Conversation {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
  avatarUrl: string | null;
  peerUsername: string | null;
  memberCount: number;
  unreadCount: number;
  isEncrypted: boolean;
  myRole: string | null;
  lastMessage: { id: string; body: string | null; type: string; isMine: boolean } | null;
  lastMessageAt: string | null;
}

/** Conversation list. Live updates arrive over the socket; pull-to-refresh is a real re-fetch. */
export function ChatListScreen({ onOpenConversation }: { onOpenConversation: (conversation: Conversation) => void }) {
  const theme = useTheme();
  const { connection, viewer } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ items: Conversation[] }>('/api/conversations');
      setConversations(result.items);
      setError(null);
    } catch {
      setError('تعذّر تحميل المحادثات — تحقق من الاتصال بالخادم.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const off = realtime.onFrame((frame) => {
      if (frame.t === 'message' || frame.t === 'message.updated') {
        setConversations((current) => {
          const index = current.findIndex((conversation) => conversation.id === frame.conversationId);
          if (index === -1) {
            void load();
            return current;
          }
          const message = (frame as { message?: { id: string; body: string | null; type: string; createdAt: string; sender?: { id: string } } }).message;
          const updated: Conversation = {
            ...current[index],
            lastMessage: message ? { id: message.id, body: message.body, type: message.type, isMine: message.sender?.id === viewer?.id } : current[index].lastMessage,
            lastMessageAt: message?.createdAt ?? current[index].lastMessageAt,
            unreadCount:
              frame.t === 'message' && message?.sender?.id !== viewer?.id
                ? current[index].unreadCount + 1
                : current[index].unreadCount,
          };
          return [updated, ...current.filter((_, i) => i !== index)];
        });
      }
      if (frame.t === 'conversation.updated') void load();
    });
    return () => {
      off();
    };
  }, [load, viewer?.id]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.surface }}>
      <ConnectionBanner state={connection} />
      {error ? (
        <Text style={{ color: theme.danger, padding: spacing.md, textAlign: 'center' }} onPress={() => void load()}>
          {error} — اضغط لإعادة المحاولة
        </Text>
      ) : null}
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={theme.accent} />}
        ListEmptyComponent={loading ? null : <EmptyState title="لا محادثات بعد" description="ابدأ محادثة من صفحة المستخدم أو من الشبكة الاجتماعية." icon="💬" />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenConversation(item)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              padding: spacing.md,
              backgroundColor: pressed ? theme.surfaceSunken : 'transparent',
              borderBottomWidth: 1,
              borderBottomColor: theme.border,
            })}
          >
            <Avatar name={item.title ?? 'محادثة'} size={46} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text style={{ color: theme.text, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                  {item.title ?? 'محادثة'}
                </Text>
                {item.type === 'group' ? <Badge label={`${item.memberCount}`} /> : null}
                {item.isEncrypted ? <Badge label="E2EE" tone="brand" /> : null}
              </View>
              <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }} numberOfLines={1}>
                {item.lastMessage?.isMine ? 'أنت: ' : ''}
                {item.lastMessage?.body ?? 'لا رسائل بعد'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: spacing.xs }}>
              {item.lastMessageAt ? (
                <Text style={{ color: theme.textMuted, fontSize: 11 }}>{formatTime(item.lastMessageAt)}</Text>
              ) : null}
              {item.unreadCount > 0 ? <Badge label={String(item.unreadCount)} tone="brand" /> : null}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}
