/**
 * The mobile E2EE engine, exercised with real libsignal and real key material.
 *
 * Nothing in here fakes cryptography: two engines are created, each with its own key store, the
 * session is built from a claimed bundle exactly like the app builds it, and the ciphertext that one
 * produces is the ciphertext the other opens. Only the *network* is a fake (./fake-key-api), because
 * the server's own contract is proven by the server's acceptance tests.
 */
import { describe, expect, it } from 'vitest';
import { MobileE2eeEngine } from '../src/lib/e2ee/engine';
import { MemoryBackend } from '../src/lib/e2ee/storage';
import { conversationStatus, FakeKeyApi } from './fake-key-api';

const ALICE = '11111111-1111-4111-8111-111111111111';
const ALICE_DEVICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ALICE_TABLET = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';
const BOB_DEVICE = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BOB_OLD_PHONE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function makeEngine(
  api: FakeKeyApi,
  userId: string,
  deviceId: string,
  backend = new MemoryBackend(),
): Promise<MobileE2eeEngine> {
  return MobileE2eeEngine.create({ userId, deviceId, transport: api.transportFor(userId), backend });
}

describe('mobile E2EE engine — provisioning', () => {
  it('generates one identity, publishes it, and reuses it on the next start', async () => {
    const api = new FakeKeyApi();
    const backend = new MemoryBackend();
    const first = await makeEngine(api, ALICE, ALICE_DEVICE, backend);
    const identity = await first.identityKey();
    expect(identity).toBeTruthy();
    expect(api.pool(ALICE, ALICE_DEVICE)).toBeGreaterThanOrEqual(20);

    const second = await makeEngine(api, ALICE, ALICE_DEVICE, backend);
    expect(await second.identityKey()).toBe(identity);
    // A restart must not republish an accepted batch: those private halves may already be spent.
    expect(api.pool(ALICE, ALICE_DEVICE)).toBe(20);
  });

  it('keeps two devices of one account on separate identities and separate pools', async () => {
    const api = new FakeKeyApi();
    const phone = await makeEngine(api, ALICE, ALICE_DEVICE);
    const tablet = await makeEngine(api, ALICE, ALICE_TABLET);
    expect(await phone.identityKey()).not.toBe(await tablet.identityKey());
    expect(api.pool(ALICE, ALICE_DEVICE)).toBe(20);
    expect(api.pool(ALICE, ALICE_TABLET)).toBe(20);
  });

  it('tops the server-side pool up when it runs low', async () => {
    const api = new FakeKeyApi();
    const backend = new MemoryBackend();
    const engine = await makeEngine(api, ALICE, ALICE_DEVICE, backend);
    // Drain the pool the way peers would: one claim per new inbound session.
    const bobTransport = api.transportFor(BOB);
    for (let index = 0; index < 19; index += 1) await bobTransport.get(`/api/keys/${ALICE}`);
    expect(api.pool(ALICE, ALICE_DEVICE)).toBe(1);

    const restarted = await makeEngine(api, ALICE, ALICE_DEVICE, backend);
    const inventory = await restarted.inventory();
    expect(inventory.algorithm).toBe('libsignal-v1');
    expect(inventory.remainingOneTimePreKeys).toBeGreaterThanOrEqual(19);
  });
});

describe('mobile E2EE engine — sending and receiving', () => {
  it('delivers a message from a phone to a phone, both directions', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const conversation = conversationStatus([{ userId: ALICE }, { userId: BOB }]);

    const first = await alice.encryptForConversation(conversation, 'hello from the phone');
    expect(first.skipped).toEqual([]);
    expect(first.envelopes).toHaveLength(1);
    expect(first.envelopes[0]!.deviceId).toBe(BOB_DEVICE);
    expect(first.envelopes[0]!.scheme).toBe('libsignal-v1');

    const decrypted = await bob.decryptEnvelope({ senderUserId: ALICE, envelope: first.envelopes[0]! });
    expect(decrypted).toBe('hello from the phone');

    const reply = await bob.encryptForConversation(conversation, 'reply from the phone');
    expect(reply.envelopes).toHaveLength(1);
    expect(await alice.decryptEnvelope({ senderUserId: BOB, envelope: reply.envelopes[0]! })).toBe(
      'reply from the phone',
    );
    // The first message built a session, so the second is a ratchet message, not another prekey one.
    const second = await alice.encryptForConversation(conversation, 'second message');
    expect(JSON.parse(second.envelopes[0]!.ciphertext).type).toBe(1);
    expect(await bob.decryptEnvelope({ senderUserId: ALICE, envelope: second.envelopes[0]! })).toBe('second message');
  });

  it('spends exactly one one-time prekey per new session, and none afterwards', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    await makeEngine(api, BOB, BOB_DEVICE);
    const conversation = conversationStatus([{ userId: ALICE }, { userId: BOB }]);

    await alice.encryptForConversation(conversation, 'first');
    expect(api.pool(BOB, BOB_DEVICE)).toBe(19);
    await alice.encryptForConversation(conversation, 'second');
    await alice.encryptForConversation(conversation, 'third');
    expect(api.pool(BOB, BOB_DEVICE)).toBe(19);
  });

  it('addresses every device of a member, and never itself', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const aliceTablet = await makeEngine(api, ALICE, ALICE_TABLET);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const conversation = conversationStatus([{ userId: ALICE }, { userId: BOB }]);

    const result = await alice.encryptForConversation(conversation, 'to everyone');
    // Bob's phone plus Alice's tablet — not Alice's sending phone, which holds the plaintext.
    const deviceIds = result.envelopes.map((envelope) => envelope.deviceId).sort();
    expect(deviceIds).toEqual([ALICE_TABLET, BOB_DEVICE].sort());

    const tabletEnvelope = result.envelopes.find((envelope) => envelope.deviceId === ALICE_TABLET)!;
    expect(await aliceTablet.decryptEnvelope({ senderUserId: ALICE, envelope: tabletEnvelope })).toBe('to everyone');
    const bobEnvelope = result.envelopes.find((envelope) => envelope.deviceId === BOB_DEVICE)!;
    expect(await bob.decryptEnvelope({ senderUserId: ALICE, envelope: bobEnvelope })).toBe('to everyone');
  });

  it('refuses to pretend a member with no devices was reached', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    // A user who never published keys has nothing to open a message with.
    const stranger = '33333333-3333-4333-8333-333333333333';
    const result = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: stranger }]),
      'hello?',
    );
    expect(result.envelopes).toHaveLength(0);
    expect(result.skipped).toEqual([{ userId: stranger, reason: 'no_usable_devices' }]);
  });

  it('reports a device that cannot be reached instead of failing the whole send', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    await makeEngine(api, BOB, BOB_OLD_PHONE, new MemoryBackend());
    // The old phone's published signed prekey is garbage: no session with it can ever be built.
    const broken = api.device(BOB, BOB_OLD_PHONE)!;
    broken.oneTimePreKeys = [];
    broken.signedPreKey = { id: 1, publicKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', signature: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' };

    const result = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'anyone home?',
    );
    expect(result.envelopes.map((envelope) => envelope.deviceId)).toEqual([BOB_DEVICE]);
    expect(result.skipped).toEqual([]);
    expect(result.unreachable).toEqual([
      { userId: BOB, deviceId: BOB_OLD_PHONE, reason: 'session_unavailable' },
    ]);
    expect(await bob.decryptEnvelope({ senderUserId: ALICE, envelope: result.envelopes[0]! })).toBe('anyone home?');
  });

  it('reports a device on the other scheme rather than dropping it silently', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    await makeEngine(api, BOB, BOB_DEVICE);
    // A browser session of the same account: reachable by chat, not by this client's scheme.
    const browserDevice = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
    api.addForeignDevice(BOB, browserDevice, 'olm-v1');

    const result = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'mixed devices',
    );
    // The phone still reaches Bob's phone; the browser is named instead of silently skipped.
    expect(result.envelopes.map((envelope) => envelope.deviceId)).toEqual([BOB_DEVICE]);
    expect(result.schemeMismatches).toEqual([{ userId: BOB, deviceId: browserDevice, algorithm: 'olm-v1' }]);
    expect(result.skipped).toEqual([]);
  });

  it('blocks the send when a member has only devices of the other scheme', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const browserOnly = '44444444-4444-4444-8444-444444444444';
    api.addForeignDevice(browserOnly, 'cccccccc-1111-4111-8111-cccccccccccc', 'olm-v1');

    const result = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: browserOnly }]),
      'anyone?',
    );
    expect(result.envelopes).toHaveLength(0);
    expect(result.skipped).toEqual([]); // the member *has* devices; they just are not reachable here
    expect(result.schemeMismatches).toHaveLength(1);
  });

  it('shares one plaintext locally instead of encrypting to the sending device', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    await makeEngine(api, BOB, BOB_DEVICE);
    const result = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'note to self',
    );
    expect(result.envelopes.every((envelope) => envelope.deviceId !== ALICE_DEVICE)).toBe(true);
  });
});

describe('mobile E2EE engine — integrity', () => {
  it('rejects ciphertext that was tampered with', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const sent = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'do not touch',
    );

    const payload = JSON.parse(sent.envelopes[0]!.ciphertext) as { type: number; body: string };
    const flipped = `${payload.body.slice(0, -4)}AAAA`;
    const tampered = { ...sent.envelopes[0]!, ciphertext: JSON.stringify({ ...payload, body: flipped }) };
    await expect(bob.decryptEnvelope({ senderUserId: ALICE, envelope: tampered })).rejects.toThrow();
  });

  it('refuses an envelope that claims a sender device with a different identity key', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const sent = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'who am i',
    );
    const payload = JSON.parse(sent.envelopes[0]!.ciphertext) as Record<string, unknown>;
    const forged = {
      ...sent.envelopes[0]!,
      ciphertext: JSON.stringify({ ...payload, senderIdentityKey: await bob.identityKey() }),
    };
    await expect(bob.decryptEnvelope({ senderUserId: ALICE, envelope: forged })).rejects.toThrow(
      'envelope_sender_key_mismatch',
    );
  });

  it('refuses an envelope from a device the directory does not know', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const sent = await alice.encryptForConversation(
      conversationStatus([{ userId: ALICE }, { userId: BOB }]),
      'stranger',
    );
    const payload = JSON.parse(sent.envelopes[0]!.ciphertext) as Record<string, unknown>;
    await expect(
      bob.decryptEnvelope({
        senderUserId: ALICE,
        envelope: { ...sent.envelopes[0]!, ciphertext: JSON.stringify({ ...payload, senderDeviceId: ALICE_TABLET }) },
      }),
    ).rejects.toThrow('envelope_sender_device_unknown');
  });

  it('produces the same safety number on both phones, and changes when a key changes', async () => {
    const api = new FakeKeyApi();
    const alice = await makeEngine(api, ALICE, ALICE_DEVICE);
    const bob = await makeEngine(api, BOB, BOB_DEVICE);
    const aliceKey = await alice.identityKey();
    const bobKey = await bob.identityKey();

    const onAlice = await alice.safetyNumberWith(bobKey);
    const onBob = await bob.safetyNumberWith(aliceKey);
    expect(onAlice).toHaveLength(12);
    expect(onAlice.join('')).toMatch(/^\d{60}$/);
    expect(onAlice).toEqual(onBob);
    expect(await alice.safetyEmojiWith(bobKey)).toEqual(await bob.safetyEmojiWith(aliceKey));

    // A reinstall means a new identity: every digit has to change, or verification means nothing.
    const reinstall = await makeEngine(api, BOB, BOB_DEVICE, new MemoryBackend());
    const changed = await alice.safetyNumberWith(await reinstall.identityKey());
    expect(changed).not.toEqual(onAlice);
  });
});
