import { AppError } from '../lib/errors.js';
import type { AppDeps, RequestContext } from './context.js';
import { postToDto, userToPublic } from './serializers.js';
import type { PrivacySettings, NotificationSettings } from '../domain/settings.js';

/** Profiles, privacy settings, blocking and account data export/deletion. */

export class UsersService {
  constructor(private readonly deps: AppDeps) {}

  async me(userId: string) {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    const stats = await this.deps.repos.users.statsFor(userId);
    return {
      ...userToPublic(user),
      email: user.email,
      emailVerified: user.email_verified_at !== null,
      locale: user.locale,
      theme: user.theme,
      role: user.role,
      twoFactorEnabled: user.two_factor_enabled_at !== null,
      privacy: user.privacy_settings,
      notifications: user.notification_settings,
      e2eeReady: user.e2ee_ready,
      stats: {
        followers: Number(stats?.followers ?? 0),
        following: Number(stats?.following ?? 0),
        posts: Number(stats?.posts ?? 0),
      },
    };
  }

  async publicProfile(username: string, viewerId: string | null) {
    const user = await this.deps.repos.users.findByUsername(username);
    if (!user) throw new AppError('user_not_found');

    const privacy = user.privacy_settings;
    if (privacy.whoCanSeeProfile === 'nobody' && viewerId !== user.id) {
      throw new AppError('forbidden', 'profile_is_private');
    }
    if (privacy.whoCanSeeProfile === 'followers' && viewerId && viewerId !== user.id) {
      const follows = await this.deps.repos.social.isFollowing(viewerId, user.id);
      if (!follows) throw new AppError('forbidden', 'profile_visible_to_followers_only');
    }

    const stats = await this.deps.repos.users.statsFor(user.id);
    const viewer = viewerId
      ? {
          following: await this.deps.repos.social.isFollowing(viewerId, user.id),
          followedBy: await this.deps.repos.social.isFollowing(user.id, viewerId),
          blocked: await this.deps.repos.social.blockedBy(viewerId, user.id),
          isSelf: viewerId === user.id,
        }
      : null;
    const posts = await this.deps.repos.posts.byAuthor({
      viewerId: viewerId ?? user.id,
      authorId: user.id,
      limit: 10,
      includeReplies: false,
    });
    const media = await this.deps.repos.files.listForPosts(posts.items.map((p) => p.id));
    const mediaByPost = new Map<string, typeof media>();
    for (const item of media) {
      const list = mediaByPost.get(item.post_id ?? '') ?? [];
      list.push(item);
      mediaByPost.set(item.post_id ?? '', list);
    }

    return {
      user: userToPublic(user),
      stats: {
        followers: Number(stats?.followers ?? 0),
        following: Number(stats?.following ?? 0),
        posts: Number(stats?.posts ?? 0),
      },
      viewer,
      posts: posts.items.map((p) => postToDto(p, mediaByPost.get(p.id) ?? [], viewerId)),
      online: false,
    };
  }

  async updateProfile(
    userId: string,
    patch: { displayName?: string; bio?: string | null; avatarUrl?: string | null; locale?: 'ar' | 'en'; theme?: 'light' | 'dark' | 'system' },
  ) {
    await this.deps.repos.users.updateProfile(userId, patch);
    return this.me(userId);
  }

  async updatePrivacy(userId: string, patch: Partial<PrivacySettings>) {
    await this.deps.repos.users.updatePrivacy(userId, patch);
    return this.me(userId);
  }

  async updateNotificationSettings(userId: string, patch: Partial<NotificationSettings>) {
    await this.deps.repos.users.updateNotificationSettings(userId, patch);
    return this.me(userId);
  }

  async search(term: string, limit: number) {
    const users = await this.deps.repos.users.search(term, limit);
    return users.map(userToPublic);
  }

  async follow(followerId: string, username: string) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    if (target.id === followerId) throw new AppError('self_action_not_allowed');
    if (await this.deps.repos.social.blockExistsBetween(followerId, target.id)) {
      throw new AppError('blocked_by_user');
    }
    const created = await this.deps.repos.social.follow(followerId, target.id);
    if (created) {
      await this.deps.repos.notifications.create({
        userId: target.id,
        kind: 'follow',
        actorId: followerId,
      });
    }
    return { following: true, created };
  }

  async unfollow(followerId: string, username: string) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    const removed = await this.deps.repos.social.unfollow(followerId, target.id);
    return { following: false, removed };
  }

  async followers(username: string, limit: number, offset: number) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    const rows = await this.deps.repos.social.followers(target.id, limit, offset);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      bio: r.bio,
      followedAt: r.followed_at.toISOString(),
    }));
  }

  async following(username: string, limit: number, offset: number) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    const rows = await this.deps.repos.social.following(target.id, limit, offset);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      bio: r.bio,
      followedAt: r.followed_at.toISOString(),
    }));
  }

  async block(userId: string, username: string) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    if (target.id === userId) throw new AppError('self_action_not_allowed');
    await this.deps.repos.social.block(userId, target.id);
    return { blocked: true };
  }

  async unblock(userId: string, username: string) {
    const target = await this.deps.repos.users.findByUsername(username);
    if (!target) throw new AppError('user_not_found');
    await this.deps.repos.social.unblock(userId, target.id);
    return { blocked: false };
  }

  async blockList(userId: string) {
    const rows = await this.deps.repos.social.blockList(userId);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      blockedAt: r.blocked_at.toISOString(),
    }));
  }

  async suggestions(userId: string, limit = 10) {
    const rows = await this.deps.repos.social.suggestions(userId, limit);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      mutuals: Number(r.mutuals),
    }));
  }

  /**
   * Data export (GDPR-style portability, requirement 2 "export/delete user data").
   * Message bodies are included because the requester is a participant; secrets and
   * other users' private data are not.
   */
  async exportData(userId: string, ctx: RequestContext) {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    const [posts, messages, sessions, devices, following, followers] = await Promise.all([
      this.deps.db.many('select id, body, visibility, created_at from posts where author_id = $1 order by created_at desc limit 5000', [userId]),
      this.deps.db.many(
        `select id, conversation_id, body, type, created_at from messages where sender_id = $1 order by created_at desc limit 5000`,
        [userId],
      ),
      this.deps.repos.sessions.listSessions(userId),
      this.deps.repos.sessions.listDevices(userId),
      this.deps.repos.social.following(userId, 1000, 0),
      this.deps.repos.social.followers(userId, 1000, 0),
    ]);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'user.data_exported',
      targetType: 'user',
      targetId: userId,
    });
    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        locale: user.locale,
        createdAt: user.created_at.toISOString(),
      },
      posts,
      messages,
      sessions: sessions.map((s) => ({ id: s.id, createdAt: s.created_at, ip: s.ip })),
      devices: devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at })),
      following: following.map((f) => f.username),
      followers: followers.map((f) => f.username),
    };
  }

  /** Account deletion anonymises the row and revokes every credential immediately. */
  async deleteAccount(userId: string, ctx: RequestContext) {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    const anonymised = `deleted_${userId.slice(0, 8)}_${Date.now().toString(36)}`;
    await this.deps.repos.users.deleteAccount(userId, anonymised);
    await this.deps.repos.audit.record({
      actorId: null,
      actorIp: ctx.ip,
      action: 'user.account_deleted',
      targetType: 'user',
      targetId: userId,
      metadata: { previousUsername: user.username },
    });
    return { deleted: true };
  }

  async issues(userId: string) {
    const [devices, sessions, keys] = await Promise.all([
      this.deps.repos.sessions.listDevices(userId),
      this.deps.repos.sessions.listSessions(userId),
      this.deps.repos.keys.forUser(userId),
    ]);
    return {
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        lastSeenAt: d.last_seen_at.toISOString(),
      })),
      sessions: sessions.length,
      e2eeDevices: keys.length,
    };
  }
}
