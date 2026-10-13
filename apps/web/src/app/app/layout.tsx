'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { Avatar, Spinner } from '@/components/ui';
import { useT, setLocale, LOCALES } from '@/lib/i18n';
import { api } from '@/lib/api';

/**
 * Application shell: navigation, connection indicator, account menu.
 * Protected: anonymous visitors are redirected to the login page.
 */

const NAV = [
  { href: '/app', key: 'chats', icon: '💬' },
  { href: '/app/feed', key: 'timeline', icon: '🌐' },
  { href: '/app/channels', key: 'channels', icon: '📣' },
  { href: '/app/notifications', key: 'notifications', icon: '🔔' },
  { href: '/app/settings', key: 'settings', icon: '⚙️' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { viewer, status, connection, logout, updateViewer } = useSession();
  const tr = useT();
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  // Badge with unread notifications, refreshed whenever the route changes.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    api
      .get<{ unread: number }>('/api/notifications?limit=1')
      .then((res) => {
        if (!cancelled) setUnread(res.unread);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status, pathname]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner size={28} />
      </div>
    );
  }
  if (!viewer) return null;

  const connectionLabel =
    connection === 'open' ? tr('online') : connection === 'reconnecting' ? tr('reconnecting') : tr('connecting');

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-2.5 backdrop-blur"
        style={{ borderColor: 'var(--border)', background: 'color-mix(in oklab, var(--surface) 88%, transparent)' }}
      >
        <Link href="/app" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-bold text-white">س</span>
          <span className="hidden font-bold sm:block">{tr('appName')}</span>
        </Link>

        <nav className="scroll-area flex flex-1 items-center gap-1 overflow-x-auto" aria-label="main">
          {NAV.map((item) => {
            const active = item.href === '/app' ? pathname === '/app' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition"
                style={active ? { background: 'var(--surface-raised)', boxShadow: '0 1px 2px rgb(0 0 0 / 0.06)' } : { color: 'var(--text-muted)' }}
              >
                <span aria-hidden>{item.icon}</span>
                <span className="hidden sm:inline">{tr(item.key)}</span>
                {item.key === 'notifications' && unread > 0 && (
                  <span className="ms-1 rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">{unread}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <span
          className="hidden items-center gap-1.5 text-xs sm:flex"
          style={{ color: connection === 'open' ? 'var(--success)' : 'var(--text-muted)' }}
          title={connectionLabel}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: 'currentColor' }} />
          {connectionLabel}
        </span>

        <select
          aria-label={tr('language')}
          className="input w-auto px-2 py-1 text-xs"
          value={viewer.locale}
          onChange={async (event) => {
            const locale = event.target.value as 'ar' | 'en';
            setLocale(locale);
            updateViewer({ locale });
            await api.patch('/api/users/me', { locale }).catch(() => {});
            router.refresh();
          }}
        >
          {LOCALES.map((locale) => (
            <option key={locale.id} value={locale.id}>
              {locale.label}
            </option>
          ))}
        </select>

        <Link href={`/app/profile/${viewer.username}`} aria-label={tr('profile')}>
          <Avatar name={viewer.displayName} src={viewer.avatarUrl} size={32} />
        </Link>

        <button
          className="btn btn-ghost px-2 py-1 text-xs"
          onClick={() => {
            void logout();
          }}
        >
          {tr('logout')}
        </button>
      </header>

      {!viewer.emailVerified && (
        <p className="px-4 py-2 text-center text-xs" style={{ background: 'color-mix(in oklab, var(--accent) 12%, transparent)' }}>
          {tr('verifiedEmailHint')}
        </p>
      )}

      <main className="flex-1">{children}</main>
    </div>
  );
}
