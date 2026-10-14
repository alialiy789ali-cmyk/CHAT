import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { I18nManager, StyleSheet, View } from 'react-native';
import { SessionProvider } from './src/lib/session';
import { E2eeProvider } from './src/lib/e2ee/provider';
import { Root } from './src/navigation';
import { useTheme } from './src/lib/theme';

/**
 * App root.
 *
 * Arabic-first: the UI is written RTL-native (logical props, no hard-coded left/right), so it
 * renders correctly whether or not the platform has RTL forced. `I18nManager` is consulted only
 * to align the few platform-provided components (e.g. switch layout).
 */

function Shell() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Root />
    </SafeAreaView>
  );
}

export default function App() {
  // Read once for diagnostics: whether the platform reports RTL (used by native switches).
  const rtl = I18nManager.isRTL;
  if (__DEV__) {
    console.log(`[sovereign] RTL=${rtl} — layout is direction-agnostic by design`);
  }

  return (
    <SafeAreaProvider>
      <SessionProvider>
        {/* E2EE sits inside the session because keys are per account *and* per device row. */}
        <E2eeProvider>
          <View style={styles.root}>
            <Shell />
          </View>
        </E2eeProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
});
