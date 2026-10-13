import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { spacing, typography, useTheme, type Theme } from '../lib/theme';

/** Minimal, accessible primitives shared by every screen (RTL-safe). */

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const theme = useTheme();
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.accent + '22' },
      ]}
    >
      <Text style={{ color: theme.accent, fontWeight: '700', fontSize: size * 0.4 }}>{initials || '؟'}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const palette = {
    primary: { backgroundColor: theme.accent, borderColor: 'transparent', color: theme.accentContrast },
    ghost: { backgroundColor: 'transparent', borderColor: theme.border, color: theme.text },
    danger: { backgroundColor: theme.danger, borderColor: 'transparent', color: '#fff' },
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={palette.color} /> : <Text style={{ color: palette.color, fontWeight: '600' }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const theme = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: theme.text, fontWeight: '600' }}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={theme.textMuted}
        style={[
          styles.input,
          { backgroundColor: theme.surfaceRaised, borderColor: error ? theme.danger : theme.border, color: theme.text },
          props.style as ViewStyle,
        ]}
      />
      {hint && !error ? <Text style={{ color: theme.textMuted, fontSize: typography.caption.fontSize }}>{hint}</Text> : null}
      {error ? <Text style={{ color: theme.danger, fontSize: typography.caption.fontSize }}>{error}</Text> : null}
    </View>
  );
}

export function Screen({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <View style={{ flex: 1, backgroundColor: theme.surface, padding: spacing.lg }}>{children}</View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }, style]}>{children}</View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'brand' | 'success' | 'danger' }) {
  const theme = useTheme();
  const color = { neutral: theme.textMuted, brand: theme.accent, success: theme.success, danger: theme.danger }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: string }) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: spacing.sm, padding: spacing.xl }}>
      {icon ? <Text style={{ fontSize: 28 }}>{icon}</Text> : null}
      <Text style={{ color: theme.text, fontWeight: '700' }}>{title}</Text>
      {description ? <Text style={{ color: theme.textMuted, textAlign: 'center' }}>{description}</Text> : null}
    </View>
  );
}

export function ConnectionBanner({ state }: { state: 'connecting' | 'open' | 'closed' | 'reconnecting' }) {
  const theme = useTheme();
  if (state === 'open') return null;
  const text = state === 'reconnecting' ? 'إعادة الاتصال…' : state === 'connecting' ? 'جارٍ الاتصال…' : 'غير متصل — تُحفظ رسائلك وتُرسل عند العودة';
  return (
    <View style={{ backgroundColor: theme.surfaceSunken, paddingVertical: spacing.xs }}>
      <Text style={{ color: theme.textMuted, textAlign: 'center', fontSize: 12 }}>{text}</Text>
    </View>
  );
}

export function themeStyle(theme: Theme): ViewStyle {
  return { backgroundColor: theme.surface };
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  button: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: spacing.md, minHeight: 44 },
  card: { borderWidth: 1, borderRadius: 16, padding: spacing.lg, gap: spacing.sm },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' },
});
