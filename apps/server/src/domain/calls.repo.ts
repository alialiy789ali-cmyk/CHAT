import type { Db } from '../db/pool.js';

/** Call records + participants, and live rooms (audio spaces / group calls). */

export interface CallRow {
  id: string;
  conversation_id: string;
  initiator_id: string | null;
  kind: 'audio' | 'video';
  state: 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'failed';
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  ended_by: string | null;
  duration_ms: number | null;
}

export class CallsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    conversationId: string;
    initiatorId: string;
    kind: 'audio' | 'video';
    participantIds: string[];
  }): Promise<CallRow> {
    return this.db.withTransaction(async (tx) => {
      const call = await tx.oneOrFail<CallRow>(
        `insert into calls (conversation_id, initiator_id, kind) values ($1, $2, $3) returning *`,
        [input.conversationId, input.initiatorId, input.kind],
        'service_unavailable',
      );
      if (input.participantIds.length) {
        await tx.query(
          `insert into call_participants (call_id, user_id, state)
           select $1, unnest($2::uuid[]), 'invited' on conflict do nothing`,
          [call.id, input.participantIds],
        );
      }
      return call;
    });
  }

  findById(id: string): Promise<CallRow | null> {
    return this.db.one<CallRow>('select * from calls where id = $1', [id]);
  }

  async markAnswered(callId: string, userId: string): Promise<CallRow | null> {
    const row = await this.db.one<CallRow>(
      `update calls set state = 'active', answered_at = coalesce(answered_at, now())
       where id = $1 and state = 'ringing' returning *`,
      [callId],
    );
    await this.db.query(
      `update call_participants set state = 'joined', joined_at = now() where call_id = $1 and user_id = $2`,
      [callId, userId],
    );
    return row ?? this.findById(callId);
  }

  async markParticipantState(callId: string, userId: string, state: 'joined' | 'declined' | 'missed' | 'left') {
    await this.db.query(
      `update call_participants
       set state = $3,
           joined_at = case when $3 = 'joined' then coalesce(joined_at, now()) else joined_at end,
           left_at = case when $3 in ('left', 'declined') then now() else left_at end
       where call_id = $1 and user_id = $2`,
      [callId, userId, state],
    );
  }

  async end(callId: string, userId: string, state: 'ended' | 'declined' | 'missed' | 'failed', reason: string): Promise<CallRow | null> {
    const row = await this.db.one<CallRow>(
      `update calls
       set state = $3, ended_at = now(), ended_by = $2, end_reason = $4,
           duration_ms = case when answered_at is not null then (extract(epoch from (now() - answered_at)) * 1000)::int else 0 end
       where id = $1 and state in ('ringing', 'active')
       returning *`,
      [callId, userId, state, reason],
    );
    return row ?? this.findById(callId);
  }

  participants(callId: string) {
    return this.db.many<{ user_id: string; state: string; joined_at: Date | null; left_at: Date | null; username: string; display_name: string; avatar_url: string | null }>(
      `select p.user_id, p.state, p.joined_at, p.left_at, u.username, u.display_name, u.avatar_url
       from call_participants p join users u on u.id = p.user_id where p.call_id = $1`,
      [callId],
    );
  }

  history(userId: string, limit: number) {
    return this.db.many<CallRow & { direction: string; peer_username: string | null }>(
      `select c.*,
              case when c.initiator_id = $1 then 'outgoing' else 'incoming' end as direction,
              (select u.username::text from call_participants cp join users u on u.id = cp.user_id
                where cp.call_id = c.id and cp.user_id <> $1 limit 1) as peer_username
       from calls c
       join call_participants cp2 on cp2.call_id = c.id and cp2.user_id = $1
       order by c.started_at desc limit $2`,
      [userId, limit],
    );
  }

  async ringingFor(userId: string) {
    return this.db.many<CallRow & { initiator_username: string | null; initiator_display_name: string | null }>(
      `select c.*, u.username as initiator_username, u.display_name as initiator_display_name
       from calls c
       join call_participants cp on cp.call_id = c.id and cp.user_id = $1 and cp.state = 'invited'
       left join users u on u.id = c.initiator_id
       where c.state = 'ringing' and c.started_at > now() - interval '2 minutes'
       order by c.started_at desc`,
      [userId],
    );
  }

  /** ------------------------------------------------------------- live rooms */

  async createRoom(input: {
    hostId: string;
    title: string;
    topic?: string | null;
    kind: 'audio_space' | 'group_call';
    visibility: 'public' | 'private';
    scheduledFor?: Date | null;
  }) {
    return this.db.oneOrFail<{
      id: string;
      host_id: string;
      title: string;
      topic: string | null;
      kind: string;
      visibility: string;
      state: string;
      scheduled_for: Date | null;
      started_at: Date | null;
    }>(
      `insert into live_rooms (host_id, title, topic, kind, visibility, scheduled_for, state, started_at)
       values ($1, $2, $3, $4, $5, $6, case when $6 is null then 'live' else 'scheduled' end, case when $6 is null then now() else null end)
       returning id, host_id, title, topic, kind, visibility, state, scheduled_for, started_at`,
      [input.hostId, input.title, input.topic ?? null, input.kind, input.visibility, input.scheduledFor ?? null],
      'service_unavailable',
    );
  }

  async joinRoom(roomId: string, userId: string, role: 'host' | 'speaker' | 'listener' = 'listener') {
    await this.db.query(
      `insert into live_room_participants (room_id, user_id, role) values ($1, $2, $3)
       on conflict (room_id, user_id) do update set left_at = null`,
      [roomId, userId, role],
    );
  }

  listRooms(input: { limit: number; onlyLive?: boolean }) {
    return this.db.many<{ id: string; title: string; topic: string | null; kind: string; visibility: string; state: string; started_at: Date | null; host_username: string; participants: string }>(
      `select r.id, r.title, r.topic, r.kind, r.visibility, r.state, r.started_at, u.username as host_username,
              (select count(*)::text from live_room_participants p where p.room_id = r.id and p.left_at is null) as participants
       from live_rooms r join users u on u.id = r.host_id
       where ($2::boolean is not true or r.state = 'live')
       order by r.started_at desc nulls last limit $1`,
      [input.limit, input.onlyLive ?? false],
    );
  }

  room(roomId: string) {
    return this.db.one<{ id: string; host_id: string; title: string; topic: string | null; kind: string; state: string; started_at: Date | null }>(
      'select id, host_id, title, topic, kind, state, started_at from live_rooms where id = $1',
      [roomId],
    );
  }
}
