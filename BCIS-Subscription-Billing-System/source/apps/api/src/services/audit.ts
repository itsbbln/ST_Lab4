import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { auditLogs } from "../db/schema/index.js";
import type { Executor } from "../db/client.js";
import type { Actor } from "./types.js";

/**
 * Append-only audit trail (§4.4).
 *
 * There is deliberately no update or delete function in this module. The table
 * has no trigger protecting it from raw SQL, but the application exposes no
 * write path other than `writeAudit`, and the only route that reads it requires
 * the `audit.view` permission.
 */

export interface AuditChange {
  /** Value before the mutation. */
  old?: unknown;
  /** Value after the mutation. */
  new?: unknown;
}

export interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string;
  reason?: string | null;
  /** Old/new value pairs, which §4.4 requires for financial mutations. */
  changes?: Record<string, AuditChange>;
  metadata?: Record<string, unknown>;
}

/** Actions recorded by the system. Kept in one place so reports can group them. */
export const auditActions = {
  LOGIN_SUCCEEDED: "auth.login.succeeded",
  LOGIN_FAILED: "auth.login.failed",
  LOGOUT: "auth.logout",
  SESSION_LOCKED: "auth.session.locked",
  PASSWORD_CHANGED: "auth.password.changed",
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  PLAN_CREATED: "plan.created",
  PLAN_UPDATED: "plan.updated",
  SUBSCRIBER_CREATED: "subscriber.created",
  SUBSCRIBER_UPDATED: "subscriber.updated",
  SERVICE_ACCOUNT_CREATED: "service_account.created",
  SERVICE_ACCOUNT_PLAN_CHANGED: "service_account.plan_changed",
  BILLING_GENERATED: "billing.generated",
  INVOICE_VOIDED: "invoice.voided",
  INVOICE_ADJUSTED: "invoice.adjusted",
  PAYMENT_POSTED: "payment.posted",
  PAYMENT_REVERSED: "payment.reversed",
  RECEIPT_VOIDED: "receipt.voided",
  GCASH_PROOF_SUBMITTED: "gcash.proof_submitted",
  GCASH_PROOF_VERIFIED: "gcash.proof_verified",
  GCASH_PROOF_REJECTED: "gcash.proof_rejected",
  BATCH_OPENED: "collection.batch_opened",
  BATCH_TRANSITIONED: "collection.batch_transitioned",
  COLLECTION_RECORDED: "collection.recorded",
  REMITTANCE_SUBMITTED: "collection.remittance_submitted",
  REMITTANCE_CONFIRMED: "collection.remittance_confirmed",
  REMITTANCE_REJECTED: "collection.remittance_rejected",
  BATCH_CLOSED: "collection.batch_closed",
  SUSPENSION_REQUESTED: "service.suspension_requested",
  SUSPENSION_EXECUTED: "service.suspension_executed",
  RECONNECTION_REQUESTED: "service.reconnection_requested",
  RECONNECTION_COMPLETED: "service.reconnection_completed",
  SETTING_UPDATED: "settings.updated",
  BACKUP_CREATED: "backup.created",
  BACKUP_VERIFIED: "backup.verified",
  BACKUP_RESTORED: "backup.restored",
  ATTACHMENT_UPLOADED: "attachment.uploaded"
} as const;

export type AuditAction = (typeof auditActions)[keyof typeof auditActions];

/**
 * Flattens a changes map plus optional metadata into the `old_values` /
 * `new_values` jsonb pair the schema stores.
 *
 * Old and new are kept in separate columns so a reader never has to guess which
 * side a value came from; supplementary context is merged into `new_values`.
 */
function splitChanges(
  changes: Record<string, AuditChange> | undefined,
  metadata: Record<string, unknown> | undefined
) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (value.old !== undefined) {
      oldValues[key] = value.old;
    }
    if (value.new !== undefined) {
      newValues[key] = value.new;
    }
  }
  for (const [key, value] of Object.entries(metadata ?? {})) {
    newValues[key] = value;
  }
  return {
    oldValues: Object.keys(oldValues).length > 0 ? oldValues : null,
    newValues: Object.keys(newValues).length > 0 ? newValues : null
  };
}

/**
 * Records one audit row inside the caller's transaction, so the audit entry and
 * the financial mutation it describes commit or roll back together.
 */
export async function writeAudit(
  executor: Executor,
  actor: Actor | undefined,
  input: AuditInput
): Promise<void> {
  const { oldValues, newValues } = splitChanges(input.changes, input.metadata);

  await executor.insert(auditLogs).values({
    actorId: actor?.id ?? null,
    actorUsername: actor?.username ?? "system",
    actorName: actor?.displayName ?? "System",
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    reason: input.reason ?? null,
    oldValues: oldValues as never,
    newValues: newValues as never,
    ipAddress: actor?.ipAddress ?? null,
    requestId: actor?.requestId ?? null
  });
}

// ---------------------------------------------------------------------------
// Reading the trail
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(25),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(80).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  q: z.string().trim().max(120).optional()
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export async function listAuditLogs(executor: Executor, query: AuditQuery) {
  const filters: SQL[] = [];
  if (query.action) {
    filters.push(eq(auditLogs.action, query.action));
  }
  if (query.entityType) {
    filters.push(eq(auditLogs.entityType, query.entityType));
  }
  if (query.entityId) {
    filters.push(eq(auditLogs.entityId, query.entityId));
  }
  if (query.actorId) {
    filters.push(eq(auditLogs.actorId, query.actorId));
  }
  if (query.from) {
    filters.push(gte(auditLogs.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
  }
  if (query.to) {
    filters.push(lte(auditLogs.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      or(
        ilike(auditLogs.action, pattern),
        ilike(auditLogs.actorName, pattern),
        ilike(auditLogs.entityId, pattern)
      )!
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await executor
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [totalRow] = await executor
    .select({ value: count() })
    .from(auditLogs)
    .where(where);

  return {
    items: rows,
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0
  };
}

/** Distinct action names, used to populate the audit filter dropdown. */
export async function listAuditActions(executor: Executor): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .orderBy(auditLogs.action);
  return rows.map((row) => row.action);
}

/** Recent activity for the subscriber-profile audit tab. */
export async function listEntityAudit(
  executor: Executor,
  entityType: string,
  entityId: string,
  limit = 50
) {
  return executor
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}

/** Count of mutations performed by an actor, used by the user-activity report. */
export async function countByActorSince(executor: Executor, since: Date) {
  return executor
    .select({
      actorId: auditLogs.actorId,
      actorName: auditLogs.actorName,
      actorUsername: auditLogs.actorUsername,
      mutations: sql<number>`count(*)::int`
    })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, since))
    .groupBy(auditLogs.actorId, auditLogs.actorName, auditLogs.actorUsername)
    .orderBy(desc(sql`count(*)`));
}
