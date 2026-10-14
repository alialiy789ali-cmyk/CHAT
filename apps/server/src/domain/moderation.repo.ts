import type { Db } from '../db/pool.js';

/** Reports and moderation decisions. Every decision is explainable and reversible by a human. */

export interface ReportRow {
  id: string;
  reporter_id: string | null;
  target_type: 'user' | 'post' | 'message' | 'channel' | 'comment';
  target_id: string;
  reason: string;
  details: string | null;
  status: 'open' | 'reviewing' | 'resolved';
  decision: string | null;
  handled_by: string | null;
  handled_at: Date | null;
  note: string | null;
  created_at: Date;
}

export class ModerationRepo {
  constructor(private readonly db: Db) {}

  /** One open report per reporter/target; duplicates return the existing report. */
  async createReport(input: {
    reporterId: string;
    targetType: ReportRow['target_type'];
    targetId: string;
    reason: string;
    details?: string | null;
  }): Promise<{ report: ReportRow; duplicated: boolean }> {
    const created = await this.db.one<ReportRow>(
      `insert into reports (reporter_id, target_type, target_id, reason, details)
       values ($1, $2, $3, $4, $5)
       on conflict (reporter_id, target_type, target_id) where status = 'open' do nothing
       returning *`,
      [input.reporterId, input.targetType, input.targetId, input.reason, input.details ?? null],
    );
    if (created) return { report: created, duplicated: false };
    const existing = await this.db.oneOrFail<ReportRow>(
      `select * from reports where reporter_id = $1 and target_type = $2 and target_id = $3 and status = 'open'`,
      [input.reporterId, input.targetType, input.targetId],
      'conflict',
    );
    return { report: existing, duplicated: true };
  }

  list(filter: { status?: ReportRow['status']; limit: number; offset: number }) {
    return this.db.many<ReportRow & { reporter_username: string | null; target_preview: string | null }>(
      `select r.*, u.username as reporter_username,
              case r.target_type
                when 'post' then (select left(p.body, 160) from posts p where p.id::text = r.target_id)
                when 'message' then (select left(m.body, 160) from messages m where m.id::text = r.target_id)
                when 'channel' then (select c.name from channels c where c.id::text = r.target_id)
                when 'user' then (select u2.username::text from users u2 where u2.id::text = r.target_id)
                else null
              end as target_preview
       from reports r left join users u on u.id = r.reporter_id
       where ($1::text is null or r.status = $1)
       order by r.created_at desc limit $2 offset $3`,
      [filter.status ?? null, filter.limit, filter.offset],
    );
  }

  async resolve(input: {
    reportId: string;
    moderatorId: string;
    decision: 'dismissed' | 'hidden' | 'removed' | 'user_warned' | 'user_suspended';
    note?: string | null;
  }): Promise<ReportRow> {
    return this.db.oneOrFail<ReportRow>(
      `update reports set status = 'resolved', decision = $2, handled_by = $3, handled_at = now(), note = $4
       where id = $1 returning *`,
      [input.reportId, input.decision, input.moderatorId, input.note ?? null],
      'not_found',
    );
  }

  findReport(id: string): Promise<ReportRow | null> {
    return this.db.one<ReportRow>('select * from reports where id = $1', [id]);
  }

  async recordAction(input: {
    moderatorId: string;
    targetType: string;
    targetId: string;
    action: string;
    reason?: string | null;
    reportId?: string | null;
  }): Promise<void> {
    await this.db.query(
      `insert into moderation_actions (moderator_id, target_type, target_id, action, reason, report_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.moderatorId, input.targetType, input.targetId, input.action, input.reason ?? null, input.reportId ?? null],
    );
  }

  async openCount(): Promise<number> {
    const row = await this.db.one<{ count: string }>("select count(*)::text as count from reports where status = 'open'");
    return Number(row?.count ?? 0);
  }
}
