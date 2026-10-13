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

console.log(`\n${failures === 0 ? 'ALL WEB API CONTRACT CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
