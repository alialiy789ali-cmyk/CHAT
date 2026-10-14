/**
 * Persistence for the browser's Olm state.
 *
 * Olm keeps everything a device needs in pickles: the account (identity key, one-time keys) and
 * one pickle per session (the ratchet state). Losing them means losing the ability to read past or
 * future messages in that session, so they are written to IndexedDB — the only browser store that
 * survives a reload without being sent anywhere.
 *
 * Two deliberate decisions:
 *  - Pickles are additionally encrypted with a per-device key (`crypto.subtle`) before they are
 *    stored, so a reader of the IndexedDB contents (another script on a shared machine, a backup
 *    of the profile directory) does not get a usable ratchet.
 *  - Nothing here is ever uploaded. The server only ever sees public keys — that is what makes
 *    the encryption real rather than decorative.
 */

const DB_NAME = 'sovereign-e2ee';
const DB_VERSION = 2;
const STORE_ACCOUNTS = 'accounts';
const STORE_SESSIONS = 'sessions';
const STORE_PLAINTEXT = 'plaintext';
const STORE_WRAP_KEY = 'keyring';

export interface StoredAccount {
  /** Owning user; a browser profile can be used by more than one account over its lifetime. */
  userId: string;
  /** Server-side device id this account belongs to. */
  deviceId: string;
  /** Olm account pickle (encrypted at rest, see `wrap`). */
  pickle: string;
  /** Curve25519 identity key, kept in clear so the UI can show a fingerprint without unlocking. */
  identityKey: string;
  /** Ed25519 signing key. */
  signingKey: string;
  /** When the device last published keys. */
  publishedAt: string;
  /** True once the account has been published to this server instance. */
  registered: boolean;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) db.createObjectStore(STORE_ACCOUNTS, { keyPath: 'deviceId' });
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      // v1 keyed plaintext by message id alone, which made two devices in one browser profile
      // overwrite each other's entry: the second write silently erased the first, and the message
      // came back "locked" later even though the device had already decrypted it. v2 keys by
      // (deviceId, messageId). Cached plaintext is disposable, so the store is rebuilt.
      if ((event as IDBVersionChangeEvent).oldVersion < 2 && db.objectStoreNames.contains(STORE_PLAINTEXT)) {
        db.deleteObjectStore(STORE_PLAINTEXT);
      }
      if (!db.objectStoreNames.contains(STORE_PLAINTEXT)) {
        db.createObjectStore(STORE_PLAINTEXT, { keyPath: ['deviceId', 'messageId'] });
      }
      if (!db.objectStoreNames.contains(STORE_WRAP_KEY)) db.createObjectStore(STORE_WRAP_KEY);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'));
  });
}

function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = run(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexeddb_request_failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

/** True when the browser exposes the storage APIs E2EE needs; the UI hides the feature otherwise. */
export function e2eeStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto?.subtle !== 'undefined';
}

/* --------------------------------------------------------------- at-rest wrapping */

let wrapKeyPromise: Promise<CryptoKey> | null = null;

/**
 * Device-local wrapping key. It is generated once per browser profile and stored as a
 * non-extractable CryptoKey, which the browser refuses to export — so the wrapped pickles cannot
 * be lifted out of the profile by a script that merely reads storage.
 */
function wrappingKey(): Promise<CryptoKey> {
  if (!wrapKeyPromise) {
    wrapKeyPromise = (async () => {
      const existing = await transaction<CryptoKey | undefined>(STORE_WRAP_KEY, 'readonly', (store) => store.get('wrap'));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await transaction(STORE_WRAP_KEY, 'readwrite', (store) => store.put(key, 'wrap'));
      return key;
    })();
  }
  return wrapKeyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function wrap(plain: string): Promise<string> {
  const key = await wrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

async function unwrap(wrapped: string): Promise<string> {
  const [ivPart, dataPart] = wrapped.split('.');
  if (!ivPart || !dataPart) throw new Error('e2ee_pickle_corrupt');
  const key = await wrappingKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivPart) as unknown as BufferSource },
    key,
    fromBase64(dataPart) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/* --------------------------------------------------------------- accounts */

export async function saveAccount(account: StoredAccount): Promise<void> {
  const stored: StoredAccount = { ...account, pickle: await wrap(account.pickle) };
  await transaction(STORE_ACCOUNTS, 'readwrite', (store) => store.put(stored));
}

export async function loadAccount(deviceId: string): Promise<StoredAccount | null> {
  const stored = await transaction<StoredAccount | undefined>(STORE_ACCOUNTS, 'readonly', (store) => store.get(deviceId));
  if (!stored) return null;
  return { ...stored, pickle: await unwrap(stored.pickle) };
}

/** Every device this browser has keys for; the UI lists them so a user can see the truth. */
export async function listAccounts(): Promise<StoredAccount[]> {
  const stored = await transaction<StoredAccount[]>(STORE_ACCOUNTS, 'readonly', (store) => store.getAll());
  return stored.map((account) => ({ ...account, pickle: '' }));
}

export async function deleteAccount(deviceId: string): Promise<void> {
  await transaction(STORE_ACCOUNTS, 'readwrite', (store) => store.delete(deviceId));
  // Sessions belonging to that device must go with it, or a stale ratchet stays on disk.
  const sessions = await transaction<StoredSession[]>(STORE_SESSIONS, 'readonly', (store) => store.getAll());
  for (const session of sessions.filter((entry) => entry.deviceId === deviceId)) {
    await deleteSession(session.id);
  }
}

/* --------------------------------------------------------------- sessions */

export interface StoredSession {
  /** `<own device>|<peer device>` — one live ratchet per device pair. */
  id: string;
  deviceId: string;
  peerDeviceId: string;
  /** Olm session pickle. */
  pickle: string;
  sessionId: string;
  updatedAt: string;
}

export async function saveSession(session: Omit<StoredSession, 'pickle'> & { pickle: string }): Promise<void> {
  const pickle = await wrap(session.pickle);
  await transaction(STORE_SESSIONS, 'readwrite', (store) => store.put({ ...session, pickle }));
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  const stored = await transaction<StoredSession | undefined>(STORE_SESSIONS, 'readonly', (store) => store.get(id));
  if (!stored) return null;
  return { ...stored, pickle: await unwrap(stored.pickle) };
}

export async function loadSessions(deviceId: string): Promise<StoredSession[]> {
  const stored = await transaction<StoredSession[]>(STORE_SESSIONS, 'readonly', (store) => store.getAll());
  const mine = stored.filter((session) => session.deviceId === deviceId);
  const unlocked: StoredSession[] = [];
  for (const session of mine) {
    unlocked.push({ ...session, pickle: await unwrap(session.pickle) });
  }
  return unlocked;
}

export async function deleteSession(id: string): Promise<void> {
  await transaction(STORE_SESSIONS, 'readwrite', (store) => store.delete(id));
}

/** Session key for a device pair. Order is the local device first, which is stable per client. */
export function sessionKey(deviceId: string, peerDeviceId: string): string {
  return `${deviceId}|${peerDeviceId}`;
}

/* --------------------------------------------------------------- plaintext cache */

export interface CachedPlaintext {
  messageId: string;
  conversationId: string;
  deviceId: string;
  body: string;
  /** Sender's own messages are cached too, so the device can re-render them after a reload. */
  mine: boolean;
  storedAt: string;
}

export async function cachePlaintext(entry: CachedPlaintext): Promise<void> {
  await transaction(STORE_PLAINTEXT, 'readwrite', (store) => store.put(entry));
}

/**
 * Looks up cached plaintext **for one device**.
 *
 * The device check is not cosmetic: a browser profile can be used by more than one account, and
 * the messages of an encrypted conversation the other account took part in are already on disk.
 * Returning them for the wrong device would hand one account text it never decrypted.
 */
export async function loadPlaintext(messageId: string, deviceId: string): Promise<CachedPlaintext | null> {
  const entry = await transaction<CachedPlaintext | undefined>(STORE_PLAINTEXT, 'readonly', (store) =>
    store.get([deviceId, messageId]),
  );
  if (!entry || entry.deviceId !== deviceId) return null;
  return entry;
}

export async function loadPlaintextForConversation(conversationId: string, deviceId: string): Promise<CachedPlaintext[]> {
  const all = await transaction<CachedPlaintext[]>(STORE_PLAINTEXT, 'readonly', (store) => store.getAll());
  return all.filter((entry) => entry.conversationId === conversationId && entry.deviceId === deviceId);
}

export async function clearPlaintextCache(): Promise<void> {
  await transaction(STORE_PLAINTEXT, 'readwrite', (store) => store.clear());
}
