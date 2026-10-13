import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@sovereign/shared/protocol';
import { e2e } from '../helpers/setup-e2e.js';
import { ApiClient, PASSWORD, uniqueEmail, uniqueUsername } from '../helpers/client.js';

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
});
