import { AppError, assert } from '../lib/errors.js';
import type { AppDeps, RequestContext } from './context.js';
import { postToDto } from './serializers.js';
import type { DomainEvents } from './events.js';
import type { AttachmentRow } from '../domain/messages.repo.js';

/**
 * Public social network (requirement 2.E): posts, media, follows, likes, comments,
 * reposts, quotes, hashtags, search, notifications.
 *
 * Deliberately starting with a chronological "following" feed: it is fast, explainable
 * and does not require behavioural profiling. The `for-you` and `trending` tabs use
 * only public engagement counters.
 */

const HASHTAG_RE = /#([\p{L}\p{N}_]{1,50})/gu;
const MENTION_RE = /@([a-z0-9_]{3,24})/gi;

export function extractHashtags(body: string): string[] {
  return [...new Set([...body.matchAll(HASHTAG_RE)].map((m) => (m[1] ?? '').toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function extractMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => (m[1] ?? '').toLowerCase()).filter(Boolean))].slice(0, 20);
}

export class SocialService {
  constructor(
    private readonly deps: AppDeps,
    private readonly events: DomainEvents,
  ) {}

  /** --------------------------------------------------------------- posts */

  async createPost(
    userId: string,
    input: { body: string; visibility: 'public' | 'followers'; attachmentIds?: string[]; replyToId?: string | null; quoteOfId?: string | null },
    ctx: RequestContext,
  ) {
    const body = input.body.trim();
    const attachmentIds = input.attachmentIds ?? [];
    assert(body.length > 0 || attachmentIds.length > 0, 'validation_error', 'post_must_have_content');
    assert(body.length <= 4000, 'validation_error', 'post_too_long');

    const hashtags = extractHashtags(body);
    const mentionNames = extractMentions(body);
    const mentioned = mentionNames.length
      ? await this.deps.db.many<{ id: string; username: string }>(
          'select id, username::text as username from users where username = any($1::citext[]) and deleted_at is null',
          [mentionNames],
        )
      : [];

    if (input.replyToId) {
      const parent = await this.deps.repos.posts.findById(userId, input.replyToId);
      assert(parent, 'post_not_found', 'reply_target_missing');
      if (parent.visibility === 'followers' && parent.author_id !== userId) {
        const follows = await this.deps.repos.social.isFollowing(userId, parent.author_id);
        assert(follows, 'forbidden', 'cannot_reply_to_followers_only_post');
      }
    }
    if (input.quoteOfId) {
      const quoted = await this.deps.repos.posts.findById(userId, input.quoteOfId);
      assert(quoted, 'post_not_found', 'quoted_post_missing');
    }

    const post = await this.deps.repos.posts.create({
      authorId: userId,
      body,
      visibility: input.visibility,
      hashtags,
      mentions: mentionNames,
      replyToId: input.replyToId ?? null,
      quoteOfId: input.quoteOfId ?? null,
    });

    if (attachmentIds.length > 0) {
      const attached = await this.deps.repos.posts.attachMedia(post.id, attachmentIds, userId);
      assert(attached === attachmentIds.length, 'validation_error', 'some_attachments_unavailable');
    }
    if (input.replyToId) {
      await this.deps.repos.posts.incrementCounter(input.replyToId, 'comment_count', 1);
    }

    // Notify: parent author (comment), followers (new post), mentioned users.
    const parent = input.replyToId ? await this.deps.repos.posts.findById(userId, input.replyToId) : null;
    if (parent && parent.author_id !== userId) {
      await this.deps.repos.notifications.create({
        userId: parent.author_id,
        kind: 'comment',
        actorId: userId,
        postId: post.id,
        payload: { preview: body.slice(0, 120), replyToId: input.replyToId },
      });
    }
    for (const user of mentioned) {
      if (user.id === userId) continue;
      await this.deps.repos.notifications.create({
        userId: user.id,
        kind: 'mention',
        actorId: userId,
        postId: post.id,
        payload: { preview: body.slice(0, 120) },
      });
    }

    const followerRows = await this.deps.db.many<{ follower_id: string }>(
      'select follower_id from follows where following_id = $1',
      [userId],
    );
    const recipientIds = followerRows.map((r) => r.follower_id);
    await this.events.emit({ type: 'post.created', postId: post.id, authorId: userId, recipientIds, at: post.created_at });

    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: input.replyToId ? 'post.comment_created' : 'post.created',
      targetType: 'post',
      targetId: post.id,
      metadata: { visibility: input.visibility, attachments: attachmentIds.length, hashtags },
    });

    return this.getPost(post.id, userId);
  }

  async getPost(postId: string, viewerId: string | null) {
    const row = await this.deps.repos.posts.findById(viewerId ?? '00000000-0000-0000-0000-000000000000', postId);
    if (!row) throw new AppError('post_not_found');
    if (row.visibility === 'followers' && row.author_id !== viewerId) {
      if (!viewerId) throw new AppError('forbidden', 'followers_only');
      const follows = await this.deps.repos.social.isFollowing(viewerId, row.author_id);
      if (!follows) throw new AppError('forbidden', 'followers_only');
    }
    const media = await this.deps.repos.files.listForPost(postId);
    return postToDto(row, media, viewerId);
  }

  async deletePost(postId: string, userId: string, ctx: RequestContext) {
    const post = await this.deps.repos.posts.findById(userId, postId);
    if (!post) throw new AppError('post_not_found');
    const user = await this.deps.repos.users.findById(userId);
    const isStaff = user?.role === 'admin' || user?.role === 'moderator';
    if (post.author_id !== userId && !isStaff) throw new AppError('forbidden', 'only_author_can_delete');
    const deleted = await this.deps.repos.posts.softDelete(postId, post.author_id === userId ? userId : null);
    if (!deleted) throw new AppError('post_not_found', 'already_deleted');
    if (post.reply_to_id) await this.deps.repos.posts.incrementCounter(post.reply_to_id, 'comment_count', -1);
    if (post.repost_of_id) await this.deps.repos.posts.incrementCounter(post.repost_of_id, 'repost_count', -1);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: isStaff && post.author_id !== userId ? 'post.removed_by_moderator' : 'post.deleted_own',
      targetType: 'post',
      targetId: postId,
    });
    return { deleted: true };
  }

  async feed(viewerId: string, params: { tab: 'following' | 'for-you' | 'trending'; limit: number; cursor?: string }) {
    const { items, nextCursor } = await this.deps.repos.posts.feed({
      viewerId,
      tab: params.tab,
      limit: params.limit,
      cursor: params.cursor,
    });
    const media = await this.deps.repos.files.listForPosts(items.map((i) => i.id));
    const byPost = groupAttachments(media);
    return {
      items: items.map((row) => postToDto(row, byPost.get(row.id) ?? [], viewerId)),
      nextCursor,
    };
  }

  async like(postId: string, userId: string) {
    const post = await this.deps.repos.posts.findById(userId, postId);
    if (!post) throw new AppError('post_not_found');
    if (post.author_id !== userId) {
      await this.deps.repos.notifications.create({ userId: post.author_id, kind: 'like', actorId: userId, postId });
    }
    const result = await this.deps.repos.posts.like(userId, postId);
    await this.events.emit({ type: 'post.liked', postId, actorId: userId, authorId: post.author_id, at: new Date() });
    return result;
  }

  async unlike(postId: string, userId: string) {
    return this.deps.repos.posts.unlike(userId, postId);
  }

  async likers(postId: string, limit = 50) {
    return this.deps.repos.posts.likers(postId, limit);
  }

  async repost(postId: string, userId: string) {
    const original = await this.deps.repos.posts.findById(userId, postId);
    if (!original) throw new AppError('post_not_found');
    if (original.repost_of_id) throw new AppError('conflict', 'cannot_repost_a_repost');
    const existing = await this.deps.db.one<{ id: string }>(
      'select id from posts where author_id = $1 and repost_of_id = $2 and deleted_at is null',
      [userId, postId],
    );
    if (existing) {
      await this.deps.repos.posts.deleteRepost(userId, postId);
      return { reposted: false };
    }
    const created = await this.deps.repos.posts.create({ authorId: userId, body: '', repostOfId: postId });
    await this.deps.repos.posts.incrementCounter(postId, 'repost_count', 1);
    if (original.author_id !== userId) {
      await this.deps.repos.notifications.create({ userId: original.author_id, kind: 'repost', actorId: userId, postId });
    }
    return { reposted: true, postId: created.id };
  }

  async comments(postId: string, viewerId: string | null, params: { limit: number; cursor?: string }) {
    const post = await this.deps.repos.posts.findById(viewerId ?? '00000000-0000-0000-0000-000000000000', postId);
    if (!post) throw new AppError('post_not_found');
    const { items, nextCursor } = await this.deps.repos.posts.comments({
      viewerId: viewerId ?? post.author_id,
      postId,
      limit: params.limit,
      cursor: params.cursor,
    });
    const media = await this.deps.repos.files.listForPosts(items.map((i) => i.id));
    const byPost = groupAttachments(media);
    return {
      items: items.map((row) => postToDto(row, byPost.get(row.id) ?? [], viewerId)),
      nextCursor,
    };
  }

  async byHashtag(tag: string, viewerId: string, params: { limit: number; cursor?: string }) {
    const clean = tag.replace(/^#/, '').toLowerCase();
    const { items, nextCursor } = await this.deps.repos.posts.byHashtag({ viewerId, tag: clean, limit: params.limit, cursor: params.cursor });
    const media = await this.deps.repos.files.listForPosts(items.map((i) => i.id));
    const byPost = groupAttachments(media);
    return {
      tag: clean,
      items: items.map((row) => postToDto(row, byPost.get(row.id) ?? [], viewerId)),
      nextCursor,
    };
  }

  async trendingHashtags(limit = 10) {
    const rows = await this.deps.repos.posts.trendingHashtags(limit);
    return rows.map((row) => ({ tag: row.tag, uses: Number(row.uses), likes: Number(row.likes) }));
  }

  /** Unified search used by the explore page. */
  async search(viewerId: string, term: string, type: 'all' | 'users' | 'posts' | 'channels', limit: number) {
    const result: Record<string, unknown[]> = { users: [], posts: [], channels: [] };
    if (type === 'all' || type === 'users') {
      const users = await this.deps.repos.users.search(term, limit);
      result.users = users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        bio: u.bio,
      }));
    }
    if (type === 'all' || type === 'posts') {
      const posts = await this.deps.repos.posts.search({ viewerId, term, limit });
      result.posts = posts.map((row) => postToDto(row, [], viewerId));
    }
    if (type === 'all' || type === 'channels') {
      const channels = await this.deps.repos.channels.discover({ viewerId, term, limit });
      result.channels = channels.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        subscriberCount: c.subscriber_count,
        isSubscribed: c.is_subscribed,
      }));
    }
    return result;
  }

  /** --------------------------------------------------------------- notifications */

  async notifications(userId: string, limit: number, onlyUnread = false) {
    const rows = await this.deps.repos.notifications.list(userId, limit, onlyUnread);
    const unread = await this.deps.repos.notifications.unreadCount(userId);
    return {
      unread,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        actor: row.actor_id
          ? {
              id: row.actor_id,
              username: row.actor_username,
              displayName: row.actor_display_name,
              avatarUrl: row.actor_avatar_url,
            }
          : null,
        conversationId: row.conversation_id,
        postId: row.post_id,
        payload: row.payload,
        readAt: row.read_at ? row.read_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async markNotificationsRead(userId: string, ids?: string[]) {
    const count = await this.deps.repos.notifications.markRead(userId, ids);
    return { updated: count };
  }
}

function groupAttachments(rows: AttachmentRow[]): Map<string, AttachmentRow[]> {
  const map = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const key = row.post_id ?? row.channel_post_id ?? '';
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}
