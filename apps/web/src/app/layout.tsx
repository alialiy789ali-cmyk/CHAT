import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { E2eeProvider } from '@/lib/e2ee/context';

export const metadata: Metadata = {
  title: 'سيادي · Sovereign',
  description:
    'منصة تواصل سيادية قابلة للاستضافة الذاتية: مراسلة فورية، قنوات، شبكة اجتماعية، ومكالمات صوتية ومرئية.',
  applicationName: 'Sovereign',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-[var(--surface-raised)] focus:px-3 focus:py-2"
        >
          تخطَّ إلى المحتوى
        </a>
        <SessionProvider>
          {/* E2EE depends on the session (user + device), so it nests inside it. */}
          <E2eeProvider>
            <div id="main">{children}</div>
          </E2eeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
