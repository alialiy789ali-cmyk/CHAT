import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, devicePayload } from './api';
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
  /**
   * This phone's device row on the server.
   *
   * E2EE keys are published *per device*, and envelopes are addressed to a device id, so the app
   * needs to know which row is its own before it can encrypt. Null until the session is known.
   */
  deviceId: string | null;
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
  const [deviceId, setDeviceId] = useState<string | null>(null);

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
        // The device row is what the E2EE layer publishes keys for and hears envelopes on.
        try {
          const sessions = await api.get<Array<{ current: boolean; deviceId: string | null }>>('/api/auth/sessions');
          setDeviceId(sessions.find((entry) => entry.current)?.deviceId ?? null);
        } catch {
          setDeviceId(null);
        }
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
      const result = await api.post<{ accessToken: string; refreshToken: string; deviceId: string | null }>(
        '/api/auth/login',
        { identifier, password, totp, device: await devicePayload() },
      );
      await api.setTokens(result.accessToken, result.refreshToken);
      setDeviceId(result.deviceId);
      await refreshViewer();
    },
    [refreshViewer],
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string; displayName?: string }) => {
      const result = await api.post<{ accessToken: string; refreshToken: string; deviceId: string | null }>(
        '/api/auth/register',
        {
          ...input,
          username: input.username.toLowerCase(),
          email: input.email.toLowerCase(),
          device: await devicePayload(),
        },
      );
      await api.setTokens(result.accessToken, result.refreshToken);
      setDeviceId(result.deviceId);
      await refreshViewer();
    },
    [refreshViewer],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout', {}).catch(() => {});
    realtime.close();
    setDeviceId(null);
    await api.clearTokens();
    setViewer(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ viewer, status, connection, deviceId, login, register, logout, refreshViewer }),
    [viewer, status, connection, deviceId, login, register, logout, refreshViewer],
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
