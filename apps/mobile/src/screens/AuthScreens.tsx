import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { Button, Card, Field, Screen } from '../components/ui';
import { describeAuthError, useSession } from '../lib/session';
import { useTheme, typography } from '../lib/theme';

/** Sign-in screen. Mirrors the server policy: identifier + password (+ optional TOTP). */
export function LoginScreen({ onSwitchToRegister }: { onSwitchToRegister: () => void }) {
  const theme = useTheme();
  const { login } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password, needsTotp ? totp : undefined);
    } catch (err) {
      const message = describeAuthError(err);
      if (message.includes('رمز التحقق')) setNeedsTotp(true);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: theme.text, fontSize: 28, fontWeight: '800' }}>سيادي</Text>
        <Text style={{ color: theme.textMuted }}>منصة تواصل على خادمك: مراسلة، قنوات، شبكة اجتماعية، ومكالمات.</Text>

        <Card>
          <Field
            label="اسم المستخدم أو البريد"
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
          />
          <Field label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" />
          {needsTotp && (
            <Field
              label="رمز التحقق بخطوتين"
              value={totp}
              onChangeText={(value) => setTotp(value.replace(/\D/g, ''))}
              keyboardType="number-pad"
              maxLength={6}
              hint="6 أرقام من تطبيق المصادقة"
            />
          )}
          {error ? <Text style={{ color: theme.danger }}>{error}</Text> : null}
          <Button title="تسجيل الدخول" onPress={submit} loading={busy} disabled={!identifier || !password} />
          <Button title="إنشاء حساب جديد" variant="ghost" onPress={onSwitchToRegister} />
        </Card>

        <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize, textAlign: 'center' }}>
          حسابات تجريبية بعد `npm run seed`: layla / Sovereign-Demo-2026
        </Text>
      </ScrollView>
    </Screen>
  );
}

/** Registration screen with the same client-side hints the server enforces. */
export function RegisterScreen({ onSwitchToLogin }: { onSwitchToLogin: () => void }) {
  const theme = useTheme();
  const { register } = useSession();
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usernameError = form.username && !/^[a-z][a-z0-9_]{2,23}$/.test(form.username) ? '3-24 حرفاً تبدأ بحرف، أرقام و_ فقط' : null;
  const passwordError = form.password && (form.password.length < 10 || !/\d/.test(form.password)) ? '10 أحرف على الأقل مع رقم' : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await register({
        username: form.username,
        email: form.email,
        password: form.password,
        displayName: form.displayName || form.username,
      });
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '800' }}>حساب جديد</Text>
        <Card>
          <Field
            label="اسم المستخدم"
            value={form.username}
            onChangeText={(value) => setForm({ ...form, username: value.toLowerCase() })}
            autoCapitalize="none"
            error={usernameError}
          />
          <Field label="الاسم الظاهر" value={form.displayName} onChangeText={(value) => setForm({ ...form, displayName: value })} />
          <Field label="البريد الإلكتروني" value={form.email} onChangeText={(value) => setForm({ ...form, email: value })} keyboardType="email-address" autoCapitalize="none" />
          <Field label="كلمة المرور" value={form.password} onChangeText={(value) => setForm({ ...form, password: value })} secureTextEntry error={passwordError} />
          {error ? <Text style={{ color: theme.danger }}>{error}</Text> : null}
          <Button title="إنشاء الحساب" onPress={submit} loading={busy} disabled={Boolean(usernameError || passwordError) || !form.email} />
          <Button title="لدي حساب بالفعل" variant="ghost" onPress={onSwitchToLogin} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
