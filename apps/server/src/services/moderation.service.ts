import { AppError, assert } from '../lib/errors.js';
import { Roles } from '../domain/roles.js';
import type { AppDeps, RequestContext } from './context.js';

/**
 * Reporting and moderation (requirement 2.E "abuse prevention", requirement 6).
 *
 * Principles:
 *  - any authenticated user can report content,
 *  - only staff (global admin/moderator) can read the queue and decide,
 *  - every decision is recorded with the human who made it (audit trail) and is reversible,
 *  - moderators can never silently edit content: they hide or remove it, and the
 *    target row keeps its history.
 */

export class ModerationService {
  constructor(private readonly deps: AppDeps) {}

  async report(
    reporterId: string,
    input: { targetType: 'user' | 'post' | 'message' | 'channel' | 'comment'; targetId: string; reason: string; details?: string },
    ctx: RequestContext,
  ) {
    // The target must exist, otherwise reports become a garbage channel.
    const exists = await this.targetExists(input.targetType, input.targetId);
    assert(exists, 'not_found', 'report_target_not_found');

    const { report, duplicated } = await this.deps.repos.moderation.createReport({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      details: input.details ?? null,
    });
    await this.deps.repos.audit.record({
      actorId: reporterId,
      actorIp: ctx.ip,
      action: 'moderation.report_created',
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: { reason: input.reason, duplicated },
    });
    return {
      id: report.id,
      status: report.status,
      duplicated,
      createdAt: report.created_at.toISOString(),
    };
  }

  private async targetExists(type: string, id: string): Promise<boolean> {
    const checks: Record<string, string> = {
      user: 'select 1 from users where id = $1 and deleted_at is null',
      post: 'select 1 from posts where id = $1 and deleted_at is null',
      comment: 'select 1 from posts where id = $1 and deleted_at is null',
      message: 'select 1 from messages where id = $1 and deleted_at is null',
      channel: 'select 1 from channels where id = $1 and deleted_at is null',
    };
    const sql = checks[type];
    if (!sql) return false;
    // Non-UUID ids would raise a database error; validate first.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const row = await this.deps.db.one(sql, [id]);
    return Boolean(row);
  }

  private async requireStaff(userId: string): Promise<void> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user || !Roles.isStaff(user.role)) throw new AppError('forbidden', 'staff_only');
  }

  async queue(userId: string, filter: { status?: 'open' | 'reviewing' | 'resolved'; limit: number; offset: number }) {
    await this.requireStaff(userId);
    const rows = await this.deps.repos.moderation.list(filter);
    const openCount = await this.deps.repos.moderation.openCount();
    return {
      openCount,
      items: rows.map((row) => ({
        id: row.id,
        reporterId: row.reporter_id,
        reporterUsername: row.reporter_username,
        targetType: row.target_type,
        targetId: row.target_id,
        targetPreview: row.target_preview,
        reason: row.reason,
        details: row.details,
        status: row.status,
        decision: row.decision,
        note: row.note,
        handledBy: row.handled_by,
        handledAt: row.handled_at ? row.handled_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async resolve(
    moderatorId: string,
    reportId: string,
    input: {
      decision: 'dismissed' | 'hidden' | 'removed' | 'user_warned' | 'user_suspended';
      note?: string;
    },
    ctx: RequestContext,
  ) {
    await this.requireStaff(moderatorId);
    const report = await this.deps.repos.moderation.findReport(reportId);
    if (!report) throw new AppError('not_found', 'report_not_found');

    // Apply the decision to the target.
    if (input.decision === 'removed' || input.decision === 'hidden') {
      if (report.target_type === 'post' || report.target_type === 'comment') {
        await this.deps.repos.posts.softDelete(report.target_id, null);
      } else if (report.target_type === 'message') {
        await this.deps.db.query(
          'update messages set deleted_at = now(), body = null, ciphertext = null where id = $1',
          [report.target_id],
        );
      } else if (report.target_type === 'channel') {
        await this.deps.db.query('update channels set deleted_at = now() where id = $1', [report.target_id]);
      }
    }
    if (input.decision === 'user_suspended' || input.decision === 'user_warned') {
      const ownerId = await this.targetOwner(report.target_type, report.target_id);
      if (ownerId) {
        if (input.decision === 'user_suspended') {
          await this.deps.repos.users.setStatus(ownerId, 'suspended');
          await this.deps.db.query(
            "update sessions set revoked_at = now(), revoked_reason = 'user_suspended' where user_id = $1 and revoked_at is null",
            [ownerId],
          );
        }
        await this.deps.repos.notifications.create({
          userId: ownerId,
          kind: input.decision === 'user_suspended' ? 'account_suspended' : 'moderation_warning',
          payload: { reportId, decision: input.decision, note: input.note ?? null },
        });
      }
    }

    const resolved = await this.deps.repos.moderation.resolve({
      reportId,
      moderatorId,
      decision: input.decision,
      note: input.note ?? null,
    });
    await this.deps.repos.moderation.recordAction({
      moderatorId,
      targetType: report.target_type,
      targetId: report.target_id,
      action: input.decision,
      reason: input.note ?? null,
      reportId,
    });
    await this.deps.repos.audit.record({
      actorId: moderatorId,
      actorIp: ctx.ip,
      action: 'moderation.report_resolved',
      targetType: report.target_type,
      targetId: report.target_id,
      metadata: { decision: input.decision, reportId },
    });
    return {
      id: resolved.id,
      decision: resolved.decision,
      status: resolved.status,
      handledAt: resolved.handled_at ? resolved.handled_at.toISOString() : null,
    };
  }

  private async targetOwner(type: string, id: string): Promise<string | null> {
    const map: Record<string, string> = {
      user: 'select id as owner from users where id = $1',
      post: 'select author_id as owner from posts where id = $1',
      comment: 'select author_id as owner from posts where id = $1',
      message: 'select sender_id as owner from messages where id = $1',
      channel: 'select owner_id as owner from channels where id = $1',
    };
    const sql = map[type];
    if (!sql) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const row = await this.deps.db.one<{ owner: string | null }>(sql, [id]);
    return row?.owner ?? null;
  }

  async auditTrail(userId: string, filter: { action?: string; actorId?: string; limit: number; offset: number }) {
    await this.requireStaff(userId);
    return this.deps.repos.audit.list(filter);
  }
}
