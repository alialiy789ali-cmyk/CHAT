import { AppError, assert } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import type { AppDeps, RequestContext } from './context.js';
import { channelPostToDto, channelToDto } from './serializers.js';
import type { DomainEvents } from './events.js';
import type { RealtimeHub } from '../realtime/hub.js';

/**
 * Broadcast channels (requirement 2.D): public/private channels, roles, posts,
 * pinned messages, invite links and abuse controls.
 */

export class ChannelsService {
  constructor(
    private readonly deps: AppDeps,
    private readonly realtime: RealtimeHub,
    private readonly events: DomainEvents,
  ) {}

  /**
   * Derives a slug from a channel name.
   *
   * Arabic-first product, latin-restricted URLs: a name written entirely in Arabic (the common
   * case here) has no latin characters to derive from, so we fall back to a short random slug
   * instead of failing the creation with `slug_invalid`. Callers that want a specific URL pass
   * `slug` explicitly and then get a clear `slug_taken` error instead of a silent rename.
   */
  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30);
    const latinOnly = base.replace(/^[^a-z]+/, '');
    if (/^[a-z]/.test(base) && latinOnly.length >= 2) return base;
    if (latinOnly.length >= 2) return `c_${latinOnly}`.slice(0, 39);
    return `c_${randomToken(6).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
  }

  /** Keeps auto-generated slugs unique when two channels share a name. */
  private withSuffix(slug: string): string {
    const suffix = randomToken(6).replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
    return `${slug.slice(0, 30).replace(/[^a-z0-9_]+$/g, '')}_${suffix}`.slice(0, 39);
  }

  async create(userId: string, input: { name: string; slug?: string; description?: string; visibility: 'public' | 'private' }, ctx: RequestContext) {
    let slug = input.slug ?? this.slugify(input.name);
    assert(/^[a-z][a-z0-9_]{2,39}$/.test(slug), 'validation_error', 'slug_invalid');
    if (input.slug) {
      const existing = await this.deps.repos.channels.findBySlug(slug);
      if (existing) throw new AppError('slug_taken');
    } else {
      // A user-chosen URL must never be silently rewritten; an auto-derived one may be retried.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await this.deps.repos.channels.findBySlug(slug);
        if (!existing) break;
        slug = this.withSuffix(slug);
      }
      assert(/^[a-z][a-z0-9_]{2,39}$/.test(slug), 'validation_error', 'slug_invalid');
    }
    const channel = await this.deps.repos.channels.create({
      ownerId: userId,
      name: input.name,
      slug,
      description: input.description ?? null,
      visibility: input.visibility,
    });
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.created',
      targetType: 'channel',
      targetId: channel.id,
      metadata: { slug, visibility: input.visibility },
    });
    return channelToDto({ ...channel, is_subscribed: true, my_role: 'owner' });
  }

  async getBySlug(slug: string, viewerId: string | null) {
    const channel = await this.deps.repos.channels.findBySlug(slug);
    if (!channel) throw new AppError('channel_not_found');
    const member = viewerId ? await this.deps.repos.channels.member(channel.id, viewerId) : null;
    if (channel.visibility === 'private' && !member) throw new AppError('not_member', 'private_channel');
    const members = await this.deps.repos.channels.members(channel.id, 50);
    return {
      channel: channelToDto({ ...channel, is_subscribed: Boolean(member), my_role: member?.role ?? null }),
      members: members.map((m) => ({
        id: m.user_id,
        username: m.username,
        displayName: m.display_name,
        avatarUrl: m.avatar_url,
        role: m.role,
        joinedAt: m.joined_at.toISOString(),
      })),
    };
  }

  async update(channelId: string, userId: string, patch: { name?: string; description?: string | null; avatarUrl?: string | null; visibility?: 'public' | 'private' }, ctx: RequestContext) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    const updated = await this.deps.repos.channels.update(channelId, patch);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.updated',
      targetType: 'channel',
      targetId: channelId,
      metadata: patch as Record<string, unknown>,
    });
    return channelToDto(updated);
  }

  async discover(viewerId: string, term: string | null, limit: number) {
    const rows = await this.deps.repos.channels.discover({ viewerId, term, limit });
    return rows.map(channelToDto);
  }

  async subscribed(viewerId: string) {
    const rows = await this.deps.repos.channels.subscribedFor(viewerId);
    return rows.map((row) => ({ ...channelToDto({ ...row, is_subscribed: true }), unread: false }));
  }

  async subscribe(channelId: string, userId: string, ctx: RequestContext) {
    const channel = await this.deps.repos.channels.findById(channelId);
    if (!channel) throw new AppError('channel_not_found');
    if (channel.visibility === 'private') throw new AppError('invite_invalid', 'private_channel_requires_invite');
    const created = await this.deps.repos.channels.join(channelId, userId);
    if (created) {
      await this.events.emit({ type: 'conversation.updated', conversationId: channelId, recipientIds: [userId], reason: 'channel_joined', at: new Date() });
    }
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.subscribed',
      targetType: 'channel',
      targetId: channelId,
      metadata: { created },
    });
    return { subscribed: true, created };
  }

  async unsubscribe(channelId: string, userId: string) {
    const removed = await this.deps.repos.channels.leave(channelId, userId);
    return { subscribed: false, removed };
  }

  async joinByInvite(code: string, userId: string, ctx: RequestContext) {
    const invite = await this.deps.repos.channels.findInvite(code);
    if (!invite || invite.revoked_at) throw new AppError('invite_invalid');
    if (invite.expires_at && invite.expires_at.getTime() < Date.now()) throw new AppError('invite_invalid', 'invite_expired');
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) throw new AppError('invite_invalid', 'invite_exhausted');
    const channel = await this.deps.repos.channels.findById(invite.channel_id);
    if (!channel) throw new AppError('channel_not_found');
    const created = await this.deps.repos.channels.join(invite.channel_id, userId, invite.role);
    if (created) await this.deps.repos.channels.consumeInvite(invite.id);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.joined_by_invite',
      targetType: 'channel',
      targetId: invite.channel_id,
      metadata: { code: code.slice(0, 6) + '…' },
    });
    return { channel: channelToDto({ ...channel, is_subscribed: true, my_role: invite.role }), created };
  }

  async createInvite(channelId: string, userId: string, input: { role: 'admin' | 'moderator' | 'subscriber'; maxUses?: number; ttlHours?: number }, ctx: RequestContext) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    const invite = await this.deps.repos.channels.createInvite({
      channelId,
      code: randomToken(12),
      createdBy: userId,
      role: input.role,
      maxUses: input.maxUses ?? null,
      expiresAt: input.ttlHours ? new Date(Date.now() + input.ttlHours * 3600 * 1000) : null,
    });
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.invite_created',
      targetType: 'channel',
      targetId: channelId,
      metadata: { role: input.role },
    });
    return {
      id: invite.id,
      code: invite.code,
      role: invite.role,
      maxUses: invite.max_uses,
      uses: invite.uses,
      expiresAt: invite.expires_at ? invite.expires_at.toISOString() : null,
    };
  }

  async listInvites(channelId: string, userId: string) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    return this.deps.repos.channels.listInvites(channelId);
  }

  async revokeInvite(channelId: string, userId: string, inviteId: string) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    await this.deps.repos.channels.revokeInvite(channelId, inviteId);
    return { revoked: true };
  }

  async setMemberRole(channelId: string, actorId: string, targetUserId: string, role: 'admin' | 'moderator' | 'subscriber', ctx: RequestContext) {
    await this.requireChannelRole(channelId, actorId, ['owner', 'admin']);
    const channel = await this.deps.repos.channels.findById(channelId);
    if (channel?.owner_id === targetUserId) throw new AppError('not_authorized_role', 'cannot_change_owner_role');
    await this.deps.repos.channels.setRole(channelId, targetUserId, role);
    await this.deps.repos.audit.record({
      actorId,
      actorIp: ctx.ip,
      action: 'channel.role_changed',
      targetType: 'channel',
      targetId: channelId,
      metadata: { subjectId: targetUserId, role },
    });
    return { updated: true };
  }

  /** ------------------------------------------------------------------ posts */

  async createPost(channelId: string, userId: string, input: { body: string; attachmentIds?: string[] }, ctx: RequestContext) {
    const channel = await this.deps.repos.channels.findById(channelId);
    if (!channel) throw new AppError('channel_not_found');
    const member = await this.deps.repos.channels.member(channelId, userId);
    if (!member || !['owner', 'admin', 'moderator'].includes(member.role)) {
      throw new AppError('not_authorized_role', 'only_admins_can_post');
    }
    const post = await this.deps.repos.channels.createPost({ channelId, authorId: userId, body: input.body });
    if (input.attachmentIds?.length) {
      const attached = await this.deps.repos.channels.attachMedia(post.id, input.attachmentIds, userId);
      assert(attached === input.attachmentIds.length, 'validation_error', 'some_attachments_unavailable');
    }
    const media = await this.deps.repos.files.listForChannelPost(post.id);
    const subscribers = await this.deps.db.many<{ user_id: string }>(
      'select user_id from channel_members where channel_id = $1 and user_id <> $2',
      [channelId, userId],
    );
    for (const subscriber of subscribers) {
      await this.deps.repos.notifications.create({
        userId: subscriber.user_id,
        kind: 'channel_post',
        actorId: userId,
        payload: { channelId, postId: post.id, preview: input.body.slice(0, 120) },
      });
    }
    await this.events.emit({
      type: 'notification',
      userId: userId,
      kind: 'channel_post.created',
      payload: { channelId, postId: post.id },
      at: new Date(),
    });
    return channelPostToDto({ ...post, author_username: null }, media);
  }

  async listPosts(channelId: string, viewerId: string | null, params: { limit: number; cursor?: string; search?: string }) {
    const channel = await this.deps.repos.channels.findById(channelId);
    if (!channel) throw new AppError('channel_not_found');
    if (channel.visibility === 'private') {
      const member = viewerId ? await this.deps.repos.channels.member(channelId, viewerId) : null;
      if (!member) throw new AppError('not_member', 'private_channel');
    }
    const { items, nextCursor } = await this.deps.repos.channels.listPosts({
      channelId,
      limit: params.limit,
      cursor: params.cursor,
      search: params.search,
    });
    const media = await Promise.all(items.map((item) => this.deps.repos.files.listForChannelPost(item.id)));
    if (viewerId) await this.deps.repos.channels.markRead(channelId, viewerId);
    return {
      items: items.map((item, index) => channelPostToDto(item, media[index] ?? [])),
      nextCursor,
    };
  }

  /**
   * Channel-scoped audit trail (requirement: reviewable moderation). Owners and admins can
   * see exactly what was done in their channel — promotions, deletions, invites — without
   * gaining the platform-wide staff log.
   */
  async auditLog(channelId: string, userId: string, options: { limit: number; offset: number }) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    const entries = await this.deps.repos.audit.list({
      targetType: 'channel',
      targetId: channelId,
      limit: options.limit,
      offset: options.offset,
    });
    return { items: entries, channelId };
  }

  async pinPost(channelId: string, postId: string, userId: string, pinned: boolean) {
    await this.requireChannelRole(channelId, userId, ['owner', 'admin']);
    await this.deps.repos.channels.setPinned(postId, pinned);
    return { pinned };
  }

  async deletePost(channelId: string, postId: string, userId: string, ctx: RequestContext) {
    const channel = await this.deps.repos.channels.findById(channelId);
    if (!channel) throw new AppError('channel_not_found');
    const post = await this.deps.repos.channels.findPost(postId);
    if (!post || post.channel_id !== channelId) throw new AppError('not_found', 'post_not_found');
    const member = await this.deps.repos.channels.member(channelId, userId);
    const isAuthor = post.author_id === userId;
    const isAdmin = member && ['owner', 'admin', 'moderator'].includes(member.role);
    if (!isAuthor && !isAdmin) throw new AppError('forbidden');
    await this.deps.repos.channels.deletePost(postId);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'channel.post_deleted',
      targetType: 'channel_post',
      targetId: postId,
      metadata: { channelId },
    });
    return { deleted: true };
  }

  private async requireChannelRole(channelId: string, userId: string, roles: string[]): Promise<void> {
    const member = await this.deps.repos.channels.member(channelId, userId);
    if (!member) throw new AppError('not_member');
    if (!roles.includes(member.role)) throw new AppError('not_authorized_role');
  }
}
