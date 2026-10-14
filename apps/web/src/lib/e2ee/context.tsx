'use client';

/**
 * React binding for the E2EE engine.
 *
 * The engine is created once per authenticated device and shared through context, because an Olm
 * account is stateful: two components each loading their own copy would fork the ratchet and make
 * messages undecryptable. Setup failures are surfaced as data rather than thrown, so a browser
 * without the needed APIs degrades to a clear explanation instead of a broken page.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { E2eeEngine, type E2eeStatus } from './engine';
import { e2eeStorageAvailable } from './store';

interface E2eeContextValue {
  /** Null until the device is resolved (or when the viewer is anonymous). */
  status: E2eeStatus | null;
  engine: E2eeEngine | null;
  /** Human-readable reason setup failed, translated by the caller. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const E2eeContext = createContext<E2eeContextValue>({
  status: null,
  engine: null,
  error: null,
  loading: false,
  refresh: async () => {},
});

/**
 * Resolves which device this browser session is, by asking the API for the caller's sessions and
 * taking the one flagged `current`. The device id is what ties the local Olm account to the key
 * material the server publishes for it.
 */
async function currentDeviceId(): Promise<string | null> {
  // The endpoint answers with a bare array of the caller's sessions, one of which is this one.
  const sessions = await api.get<Array<{ id: string; deviceId: string | null; current: boolean }>>('/api/auth/sessions');
  return sessions.find((session) => session.current)?.deviceId ?? null;
}

export function E2eeProvider({ children }: { children: ReactNode }) {
  const { viewer, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<E2eeStatus | null>(null);
  const [engine, setEngine] = useState<E2eeEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Guards against a second setup run overlapping the first (StrictMode does this in dev). */
  const startingFor = useRef<string | null>(null);

  const setup = useCallback(async () => {
    if (sessionStatus !== 'authenticated' || !viewer) return;
    if (!e2eeStorageAvailable()) {
      setError('e2ee_unsupported_browser');
      return;
    }
    const deviceId = await currentDeviceId();
    if (!deviceId) {
      setError('e2ee_no_device_for_session');
      return;
    }
    const key = `${viewer.id}:${deviceId}`;
    if (startingFor.current === key) return;
    startingFor.current = key;
    setLoading(true);
    try {
      const created = await E2eeEngine.create(viewer.id, deviceId);
      setEngine(created);
      setStatus(created.status());
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'e2ee_setup_failed';
      setError(message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [sessionStatus, viewer]);

  useEffect(() => {
    if (sessionStatus === 'anonymous') {
      // Keys stay in IndexedDB (they belong to the device, not the session) but the live engine
      // must not outlive the session, or a different account could reuse those ratchets.
      startingFor.current = null;
      setEngine(null);
      setStatus(null);
      setError(null);
      return;
    }
    void setup();
  }, [sessionStatus, setup]);

  const refresh = useCallback(async () => {
    startingFor.current = null;
    await setup();
  }, [setup]);

  const value = useMemo(() => ({ status, engine, error, loading, refresh }), [status, engine, error, loading, refresh]);

  return <E2eeContext.Provider value={value}>{children}</E2eeContext.Provider>;
}

export function useE2ee(): E2eeContextValue {
  return useContext(E2eeContext);
}
