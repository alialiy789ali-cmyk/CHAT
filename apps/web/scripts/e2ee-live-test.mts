/**
 * Live end-to-end test of the web client's encryption modules.
 *
 * Unlike the server's acceptance suite (which drives its own Olm helper), this script imports the
 * **actual browser modules** — `lib/e2ee/client.ts`, `lib/e2ee/engine.ts`, `lib/e2ee/store.ts`,
 * `lib/e2ee/fingerprint.ts` and the real `lib/api.ts` — and runs them against a running API. The
 * only browser APIs stood in for are IndexedDB (`fake-indexeddb`, a real implementation of the
 * spec) and the React layer, which this test deliberately skips: everything below the components
 * is what a browser executes.
 *
 * Run against a live server:
 *   npm run test:e2ee -w @sovereign/web            (defaults to http://127.0.0.1:8787)
 *   E2EE_API_URL=http://host:8787 npm run test:e2ee -w @sovereign/web
 */
import 'fake-indexeddb/auto';

import { ApiClient } from '../src/lib/api';
import { E2eeEngine } from '../src/lib/e2ee/engine';
import { loadOlm } from '../src/lib/e2ee/client';
import { parseEnvelope } from '../src/lib/e2ee/types';
import { safetyNumber, safetyNumberEmoji, deviceFingerprint } from '../src/lib/e2ee/fingerprint';
import { loadPlaintext, loadSessions } from '../src/lib/e2ee/store';

const BASE = process.env.E2EE_API_URL ?? 'http://127.0.0.1:8787';

/**
 * Logs into one of the accounts the seed reserves for this test.
 *
 * `cipher_c` intentionally never publishes keys — it is the member who cannot receive encrypted
 * messages, which is what the refusal check below needs.
 */
/**
 * Signs a seeded account in.
 *
 * The install key is derived from the account name so repeated runs reuse one device row: a fresh
 * device every run would publish another set of keys and leave the previous ones unreachable.
 */
async function loginSeeded(username: string, installKey = `e2ee-live-${username}`): Promise<ApiClient> {
  const client = newClient();
  await client.login(username, 'Sovereign-Demo-2026', { installKey });
  return client;
}

/** Each account gets its own client: two users cannot share one access token. */
function newClient(): ApiClient {
  const client = new ApiClient();
  client.setBaseUrl(BASE);
  return client;
}

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(label);
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
}

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

interface Account {
  client: ApiClient;
  engine: E2eeEngine;
  userId: string;
  deviceId: string;
  username: string;
}

/**
 * Prepares one account for the test.
 *
 * Registration is rate limited on purpose (10 per 10 minutes per IP), so repeat runs log into the
 * two accounts the seed script reserves for this test (`cipher_a` / `cipher_b`). Override them with
 * `E2EE_TEST_USERS="userA:passA,userB:passB"`; if they do not exist, a fresh pair is registered.
 */
async function createAccount(label: string): Promise<Account> {
  const client = newClient();
  const configured = (process.env.E2EE_TEST_USERS ?? '')
    .split(',')
    .map((entry) => entry.split(':'))
    .filter((parts) => parts.length === 2);
  const seeded = label === 'alice' ? 'cipher_a' : 'cipher_b';
  const chosen = configured[label === 'alice' ? 0 : 1];
  const username = chosen ? chosen[0]! : seeded;
  const password = chosen ? chosen[1]! : 'Sovereign-Demo-2026';

  let userId: string;
  try {
    const loggedIn = await client.login(username, password, { installKey: `e2ee-live-${username}` });
    userId = loggedIn.user.id;
  } catch (loginError) {
    // An explicit pair that does not work is an error; otherwise fall back to registering, which
    // is the case on a fresh database that has not been seeded.
    if (configured.length > 0) throw loginError;
    const fresh = `live${label}${suffix}`.slice(0, 24);
    const registered = await client.register({
      username: fresh,
      email: `${fresh}@live.local`,
      password: 'Sovereign-Live-Passw0rd',
      displayName: `Live ${label}`,
    });
    userId = registered.user.id;
  }

  // The browser learns its own device id from the session list; scripts must do the same.
  const sessions = await client.get<Array<{ deviceId: string | null; current: boolean }>>('/api/auth/sessions');
  const deviceId = sessions.find((session) => session.current)?.deviceId;
  if (!deviceId) throw new Error(`no device for ${label}`);

  const engine = await E2eeEngine.create(userId, deviceId, client);
  return { client, engine, userId, deviceId, username };
}

async function main(): Promise<void> {
  console.log(`Sovereign web E2EE live test against ${BASE}\n`);

  console.log('[1] device registration (real Olm identity per browser)');
  let alice: Account | null = null;
  let bob: Account | null = null;
  try {
    alice = await createAccount('alice');
    bob = await createAccount('bob');
    await runChecks(alice, bob);
  } finally {
    // Sessions are capped per account: leaving them behind would lock an account out after a few
    // runs. Logging out here is what makes this script repeatable.
    for (const account of [alice, bob]) {
      await account?.client.post('/api/auth/logout').catch(() => {});
    }
  }
}

async function runChecks(alice: Account, bob: Account): Promise<void> {
  check('device created and published', alice.engine.created && bob.engine.created);
  check('identity keys differ between devices', alice.engine.identityKey !== bob.engine.identityKey);
  check('one-time key pool filled', alice.engine.remainingOneTimeKeys() >= 10, alice.engine.remainingOneTimeKeys());

  const aliceFingerprint = await deviceFingerprint(alice.engine.identityKey);
  check('fingerprint is 5 human-readable groups', /^([0-9a-f]{4} ){4}[0-9a-f]{4}$/.test(aliceFingerprint), aliceFingerprint);

  console.log('[2] bundle fetching and signature verification');
  // Accounts accumulate devices over runs (that is what multi-device means), so the checks work
  // with the device this process actually owns rather than assuming there is only one.
  const bobBundles = await alice.engine.bundlesFor(bob.userId);
  const bobCurrent = bobBundles.find((bundle) => bundle.deviceId === bob.deviceId);
  check('bob has at least one usable bundle', bobBundles.length >= 1, bobBundles.length);
  check("bob's own device is among them", Boolean(bobCurrent), bobBundles.map((bundle) => bundle.deviceId));
  check('bundle carries an Olm algorithm', bobCurrent?.algorithm === 'olm-v1');
  check('bundle identity matches bob device', bobCurrent?.identityKey === bob.engine.identityKey);

  console.log('[3] conversation encryption');
  const conversation = await alice.client.post<{ conversation: { id: string } }>('/api/conversations/direct', { userId: bob.userId });
  const conversationId = conversation.conversation.id;
  const statusBefore = await alice.engine.conversationStatus(conversationId);
  check('both participants ready', statusBefore.ready, statusBefore.participants);
  check('no key material leaks in the status payload', !JSON.stringify(statusBefore).includes('PrivateKey'));
  await alice.engine.setConversationEncryption(conversationId, true);
  const statusAfter = await alice.engine.conversationStatus(conversationId);
  check('conversation is encrypted', statusAfter.isEncrypted);

  console.log('[4] encrypt, send, fetch and decrypt (two real devices)');
  const secret = 'رسالة حقيقية مشفّرة من متصفح إلى متصفح 🔐';
  const encrypted = await alice.engine.encryptForConversation(statusAfter, secret);
  const toBob = encrypted.envelopes.find((envelope) => envelope.deviceId === bob.deviceId);
  check('an envelope addressed to bob\'s device exists', Boolean(toBob), encrypted.envelopes.map((e) => e.deviceId));
  check('no device of any participant was skipped', encrypted.skipped.length === 0, encrypted.skipped);
  const payload = parseEnvelope(toBob!.ciphertext);
  check('first message is a prekey message (type 0)', payload.type === 0, payload.type);
  check('plaintext absent from the envelope', !toBob!.ciphertext.includes(secret));

  const sent = await alice.client.post<{ message: { id: string } }>(`/api/conversations/${conversationId}/messages`, {
    clientMessageId: `live-${Date.now()}-a`,
    body: '',
    encryptionScheme: 'olm-v1',
    envelopes: encrypted.envelopes,
  });
  await alice.engine.rememberSent({ messageId: sent.message.id, conversationId, body: secret });

  const history = await bob.client.get<{
    items: Array<{ id: string; body: string | null; encryptionScheme: string; envelopes: Array<{ ciphertext: string }> }>;
  }>(`/api/conversations/${conversationId}/messages?limit=10`);
  const row = history.items.find((item) => item.id === sent.message.id);
  check('the stored row has no readable body', row?.body === null, row?.body);
  // The server hands each device only its own envelope, so bob sees exactly one row here.
  check("bob's device received exactly one envelope", row?.envelopes.length === 1, row?.envelopes.length);

  // Alice cached her own plaintext when she sent; bob's device must not be able to read that
  // cache (a shared browser profile with two accounts would otherwise leak between them).
  const aliceCacheLeak = await loadPlaintext(sent.message.id, bob.deviceId);
  check("the other device cannot read alice's cached plaintext", aliceCacheLeak === null, aliceCacheLeak);

  const decrypted = await bob.engine.decryptEnvelope({
    messageId: sent.message.id,
    conversationId,
    senderUserId: alice.userId,
    envelope: { deviceId: bob.deviceId, scheme: 'olm-v1', ciphertext: row!.envelopes[0]!.ciphertext },
    mine: false,
  });
  check('bob decrypted the exact text', decrypted === secret, decrypted);
  // Proof the ratchet really ran: an inbound session for alice's device now exists on bob's side.
  const bobSessions = await loadSessions(bob.deviceId);
  check(
    "bob's device now holds a ratchet with alice's device",
    bobSessions.some((entry) => entry.peerDeviceId === alice.deviceId),
    bobSessions.map((entry) => entry.peerDeviceId),
  );

  console.log('[5] reply inside the ratchet (type 1)');
  const replyText = 'استلمت وفككت التشفير، والرد على نفس الجلسة ✅';
  const reply = await bob.engine.encryptForConversation(await bob.engine.conversationStatus(conversationId), replyText);
  // The interesting envelope is the one addressed to the device alice is using right now: that is
  // the pair whose ratchet was established by the first message, so the reply must not be another
  // prekey message. Other (older) devices of alice legitimately get a fresh session.
  const replyToAlice = reply.envelopes.find((envelope) => envelope.deviceId === alice.deviceId);
  check('reply targets alice\'s current device', Boolean(replyToAlice), reply.envelopes.map((e) => e.deviceId));
  const replyPayload = parseEnvelope(replyToAlice!.ciphertext);
  check('reply is a ratchet message (type 1), not another handshake', replyPayload.type === 1, replyPayload.type);
  const replySent = await bob.client.post<{ message: { id: string } }>(`/api/conversations/${conversationId}/messages`, {
    clientMessageId: `live-${Date.now()}-b`,
    body: '',
    encryptionScheme: 'olm-v1',
    envelopes: reply.envelopes,
  });
  await bob.engine.rememberSent({ messageId: replySent.message.id, conversationId, body: replyText });

  const aliceHistory = await alice.client.get<{ items: Array<{ id: string; envelopes: Array<{ ciphertext: string }> }> }>(
    `/api/conversations/${conversationId}/messages?limit=10`,
  );
  const aliceRow = aliceHistory.items.find((item) => item.id === replySent.message.id);
  const aliceText = await alice.engine.decryptEnvelope({
    messageId: replySent.message.id,
    conversationId,
    senderUserId: bob.userId,
    envelope: { deviceId: alice.deviceId, scheme: 'olm-v1', ciphertext: aliceRow!.envelopes[0]!.ciphertext },
    mine: false,
  });
  check('alice decrypted the reply', aliceText === replyText, aliceText);

  console.log('[6] envelope scoping and server blindness');
  const ownHistory = await alice.client.get<{ items: Array<{ id: string; envelopes: Array<{ ciphertext: string }> }> }>(
    `/api/conversations/${conversationId}/messages?limit=10`,
  );
  const ownRow = ownHistory.items.find((item) => item.id === sent.message.id)!;
  check('sender gets no recipient envelope back', ownRow.envelopes.length === 0, ownRow.envelopes.length);
  const search = await alice.client.get<Array<{ id: string }>>(`/api/messages/search?q=${encodeURIComponent('مشفّرة')}`);
  check('full-text search cannot see the message', !search.some((hit) => hit.id === sent.message.id));
  const stored = await alice.engine.fetchEnvelope(sent.message.id);
  check('envelope endpoint returns nothing for the sender device', stored === null, stored);

  console.log('[7] safety numbers');
  const digitsA = await safetyNumber(alice.engine.identityKey, bob.engine.identityKey);
  const digitsB = await safetyNumber(bob.engine.identityKey, alice.engine.identityKey);
  check('both sides derive identical digits (order independent)', digitsA.join(' ') === digitsB.join(' '), digitsA.join(' '));
  check('60 digits in 12 groups', digitsA.length === 12 && digitsA.every((group) => group.length === 5), digitsA);
  const emojiA = await safetyNumberEmoji(alice.engine.identityKey, bob.engine.identityKey);
  const emojiB = await safetyNumberEmoji(bob.engine.identityKey, alice.engine.identityKey);
  check('emoji form matches on both sides', emojiA.join('') === emojiB.join(''), emojiA.join(' '));
  const substituted = await safetyNumber(alice.engine.identityKey, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  check('a substituted key changes the number', substituted.join('') !== digitsA.join(''));

  console.log('[8] verification bookkeeping');
  await alice.engine.markVerified(bob.deviceId, digitsA.join(' '), true);
  const verifications = await alice.engine.verificationsFor(bob.userId);
  const bobRecord = verifications.find((entry) => entry.deviceId === bob.deviceId);
  check('alice recorded verification of bob device', bobRecord?.verified === true, bobRecord);
  const bobViewOfAlice = await bob.engine.verificationsFor(alice.userId);
  check('verification is per verifier (bob has none recorded)', bobViewOfAlice.every((entry) => !entry.verified));

  console.log('[9] a device that stopped answering cannot freeze the conversation');
  {
    // A second device for bob, published with a **single** one-time key and then left alone: the
    // first bundle fetch consumes that key, so the device becomes unaddressable — exactly what a
    // phone that was lost or reinstalled looks like to everyone else.
    // A *second install* of the same user: it must be a different device row, otherwise consuming
    // its only one-time key would break the device under test instead of simulating a stale phone.
    const staleClient = await loginSeeded('cipher_b', 'e2ee-live-cipher_b-stale-install');
    const staleDeviceId = (await staleClient.get<Array<{ deviceId: string | null; current: boolean }>>('/api/auth/sessions')).find(
      (session) => session.current,
    )?.deviceId;
    // Publish exactly one one-time key, straight through the real library.
    const olm = await loadOlm();
    const staleAccount = new olm.Account();
    staleAccount.create();
    const staleIdentity = JSON.parse(staleAccount.identity_keys()) as { curve25519: string; ed25519: string };
    staleAccount.generate_one_time_keys(1);
    const staleOneTimeKeys = Object.entries(
      (JSON.parse(staleAccount.one_time_keys()) as { curve25519: Record<string, string> }).curve25519,
    ).map(([id, key]) => ({ id, key }));
    await staleClient.put('/api/keys/identity/olm', {
      deviceId: staleDeviceId,
      identityKey: staleIdentity.curve25519,
      signingKey: staleIdentity.ed25519,
      signature: staleAccount.sign(staleIdentity.curve25519),
      oneTimeKeys: staleOneTimeKeys,
    });

    // Two fetches: the first hands out the only key, the second finds the pool empty.
    await alice.engine.bundlesFor(bob.userId, { fresh: true });
    await alice.engine.bundlesFor(bob.userId, { fresh: true });

    const staleStatus = await alice.engine.conversationStatus(conversationId);
    const send = await alice.engine.encryptForConversation(staleStatus, 'a message for the reachable devices');
    check('the reachable devices still receive an envelope', send.envelopes.length >= 1, send.envelopes.length);
    check('the stale device is reported, not silently dropped', send.unreachable.some((entry) => entry.deviceId === staleDeviceId), send.unreachable);
    check('the send is not blocked for everybody', send.skipped.length === 0, send.skipped);

    // The opposite case: a member with *no* keys at all must block the send outright.
    const noKeysClient = await loginSeeded('cipher_c');
    const noKeysMe = await noKeysClient.get<{ id: string }>('/api/users/me');
    const blockedConversation = await alice.client.post<{ conversation: { id: string } }>('/api/conversations/direct', {
      userId: noKeysMe.id,
    });
    const blockedStatus = await alice.engine.conversationStatus(blockedConversation.conversation.id);
    const blockedSend = await alice.engine.encryptForConversation(blockedStatus, 'nobody can read this');
    check(
      'a participant with no keys is reported as a blocking skip',
      blockedSend.skipped.some((entry) => entry.userId === noKeysMe.id),
      blockedSend.skipped,
    );
    // Everything that did get an envelope belongs to alice's own devices; nothing was produced for
    // the keyless member, and the composer refuses the send because `skipped` is not empty.
    const ownDevices = (await alice.client.get<{ devices: Array<{ deviceId: string }> }>('/api/keys/me')).devices.map(
      (entry) => entry.deviceId,
    );
    check(
      'only the sender\'s own devices receive envelopes in that case',
      blockedSend.envelopes.every((envelope) => ownDevices.includes(envelope.deviceId)),
      blockedSend.envelopes.map((envelope) => envelope.deviceId),
    );

    // The server agrees: such a conversation cannot be switched to encrypted in the first place.
    let refused = false;
    try {
      await alice.engine.setConversationEncryption(blockedConversation.conversation.id, true);
    } catch (error) {
      refused = String(error).includes('participant_without_keys') || String(error).includes('409');
    }
    check('the server refuses to encrypt a conversation with a keyless member', refused);

    await staleClient.post('/api/auth/logout').catch(() => {});
    await noKeysClient.post('/api/auth/logout').catch(() => {});
  }

  console.log('[10] refusals that protect the conversation');
  let refusals = 0;
  try {
    // Plaintext into an encrypted conversation must be rejected, not silently stored.
    await alice.client.post(`/api/conversations/${conversationId}/messages`, {
      clientMessageId: `live-${Date.now()}-plain`,
      body: 'نص عادي داخل محادثة مشفّرة',
    });
  } catch {
    refusals += 1;
  }
  check('plaintext is refused in an encrypted conversation', refusals === 1);

  let tamperDetected = false;
  try {
    const tamperedBody = `${row!.envelopes[0]!.ciphertext.slice(0, -8)}AAAAAA`;
    void tamperedBody;
    await bob.engine.decryptEnvelope({
      messageId: 'tampered-probe',
      conversationId,
      senderUserId: alice.userId,
      envelope: { deviceId: bob.deviceId, scheme: 'olm-v1', ciphertext: tamperedBody },
      mine: false,
    });
  } catch {
    tamperDetected = true;
  }
  check('a tampered envelope is rejected', tamperDetected);


  console.log("[11] the sender's own other devices can read what this device sent (self-sync)");
  // A second install of the *same* account: different device row, different Olm identity, same user.
  // This is the case a phone/browser pair hits every day, and it is the reason the sender must also
  // address its own devices instead of only the other participants.
  const secondClient = await loginSeeded(alice.username, `e2ee-selfsync-${suffix}`);
  const secondDeviceId = (
    await secondClient.get<Array<{ deviceId: string | null; current: boolean }>>('/api/auth/sessions')
  ).find((session) => session.current)?.deviceId;
  check(
    'the second install is a different device',
    Boolean(secondDeviceId) && secondDeviceId !== alice.deviceId,
    secondDeviceId,
  );
  const secondEngine = await E2eeEngine.create(alice.userId, secondDeviceId!, secondClient);

  const selfSecret = 'رسالة من الجهاز الأول — ويجب أن يقرأها الجهاز الثاني لنفس الحساب';
  const outbound = await alice.engine.encryptForConversation(
    await alice.engine.conversationStatus(conversationId),
    selfSecret,
  );
  check(
    "the sender's own other device is addressed too",
    outbound.envelopes.some((envelope) => envelope.deviceId === secondDeviceId),
    outbound.envelopes.map((envelope) => envelope.deviceId),
  );
  const selfSent = await alice.client.post<{ message: { id: string } }>(`/api/conversations/${conversationId}/messages`, {
    clientMessageId: `live-${Date.now()}-sync`,
    body: '',
    encryptionScheme: 'olm-v1',
    envelopes: outbound.envelopes,
  });
  await alice.engine.rememberSent({ messageId: selfSent.message.id, conversationId, body: selfSecret });

  // The second device gets only its own envelope and recovers the text on its own.
  const secondHistory = await secondClient.get<{
    items: Array<{ id: string; envelopes: Array<{ ciphertext: string }> }>;
  }>(`/api/conversations/${conversationId}/messages?limit=10`);
  const secondRow = secondHistory.items.find((item) => item.id === selfSent.message.id);
  check(
    'the second device receives exactly its own envelope',
    secondRow?.envelopes.length === 1,
    secondRow?.envelopes.length,
  );
  const secondText = await secondEngine.decryptEnvelope({
    messageId: selfSent.message.id,
    conversationId,
    senderUserId: alice.userId,
    envelope: { deviceId: secondDeviceId!, scheme: 'olm-v1', ciphertext: secondRow!.envelopes[0]!.ciphertext },
    mine: true,
  });
  check('the second device decrypted a message it never sent', secondText === selfSecret, secondText);
  // …while the sending device never needed an envelope for itself: its own plaintext is local.
  const firstCache = await loadPlaintext(selfSent.message.id, alice.deviceId);
  check('the sending device kept its own plaintext locally', firstCache?.body === selfSecret, firstCache?.body);
  await secondClient.post('/api/auth/logout').catch(() => {});

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nFATAL', error);
  process.exit(1);
});
