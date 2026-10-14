// Exercises exactly the endpoints the web UI calls, through the web origin (:3000 proxy).
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
let failures = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' :: ' + extra : ''}`); if (!cond) failures++; };
const call = async (path, { method = 'GET', token, body, raw } = {}) => {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, json, raw: text, cookies: res.headers.getSetCookie?.() ?? [] };
};
const stamp = Date.now().toString(36);

/** Logs in and returns the access token + user id (or null when the account does not exist). */
const loginAs = async (username, password = 'Sovereign-Demo-2026') => {
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier: username, password } });
  if (res.status !== 200 || !res.json?.accessToken) return null;
  const me = await call('/api/users/me', { token: res.json.accessToken });
  const sessions = await call('/api/auth/sessions', { token: res.json.accessToken });
  return {
    token: res.json.accessToken,
    userId: me.json?.id,
    deviceId: sessions.json?.find((entry) => entry.current)?.deviceId,
  };
};

/**
 * A minimal but real Olm client for the contract checks.
 *
 * It uses the shipped WASM library — the same code the browser runs — so the keys published here
 * are genuine and the messages below are genuinely encrypted. Session persistence, the safety
 * number UI and the React layer are exercised by `npm run test:e2ee -w @sovereign/web`; this
 * helper exists so the API contract is checked with real crypto rather than filler bytes.
 */
const newOlmClient = async (account) => {
  const imported = await import('@matrix-org/olm');
  const olm = imported.default ?? imported;
  await olm.init();
  const acct = new olm.Account();
  acct.create();
  const keys = JSON.parse(acct.identity_keys());
  const oneTimeKeys = (count) => {
    acct.generate_one_time_keys(count);
    return Object.entries(JSON.parse(acct.one_time_keys()).curve25519 ?? {}).map(([id, key]) => ({ id, key }));
  };
  const otks = oneTimeKeys(20);
  const published = await call('/api/keys/identity/olm', {
    method: 'PUT',
    token: account.token,
    body: {
      deviceId: account.deviceId,
      identityKey: keys.curve25519,
      signingKey: keys.ed25519,
      signature: acct.sign(keys.curve25519),
      oneTimeKeys: otks,
    },
  });
  acct.mark_keys_as_published();
  const replenished = await call('/api/keys/prekeys/olm', {
    method: 'POST',
    token: account.token,
    body: { deviceId: account.deviceId, oneTimeKeys: oneTimeKeys(5) },
  });
  acct.mark_keys_as_published();
  const sessions = new Map();
  return {
    identityKey: keys.curve25519,
    deviceId: account.deviceId,
    published: published.json ?? {},
    replenished: replenished.json?.oneTimeKeysStored ?? 0,
    verifyBundle(bundle) {
      const utility = new olm.Utility();
      try {
        utility.ed25519_verify(bundle.signingKey, bundle.identityKey, bundle.identitySignature);
        return true;
      } catch {
        return false;
      } finally {
        utility.free();
      }
    },
    encryptFor(bundle, text) {
      const session = new olm.Session();
      session.create_outbound(acct, bundle.identityKey, bundle.oneTimePreKey.publicKey);
      const message = session.encrypt(text);
      sessions.set(session.session_id(), session);
      return {
        payload: { type: message.type, body: message.body },
        envelope: {
          deviceId: bundle.deviceId,
          scheme: 'olm-v1',
          ciphertext: JSON.stringify({
            type: message.type,
            body: message.body,
            senderIdentityKey: keys.curve25519,
            senderSigningKey: keys.ed25519,
          }),
        },
      };
    },
    decryptFrom(peerIdentityKey, peerDeviceId, ciphertext) {
      void peerDeviceId;
      const parsed = JSON.parse(ciphertext);
      const session = new olm.Session();
      session.create_inbound_from(acct, peerIdentityKey, parsed.body);
      const text = session.decrypt(parsed.type, parsed.body);
      acct.remove_one_time_keys(session);
      return text;
    },
  };
};

console.log('\n[1] auth through the proxy');
const reg = await call('/api/auth/register', { method: 'POST', body: { username: `webcheck_${stamp}`, email: `web_${stamp}@example.test`, password: 'Sovereign-Web-2026', displayName: 'فحص الويب', device: { name: 'node', platform: 'web' } } });
ok('register 201', reg.status === 201, `status=${reg.status} ${reg.raw?.slice(0, 120)}`);
if (reg.status !== 201) {
  // Registration is rate limited by design (10 per 10 minutes per IP). Continuing would produce a
  // cascade of misleading failures, so stop with the real reason instead.
  if (reg.status === 429) {
    console.error(`\nRegistration is rate limited (retry in ${reg.json?.error?.retryAfterSeconds ?? '?'}s). ` +
      'Wait for the window to pass, or run this check against a server with a higher limit.\n');
  } else {
    console.error(`\nRegistration failed: ${reg.raw?.slice(0, 200)}\n`);
  }
  process.exit(1);
}
ok('refresh cookie set', (reg.cookies ?? []).some((c) => c.startsWith('sovereign_refresh=')));
const token = reg.json?.accessToken;

const me = await call('/api/users/me', { token });
ok('GET /users/me matches Viewer shape', me.status === 200 && typeof me.json?.username === 'string' && typeof me.json?.privacy?.readReceipts === 'boolean' && typeof me.json?.stats?.followers === 'number' && typeof me.json?.theme === 'string');

const login = await call('/api/auth/login', { method: 'POST', body: { identifier: 'layla', password: 'Sovereign-Demo-2026' } });
ok('seed login layla', login.status === 200);
const layla = login.json?.accessToken;
const laylaMe = await call('/api/users/me', { token: layla });
ok('seed viewer has stats + locale', laylaMe.status === 200 && laylaMe.json?.locale === 'ar' && typeof laylaMe.json?.stats?.posts === 'number');

console.log('\n[2] messaging endpoints');
const conversations = await call('/api/conversations', { token: layla });
ok('GET /conversations → {items}', conversations.status === 200 && Array.isArray(conversations.json?.items), `count=${conversations.json?.items?.length}`);
const firstConv = conversations.json?.items?.[0];
ok('conversation DTO fields', Boolean(firstConv?.id && firstConv?.type && typeof firstConv?.unreadCount === 'number' && 'lastMessage' in firstConv && typeof firstConv?.isEncrypted === 'boolean'));
const messages = await call(`/api/conversations/${firstConv.id}/messages?limit=10`, { token: layla });
ok('GET messages → {items}', messages.status === 200 && Array.isArray(messages.json?.items), `count=${messages.json?.items?.length}`);
const sample = messages.json?.items?.[0];
ok('message DTO has state/attachments/replyTo', Boolean(sample && typeof sample.state === 'string' && Array.isArray(sample.attachments) && 'replyTo' in sample));

const direct = await call('/api/conversations/direct', { method: 'POST', token: layla, body: { userId: me.json.id } });
ok('POST /conversations/direct', direct.status < 300 && Boolean(direct.json?.conversation?.id));
const sent = await call(`/api/conversations/${direct.json.conversation.id}/messages`, { method: 'POST', token: layla, body: { clientMessageId: `webcheck-${stamp}`, body: 'رسالة من فحص الويب' } });
ok('POST message 201', sent.status === 201 && sent.json?.duplicated === false);
const dupe = await call(`/api/conversations/${direct.json.conversation.id}/messages`, { method: 'POST', token: layla, body: { clientMessageId: `webcheck-${stamp}`, body: 'رسالة من فحص الويب' } });
ok('duplicate send → 200 duplicated', dupe.status === 200 && dupe.json?.duplicated === true);

console.log('\n[3] social endpoints');
const feed = await call('/api/feed?tab=following&limit=20', { token: layla });
ok('feed → {items, nextCursor}', feed.status === 200 && Array.isArray(feed.json?.items) && 'nextCursor' in feed.json);
const post = feed.json?.items?.[0];
ok('post DTO shape (viewer/media/counts)', Boolean(post && post.viewer && typeof post.viewer.liked === 'boolean' && Array.isArray(post.media) && typeof post.counts?.likes === 'number' && 'repostOf' in post));
if (post) {
  const like = await call(`/api/posts/${post.id}/like`, { method: 'POST', token: layla });
  ok('POST like', like.status < 300);
  const comments = await call(`/api/posts/${post.id}/comments?limit=5`, { token: layla });
  ok('GET comments → {items}', comments.status === 200 && Array.isArray(comments.json?.items));
  const comment = await call(`/api/posts/${post.id}/comments`, { method: 'POST', token: layla, body: { body: 'تعليق فحص' } });
  ok('POST comment → {post}', comment.status === 201 && Boolean(comment.json?.post?.id));
}
const trending = await call('/api/hashtags/trending');
ok('GET /hashtags/trending → {hashtags}', trending.status === 200 && Array.isArray(trending.json?.hashtags));
const search = await call('/api/search?q=سيادة&type=all&limit=10', { token: layla });
ok('GET /search → {users,posts,channels}', search.status === 200 && Array.isArray(search.json?.users) && Array.isArray(search.json?.posts) && Array.isArray(search.json?.channels));
const notifications = await call('/api/notifications?limit=10', { token: layla });
ok('GET /notifications → {items,unread}', notifications.status === 200 && Array.isArray(notifications.json?.items) && typeof notifications.json?.unread === 'number');
const profile = await call('/api/users/omar', { token: layla });
ok('GET /users/:username → {user,stats,viewer,posts,online}', profile.status === 200 && Boolean(profile.json?.user?.username) && Boolean(profile.json?.stats) && Boolean(profile.json?.viewer) && Array.isArray(profile.json?.posts));
const follow = await call(`/api/users/omar/follow`, { method: 'POST', token: token });
ok('POST follow by username', follow.status < 300);

console.log('\n[4] channels + calls');
const discovery = await call('/api/channels/discover?limit=10', { token: layla });
ok('GET channels/discover → {channels}', discovery.status === 200 && Array.isArray(discovery.json?.channels), `count=${discovery.json?.channels?.length}`);
const subscribed = await call('/api/channels/subscribed', { token: layla });
ok('GET channels/subscribed', subscribed.status === 200 && Array.isArray(subscribed.json?.channels));
const slug = discovery.json?.channels?.[0]?.slug;
if (slug) {
  const detail = await call(`/api/channels/${slug}`, { token: layla });
  ok('GET channels/:slug → {channel,members}', detail.status === 200 && Boolean(detail.json?.channel?.id) && Array.isArray(detail.json?.members));
  const posts = await call(`/api/channels/${detail.json.channel.id}/posts?limit=10`, { token: layla });
  ok('GET channel posts → {items}', posts.status === 200 && Array.isArray(posts.json?.items));
  ok('channel post DTO uses media[]', posts.json?.items?.length === 0 || Array.isArray(posts.json.items[0].media));
}
const ice = await call('/api/calls/ice', { token: layla });
ok('GET /calls/ice → {iceServers}', ice.status === 200 && Array.isArray(ice.json?.iceServers), JSON.stringify(ice.json?.iceServers));
const caps = await call('/api/calls/capabilities');
ok('GET /calls/capabilities', caps.status === 200 && typeof caps.json?.groupCalls === 'boolean');
const sessions = await call('/api/auth/sessions', { token: layla });
ok('GET /auth/sessions → array', sessions.status === 200 && Array.isArray(sessions.json) && 'current' in (sessions.json[0] ?? {}));
const devices = await call('/api/users/me/devices', { token: layla });
ok('GET /users/me/devices → array', devices.status === 200 && Array.isArray(devices.json));
const privacy = await call('/api/users/me/privacy', { method: 'PATCH', token: layla, body: { readReceipts: true } });
ok('PATCH /users/me/privacy', privacy.status < 300);
const exported = await call('/api/users/me/export', { token: layla });
ok('GET /users/me/export', exported.status === 200 && typeof exported.json === 'object');

console.log('\n[5] realtime through the web proxy');
{
  // Same handshake the browser performs: ticket over HTTP, then a WebSocket upgrade
  // on the *same* origin (the web server proxies /ws to the API).
  const { default: WebSocket } = await import('ws');
  const ticketRes = await call('/api/auth/realtime-ticket', { method: 'POST', token: layla, body: {} });
  ok('POST /auth/realtime-ticket', ticketRes.status === 200 && typeof ticketRes.json?.ticket === 'string');
  const wsUrl = (process.env.WEB_WS_URL ?? BASE.replace(/^http/, 'ws')) + '/ws?ticket=' + encodeURIComponent(ticketRes.json.ticket);
  const frame = await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); resolve(null); }, 8000);
    socket.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed.t === 'ready' || parsed.t === 'hello') { clearTimeout(timer); socket.close(); resolve(parsed); }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  ok('WebSocket upgrade through the web origin', Boolean(frame), frame ? JSON.stringify(frame).slice(0, 80) : 'no ready frame');
}

console.log('\n[6] authenticated media (browser tags cannot send headers)');
{
  // Upload a real PNG as layla, then fetch it the way an <img> does: no Authorization header,
  // only the short-lived media token. This is the exact code path the web UI uses.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'contract-media.png');
  const uploaded = await fetch(`${BASE}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${layla}` },
    body: form,
  });
  const uploadBody = await uploaded.json().catch(() => ({}));
  ok('POST /files (multipart upload)', uploaded.status === 201 && Boolean(uploadBody.attachment?.id), `status=${uploaded.status}`);

  const minted = await call('/api/auth/media-token', { method: 'POST', token: layla, body: {} });
  ok(
    'POST /auth/media-token → short-lived read-only token',
    minted.status === 200 && typeof minted.json?.token === 'string' && minted.json.expiresIn <= 300,
    `expiresIn=${minted.json?.expiresIn}`,
  );

  if (uploadBody.attachment?.id && minted.json?.token) {
    const mediaRes = await fetch(`${BASE}/api/files/${uploadBody.attachment.id}?token=${encodeURIComponent(minted.json.token)}`);
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    ok(
      'GET /files/:id?token= (no Authorization header)',
      mediaRes.status === 200 && mediaRes.headers.get('content-type') === 'image/png' && bytes.equals(png),
      `status=${mediaRes.status} bytes=${bytes.length}`,
    );
    const anonymous = await fetch(`${BASE}/api/files/${uploadBody.attachment.id}`);
    ok('GET /files/:id without credentials → 401', anonymous.status === 401, `status=${anonymous.status}`);
    const asBearer = await call('/api/users/me', { token: minted.json.token });
    ok('media token cannot be used as an access token', asBearer.status === 401, `status=${asBearer.status}`);
  }
}

console.log('\n[7] end-to-end encryption through the web origin (real Olm)');
{
  // This section drives the **real** Olm library (the same WASM the browser loads) through the
  // public API: publish devices, enable encryption, send envelopes, decrypt on the other side.
  // A stand-in key would prove field names but not that the platform works, and the checks below
  // (envelope scoping, refusals) only mean something against a genuinely encrypted conversation.
  const alice = await loginAs('cipher_a');
  const bob = await loginAs('cipher_b');
  if (!alice || !bob) {
    ok('seed accounts cipher_a / cipher_b exist (run `npm run seed`)', false);
  } else {
    const aliceEngine = await newOlmClient(alice);
    const bobEngine = await newOlmClient(bob);

    ok('session list exposes the current device id', typeof aliceEngine.deviceId === 'string', `deviceId=${aliceEngine.deviceId}`);
    ok('PUT /keys/identity/olm 200', aliceEngine.published.algorithm === 'olm-v1', JSON.stringify(aliceEngine.published));
    ok('POST /keys/prekeys/olm tops the pool up', aliceEngine.replenished > aliceEngine.published.oneTimeKeysStored, `before=${aliceEngine.published.oneTimeKeysStored} after=${aliceEngine.replenished}`);

    const inventory = await call('/api/keys/me', { token: alice.token });
    const own = inventory.json?.devices?.find((entry) => entry.deviceId === aliceEngine.deviceId);
    ok('GET /keys/me reports the Olm device + pool', own?.algorithm === 'olm-v1' && typeof own?.remainingOneTimePreKeys === 'number', JSON.stringify(own));

    const bundle = await call(`/api/keys/${bob.userId}`, { token: alice.token });
    const bobBundle = bundle.json?.bundles?.find((entry) => entry.deviceId === bobEngine.deviceId);
    ok('GET /keys/:id returns the peer device bundle', bundle.status === 200 && Boolean(bobBundle), `status=${bundle.status}`);
    ok('Olm bundle carries signing key + identity signature', Boolean(bobBundle?.signingKey && bobBundle?.identitySignature));
    ok('the peer bundle signature verifies locally', aliceEngine.verifyBundle(bobBundle) === true);

    // Both members must hold keys before a conversation can be switched to encrypted.
    const conv = await call('/api/conversations/direct', { method: 'POST', token: alice.token, body: { userId: bob.userId } });
    const convId = conv.json?.conversation?.id;
    const status = await call(`/api/conversations/${convId}/encryption`, { token: alice.token });
    ok('encryption status reports every participant ready', status.json?.ready === true, JSON.stringify(status.json?.participants));
    ok('participants name their algorithms', Array.isArray(status.json?.participants?.[0]?.algorithms));
    const enabled = await call(`/api/conversations/${convId}/encryption`, { method: 'POST', token: alice.token, body: { enabled: true } });
    ok('POST /conversations/:id/encryption enables it', enabled.json?.isEncrypted === true, `status=${enabled.status}`);

    // Real handshake: alice's outbound session produces a prekey message for bob's device.
    const secret = 'فحص العقد: رسالة مشفّرة فعلياً بين جهازين';
    const encrypted = aliceEngine.encryptFor(bobBundle, secret);
    ok('first message is a prekey message (type 0)', encrypted.payload.type === 0, encrypted.payload.type);
    ok('ciphertext contains no plaintext', !encrypted.envelope.ciphertext.includes(secret));

    const strangerDevice = '11111111-2222-4333-8444-555555555555';
    const foreign = await call(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      token: alice.token,
      body: {
        clientMessageId: `webcheck-olm-foreign-${stamp}`,
        body: '',
        encryptionScheme: 'olm-v1',
        envelopes: [{ deviceId: strangerDevice, scheme: 'olm-v1', ciphertext: encrypted.envelope.ciphertext }],
      },
    });
    ok('envelope for an unknown device is rejected', foreign.status === 400, `status=${foreign.status}`);

    const stored = await call(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      token: alice.token,
      body: { clientMessageId: `webcheck-olm-${stamp}`, body: '', encryptionScheme: 'olm-v1', envelopes: [encrypted.envelope] },
    });
    ok('ciphertext with an empty body is accepted', stored.status === 201 && stored.json?.message?.body === null, `status=${stored.status}`);
    ok('message DTO carries the scheme', stored.json?.message?.encryptionScheme === 'olm-v1');
    ok('the sender response leaks no envelope', Array.isArray(stored.json?.message?.envelopes) && stored.json.message.envelopes.length === 0);

    const plaintextIntoEncrypted = await call(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      token: alice.token,
      body: { clientMessageId: `webcheck-plain-${stamp}`, body: 'نص عادي داخل محادثة مشفّرة' },
    });
    ok('plaintext is refused inside an encrypted conversation', plaintextIntoEncrypted.status === 501, `status=${plaintextIntoEncrypted.status}`);

    const history = await call(`/api/conversations/${convId}/messages?limit=5`, { token: bob.token });
    const row = history.json?.items?.find((item) => item.id === stored.json.message.id);
    ok("the recipient's device receives its envelope", row?.envelopes?.length === 1 && row?.body === null, JSON.stringify({ env: row?.envelopes?.length, body: row?.body }));
    const decrypted = bobEngine.decryptFrom(aliceEngine.identityKey, aliceEngine.deviceId, row.envelopes[0].ciphertext);
    ok('the recipient decrypts the original text', decrypted === secret, decrypted);

    // A second device of the same user (a new login) has no envelope for that message.
    const bobSecondDevice = await loginAs('cipher_b');
    const otherDevice = await call(`/api/messages/${stored.json.message.id}/envelope`, { token: bobSecondDevice.token });
    ok('a different device of the same user gets no envelope', otherDevice.json?.envelope === null, JSON.stringify(otherDevice.json)?.slice(0, 120));
    const ownerDevice = await call(`/api/messages/${stored.json.message.id}/envelope`, { token: bob.token });
    ok('the addressed device does get its envelope', ownerDevice.json?.envelope?.ciphertext === encrypted.envelope.ciphertext, JSON.stringify(ownerDevice.json)?.slice(0, 80));

    const search = await call(`/api/messages/search?q=${encodeURIComponent('مشفّرة')}`, { token: bob.token });
    ok('encrypted messages are invisible to search', Array.isArray(search.json) && !search.json.some((hit) => hit.id === stored.json.message.id));

    const edit = await call(`/api/messages/${stored.json.message.id}`, { method: 'PATCH', token: alice.token, body: { body: 'تعديل' } });
    ok('editing a ciphertext message is refused', edit.status === 501, `status=${edit.status}`);

    // Leave the demo accounts as they were found: unencrypted, sessions closed.
    await call(`/api/conversations/${convId}/encryption`, { method: 'POST', token: alice.token, body: { enabled: false } });
    await call('/api/auth/logout', { method: 'POST', token: alice.token });
    await call('/api/auth/logout', { method: 'POST', token: bob.token });
    await call('/api/auth/logout', { method: 'POST', token: bobSecondDevice.token });
  }

  const missing = await call('/api/messages/00000000-0000-4000-8000-000000000000/envelope', { token });
  ok('envelope endpoint 404s for an unknown message', missing.status === 404, `status=${missing.status}`);
  const malformed = await call('/api/messages/not-a-uuid/envelope', { token });
  ok('envelope endpoint 400s for a malformed id', malformed.status === 400, `status=${malformed.status}`);
}

console.log('\n[8] cleanup (the script must not leak sessions)');
{
  // Each run logs in as the demo user; without this, repeated runs would eventually hit the
  // 10-active-session cap. Logging out is also the last real behaviour we assert here.
  const out = await call('/api/auth/logout', { method: 'POST', token: layla });
  ok('POST /auth/logout', out.status === 200, `status=${out.status}`);
  const fresh = await call('/api/auth/logout', { method: 'POST', token });
  ok('registered check user logged out', fresh.status === 200, `status=${fresh.status}`);
}

console.log(`\n${failures === 0 ? 'ALL WEB API CONTRACT CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
