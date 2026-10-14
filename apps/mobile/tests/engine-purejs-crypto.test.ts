/**
 * The crypto configuration a **phone** actually runs.
 *
 * A test that only ran on Node's WebCrypto would prove very little about Android: React Native has no
 * `crypto.subtle`, so on a real device the protocol library uses its own pure-JavaScript primitives
 * and takes *randomness* from the platform CSPRNG through `expo-crypto`
 * (`./runtime.ts` explains why that split is the right one).
 *
 * This file forces exactly that combination — the library's bundled primitives plus a real random
 * source — and runs a complete session through it: identity keys, signed prekeys, a prekey message,
 * ratchet messages both ways, and the safety number. If this passes, the phone path is sound; the
 * only thing the sandbox cannot verify is the native RNG module itself.
 */
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { setWebCrypto } from '@privacyresearch/libsignal-protocol-typescript';

const require = createRequire(import.meta.url);

beforeAll(() => {
  const bundled = require('@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto') as {
    subtle: SubtleCrypto;
  };
  expect(bundled.subtle).toBeTruthy();
  // Same shape as the app's runtime: pure-JS primitives + a platform random source.
  setWebCrypto({
    subtle: bundled.subtle,
    getRandomValues: <T extends ArrayBufferView>(array: T): T => webcrypto.getRandomValues(array as never) as T,
  } as unknown as Crypto);
});

describe('mobile E2EE on the phone crypto configuration', () => {
  it('runs a full session with the library’s bundled primitives', async () => {
    // Imported *after* setWebCrypto so the engines pick up the forced configuration.
    const { MobileE2eeEngine } = await import('../src/lib/e2ee/engine');
    const { MemoryBackend } = await import('../src/lib/e2ee/storage');
    const { FakeKeyApi, conversationStatus } = await import('./fake-key-api');

    const api = new FakeKeyApi();
    const aliceId = '11111111-1111-4111-8111-111111111111';
    const aliceDevice = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const bobId = '22222222-2222-4222-8222-222222222222';
    const bobDevice = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

    const alice = await MobileE2eeEngine.create({
      userId: aliceId,
      deviceId: aliceDevice,
      transport: api.transportFor(aliceId),
      backend: new MemoryBackend(),
    });
    const bob = await MobileE2eeEngine.create({
      userId: bobId,
      deviceId: bobDevice,
      transport: api.transportFor(bobId),
      backend: new MemoryBackend(),
    });

    // Keys are real, and shaped like Signal's: the public identity key carries the `0x05` curve-type
    // byte in front of the 32-byte point, which is why it is 33 bytes on the wire.
    const identity = await alice.identityKey();
    expect(Buffer.from(identity, 'base64')).toHaveLength(33);
    expect(Buffer.from(identity, 'base64')[0]).toBe(0x05);

    const conversation = conversationStatus([{ userId: aliceId }, { userId: bobId }]);
    const sent = await alice.encryptForConversation(conversation, 'رسالة على مسار الجوال');
    expect(sent.envelopes).toHaveLength(1);
    expect(
      await bob.decryptEnvelope({ senderUserId: aliceId, envelope: sent.envelopes[0]! }),
    ).toBe('رسالة على مسار الجوال');

    const reply = await bob.encryptForConversation(conversation, 'ووصل الرد');
    expect(await alice.decryptEnvelope({ senderUserId: bobId, envelope: reply.envelopes[0]! })).toBe('ووصل الرد');

    const onAlice = await alice.safetyNumberWith(await bob.identityKey());
    const onBob = await bob.safetyNumberWith(identity);
    expect(onAlice.join('')).toBe(onBob.join(''));
    expect(onAlice.join('')).toMatch(/^\d{60}$/);
  });
});
