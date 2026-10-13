import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Avatar, Badge, Button, Card, ConnectionBanner, EmptyState } from '../components/ui';
import { formatTime, spacing, typography, useTheme } from '../lib/theme';

interface Post {
  id: string;
  author: { id: string; username: string; displayName: string; avatarUrl: string | null };
  body: string | null;
  visibility: 'public' | 'followers' | 'private';
  media: Array<{ id: string; url: string; mimeType: string; fileName: string; width?: number | null; height?: number | null }>;
  counts: { likes: number; comments: number; reposts: number };
  viewer: { liked: boolean; reposted: boolean; following: boolean; isMine: boolean };
  createdAt: string;
}

/** Timeline: chronological following/for-you tabs with a real composer (POST /api/posts). */
export function FeedScreen() {
  const theme = useTheme();
  const { viewer, connection } = useSession();
  const [tab, setTab] = useState<'following' | 'for-you'>('following');
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [body, setBody] = useState('');
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async (which: 'following' | 'for-you') => {
    try {
      const result = await api.get<{ items: Post[] }>(`/api/feed?tab=${which}&limit=20`);
      setPosts(result.items);
    } catch {
      Alert.alert('تعذّر التحميل', 'تحقق من الاتصال بالخادم.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function publish() {
    const text = body.trim();
    if (!text) return;
    setPublishing(true);
    try {
      const result = await api.post<{ post: Post }>('/api/posts', { body: text, visibility: 'public' });
      setPosts((current) => [result.post, ...current]);
      setBody('');
    } catch {
      Alert.alert('تعذّر النشر', 'حاول مرة أخرى.');
    } finally {
      setPublishing(false);
    }
  }

  async function toggleLike(post: Post) {
    try {
      if (post.viewer.liked) {
        await api.del(`/api/posts/${post.id}/like`);
      } else {
        await api.post(`/api/posts/${post.id}/like`);
      }
      setPosts((current) =>
        current.map((item) =>
          item.id === post.id
            ? {
                ...item,
                viewer: { ...item.viewer, liked: !item.viewer.liked },
                counts: { ...item.counts, likes: item.counts.likes + (item.viewer.liked ? -1 : 1) },
              }
            : item,
        ),
      );
    } catch {
      /* keep the previous state; the next refresh reconciles */
    }
  }

  async function follow(post: Post) {
    try {
      if (post.viewer.following) await api.del(`/api/users/${post.author.username}/follow`);
      else await api.post(`/api/users/${post.author.username}/follow`);
      setPosts((current) =>
        current.map((item) => (item.author.id === post.author.id ? { ...item, viewer: { ...item.viewer, following: !post.viewer.following } } : item)),
      );
    } catch {
      /* ignore */
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.surface }}>
      <ConnectionBanner state={connection} />

      <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.md }}>
        {(['following', 'for-you'] as const).map((id) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === id }}
            style={{
              flex: 1,
              paddingVertical: spacing.sm,
              borderRadius: 12,
              backgroundColor: tab === id ? theme.surfaceRaised : theme.surfaceSunken,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: tab === id ? theme.text : theme.textMuted, fontWeight: '600' }}>
              {id === 'following' ? 'المتابَعون' : 'لك'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Card style={{ marginHorizontal: spacing.md }}>
        <TextInput
          style={{ color: theme.text, minHeight: 44 }}
          value={body}
          onChangeText={setBody}
          placeholder="ماذا يحدث؟"
          placeholderTextColor={theme.textMuted}
          multiline
          maxLength={5000}
          accessibilityLabel="نص المنشور"
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }}>{body.length}/5000</Text>
          <Button title="نشر" onPress={() => void publish()} loading={publishing} disabled={!body.trim()} />
        </View>
      </Card>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(tab); }} tintColor={theme.accent} />}
          ListEmptyComponent={<EmptyState title="لا منشورات" description="تابع مستخدمين آخرين أو انشر أول تحديث." icon="🌐" />}
          renderItem={({ item }) => (
            <Card style={{ margin: spacing.md, marginBottom: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Avatar name={item.author.displayName} src={item.author.avatarUrl} size={38} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '700' }} numberOfLines={1}>
                    {item.author.displayName}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: 11 }}>
                    @{item.author.username} · {formatTime(item.createdAt)}
                  </Text>
                </View>
                {item.visibility !== 'public' ? <Badge label={item.visibility === 'followers' ? 'متابعون' : 'خاص'} /> : null}
              </View>

              {item.body ? <Text style={{ color: theme.text }}>{item.body}</Text> : null}
              {item.media.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                  {item.media.slice(0, 4).map((media) =>
                    media.mimeType.startsWith('image/') ? (
                      <Image
                        key={media.id}
                        source={api.mediaSource(media.url)}
                        accessibilityLabel={media.fileName}
                        style={{ width: 140, height: 140, borderRadius: 12 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <Text key={media.id} style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }}>
                        📎 {media.fileName}
                      </Text>
                    ),
                  )}
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                <Pressable onPress={() => void toggleLike(item)} accessibilityRole="button" accessibilityLabel="إعجاب">
                  <Text style={{ color: item.viewer.liked ? theme.danger : theme.textMuted }}>
                    {item.viewer.liked ? '❤️' : '🤍'} {item.counts.likes}
                  </Text>
                </Pressable>
                <Text style={{ color: theme.textMuted }}>💬 {item.counts.comments}</Text>
                <Text style={{ color: theme.textMuted }}>🔁 {item.counts.reposts}</Text>
                {!item.viewer.isMine ? (
                  <Pressable onPress={() => void follow(item)} accessibilityRole="button" accessibilityLabel="متابعة">
                    <Text style={{ color: theme.accent }}>{item.viewer.following ? 'إلغاء المتابعة' : 'متابعة'}</Text>
                  </Pressable>
                ) : (
                  <Text style={{ color: theme.textMuted, fontSize: 11 }}>منشورك</Text>
                )}
              </View>
            </Card>
          )}
        />
      )}
    </View>
  );
}
