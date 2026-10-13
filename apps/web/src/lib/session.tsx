'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from './api';
import { realtime, type ConnectionState } from './realtime';
import { setLocale, type Locale } from './i18n';
import { invalidateMediaToken } from '@/lib/media';

/**
 * Session provider: owns authentication state, the realtime connection lifecycle and
 * the viewer's own profile. Every page reads state from here instead of refetching,
 * which keeps the UI consistent (e.g. a rename is reflected everywhere at once).
 */

export interface Viewer {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  bio: string | null;
  role: 'user' | 'moderator' | 'admin';
  locale: Locale;
  theme: 'light' | 'dark' | 'system';
  twoFactorEnabled: boolean;
  privacy: {
    whoCanMessage: 'everyone' | 'contacts' | 'nobody';
    whoCanSeeProfile: 'everyone' | 'followers' | 'nobody';
    readReceipts: boolean;
    showOnlineStatus: boolean;
  };
  stats: { followers: number; following: number; posts: number };
}

interface SessionContextValue {
  viewer: Viewer | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  connection: ConnectionState;
  login: (identifier: string, password: string, totp?: string) => Promise<void>;
  register: (input: { username: string; email: string; password: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshViewer: () => Promise<void>;
  updateViewer: (patch: Partial<Viewer>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'anonymous'>('loading');
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const router = useRouter();

  const refreshViewer = useCallback(async () => {
    try {
      const me = await api.get<Viewer>('/api/users/me');
      setViewer(me);
      setStatus('authenticated');
      setLocale(me.locale ?? 'ar');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setViewer(null);
        setStatus('anonymous');
        return;
      }
      throw err;
    }
  }, []);

  // Restore the session on first paint using the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await api.bootstrap();
      if (cancelled) return;
      if (!restored) {
        setStatus('anonymous');
        return;
      }
      await refreshViewer().catch(() => setStatus('anonymous'));
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshViewer]);

  // Keep the realtime connection aligned with the authentication state.
  useEffect(() => {
    const off = realtime.onState(setConnection);
    if (status === 'authenticated') void realtime.connect();
    if (status === 'anonymous') realtime.close();
    return () => {
      off();
    };
  }, [status]);

  // Apply theme + text direction to the document.
  useEffect(() => {
    const root = document.documentElement;
    const theme = viewer?.theme ?? 'system';
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = theme === 'dark' || (theme === 'system' && prefersDark);
    root.classList.toggle('dark', dark);
    root.lang = viewer?.locale ?? 'ar';
    root.dir = (viewer?.locale ?? 'ar') === 'ar' ? 'rtl' : 'ltr';
  }, [viewer?.theme, viewer?.locale]);

  const login = useCallback(
    async (identifier: string, password: string, totp?: string) => {
      await api.login(identifier, password, totp);
      await refreshViewer();
      router.push('/app');
    },
    [refreshViewer, router],
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string; displayName?: string }) => {
      await api.register(input);
      await refreshViewer();
      router.push('/app');
    },
    [refreshViewer, router],
  );

  const logout = useCallback(async () => {
    await api.logout();
    // Media URLs carry a token minted for the session we just ended.
    invalidateMediaToken();
    realtime.close();
    setViewer(null);
    setStatus('anonymous');
    router.push('/login');
  }, [router]);

  const updateViewer = useCallback((patch: Partial<Viewer>) => {
    setViewer((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const value = useMemo(
    () => ({ viewer, status, connection, login, register, logout, refreshViewer, updateViewer }),
    [viewer, status, connection, login, register, logout, refreshViewer, updateViewer],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
