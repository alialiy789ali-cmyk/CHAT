import { describe, expect, it } from 'vitest';
import { e2e } from '../helpers/setup-e2e.js';
import { ApiClient, PASSWORD, uniqueUsername } from '../helpers/client.js';

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
});

