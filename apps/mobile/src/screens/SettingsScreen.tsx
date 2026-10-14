import { useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Card, Field, Screen } from '../components/ui';
import { spacing, typography, useTheme } from '../lib/theme';

/** Account settings: profile, privacy switches, sessions/devices, export and deletion. */
export function SettingsScreen() {
  const theme = useTheme();
  const { viewer: currentViewer, logout, refreshViewer } = useSession();
  const viewer = currentViewer;
  const [displayName, setDisplayName] = useState(viewer?.displayName ?? '');
  const [bio, setBio] = useState(viewer?.bio ?? '');
  const [sessions, setSessions] = useState<Array<{ id: string; deviceName: string | null; ip: string | null; current: boolean }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .get<typeof sessions>('/api/auth/sessions')
      .then(setSessions)
      .catch(() => {});
  }, []);

  if (!viewer) return null;

  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/users/me', { displayName, bio });
      await refreshViewer();
      Alert.alert('تم الحفظ', 'تم تحديث ملفك الشخصي.');
    } catch {
      Alert.alert('تعذّر الحفظ', 'تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSaving(false);
    }
  }

  async function updatePrivacy(patch: Partial<NonNullable<typeof viewer>['privacy']>) {
    try {
      await api.patch('/api/users/me/privacy', patch);
      await refreshViewer();
    } catch {
      Alert.alert('تعذّر الحفظ', 'لم يتم تحديث إعدادات الخصوصية.');
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: spacing.lg, paddingBottom: spacing.xl }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800' }}>الإعدادات</Text>

        <Card>
          <Text style={{ color: theme.text, fontWeight: '700' }}>الملف الشخصي</Text>
          <Field label="الاسم الظاهر" value={displayName} onChangeText={setDisplayName} maxLength={60} />
          <Field label="نبذة" value={bio} onChangeText={setBio} maxLength={280} multiline hint={`${bio.length}/280`} />
          <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }}>@{viewer.username} · {viewer.email}</Text>
          <Button title="حفظ" onPress={() => void save()} loading={saving} />
        </Card>

        <Card>
          <Text style={{ color: theme.text, fontWeight: '700' }}>الخصوصية</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.text }}>إشعارات القراءة</Text>
            <Switch value={viewer.privacy.readReceipts} onValueChange={(value) => void updatePrivacy({ readReceipts: value })} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.text }}>إظهار حالة الاتصال</Text>
            <Switch value={viewer.privacy.showOnlineStatus} onValueChange={(value) => void updatePrivacy({ showOnlineStatus: value })} />
          </View>
          <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }}>
            من يمكنه مراسلتك: {viewer.privacy.whoCanMessage === 'everyone' ? 'الجميع' : viewer.privacy.whoCanMessage === 'contacts' ? 'المتابَعة المتبادلة' : 'لا أحد'}
          </Text>
        </Card>

        <Card>
          <Text style={{ color: theme.text, fontWeight: '700' }}>الأجهزة والجلسات</Text>
          {sessions.map((session) => (
            <View key={session.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: theme.text, flexShrink: 1 }}>
                {session.deviceName ?? 'جهاز'} {session.current ? '· هذه الجلسة' : ''}
              </Text>
              {!session.current ? (
                <Button
                  title="إلغاء"
                  variant="ghost"
                  onPress={async () => {
                    await api.del(`/api/auth/sessions/${session.id}`).catch(() => {});
                    setSessions((current) => current.filter((item) => item.id !== session.id));
                  }}
                />
              ) : null}
            </View>
          ))}
        </Card>

        <Card>
          <Text style={{ color: theme.text, fontWeight: '700' }}>بياناتي</Text>
          <Button
            title="تصدير بياناتي (JSON)"
            variant="ghost"
            onPress={async () => {
              try {
                const data = await api.get<unknown>('/api/users/me/export');
                Alert.alert('تم التحضير', `حجم التصدير: ${JSON.stringify(data).length} حرف. استخدم تطبيق الويب لتنزيله كملف.`);
              } catch {
                Alert.alert('تعذّر التصدير', 'حاول مرة أخرى.');
              }
            }}
          />
          <Button title="تسجيل الخروج" variant="danger" onPress={() => void logout()} />
        </Card>

        <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize, textAlign: 'center' }}>
          سيادي 0.1.0 — رخصة AGPL-3.0 · الرسائل محمية أثناء النقل (TLS) وتُخزَّن على خادمك؛ التشفير الطرفي قيد التنفيذ.
        </Text>
      </ScrollView>
    </Screen>
  );
}
