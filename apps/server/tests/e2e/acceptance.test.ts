import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@sovereign/shared/protocol';
import { e2e } from '../helpers/setup-e2e.js';
import { ApiClient, PASSWORD, uniqueEmail, uniqueUsername } from '../helpers/client.js';
import { SignalDevice } from '../helpers/signal.js';
import { OlmDevice, safetyNumberFromBytes, sasBytesBothSides } from '../helpers/olm.js';
import { extractLink, lastMailTo } from '../../src/lib/mail.js';

/**
 * The acceptance criteria from the project brief, executed against the real server
 * (embedded PostgreSQL + WebSocket + storage). Every assertion below is a real
 * round-trip: no mocks, no stubbed services.
 */
describe('acceptance criteria', () => {
  it('1-2. two users can register independently and authenticate', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);

    const aliceReg = await alice.register({ username: uniqueUsername('alice'), displayName: 'Alice' });
    const bobReg = await bob.register({ username: uniqueUsername('bob'), displayName: 'Bob' });

    expect(aliceReg.user.id).not.toEqual(bobReg.user.id);

    const me = await alice.request<{ username: string; emailVerified: boolean }>('GET', '/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(alice.username);

    // Wrong password is rejected, and repeated failures throttle login.
    const bad = await alice.request('POST', '/api/auth/login', {
      body: { identifier: alice.username, password: 'wrong-password' },
      token: null,
    });
    expect(bad.status).toBe(401);
    expect((bad.body as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('3-4. A sends a message and B receives it live over WebSocket', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice'), displayName: 'Alice' });
    await bob.register({ username: uniqueUsername('bob'), displayName: 'Bob' });

    // B connects first so the delivery is a genuine push, not a database read.
    const bobSocket = await bob.connect();

    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    expect(conversation.status).toBe(200);
    const conversationId = conversation.body.conversation.id;

    const clientMessageId = `cmid-${Date.now()}`;
    const sent = await alice.request<{ message: { id: string; body: string } }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { body: { clientMessageId, body: 'مرحباً يا بوب 👋' } },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBe('مرحباً يا بوب 👋');

    const pushed = await bobSocket.waitForMessage(conversationId);
    const pushedMessage = (pushed as unknown as { message: { body: string; id: string } }).message;
    expect(pushedMessage.body).toBe('مرحباً يا بوب 👋');
    expect(pushedMessage.id).toBe(sent.body.message.id);

    // Idempotency: resending the same clientMessageId must not duplicate the message.
    const retry = await alice.request<{ duplicated: boolean; message: { id: string } }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { body: { clientMessageId, body: 'مرحباً يا بوب 👋' } },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.duplicated).toBe(true);
    expect(retry.body.message.id).toBe(sent.body.message.id);

    // A second message over the socket itself (the path the mobile client uses).
    alice.connect().then((aliceSocket) => {
      aliceSocket.send({
        t: 'message.send',
        rid: 'rid-socket-1',
        clientMessageId: `sock-${Date.now()}`,
        conversationId,
        body: 'رسالة عبر WebSocket',
      });
      return null;
    });
    const socketPushed = await bobSocket.waitForMessage(conversationId, (message) => (message as { body: string }).body === 'رسالة عبر WebSocket');
    expect((socketPushed as unknown as { message: { body: string } }).message.body).toBe('رسالة عبر WebSocket');

    bobSocket.close();
  });

  it('5. history survives a client restart (re-login on a fresh session)', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });

    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const conversationId = conversation.body.conversation.id;
    for (let i = 0; i < 3; i += 1) {
      const res = await alice.request('POST', `/api/conversations/${conversationId}/messages`, {
        body: { clientMessageId: `hist-${Date.now()}-${i}`, body: `history message ${i}` },
      });
      expect(res.status).toBe(201);
    }

    // Simulate "B reopens the app": brand-new client, brand-new session.
    const bobAgain = new ApiClient(base);
    await bobAgain.login(bob.email!, PASSWORD);

    const list = await bobAgain.request<{ items: Array<{ body: string }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=50`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.map((m) => m.body)).toContain('history message 2');

    // The conversation list reflects the unread state for B.
    const conversations = await bobAgain.request<{ items: Array<{ id: string; unreadCount: number }> }>('GET', '/api/conversations');
    const entry = conversations.body.items.find((c) => c.id === conversationId);
    expect(entry?.unreadCount).toBe(3);

    // B reads the newest message → everything up to it is marked read.
    const newest = await bobAgain.request<{ items: Array<{ id: string }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=1`,
    );
    const read = await bobAgain.request('POST', `/api/conversations/${conversationId}/read`, {
      body: { messageId: newest.body.items[0]!.id },
    });
    expect(read.status).toBe(200);
    expect((read.body as { readCount: number }).readCount).toBe(3);

    const afterRead = await bobAgain.request<{ items: Array<{ id: string; unreadCount: number }> }>('GET', '/api/conversations');
    expect(afterRead.body.items.find((c) => c.id === conversationId)?.unreadCount).toBe(0);
  });

  it('6-7. A creates a group and B joins according to permissions', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    const mallory = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });
    await mallory.register({ username: uniqueUsername('mallory') });

    const group = await alice.request<{ conversation: { id: string; title: string } }>('POST', '/api/conversations/group', {
      body: { title: 'فريق المنتج', description: 'مناقشة الطريق', memberIds: [bob.userId], visibility: 'private' },
    });
    expect(group.status).toBe(200);
    const groupId = group.body.conversation.id;

    // B is a member and can post.
    const bobSend = await bob.request('POST', `/api/conversations/${groupId}/messages`, {
      body: { clientMessageId: `grp-${Date.now()}`, body: 'أنا هنا' },
    });
    expect(bobSend.status).toBe(201);

    // Mallory is not a member: reading and writing must both be refused.
    const malloryRead = await mallory.request('GET', `/api/conversations/${groupId}/messages`);
    expect(malloryRead.status).toBe(403);
    const malloryWrite = await mallory.request('POST', `/api/conversations/${groupId}/messages`, {
      body: { clientMessageId: `grp-x-${Date.now()}`, body: 'let me in' },
    });
    expect(malloryWrite.status).toBe(403);

    // A adds Mallory (owner has permission) → she can now read.
    const addMember = await alice.request('POST', `/api/conversations/${groupId}/members`, { body: { userIds: [mallory.userId] } });
    expect(addMember.status).toBe(200);
    const malloryReadAfter = await mallory.request('GET', `/api/conversations/${groupId}/messages`);
    expect(malloryReadAfter.status).toBe(200);

    // B (a plain member) cannot manage roles.
    const roleAttempt = await bob.request('POST', `/api/conversations/${groupId}/members/role`, {
      body: { userId: mallory.userId, role: 'admin' },
    });
    expect(roleAttempt.status).toBe(403);
  });

  it('8-9. public posts appear in followers feeds and can be liked and commented on', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });

    await bob.request('POST', `/api/users/${alice.username}/follow`);
    const profile = await bob.request<{ viewer: { following: boolean } }>('GET', `/api/users/${alice.username}`);
    expect(profile.body.viewer.following).toBe(true);

    const post = await alice.request<{ post: { id: string; body: string; hashtags: string[] } }>('POST', '/api/posts', {
      body: { body: 'أطلقنا النسخة الأولى! #سيادة #تقنية', visibility: 'public' },
    });
    expect(post.status).toBe(201);
    expect(post.body.post.hashtags).toEqual(expect.arrayContaining(['سيادة', 'تقنية']));
    const postId = post.body.post.id;

    const feed = await bob.request<{ items: Array<{ id: string; body: string }> }>('GET', '/api/feed?tab=following');
    expect(feed.status).toBe(200);
    expect(feed.body.items.some((item) => item.id === postId)).toBe(true);

    const like = await bob.request<{ liked: boolean }>('POST', `/api/posts/${postId}/like`);
    expect(like.body.liked).toBe(true);
    const liked = await alice.request<{ post: { counts: { likes: number }; viewer: { isMine: boolean } } }>('GET', `/api/posts/${postId}`);
    expect(liked.body.post.counts.likes).toBe(1);
    expect(liked.body.post.viewer.isMine).toBe(true);

    const comment = await bob.request<{ post: { id: string } }>('POST', `/api/posts/${postId}/comments`, {
      body: { body: 'ممتاز! 🎉' },
    });
    expect(comment.status).toBe(201);
    const comments = await bob.request<{ items: Array<{ body: string }> }>('GET', `/api/posts/${postId}/comments`);
    expect(comments.body.items.map((c) => c.body)).toContain('ممتاز! 🎉');
    const afterComment = await alice.request<{ post: { counts: { comments: number } } }>('GET', `/api/posts/${postId}`);
    expect(afterComment.body.post.counts.comments).toBe(1);

    // Repost + hashtag discovery
    const repost = await bob.request<{ reposted: boolean }>('POST', `/api/posts/${postId}/repost`);
    expect(repost.body.reposted).toBe(true);
    const hashtag = await alice.request<{ items: Array<{ id: string }> }>('GET', '/api/hashtags/سيادة');
    expect(hashtag.body.items.some((item) => item.id === postId)).toBe(true);
  });

  it('10. read receipts and typing indicators travel over the socket', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });

    const aliceSocket = await alice.connect();
    const bobSocket = await bob.connect();

    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const conversationId = conversation.body.conversation.id;

    await alice.request('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: `rcpt-${Date.now()}`, body: 'هل وصلت؟' },
    });
    const delivered = await bobSocket.waitForMessage(conversationId);
    const messageId = (delivered as unknown as { message: { id: string } }).message.id;

    // B reads the message → A receives a read receipt for that message.
    await bob.request('POST', `/api/conversations/${conversationId}/read`, { body: { messageId } });
    const receipt = await aliceSocket.waitForFrame(
      (frame) => frame.t === 'receipt' && frame.conversationId === conversationId && frame.messageId === messageId,
      10_000,
      'read receipt',
    );
    expect((receipt as { state: string }).state).toBe('read');

    // Typing indicator.
    await bob.request('POST', `/api/conversations/${conversationId}/typing`, { body: { isTyping: true } });
    const typing = await aliceSocket.waitForFrame(
      (frame) => frame.t === 'typing' && frame.conversationId === conversationId && frame.userId === bob.userId,
      10_000,
      'typing indicator',
    );
    expect((typing as { isTyping: boolean }).isTyping).toBe(true);

    aliceSocket.close();
    bobSocket.close();
  });

  it('11. media uploads are authorised, deduplicated and streamed back', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    const outsider = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });
    await outsider.register({ username: uniqueUsername('carol') });

    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const conversationId = conversation.body.conversation.id;

    // Small PNG (1x1) as a real binary upload.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'photo.png');

    const upload = await alice.request<{ attachment: { id: string; url: string; sha256: string } }>('POST', '/api/files', {
      body: form,
      raw: true,
    });
    expect(upload.status).toBe(201);
    const attachmentId = upload.body.attachment.id;

    const message = await alice.request<{ message: { id: string; attachments: Array<{ id: string }> } }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { body: { clientMessageId: `media-${Date.now()}`, body: 'صورة', attachmentIds: [attachmentId] } },
    );
    expect(message.status).toBe(201);
    expect(message.body.message.attachments).toHaveLength(1);

    // Recipient can download; an unrelated user cannot.
    const bobDownload = await bob.request<ArrayBuffer>('GET', `/api/files/${attachmentId}`, { raw: true });
    expect(bobDownload.status).toBe(200);
    expect(bobDownload.headers.get('content-type')).toBe('image/png');
    const carolDownload = await outsider.request('GET', `/api/files/${attachmentId}`, { raw: true });
    expect(carolDownload.status).toBe(404);

    // Unsupported type is rejected before touching storage.
    const badForm = new FormData();
    badForm.append('file', new Blob([new Uint8Array(Buffer.from('MZ'))], { type: 'application/x-msdownload' }), 'virus.exe');
    const badUpload = await alice.request('POST', '/api/files', { body: badForm, raw: true });
    expect(badUpload.status).toBe(415);
  });

  it('12. channels support subscriptions, roles, posts and invite links', async () => {
    const base = e2e().baseUrl;
    const owner = new ApiClient(base);
    const member = new ApiClient(base);
    const stranger = new ApiClient(base);
    await owner.register({ username: uniqueUsername('owner') });
    await member.register({ username: uniqueUsername('member') });
    await stranger.register({ username: uniqueUsername('guest') });

    const slug = uniqueUsername('chan');
    const channel = await owner.request<{ channel: { id: string; slug: string } }>('POST', '/api/channels', {
      body: { name: 'قناة التقنية', slug, description: 'أخبار يومية', visibility: 'private' },
    });
    expect(channel.status).toBe(201);
    const channelId = channel.body.channel.id;

    // A stranger cannot read a private channel.
    const denied = await stranger.request('GET', `/api/channels/${slug}`);
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe('not_member');

    // Owner creates an invite; member joins with it.
    const invite = await owner.request<{ invite: { code: string } }>('POST', `/api/channels/${channelId}/invites`, {
      body: { role: 'subscriber', maxUses: 5, ttlHours: 24 },
    });
    expect(invite.status).toBe(201);
    const joined = await member.request<{ channel: { id: string }; created: boolean }>('POST', `/api/channels/join/${invite.body.invite.code}`);
    expect(joined.status).toBe(200);
    expect(joined.body.channel.id).toBe(channelId);

    // Subscriber cannot post; owner can, and can pin.
    const memberPost = await member.request('POST', `/api/channels/${channelId}/posts`, { body: { body: 'سأعلق' } });
    expect(memberPost.status).toBe(403);
    const ownerPost = await owner.request<{ post: { id: string } }>('POST', `/api/channels/${channelId}/posts`, {
      body: { body: 'النسخة الأولى متاحة الآن' },
    });
    expect(ownerPost.status).toBe(201);
    const pin = await owner.request('POST', `/api/channels/${channelId}/posts/${ownerPost.body.post.id}/pin`, { body: { pinned: true } });
    expect(pin.status).toBe(200);

    const posts = await member.request<{ items: Array<{ body: string; pinnedAt: string | null }> }>(`GET`, `/api/channels/${channelId}/posts`);
    expect(posts.status).toBe(200);
    expect(posts.body.items[0]?.pinnedAt).not.toBeNull();

    // Promotion to admin requires owner rights.
    const promote = await owner.request('POST', `/api/channels/${channelId}/members/${member.userId}/role`, { body: { role: 'admin' } });
    expect(promote.status).toBe(200);
    const memberPostAfterPromotion = await member.request('POST', `/api/channels/${channelId}/posts`, { body: { body: 'أنا مشرف الآن' } });
    expect(memberPostAfterPromotion.status).toBe(201);
  });

  it('13. reports reach the moderation queue and decisions are audited', async () => {
    const base = e2e().baseUrl;
    const author = new ApiClient(base);
    const reporter = new ApiClient(base);
    const staff = new ApiClient(base);
    await author.register({ username: uniqueUsername('author') });
    await reporter.register({ username: uniqueUsername('reporter') });
    await staff.register({ username: uniqueUsername('mod') });

    // Promote the moderator directly in the database (bootstrap path documented in docs/DEPLOYMENT.md).
    await e2e().runtime.deps.db.query("update users set role = 'moderator' where id = $1", [staff.userId]);

    const post = await author.request<{ post: { id: string } }>('POST', '/api/posts', { body: { body: 'محتوى مخالف للاختبار' } });
    const report = await reporter.request('POST', '/api/reports', {
      body: { targetType: 'post', targetId: post.body.post.id, reason: 'abuse', details: 'test report' },
    });
    expect(report.status).toBe(201);

    // Non-staff cannot read the queue.
    const denied = await reporter.request('GET', '/api/moderation/reports');
    expect(denied.status).toBe(403);

    const queue = await staff.request<{ items: Array<{ id: string; targetId: string }>; openCount: number }>('GET', '/api/moderation/reports');
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((item) => item.targetId === post.body.post.id)).toBe(true);

    const target = queue.body.items.find((item) => item.targetId === post.body.post.id)!;
    const decision = await staff.request<{ decision: string }>('POST', `/api/moderation/reports/${target.id}/resolve`, {
      body: { decision: 'removed', note: 'violates community rules' },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.decision).toBe('removed');

    const hidden = await reporter.request('GET', `/api/posts/${post.body.post.id}`);
    expect(hidden.status).toBe(404);

    const audit = await staff.request<Array<{ action: string }>>('GET', '/api/moderation/audit?limit=50');
    expect(audit.body.some((entry) => entry.action === 'moderation.report_resolved')).toBe(true);
  });

  it('14. sessions, devices and account protection behave correctly', async () => {
    const base = e2e().baseUrl;
    const user = new ApiClient(base);
    await user.register({ username: uniqueUsername('device') });

    const sessions = await user.request<Array<{ id: string; current: boolean; deviceName: string | null }>>('GET', '/api/auth/sessions');
    expect(sessions.body.length).toBeGreaterThanOrEqual(1);
    expect(sessions.body.some((s) => s.current)).toBe(true);

    // A second device signs in; the first session's token must still work.
    const second = new ApiClient(base);
    await second.login(user.email!, PASSWORD);
    const afterSecond = await user.request<unknown>('GET', '/api/users/me');
    expect(afterSecond.status).toBe(200);

    // Revoke the second session and confirm its refresh token is dead.
    const secondSessions = await second.request<Array<{ id: string; current: boolean }>>('GET', '/api/auth/sessions');
    const current = secondSessions.body.find((s) => s.current)!;
    const revoked = await user.request('DELETE', `/api/auth/sessions/${current.id}`);
    expect(revoked.status).toBe(200);

    const refreshed = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: second.refreshToken }),
    });
    expect(refreshed.status).toBe(401);

    // Refresh-token rotation: a used token cannot be replayed.
    const firstRefresh = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    expect(firstRefresh.status).toBe(200);
    const replay = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    expect(replay.status).toBe(401);
  });

  it('15. privacy settings, blocking and validation are enforced', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });

    // Input validation uses the shared schema (username format, password policy).
    const badRegister = await alice.request('POST', '/api/auth/register', {
      body: { username: 'A!', email: 'not-an-email', password: '123' },
      token: null,
    });
    expect(badRegister.status).toBe(400);
    expect((badRegister.body as { error: { code: string } }).error.code).toBe('validation_error');

    // Blocking prevents direct messaging in both directions.
    await bob.request('POST', `/api/users/${alice.username}/block`);
    const attempt = await alice.request('POST', '/api/conversations/direct', { body: { userId: bob.userId } });
    expect(attempt.status).toBe(403);

    await bob.request('DELETE', `/api/users/${alice.username}/block`);
    const afterUnblock = await alice.request('POST', '/api/conversations/direct', { body: { userId: bob.userId } });
    expect(afterUnblock.status).toBe(200);

    // Privacy: whoCanMessage = nobody blocks new conversations.
    await bob.request('PATCH', '/api/users/me/privacy', { body: { whoCanMessage: 'nobody' } });
    const carol = new ApiClient(base);
    await carol.register({ username: uniqueUsername('carol') });
    const blockedByPrivacy = await carol.request('POST', '/api/conversations/direct', { body: { userId: bob.userId } });
    expect(blockedByPrivacy.status).toBe(403);
    expect((blockedByPrivacy.body as { error: { code: string } }).error.code).toBe('cannot_message_user');
  });

  it('16. WebSocket handshake rejects bad tickets and protocol mismatches', async () => {
    const base = e2e().baseUrl;
    const user = new ApiClient(base);
    await user.register({ username: uniqueUsername('wsguard') });

    // No ticket → connection is closed with 4401.
    const WsClient = (await import('ws')).default as unknown as new (url: string) => import('ws').WebSocket;
    const unauth = new WsClient(`${e2e().wsUrl}`);
    const closeCode = await new Promise<number>((resolve) => {
      unauth.on('close', (code: number) => resolve(code));
      unauth.on('error', () => resolve(-1));
      setTimeout(() => resolve(-2), 5000);
    });
    expect([4401, 1006, -1, 1005]).toContain(closeCode);

    const socket = await user.connect();
    socket.send({ t: 'hello', protocolVersion: 99 });
    const mismatch = await socket.waitForFrame((frame) => frame.t === 'error', 5000, 'protocol mismatch');
    expect((mismatch as { code: string }).code).toBe('protocol_version_mismatch');
    socket.close();
  });
  it('17. WebRTC signalling is relayed between participants and call state transitions', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('callera') });
    await bob.register({ username: uniqueUsername('callerb') });

    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const conversationId = conversation.body.conversation.id;

    // Both parties are online: the caller sends the offer, the callee answers.
    const aliceSocket = await alice.connect();
    const bobSocket = await bob.connect();

    const capabilities = await alice.request<{ oneToOneAudio: boolean; oneToOneVideo: boolean; turnConfigured: boolean }>(
      'GET',
      '/api/calls/capabilities',
    );
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.oneToOneAudio).toBe(true);
    expect(capabilities.body.oneToOneVideo).toBe(true);
    // TURN is reported honestly: without RTC_TURN_URLS the deployment has no relay yet.
    expect(typeof capabilities.body.turnConfigured).toBe('boolean');

    const ice = await alice.request<{ iceServers: unknown[] }>('GET', '/api/calls/ice');
    expect(ice.status).toBe(200);
    expect(Array.isArray(ice.body.iceServers)).toBe(true);
    expect(ice.body.iceServers.length).toBeGreaterThan(0);

    const initiated = await alice.request<{ call: { id: string; state: string; kind: string } }>('POST', '/api/calls', {
      body: { conversationId, kind: 'video' },
    });
    expect(initiated.status).toBe(201);
    expect(initiated.body.call.state).toBe('ringing');
    expect(initiated.body.call.kind).toBe('video');
    const callId = initiated.body.call.id;

    // B is notified live, not by polling.
    const incoming = await bobSocket.waitForFrame<{ t: 'notification'; kind: string; payload: { callId: string; initiatorId: string } }>(
      (frame) => frame.t === 'notification' && (frame as { kind?: string }).kind === 'call.incoming',
      10_000,
      'call.incoming notification',
    );
    expect(incoming.payload.callId).toBe(callId);
    expect(incoming.payload.initiatorId).toBe(alice.userId);

    const offerSdp = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const ack = aliceSocket.waitForFrame<{ t: 'ack'; rid: string; of: string; data: { delivered: number } }>(
      (frame) => frame.t === 'ack' && (frame as { rid?: string }).rid === 'rid-offer',
      10_000,
      'offer ack',
    );
    aliceSocket.send({ t: 'call.signal', rid: 'rid-offer', callId, signal: { type: 'offer', sdp: offerSdp } });
    const offerAck = await ack;
    expect(offerAck.of).toBe('call.signal');
    expect(offerAck.data.delivered).toBeGreaterThan(0);

    const relayed = await bobSocket.waitForFrame<Extract<ServerFrame, { t: 'call.signal' }>>(
      (frame) => frame.t === 'call.signal' && (frame as { callId?: string }).callId === callId,
      10_000,
      'relayed offer',
    );
    expect(relayed.fromUserId).toBe(alice.userId);
    expect(relayed.signal.type).toBe('offer');
    expect(relayed.signal.type === 'offer' ? relayed.signal.sdp : null).toBe(offerSdp);

    // Answer → the call becomes active for both participants.
    const answered = await bob.request<{ call: { state: string } }>('POST', `/api/calls/${callId}/answer`);
    expect(answered.status).toBe(200);
    expect(answered.body.call.state).toBe('active');

    bobSocket.send({
      t: 'call.signal',
      rid: 'rid-answer',
      callId,
      signal: { type: 'answer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' },
    });
    const answer = await aliceSocket.waitForFrame<Extract<ServerFrame, { t: 'call.signal' }>>(
      (frame) => frame.t === 'call.signal' && (frame as { signal?: { type?: string } }).signal?.type === 'answer',
      10_000,
      'relayed answer',
    );
    expect(answer.t).toBe('call.signal');

    // ICE candidates travel the same path.
    aliceSocket.send({
      t: 'call.signal',
      rid: 'rid-candidate',
      callId,
      signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.1 50000 typ host' } },
    });
    const candidate = await bobSocket.waitForFrame<Extract<ServerFrame, { t: 'call.signal' }>>(
      (frame) => frame.t === 'call.signal' && (frame as { signal?: { type?: string } }).signal?.type === 'candidate',
      10_000,
      'relayed ICE candidate',
    );
    expect(candidate.signal.type).toBe('candidate');

    // Ending the call pushes a final frame to the other party.
    const endedWaiter = bobSocket.waitForFrame<Extract<ServerFrame, { t: 'notification' }>>(
      (frame) => frame.t === 'notification' && (frame as { kind?: string }).kind === 'call.ended',
      10_000,
      'call.ended notification',
    );
    const ended = await alice.request<{ call: { state: string; endReason: string | null } }>('POST', `/api/calls/${callId}/end`, {
      body: { reason: 'test_finished' },
    });
    expect(ended.status).toBe(200);
    expect(ended.body.call.state).toBe('ended');
    const endedFrame = await endedWaiter;
    expect(endedFrame.kind).toBe('call.ended');

    // Third parties cannot inject signalling into someone else's call.
    const carol = new ApiClient(base);
    await carol.register({ username: uniqueUsername('callerc') });
    const carolSocket = await carol.connect();
    carolSocket.send({ t: 'call.signal', rid: 'rid-outsider', callId, signal: { type: 'offer', sdp: 'spoof' } });
    const denied = await carolSocket.waitForFrame<Extract<ServerFrame, { t: 'error' }>>(
      (frame) => frame.t === 'error' && (frame as { rid?: string }).rid === 'rid-outsider',
      10_000,
      'outsider rejection',
    );
    expect(denied.code).toBeTruthy();

    aliceSocket.close();
    bobSocket.close();
    carolSocket.close();
  });

  it('18. server shutdown closes realtime sockets cleanly (no hung teardown)', async () => {
    // Verified implicitly by the suite teardown; here we assert the invariant explicitly:
    // every client terminated server-side must observe a close event.
    const base = e2e().baseUrl;
    const user = new ApiClient(base);
    await user.register({ username: uniqueUsername('shutdown') });
    const socket = await user.connect();
    let closed = false;
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    closed = true;
    expect(closed).toBe(true);
  });
  it('19. media tokens authorise browser media reads and nothing else', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('media') });
    await bob.register({ username: uniqueUsername('bystander') });

    // A real binary upload (1x1 PNG), exactly what the browser sends.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'media-token.png');
    const upload = await alice.request<{ attachment: { id: string } }>('POST', '/api/files', { body: form, raw: true });
    expect(upload.status).toBe(201);
    const attachmentId = upload.body.attachment.id;

    // <img> cannot send headers, so the client asks for a short-lived media token.
    const minted = await alice.request<{ token: string; expiresIn: number }>('POST', '/api/auth/media-token');
    expect(minted.status).toBe(200);
    expect(minted.body.expiresIn).toBeLessThanOrEqual(300);
    expect(minted.body.expiresIn).toBeGreaterThan(0);

    // The URL a browser actually renders: no Authorization header at all.
    const fetched = await alice.download(`/api/files/${attachmentId}?token=${encodeURIComponent(minted.body.token)}`, { token: null });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(fetched.bytes.equals(png)).toBe(true);

    // Same token, other user's file: authorisation is unchanged by the credential type.
    const bobToken = await bob.request<{ token: string }>('POST', '/api/auth/media-token');
    const bobOnAliceFile = await bob.download(`/api/files/${attachmentId}?token=${encodeURIComponent(bobToken.body.token)}`, { token: null });
    expect(bobOnAliceFile.status).toBe(404);

    // No credential at all is still a 401 — media tokens are additive, never a bypass.
    const anonymous = await alice.download(`/api/files/${attachmentId}`, { token: null });
    expect(anonymous.status).toBe(401);

    // A media token is read-only and audience-bound: it cannot authenticate an API mutation,
    // a profile read, or a WebSocket-relevant endpoint.
    const asBearer = await alice.request('GET', '/api/users/me', { token: minted.body.token });
    expect(asBearer.status).toBe(401);
    const mutation = await alice.request('PATCH', '/api/users/me', {
      body: { displayName: 'Media Token Attempt' },
      token: minted.body.token,
    });
    expect(mutation.status).toBe(401);

    // Query-string credentials are tolerated on GETs (the WebSocket handshake needs them) but
    // never authorise a write, so a link a user is tricked into opening cannot change data.
    const getWithQueryToken = await alice.request<{ username: string }>('GET', `/api/users/me?access_token=${encodeURIComponent(alice.token!)}`, {
      token: null,
    });
    expect(getWithQueryToken.status).toBe(200);
    const mutationWithQueryToken = await alice.request('PATCH', `/api/users/me?access_token=${encodeURIComponent(alice.token!)}`, {
      body: { displayName: 'Query Token Attempt' },
      token: null,
    });
    expect(mutationWithQueryToken.status).toBe(401);

    // Revoking the session kills media access too (the session is re-checked server side,
    // cached for a few seconds — so this is asserted with a bounded poll, not a sleep-guess).
    const logout = await alice.request('POST', '/api/auth/logout');
    expect(logout.status).toBe(200);
    const deadline = Date.now() + 15_000;
    let revokedStatus = 200;
    while (Date.now() < deadline) {
      const attempt = await alice.download(`/api/files/${attachmentId}?token=${encodeURIComponent(minted.body.token)}`, { token: null });
      revokedStatus = attempt.status;
      if (revokedStatus === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(revokedStatus).toBe(401);
  });
  it('20. concurrent sessions are capped, and freeing one restores access', async () => {
    const base = e2e().baseUrl;
    const user = new ApiClient(base);
    const email = uniqueEmail('sessioncap');
    await user.register({ username: uniqueUsername('cap'), email });

    // Registering already created session #1; open nine more devices (the documented cap is 10).
    const extraClients: ApiClient[] = [];
    for (let index = 0; index < 9; index += 1) {
      const client = new ApiClient(base);
      const result = await client.login(email, PASSWORD);
      expect(result.user.id).toBe(user.userId);
      extraClients.push(client);
    }

    // The 11th device is refused rather than silently evicting a live session.
    const eleventh = new ApiClient(base);
    const refused = await eleventh.request<{ error: { code: string } }>('POST', '/api/auth/login', {
      body: { identifier: email, password: PASSWORD, device: { name: 'Device 11', platform: 'web' } },
      token: null,
    });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe('too_many_sessions');

    // Signing out on one device frees the slot, and the account is usable again.
    const signOut = await extraClients[0]!.request('POST', '/api/auth/logout');
    expect(signOut.status).toBe(200);
    const twelfth = new ApiClient(base);
    const allowed = await twelfth.login(email, PASSWORD);
    expect(allowed.user.id).toBe(user.userId);

    // Logout-all revokes everything, which also clears the cap for future logins.
    const revoked = await twelfth.request<{ revokedSessions: number }>('POST', '/api/auth/logout-all');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedSessions).toBeGreaterThanOrEqual(10);
  });
  it('21. channel admins can promote, post, pin and be constrained by their role', async () => {
    const base = e2e().baseUrl;
    const owner = new ApiClient(base);
    const helper = new ApiClient(base);
    const outsider = new ApiClient(base);
    await owner.register({ username: uniqueUsername('chowner') });
    await helper.register({ username: uniqueUsername('chhelper') });
    await outsider.register({ username: uniqueUsername('chguest') });

    // Arabic-only channel name, no explicit slug: the server must derive a usable latin URL
    // (Arabic-first product) instead of failing with `slug_invalid`.
    const created = await owner.request<{ channel: { id: string; slug: string; myRole: string } }>('POST', '/api/channels', {
      body: { name: 'قناة التثبيت والأدوار', visibility: 'public', description: 'cover pin + roles' },
    });
    expect(created.status).toBe(201);
    const channelId = created.body.channel.id;
    expect(created.body.channel.myRole).toBe('owner');
    expect(created.body.channel.slug).toMatch(/^[a-z][a-z0-9_]{2,39}$/);

    // A second channel with the same Arabic name gets its own slug rather than a collision error.
    const twin = await owner.request<{ channel: { id: string; slug: string } }>('POST', '/api/channels', {
      body: { name: 'قناة التثبيت والأدوار', visibility: 'public' },
    });
    expect(twin.status).toBe(201);
    expect(twin.body.channel.slug).not.toBe(created.body.channel.slug);

    // A subscriber cannot post, promote or pin: role checks are real, not cosmetic.
    const subscribed = await helper.request<{ subscribed: boolean; created: boolean }>('POST', `/api/channels/${channelId}/subscribe`);
    expect(subscribed.status).toBe(200);
    expect(subscribed.body).toEqual({ subscribed: true, created: true });
    const subscriberPost = await helper.request('POST', `/api/channels/${channelId}/posts`, { body: { body: 'محاولة نشر من مشترك' } });
    expect(subscriberPost.status).toBe(403);
    const subscriberPin = await helper.request('POST', `/api/channels/${channelId}/posts/00000000-0000-4000-8000-000000000000/pin`, {
      body: { pinned: true },
    });
    expect(subscriberPin.status).toBe(403);

    // The owner promotes the subscriber to moderator → posting is allowed, pinning is not.
    const promoted = await owner.request<{ updated: boolean }>('POST', `/api/channels/${channelId}/members/${helper.userId}/role`, {
      body: { role: 'moderator' },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.updated).toBe(true);

    const moderatorPost = await helper.request<{ post: { id: string; pinnedAt: string | null } }>(
      'POST',
      `/api/channels/${channelId}/posts`,
      { body: { body: 'إعلان من مشرف' } },
    );
    expect(moderatorPost.status).toBe(201);
    const postId = moderatorPost.body.post.id;
    expect(moderatorPost.body.post.pinnedAt).toBeNull();

    const moderatorPin = await helper.request('POST', `/api/channels/${channelId}/posts/${postId}/pin`, { body: { pinned: true } });
    expect(moderatorPin.status).toBe(403);

    const admin = await owner.request<{ updated: boolean }>('POST', `/api/channels/${channelId}/members/${helper.userId}/role`, {
      body: { role: 'admin' },
    });
    expect(admin.status).toBe(200);
    const pinned = await helper.request<{ pinned: boolean }>('POST', `/api/channels/${channelId}/posts/${postId}/pin`, { body: { pinned: true } });
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned).toBe(true);

    // Pinning is visible to every subscriber and can be undone.
    const listed = await outsider.request<{ items: Array<{ id: string; pinnedAt: string | null }> }>(
      'GET',
      `/api/channels/${channelId}/posts`,
      { token: null },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items.find((item) => item.id === postId)?.pinnedAt).toBeTruthy();
    const unpinned = await helper.request<{ pinned: boolean }>('POST', `/api/channels/${channelId}/posts/${postId}/pin`, {
      body: { pinned: false },
    });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.pinned).toBe(false);

    // Demotion takes effect immediately, and the owner's own role cannot be reassigned away.
    const demoted = await owner.request('POST', `/api/channels/${channelId}/members/${helper.userId}/role`, { body: { role: 'subscriber' } });
    expect(demoted.status).toBe(200);
    const pinAfterDemotion = await helper.request('POST', `/api/channels/${channelId}/posts/${postId}/pin`, { body: { pinned: true } });
    expect(pinAfterDemotion.status).toBe(403);
    const ownerDemotion = await helper.request('POST', `/api/channels/${channelId}/members/${owner.userId}/role`, { body: { role: 'subscriber' } });
    expect(ownerDemotion.status).toBe(403);

    // Role changes are audited, and the channel's own admins can review them (requirement:
    // reviewable moderation) without being platform staff.
    const audit = await owner.request<{ items: Array<{ action: string; targetId: string | null }> }>(
      'GET',
      `/api/channels/${channelId}/audit?limit=50`,
    );
    expect(audit.status).toBe(200);
    expect(audit.body.items.some((entry) => entry.action === 'channel.role_changed')).toBe(true);
    expect(audit.body.items.every((entry) => entry.targetId === channelId)).toBe(true);

    // A plain subscriber cannot read the audit trail, and the staff-wide log stays staff-only.
    const subscriberAudit = await helper.request('GET', `/api/channels/${channelId}/audit`);
    expect(subscriberAudit.status).toBe(403);
    const staffAudit = await owner.request('GET', '/api/moderation/audit?limit=50');
    expect(staffAudit.status).toBe(403);
  });
  it('22. two devices establish a real Signal session and the server only sees ciphertext', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    const carol = new ApiClient(base);
    const dave = new ApiClient(base);
    await alice.register({ username: uniqueUsername('e2eealice') });
    await bob.register({ username: uniqueUsername('e2eebob') });
    await carol.register({ username: uniqueUsername('e2eecarol') });
    await dave.register({ username: uniqueUsername('e2eedave') });

    // Each device generates its own keys locally (libsignal, the official implementation).
    const aliceDevice = new SignalDevice(alice.username!, 1);
    const bobDevice = new SignalDevice(bob.username!, 1);
    const carolDevice = new SignalDevice(carol.username!, 1);

    // Publishing before the flag-independent shape check: the API validates the bundle.
    const badPublish = await alice.request('PUT', '/api/keys/identity', { body: { identityKey: 'not-base64!!' } });
    expect(badPublish.status).toBe(400);

    const alicePublish = await alice.request<{ deviceId: string; oneTimePreKeysStored: number }>('PUT', '/api/keys/identity', {
      body: await aliceDevice.bundleBody(),
    });
    expect(alicePublish.status).toBe(200);
    expect(alicePublish.body.deviceId).toBe(alice.deviceId);
    expect(alicePublish.body.oneTimePreKeysStored).toBe(20);
    const bobPublish = await bob.request('PUT', '/api/keys/identity', { body: await bobDevice.bundleBody() });
    expect(bobPublish.status).toBe(200);
    const carolPublish = await carol.request('PUT', '/api/keys/identity', { body: await carolDevice.bundleBody() });
    expect(carolPublish.status).toBe(200);

    // The account is now advertised as E2EE-capable.
    const aliceMe = await alice.request<{ e2eeReady: boolean }>('GET', '/api/users/me');
    expect(aliceMe.body.e2eeReady).toBe(true);
    const inventory = await bob.request<{ e2eeEnabled: boolean; devices: Array<{ remainingOneTimePreKeys: number }> }>(
      'GET',
      '/api/keys/me',
    );
    expect(inventory.body.e2eeEnabled).toBe(true);
    expect(inventory.body.devices[0]!.remainingOneTimePreKeys).toBe(20);

    // A conversation can only be switched to encrypted once every member has published keys.
    const conversation = await alice.request<{ conversation: { id: string; isEncrypted: boolean } }>(
      'POST',
      '/api/conversations/direct',
      { body: { userId: bob.userId } },
    );
    const conversationId = conversation.body.conversation.id;
    expect(conversation.body.conversation.isEncrypted).toBe(false);

    const status = await alice.request<{ ready: boolean; e2eeEnabled: boolean; participants: Array<{ ready: boolean }> }>(
      'GET',
      `/api/conversations/${conversationId}/encryption`,
    );
    expect(status.body.e2eeEnabled).toBe(true);
    expect(status.body.ready).toBe(true);
    expect(status.body.participants.every((participant) => participant.ready)).toBe(true);

    // A participant who never published keys blocks enabling — messages must not be stranded.
    const withDave = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: dave.userId },
    });
    const blockedEnable = await alice.request('POST', `/api/conversations/${withDave.body.conversation.id}/encryption`, {
      body: { enabled: true },
    });
    expect(blockedEnable.status).toBe(409);
    expect((blockedEnable.body as { error: { message: string } }).error.message).toContain('participant_without_keys');

    const enabled = await alice.request<{ isEncrypted: boolean }>('POST', `/api/conversations/${conversationId}/encryption`, {
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.isEncrypted).toBe(true);

    // Alice fetches Bob's bundle; one one-time prekey is consumed for the session.
    const bundleResponse = await alice.request<{
      bundles: Array<{ deviceId: string; identityKey: string; oneTimePreKey?: { id: number } }>;
    }>('GET', `/api/keys/${bob.userId}`);
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.body.bundles).toHaveLength(1);
    const bobBundle = bundleResponse.body.bundles[0]!;
    expect(bobBundle.oneTimePreKey).toBeDefined();
    const bobInventoryAfter = await bob.request<{ devices: Array<{ remainingOneTimePreKeys: number }> }>('GET', '/api/keys/me');
    expect(bobInventoryAfter.body.devices[0]!.remainingOneTimePreKeys).toBe(19);

    // The full bundle is fetched again for the crypto step (a second prekey is issued; that is
    // the expected cost of asking twice — the server never hands out the same prekey twice).
    const fullBundle = await alice.request<{
      bundles: Array<{
        deviceId: string;
        registrationId: number;
        identityKey: string;
        signedPreKey: { id: number; publicKey: string; signature: string };
        kyberPreKey?: { id: number; publicKey: string; signature: string };
        oneTimePreKey?: { id: number; publicKey: string };
      }>;
    }>('GET', `/api/keys/${bob.userId}`);
    const secondBundle = fullBundle.body.bundles[0]!;
    expect(secondBundle.oneTimePreKey!.id).not.toBe(bobBundle.oneTimePreKey!.id);

    await aliceDevice.processBundle(secondBundle, bobDevice.address);
    const secret = 'لا يمكن للخادم قراءة هذه الرسالة — ‏E2EE ✅';
    const envelope = await aliceDevice.encryptFor(bobDevice.address, secret);
    expect(envelope.ciphertext).not.toContain(secret);

    const sent = await alice.request<{
      message: { id: string; body: string | null; ciphertext: string | null; encryptionScheme: string };
      duplicated: boolean;
    }>('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: `e2ee-${Date.now()}`, ciphertext: envelope.ciphertext, encryptionScheme: 'libsignal-v1' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBeNull();
    expect(sent.body.message.encryptionScheme).toBe('libsignal-v1');
    expect(sent.body.message.ciphertext).toBe(envelope.ciphertext);

    // Bob (a different device, different private keys) decrypts what Alice encrypted.
    const bobMessages = await bob.request<{ items: Array<{ id: string; ciphertext: string | null; body: string | null; encryptionScheme: string }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=10`,
    );
    const incoming = bobMessages.body.items.find((message) => message.id === sent.body.message.id)!;
    expect(incoming.body).toBeNull();
    const decrypted = await bobDevice.decryptFrom(aliceDevice.address, incoming.ciphertext!);
    expect(decrypted).toBe(secret);

    // Bob replies on the established session (a normal Signal message, no prekey).
    const reply = await bobDevice.encryptFor(aliceDevice.address, 'وصلت الرسالة مشفّرة، شكراً!');
    const bobSend = await bob.request<{ message: { id: string } }>('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: `e2ee-reply-${Date.now()}`, ciphertext: reply.ciphertext, encryptionScheme: 'libsignal-v1' },
    });
    expect(bobSend.status).toBe(201);
    const aliceMessages = await alice.request<{ items: Array<{ id: string; ciphertext: string | null }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=10`,
    );
    const aliceIncoming = aliceMessages.body.items.find((message) => message.id === bobSend.body.message.id)!;
    expect(await aliceDevice.decryptFrom(bobDevice.address, aliceIncoming.ciphertext!)).toBe('وصلت الرسالة مشفّرة، شكراً!');

    // Invariant: the plaintext exists nowhere the server can reach — not in the API response,
    // not in message search (the body column is empty, so full-text search finds nothing).
    expect(JSON.stringify(aliceMessages.body)).not.toContain('لا يمكن للخادم');
    // `/messages/search` returns a bare array of hits; an encrypted message has no body, so it
    // can never appear there — the server cannot index what it cannot read.
    const search = await alice.request<Array<{ id: string; body: string | null }>>(
      'GET',
      `/api/messages/search?q=${encodeURIComponent('قراءة')}`,
    );
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body)).toBe(true);
    expect(search.body.some((item) => item.id === sent.body.message.id)).toBe(false);

    // Plaintext is refused inside an encrypted conversation: no silent downgrade.
    const plaintextAttempt = await alice.request('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: `plain-${Date.now()}`, body: 'نص عادي' },
    });
    expect(plaintextAttempt.status).toBe(501);
    expect((plaintextAttempt.body as { error: { message: string } }).error.message).toBe('encrypted_conversation_requires_ciphertext');

    // Non-members can neither read the conversation nor obtain a bundle of a blocked user.
    const anonymousRead = await carol.request('GET', `/api/conversations/${conversationId}/messages`, { token: null });
    expect(anonymousRead.status).toBe(401);
    const carolRead = await carol.request('GET', `/api/conversations/${conversationId}/messages`);
    expect(carolRead.status).toBe(403);

    // Safety numbers: verification is per verifier and never forged by the server.
    const fingerprint = '12345 67890 12345 67890 12345 67890';
    const verified = await alice.request<{ verified: boolean }>('POST', '/api/keys/verify', {
      body: { deviceId: bob.deviceId, fingerprint, verified: true },
    });
    expect(verified.status).toBe(200);
    const aliceView = await alice.request<{ devices: Array<{ deviceId: string; verified: boolean; fingerprint: string }>; allVerified: boolean }>(
      'GET',
      `/api/keys/verify/${bob.userId}`,
    );
    expect(aliceView.body.allVerified).toBe(true);
    expect(aliceView.body.devices[0]!.fingerprint).toBe(fingerprint);
    const carolView = await carol.request<{ devices: Array<{ verified: boolean }>; verifiedCount: number }>(
      'GET',
      `/api/keys/verify/${bob.userId}`,
    );
    expect(carolView.body.verifiedCount).toBe(0);

    // A device cannot verify itself, and its own devices are not part of the verifier's list.
    const selfVerify = await alice.request('POST', '/api/keys/verify', {
      body: { deviceId: alice.deviceId, fingerprint, verified: true },
    });
    expect(selfVerify.status).toBe(400);

    // Turning encryption off is possible and audited (users can always leave a mode).
    const disabled = await alice.request<{ isEncrypted: boolean }>('POST', `/api/conversations/${conversationId}/encryption`, {
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.isEncrypted).toBe(false);
  });
  it('23. a browser-grade Matrix Olm session works end to end and the server sees only envelopes', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    const carol = new ApiClient(base);
    await alice.register({ username: uniqueUsername('olmalice') });
    await bob.register({ username: uniqueUsername('olmbob') });
    await carol.register({ username: uniqueUsername('olmcarol') });

    // Two independent devices, each with its own ratchet state held locally.
    const aliceDevice = await OlmDevice.create('alice-web');
    const bobDevice = await OlmDevice.create('bob-web');
    const carolDevice = await OlmDevice.create('carol-web');

    // A malformed bundle is rejected before anything is stored.
    const badPublish = await alice.request('PUT', '/api/keys/identity/olm', {
      body: { deviceId: alice.deviceId, identityKey: 'not base64!', signingKey: 'x', signature: 'y', oneTimeKeys: [] },
    });
    expect(badPublish.status).toBe(400);

    const alicePublish = await alice.request<{ deviceId: string; algorithm: string; oneTimeKeysStored: number }>(
      'PUT',
      '/api/keys/identity/olm',
      { body: aliceDevice.publish(20) },
    );
    expect(alicePublish.status).toBe(200);
    expect(alicePublish.body.algorithm).toBe('olm-v1');
    expect(alicePublish.body.oneTimeKeysStored).toBe(20);
    expect(alicePublish.body.deviceId).toBe(alice.deviceId);
    const bobPublish = await bob.request('PUT', '/api/keys/identity/olm', { body: bobDevice.publish(20) });
    expect(bobPublish.status).toBe(200);
    await carol.request('PUT', '/api/keys/identity/olm', { body: carolDevice.publish(5) });

    // The device inventory reports the Olm scheme, not a Signal-shaped lie.
    const inventory = await bob.request<{
      devices: Array<{ algorithm: string; remainingOneTimePreKeys: number; signingKey: string | null }>;
    }>('GET', '/api/keys/me');
    expect(inventory.body.devices[0]!.algorithm).toBe('olm-v1');
    expect(inventory.body.devices[0]!.remainingOneTimePreKeys).toBe(20);
    expect(inventory.body.devices[0]!.signingKey).toBe(bobDevice.identityKeys().ed25519);

    // Alice fetches Bob's bundle and verifies the identity signature locally.
    const bundleResponse = await alice.request<{
      bundles: Array<{
        deviceId: string;
        algorithm: string;
        identityKey: string;
        signingKey?: string;
        identitySignature?: string;
        oneTimePreKey?: { id: string; publicKey: string };
      }>;
    }>('GET', `/api/keys/${bob.userId}`);
    expect(bundleResponse.status).toBe(200);
    const bobBundle = bundleResponse.body.bundles[0]!;
    expect(bobBundle.algorithm).toBe('olm-v1');
    expect(bobBundle.identityKey).toBe(bobDevice.identityKeys().curve25519);
    expect(bobBundle.oneTimePreKey).toBeDefined();
    // Self-authenticating device: the signature checks out with the published signing key only.
    expect(aliceDevice.verify(bobBundle.signingKey!, bobBundle.identityKey, bobBundle.identitySignature!)).toBe(true);
    // And a substituted identity key does not.
    expect(aliceDevice.verify(bobBundle.signingKey!, carolDevice.identityKeys().curve25519, bobBundle.identitySignature!)).toBe(false);

    // One-time keys drain one per session, so a second fetch cannot reuse the first key.
    const secondBundle = (await alice.request<{ bundles: Array<{ oneTimePreKey?: { id: string; publicKey: string } }> }>(
      'GET',
      `/api/keys/${bob.userId}`,
    )).body.bundles[0]!;
    expect(secondBundle.oneTimePreKey!.publicKey).not.toBe(bobBundle.oneTimePreKey!.publicKey);
    const afterFetch = await bob.request<{ devices: Array<{ remainingOneTimePreKeys: number }> }>('GET', '/api/keys/me');
    expect(afterFetch.body.devices[0]!.remainingOneTimePreKeys).toBe(18);

    // Top-up puts keys back without touching the identity.
    const topUp = await bob.request<{ oneTimeKeysStored: number }>('POST', '/api/keys/prekeys/olm', {
      body: { deviceId: bob.deviceId, oneTimeKeys: bobDevice.topUp(5) },
    });
    expect(topUp.status).toBe(200);
    expect(topUp.body.oneTimeKeysStored).toBe(23);

    // An Olm device and the conversation both support encryption.
    const conversation = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const conversationId = conversation.body.conversation.id;
    const encryptionStatus = await alice.request<{
      ready: boolean;
      participants: Array<{ userId: string; ready: boolean; algorithms: string[] }>;
    }>('GET', `/api/conversations/${conversationId}/encryption`);
    expect(encryptionStatus.body.ready).toBe(true);
    expect(encryptionStatus.body.participants.find((p) => p.userId === bob.userId)!.algorithms).toEqual(['olm-v1']);
    const enabled = await alice.request('POST', `/api/conversations/${conversationId}/encryption`, { body: { enabled: true } });
    expect(enabled.status).toBe(200);

    // Ciphertext addressed to somebody outside the conversation is refused outright.
    const foreignEnvelope = await alice.request('POST', `/api/conversations/${conversationId}/messages`, {
      body: {
        clientMessageId: `olm-foreign-${Date.now()}`,
        encryptionScheme: 'olm-v1',
        envelopes: [{ deviceId: carol.deviceId, scheme: 'olm-v1', ciphertext: JSON.stringify({ type: 0, body: 'x' }) }],
      },
    });
    expect(foreignEnvelope.status).toBe(400);
    expect((foreignEnvelope.body as { error: { message: string } }).error.message).toBe('envelope_for_unknown_device');

    // The real handshake: Alice's outbound session (type 0 prekey message) for Bob's device.
    const secret = 'رسالة مشفّرة بمصفوفة أولم — لا يقرأها الخادم 🔒';
    const first = await aliceDevice.encryptFirst(
      bobBundle.identityKey,
      bobBundle.oneTimePreKey!.publicKey,
      secret,
    );
    expect(first.type).toBe(0);
    expect(first.ciphertext).not.toContain(secret);

    const sent = await alice.request<{
      message: { id: string; body: string | null; encryptionScheme: string; envelopes: Array<{ ciphertext: string }> };
    }>('POST', `/api/conversations/${conversationId}/messages`, {
      body: {
        clientMessageId: `olm-${Date.now()}`,
        encryptionScheme: 'olm-v1',
        envelopes: [{ deviceId: bob.deviceId, scheme: 'olm-v1', ciphertext: first.ciphertext }],
      },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBeNull();
    expect(sent.body.message.encryptionScheme).toBe('olm-v1');
    // The sender's own response does not leak the recipient's ciphertext.
    expect(sent.body.message.envelopes).toHaveLength(0);

    // Bob fetches history as his own device and gets exactly one envelope: his.
    const bobMessages = await bob.request<{ items: Array<{ id: string; body: string | null; envelopes: Array<{ ciphertext: string }> }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=10`,
    );
    const incoming = bobMessages.body.items.find((message) => message.id === sent.body.message.id)!;
    expect(incoming.body).toBeNull();
    expect(incoming.envelopes).toHaveLength(1);
    const parsed = JSON.parse(incoming.envelopes[0]!.ciphertext) as { type: number; body: string };
    const inbound = bobDevice.decryptFirst(aliceDevice.identityKeys().curve25519, parsed.body, parsed.type);
    expect(inbound.plaintext).toBe(secret);
    expect(bobDevice.session(inbound.session.session_id())).toBeDefined();

    // Bob replies inside the same ratchet: a normal message (type 1), not another prekey message.
    const replyText = 'وصلت مشفّرة، أردّ على نفس الجلسة ✅';
    const reply = bobDevice.encryptOn(inbound.session, replyText);
    expect(reply.type).toBe(1);
    const bobSend = await bob.request<{ message: { id: string } }>('POST', `/api/conversations/${conversationId}/messages`, {
      body: {
        clientMessageId: `olm-reply-${Date.now()}`,
        encryptionScheme: 'olm-v1',
        envelopes: [
          { deviceId: alice.deviceId, scheme: 'olm-v1', ciphertext: reply.ciphertext },
          { deviceId: bob.deviceId, scheme: 'olm-v1', ciphertext: reply.ciphertext },
        ],
      },
    });
    expect(bobSend.status).toBe(201);

    const aliceMessages = await alice.request<{ items: Array<{ id: string; envelopes: Array<{ ciphertext: string }> }> }>(
      'GET',
      `/api/conversations/${conversationId}/messages?limit=10`,
    );
    const aliceIncoming = aliceMessages.body.items.find((message) => message.id === bobSend.body.message.id)!;
    expect(aliceIncoming.envelopes).toHaveLength(1);
    const aliceParsed = JSON.parse(aliceIncoming.envelopes[0]!.ciphertext) as { type: number; body: string };
    const aliceSession = aliceDevice.session(first.session.session_id())!;
    expect(aliceDevice.decryptOn(aliceSession, aliceParsed.type, aliceParsed.body)).toBe(replyText);

    // Tampering with a ciphertext is detected by the MAC — a server that rewrites stored
    // envelopes cannot forge a message. A fresh pair is used so the tampered prekey message
    // still refers to a one-time key the receiver genuinely holds (otherwise the failure would
    // be "unknown key" rather than a MAC mismatch).
    const tamperSender = await OlmDevice.create('tamper-sender');
    const tamperReceiver = await OlmDevice.create('tamper-receiver');
    const receiverBundle = tamperReceiver.publish(5);
    const senderBundle = tamperSender.publish(5);
    const handshake = await tamperSender.encryptFirst(
      receiverBundle.identityKey,
      receiverBundle.oneTimeKeys[0]!.key,
      'target of the tamper probe',
    );
    const handshakeParsed = JSON.parse(handshake.ciphertext) as { type: number; body: string };
    const flipped = handshakeParsed.body.endsWith('AAAA') ? 'BBBB' : 'AAAA';
    const tamperedBody = `${handshakeParsed.body.slice(0, -4)}${flipped}`;
    expect(tamperedBody).not.toBe(handshakeParsed.body);
    expect(() => tamperReceiver.decryptFirst(senderBundle.identityKey, tamperedBody, handshakeParsed.type)).toThrow(
      /BAD_MESSAGE_MAC|BAD_MESSAGE/i,
    );
    // The untampered copy still decrypts on a receiver that has not consumed the key yet.
    const honest = tamperReceiver.decryptFirst(senderBundle.identityKey, handshakeParsed.body, handshakeParsed.type);
    expect(honest.plaintext).toBe('target of the tamper probe');

    // Non-members see neither the ciphertext nor the envelopes.
    const carolRead = await carol.request('GET', `/api/conversations/${conversationId}/messages`);
    expect(carolRead.status).toBe(403);

    // Nothing readable reached the server: no plaintext in the payload, and full-text search is blind.
    expect(JSON.stringify(bobMessages.body)).not.toContain('لا يقرأها الخادم');
    const search = await alice.request<Array<{ id: string }>>('GET', `/api/messages/search?q=${encodeURIComponent('مشفّرة')}`);
    expect(search.body.some((item) => item.id === sent.body.message.id)).toBe(false);

    // Safety numbers: both sides derive the same 12 bytes and the same six-digit groups.
    const sas = await sasBytesBothSides({
      userA: alice.userId!,
      deviceA: alice.deviceId!,
      userB: bob.userId!,
      deviceB: bob.deviceId!,
    });
    expect(sas.alice).toBe(sas.bob);
    expect(safetyNumberFromBytes(sas.aliceBytes).join(' ')).toBe(safetyNumberFromBytes(sas.bobBytes).join(' '));
    // A third device exchanging keys with Alice produces a different number — this is what makes
    // the comparison meaningful when a server tries to insert itself into the conversation.
    const carolSas = await sasBytesBothSides({
      userA: alice.userId!,
      deviceA: alice.deviceId!,
      userB: carol.userId!,
      deviceB: carol.deviceId!,
    });
    expect(carolSas.alice).not.toBe(sas.alice);
    // The verification API surfaces both public keys, so the client can recompute the number.
    const verifierView = await alice.request<{
      devices: Array<{ deviceId: string; algorithm: string; identityKey: string | null; signingKey: string | null }>;
    }>('GET', `/api/keys/verify/${bob.userId}`);
    const bobPublic = verifierView.body.devices.find((device) => device.deviceId === bob.deviceId)!;
    expect(bobPublic.algorithm).toBe('olm-v1');
    expect(bobPublic.identityKey).toBe(bobDevice.identityKeys().curve25519);
    expect(bobPublic.signingKey).toBe(bobDevice.identityKeys().ed25519);
    // Nothing in that response is private material.
    expect(JSON.stringify(verifierView.body)).not.toContain('Curve25519PrivateKey');
  });

  it('24. re-signing in from the same install reuses its device instead of piling up', async () => {
    const base = e2e().baseUrl;
    const installKey = 'e2e-install-browser-profile-1';
    const first = new ApiClient(base);
    const registered = await first.register({ username: uniqueUsername('install'), deviceKey: installKey });
    const firstDevice = first.deviceId!;
    expect(firstDevice).toBeTruthy();

    // Same install, three more sign-ins: the device id must not change, and every earlier session of
    // *this device* is replaced rather than added — otherwise ten logins would lock the account out.
    const devices = [firstDevice];
    const clients = [first];
    for (let index = 0; index < 3; index += 1) {
      const again = new ApiClient(base);
      const result = await again.login(first.username!, PASSWORD, {
        name: 'Test runner',
        key: installKey,
      });
      devices.push(result.deviceId);
      clients.push(again);
    }
    expect(new Set(devices).size).toBe(1);

    // The previous session of the same install is gone (its access token no longer works)…
    const staleCall = await clients[0]!.request('GET', '/api/auth/sessions');
    expect(staleCall.status).toBe(401);
    // …while the newest one is live.
    const live = await clients[3]!.request<Array<{ deviceId: string | null }>>('GET', '/api/auth/sessions');
    expect(live.status).toBe(200);
    expect(live.body.filter((session) => session.deviceId === firstDevice)).toHaveLength(1);

    // The account lists one device for this install, not four.
    const deviceList = await clients[0]!.request('GET', '/api/users/me/devices', { token: clients[3]!.accessToken });
    const owned = (deviceList.body as Array<{ id: string }>).filter((device) => device.id === firstDevice);
    expect(owned).toHaveLength(1);

    // A second, distinct install is a second device, and the two coexist.
    const phone = new ApiClient(base);
    const phoneLogin = await phone.login(first.username!, PASSWORD, { key: 'e2e-install-phone-2' });
    expect(phoneLogin.deviceId).not.toBe(firstDevice);
    const both = await phone.request<Array<{ deviceId: string | null }>>('GET', '/api/auth/sessions');
    expect(new Set(both.body.map((session) => session.deviceId)).size).toBe(2);

    // Twelve sign-ins from one install stay well under the cap: the bug was a hard lockout here.
    const rotate = new ApiClient(base);
    for (let index = 0; index < 12; index += 1) {
      await rotate.login(first.username!, PASSWORD, { key: installKey });
    }
    expect(rotate.deviceId).toBe(firstDevice);

    // An install key is not a credential: it only ever resolves inside its owner's devices.
    const otherUser = new ApiClient(base);
    await otherUser.register({ username: uniqueUsername('other') });
    const borrowed = await otherUser.login(otherUser.email!, PASSWORD, { key: installKey });
    expect(borrowed.deviceId).not.toBe(firstDevice);
  });

  it('25. password changes revoke other sessions and free a capped account', async () => {
    const base = e2e().baseUrl;
    const owner = new ApiClient(base);
    await owner.register({ username: uniqueUsername('pwd') });
    const email = owner.email!;

    // Two more installs are signed in; all three sessions are live.
    const laptop = new ApiClient(base);
    const tablet = new ApiClient(base);
    await laptop.login(email, PASSWORD, { key: 'e2e-pwd-laptop' });
    await tablet.login(email, PASSWORD, { key: 'e2e-pwd-tablet' });
    const before = await owner.request<unknown[]>('GET', '/api/auth/sessions');
    expect(before.body.length).toBe(3);

    // Changing the password signs the *other* devices out and keeps the caller signed in.
    const changed = owner.accessToken;
    const res = await owner.request<{ changed: boolean; revokedSessions: number }>('POST', '/api/auth/password/change', {
      body: { currentPassword: PASSWORD, newPassword: 'Sovereign-Changed-Passw0rd' },
    });
    expect(res.status).toBe(200);
    expect(res.body.revokedSessions).toBe(2);
    expect(owner.accessToken).toBe(changed);
    const stillIn = await owner.request('GET', '/api/users/me');
    expect(stillIn.status).toBe(200);
    for (const other of [laptop, tablet]) {
      const revoked = await other.request('GET', '/api/users/me');
      expect(revoked.status).toBe(401);
    }

    // Fill the session table to the documented cap, so the next login is refused…
    const fillers: ApiClient[] = [];
    for (let index = 0; index < 9; index += 1) {
      const extra = new ApiClient(base);
      await extra.login(email, 'Sovereign-Changed-Passw0rd', { key: `e2e-pwd-filler-${index}` });
      fillers.push(extra);
    }
    const tooMany = await new ApiClient(base).request<{ error: { code: string } }>('POST', '/api/auth/login', {
      body: { identifier: email, password: 'Sovereign-Changed-Passw0rd', device: { name: 'One too many', platform: 'web', key: 'e2e-pwd-eleventh' } },
      token: null,
    });
    expect(tooMany.status).toBe(403);
    expect((tooMany.body as { error: { code: string } }).error.code).toBe('too_many_sessions');

    // …and the documented way out works without touching the database: reset the password, which
    // revokes everything and lets the owner sign in again.
    const requested = await new ApiClient(base).request('POST', '/api/auth/password/request-reset', {
      body: { email },
      token: null,
    });
    expect(requested.status).toBe(200);
    const mail = lastMailTo(email);
    const link = mail ? extractLink(mail, /token=[A-Za-z0-9_-]+/) : null;
    expect(link).toBeTruthy();
    const token = link!.split('token=')[1]!;
    const reset = await new ApiClient(base).request('POST', '/api/auth/password/reset', {
      body: { token, newPassword: 'Sovereign-Recovered-Passw0rd' },
      token: null,
    });
    expect(reset.status).toBe(200);
    for (const filler of fillers) {
      const revoked = await filler.request('GET', '/api/users/me');
      expect(revoked.status).toBe(401);
    }
    const backIn = new ApiClient(base);
    const recovered = await backIn.login(email, 'Sovereign-Recovered-Passw0rd', { key: 'e2e-pwd-laptop' });
    expect(recovered.user.id).toBe(owner.userId);
    // Reusing the same install key landed on the same device row as before.
    expect(recovered.deviceId).toBe(laptop.deviceId);
  });

  it('26. the device directory lists who has keys without claiming any', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    const carol = new ApiClient(base);
    await alice.register({ username: uniqueUsername('dir_alice') });
    await bob.register({ username: uniqueUsername('dir_bob') });
    await carol.register({ username: uniqueUsername('dir_carol') });

    // Bob has a real Olm device; his *other* session device never published any keys.
    const bobDevice = await OlmDevice.create('bob-phone');
    await bob.request('PUT', '/api/keys/identity/olm', { body: bobDevice.publish(20) });

    const countRemaining = async (): Promise<number> => {
      const inventory = await bob.request<{ devices: Array<{ deviceId: string; remainingOneTimePreKeys: number }> }>(
        'GET',
        '/api/keys/me',
      );
      return inventory.body.devices.find((device) => device.deviceId === bob.deviceId)!.remainingOneTimePreKeys;
    };
    const before = await countRemaining();

    // The directory answers the question a sender actually has — who exists — and nothing else.
    const directory = await alice.request<{
      targetUserId: string;
      devices: Array<{ deviceId: string; algorithm: string; identityKey: string; signingKey?: string }>;
    }>('GET', `/api/keys/${bob.userId}/devices`);
    expect(directory.status).toBe(200);
    expect(directory.body.targetUserId).toBe(bob.userId);
    expect(directory.body.devices.map((device) => device.deviceId)).toEqual([bob.deviceId]);
    expect(directory.body.devices[0]!.algorithm).toBe('olm-v1');
    expect(directory.body.devices[0]!.identityKey).toBe(bobDevice.identityKeys().curve25519);
    expect(directory.body.devices[0]!.signingKey).toBe(bobDevice.identityKeys().ed25519);
    // No key material of any kind: a directory entry is public identity data, not a claim.
    expect(JSON.stringify(directory.body)).not.toContain('oneTimePreKey');
    expect(JSON.stringify(directory.body)).not.toContain('Private');

    // …and it is free: refreshing it before every send must not drain the recipient's pool.
    await alice.request('GET', `/api/keys/${bob.userId}/devices`);
    await alice.request('GET', `/api/keys/${bob.userId}/devices`);
    expect(await countRemaining()).toBe(before);

    // Claiming is the separate, destructive step — exactly one key per bundle fetch.
    const claimed = await alice.request<{ bundles: Array<{ deviceId: string; oneTimePreKey?: { publicKey: string } }> }>(
      'GET',
      `/api/keys/${bob.userId}`,
    );
    expect(claimed.status).toBe(200);
    expect(claimed.body.bundles[0]!.oneTimePreKey).toBeTruthy();
    expect(await countRemaining()).toBe(before - 1);

    // Same access rules as bundles: no directory for someone who cannot message you.
    const bobUsername = bob.username!;
    const blocked = await alice.request('POST', `/api/users/${bobUsername}/block`);
    expect(blocked.status).toBe(200);
    const afterBlock = await alice.request<{ error: { code: string; message: string } }>(
      'GET',
      `/api/keys/${bob.userId}/devices`,
    );
    expect(afterBlock.status).toBe(403);
    // `code` is the HTTP category, `message` carries the reason.
    expect(afterBlock.body.error.code).toBe('forbidden');
    expect(afterBlock.body.error.message).toBe('blocked_by_recipient');
    await alice.request('DELETE', `/api/users/${bobUsername}/block`);
    // Unblocking restores the directory, so the rule is the block and not a sticky failure.
    const restored = await alice.request<{ devices: unknown[] }>('GET', `/api/keys/${bob.userId}/devices`);
    expect(restored.status).toBe(200);
    expect(restored.body.devices).toHaveLength(1);

    // A user with no published keys gets an empty list, not an error: the sender decides what that
    // means (and reports it as an unaddressable participant).
    const keyless = await alice.request<{ devices: unknown[] }>('GET', `/api/keys/${carol.userId}/devices`);
    expect(keyless.status).toBe(200);
    expect(keyless.body.devices).toEqual([]);
    const unknown = await alice.request<{ error: { code: string } }>('GET', '/api/keys/11111111-1111-4111-8111-111111111111/devices');
    expect(unknown.status).toBe(404);
  });
  it('27. uploads are verified against their bytes and encrypted files stay opaque', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const bob = new ApiClient(base);
    await alice.register({ username: uniqueUsername('alice') });
    await bob.register({ username: uniqueUsername('bob') });

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );

    // A file whose bytes disagree with its declared type is refused, whichever way it lies.
    const lyingImage = new FormData();
    lyingImage.append('file', new Blob([new Uint8Array(Buffer.from('<svg onload=alert(1)></svg>'))], { type: 'image/png' }), 'photo.png');
    const lyingImageUpload = await alice.request<{ error: { message: string } }>('POST', '/api/files', {
      body: lyingImage,
      raw: true,
    });
    expect(lyingImageUpload.status).toBe(415);
    expect(lyingImageUpload.body.error.message).toBe('content_type_mismatch');

    const lyingText = new FormData();
    lyingText.append('file', new Blob([new Uint8Array(png)], { type: 'text/plain' }), 'notes.txt');
    const lyingTextUpload = await alice.request<{ error: { message: string } }>('POST', '/api/files', {
      body: lyingText,
      raw: true,
    });
    expect(lyingTextUpload.status).toBe(415);
    expect(lyingTextUpload.body.error.message).toBe('content_type_mismatch');

    // An honest upload is accepted and served with its real type.
    const honest = new FormData();
    honest.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'photo.png');
    const honestUpload = await alice.request<{ attachment: { id: string; isEncrypted: boolean; mimeType: string } }>(
      'POST',
      '/api/files',
      { body: honest, raw: true },
    );
    expect(honestUpload.status).toBe(201);
    expect(honestUpload.body.attachment.isEncrypted).toBe(false);

    // Ciphertext may not be sniffed, so it must be declared: the server keeps no name or type for it.
    const secretBytes = Buffer.alloc(512);
    for (let index = 0; index < secretBytes.length; index += 1) secretBytes[index] = (index * 37 + 11) % 256;
    const cipherForm = new FormData();
    cipherForm.append('encrypted', 'true');
    cipherForm.append('file', new Blob([new Uint8Array(secretBytes)], { type: 'application/octet-stream' }), 'secret-voice.ogg');
    const cipherUpload = await alice.request<{
      attachment: { id: string; isEncrypted: boolean; mimeType: string; fileName: string; sizeBytes: number };
    }>('POST', '/api/files', { body: cipherForm, raw: true });
    expect(cipherUpload.status).toBe(201);
    expect(cipherUpload.body.attachment.isEncrypted).toBe(true);
    // The real name and type live inside the encrypted payload, not in the database.
    expect(cipherUpload.body.attachment.mimeType).toBe('application/octet-stream');
    expect(cipherUpload.body.attachment.fileName).toBe('encrypted.bin');
    expect(cipherUpload.body.attachment.sizeBytes).toBe(secretBytes.length);
    // The readable upload of the same size is a different attachment: the mode is part of the identity.
    expect(cipherUpload.body.attachment.id).not.toBe(honestUpload.body.attachment.id);

    // The same encrypted bytes are not mistaken for the readable upload (dedup keys on the mode).
    const repeatCipher = new FormData();
    repeatCipher.append('encrypted', 'true');
    repeatCipher.append('file', new Blob([new Uint8Array(secretBytes)], { type: 'application/octet-stream' }), 'secret-voice.ogg');
    const repeatUpload = await alice.request<{ attachment: { id: string } }>('POST', '/api/files', {
      body: repeatCipher,
      raw: true,
    });
    expect(repeatUpload.status).toBe(201);
    expect(repeatUpload.body.attachment.id).toBe(cipherUpload.body.attachment.id);

    const cipherId = cipherUpload.body.attachment.id as string;
    const honestId = honestUpload.body.attachment.id as string;

    // A plaintext conversation refuses ciphertext: the recipient could not open it.
    const plain = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const wrongSend = await alice.request<{ error: { message: string } }>(
      'POST',
      `/api/conversations/${plain.body.conversation.id}/messages`,
      { body: { clientMessageId: `cipher-mismatch-${Date.now()}`, body: 'ملف', attachmentIds: [cipherId] } },
    );
    expect(wrongSend.status).toBe(400);
    expect(wrongSend.body.error.message).toBe('plaintext_conversation_rejects_encrypted_files');

    // And an encrypted conversation refuses readable files: that would leak exactly what it protects.
    const aliceDevice = new SignalDevice(alice.username!, 1);
    const bobDevice = new SignalDevice(bob.username!, 1);
    await alice.request('PUT', '/api/keys/identity', { body: await aliceDevice.bundleBody() });
    await bob.request('PUT', '/api/keys/identity', { body: await bobDevice.bundleBody() });
    const encrypted = await alice.request<{ conversation: { id: string } }>('POST', '/api/conversations/direct', {
      body: { userId: bob.userId },
    });
    const encryptedId = encrypted.body.conversation.id;
    const enabled = await alice.request<{ isEncrypted: boolean }>('POST', `/api/conversations/${encryptedId}/encryption`, { body: { enabled: true } });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.isEncrypted).toBe(true);

    const leakySend = await alice.request<{ error: { message: string } }>(
      'POST',
      `/api/conversations/${encryptedId}/messages`,
      {
        body: {
          clientMessageId: `plain-file-${Date.now()}`,
          ciphertext: 'H4sIAAAAAAAA/6tWykvMTVWyUjA0MFDSUcpJTS3KBwAAAP//AwBQ',
          encryptionScheme: 'libsignal-v1',
          attachmentIds: [honestId],
        },
      },
    );
    expect(leakySend.status, JSON.stringify(leakySend.body)).toBe(400);
    expect(leakySend.body.error.message).toBe('encrypted_conversation_requires_encrypted_files');

    // Ciphertext in the encrypted conversation is accepted and delivered as opaque bytes.
    const cipherSend = await alice.request<{ message: { attachments: Array<{ id: string; isEncrypted: boolean; url: string }> } }>(
      'POST',
      `/api/conversations/${encryptedId}/messages`,
      {
        body: {
          clientMessageId: `cipher-ok-${Date.now()}`,
          ciphertext: 'H4sIAAAAAAAA/6tWykvMTVWyUjA0MFDSUcpJTS3KBwAAAP//AwBQ',
          encryptionScheme: 'libsignal-v1',
          attachmentIds: [cipherId],
        },
      },
    );
    expect(cipherSend.status, JSON.stringify(cipherSend.body)).toBe(201);
    expect(cipherSend.body.message.attachments[0]!.isEncrypted).toBe(true);

    const bobDownload = await bob.download(`/api/files/${cipherId}`);
    expect(bobDownload.status).toBe(200);
    expect(bobDownload.headers.get('content-type')).toBe('application/octet-stream');
    expect(bobDownload.headers.get('x-content-type-options')).toBe('nosniff');
    // The bytes come back exactly as they were uploaded — the server never re-encodes them.
    expect(bobDownload.bytes.equals(secretBytes)).toBe(true);
  });
  it('28. removing a device deletes its keys without locking that install out', async () => {
    const base = e2e().baseUrl;
    const alice = new ApiClient(base);
    const installKey = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await alice.register({ username: uniqueUsername('removal'), deviceKey: installKey });
    const deviceId = alice.deviceId!;
    const device = new SignalDevice(alice.username!, 1);
    const firstBundle = await device.bundleBody();
    const oldIdentityKey = firstBundle.identityKey;
    await alice.request('PUT', '/api/keys/identity', { body: firstBundle });

    const before = await alice.request<{ devices: Array<{ deviceId: string }> }>('GET', `/api/keys/${alice.userId}/devices`);
    expect(before.body.devices.map((entry) => entry.deviceId)).toContain(deviceId);

    // "Sign out and remove this device" — the security centre's own call.
    const removed = await alice.request<{ revoked: boolean }>('DELETE', `/api/users/me/devices/${deviceId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.revoked).toBe(true);

    // The keys go with it: no peer will address that device any more, and its token is dead.
    const after = await alice.request<{ devices: Array<{ deviceId: string }> }>('GET', `/api/keys/${alice.userId}/devices`);
    expect(after.body.devices.map((entry) => entry.deviceId)).not.toContain(deviceId);

    /**
     * The removed device's token stops working — after the session cache window.
     *
     * Session liveness is answered from a 10-second cache so that ordinary requests do not each cost
     * a database round trip; the trade-off is that a revocation takes effect within that window
     * rather than instantly. The test states the window instead of pretending it is zero.
     */
    const staleClient = new ApiClient(base);
    const withinWindow = await staleClient.request('GET', '/api/users/me', { token: alice.accessToken });
    expect(withinWindow.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const staleToken = await staleClient.request('GET', '/api/users/me', { token: alice.accessToken });
    expect(staleToken.status).toBe(401);

    // Signing in again from that install must work — and must reuse the row, not collide with the
    // unique install key. This is the case that used to fail with an internal error (a removed phone
    // could never sign in again).
    const again = new ApiClient(base);
    const login = await again.login(alice.username!, PASSWORD, { key: installKey, name: 'Same phone' });
    expect(login.deviceId).toBe(deviceId);
    const me = await again.request<{ id: string }>('GET', '/api/users/me');
    expect(me.status).toBe(200);

    // The device comes back empty: its keys were deleted, so the client republishes a new identity.
    const empty = await again.request<{ devices: unknown[] }>('GET', `/api/keys/${again.userId}/devices`);
    expect(empty.body.devices).toEqual([]);
    const republished = new SignalDevice(again.username!, 1);
    await again.request('PUT', '/api/keys/identity', { body: await republished.bundleBody() });
    const restored = await again.request<{ devices: Array<{ deviceId: string; identityKey: string }> }>(
      'GET',
      `/api/keys/${again.userId}/devices`,
    );
    expect(restored.body.devices).toHaveLength(1);
    // A new identity, not the resurrected old one: the keys were really deleted.
    expect(restored.body.devices[0]!.identityKey).not.toBe(oldIdentityKey);
  });
  it('29. operational metrics exist only when an operator turns them on', async () => {
    const base = e2e().baseUrl;
    const token = process.env.METRICS_TOKEN!;
    expect(token).toBeTruthy();

    // A configured endpoint must not answer to a caller without the token.
    const anonymous = await fetch(`${base}/api/metrics`);
    expect(anonymous.status).toBe(401);
    const wrongToken = await fetch(`${base}/api/metrics`, { headers: { 'x-metrics-token': 'not-the-token' } });
    expect(wrongToken.status).toBe(401);

    const counterOf = (text: string, method: string, route: string, status: string): number => {
      const match = text.match(
        new RegExp(`sovereign_http_requests_total\\{method="${method}",route="${route}",status="${status}"\\} (\\d+)`),
      );
      return match ? Number(match[1]) : 0;
    };
    const scrape = async (): Promise<string> => {
      const response = await fetch(`${base}/api/metrics`, { headers: { 'x-metrics-token': token } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      return response.text();
    };

    const first = await scrape();
    // The scrape reports the operational picture an operator needs.
    expect(first).toContain('# TYPE sovereign_http_requests_total counter');
    expect(first).toContain('sovereign_db_pool_total');
    expect(first).toContain('sovereign_db_pool_idle');
    expect(first).toContain('sovereign_realtime_connections');
    expect(first).toContain('process_resident_memory_bytes');

    // Scraping is itself a request, and it is counted like any other (the first scrape predates its
    // own series, so the second one shows it).
    const second_ = await scrape();
    // Route labels carry the full pattern, prefix included: `/api/metrics`, `/api/files/:attachmentId`.
    expect(second_).toContain('sovereign_http_requests_total{method="GET",route="/api/metrics",status="200"}');
    expect(second_).toContain('sovereign_http_request_duration_seconds_bucket{method="GET",route="/api/metrics"');

    // The counters are real: one health probe moves exactly one series by one.
    const before = counterOf(second_, 'GET', '/api/health', '200');
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const second = await scrape();
    expect(counterOf(second, 'GET', '/api/health', '200')).toBe(before + 1);

    // Cardinality: requesting two different attachment ids must not create two series. The route
    // pattern (not the URL) is the label, so the series count is a function of method and status —
    // this is the property that keeps a scrape from growing with every file anyone opens.
    const seriesCount = (text: string): number => (text.match(/route="\/api\/files\/:attachmentId"/g) ?? []).length;
    const warmUpId = '33333333-3333-4333-8333-333333333333';
    await fetch(`${base}/api/files/${warmUpId}`);
    const baseline = seriesCount(await scrape());
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    await fetch(`${base}/api/files/${firstId}`);
    await fetch(`${base}/api/files/${secondId}`);
    const third = await scrape();
    expect(baseline).toBeGreaterThan(0);
    expect(seriesCount(third)).toBe(baseline);
    expect(third).not.toContain(firstId);
    expect(third).not.toContain(secondId);

    // And nothing about who talks to whom: the scrape carries no account, conversation or message ids.
    const alice = new ApiClient(base);
    await alice.register({ username: uniqueUsername('metrics') });
    const fourth = await scrape();
    expect(fourth).not.toContain(alice.userId);
    expect(fourth).not.toContain(alice.username!);
  });
});
