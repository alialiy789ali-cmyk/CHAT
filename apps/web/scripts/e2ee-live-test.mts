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
import { parseEnvelope } from '../src/lib/e2ee/types';
import { safetyNumber, safetyNumberEmoji, deviceFingerprint } from '../src/lib/e2ee/fingerprint';

const BASE = process.env.E2EE_API_URL ?? 'http://127.0.0.1:8787';

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
 * Registration is rate limited on purpose (10 per 10 minutes per IP), so repeat runs reuse two
 * dedicated accounts instead of creating new ones. Provide them yourself with
 * `E2EE_TEST_USERS="alice:secret,bob:secret"`; otherwise the seeded demo accounts are tried and a
 * fresh pair is registered as a last resort.
 */
async function createAccount(label: string): Promise<Account> {
  const client = newClient();
  const configured = (process.env.E2EE_TEST_USERS ?? '')
    .split(',')
    .map((entry) => entry.split(':'))
    .filter((parts) => parts.length === 2);
  const chosen = configured[label === 'alice' ? 0 : 1];
  const username = chosen ? chosen[0]! : `live${label}${suffix}`.slice(0, 24);
  const password = chosen ? chosen[1]! : 'Sovereign-Live-Passw0rd';

  let userId: string;
  try {
    const loggedIn = await client.login(username, password);
    userId = loggedIn.user.id;
  } catch (loginError) {
    if (configured.length > 0) throw loginError;
    const registered = await client.register({
      username,
      email: `${username}@live.local`,
      password,
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
  const bobBundles = await alice.engine.bundlesFor(bob.userId);
  check('exactly one usable bundle for bob', bobBundles.length === 1, bobBundles.length);
  check('bundle carries an Olm algorithm', bobBundles[0]?.algorithm === 'olm-v1');
  check('bundle identity matches bob device', bobBundles[0]?.identityKey === bob.engine.identityKey);

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
  check('one envelope per recipient device', encrypted.envelopes.length === 1, encrypted.envelopes.length);
  check('no failures while encrypting', encrypted.skipped.length === 0, encrypted.skipped);
  const payload = parseEnvelope(encrypted.envelopes[0]!.ciphertext);
  check('first message is a prekey message (type 0)', payload.type === 0, payload.type);
  check('plaintext absent from the envelope', !encrypted.envelopes[0]!.ciphertext.includes(secret));

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
  check("bob's device received exactly one envelope", row?.envelopes.length === 1, row?.envelopes.length);

  const decrypted = await bob.engine.decryptEnvelope({
    messageId: sent.message.id,
    conversationId,
    senderUserId: alice.userId,
    envelope: { deviceId: bob.deviceId, scheme: 'olm-v1', ciphertext: row!.envelopes[0]!.ciphertext },
    mine: false,
  });
  check('bob decrypted the exact text', decrypted === secret, decrypted);

  console.log('[5] reply inside the ratchet (type 1)');
  const replyText = 'استلمت وفككت التشفير، والرد على نفس الجلسة ✅';
  const reply = await bob.engine.encryptForConversation(await bob.engine.conversationStatus(conversationId), replyText);
  const replyPayload = parseEnvelope(reply.envelopes[0]!.ciphertext);
  check('reply is a ratchet message (type 1)', replyPayload.type === 1, replyPayload.type);
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

  console.log('[9] refusals that protect the conversation');
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
