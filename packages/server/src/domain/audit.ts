import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/**
 * Append-only audit log (§6.1.4).
 *
 * There is no update or delete path in this module, and none should be added:
 * the log's value against a malicious administrator depends entirely on being
 * unable to rewrite it. Retention pruning, if it is ever needed, belongs in an
 * explicit archival job that exports before it removes.
 */

export interface AuditEntry {
  actorType: 'user' | 'worker' | 'system';
  actor: string;
  action: string;
  target?: string | null;
  detail?: unknown;
  remoteAddress?: string | null;
}

export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: entry.actorType,
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    detail: (entry.detail ?? null) as never,
    remoteAddress: entry.remoteAddress ?? null,
  });
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function queryAudit(db: Database, q: AuditQuery = {}) {
  const conditions: SQL[] = [];
  if (q.actor) conditions.push(eq(auditLog.actor, q.actor));
  if (q.action) conditions.push(eq(auditLog.action, q.action));
  if (q.from) conditions.push(gte(auditLog.at, q.from));
  if (q.to) conditions.push(lte(auditLog.at, q.to));

  return db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(Math.min(q.limit ?? 100, 1000))
    .offset(q.offset ?? 0);
}
