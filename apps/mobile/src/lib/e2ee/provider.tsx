/**
 * E2EE state for the mobile app.
 *
 * The engine is created once per (account, device) pair and lives in React state, because the key
 * material itself lives in the OS keychain (`./storage`) — this provider only decides *when* it is
 * made ready and hands it to the screens.
 *
 * Three rules are enforced here, and they are the reason this is a provider rather than a hook:
 *
 *  1. **Readiness is honest.** Until keys are published the engine says `preparing`; on failure it
 *     says `error` and keeps the message, so a screen can disable encrypted sends instead of
 *     pretending they worked.
 *  2. **The device id comes from the server.** Envelopes are addressed to the device row the
 *     *session* belongs to, not to a locally invented id, so a mismatch is impossible.
 *  3. **Plaintext never leaves this device.** Decryption writes into the device-scoped cache and
 *     nothing is sent back to the server.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { PlaintextCache } from './content';
import { addressFor, MobileE2eeEngine } from './engine';
import { SecureStoreBackend } from './storage';
import type { DeviceDescriptor, E2eeTransport } from './types';

type E2eeStatus = 'idle' | 'preparing' | 'ready' | 'error';

interface E2eeValue {
  status: E2eeStatus;
  error: string | null;
  engine: MobileE2eeEngine | null;
  identityKey: string | null;
  oneTimeKeysRemaining: number | null;
  /** Plaintext this device already knows for a message, or null when it has none yet. */
  plaintextFor: (messageId: string) => string | null;
  /** Remembers a plaintext this device just sent, so the thread renders without decrypting it. */
  rememberPlaintext: (messageId: string, plaintext: string) => Promise<void>;
  /** Fetches this device's envelope for a message and decrypts it, or explains why it cannot. */
  decryptMessage: (input: { messageId: string; senderUserId: string }) => Promise<string>;
  /** Rebuilds the engine after a failure (e.g. the network came back). */
  retry: () => void;
}

const E2eeContext = createContext<E2eeValue | null>(null);

/** The app's transport: the shared API client, narrowed to what the protocol needs. */
function apiTransport(): E2eeTransport {
  return {
    get: (path) => api.get(path),
    post: (path, body) => api.post(path, body),
    put: (path, body) => api.put(path, body),
  };
}

export function E2eeProvider({ children }: { children: ReactNode }) {
  const { viewer, deviceId } = useSession();
  const [status, setStatus] = useState<E2eeStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<MobileE2eeEngine | null>(null);
  const [identityKey, setIdentityKey] = useState<string | null>(null);
  const [oneTimeKeysRemaining, setOneTimeKeysRemaining] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [plaintext, setPlaintext] = useState<Record<string, string>>({});
  const cacheRef = useRef<PlaintextCache | null>(null);

  useEffect(() => {
    if (!viewer?.id || !deviceId) {
      // Signed out, or the device row is not known yet: no keys, no engine, no claims.
      setEngine(null);
      setIdentityKey(null);
      setOneTimeKeysRemaining(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('preparing');
    setError(null);

    (async () => {
      const backend = new SecureStoreBackend();
      const cache = new PlaintextCache(backend, deviceId);
      const created = await MobileE2eeEngine.create({
        userId: viewer.id,
        deviceId,
        transport: apiTransport(),
        backend,
      });
      if (cancelled) return;
      const inventory = await created.inventory().catch(() => null);
      cacheRef.current = cache;
      setEngine(created);
      setIdentityKey(await created.identityKey());
      setOneTimeKeysRemaining(inventory?.remainingOneTimePreKeys ?? null);
      setStatus('ready');

      // Pre-load the cached plaintext so an offline thread renders without any network call.
      const keys = await backend.keys(`e2ee:${deviceId}:plaintext:`);
      const entries: Array<[string, string]> = [];
      for (const key of keys) {
        const value = await cache.get(key.split(':plaintext:')[1]!);
        if (value !== null) entries.push([key.split(':plaintext:')[1]!, value]);
      }
      if (!cancelled && entries.length > 0) setPlaintext((current) => ({ ...current, ...Object.fromEntries(entries) }));
    })().catch((cause: unknown) => {
      if (cancelled) return;
      setStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
    };
  }, [viewer?.id, deviceId, attempt]);

  const rememberPlaintext = useCallback(async (messageId: string, text: string) => {
    setPlaintext((current) => ({ ...current, [messageId]: text }));
    await cacheRef.current?.put(messageId, text);
  }, []);

  const plaintextFor = useCallback((messageId: string) => plaintext[messageId] ?? null, [plaintext]);

  const decryptMessage = useCallback(
    async ({ messageId, senderUserId }: { messageId: string; senderUserId: string }) => {
      const cached = await cacheRef.current?.get(messageId);
      if (cached !== null && cached !== undefined) return cached;
      if (!engine || !viewer?.id) throw new Error('e2ee_not_ready');

      // One request, not two: the caller already knows who sent the message (it is rendering the
      // row), and the *device* is named inside the envelope itself. The engine then refuses an
      // envelope naming a device the directory does not know, or one whose identity key moved.
      const { envelope } = await api.get<{ envelope: { deviceId: string; scheme: string; ciphertext: string } | null }>(
        `/api/messages/${messageId}/envelope`,
      );
      if (!envelope) throw new Error('no_envelope_for_device');
      const text = await engine.decryptEnvelope({ senderUserId, envelope });
      await rememberPlaintext(messageId, text);
      return text;
    },
    [engine, rememberPlaintext, viewer?.id],
  );

  const value = useMemo<E2eeValue>(
    () => ({
      status,
      error,
      engine,
      identityKey,
      oneTimeKeysRemaining,
      plaintextFor,
      rememberPlaintext,
      decryptMessage,
      retry: () => setAttempt((current) => current + 1),
    }),
    [status, error, engine, identityKey, oneTimeKeysRemaining, plaintextFor, rememberPlaintext, decryptMessage],
  );

  return <E2eeContext.Provider value={value}>{children}</E2eeContext.Provider>;
}

export function useE2ee(): E2eeValue {
  const value = useContext(E2eeContext);
  if (!value) throw new Error('useE2ee must be used inside E2eeProvider');
  return value;
}

/** Address of this device, for diagnostics screens. */
export function selfAddress(userId: string, deviceId: string): string {
  return addressFor(userId, deviceId).toString();
}

export type { DeviceDescriptor };
