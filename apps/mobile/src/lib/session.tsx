import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { realtime, type ConnectionState } from './realtime';

/** Authentication + viewer state for the whole app (same shapes as the web client). */

export interface Viewer {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  bio: string | null;
  role: 'user' | 'moderator' | 'admin';
  isVerified: boolean;
  /** Server-reported E2EE readiness; false until phase 5 ships, so the UI never over-claims. */
  e2eeReady: boolean;
  locale: 'ar' | 'en';
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

interface SessionValue {
  viewer: Viewer | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  connection: ConnectionState;
  login: (identifier: string, password: string, totp?: string) => Promise<void>;
  register: (input: { username: string; email: string; password: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshViewer: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  const [connection, setConnection] = useState<ConnectionState>('closed');

  const refreshViewer = useCallback(async () => {
    const me = await api.get<Viewer>('/api/users/me');
    setViewer(me);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await api.restoreSession();
      if (cancelled) return;
      if (!restored) {
        setStatus('anonymous');
        return;
      }
      try {
        await refreshViewer();
      } catch {
        setStatus('anonymous');
      }
    })();
    const off = api.onUnauthorized(() => {
      setStatus('anonymous');
      setViewer(null);
      realtime.close();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [refreshViewer]);

  useEffect(() => {
    const off = realtime.onState(setConnection);
    if (status === 'authenticated') void realtime.connect();
    if (status === 'anonymous') realtime.close();
    return () => {
      off();
    };
  }, [status]);

  const login = useCallback(
    async (identifier: string, password: string, totp?: string) => {
      const result = await api.post<{ accessToken: string; refreshToken: string }>('/api/auth/login', {
        identifier,
        password,
        totp,
        device: { name: 'Sovereign mobile', platform: 'mobile' },
      });
      await api.setTokens(result.accessToken, result.refreshToken);
      await refreshViewer();
    },
    [refreshViewer],
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string; displayName?: string }) => {
      const result = await api.post<{ accessToken: string; refreshToken: string }>('/api/auth/register', {
        ...input,
        username: input.username.toLowerCase(),
        email: input.email.toLowerCase(),
        device: { name: 'Sovereign mobile', platform: 'mobile' },
      });
      await api.setTokens(result.accessToken, result.refreshToken);
      await refreshViewer();
    },
    [refreshViewer],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout', {}).catch(() => {});
    realtime.close();
    await api.clearTokens();
    setViewer(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ viewer, status, connection, login, register, logout, refreshViewer }),
    [viewer, status, connection, login, register, logout, refreshViewer],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

export function describeAuthError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'totp_required':
        return 'أدخل رمز التحقق من تطبيق المصادقة.';
      case 'invalid_credentials':
        return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
      case 'rate_limited':
        return 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.';
      case 'network_unreachable':
        return error.message;
      case 'username_taken':
        return 'اسم المستخدم محجوز.';
      case 'email_taken':
        return 'البريد الإلكتروني مستخدم بالفعل.';
      case 'validation_error':
        return 'تحقق من صحة الحقول المدخلة.';
      default:
        return error.message;
    }
  }
  return 'حدث خطأ غير متوقع.';
}
