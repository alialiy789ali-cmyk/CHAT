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

console.log('\n[7] end-to-end encryption endpoints (web client contract)');
{
  // The web client publishes an Olm device, asks for a peer bundle, and reads its own envelope.
  // A stand-in identity is enough here: this section checks the *contract* the UI depends on
  // (field names, status codes, scoping). Real crypto in the browser is covered by
  // `npm run test:e2ee -w @sovereign/web`, which drives the actual client modules.
  const fakeKey = Buffer.alloc(32, 7).toString('base64');
  const fakeSig = Buffer.alloc(64, 9).toString('base64');

  const sessions = await call('/api/auth/sessions', { token });
  const deviceId = sessions.json?.find?.((entry) => entry.current)?.deviceId;
  ok('session list exposes the current device id', typeof deviceId === 'string', `deviceId=${deviceId}`);

  const publish = await call('/api/keys/identity/olm', {
    method: 'PUT',
    token,
    body: {
      deviceId,
      identityKey: fakeKey,
      signingKey: fakeKey,
      signature: fakeSig,
      oneTimeKeys: [{ id: 'AAAAAA', key: fakeKey }],
    },
  });
  ok('PUT /keys/identity/olm 200', publish.status === 200 && publish.json?.algorithm === 'olm-v1', `status=${publish.status}`);

  const inventory = await call('/api/keys/me', { token });
  const own = inventory.json?.devices?.find((entry) => entry.deviceId === deviceId);
  ok('GET /keys/me reports the Olm device + pool', own?.algorithm === 'olm-v1' && typeof own?.remainingOneTimePreKeys === 'number', JSON.stringify(own));

  const bundle = await call(`/api/keys/${me.json.id}`, { token: layla });
  const first = bundle.json?.bundles?.[0];
  ok('GET /keys/:id returns a scheme-tagged bundle', bundle.status === 200 && typeof first?.algorithm === 'string' && typeof first?.identityKey === 'string');
  ok('Olm bundle carries signing key + signature', Boolean(first?.signingKey && first?.identitySignature) || first?.algorithm === 'libsignal-v1');

  const replenish = await call('/api/keys/prekeys/olm', {
    method: 'POST',
    token,
    body: { deviceId, oneTimeKeys: [{ id: 'AAAAAB', key: fakeKey }] },
  });
  ok('POST /keys/prekeys/olm tops the pool up', replenish.status === 200 && replenish.json?.oneTimeKeysStored >= 2, `status=${replenish.status}`);

  // Envelope scoping: a ciphertext addressed to a device outside the conversation is refused,
  // while one addressed to a member device is stored and never echoed back to the sender.
  const conv = await call('/api/conversations/direct', { method: 'POST', token, body: { userId: laylaMe.json.id } });
  const convId = conv.json?.conversation?.id;
  const strangerDevice = '11111111-2222-4333-8444-555555555555';
  const foreign = await call(`/api/conversations/${convId}/messages`, {
    method: 'POST',
    token,
    body: {
      clientMessageId: `webcheck-olm-foreign-${stamp}`,
      body: '',
      encryptionScheme: 'olm-v1',
      envelopes: [{ deviceId: strangerDevice, scheme: 'olm-v1', ciphertext: JSON.stringify({ type: 1, body: 'x' }) }],
    },
  });
  ok('envelope for an unknown device is rejected', foreign.status === 400, `status=${foreign.status}`);

  const stored = await call(`/api/conversations/${convId}/messages`, {
    method: 'POST',
    token,
    body: {
      clientMessageId: `webcheck-olm-${stamp}`,
      body: '',
      encryptionScheme: 'olm-v1',
      envelopes: [{ deviceId, scheme: 'olm-v1', ciphertext: JSON.stringify({ type: 1, body: 'ciphertext-for-own-device' }) }],
    },
  });
  ok('ciphertext with an empty body is accepted', stored.status === 201 && stored.json?.message?.body === null, `status=${stored.status}`);
  ok('message DTO carries the scheme', stored.json?.message?.encryptionScheme === 'olm-v1');
  ok('sender response leaks no envelope', Array.isArray(stored.json?.message?.envelopes) && stored.json.message.envelopes.length === 0);
  const mine = await call(`/api/messages/${stored.json.message.id}/envelope`, { token });
  ok('own envelope is returned to the owning device', mine.status === 200 && mine.json?.envelope?.ciphertext?.includes('ciphertext-for-own-device'), JSON.stringify(mine.json)?.slice(0, 120));
  const notMine = await call(`/api/messages/${stored.json.message.id}/envelope`, { token: layla });
  ok('the peer device gets no envelope for it', notMine.status === 200 && notMine.json?.envelope === null, JSON.stringify(notMine.json)?.slice(0, 120));

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
