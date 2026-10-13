import type { Db } from '../db/pool.js';
import { decodeCursor, encodeCursor } from '../lib/crypto.js';

/** Public timeline posts: create, feed, likes, comments, reposts, hashtags. */

export interface PostRow {
  id: string;
  author_id: string;
  body: string;
  visibility: 'public' | 'followers';
  reply_to_id: string | null;
  repost_of_id: string | null;
  quote_of_id: string | null;
  hashtags: string[];
  mentions: string[];
  like_count: number;
  comment_count: number;
  repost_count: number;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface PostWithAuthorRow extends PostRow {
  author_username: string;
  author_display_name: string;
  author_avatar_url: string | null;
  author_created_at?: Date;
  viewer_liked: boolean;
  viewer_reposted: boolean;
  viewer_following: boolean;
  repost_of_body: string | null;
  repost_of_created_at: Date | null;
  repost_author_username: string | null;
  repost_author_display_name: string | null;
  repost_author_avatar_url: string | null;
}

const POST_SELECT = `
  select p.*,
         au.username as author_username,
         au.display_name as author_display_name,
         au.avatar_url as author_avatar_url,
         coalesce((select true from post_likes pl where pl.post_id = p.id and pl.user_id = $1), false) as viewer_liked,
         coalesce((select true from posts rp where rp.repost_of_id = p.id and rp.author_id = $1 and rp.deleted_at is null), false) as viewer_reposted,
         coalesce((select true from follows f where f.follower_id = $1 and f.following_id = p.author_id), false) as viewer_following,
         ro.body as repost_of_body,
         ro.created_at as repost_of_created_at,
         rau.username as repost_author_username,
         rau.display_name as repost_author_display_name,
         rau.avatar_url as repost_author_avatar_url
  from posts p
  join users au on au.id = p.author_id
  left join posts ro on ro.id = p.repost_of_id
  left join users rau on rau.id = ro.author_id
`;

export class PostsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    authorId: string;
    body: string;
    visibility?: 'public' | 'followers';
    hashtags?: string[];
    mentions?: string[];
    replyToId?: string | null;
    repostOfId?: string | null;
    quoteOfId?: string | null;
  }): Promise<PostRow> {
    return this.db.oneOrFail<PostRow>(
      `insert into posts (author_id, body, visibility, hashtags, mentions, reply_to_id, repost_of_id, quote_of_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [
        input.authorId,
        input.body,
        input.visibility ?? 'public',
        input.hashtags ?? [],
        input.mentions ?? [],
        input.replyToId ?? null,
        input.repostOfId ?? null,
        input.quoteOfId ?? null,
      ],
      'service_unavailable',
    );
  }

  findById(viewerId: string, id: string): Promise<PostWithAuthorRow | null> {
    return this.db.one<PostWithAuthorRow>(`${POST_SELECT} where p.id = $2 and p.deleted_at is null`, [viewerId, id]);
  }

  async attachMedia(postId: string, attachmentIds: string[], uploaderId: string): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    const res = await this.db.query(
      `update attachments set post_id = $1
       where id = any($2::uuid[]) and uploader_id = $3 and post_id is null and message_id is null and deleted_at is null`,
      [postId, attachmentIds, uploaderId],
    );
    return res.rowCount ?? 0;
  }

  async incrementCounter(postId: string, column: 'like_count' | 'comment_count' | 'repost_count', delta: number): Promise<void> {
    const sql = `update posts set ${column} = greatest(0, ${column} + $2) where id = $1`;
    await this.db.query(sql, [postId, delta]);
  }

  async like(viewerId: string, postId: string): Promise<{ liked: boolean }> {
    const res = await this.db.query('insert into post_likes (post_id, user_id) values ($1, $2) on conflict do nothing', [
      postId,
      viewerId,
    ]);
    const created = (res.rowCount ?? 0) > 0;
    if (created) await this.incrementCounter(postId, 'like_count', 1);
    return { liked: true };
  }

  async unlike(viewerId: string, postId: string): Promise<{ liked: boolean }> {
    const res = await this.db.query('delete from post_likes where post_id = $1 and user_id = $2', [postId, viewerId]);
    if ((res.rowCount ?? 0) > 0) await this.incrementCounter(postId, 'like_count', -1);
    return { liked: false };
  }

  async deleteRepost(authorId: string, postId: string): Promise<boolean> {
    const res = await this.db.query(
      'update posts set deleted_at = now() where author_id = $1 and repost_of_id = $2 and deleted_at is null',
      [authorId, postId],
    );
    if ((res.rowCount ?? 0) > 0) await this.incrementCounter(postId, 'repost_count', -1);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Home timeline:
   *  - `following`: chronological posts from followed accounts (+ own posts). No ranking,
   *    as required: a trustworthy chronological feed first.
   *  - `for-you`: highest-engagement public posts of the last 7 days (still simple and explainable).
   *  - `trending`: posts with the most likes in the last 48 hours.
   */
  async feed(input: {
    viewerId: string;
    tab: 'for-you' | 'following' | 'trending';
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: PostWithAuthorRow[]; nextCursor: string | null }> {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const order = 'p.created_at desc, p.id desc';

    if (input.tab === 'following') {
      const rows = await this.db.many<PostWithAuthorRow>(
        `${POST_SELECT}
         where p.deleted_at is null and p.reply_to_id is null
           and (p.author_id = $1 or exists (select 1 from follows f where f.follower_id = $1 and f.following_id = p.author_id))
           and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
         order by ${order}
         limit $2`,
        [input.viewerId, input.limit, decoded?.c ?? null, decoded?.i ?? null],
      );
      return this.withCursor(rows, input.limit);
    }

    if (input.tab === 'for-you') {
      const rows = await this.db.many<PostWithAuthorRow>(
        `${POST_SELECT}
         where p.deleted_at is null and p.reply_to_id is null and p.visibility = 'public'
           and p.created_at > now() - interval '7 days'
           and not exists (select 1 from blocks b where b.blocker_id = $1 and b.blocked_id = p.author_id)
           and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
         order by ${order}
         limit $2`,
        [input.viewerId, input.limit, decoded?.c ?? null, decoded?.i ?? null],
      );
      return this.withCursor(rows, input.limit);
    }

    const rows = await this.db.many<PostWithAuthorRow>(
      `${POST_SELECT}
       where p.deleted_at is null and p.reply_to_id is null and p.visibility = 'public'
         and p.created_at > now() - interval '48 hours' and p.like_count > 0
         and not exists (select 1 from blocks b where b.blocker_id = $1 and b.blocked_id = p.author_id)
         and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
       order by p.like_count desc, ${order}
       limit $2`,
      [input.viewerId, input.limit, decoded?.c ?? null, decoded?.i ?? null],
    );
    return this.withCursor(rows, input.limit);
  }

  private withCursor(rows: PostWithAuthorRow[], limit: number) {
    const hasMore = rows.length === limit;
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: hasMore && last ? encodeCursor({ c: last.created_at.toISOString(), i: last.id }) : null,
    };
  }

  async byAuthor(input: { viewerId: string; authorId: string; limit: number; cursor?: string | null; includeReplies: boolean }) {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db.many<PostWithAuthorRow>(
      `${POST_SELECT}
       where p.deleted_at is null and p.author_id = $2
         and ($5::boolean or p.reply_to_id is null)
         and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
       order by p.created_at desc, p.id desc
       limit $6`,
      [
        input.viewerId,
        input.authorId,
        decoded?.c ?? null,
        decoded?.i ?? null,
        input.includeReplies,
        input.limit,
      ],
    );
    return this.withCursor(rows, input.limit);
  }

  async comments(input: { viewerId: string; postId: string; limit: number; cursor?: string | null }) {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db.many<PostWithAuthorRow>(
      `${POST_SELECT}
       where p.deleted_at is null and p.reply_to_id = $2
         and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
       order by p.created_at asc, p.id asc
       limit $5`,
      [input.viewerId, input.postId, decoded?.c ?? null, decoded?.i ?? null, input.limit],
    );
    return this.withCursor(rows, input.limit);
  }

  async likers(postId: string, limit: number) {
    return this.db.many<{ id: string; username: string; display_name: string; avatar_url: string | null }>(
      `select u.id, u.username, u.display_name, u.avatar_url from post_likes pl join users u on u.id = pl.user_id
       where pl.post_id = $1 order by pl.created_at desc limit $2`,
      [postId, limit],
    );
  }

  async byHashtag(input: { viewerId: string; tag: string; limit: number; cursor?: string | null }) {
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db.many<PostWithAuthorRow>(
      `${POST_SELECT}
       where p.deleted_at is null and p.visibility = 'public' and $2 = any(p.hashtags)
         and ($3::timestamptz is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
       order by p.created_at desc, p.id desc
       limit $5`,
      [input.viewerId, input.tag, decoded?.c ?? null, decoded?.i ?? null, input.limit],
    );
    return this.withCursor(rows, input.limit);
  }

  async trendingHashtags(limit: number) {
    return this.db.many<{ tag: string; uses: string; likes: string }>(
      `select tag, count(*)::text as uses, coalesce(sum(p.like_count), 0)::text as likes
       from posts p, unnest(p.hashtags) as tag
       where p.deleted_at is null and p.visibility = 'public' and p.created_at > now() - interval '7 days'
       group by tag order by sum(p.like_count) desc, count(*) desc limit $1`,
      [limit],
    );
  }

  /** Simple relevance search over post bodies. */
  async search(input: { viewerId: string; term: string; limit: number }) {
    return this.db.many<PostWithAuthorRow>(
      `${POST_SELECT}
       where p.deleted_at is null and p.visibility = 'public' and p.body ilike '%' || $2 || '%'
       order by p.created_at desc limit $3`,
      [input.viewerId, input.term, input.limit],
    );
  }

  async softDelete(postId: string, actorId: string | null): Promise<boolean> {
    const res = await this.db.query(
      `update posts set deleted_at = now() where id = $1 and ($2::uuid is null or author_id = $2) and deleted_at is null`,
      [postId, actorId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
