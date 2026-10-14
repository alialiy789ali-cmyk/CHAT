import { useColorScheme } from 'react-native';

/**
 * Design tokens for the mobile client — the same palette as the web app so the
 * product feels like one platform, with logical (RTL-safe) spacing helpers.
 */

export interface Theme {
  dark: boolean;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentContrast: string;
  danger: string;
  success: string;
  bubbleOut: string;
  bubbleOutText: string;
  bubbleIn: string;
  bubbleInText: string;
}

const light: Theme = {
  dark: false,
  surface: '#f7f8fb',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#eef0f5',
  border: '#dfe3ea',
  text: '#101828',
  textMuted: '#5b6577',
  accent: '#3b6fe0',
  accentContrast: '#ffffff',
  danger: '#d64545',
  success: '#1f9d6b',
  bubbleOut: '#3b6fe0',
  bubbleOutText: '#ffffff',
  bubbleIn: '#eef0f5',
  bubbleInText: '#101828',
};

const dark: Theme = {
  dark: true,
  surface: '#0d1117',
  surfaceRaised: '#151b23',
  surfaceSunken: '#0a0e13',
  border: '#262d38',
  text: '#e8edf4',
  textMuted: '#9aa6b8',
  accent: '#5b8bf7',
  accentContrast: '#06101f',
  danger: '#ff6b6b',
  success: '#34d399',
  bubbleOut: '#2b57ba',
  bubbleOutText: '#f2f6ff',
  bubbleIn: '#1d2530',
  bubbleInText: '#e8edf4',
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Arabic-first typography with system fallbacks for both platforms. */
export const typography = {
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 15 },
  caption: { fontSize: 12 },
};

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'أمس';
  return date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}
