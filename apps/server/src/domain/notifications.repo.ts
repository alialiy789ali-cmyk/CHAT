import type { Db } from '../db/pool.js';

/** In-app notification inbox (push delivery is documented as an external dependency). */

export class NotificationsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    kind: string;
    actorId?: string | null;
    conversationId?: string | null;
    postId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const row = await this.db.oneOrFail<{ id: string }>(
      `insert into notifications (user_id, kind, actor_id, conversation_id, post_id, payload)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.userId,
        input.kind,
        input.actorId ?? null,
        input.conversationId ?? null,
        input.postId ?? null,
        JSON.stringify(input.payload ?? {}),
      ],
      'service_unavailable',
    );
    return row;
  }

  createManyInputs(
    userIds: string[],
    build: (userId: string) => {
      kind: string;
      actorId?: string | null;
      conversationId?: string | null;
      postId?: string | null;
      payload?: Record<string, unknown>;
    },
  ) {
    return userIds.map(build);
  }

  async list(userId: string, limit: number, onlyUnread = false) {
    return this.db.many<{
      id: string;
      kind: string;
      actor_id: string | null;
      conversation_id: string | null;
      post_id: string | null;
      payload: Record<string, unknown>;
      read_at: Date | null;
      created_at: Date;
      actor_username: string | null;
      actor_display_name: string | null;
      actor_avatar_url: string | null;
    }>(
      `select n.*, u.username as actor_username, u.display_name as actor_display_name, u.avatar_url as actor_avatar_url
       from notifications n left join users u on u.id = n.actor_id
       where n.user_id = $1 and ($2::boolean is not true or n.read_at is null)
       order by n.created_at desc limit $3`,
      [userId, onlyUnread, limit],
    );
  }

  async unreadCount(userId: string): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      'select count(*)::text as count from notifications where user_id = $1 and read_at is null',
      [userId],
    );
    return Number(row?.count ?? 0);
  }

  async markRead(userId: string, ids?: string[]): Promise<number> {
    const res = await this.db.query(
      `update notifications set read_at = now() where user_id = $1 and read_at is null and ($2::bigint[] is null or id = any($2::bigint[]))`,
      [userId, ids && ids.length ? ids.map((i) => Number(i)) : null],
    );
    return res.rowCount ?? 0;
  }
}
