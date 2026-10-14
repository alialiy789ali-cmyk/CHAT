/**
 * The phone's key store.
 *
 * The store is the part of E2EE that survives the process: if it lies about what it holds, sessions
 * and prekeys are lost or, worse, reused. The tests below use `MemoryBackend`, which is the same
 * interface the app backs with the OS keychain — the app supplies the keychain, these tests supply
 * the memory.
 */
import { describe, expect, it } from 'vitest';
import { MemoryBackend, SignalStore, decode, encode } from '../src/lib/e2ee/storage';

const DEVICE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const pair = (seed: number): { pubKey: ArrayBuffer; privKey: ArrayBuffer } => ({
  pubKey: new Uint8Array([seed, seed + 1, seed + 2]).buffer,
  privKey: new Uint8Array([seed + 3, seed + 4]).buffer,
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes, including the never-used zero byte', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 0]);
    expect(new Uint8Array(decode(encode(bytes)))).toEqual(bytes);
  });
});

describe('SignalStore — device material', () => {
  it('stores an identity that survives a reload', async () => {
    const backend = new MemoryBackend();
    const store = new SignalStore(backend, DEVICE_A);
    const identity = pair(1);
    await store.saveIdentityKeyPair(identity);
    await store.saveRegistrationId(4242);

    const reopened = new SignalStore(backend, DEVICE_A);
    const loaded = await reopened.loadIdentityKeyPair();
    expect(loaded && new Uint8Array(loaded.pubKey)).toEqual(new Uint8Array(identity.pubKey));
    expect(loaded && new Uint8Array(loaded.privKey)).toEqual(new Uint8Array(identity.privKey));
    expect(await reopened.getLocalRegistrationId()).toBe(4242);
  });

  it('keeps two devices of one account in separate namespaces', async () => {
    const backend = new MemoryBackend();
    const first = new SignalStore(backend, DEVICE_A);
    const second = new SignalStore(backend, DEVICE_B);
    await first.saveIdentityKeyPair(pair(10));
    await first.storePreKey(1, pair(20));
    await first.storeSession('22222222-2222-4222-8222-222222222222:cccc.d', 'session-a');

    expect(await second.loadIdentityKeyPair()).toBeUndefined();
    expect(await second.loadPreKey(1)).toBeUndefined();
    expect(await second.sessionAddresses()).toEqual([]);
    expect(await first.sessionAddresses()).toEqual(['22222222-2222-4222-8222-222222222222:cccc.d']);
  });

  it('refuses to silently accept a changed identity key (trust on first use)', async () => {
    const store = new SignalStore(new MemoryBackend(), DEVICE_A);
    const address = 'peer-device-address';
    expect(await store.isTrustedIdentity(address, pair(1).pubKey, 0 as never)).toBe(true);
    await store.saveIdentity(address, pair(1).pubKey);
    expect(await store.isTrustedIdentity(address, pair(1).pubKey, 0 as never)).toBe(true);
    // A different key for a peer we already know is exactly the case a user must confirm.
    expect(await store.isTrustedIdentity(address, pair(2).pubKey, 0 as never)).toBe(false);
  });

  it('wipes every key of one device and leaves the other device alone', async () => {
    const backend = new MemoryBackend();
    const first = new SignalStore(backend, DEVICE_A);
    const second = new SignalStore(backend, DEVICE_B);
    await first.saveIdentityKeyPair(pair(1));
    await first.storePreKey(1, pair(2));
    await first.storeSignedPreKey(1, pair(3));
    await first.storeSession('addr', 'record');
    await second.saveIdentityKeyPair(pair(9));

    await first.wipe();

    expect(await first.loadIdentityKeyPair()).toBeUndefined();
    expect(await first.loadPreKey(1)).toBeUndefined();
    expect(await first.loadSignedPreKey(1)).toBeUndefined();
    expect(await first.sessionAddresses()).toEqual([]);
    expect(await second.loadIdentityKeyPair()).toBeDefined();
  });
});

describe('SignalStore — one-time prekey bookkeeping', () => {
  it('separates locally generated keys from the ones the server accepted', async () => {
    const store = new SignalStore(new MemoryBackend(), DEVICE_A);
    expect(await store.hasPublishedKeys()).toBe(false);

    await store.storePreKey(1, pair(1));
    await store.storePreKey(2, pair(2));
    expect(await store.localPreKeyIds()).toEqual([1, 2]);
    expect(await store.unpublishedPreKeyIds()).toEqual([1, 2]);

    await store.markPublishedPreKeys([1]);
    expect(await store.unpublishedPreKeyIds()).toEqual([2]);
    expect(await store.hasPublishedKeys()).toBe(true);

    // Re-marking is idempotent, and a later batch does not resurrect older ids.
    await store.markPublishedPreKeys([1, 2, 3]);
    expect(await store.publishedPreKeyIds()).toEqual([1, 2, 3]);
    expect(await store.unpublishedPreKeyIds()).toEqual([]);
  });

  it('survives a corrupted bookkeeping entry instead of crashing the client', async () => {
    const store = new SignalStore(new MemoryBackend(), DEVICE_A);
    await store.setRaw('published-prekeys', 'not json at all');
    expect(await store.publishedPreKeyIds()).toEqual([]);
    await store.storePreKey(7, pair(7));
    expect(await store.unpublishedPreKeyIds()).toEqual([7]);
  });

  it('forgets a prekey that was consumed, so it is never advertised twice', async () => {
    const store = new SignalStore(new MemoryBackend(), DEVICE_A);
    await store.storePreKey(5, pair(5));
    await store.removePreKey(5);
    expect(await store.localPreKeyIds()).toEqual([]);
    expect(await store.loadPreKey(5)).toBeUndefined();
  });
});

describe('MemoryBackend', () => {
  it('lists keys by prefix and removes them', async () => {
    const backend = new MemoryBackend();
    await backend.set('e2ee:a:prekey:1', 'x');
    await backend.set('e2ee:a:prekey:2', 'y');
    await backend.set('e2ee:b:prekey:1', 'z');
    expect(await backend.keys('e2ee:a:prekey:')).toEqual(['e2ee:a:prekey:1', 'e2ee:a:prekey:2']);
    await backend.remove('e2ee:a:prekey:1');
    expect(await backend.keys('e2ee:a:')).toEqual(['e2ee:a:prekey:2']);
    expect(await backend.get('e2ee:b:prekey:1')).toBe('z');
  });
});
