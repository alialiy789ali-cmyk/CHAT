/**
 * The screen shown when something threw instead of the app closing.
 *
 * A released app that closes itself tells the user nothing: no message, no way to report, and no hint
 * whether it will happen again. This boundary replaces that with the actual error, a way to retry, and
 * a stable log tag to quote when asking for help — while making clear that nothing was sent anywhere.
 *
 * It catches render and effect errors (and anything the global handler forwards through
 * `crash-report.ts`). It does *not* pretend to recover the broken feature: "إعادة المحاولة" re-mounts
 * the tree, which is honest about being a retry rather than a fix.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { lastFatal, onFatal, reportFatal, type FatalReport } from '../lib/crash-report';
import { spacing } from '../lib/theme';

interface Props {
  children: ReactNode;
}

interface State {
  report: FatalReport | null;
  /** Bumped on retry so the subtree is rebuilt instead of reusing broken state. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { report: null, attempt: 0 };
  private unsubscribe: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { report: reportFatal(error, true) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The component stack is the useful half of a render error; keep it in the log.
    console.error('[SovereignCrash] component stack', info.componentStack ?? '');
  }

  componentDidMount(): void {
    // Errors raised outside React (timers, sockets, native callbacks) arrive asynchronously.
    this.unsubscribe = onFatal((report) => {
      if (!report.fromReact) this.setState({ report });
    });
    const missed = lastFatal();
    if (missed) this.setState({ report: missed });
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
  }

  render(): ReactNode {
    const { report } = this.state;
    if (!report) return this.props.children;
    return (
      <View style={styles.container} key={this.state.attempt}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>حدث خطأ غير متوقع</Text>
          <Text style={styles.body}>
            التطبيق منع إغلاق نفسه كي تخبرنا بما حدث. لم يُرسل أي شيء إلى الخادم، وهذه التفاصيل بقيت على
            جهازك فقط.
          </Text>
          <View style={styles.card}>
            <Text style={styles.mono}>{report.message}</Text>
            {report.stack ? (
              <Text style={[styles.mono, styles.stack]} numberOfLines={12}>
                {report.stack}
              </Text>
            ) : null}
            <Text style={styles.meta}>
              {report.at} · {report.fromReact ? 'react' : 'global'}
            </Text>
          </View>
          <Text style={styles.hint}>
            لإرسال التقرير: وصّل الجهاز بالحاسوب ونفّذ
            {'\n'}
            adb logcat -s SovereignCrash
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ report: null, attempt: this.state.attempt + 1 })}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

/**
 * The palette is read from the same tokens the rest of the app uses, but without the theme hook: a
 * boundary found in the render tree cannot assume the providers above it are mounted, and the crash
 * screen must render even when the thing that broke was a theme or a context.
 */
const palette = {
  background: '#0d1117',
  surface: '#151b23',
  border: '#262d38',
  text: '#e8edf4',
  muted: '#9aa6b8',
  accent: '#5b8bf7',
  danger: '#ff6b6b',
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  content: { gap: spacing.md, padding: spacing.lg, paddingVertical: spacing.xl },
  title: { fontSize: 22, fontWeight: '800', color: palette.text },
  body: { fontSize: 14, color: palette.muted, lineHeight: 22 },
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  mono: { fontSize: 13, color: palette.danger, fontWeight: '600' },
  stack: { fontSize: 11, color: palette.muted, fontWeight: '400' },
  meta: { fontSize: 11, color: palette.muted },
  hint: { fontSize: 12, color: palette.muted, lineHeight: 18 },
  button: {
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: palette.accent,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
