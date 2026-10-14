import type { Db } from '../db/pool.js';

/** Follows, blocks and the friendship/contact notion used by privacy rules. */

export class SocialRepo {
  constructor(private readonly db: Db) {}

  async follow(followerId: string, followingId: string): Promise<boolean> {
    const res = await this.db.query(
      `insert into follows (follower_id, following_id) values ($1, $2) on conflict do nothing`,
      [followerId, followingId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unfollow(followerId: string, followingId: string): Promise<boolean> {
    const res = await this.db.query('delete from follows where follower_id = $1 and following_id = $2', [
      followerId,
      followingId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const row = await this.db.one<{ exists: boolean }>(
      'select exists(select 1 from follows where follower_id = $1 and following_id = $2) as exists',
      [followerId, followingId],
    );
    return Boolean(row?.exists);
  }

  async mutualFollow(a: string, b: string): Promise<boolean> {
    const row = await this.db.one<{ exists: boolean }>(
      `select exists(
         select 1 from follows f1 join follows f2 on f1.follower_id = f2.following_id
         where f1.follower_id = $1 and f1.following_id = $2 and f2.follower_id = $2 and f2.following_id = $1
       ) as exists`,
      [a, b],
    );
    return Boolean(row?.exists);
  }

  async followers(userId: string, limit: number, offset: number) {
    return this.db.many<{ id: string; username: string; display_name: string; avatar_url: string | null; bio: string | null; followed_at: Date }>(
      `select u.id, u.username, u.display_name, u.avatar_url, u.bio, f.created_at as followed_at
       from follows f join users u on u.id = f.follower_id
       where f.following_id = $1 and u.deleted_at is null
       order by f.created_at desc limit $2 offset $3`,
      [userId, limit, offset],
    );
  }

  async following(userId: string, limit: number, offset: number) {
    return this.db.many<{ id: string; username: string; display_name: string; avatar_url: string | null; bio: string | null; followed_at: Date }>(
      `select u.id, u.username, u.display_name, u.avatar_url, u.bio, f.created_at as followed_at
       from follows f join users u on u.id = f.following_id
       where f.follower_id = $1 and u.deleted_at is null
       order by f.created_at desc limit $2 offset $3`,
      [userId, limit, offset],
    );
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query('insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing', [
        blockerId,
        blockedId,
      ]);
      // Blocking removes any follow relationship in both directions.
      await tx.query(
        'delete from follows where (follower_id = $1 and following_id = $2) or (follower_id = $2 and following_id = $1)',
        [blockerId, blockedId],
      );
    });
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.db.query('delete from blocks where blocker_id = $1 and blocked_id = $2', [blockerId, blockedId]);
  }

  async blockedBy(blockerId: string, blockedId: string): Promise<boolean> {
    const row = await this.db.one<{ exists: boolean }>(
      'select exists(select 1 from blocks where blocker_id = $1 and blocked_id = $2) as exists',
      [blockerId, blockedId],
    );
    return Boolean(row?.exists);
  }

  async blockExistsBetween(a: string, b: string): Promise<boolean> {
    const row = await this.db.one<{ exists: boolean }>(
      'select exists(select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)) as exists',
      [a, b],
    );
    return Boolean(row?.exists);
  }

  async blockedUserIds(blockerId: string): Promise<string[]> {
    const rows = await this.db.many<{ blocked_id: string }>('select blocked_id from blocks where blocker_id = $1', [
      blockerId,
    ]);
    return rows.map((r) => r.blocked_id);
  }

  async blockList(blockerId: string) {
    return this.db.many<{ id: string; username: string; display_name: string; avatar_url: string | null; blocked_at: Date }>(
      `select u.id, u.username, u.display_name, u.avatar_url, b.created_at as blocked_at
       from blocks b join users u on u.id = b.blocked_id where b.blocker_id = $1 order by b.created_at desc`,
      [blockerId],
    );
  }

  async counts(userId: string) {
    const row = await this.db.one<{ followers: string; following: string }>(
      `select (select count(*)::text from follows where following_id = $1) as followers,
              (select count(*)::text from follows where follower_id = $1) as following`,
      [userId],
    );
    return { followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) };
  }

  /**
   * Suggestion list: people followed by the people you follow, excluding yourself,
   * blocked users and anyone already followed.
   */
  async suggestions(userId: string, limit: number) {
    return this.db.many<{ id: string; username: string; display_name: string; avatar_url: string | null; mutuals: string }>(
      `select u.id, u.username, u.display_name, u.avatar_url, count(*)::text as mutuals
       from follows f
       join follows f2 on f2.follower_id = f.following_id
       join users u on u.id = f2.following_id
       where f.follower_id = $1
         and f2.following_id <> $1
         and not exists (select 1 from follows me where me.follower_id = $1 and me.following_id = f2.following_id)
         and not exists (select 1 from blocks b where (b.blocker_id = $1 and b.blocked_id = f2.following_id) or (b.blocker_id = f2.following_id and b.blocked_id = $1))
       group by u.id, u.username, u.display_name, u.avatar_url
       order by count(*) desc, u.created_at desc
       limit $2`,
      [userId, limit],
    );
  }
}
