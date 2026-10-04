import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { ReconnectionStatus, SuspensionStatus } from "@bcis/shared";

import { queryRow, queryRows, type Executor, type Transaction } from "../db/client.js";
import {
  invoices,
  invoiceItems,
  reconnectionRecords,
  serviceAccounts,
  serviceEvents,
  servicePlans,
  suspensionRecords
} from "../db/schema/index.js";
import { businessRule, invalidState, notFound, validationFailed } from "./errors.js";
import { writeAudit, auditActions } from "./audit.js";
import { nextDocument } from "./numbering.js";
import { postLedgerEntry } from "./ledger.js";
import { getSettings } from "./settings.js";
import { assertCan, type Actor, type Page } from "./types.js";
import { accountArrearsSnapshot } from "./receivables.js";

/**
 * Service control: suspensions and reconnections (A3.10).
 *
 * The workstation flow is deliberately split into small, auditable steps rather
 * than one "big red button":
 *
 *  1. A suspension is *requested*, carrying the reason, effective date and
 *     notes. Arrears at that instant are frozen onto the record from the same
 *     open-invoice definition the receivables dashboard uses, so what the
 *     account owed on the day of the decision cannot be rewritten later.
 *  2. It is *approved* by somebody with `suspension.manage` (the reconnection
 *     permission on the shared role map), and only then *executed*. Execution
 *     is the moment the account's status actually changes - nothing earlier
 *     ever touches `service_accounts.status`, so a rejected or abandoned
 *     suspension is purely paper.
 *  3. Once the arrears are settled, a reconnection is *requested*. The fee is
 *     resolved per plan with the global default as the fallback, and when one
 *     is due it is drawn as a real RECONNECTION invoice, quoted and numbered
 *     from the same sequence as every other invoice in the system.
 *  4. The reconnection advances PENDING_PAYMENT → REQUESTED (once the fee
 *     invoice is fully paid) → completed, when the account goes back to ACTIVE
 *     and a RECONNECTED event lands in the service history.
 *
 * Every state change on a service account is written to `service_events`, which
 * keeps A3.2's "all service state changes remain in service history" true for
 * the lifecycle endpoints as much as for the directory ones.
 */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateSuspensionInput {
  serviceAccountId: string;
  reason: string;
  effectiveDate: string;
  notes?: string | null;
}

export interface RequestReconnectionInput {
  serviceAccountId: string;
  suspensionId?: string | null;
  /** Explicit fee override. Omitted (or null) to resolve plan/default. */
  feeCentavos?: number | null;
  technicianId?: string | null;
  requestDate?: string;
  notes?: string | null;
}

async function requireAccount(tx: Executor, serviceAccountId: string) {
  const rows = await tx
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);
  if (!rows[0]) {
    throw notFound("Service account", serviceAccountId);
  }
  return rows[0];
}

async function requireSuspension(tx: Executor, id: string) {
  const rows = await tx.select().from(suspensionRecords).where(eq(suspensionRecords.id, id)).limit(1);
  if (!rows[0]) {
    throw notFound("Suspension", id);
  }
  return rows[0];
}

async function requireReconnection(tx: Executor, id: string) {
  const rows = await tx.select().from(reconnectionRecords).where(eq(reconnectionRecords.id, id)).limit(1);
  if (!rows[0]) {
    throw notFound("Reconnection", id);
  }
  return rows[0];
}

/**
 * Creates a suspension request. Only an ACTIVE account can be suspended; a
 * pending activation has never been switched on, and an account that is already
 * suspended is a candidate for reconnection, not for another suspension.
 */
export async function createSuspensionRequest(
  tx: Transaction,
  input: CreateSuspensionInput,
  actor?: Actor
) {
  assertCan(actor, "suspension.manage");

  const reason = input.reason?.trim();
  if (!reason) {
    throw validationFailed("A suspension reason is required.");
  }

  const account = await requireAccount(tx, input.serviceAccountId);
  if (account.status !== "ACTIVE") {
    throw businessRule(
      `Service account ${account.serviceAccountNumber} cannot be suspended because its status is ${account.status}.`
    );
  }

  const arrears = await accountArrearsSnapshot(tx, account.id, { asOf: input.effectiveDate });

  const [record] = await tx
    .insert(suspensionRecords)
    .values({
      serviceAccountId: account.id,
      reason,
      effectiveDate: input.effectiveDate,
      arrearsAtSuspensionCentavos: arrears.overdueCentavos,
      status: "PENDING",
      notes: input.notes?.trim() || null,
      createdBy: actor?.id ?? null,
      createdByName: actor?.displayName ?? null
    })
    .returning();

  await writeAudit(tx, actor, {
    action: auditActions.SUSPENSION_REQUESTED,
    entityType: "suspension",
    entityId: record.id,
    changes: { status: { new: record.status } },
    metadata: {
      serviceAccountId: account.id,
      effectiveDate: input.effectiveDate,
      arrearsAtSuspensionCentavos: arrears.overdueCentavos,
      reason
    }
  });

  return record;
}

/** Approves a pending suspension, recording precisely who signed it off. */
export async function approveSuspension(tx: Transaction, id: string, actor?: Actor) {
  assertCan(actor, "suspension.manage");
  const record = await requireSuspension(tx, id);
  if (record.status !== "PENDING") {
    throw invalidState(`Suspension ${id} is ${record.status}; only a PENDING suspension can be approved.`);
  }

  const [updated] = await tx
    .update(suspensionRecords)
    .set({
      status: "APPROVED",
      approvedBy: actor?.id ?? null,
      approvedByName: actor?.displayName ?? null,
      approvedAt: new Date()
    })
    .where(eq(suspensionRecords.id, id))
    .returning();

  return updated;
}

/**
 * Executes an approved suspension - the single moment the account actually goes
 * dark. A SUSPENDED event is appended to the service history so the state change
 * is reconstructable years later without the suspension record.
 */
export async function executeSuspension(tx: Transaction, id: string, actor?: Actor) {
  assertCan(actor, "suspension.manage");
  const record = await requireSuspension(tx, id);
  if (record.status !== "APPROVED") {
    throw invalidState(
      `Suspension ${id} is ${record.status}; only an APPROVED suspension can be executed.`
    );
  }

  const account = await requireAccount(tx, record.serviceAccountId);
  if (account.status !== "ACTIVE") {
    throw businessRule(
      `Service account ${account.serviceAccountNumber} is already ${account.status} and cannot be suspended.`
    );
  }

  await tx
    .update(serviceAccounts)
    .set({ status: "SUSPENDED", suspendedAt: new Date() })
    .where(eq(serviceAccounts.id, account.id));

  const [updated] = await tx
    .update(suspensionRecords)
    .set({ status: "EXECUTED", executedAt: new Date() })
    .where(eq(suspensionRecords.id, id))
    .returning();

  await tx.insert(serviceEvents).values({
    serviceAccountId: account.id,
    eventType: "SUSPENDED",
    reason: record.reason,
    effectiveDate: record.effectiveDate,
    notes: record.notes,
    actorId: actor?.id ?? null,
    actorName: actor?.displayName ?? null,
    metadata: JSON.stringify({ suspensionId: id })
  });

  await writeAudit(tx, actor, {
    action: auditActions.SUSPENSION_EXECUTED,
    entityType: "suspension",
    entityId: id,
    changes: {
      accountStatus: { old: "ACTIVE", new: "SUSPENDED" },
      status: { old: "APPROVED", new: "EXECUTED" }
    },
    metadata: { serviceAccountId: account.id, effectiveDate: record.effectiveDate }
  });

  return updated;
}

/** Withdraws a suspension that was never executed. */
export async function cancelSuspension(tx: Transaction, id: string, actor?: Actor) {
  assertCan(actor, "suspension.manage");
  const record = await requireSuspension(tx, id);
  if (record.status === "EXECUTED" || record.status === "CANCELLED") {
    throw invalidState(`Suspension ${id} is ${record.status} and cannot be cancelled.`);
  }

  const [updated] = await tx
    .update(suspensionRecords)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(eq(suspensionRecords.id, id))
    .returning();

  return updated;
}

async function resolveReconnectionFee(
  tx: Executor,
  planId: string,
  explicit?: number | null
): Promise<number> {
  if (explicit !== undefined && explicit !== null) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw validationFailed("The reconnection fee must be a positive amount or zero.");
    }
    return explicit;
  }

  const settings = await getSettings(tx);
  const [plan] = await tx
    .select({ reconnectionFeeCentavos: servicePlans.reconnectionFeeCentavos })
    .from(servicePlans)
    .where(eq(servicePlans.id, planId))
    .limit(1);

  // Per-plan fee wins; the global default only applies to plans that carry none.
  const planFee = plan?.reconnectionFeeCentavos ?? 0;
  return planFee > 0 ? planFee : settings.defaultReconnectionFeeCentavos;
}

/**
 * Draws a reconnection fee as a numbered, finalized invoice.
 *
 * The invoice is a first-class citizen: it is debited to the ledger exactly like
 * a monthly bill, it appears on the overdue list if left unpaid, and its balance
 * gates the reconnection. The period is labelled REC-<month> so the partial
 * unique index on (service_account_id, period) can never confuse a fee invoice
 * with a monthly subscription invoice for the same period.
 */
async function createReconnectionFeeInvoice(
  tx: Transaction,
  account: { id: string; serviceAccountNumber: string },
  feeCentavos: number,
  onDate: string,
  actor?: Actor
) {
  const year = Number(onDate.slice(0, 4));
  const period = `REC-${onDate.slice(0, 7)}`;

  const prior = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.serviceAccountId, account.id), eq(invoices.period, period), ne(invoices.status, "VOID")))
    .limit(1);
  if (prior[0]) {
    throw businessRule(
      `Service account ${account.serviceAccountNumber} already has a reconnection fee invoice for ${period}. Cancel or settle it before requesting another so fee numbers stay unique.`
    );
  }

  const [feeInvoice] = await tx
    .insert(invoices)
    .values({
      invoiceNumber: "PENDING",
      serviceAccountId: account.id,
      billingCycleId: null,
      period,
      issueDate: onDate,
      dueDate: onDate,
      subtotalCentavos: feeCentavos,
      discountCentavos: 0,
      penaltyCentavos: 0,
      totalCentavos: feeCentavos,
      paidCentavos: 0,
      balanceCentavos: feeCentavos,
      status: "UNPAID",
      rateSnapshotCentavos: feeCentavos,
      isFinalized: true,
      finalizedAt: new Date()
    })
    .returning();

  const invoiceNumber = await nextDocument(tx, "INVOICE", year);
  await tx
    .update(invoices)
    .set({ invoiceNumber })
    .where(eq(invoices.id, feeInvoice.id));

  await tx.insert(invoiceItems).values({
    invoiceId: feeInvoice.id,
    itemType: "RECONNECTION",
    description: `Reconnection fee for service account ${account.serviceAccountNumber}`,
    quantity: "1",
    unitPriceCentavos: feeCentavos,
    amountCentavos: feeCentavos,
    sortOrder: 0
  });

  await postLedgerEntry(tx, {
    serviceAccountId: account.id,
    entryDate: onDate,
    reference: invoiceNumber,
    description: `Reconnection fee invoice ${invoiceNumber}`,
    entryType: "INVOICE",
    debitCentavos: feeCentavos,
    sourceType: "INVOICE",
    sourceId: feeInvoice.id,
    actor
  });

  return { id: feeInvoice.id, invoiceNumber };
}

/**
 * Opens the reconnection workflow. A SUSPENDED account is the only eligible
 * subject. When a fee is due, the workflow starts in PENDING_PAYMENT with the
 * fee invoice open; a fee-free plan starts straight in REQUESTED.
 */
export async function requestReconnection(
  tx: Transaction,
  input: RequestReconnectionInput,
  actor?: Actor
) {
  assertCan(actor, "suspension.manage");

  const account = await requireAccount(tx, input.serviceAccountId);
  if (account.status !== "SUSPENDED") {
    throw businessRule(
      `Service account ${account.serviceAccountNumber} is ${account.status}; only a SUSPENDED account can be reconnected.`
    );
  }

  const requestDate = input.requestDate ?? today();
  const fee = await resolveReconnectionFee(tx, account.planId, input.feeCentavos);

  let invoiceId: string | null = null;
  if (fee > 0) {
    const feeInvoice = await createReconnectionFeeInvoice(tx, account, fee, requestDate, actor);
    invoiceId = feeInvoice.id;
  }

  const [record] = await tx
    .insert(reconnectionRecords)
    .values({
      serviceAccountId: account.id,
      suspensionId: input.suspensionId?.trim() || null,
      feeCentavos: fee,
      invoiceId,
      technicianId: input.technicianId?.trim() || null,
      requestDate,
      requestedAt: fee > 0 ? null : new Date(),
      status: fee > 0 ? "PENDING_PAYMENT" : "REQUESTED",
      notes: input.notes?.trim() || null,
      createdBy: actor?.id ?? null,
      createdByName: actor?.displayName ?? null
    })
    .returning();

  await writeAudit(tx, actor, {
    action: auditActions.RECONNECTION_REQUESTED,
    entityType: "reconnection",
    entityId: record.id,
    changes: { status: { new: record.status } },
    metadata: {
      serviceAccountId: account.id,
      feeCentavos: fee,
      invoiceId,
      requestDate
    }
  });

  return { ...record, feeInvoiceNumber: fee > 0 ? await feeInvoiceNumber(tx, invoiceId!) : null };
}

async function feeInvoiceNumber(tx: Executor, invoiceId: string): Promise<string | null> {
  const rows = await tx
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return rows[0]?.invoiceNumber ?? null;
}

/**
 * Advances a reconnection from PENDING_PAYMENT to REQUESTED once the fee invoice
 * is fully paid. The route that collects money calls postPayment through the
 * payments module and hands the resulting update to this function, so "which
 * payment qualified the workflow" is described by gatekeeping on the invoice
 * balance rather than by trusting a flag from the renderer.
 */
export async function confirmReconnectionFee(tx: Transaction, id: string, actor?: Actor) {
  assertCan(actor, "suspension.manage");
  const record = await requireReconnection(tx, id);

  if (record.status === "REQUESTED" || record.status === "IN_PROGRESS") {
    return { ...record, requestedAt: record.requestedAt };
  }
  if (record.status !== "PENDING_PAYMENT") {
    throw invalidState(`Reconnection ${id} is ${record.status} and is not waiting on its fee.`);
  }
  if (!record.invoiceId) {
    throw invalidState(`Reconnection ${id} has no fee invoice to confirm.`);
  }

  const [feeInvoice] = await tx
    .select({ status: invoices.status, balance: invoices.balanceCentavos })
    .from(invoices)
    .where(eq(invoices.id, record.invoiceId))
    .limit(1);
  if (!feeInvoice) {
    throw notFound("Reconnection fee invoice", record.invoiceId);
  }
  if (feeInvoice.balance > 0) {
    throw businessRule(
      `The reconnection fee of ${formatCentavos(feeInvoice.balance)} is still outstanding. The workflow cannot be requested until the fee invoice is fully paid.`
    );
  }

  const [updated] = await tx
    .update(reconnectionRecords)
    .set({ status: "REQUESTED", requestedAt: new Date() })
    .where(eq(reconnectionRecords.id, id))
    .returning();

  return updated;
}

/** Assigns (or replaces) the technician and moves the job IN_PROGRESS. */
export async function assignReconnectionTechnician(
  tx: Transaction,
  id: string,
  technicianId: string,
  actor?: Actor
) {
  assertCan(actor, "suspension.manage");
  const record = await requireReconnection(tx, id);
  if (record.status === "PENDING_PAYMENT") {
    throw invalidState("A reconnection must be requested before a technician is assigned.");
  }
  if (record.status === "COMPLETED" || record.status === "CANCELLED") {
    throw invalidState(`Reconnection ${id} is ${record.status} and no longer accepts a technician.`);
  }

  const [updated] = await tx
    .update(reconnectionRecords)
    .set({
      technicianId,
      status: "IN_PROGRESS"
    })
    .where(eq(reconnectionRecords.id, id))
    .returning();

  return updated;
}

/**
 * Completes the reconnection: the account returns to ACTIVE and a RECONNECTED
 * event is appended to the service history. A fee-paying reconnection cannot be
 * completed ahead of its invoice.
 */
export async function completeReconnection(
  tx: Transaction,
  id: string,
  options: { completedDate?: string; technicianId?: string } = {},
  actor?: Actor
) {
  assertCan(actor, "suspension.manage");
  const record = await requireReconnection(tx, id);

  if (record.status === "PENDING_PAYMENT") {
    throw businessRule(
      `Reconnection ${id} is still PENDING_PAYMENT; the fee invoice must be settled and the workflow confirmed before it can be completed.`
    );
  }
  if (record.status === "CANCELLED") {
    throw invalidState(`A cancelled reconnection cannot be completed.`);
  }

  if (record.feeCentavos > 0 && record.invoiceId) {
    const [feeInvoice] = await tx
      .select({ balance: invoices.balanceCentavos })
      .from(invoices)
      .where(eq(invoices.id, record.invoiceId))
      .limit(1);
    if (!feeInvoice || feeInvoice.balance > 0) {
      throw businessRule(
        `Reconnection ${id} has an unpaid fee. Complete the payment before restoring the service.`
      );
    }
  }

  const account = await requireAccount(tx, record.serviceAccountId);
  if (account.status !== "SUSPENDED") {
    throw businessRule(
      `Service account ${account.serviceAccountNumber} is ${account.status}; only a SUSPENDED account can be reconnected.`
    );
  }

  const completedDate = options.completedDate ?? today();

  await tx
    .update(serviceAccounts)
    .set({ status: "ACTIVE", suspendedAt: null })
    .where(eq(serviceAccounts.id, account.id));

  const [updated] = await tx
    .update(reconnectionRecords)
    .set({
      status: "COMPLETED",
      completedAt: new Date(),
      technicianId: options.technicianId?.trim() || record.technicianId
    })
    .where(eq(reconnectionRecords.id, id))
    .returning();

  await tx.insert(serviceEvents).values({
    serviceAccountId: account.id,
    eventType: "RECONNECTED",
    reason: `Reconnection completed (fee ${formatCentavos(record.feeCentavos)})`,
    effectiveDate: completedDate,
    notes: record.notes,
    actorId: actor?.id ?? null,
    actorName: actor?.displayName ?? null,
    metadata: JSON.stringify({ reconnectionId: id })
  });

  await writeAudit(tx, actor, {
    action: auditActions.RECONNECTION_COMPLETED,
    entityType: "reconnection",
    entityId: id,
    changes: {
      accountStatus: { old: "SUSPENDED", new: "ACTIVE" },
      status: { old: record.status, new: "COMPLETED" }
    },
    metadata: {
      serviceAccountId: account.id,
      feeCentavos: record.feeCentavos,
      completedDate
    }
  });

  return updated;
}

/** Withdraws an in-flight reconnection, voiding an unpaid fee invoice. */
export async function cancelReconnection(tx: Transaction, id: string, actor?: Actor) {
  assertCan(actor, "suspension.manage");
  const record = await requireReconnection(tx, id);
  if (record.status === "COMPLETED" || record.status === "CANCELLED") {
    throw invalidState(`Reconnection ${id} is ${record.status} and cannot be cancelled.`);
  }

  // Money already collected is never refunded by just flipping a flag; the
  // reversal path is reserved for that. Only an unpaid fee invoice is voided so
  // the (service_account_id, period) uniqueness frees the month again.
  if (record.invoiceId) {
    const [feeInvoice] = await tx
      .select({ balance: invoices.balanceCentavos })
      .from(invoices)
      .where(eq(invoices.id, record.invoiceId))
      .limit(1);
    if (feeInvoice && feeInvoice.balance > 0) {
      await tx
        .update(invoices)
        .set({
          status: "VOID",
          voidedAt: new Date(),
          voidedBy: actor?.id ?? null,
          voidReason: "Reconnection cancelled"
        })
        .where(eq(invoices.id, record.invoiceId));
    }
  }

  const [updated] = await tx
    .update(reconnectionRecords)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(eq(reconnectionRecords.id, id))
    .returning();

  return updated;
}

function formatCentavos(centavos: number): string {
  return `P${(centavos / 100).toFixed(2)}`;
}

/**
 * Display pick for suspension and reconnection lists: the operational record
 * plus the subscriber, service account and plan so an office screen can render
 * the whole row without a follow-up join per row.
 */
const accountDisplay = sql`
  select
    sa.id as service_account_id,
    sa.service_account_number,
    sa.status as account_status,
    sub.id as subscriber_id,
    sub.full_name as subscriber_name,
    sub.account_number as subscriber_account_number,
    pl.code as plan_code,
    pl.name as plan_name
  from service_accounts sa
  join subscribers sub on sub.id = sa.subscriber_id
  join service_plans pl on pl.id = sa.plan_id
`;

export interface SuspensionListQuery {
  serviceAccountId?: string;
  status?: SuspensionStatus;
  page?: number;
  pageSize?: number;
}

export async function listSuspensions(executor: Executor, query: SuspensionListQuery = {}): Promise<
  Page<Record<string, unknown>>
> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const clauses: ReturnType<typeof sql>[] = [];
  if (query.serviceAccountId) {
    clauses.push(sql`sr.service_account_id = ${query.serviceAccountId}`);
  }
  if (query.status) {
    clauses.push(sql`sr.status = ${query.status}`);
  }
  const where = clauses.length ? sql` where ${sql.join(clauses, sql` and `)}` : sql``;

  const rows = await queryRows<Record<string, unknown>>(
    executor,
    sql`
      select sr.id, sr.reason, sr.effective_date, sr.arrears_at_suspension_centavos,
        sr.status, sr.approved_by_name, sr.approved_at, sr.executed_at, sr.cancelled_at,
        sr.notes, sr.created_by_name, sr.created_at,
        d.*
      from suspension_records sr
      join (${accountDisplay}) d on d.service_account_id = sr.service_account_id
      ${where}
      order by sr.effective_date desc, sr.created_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `
  );

  const countRow = await queryRow<{ total: string }>(
    executor,
    sql`
      select count(*) as total
      from suspension_records sr
      ${where}
    `
  );

  return { page, pageSize, total: Number(countRow?.total ?? 0), items: rows };
}

export interface ReconnectionListQuery {
  serviceAccountId?: string;
  status?: ReconnectionStatus;
  page?: number;
  pageSize?: number;
}

export async function listReconnections(
  executor: Executor,
  query: ReconnectionListQuery = {}
): Promise<Page<Record<string, unknown>>> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const clauses: ReturnType<typeof sql>[] = [];
  if (query.serviceAccountId) {
    clauses.push(sql`rr.service_account_id = ${query.serviceAccountId}`);
  }
  if (query.status) {
    clauses.push(sql`rr.status = ${query.status}`);
  }
  const where = clauses.length ? sql` where ${sql.join(clauses, sql` and `)}` : sql``;

  const rows = await queryRows<Record<string, unknown>>(
    executor,
    sql`
      select rr.id, rr.fee_centavos, rr.request_date, rr.requested_at, rr.completed_at,
        rr.cancelled_at, rr.status, rr.technician_id, rr.notes, rr.created_by_name, rr.created_at,
        srf.effective_date as suspension_effective_date, srf.reason as suspension_reason,
        inv.invoice_number as fee_invoice_number, inv.status as fee_status,
        inv.balance_centavos as fee_balance_centavos,
        d.*
      from reconnection_records rr
      join (${accountDisplay}) d on d.service_account_id = rr.service_account_id
      left join suspension_records srf on srf.id = rr.suspension_id
      left join invoices inv on inv.id = rr.invoice_id
      ${where}
      order by rr.request_date desc, rr.created_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `
  );

  const countRow = await queryRow<{ total: string }>(
    executor,
    sql`
      select count(*) as total
      from reconnection_records rr
      ${where}
    `
  );

  return { page, pageSize, total: Number(countRow?.total ?? 0), items: rows };
}