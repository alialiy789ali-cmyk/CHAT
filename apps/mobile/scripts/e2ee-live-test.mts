/**
 * Account names are **fixed**, not random.
 *
 * Two reasons, both about the rate limiter and key material: registration is rate limited (10 per 10
 * minutes), and a random name would publish a fresh device and a fresh identity on every run, leaving
 * the previous identity's sessions and one-time keys orphaned on the server. Fixed names plus the
 * stable install key below mean the second run signs in to the same device row it used before.
 */
const PREFIX = process.env.E2EE_MOBILE_PREFIX ?? 'phonelive';

/**
 * Live end-to-end test of the **mobile** encryption modules against a running server.
 *
 * This script imports the real `src/lib/e2ee/engine.ts`, `storage.ts` and `fingerprint.ts` — the same
 * files the app runs — and talks to a live API over HTTP. Nothing about the protocol is stubbed: real
 * libsignal keys, real prekey claims, real ratchets, real ciphertext, and a peer that only ever sees
 * what the server hands it.
 *
 * Two deliberate stand-ins, both stated rather than hidden:
 *   * the key store is `MemoryBackend` instead of the OS keychain (the keychain is a platform API and
 *     `tests/storage.test.ts` covers the store contract);
 *   * the transport is `fetch` instead of the app's API client, because the point here is the wire
 *     contract, and the app's client is exercised by the app itself.
 *
 * Run against a live server (the dev API listens on :8787):
 *   npm run test:e2ee -w @sovereign/mobile
 *   E2EE_API_URL=http://host:8787 npm run test:e2ee -w @sovereign/mobile
 */
import { MobileE2eeEngine } from '../src/lib/e2ee/engine';
import { safetyNumber } from '../src/lib/e2ee/fingerprint';
import { MemoryBackend } from '../src/lib/e2ee/storage';
import type { ConversationEncryptionStatus, E2eeTransport } from '../src/lib/e2ee/types';

const BASE = process.env.E2EE_API_URL ?? 'http://127.0.0.1:8787';
const PASSWORD = 'Sovereign-Mobile-2026';

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

interface Account {
  token: string;
  userId: string;
  deviceId: string;
  username: string;
}

/** Raw HTTP helper: every call below states its own method and body, so the wire contract is visible. */
async function call<T>(
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const unique = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * Registers (or signs back into) a phone account.
 *
 * The install key is stable per account name, which is exactly what the app does: a second run reuses
 * the same device row instead of orphaning the keys the previous run published.
 */
async function phoneAccount(username: string, installKey = `mobile-live-${username}`): Promise<Account> {
  const device = { name: 'Live test phone', platform: 'android', key: installKey };
  const credentials = { username, email: `${username}@example.test`, password: PASSWORD, displayName: username, device };
  const registered = await call<{ accessToken: string; user: { id: string }; deviceId: string; error?: { message: string } }>(
    'POST',
    '/api/auth/register',
    { body: credentials },
  );
  if (registered.status === 201) {
    return { token: registered.body.accessToken, userId: registered.body.user.id, deviceId: registered.body.deviceId, username };
  }

  const loggedIn = await call<{ accessToken: string; user: { id: string }; deviceId: string; error?: { message: string } }>(
    'POST',
    '/api/auth/login',
    { body: { identifier: username, password: PASSWORD, device } },
  );
  if (loggedIn.status === 429) {
    throw new Error(
      `rate limited on ${username} (${loggedIn.body.error?.message ?? 'too many attempts'}) — ` +
        'the live test signs in to fixed accounts, so wait for the window and run it again',
    );
  }
  if (loggedIn.status !== 200) {
    throw new Error(
      `cannot sign in ${username}: ${loggedIn.status} ${JSON.stringify(loggedIn.body)} ` +
        `(registration said ${registered.status}: ${registered.body?.error?.message ?? 'ok'})`,
    );
  }
  return { token: loggedIn.body.accessToken, userId: loggedIn.body.user.id, deviceId: loggedIn.body.deviceId, username };
}


/**
 * Removes devices this account no longer uses, before the run starts.
 *
 * The live test signs in to fixed accounts so repeated runs do not pile up identities — but that also
 * means a device created by an *earlier* run is still in the account, and every device that has
 * published keys is addressed by every send. The assertions below ("exactly one envelope", "the
 * second device gets its own envelope") describe a clean device set, so the run begins by making one:
 * sign in, then drop every other device of the account through the same endpoint the security centre
 * uses (`DELETE /users/me/devices/:id`).
 *
 * The keys of a removed device are deleted with it — asserted explicitly at the end of the run, since
 * that is what makes a lost phone stop receiving ciphertext.
 */
async function dropOtherDevices(account: Account): Promise<string[]> {
  const devices = await call<Array<{ id: string }>>('GET', '/api/users/me/devices', { token: account.token });
  const removed: string[] = [];
  for (const device of devices.body) {
    if (device.id === account.deviceId) continue;
    await call('DELETE', `/api/users/me/devices/${device.id}`, { token: account.token });
    removed.push(device.id);
  }
  return removed;
}

/** The app's `E2eeTransport`, backed by fetch. */
function transportFor(token: string): E2eeTransport {
  return {
    get: <T,>(path: string) => call<T>('GET', path, { token }).then((result) => result.body),
    post: <T,>(path: string, body?: unknown) => call<T>('POST', path, { token, body }).then((result) => result.body),
    put: <T,>(path: string, body?: unknown) => call<T>('PUT', path, { token, body }).then((result) => result.body),
  };
}

async function makeEngine(account: Account, backend = new MemoryBackend()): Promise<MobileE2eeEngine> {
  return MobileE2eeEngine.create({
    userId: account.userId,
    deviceId: account.deviceId,
    transport: transportFor(account.token),
    backend,
  });
}

async function main(): Promise<void> {
  console.log(`\nmobile E2EE live test → ${BASE}\n`);

  // ---------------------------------------------------------------- [1] registration and keys
  const aliceName = `${PREFIX}_a`;
  const bobName = `${PREFIX}_b`;
  const alice = await phoneAccount(aliceName);
  const bob = await phoneAccount(bobName);
  // Housekeeping first: leftovers from earlier runs would otherwise be addressed by every send.
  const staleLeftovers = (await dropOtherDevices(alice)).length + (await dropOtherDevices(bob)).length;
  if (staleLeftovers > 0) console.log(`  · removed ${staleLeftovers} leftover device(s) from earlier runs`);
  check('two accounts register and each gets its own device row', alice.deviceId !== bob.deviceId && alice.userId !== bob.userId);

  const aliceEngine = await makeEngine(alice);
  const bobEngine = await makeEngine(bob);
  const aliceIdentity = await aliceEngine.identityKey();
  const bobIdentity = await bobEngine.identityKey();
  check('each phone generates a distinct identity key', aliceIdentity !== bobIdentity);

  const aliceInventory = await aliceEngine.inventory();
  check(
    'the server reports the phone as a libsignal-v1 device with a prekey pool',
    aliceInventory.algorithm === 'libsignal-v1' && aliceInventory.remainingOneTimePreKeys >= 20,
    aliceInventory,
  );
  // Counts are compared as *deltas*: a rerun republishes keys for the same device row, so the
  // absolute number depends on how often the test has run, while the deltas do not.
  const bobPoolBefore = (await bobEngine.inventory()).remainingOneTimePreKeys;

  // ---------------------------------------------------------------- [2] directory is claim-free
  const directory = await aliceEngine.directory(bob.userId);
  check('the directory lists the peer device', directory.length === 1 && directory[0]!.deviceId === bob.deviceId, directory);
  check(
    'the directory carries no one-time key',
    !JSON.stringify(directory).includes('oneTimePreKey'),
  );
  const afterDirectory = (await bobEngine.inventory()).remainingOneTimePreKeys;
  check('reading the directory claimed nothing from the pool', afterDirectory === bobPoolBefore, {
    before: bobPoolBefore,
    after: afterDirectory,
  });

  // ---------------------------------------------------------------- [3] encrypted conversation
  const conversation = await call<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
    token: alice.token,
    body: { userId: bob.userId },
  });
  const conversationId = conversation.body.conversation.id;
  const enabled = await call<{ isEncrypted: boolean; ready: boolean }>(
    'POST',
    `/api/conversations/${conversationId}/encryption`,
    { token: alice.token, body: { enabled: true } },
  );
  check('the conversation turns encryption on with both phones ready', enabled.status === 200 && enabled.body.isEncrypted, enabled.body);
  if (enabled.body.isEncrypted) {
    // The exact client contract: the per-device read must not claim anything either.
    await call('GET', `/api/conversations/${conversationId}/encryption`, { token: alice.token });
    const afterStatus = (await bobEngine.inventory()).remainingOneTimePreKeys;
    check('the per-device encryption status claimed nothing', afterStatus === bobPoolBefore, {
      before: bobPoolBefore,
      after: afterStatus,
    });
  }

  const status = await call<ConversationEncryptionStatus>('GET', `/api/conversations/${conversationId}/encryption`, {
    token: alice.token,
  });
  check(
    'the status names both participants',
    status.body.participants.length === 2 && status.body.participants.every((participant) => participant.ready),
    status.body,
  );

  // ---------------------------------------------------------------- [4] phone → phone
  const sent = await aliceEngine.encryptForConversation(status.body, 'مرحباً من الهاتف');
  check('one envelope is produced for the peer device', sent.envelopes.length === 1 && sent.envelopes[0]!.deviceId === bob.deviceId, sent);
  check('nothing was skipped or mismatched', sent.skipped.length === 0 && sent.schemeMismatches.length === 0, sent);
  const afterFirstSend = (await bobEngine.inventory()).remainingOneTimePreKeys;
  check('building the session claimed exactly one one-time prekey', afterFirstSend === bobPoolBefore - 1, {
    before: bobPoolBefore,
    after: afterFirstSend,
  });

  const posted = await call<{ message: { id: string; body: string | null } }>(
    'POST',
    `/api/conversations/${conversationId}/messages`,
    {
      token: alice.token,
      body: {
        clientMessageId: `live-${Date.now()}`,
        body: '',
        replyToId: null,
        encryptionScheme: 'libsignal-v1',
        envelopes: sent.envelopes,
      },
    },
  );
  check('the server accepts the envelopes', posted.status === 201, posted.body);
  check('the stored message has no plaintext', posted.body.message.body === '' || posted.body.message.body === null, posted.body.message);

  const bobEnvelope = await call<{ envelope: { deviceId: string; scheme: string; ciphertext: string } | null }>(
    'GET',
    `/api/messages/${posted.body.message.id}/envelope`,
    { token: bob.token },
  );
  check(
    "bob's phone receives his own envelope only",
    bobEnvelope.body.envelope?.deviceId === bob.deviceId && bobEnvelope.body.envelope.scheme === 'libsignal-v1',
    bobEnvelope.body,
  );
  const bobPlaintext = await bobEngine.decryptEnvelope({
    senderUserId: alice.userId,
    envelope: bobEnvelope.body.envelope!,
  });
  check('bob decrypts the real ciphertext on his phone', bobPlaintext === 'مرحباً من الهاتف', bobPlaintext);

  // The sender must not have an envelope of its own: it kept the plaintext locally.
  const aliceEnvelope = await call<{ envelope: unknown }>('GET', `/api/messages/${posted.body.message.id}/envelope`, {
    token: alice.token,
  });
  check('the sending phone has no envelope to decrypt', aliceEnvelope.body.envelope === null, aliceEnvelope.body);

  // ---------------------------------------------------------------- [5] phone ← phone
  const reply = await bobEngine.encryptForConversation(status.body, 'وصلت مشفّرة، شكراً');
  const replyPosted = await call<{ message: { id: string } }>('POST', `/api/conversations/${conversationId}/messages`, {
    token: bob.token,
    body: {
      clientMessageId: `live-reply-${Date.now()}`,
      body: '',
      replyToId: null,
      encryptionScheme: 'libsignal-v1',
      envelopes: reply.envelopes,
    },
  });
  const replyEnvelope = await call<{ envelope: { deviceId: string; scheme: string; ciphertext: string } | null }>(
    'GET',
    `/api/messages/${replyPosted.body.message.id}/envelope`,
    { token: alice.token },
  );
  const decryptedReply = await aliceEngine.decryptEnvelope({
    senderUserId: bob.userId,
    envelope: replyEnvelope.body.envelope!,
  });
  check('alice decrypts the reply', decryptedReply === 'وصلت مشفّرة، شكراً', decryptedReply);
  const afterReply = (await bobEngine.inventory()).remainingOneTimePreKeys;
  check('the reply did not claim another prekey (a ratchet already existed)', afterReply === afterFirstSend, {
    after: afterReply,
  });

  // ---------------------------------------------------------------- [6] tampering and plaintext leaks
  const tampered = {
    ...replyEnvelope.body.envelope!,
    ciphertext: (() => {
      const payload = JSON.parse(replyEnvelope.body.envelope!.ciphertext) as { type: number; body: string };
      return JSON.stringify({ ...payload, body: `${payload.body.slice(0, -6)}AAAAAA` });
    })(),
  };
  const tamperResult = await aliceEngine
    .decryptEnvelope({ senderUserId: bob.userId, envelope: tampered })
    .then(() => 'decrypted')
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  check('tampered ciphertext is rejected', tamperResult !== 'decrypted', tamperResult);

  const search = await call<Array<{ id: string; body: string | null }>>(
    'GET',
    `/api/messages/search?q=${encodeURIComponent('مرحباً')}`,
    { token: alice.token },
  );
  check(
    'the server cannot find the plaintext anywhere',
    search.status === 200 && !search.body.some((hit) => hit.id === posted.body.message.id),
    search.body,
  );
  const list = await call<{ items: Array<{ id: string; body: string | null }> }>(
    'GET',
    `/api/conversations/${conversationId}/messages?limit=20`,
    { token: bob.token },
  );
  const stored = list.body.items.find((item) => item.id === posted.body.message.id);
  check('the message row the peer reads carries ciphertext only', stored?.body === '' || stored?.body === null, stored);

  // ---------------------------------------------------------------- [7] a second phone of the same account
  const aliceTablet = await phoneAccount(aliceName, `mobile-live-${aliceName}-tablet`);
  check('the second device of the same account is a distinct row', aliceTablet.deviceId !== alice.deviceId && aliceTablet.userId === alice.userId);
  const tabletEngine = await makeEngine(aliceTablet);
  const multiSend = await aliceEngine.encryptForConversation(status.body, 'رسالة لكل أجهزتي');
  check(
    'a send addresses the other devices of the sender and the peer',
    multiSend.envelopes.map((envelope) => envelope.deviceId).sort().join(',') ===
      [bob.deviceId, aliceTablet.deviceId].sort().join(','),
    multiSend.envelopes.map((envelope) => envelope.deviceId),
  );
  const multiPosted = await call<{ message: { id: string } }>('POST', `/api/conversations/${conversationId}/messages`, {
    token: alice.token,
    body: {
      clientMessageId: `live-multi-${Date.now()}`,
      body: '',
      replyToId: null,
      encryptionScheme: 'libsignal-v1',
      envelopes: multiSend.envelopes,
    },
  });
  const tabletEnvelope = await call<{ envelope: { deviceId: string; scheme: string; ciphertext: string } | null }>(
    'GET',
    `/api/messages/${multiPosted.body.message.id}/envelope`,
    { token: aliceTablet.token },
  );
  check('the second device gets its own envelope', tabletEnvelope.body.envelope?.deviceId === aliceTablet.deviceId, tabletEnvelope.body);
  const tabletPlaintext = await tabletEngine.decryptEnvelope({
    senderUserId: alice.userId,
    envelope: tabletEnvelope.body.envelope!,
  });
  check("the sender's second device decrypts the sync copy", tabletPlaintext === 'رسالة لكل أجهزتي', tabletPlaintext);

  // ---------------------------------------------------------------- [8] a peer this phone cannot address
  const browserName = `${PREFIX}_browser`;
  const browserAccount = await phoneAccount(browserName);
  // A browser-style Olm device of that account: real endpoint, real stored keys, wrong scheme for a phone.
  const browserDevice = await call('PUT', '/api/keys/identity/olm', {
    token: browserAccount.token,
    body: {
      deviceId: browserAccount.deviceId,
      algorithm: 'olm-v1',
      identityKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      signingKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      signature: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
      oneTimeKeys: [{ id: 'k1', key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') }],
    },
  });
  check('an Olm device publishes through the Olm endpoint', browserDevice.status === 200, browserDevice.body);

  const browserConversation = await call<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
    token: alice.token,
    body: { userId: browserAccount.userId },
  });
  await call('POST', `/api/conversations/${browserConversation.body.conversation.id}/encryption`, {
    token: alice.token,
    body: { enabled: true },
  });
  const browserStatus = await call<ConversationEncryptionStatus>(
    'GET',
    `/api/conversations/${browserConversation.body.conversation.id}/encryption`,
    { token: alice.token },
  );
  const crossScheme = await aliceEngine.encryptForConversation(browserStatus.body, 'هل تقرأ هذا؟');
  check(
    'a device of the other scheme is reported, not silently skipped',
    crossScheme.schemeMismatches.length === 1 &&
      crossScheme.schemeMismatches[0]!.deviceId === browserAccount.deviceId &&
      crossScheme.schemeMismatches[0]!.algorithm === 'olm-v1',
    { mismatches: crossScheme.schemeMismatches },
  );
  check(
    'the only envelope in that conversation goes to the sender\'s own second device',
    crossScheme.envelopes.length === 1 && crossScheme.envelopes[0]!.deviceId === aliceTablet.deviceId,
    crossScheme.envelopes.map((envelope) => envelope.deviceId),
  );
  check('no envelope was produced for the Olm device', !crossScheme.envelopes.some((envelope) => envelope.deviceId === browserAccount.deviceId));

  // ---------------------------------------------------------------- [9] safety numbers agree
  const onAlice = await aliceEngine.safetyNumberWith(bobIdentity);
  const onBob = await bobEngine.safetyNumberWith(aliceIdentity);
  const onTablet = await tabletEngine.safetyNumberWith(bobIdentity);
  check('both phones compute the same safety number', onAlice.join('') === onBob.join('') && onAlice.length === 12, { onAlice, onBob });
  check(
    "the sender's second device computes the same digits for its own pair",
    onTablet.join('') === (await safetyNumber(await tabletEngine.identityKey(), bobIdentity)).join(''),
  );
  // Different devices are *supposed* to show different digits: verifying the phone says nothing about
  // the tablet, which is the whole reason verification is per device rather than per account.
  check("the second device's digits differ from the phone's", onTablet.join('') !== onAlice.join(''));
  const emojisA = await aliceEngine.safetyEmojiWith(bobIdentity);
  const emojisB = await bobEngine.safetyEmojiWith(aliceIdentity);
  check('the emoji comparison agrees', emojisA.join('') === emojisB.join('') && emojisA.length === 7, { emojisA, emojisB });

  // A device that is gone must stop being addressable, and its keys must go with it: this is what
  // makes "sign out and remove this phone" a real answer to a lost device.
  await call('DELETE', `/api/users/me/devices/${aliceTablet.deviceId}`, { token: alice.token });
  const directoryAfterRemoval = await call<{ devices: Array<{ deviceId: string }> }>(
    'GET',
    `/api/keys/${alice.userId}/devices`,
    { token: bob.token },
  );
  check(
    'removing a device deletes the keys it published',
    !directoryAfterRemoval.body.devices.some((device) => device.deviceId === aliceTablet.deviceId),
    directoryAfterRemoval.body.devices,
  );

  // ---------------------------------------------------------------- summary
  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nlive test crashed:', error);
  process.exitCode = 1;
});
