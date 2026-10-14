/**
 * Protocol state storage for the phone, built on a pluggable key/value backend.
 *
 * Two implementations travel with the code:
 *
 *  - `SecureStoreBackend` — expo-secure-store (Keychain on iOS, Keystore-backed prefs on Android).
 *    That is where a private identity key belongs when the OS offers a place for it.
 *  - `MemoryBackend`      — for tests. Same code path, no device required.
 *
 * The store is scoped to one device id: every key it writes is prefixed with it, so signing in again
 * (or switching accounts in the same install) can never resurrect another device's ratchet state.
 */
import type { Direction, KeyPairType, StorageType } from '@privacyresearch/libsignal-protocol-typescript';
import { fromByteArray, toByteArray } from 'base64-js';
import type { KeyValueBackend } from './types';

export const encode = (buffer: ArrayBuffer | Uint8Array): string =>
  fromByteArray(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

export const decode = (value: string): ArrayBuffer => {
  const bytes = toByteArray(value);
  // `toByteArray` can return a view; copy so callers own a plain ArrayBuffer of exact length.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export class MemoryBackend implements KeyValueBackend {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix));
  }
}

/**
 * Keychain/Keystore-backed storage.
 *
 * `expo-secure-store` is imported lazily so the module can be exercised in Node (tests, CI) without
 * the native module present — the import would otherwise fail at load time.
 */
export class SecureStoreBackend implements KeyValueBackend {
  private secureStore: {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
  } | null = null;

  private async store() {
    if (!this.secureStore) {
      const imported = await import('expo-secure-store');
      this.secureStore = imported;
    }
    return this.secureStore!;
  }

  async get(key: string): Promise<string | null> {
    return (await this.store()).getItemAsync(key);
  }
  async set(key: string, value: string): Promise<void> {
    await (await this.store()).setItemAsync(key, value);
  }
  async remove(key: string): Promise<void> {
    await (await this.store()).deleteItemAsync(key);
  }
  /**
   * `expo-secure-store` has no key listing, so the store keeps an index entry listing the keys it
   * wrote. It is needed for wiping one device's material (and for the settings screen to show what
   * exists) and it holds no secret material itself.
   */
  async keys(prefix: string): Promise<string[]> {
    const index = (await this.get(`${prefix}__index`)) ?? '';
    return index.split('\n').filter(Boolean);
  }
}

/** A small serialisable key pair; matches the library's `KeyPairType` after base64 conversion. */
interface StoredKeyPair {
  pubKey: string;
  privKey: string;
}

export class SignalStore implements StorageType {
  constructor(
    private readonly backend: KeyValueBackend,
    readonly deviceId: string,
  ) {}

  private key(name: string): string {
    return `e2ee:${this.deviceId}:${name}`;
  }

  /** Registers a written key in the backend's index (secure stores cannot enumerate). */
  private async note(key: string): Promise<void> {
    if (!(this.backend instanceof SecureStoreBackend)) return;
    const indexKey = `e2ee:${this.deviceId}:__index`;
    const current = (await this.backend.get(indexKey)) ?? '';
    if (current.split('\n').includes(key)) return;
    await this.backend.set(indexKey, [...current.split('\n').filter(Boolean), key].join('\n'));
  }

  async getRaw(name: string): Promise<string | null> {
    return this.backend.get(this.key(name));
  }
  async setRaw(name: string, value: string): Promise<void> {
    await this.backend.set(this.key(name), value);
    await this.note(this.key(name));
  }
  async removeRaw(name: string): Promise<void> {
    await this.backend.remove(this.key(name));
  }

  async loadIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const raw = await this.getRaw('identity');
    if (!raw) return undefined;
    const pair = JSON.parse(raw) as StoredKeyPair;
    return { pubKey: decode(pair.pubKey), privKey: decode(pair.privKey) };
  }

  async saveIdentityKeyPair(pair: KeyPairType): Promise<void> {
    const stored: StoredKeyPair = { pubKey: encode(pair.pubKey), privKey: encode(pair.privKey) };
    await this.setRaw('identity', JSON.stringify(stored));
  }

  /** ------------------------------------------------------------- library interface */

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return this.loadIdentityKeyPair();
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const raw = await this.getRaw('registrationId');
    return raw ? Number(raw) : undefined;
  }

  async saveRegistrationId(id: number): Promise<void> {
    await this.setRaw('registrationId', String(id));
  }

  /**
   * Trust-on-first-use with a hard rule: once a device's identity key is stored, a *different* key
   * for the same address is refused. That refusal is what makes a server swap of an identity key
   * visible instead of silent — the caller then decides to re-verify or reset the session.
   */
  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    const existing = await this.getRaw(`ident:${encodedAddress}`);
    const incoming = encode(publicKey);
    if (existing === incoming) return false;
    await this.setRaw(`ident:${encodedAddress}`, incoming);
    return existing !== null;
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: Direction): Promise<boolean> {
    const stored = await this.getRaw(`ident:${identifier}`);
    return stored === null || stored === encode(identityKey);
  }

  async loadPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    const raw = await this.getRaw(`prekey:${keyId}`);
    if (!raw) return undefined;
    const pair = JSON.parse(raw) as StoredKeyPair;
    return { pubKey: decode(pair.pubKey), privKey: decode(pair.privKey) };
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    // The library reads `privKey` straight off what it loads, so keys are stored as bare pairs.
    const stored: StoredKeyPair = { pubKey: encode(keyPair.pubKey), privKey: encode(keyPair.privKey) };
    await this.setRaw(`prekey:${keyId}`, JSON.stringify(stored));
  }

  async removePreKey(keyId: number | string): Promise<void> {
    await this.removeRaw(`prekey:${keyId}`);
  }

  async loadSignedPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    const raw = await this.getRaw(`signedprekey:${keyId}`);
    if (!raw) return undefined;
    const pair = JSON.parse(raw) as StoredKeyPair;
    return { pubKey: decode(pair.pubKey), privKey: decode(pair.privKey) };
  }

  async storeSignedPreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    const stored: StoredKeyPair = { pubKey: encode(keyPair.pubKey), privKey: encode(keyPair.privKey) };
    await this.setRaw(`signedprekey:${keyId}`, JSON.stringify(stored));
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    await this.removeRaw(`signedprekey:${keyId}`);
  }

  /** One-time prekey ids held locally, in order. */
  async localPreKeyIds(): Promise<number[]> {
    const keys = await this.backend.keys(`e2ee:${this.deviceId}:prekey:`);
    return keys
      .map((key) => Number(key.split(':prekey:')[1]))
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
  }

  /** Ids the server has already accepted, so a restart does not republish the same batch. */
  async publishedPreKeyIds(): Promise<number[]> {
    const raw = await this.getRaw('published-prekeys');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
    } catch {
      return [];
    }
  }

  /** Local prekeys the server has not been told about yet. */
  async unpublishedPreKeyIds(): Promise<number[]> {
    const published = new Set(await this.publishedPreKeyIds());
    return (await this.localPreKeyIds()).filter((id) => !published.has(id));
  }

  /** True when this device ever published a key set — tells a fresh install from a restart. */
  async hasPublishedKeys(): Promise<boolean> {
    return (await this.getRaw('published-prekeys')) !== null;
  }

  /**
   * Marks keys as published.
   *
   * Called only after the server acknowledged the upload: a key marked here but missing on the server
   * is a one-time prekey nobody can claim, which silently costs the device a first-message slot.
   */
  async markPublishedPreKeys(ids: number[]): Promise<void> {
    const current = new Set(await this.publishedPreKeyIds());
    for (const id of ids) current.add(id);
    await this.setRaw('published-prekeys', JSON.stringify([...current].sort((a, b) => a - b)));
  }

  async loadSession(encodedAddress: string): Promise<string | undefined> {
    return (await this.getRaw(`session:${encodedAddress}`)) ?? undefined;
  }

  async storeSession(encodedAddress: string, record: string): Promise<void> {
    await this.setRaw(`session:${encodedAddress}`, record);
  }

  /** Every session record this device holds — used to reason about multi-device state in tests. */
  async sessionAddresses(): Promise<string[]> {
    const keys = await this.backend.keys(`e2ee:${this.deviceId}:session:`);
    return keys.map((key) => key.split(':session:')[1] ?? '');
  }

  async removeSession(encodedAddress: string): Promise<void> {
    await this.removeRaw(`session:${encodedAddress}`);
  }

  async removeAllSessions(): Promise<void> {
    for (const address of await this.sessionAddresses()) await this.removeSession(address);
  }

  /** Drops every stored byte for this device (identity, keys, sessions). */
  async wipe(): Promise<void> {
    for (const key of await this.backend.keys(`e2ee:${this.deviceId}:`)) await this.backend.remove(key);
  }
}
