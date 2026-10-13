import type { Db } from '../db/pool.js';

/**
 * Audit trail. Every administrative or security-relevant action is recorded with
 * actor, source IP and a small metadata object. Secrets are never stored here.
 */

export interface AuditEntry {
  actorId: string | null;
  actorIp?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `insert into audit_logs (actor_id, actor_ip, action, target_type, target_id, metadata)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          entry.actorId,
          entry.actorIp ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          JSON.stringify(entry.metadata ?? {}),
        ],
      );
    } catch {
      // Auditing must never break the request path; failures are surfaced via metrics.
      (globalThis as Record<string, unknown>).__sovereignAuditFailures =
        Number((globalThis as Record<string, unknown>).__sovereignAuditFailures ?? 0) + 1;
    }
  }

  async list(filter: { action?: string; actorId?: string; limit: number; offset: number }) {
    const rows = await this.db.many<{
      id: string;
      actor_id: string | null;
      actor_ip: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `select id, actor_id, actor_ip, action, target_type, target_id, metadata, created_at
       from audit_logs
       where ($1::text is null or action = $1) and ($2::uuid is null or actor_id = $2)
       order by created_at desc limit $3 offset $4`,
      [filter.action ?? null, filter.actorId ?? null, filter.limit, filter.offset],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      actorId: row.actor_id,
      actorIp: row.actor_ip,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
