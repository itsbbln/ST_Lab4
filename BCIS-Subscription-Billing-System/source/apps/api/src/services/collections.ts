import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  BatchAccountStatus,
  BatchStatus,
  PaymentMethod,
  RemittanceStatus
} from "@bcis/shared";

import { queryRows, type Executor, type Transaction } from "../db/client.js";
import {
  batchAccounts,
  collectionAreas,
  collectionBatches,
  collectionRoutes,
  collectorRemittances,
  collectors,
  invoices,
  payments,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers
} from "../db/schema/index.js";
import {
  businessRule,
  conflict,
  invalidState,
  notFound,
  validationFailed
} from "./errors.js";
import { writeAudit, auditActions } from "./audit.js";
import { nextDocument } from "./numbering.js";
import { postPayment } from "./payments.js";
import { assertCan, type Actor } from "./types.js";

/**
 * House-to-house collection (§3.8).
 *
 * The accountability chain is the point of this module: a batch is opened for one
 * collector on one day, money is only ever received by posting a real payment
 * through the normal engine, and a batch cannot be closed until an authorized
 * person has confirmed a remittance. Cash a collector collected is money the
 * office has not yet seen, so `collection_batches.cash_collected_centavos` is
 * compared against what the collector physically hands over - never assumed to
 * match.
 *
 * AT-07 and AT-08 are enforced here. A balanced remittance reconciles; a short
 * remittance is recorded as a shortage, displayed, and can only be closed by
 * someone who explicitly acknowledges the discrepancy.
 */

/**
 * The batch lifecycle, minus the three states that only a dedicated, authorized
 * operation may reach. `transitionBatch` refuses to set them, so a caller cannot
 * walk a batch to CLOSED by hand and skip remittance entirely.
 */
const batchTransitions: Record<BatchStatus, BatchStatus[]> = {
  OPEN: ["IN_PROGRESS"],
  IN_PROGRESS: ["SUBMITTED", "OPEN"],
  SUBMITTED: ["IN_PROGRESS"],
  // Only submitRemittance() may set REMITTED.
  REMITTED: ["IN_PROGRESS"],
  // Only confirmRemittance() may set RECONCILED.
  RECONCILED: ["IN_PROGRESS"],
  CLOSED: []
};

const statesReservedForDedicatedOperations: BatchStatus[] = ["REMITTED", "RECONCILED", "CLOSED"];

export interface DueBreakdownRow {
  service_account_id: string;
  current_bill_centavos: number;
  arrears_centavos: number;
  total_due_centavos: number;
}

export interface OpenBatchInput {
  areaId: string;
  routeId?: string | null;
  collectorId: string;
  batchDate: string;
  dueDayCutoff?: number;
  notes?: string | null;
}

export interface BatchTotals {
  accountCount: number;
  expectedReceivableCentavos: number;
  cashCollectedCentavos: number;
  nonCashCollectedCentavos: number;
  totalCollectedCentavos: number;
  uncollectedCentavos: number;
}

export interface AddBatchAccountsResult {
  batchId: string;
  added: number;
  skipped: number;
  accounts: Array<{ serviceAccountId: string; totalDueCentavos: number }>;
  totals: BatchTotals;
}

export interface RecordCollectionInput {
  batchAccountId: string;
  amountCentavos: number;
  status: BatchAccountStatus;
  method?: PaymentMethod;
  notes?: string | null;
}

export interface RecordCollectionResult {
  batchAccountId: string;
  paymentId: string;
  receiptNumber: string;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCentavos: number;
  balanceAfterCentavos: number;
  collectedCentavos: number;
  totalDueCentavos: number;
  status: BatchAccountStatus;
  totals: BatchTotals;
}

export interface TransitionBatchResult {
  batchId: string;
  fromStatus: BatchStatus;
  toStatus: BatchStatus;
}

export interface SubmitRemittanceInput {
  batchId: string;
  cashRemittedCentavos: number;
  nonCashCollectedCentavos?: number;
  remarks?: string | null;
}

export interface RemittanceView {
  id: string;
  remittanceNumber: string;
  batchId: string;
  collectorId: string;
  remittanceDate: string;
  cashCollectedCentavos: number;
  cashRemittedCentavos: number;
  nonCashCollectedCentavos: number;
  differenceCentavos: number;
  shortageCentavos: number;
  overageCentavos: number;
  status: string;
  rejectionReason: string | null;
  remarks: string | null;
}

export interface SubmitRemittanceResult extends RemittanceView {
  batchStatus: BatchStatus;
  totals: BatchTotals;
}

export interface ConfirmRemittanceResult {
  remittanceId: string;
  status: "CONFIRMED" | "REJECTED";
  shortageCentavos: number;
  overageCentavos: number;
  batchStatus: BatchStatus;
}

export interface CloseBatchResult {
  batchId: string;
  status: "CLOSED";
  shortageCentavos: number;
  overageCentavos: number;
  discrepancyAcknowledged: boolean;
}

export interface BatchListQuery {
  page: number;
  pageSize: number;
  status?: BatchStatus;
  collectorId?: string;
  areaId?: string;
  from?: string;
  to?: string;
}

export interface BatchListItem extends BatchTotals {
  id: string;
  batchNumber: string;
  batchDate: string;
  status: BatchStatus;
  areaId: string;
  areaName: string;
  routeId: string | null;
  routeName: string | null;
  collectorId: string;
  collectorName: string;
  openedByName: string | null;
  submittedAt: Date | null;
  remittedAt: Date | null;
  reconciledAt: Date | null;
  closedAt: Date | null;
}

export interface BatchAccountView {
  id: string;
  serviceAccountId: string;
  accountNumber: string;
  subscriberName: string;
  serviceTypeCode: string | null;
  address: string | null;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  collectedCentavos: number;
  status: BatchAccountStatus;
  collectionNotes: string | null;
  collectedAt: Date | null;
}

export interface RouteSheetRow extends BatchAccountView {
  sequence: number;
}

export interface BatchDetail extends BatchListItem {
  dueDayCutoff: number;
  notes: string | null;
  openedBy: string | null;
  reconciledByName: string | null;
  closedBy: string | null;
  accounts: BatchAccountView[];
  remittances: RemittanceView[];
  confirmedRemittance: RemittanceView | null;
}

function assertCentavos(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw validationFailed(`${field} must be an integer number of centavos.`);
  }
  if (value < 0) {
    throw validationFailed(`${field} cannot be negative.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw validationFailed(`${field} is too large.`);
  }
  return value;
}

/** The billing period a batch is collecting for, e.g. `2026-03-11` -> `2026-03`. */
function periodOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * What each account owes, split into the current period's bill and older arrears.
 *
 * Reads the stored `balance_centavos`, which the payment engine maintains, rather
 * than recomputing from payments: the collection sheet has to agree with the
 * invoice a subscriber can see in the office, to the centavo.
 */
export async function dueBreakdown(
  executor: Executor,
  serviceAccountIds: string[],
  currentPeriod: string
): Promise<Map<string, DueBreakdownRow>> {
  const result = new Map<string, DueBreakdownRow>();
  if (serviceAccountIds.length === 0) {
    return result;
  }

  const rows = await queryRows<DueBreakdownRow>(
    executor,
    sql`
      select
        service_account_id,
        coalesce(sum(balance_centavos) filter (where period = ${currentPeriod}), 0)::bigint
          as current_bill_centavos,
        coalesce(sum(balance_centavos) filter (where period < ${currentPeriod}), 0)::bigint
          as arrears_centavos,
        coalesce(sum(balance_centavos), 0)::bigint as total_due_centavos
      from ${invoices}
      where service_account_id in (
        ${sql.join(serviceAccountIds.map((id) => sql`${id}::uuid`), sql`, `)}
      )
        and status in ('UNPAID', 'PARTIALLY_PAID', 'OVERDUE')
        and is_finalized = true
      group by service_account_id
    `
  );

  for (const row of rows) {
    result.set(row.service_account_id, {
      service_account_id: row.service_account_id,
      current_bill_centavos: Number(row.current_bill_centavos ?? 0),
      arrears_centavos: Number(row.arrears_centavos ?? 0),
      total_due_centavos: Number(row.total_due_centavos ?? 0)
    });
  }
  return result;
}

/**
 * Recomputes every derived total on a batch from its account rows and the
 * payments taken against it.
 *
 * Totals are always derived, never incrementally maintained, so a retry or a
 * re-run of the same recording cannot drift the batch away from its accounts.
 */
export async function recalculateBatchTotals(
  executor: Transaction,
  batchId: string
): Promise<BatchTotals> {
  const [account] = await executor
    .select({
      accountCount: sql<number>`count(*)::int`,
      expected: sql<number>`coalesce(sum(total_due_centavos), 0)::bigint`,
      collected: sql<number>`coalesce(sum(collected_centavos), 0)::bigint`
    })
    .from(batchAccounts)
    .where(eq(batchAccounts.batchId, batchId))
    .limit(1);

  // Cash versus non-cash comes from the payment method, so the batch's cash
  // figure is exactly the money a collector is carrying and must remit.
  const byMethod = await queryRows<{ method: string; total: number }>(
    executor,
    sql`
      select p.method, coalesce(sum(p.amount_centavos), 0)::bigint as total
      from ${payments} p
      where p.batch_id = ${batchId} and p.status = 'POSTED'
      group by p.method
    `
  );

  let cashCollected = 0;
  let nonCashCollected = 0;
  for (const row of byMethod) {
    const total = Number(row.total ?? 0);
    if (row.method === "CASH") {
      cashCollected += total;
    } else {
      nonCashCollected += total;
    }
  }

  const expectedReceivable = Number(account?.expected ?? 0);
  const totalCollected = Number(account?.collected ?? 0);

  const totals: BatchTotals = {
    accountCount: Number(account?.accountCount ?? 0),
    expectedReceivableCentavos: expectedReceivable,
    cashCollectedCentavos: cashCollected,
    nonCashCollectedCentavos: nonCashCollected,
    totalCollectedCentavos: totalCollected,
    // What the collector is still holding. Never negative: overpayment arrives
    // as advance on the account, not as a credit against the batch.
    uncollectedCentavos: Math.max(0, expectedReceivable - totalCollected)
  };

  await executor
    .update(collectionBatches)
    .set({
      accountCount: totals.accountCount,
      expectedReceivableCentavos: totals.expectedReceivableCentavos,
      cashCollectedCentavos: totals.cashCollectedCentavos,
      nonCashCollectedCentavos: totals.nonCashCollectedCentavos,
      totalCollectedCentavos: totals.totalCollectedCentavos,
      uncollectedCentavos: totals.uncollectedCentavos,
      updatedAt: new Date()
    })
    .where(eq(collectionBatches.id, batchId));

  return totals;
}

async function requireBatch(executor: Executor, batchId: string) {
  const [batch] = await executor
    .select()
    .from(collectionBatches)
    .where(eq(collectionBatches.id, batchId))
    .limit(1);
  if (!batch) {
    throw notFound("Collection batch", batchId);
  }
  return batch;
}

/** Only money can move while a batch is still open to the collector. */
function assertBatchAcceptsCollection(status: BatchStatus): void {
  if (status !== "OPEN" && status !== "IN_PROGRESS") {
    throw invalidState(
      `A batch in status ${status} can no longer record collections. ` +
        "Reopen it before recording more payments.",
      { status }
    );
  }
}

/**
 * Opens a batch for one collector on one day.
 *
 * The batch is created empty; accounts are attached with `addBatchAccounts`, so
 * a supervisor can build the route sheet from the live receivables rather than
 * from a snapshot taken at some earlier moment.
 */
export async function openBatch(
  tx: Transaction,
  input: OpenBatchInput,
  actor?: Actor
): Promise<BatchDetail> {
  assertCan(actor, "collection.record");

  const [area] = await tx
    .select()
    .from(collectionAreas)
    .where(eq(collectionAreas.id, input.areaId))
    .limit(1);
  if (!area) {
    throw notFound("Collection area", input.areaId);
  }

  const [collector] = await tx
    .select()
    .from(collectors)
    .where(eq(collectors.id, input.collectorId))
    .limit(1);
  if (!collector) {
    throw notFound("Collector", input.collectorId);
  }
  if (!collector.isActive) {
    throw businessRule(`${collector.fullName} is not an active collector.`);
  }

  if (input.routeId) {
    const [route] = await tx
      .select()
      .from(collectionRoutes)
      .where(eq(collectionRoutes.id, input.routeId))
      .limit(1);
    if (!route) {
      throw notFound("Collection route", input.routeId);
    }
    if (route.areaId !== input.areaId) {
      throw businessRule("The selected route does not belong to the selected area.");
    }
  }

  const year = Number(input.batchDate.slice(0, 4));
  const batchNumber = await nextDocument(tx, "BATCH", year);

  const [batch] = await tx
    .insert(collectionBatches)
    .values({
      batchNumber,
      areaId: input.areaId,
      routeId: input.routeId ?? null,
      collectorId: input.collectorId,
      batchDate: input.batchDate,
      dueDayCutoff: input.dueDayCutoff ?? 31,
      status: "OPEN",
      openedBy: actor?.id ?? null,
      openedByName: actor?.displayName ?? null,
      notes: input.notes ?? null
    })
    .returning();

  await writeAudit(tx, actor, {
    action: auditActions.BATCH_OPENED,
    entityType: "collection_batch",
    entityId: batch.id,
    metadata: { batchNumber, collectorId: input.collectorId, batchDate: input.batchDate }
  });

  return getBatch(tx, batch.id);
}

/**
 * Attaches accounts to a batch and snapshots what each one owes.
 *
 * The snapshot is what the printed route sheet and the collection totals are
 * built from. It deliberately does not move money: collection happens only
 * through `recordCollection`, so nothing can be marked collected without a
 * payment, a receipt and a ledger credit behind it.
 */
export async function addBatchAccounts(
  tx: Transaction,
  batchId: string,
  serviceAccountIds: string[],
  actor?: Actor
): Promise<AddBatchAccountsResult> {
  assertCan(actor, "collection.record");

  const batch = await requireBatch(tx, batchId);
  assertBatchAcceptsCollection(batch.status);

  const unique = [...new Set(serviceAccountIds)];
  const existing = await tx
    .select({ serviceAccountId: batchAccounts.serviceAccountId })
    .from(batchAccounts)
    .where(
      and(
        eq(batchAccounts.batchId, batchId),
        inArray(batchAccounts.serviceAccountId, unique)
      )
    );
  const alreadyPresent = new Set(existing.map((row) => row.serviceAccountId));
  const toAdd = unique.filter((id) => !alreadyPresent.has(id));

  if (toAdd.length === 0) {
    return {
      batchId,
      added: 0,
      skipped: unique.length,
      accounts: [],
      totals: await recalculateBatchTotals(tx, batchId)
    };
  }

  // An account must be active and actually billable to belong on a route sheet.
  const eligible = await tx
    .select({
      id: serviceAccounts.id,
      status: serviceAccounts.status
    })
    .from(serviceAccounts)
    .where(inArray(serviceAccounts.id, toAdd));
  const eligibleIds = new Set(
    eligible.filter((row) => row.status === "ACTIVE").map((row) => row.id)
  );
  const rejected = toAdd.filter((id) => !eligibleIds.has(id));
  if (rejected.length > 0) {
    throw businessRule(
      `${rejected.length} service account(s) cannot be added to a batch because they are not active.`,
      { serviceAccountIds: rejected }
    );
  }

  const breakdown = await dueBreakdown(tx, toAdd, periodOf(batch.batchDate));

  await tx.insert(batchAccounts).values(
    toAdd.map((id) => {
      const due = breakdown.get(id);
      return {
        batchId,
        serviceAccountId: id,
        currentBillCentavos: due?.current_bill_centavos ?? 0,
        arrearsCentavos: due?.arrears_centavos ?? 0,
        totalDueCentavos: due?.total_due_centavos ?? 0,
        collectedCentavos: 0,
        status: "PENDING" as const
      };
    })
  );

  const totals = await recalculateBatchTotals(tx, batchId);
  return {
    batchId,
    added: toAdd.length,
    skipped: unique.length - toAdd.length,
    accounts: toAdd.map((id) => ({
      serviceAccountId: id,
      totalDueCentavos: breakdown.get(id)?.total_due_centavos ?? 0
    })),
    totals
  };
}

/**
 * Records one doorstep collection.
 *
 * The money goes through `postPayment`, so the collector's cash gets the same
 * oldest-first allocation, advance handling, receipt number and ledger credit as
 * an over-the-counter payment. The batch is only ever a summary of those real
 * payments - it is never a second way to record cash.
 */
export async function recordCollection(
  tx: Transaction,
  input: RecordCollectionInput,
  actor?: Actor
): Promise<RecordCollectionResult> {
  assertCan(actor, "collection.record");

  assertCentavos(input.amountCentavos, "Collection amount");
  const method: PaymentMethod = input.method ?? "CASH";

  const [account] = await tx
    .select()
    .from(batchAccounts)
    .where(eq(batchAccounts.id, input.batchAccountId))
    .limit(1);
  if (!account) {
    throw notFound("Batch account", input.batchAccountId);
  }

  const batch = await requireBatch(tx, account.batchId);
  assertBatchAcceptsCollection(batch.status);

  if (account.collectedCentavos > 0 && input.amountCentavos > 0) {
    throw businessRule(
      "This account already has a collection recorded against it. " +
        "Reverse the earlier payment before recording a replacement."
    );
  }

  // Status must describe what actually happened. A caller cannot mark an
  // account COLLECTED without money, or collect money and call it UNCOLLECTED.
  let nextStatus: BatchAccountStatus;
  if (input.amountCentavos > 0) {
    if (input.status === "UNCOLLECTED" || input.status === "SKIPPED") {
      throw businessRule(
        `A collection of ${input.amountCentavos} cannot be recorded with status ${input.status}.`
      );
    }
    const collected = account.collectedCentavos + input.amountCentavos;
    nextStatus = collected >= account.totalDueCentavos ? "COLLECTED" : "PARTIAL";
  } else {
    if (input.status === "COLLECTED" || input.status === "PARTIAL") {
      throw businessRule(`Status ${input.status} requires a collection amount greater than zero.`);
    }
    nextStatus = input.status;
  }

  let payment: Awaited<ReturnType<typeof postPayment>> | null = null;
  if (input.amountCentavos > 0) {
    payment = await postPayment(
      tx,
      {
        serviceAccountId: account.serviceAccountId,
        amountCentavos: input.amountCentavos,
        method,
        paymentDate: new Date(`${batch.batchDate}T12:00:00Z`),
        notes: input.notes ?? null,
        batchId: batch.id,
        collectorId: batch.collectorId
      },
      actor
    );
  }

  const collectedCentavos = account.collectedCentavos + input.amountCentavos;
  await tx
    .update(batchAccounts)
    .set({
      collectedCentavos,
      status: nextStatus,
      collectionNotes: input.notes ?? null,
      collectedAt: input.amountCentavos > 0 ? new Date() : null
    })
    .where(eq(batchAccounts.id, account.id));

  if (batch.status === "OPEN") {
    await tx
      .update(collectionBatches)
      .set({ status: "IN_PROGRESS", updatedAt: new Date() })
      .where(eq(collectionBatches.id, batch.id));
  }

  const totals = await recalculateBatchTotals(tx, batch.id);

  await writeAudit(tx, actor, {
    action: auditActions.COLLECTION_RECORDED,
    entityType: "batch_account",
    entityId: account.id,
    reason: input.notes ?? null,
    changes: {
      collectedCentavos: { old: account.collectedCentavos, new: collectedCentavos },
      status: { old: account.status, new: nextStatus }
    },
    metadata: {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      method,
      amountCentavos: input.amountCentavos,
      paymentId: payment?.paymentId ?? null,
      receiptNumber: payment?.receiptNumber ?? null
    }
  });

  return {
    batchAccountId: account.id,
    paymentId: payment?.paymentId ?? "",
    receiptNumber: payment?.receiptNumber ?? "",
    amountCentavos: input.amountCentavos,
    allocatedCentavos: payment?.allocatedCentavos ?? 0,
    advanceCentavos: payment?.advanceCentavos ?? 0,
    balanceAfterCentavos: payment?.balanceAfterCentavos ?? 0,
    collectedCentavos,
    totalDueCentavos: account.totalDueCentavos,
    status: nextStatus,
    totals
  };
}

/**
 * Moves a batch along the ordinary part of its lifecycle.
 *
 * REMITTED, RECONCILED and CLOSED are refused here on purpose: each of those
 * means money changed hands with the office or an authorized person signed off,
 * so they belong to `submitRemittance`, `confirmRemittance` and `closeBatch`.
 */
export async function transitionBatch(
  tx: Transaction,
  batchId: string,
  toStatus: BatchStatus,
  notes?: string | null,
  actor?: Actor
): Promise<TransitionBatchResult> {
  assertCan(actor, "collection.record");

  if (statesReservedForDedicatedOperations.includes(toStatus)) {
    throw businessRule(
      `A batch cannot be moved to ${toStatus} directly.`,
      { toStatus, use: toStatus === "REMITTED" ? "submit a remittance" : toStatus === "RECONCILED" ? "confirm a remittance" : "close the batch" }
    );
  }

  const batch = await requireBatch(tx, batchId);
  if (batch.status === toStatus) {
    return { batchId, fromStatus: batch.status, toStatus };
  }
  if (!batchTransitions[batch.status].includes(toStatus)) {
    throw invalidState(`A batch cannot move from ${batch.status} to ${toStatus}.`, {
      from: batch.status,
      to: toStatus
    });
  }

  await tx
    .update(collectionBatches)
    .set({ status: toStatus, updatedAt: new Date() })
    .where(eq(collectionBatches.id, batchId));

  await writeAudit(tx, actor, {
    action: auditActions.BATCH_TRANSITIONED,
    entityType: "collection_batch",
    entityId: batchId,
    reason: notes ?? null,
    changes: { status: { old: batch.status, new: toStatus } },
    metadata: { batchNumber: batch.batchNumber }
  });

  return { batchId, fromStatus: batch.status, toStatus };
}

/**
 * Records what a collector physically handed over, and derives the difference.
 *
 * `shortageCentavos` and `overageCentavos` are computed here and are never
 * accepted from the client, so a collector cannot declare a ₱500 shortage away
 * by typing a matching number. A shortage is recorded, reported and escalated;
 * it is never rounded off to zero.
 */
export async function submitRemittance(
  tx: Transaction,
  input: SubmitRemittanceInput,
  actor?: Actor
): Promise<SubmitRemittanceResult> {
  assertCan(actor, "collection.reconcile");

  assertCentavos(input.cashRemittedCentavos, "Cash remitted");
  const nonCash = assertCentavos(input.nonCashCollectedCentavos ?? 0, "Non-cash collected");

  const batch = await requireBatch(tx, input.batchId);
  if (batch.status !== "SUBMITTED" && batch.status !== "IN_PROGRESS") {
    throw invalidState(
      `Only a submitted batch can be remitted. This batch is ${batch.status}.`,
      { status: batch.status }
    );
  }

  const totals = await recalculateBatchTotals(tx, batch.id);
  const year = Number(batch.batchDate.slice(0, 4));
  const remittanceNumber = await nextDocument(tx, "REMITTANCE", year);

  // Positive means the collector is short; negative means they handed over more
  // cash than the batch shows, which is an overage the office has to account for.
  const difference = totals.cashCollectedCentavos - input.cashRemittedCentavos;
  const shortage = difference > 0 ? difference : 0;
  const overage = difference < 0 ? -difference : 0;

  const [remittance] = await tx
    .insert(collectorRemittances)
    .values({
      remittanceNumber,
      batchId: batch.id,
      collectorId: batch.collectorId,
      remittanceDate: batch.batchDate,
      cashCollectedCentavos: totals.cashCollectedCentavos,
      cashRemittedCentavos: input.cashRemittedCentavos,
      nonCashCollectedCentavos: nonCash,
      differenceCentavos: difference,
      shortageCentavos: shortage,
      overageCentavos: overage,
      status: "SUBMITTED",
      submittedBy: actor?.id ?? null,
      submittedByName: actor?.displayName ?? null,
      submittedAt: new Date(),
      remarks: input.remarks ?? null
    })
    .returning();

  await tx
    .update(collectionBatches)
    .set({ status: "REMITTED", remittedAt: new Date(), submittedAt: batch.submittedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(collectionBatches.id, batch.id));

  await writeAudit(tx, actor, {
    action: auditActions.REMITTANCE_SUBMITTED,
    entityType: "collector_remittance",
    entityId: remittance.id,
    reason: input.remarks ?? null,
    changes: {
      cashCollectedCentavos: { old: null, new: totals.cashCollectedCentavos },
      cashRemittedCentavos: { old: null, new: input.cashRemittedCentavos },
      shortageCentavos: { old: null, new: shortage },
      overageCentavos: { old: null, new: overage }
    },
    metadata: { batchId: batch.id, remittanceNumber }
  });

  const view: RemittanceView = {
    id: remittance.id,
    remittanceNumber,
    batchId: batch.id,
    collectorId: batch.collectorId,
    remittanceDate: remittance.remittanceDate,
    cashCollectedCentavos: remittance.cashCollectedCentavos,
    cashRemittedCentavos: remittance.cashRemittedCentavos,
    nonCashCollectedCentavos: remittance.nonCashCollectedCentavos,
    differenceCentavos: remittance.differenceCentavos,
    shortageCentavos: remittance.shortageCentavos,
    overageCentavos: remittance.overageCentavos,
    status: remittance.status,
    rejectionReason: remittance.rejectionReason,
    remarks: remittance.remarks
  };

  return { ...view, batchStatus: "REMITTED", totals };
}

/**
 * Confirms or rejects a submitted remittance.
 *
 * Confirmation is the authorized act that lets a batch reconcile. A rejection
 * sends the batch back to IN_PROGRESS so the collector can correct it, and the
 * confirmed/rejected decision and the discrepancy figures are audited.
 */
export async function confirmRemittance(
  tx: Transaction,
  remittanceId: string,
  approved: boolean,
  reason: string,
  actor?: Actor
): Promise<ConfirmRemittanceResult> {
  assertCan(actor, "collection.reconcile");

  const [remittance] = await tx
    .select()
    .from(collectorRemittances)
    .where(eq(collectorRemittances.id, remittanceId))
    .limit(1);
  if (!remittance) {
    throw notFound("Remittance", remittanceId);
  }
  if (remittance.status !== "SUBMITTED") {
    throw invalidState(`Only a submitted remittance can be reviewed. This one is ${remittance.status}.`, {
      status: remittance.status
    });
  }

  const batch = await requireBatch(tx, remittance.batchId);
  const nextStatus: "CONFIRMED" | "REJECTED" = approved ? "CONFIRMED" : "REJECTED";
  const nextBatchStatus: BatchStatus = approved ? "RECONCILED" : "IN_PROGRESS";

  await tx
    .update(collectorRemittances)
    .set({
      status: nextStatus,
      confirmedBy: actor?.id ?? null,
      confirmedByName: actor?.displayName ?? null,
      confirmedAt: new Date(),
      rejectionReason: approved ? null : reason
    })
    .where(eq(collectorRemittances.id, remittanceId));

  await tx
    .update(collectionBatches)
    .set({
      status: nextBatchStatus,
      reconciledAt: approved ? new Date() : null,
      reconciledBy: approved ? actor?.id ?? null : null,
      reconciledByName: approved ? actor?.displayName ?? null : null,
      updatedAt: new Date()
    })
    .where(eq(collectionBatches.id, batch.id));

  await writeAudit(tx, actor, {
    action: approved ? auditActions.REMITTANCE_CONFIRMED : auditActions.REMITTANCE_REJECTED,
    entityType: "collector_remittance",
    entityId: remittanceId,
    reason,
    changes: { status: { old: remittance.status, new: nextStatus } },
    metadata: {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      shortageCentavos: remittance.shortageCentavos,
      overageCentavos: remittance.overageCentavos,
      differenceCentavos: remittance.differenceCentavos
    }
  });

  return {
    remittanceId,
    status: nextStatus,
    shortageCentavos: remittance.shortageCentavos,
    overageCentavos: remittance.overageCentavos,
    batchStatus: nextBatchStatus
  };
}

/**
 * Closes a reconciled batch.
 *
 * A batch may only close with a confirmed remittance behind it, and when that
 * remittance is short or over, the caller has to say so explicitly. This is the
 * guard for AT-08: a ₱500 shortage can be closed, but only by someone who
 * acknowledges the ₱500 in the same action - it can never be closed as if the
 * day balanced.
 */
export async function closeBatch(
  tx: Transaction,
  batchId: string,
  options: { notes?: string | null; acknowledgeDiscrepancy?: boolean } = {},
  actor?: Actor
): Promise<CloseBatchResult> {
  assertCan(actor, "collection.reconcile");

  const batch = await requireBatch(tx, batchId);
  if (batch.status !== "RECONCILED") {
    throw invalidState(
      `Only a reconciled batch can be closed. This batch is ${batch.status}.`,
      { status: batch.status }
    );
  }

  const [confirmed] = await tx
    .select()
    .from(collectorRemittances)
    .where(and(eq(collectorRemittances.batchId, batchId), eq(collectorRemittances.status, "CONFIRMED")))
    .orderBy(desc(collectorRemittances.confirmedAt))
    .limit(1);
  if (!confirmed) {
    throw invalidState("This batch has no confirmed remittance, so it cannot be closed.", {
      status: batch.status
    });
  }

  const discrepancy = confirmed.shortageCentavos > 0 || confirmed.overageCentavos > 0;
  if (discrepancy && !options.acknowledgeDiscrepancy) {
    throw businessRule(
      `This remittance is out by ` +
        `${formatDiscrepancy(confirmed.shortageCentavos, confirmed.overageCentavos)}. ` +
        "Acknowledge the discrepancy to close the batch; it cannot be closed as balanced.",
      {
        shortageCentavos: confirmed.shortageCentavos,
        overageCentavos: confirmed.overageCentavos,
        remittanceNumber: confirmed.remittanceNumber
      }
    );
  }

  await tx
    .update(collectionBatches)
    .set({ status: "CLOSED", closedAt: new Date(), closedBy: actor?.id ?? null, updatedAt: new Date() })
    .where(eq(collectionBatches.id, batchId));

  await writeAudit(tx, actor, {
    action: auditActions.BATCH_CLOSED,
    entityType: "collection_batch",
    entityId: batchId,
    reason: options.notes ?? null,
    changes: { status: { old: batch.status, new: "CLOSED" } },
    metadata: {
      batchNumber: batch.batchNumber,
      remittanceNumber: confirmed.remittanceNumber,
      shortageCentavos: confirmed.shortageCentavos,
      overageCentavos: confirmed.overageCentavos,
      discrepancyAcknowledged: discrepancy
    }
  });

  return {
    batchId,
    status: "CLOSED",
    shortageCentavos: confirmed.shortageCentavos,
    overageCentavos: confirmed.overageCentavos,
    discrepancyAcknowledged: discrepancy
  };
}

function formatDiscrepancy(shortage: number, overage: number): string {
  const peso = (centavos: number) => `₱${(centavos / 100).toFixed(2)}`;
  if (shortage > 0 && overage > 0) {
    return `${peso(shortage)} short and ${peso(overage)} over`;
  }
  return shortage > 0 ? `${peso(shortage)} short` : `${peso(overage)} over`;
}

const batchListSelection = {
  id: collectionBatches.id,
  batchNumber: collectionBatches.batchNumber,
  batchDate: collectionBatches.batchDate,
  status: collectionBatches.status,
  areaId: collectionBatches.areaId,
  routeId: collectionBatches.routeId,
  collectorId: collectionBatches.collectorId,
  accountCount: collectionBatches.accountCount,
  expectedReceivableCentavos: collectionBatches.expectedReceivableCentavos,
  cashCollectedCentavos: collectionBatches.cashCollectedCentavos,
  nonCashCollectedCentavos: collectionBatches.nonCashCollectedCentavos,
  totalCollectedCentavos: collectionBatches.totalCollectedCentavos,
  uncollectedCentavos: collectionBatches.uncollectedCentavos,
  openedByName: collectionBatches.openedByName,
  submittedAt: collectionBatches.submittedAt,
  remittedAt: collectionBatches.remittedAt,
  reconciledAt: collectionBatches.reconciledAt,
  closedAt: collectionBatches.closedAt,
  areaName: collectionAreas.name,
  routeName: collectionRoutes.name,
  collectorName: collectors.fullName
};

export async function listBatches(
  executor: Executor,
  query: BatchListQuery
): Promise<{ items: BatchListItem[]; page: number; pageSize: number; total: number }> {
  const filters = [];
  if (query.status) {
    filters.push(eq(collectionBatches.status, query.status));
  }
  if (query.collectorId) {
    filters.push(eq(collectionBatches.collectorId, query.collectorId));
  }
  if (query.areaId) {
    filters.push(eq(collectionBatches.areaId, query.areaId));
  }
  if (query.from) {
    filters.push(sql`${collectionBatches.batchDate} >= ${query.from}`);
  }
  if (query.to) {
    filters.push(sql`${collectionBatches.batchDate} <= ${query.to}`);
  }

  const rows = await executor
    .select(batchListSelection)
    .from(collectionBatches)
    .leftJoin(collectionAreas, eq(collectionAreas.id, collectionBatches.areaId))
    .leftJoin(collectionRoutes, eq(collectionRoutes.id, collectionBatches.routeId))
    .innerJoin(collectors, eq(collectors.id, collectionBatches.collectorId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(collectionBatches.batchDate), desc(collectionBatches.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [{ count }] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionBatches)
    .where(filters.length > 0 ? and(...filters) : undefined);

  return {
    items: rows as BatchListItem[],
    page: query.page,
    pageSize: query.pageSize,
    total: Number(count ?? 0)
  };
}

async function loadBatchAccounts(
  executor: Executor,
  batchId: string
): Promise<BatchAccountView[]> {
  const rows = await executor
    .select({
      id: batchAccounts.id,
      serviceAccountId: batchAccounts.serviceAccountId,
      currentBillCentavos: batchAccounts.currentBillCentavos,
      arrearsCentavos: batchAccounts.arrearsCentavos,
      totalDueCentavos: batchAccounts.totalDueCentavos,
      collectedCentavos: batchAccounts.collectedCentavos,
      status: batchAccounts.status,
      collectionNotes: batchAccounts.collectionNotes,
      collectedAt: batchAccounts.collectedAt,
      accountNumber: serviceAccounts.serviceAccountNumber,
      serviceTypeCode: serviceTypes.code,
      address: serviceAccounts.installationAddress,
      subscriberName: subscribers.fullName
    })
    .from(batchAccounts)
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, batchAccounts.serviceAccountId))
    .innerJoin(subscribers, eq(subscribers.id, serviceAccounts.subscriberId))
    .leftJoin(servicePlans, eq(servicePlans.id, serviceAccounts.planId))
    .leftJoin(serviceTypes, eq(serviceTypes.id, servicePlans.serviceTypeId))
    .where(eq(batchAccounts.batchId, batchId))
    .orderBy(asc(subscribers.fullName));

  return rows as BatchAccountView[];
}

export async function getBatch(executor: Executor, batchId: string): Promise<BatchDetail> {
  const [batch] = await executor
    .select({
      ...batchListSelection,
      dueDayCutoff: collectionBatches.dueDayCutoff,
      notes: collectionBatches.notes,
      openedBy: collectionBatches.openedBy,
      reconciledByName: collectionBatches.reconciledByName,
      closedBy: collectionBatches.closedBy
    })
    .from(collectionBatches)
    .innerJoin(collectionAreas, eq(collectionAreas.id, collectionBatches.areaId))
    .leftJoin(collectionRoutes, eq(collectionRoutes.id, collectionBatches.routeId))
    .innerJoin(collectors, eq(collectors.id, collectionBatches.collectorId))
    .where(eq(collectionBatches.id, batchId))
    .limit(1);
  if (!batch) {
    throw notFound("Collection batch", batchId);
  }

  const remittanceRows = await executor
    .select()
    .from(collectorRemittances)
    .where(eq(collectorRemittances.batchId, batchId))
    .orderBy(desc(collectorRemittances.createdAt));

  const remittances: RemittanceView[] = remittanceRows.map((row) => ({
    id: row.id,
    remittanceNumber: row.remittanceNumber,
    batchId: row.batchId,
    collectorId: row.collectorId,
    remittanceDate: row.remittanceDate,
    cashCollectedCentavos: row.cashCollectedCentavos,
    cashRemittedCentavos: row.cashRemittedCentavos,
    nonCashCollectedCentavos: row.nonCashCollectedCentavos,
    differenceCentavos: row.differenceCentavos,
    shortageCentavos: row.shortageCentavos,
    overageCentavos: row.overageCentavos,
    status: row.status,
    rejectionReason: row.rejectionReason,
    remarks: row.remarks
  }));

  return {
    ...(batch as BatchListItem),
    dueDayCutoff: batch.dueDayCutoff,
    notes: batch.notes,
    openedBy: batch.openedBy,
    reconciledByName: batch.reconciledByName,
    closedBy: batch.closedBy,
    accounts: await loadBatchAccounts(executor, batchId),
    remittances,
    confirmedRemittance: remittances.find((row) => row.status === "CONFIRMED") ?? null
  };
}

export interface RemittanceListQuery {
  page: number;
  pageSize: number;
  status?: RemittanceStatus;
  collectorId?: string;
}

export interface RemittanceListItem extends RemittanceView {
  batchNumber: string;
  batchDate: string;
  collectorName: string;
  submittedByName: string | null;
  confirmedByName: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
}

export async function listRemittances(
  executor: Executor,
  query: RemittanceListQuery
): Promise<{ items: RemittanceListItem[]; page: number; pageSize: number; total: number }> {
  const filters = [];
  if (query.status) {
    filters.push(eq(collectorRemittances.status, query.status));
  }
  if (query.collectorId) {
    filters.push(eq(collectorRemittances.collectorId, query.collectorId));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await executor
    .select({
      id: collectorRemittances.id,
      remittanceNumber: collectorRemittances.remittanceNumber,
      batchId: collectorRemittances.batchId,
      collectorId: collectorRemittances.collectorId,
      remittanceDate: collectorRemittances.remittanceDate,
      cashCollectedCentavos: collectorRemittances.cashCollectedCentavos,
      cashRemittedCentavos: collectorRemittances.cashRemittedCentavos,
      nonCashCollectedCentavos: collectorRemittances.nonCashCollectedCentavos,
      differenceCentavos: collectorRemittances.differenceCentavos,
      shortageCentavos: collectorRemittances.shortageCentavos,
      overageCentavos: collectorRemittances.overageCentavos,
      status: collectorRemittances.status,
      rejectionReason: collectorRemittances.rejectionReason,
      remarks: collectorRemittances.remarks,
      submittedByName: collectorRemittances.submittedByName,
      confirmedByName: collectorRemittances.confirmedByName,
      submittedAt: collectorRemittances.submittedAt,
      confirmedAt: collectorRemittances.confirmedAt,
      batchNumber: collectionBatches.batchNumber,
      batchDate: collectionBatches.batchDate,
      collectorName: collectors.fullName
    })
    .from(collectorRemittances)
    .innerJoin(collectionBatches, eq(collectionBatches.id, collectorRemittances.batchId))
    .innerJoin(collectors, eq(collectors.id, collectorRemittances.collectorId))
    .where(where)
    .orderBy(desc(collectorRemittances.remittanceDate), desc(collectorRemittances.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [{ count }] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(collectorRemittances)
    .where(where);

  return {
    items: rows as RemittanceListItem[],
    page: query.page,
    pageSize: query.pageSize,
    total: Number(count ?? 0)
  };
}

/**
 * The printable route sheet (§3.8): account, address, current bill, arrears and
 * total due, in visiting order. Returned as data so the renderer can lay it out
 * for print without the API knowing anything about paper.
 */
export async function getRouteSheet(
  executor: Executor,
  batchId: string
): Promise<{ batch: BatchDetail; rows: RouteSheetRow[]; totals: BatchTotals }> {
  const batch = await getBatch(executor, batchId);
  return {
    batch,
    rows: batch.accounts.map((account, index) => ({ ...account, sequence: index + 1 })),
    totals: {
      accountCount: batch.accountCount,
      expectedReceivableCentavos: batch.expectedReceivableCentavos,
      cashCollectedCentavos: batch.cashCollectedCentavos,
      nonCashCollectedCentavos: batch.nonCashCollectedCentavos,
      totalCollectedCentavos: batch.totalCollectedCentavos,
      uncollectedCentavos: batch.uncollectedCentavos
    }
  };
}

/** Per-collector performance for the collection report. */
export interface CollectorPerformanceRow {
  collectorId: string;
  collectorName: string;
  batchCount: number;
  expectedReceivableCentavos: number;
  totalCollectedCentavos: number;
  uncollectedCentavos: number;
  collectionRate: number;
  shortageCentavos: number;
  overageCentavos: number;
}

interface CollectorPerformanceRawRow {
  collector_id: string;
  collector_name: string;
  batch_count: number;
  expected_receivable_centavos: number;
  total_collected_centavos: number;
  uncollected_centavos: number;
  collection_rate: number;
  shortage_centavos: number;
  overage_centavos: number;
}

export async function collectorPerformance(
  executor: Executor,
  filters: { from?: string; to?: string; collectorId?: string } = {}
): Promise<CollectorPerformanceRow[]> {
  const conditions = [];
  if (filters.from) {
    conditions.push(sql`b.batch_date >= ${filters.from}`);
  }
  if (filters.to) {
    conditions.push(sql`b.batch_date <= ${filters.to}`);
  }
  if (filters.collectorId) {
    conditions.push(sql`b.collector_id = ${filters.collectorId}`);
  }
  const where =
    conditions.length > 0
      ? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}`
      : sql``;

  const rows = await queryRows<CollectorPerformanceRawRow>(
    executor,
    sql`
      select
        b.collector_id,
        coalesce(c.full_name, 'Unassigned') as collector_name,
        count(*)::int as batch_count,
        coalesce(sum(b.expected_receivable_centavos), 0)::bigint as expected_receivable_centavos,
        coalesce(sum(b.total_collected_centavos), 0)::bigint as total_collected_centavos,
        coalesce(sum(b.uncollected_centavos), 0)::bigint as uncollected_centavos,
        case when coalesce(sum(b.expected_receivable_centavos), 0) = 0 then 0
          else round(
            coalesce(sum(b.total_collected_centavos), 0)::numeric
            / sum(b.expected_receivable_centavos) * 100, 2
          ) end as collection_rate,
        coalesce(sum(r.shortage_centavos), 0)::bigint as shortage_centavos,
        coalesce(sum(r.overage_centavos), 0)::bigint as overage_centavos
      from ${collectionBatches} b
      left join ${collectors} c on c.id = b.collector_id
      left join ${collectorRemittances} r on r.batch_id = b.id and r.status = 'CONFIRMED'
      ${where}
      group by b.collector_id, c.full_name
      order by c.full_name
    `
  );

  return rows.map((row) => ({
    collectorId: row.collector_id,
    collectorName: row.collector_name,
    batchCount: Number(row.batch_count ?? 0),
    expectedReceivableCentavos: Number(row.expected_receivable_centavos ?? 0),
    totalCollectedCentavos: Number(row.total_collected_centavos ?? 0),
    uncollectedCentavos: Number(row.uncollected_centavos ?? 0),
    collectionRate: Number(row.collection_rate ?? 0),
    shortageCentavos: Number(row.shortage_centavos ?? 0),
    overageCentavos: Number(row.overage_centavos ?? 0)
  }));
}

/** Guard used by the routes: a batch must not be edited once it is closed. */
export async function assertBatchEditable(executor: Executor, batchId: string): Promise<BatchStatus> {
  const batch = await requireBatch(executor, batchId);
  if (batch.status === "CLOSED") {
    throw conflict("This batch is closed and can no longer be changed.", { status: batch.status });
  }
  return batch.status;
}
