import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, spacing } from './lib/theme';
import { useSession } from './lib/session';
import { LoginScreen, RegisterScreen } from './screens/AuthScreens';
import { ChatListScreen, type Conversation } from './screens/ChatListScreen';
import { ChatScreen } from './screens/ChatScreen';
import { FeedScreen } from './screens/FeedScreen';
import { SettingsScreen } from './screens/SettingsScreen';

/**
 * Navigation.
 *
 * Deliberately dependency-free: a tab bar plus a modal-style stack for the message thread.
 * This keeps the native dependency surface small (no gesture-handler/reanimated needed to
 * build the app) — swapping in @react-navigation later is a drop-in change because every
 * screen already receives its navigation needs through props.
 */

type Tab = 'chats' | 'feed' | 'settings';

export function Root() {
  const theme = useTheme();
  const { status, viewer } = useSession();
  const [showRegister, setShowRegister] = useState(false);
  const [tab, setTab] = useState<Tab>('chats');
  const [openConversation, setOpenConversation] = useState<Conversation | null>(null);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surface }}>
        <Text style={{ color: theme.textMuted }}>جارٍ التحقق من الجلسة…</Text>
      </View>
    );
  }

  if (status === 'anonymous' || !viewer) {
    return showRegister ? (
      <RegisterScreen onSwitchToLogin={() => setShowRegister(false)} />
    ) : (
      <LoginScreen onSwitchToRegister={() => setShowRegister(true)} />
    );
  }

  if (openConversation) {
    return <ChatScreen conversation={openConversation} onBack={() => setOpenConversation(null)} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.surface }}>
      <View style={{ flex: 1 }}>
        {tab === 'chats' ? <ChatListScreen onOpenConversation={setOpenConversation} /> : null}
        {tab === 'feed' ? <FeedScreen /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>

      <View
        style={{
          flexDirection: 'row',
          borderTopWidth: 1,
          borderTopColor: theme.border,
          backgroundColor: theme.surfaceRaised,
        }}
      >
        {(
          [
            ['chats', '💬', 'المحادثات'],
            ['feed', '🌐', 'الموجز'],
            ['settings', '⚙️', 'الإعدادات'],
          ] as const
        ).map(([id, icon, label]) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === id }}
            accessibilityLabel={label}
            style={{ flex: 1, alignItems: 'center', paddingVertical: spacing.md, gap: 2 }}
          >
            <Text style={{ fontSize: 18, opacity: tab === id ? 1 : 0.5 }}>{icon}</Text>
            <Text style={{ color: tab === id ? theme.text : theme.textMuted, fontSize: 11 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
