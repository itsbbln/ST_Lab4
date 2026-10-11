import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { formatCentavos, sum as sumCentavos, type PaymentMethod } from "@bcis/shared";

import { queryRow, queryRows, type Executor, type Transaction } from "../db/client.js";
import {
  invoices,
  paymentAllocations,
  paymentProofs,
  paymentReversals,
  payments,
  receipts,
  serviceAccounts,
  subscribers
} from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { deriveInvoiceStatus } from "./billing.js";
import { businessRule, conflict, duplicateReference, notFound, validationFailed } from "./errors.js";
import { accountBalance, labelForMethod, postLedgerEntry, postPaymentCredit } from "./ledger.js";
import { nextDocument } from "./numbering.js";
import type { Actor } from "./types.js";

/**
 * Payments, allocation, GCash verification and reversals (§3.4–§3.7).
 *
 * ## The allocation invariant
 *
 * ```
 * allocated_centavos + credit_applied_centavos + advance_centavos
 *     == payments.amount_centavos
 * ```
 *
 * and for every invoice:
 *
 * ```
 * invoice.paid_centavos  ==  sum of its payment_allocations
 * invoice.balance_centavos == invoice.total_centavos - invoice.paid_centavos
 * ```
 *
 * These are checked by the acceptance tests. They hold because every allocation
 * is written in the same transaction that updates the invoice, and because
 * allocation is always *oldest invoice first* — so the money is never parked on
 * a current invoice while an older one goes unpaid, which is the behaviour the
 * lab's accountability requirement is about.
 *
 * ## Why advance is re-applied, not re-created
 *
 * When a subscriber overpays, the excess sits on the payment as `advance`. When
 * the next invoice is generated, that advance is applied by writing an
 * allocation row against the *original* payment and moving the amount from
 * `advance` to `credit_applied`. No second cash movement is invented, so the
 * ledger credit still matches the money that actually arrived, and the
 * statement of account keeps telling the truth.
 *
 * ## Concurrency
 *
 * Every posting path takes a row lock on the service account
 * (`SELECT ... FOR UPDATE`) before reading open invoices. Without it, two cashiers
 * posting against the same account at the same time could both read the same
 * invoice balance and collectively over-allocate it.
 */

export interface AllocationLine {
  invoiceId: string;
  invoiceNumber: string;
  period: string;
  dueDate: string;
  outstandingCentavos: number;
  amountCentavos: number;
}

export interface AllocationPreview {
  serviceAccountId: string;
  amountCentavos: number;
  /** Applied to the oldest outstanding invoices first. */
  allocations: AllocationLine[];
  /** Unmatched remainder, held as a credit on account. */
  advanceCentavos: number;
  /** Advance already held from earlier payments, available to absorb this one. */
  existingAdvanceCentavos: number;
  outstandingAfterCentavos: number;
  total: {
    amount: string;
    advance: string;
    existingAdvance: string;
  };
}

/** One open invoice as the locked query returns it. */
interface OpenInvoiceSqlRow extends Record<string, unknown> {
  id: string;
  invoice_number: string;
  period: string;
  due_date: string;
  total_centavos: number;
  paid_centavos: number;
  balance_centavos: number;
  status: string;
}

/** Open invoices for an account, oldest first, locked for update. */
async function openInvoicesForUpdate(executor: Executor, serviceAccountId: string) {
  return queryRows<OpenInvoiceSqlRow>(
    executor,
    sql`
      select id, invoice_number, period, due_date, total_centavos, paid_centavos, balance_centavos, status
      from invoices
      where service_account_id = ${serviceAccountId}
        and status in ('UNPAID', 'PARTIALLY_PAID', 'OVERDUE')
        and balance_centavos > 0
      order by due_date asc, period asc, invoice_number asc
      for update
    `
  );
}

/** Advance currently held across a service account's posted payments. */
export async function availableAdvance(
  executor: Executor,
  serviceAccountId: string
): Promise<number> {
  const row = await queryRow<{ advance: number }>(
    executor,
    sql`
      select coalesce(sum(advance_centavos), 0)::bigint as advance
      from payments
      where service_account_id = ${serviceAccountId} and status = 'POSTED'
    `
  );
  return Number(row?.advance ?? 0);
}

/**
 * Works out how a payment would be applied, without writing anything.
 *
 * The cashier screen calls this as the amount is typed so the operator can see
 * which invoices are being settled and whether a change is left over.
 */
export async function previewAllocation(
  executor: Executor,
  serviceAccountId: string,
  amountCentavos: number
): Promise<AllocationPreview> {
  if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw validationFailed("The payment amount must be greater than zero.");
  }

  const rows = await queryRows<OpenInvoiceSqlRow>(
    executor,
    sql`
      select id, invoice_number, period, due_date, balance_centavos
      from invoices
      where service_account_id = ${serviceAccountId}
        and status in ('UNPAID', 'PARTIALLY_PAID', 'OVERDUE')
        and balance_centavos > 0
      order by due_date asc, period asc, invoice_number asc
    `
  );

  const allocations = planAllocation(rows, amountCentavos);
  const advanceCentavos = amountCentavos - sumCentavos(allocations.map((line) => line.amountCentavos));
  const existingAdvanceCentavos = await availableAdvance(executor, serviceAccountId);
  const outstandingAfter = await totalOutstanding(executor, serviceAccountId);

  return {
    serviceAccountId,
    amountCentavos,
    allocations,
    advanceCentavos,
    existingAdvanceCentavos,
    outstandingAfterCentavos: outstandingAfter - sumCentavos(allocations.map((line) => line.amountCentavos)),
    total: {
      amount: formatCentavos(amountCentavos),
      advance: formatCentavos(advanceCentavos, { blankZero: true }),
      existingAdvance: formatCentavos(existingAdvanceCentavos, { blankZero: true })
    }
  };
}

/**
 * Oldest-first allocation plan. Pure, so the same function backs both the
 * preview and the actual posting and they cannot disagree.
 *
 * Exported for tests: this decides which invoice a subscriber's money settles,
 * and getting it wrong silently misdirects real collections.
 */
export function planAllocation(
  rows: Array<Record<string, unknown>>,
  amountCentavos: number
): AllocationLine[] {
  const lines: AllocationLine[] = [];
  let remaining = amountCentavos;

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    const outstanding = Number(row.balance_centavos ?? 0);
    if (outstanding <= 0) {
      continue;
    }
    const applied = Math.min(outstanding, remaining);
    lines.push({
      invoiceId: String(row.id),
      invoiceNumber: String(row.invoice_number),
      period: String(row.period),
      dueDate: String(row.due_date).slice(0, 10),
      outstandingCentavos: outstanding,
      amountCentavos: applied
    });
    remaining -= applied;
  }

  return lines;
}

async function totalOutstanding(executor: Executor, serviceAccountId: string): Promise<number> {
  const row = await queryRow<{ outstanding: number }>(
    executor,
    sql`
      select coalesce(sum(balance_centavos), 0)::bigint as outstanding
      from invoices
      where service_account_id = ${serviceAccountId}
        and status <> 'VOID' and balance_centavos > 0
    `
  );
  return Number(row?.outstanding ?? 0);
}

/** Serialises posting for one account so two cashiers cannot over-allocate. */
async function lockAccount(executor: Executor, serviceAccountId: string) {
  const rows = await executor
    .select({
      id: serviceAccounts.id,
      status: serviceAccounts.status,
      collectorId: serviceAccounts.collectorId
    })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1)
    .for("update");

  const account = rows[0];
  if (!account) {
    throw notFound("Service account", serviceAccountId);
  }
  if (account.status === "TERMINATED") {
    throw businessRule("This service account has been terminated and cannot take payments.");
  }
  return account;
}

export interface PostPaymentInput {
  serviceAccountId: string;
  amountCentavos: number;
  method: PaymentMethod;
  paymentDate?: Date;
  referenceNumber?: string | null;
  notes?: string | null;
  /** Set when a cashier collects on a collection batch. */
  batchId?: string | null;
  collectorId?: string | null;
  /** Explicit allocation; when omitted the oldest-first plan is used. */
  allocations?: Array<{ invoiceId: string; amountCentavos: number }>;
  /** Set when posting a payment that came from a verified GCash proof. */
  proofId?: string | null;
}

export interface PostPaymentResult {
  paymentId: string;
  receiptNumber: string;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCentavos: number;
  balanceAfterCentavos: number;
  allocations: Array<AllocationLine & { allocationType: "AUTO" | "MANUAL" }>;
  receipt: { id: string; receiptNumber: string; issuedAt: Date };
  totals: {
    amount: string;
    allocated: string;
    advance: string;
    balance: string;
  };
}

/**
 * Posts a payment, applies it, and writes the matching ledger credit.
 *
 * This takes the caller's transaction rather than opening one. `postPayment` is
 * reached from more than one path — a cashier, and the GCash reviewer — and the
 * reviewer's approval has to be all-or-nothing, so the decision to open a
 * transaction belongs to the route. A service that quietly started its own
 * would take a second pooled connection, and its writes would commit or roll
 * back independently of the surrounding work.
 *
 * The receipt number is reserved from the shared sequence so three office PCs
 * can never issue the same number, and the ledger credit is written on the same
 * transaction: a payment with no ledger credit, or a credit with no payment, is
 * exactly the inconsistency the lab's audit test looks for.
 */
export async function postPayment(
  tx: Transaction,
  input: PostPaymentInput,
  actor?: Actor
): Promise<PostPaymentResult> {
  if (!Number.isInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    throw validationFailed("The payment amount must be greater than zero.");
  }

  const account = await lockAccount(tx, input.serviceAccountId);
  const subscriber = await tx
    .select({ id: subscribers.id })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(eq(serviceAccounts.id, input.serviceAccountId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!subscriber) {
    throw notFound("Service account", input.serviceAccountId);
  }

  const paymentDate = input.paymentDate ?? new Date();
  const year = paymentDate.getUTCFullYear();
  const receiptNumber = await nextDocument(tx, "RECEIPT", year);

  // A duplicate GCash reference is a real and common error, and the partial
  // unique index on (method, status, reference_number) makes it impossible to
  // store twice. Catch it here to give the operator a usable message.
  if (input.method === "GCASH" && input.referenceNumber) {
    const existing = await tx
      .select({ id: payments.id, receiptNumber: payments.receiptNumber })
      .from(payments)
      .where(
        and(
          eq(payments.method, "GCASH"),
          eq(payments.status, "POSTED"),
          sql`upper(${payments.referenceNumber}) = upper(${input.referenceNumber})`
        )
      )
      .limit(1);
    if (existing[0]) {
      throw duplicateReference(
        `GCash reference ${input.referenceNumber} was already posted as receipt ${existing[0].receiptNumber}.`
      );
    }
  }

  const [payment] = await tx
    .insert(payments)
    .values({
      receiptNumber,
      serviceAccountId: input.serviceAccountId,
      subscriberId: subscriber.id,
      paymentDate,
      amountCentavos: input.amountCentavos,
      method: input.method,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      status: "POSTED",
      collectorId: input.collectorId ?? account.collectorId ?? null,
      batchId: input.batchId ?? null,
      postedBy: actor?.id ?? null,
      postedByName: actor?.displayName ?? null
    })
    .returning();

  const allocationLines = await applyAllocations(tx, {
    paymentId: payment.id,
    serviceAccountId: input.serviceAccountId,
    amountCentavos: input.amountCentavos,
    requested: input.allocations
  });

  const allocatedCentavos = sumCentavos(allocationLines.map((line) => line.amountCentavos));
  const advanceCentavos = input.amountCentavos - allocatedCentavos;

  await tx
    .update(payments)
    .set({ allocatedCentavos, advanceCentavos })
    .where(eq(payments.id, payment.id));

  const [receipt] = await tx
    .insert(receipts)
    .values({
      receiptNumber,
      paymentId: payment.id,
      issuedBy: actor?.id ?? null,
      issuedByName: actor?.displayName ?? null
    })
    .returning();

  // The ledger credit is for the *full* cash amount, including any part held as
  // advance. Allocation does not move money, so it is not in the ledger.
  await postPaymentCredit(
    tx,
    {
      serviceAccountId: input.serviceAccountId,
      receiptNumber,
      amountCentavos: input.amountCentavos,
      paymentId: payment.id,
      method: input.method,
      paymentDate: paymentDate.toISOString()
    },
    actor
  );

  if (input.proofId) {
    await tx
      .update(paymentProofs)
      .set({ paymentId: payment.id })
      .where(eq(paymentProofs.id, input.proofId));
  }

  const { balanceCentavos } = await accountBalance(tx, input.serviceAccountId);

  await writeAudit(tx, actor, {
    action: auditActions.PAYMENT_POSTED,
    entityType: "payment",
    entityId: payment.id,
    changes: {
      amountCentavos: { new: input.amountCentavos },
      allocatedCentavos: { new: allocatedCentavos },
      advanceCentavos: { new: advanceCentavos },
      method: { new: input.method }
    },
    metadata: {
      receiptNumber,
      serviceAccountId: input.serviceAccountId,
      allocations: allocationLines.map((line) => ({
        invoiceId: line.invoiceId,
        invoiceNumber: line.invoiceNumber,
        amountCentavos: line.amountCentavos
      }))
    }
  });

  return {
    paymentId: payment.id,
    receiptNumber,
    amountCentavos: input.amountCentavos,
    allocatedCentavos,
    advanceCentavos,
    balanceAfterCentavos: balanceCentavos,
    allocations: allocationLines,
    receipt: { id: receipt.id, receiptNumber, issuedAt: receipt.issuedAt },
    totals: {
      amount: formatCentavos(input.amountCentavos),
      allocated: formatCentavos(allocatedCentavos),
      advance: formatCentavos(advanceCentavos, { blankZero: true }),
      balance: formatCentavos(balanceCentavos)
    }
  };
}

/**
 * Writes the allocation rows and updates each invoice in the same transaction.
 *
 * When the caller supplies no explicit split, the oldest-first plan is used.
 * A supplied split is still validated against what each invoice can absorb, so a
 * stale screen cannot push an invoice past zero.
 */
async function applyAllocations(
  executor: Executor,
  input: {
    paymentId: string;
    serviceAccountId: string;
    amountCentavos: number;
    requested?: Array<{ invoiceId: string; amountCentavos: number }>;
  }
): Promise<Array<AllocationLine & { allocationType: "AUTO" | "MANUAL" }>> {
  const openRows = await openInvoicesForUpdate(executor, input.serviceAccountId);

  let lines: AllocationLine[];
  let allocationType: "AUTO" | "MANUAL";

  if (input.requested && input.requested.length > 0) {
    const byId = new Map(openRows.map((row) => [String(row.id), row]));
    const requestedTotal = sumCentavos(input.requested.map((line) => line.amountCentavos));
    if (requestedTotal > input.amountCentavos) {
      throw businessRule(
        `The allocation totals ${formatCentavos(requestedTotal)}, which is more than the payment of ${formatCentavos(
          input.amountCentavos
        )}.`
      );
    }
    lines = input.requested
      .filter((line) => line.amountCentavos > 0)
      .map((line) => {
        const row = byId.get(line.invoiceId);
        if (!row) {
          throw businessRule(
            "One of the selected invoices is no longer open. Refresh the screen and try again."
          );
        }
        const outstanding = Number(row.balance_centavos ?? 0);
        if (line.amountCentavos > outstanding) {
          throw businessRule(
            `Invoice ${String(row.invoice_number)} only has ${formatCentavos(outstanding)} outstanding.`
          );
        }
        return {
          invoiceId: line.invoiceId,
          invoiceNumber: String(row.invoice_number),
          period: String(row.period),
          dueDate: String(row.due_date).slice(0, 10),
          outstandingCentavos: outstanding,
          amountCentavos: line.amountCentavos
        };
      });
    allocationType = "MANUAL";
  } else {
    lines = planAllocation(openRows, input.amountCentavos);
    allocationType = "AUTO";
  }

  if (lines.length === 0) {
    return [];
  }

  await executor.insert(paymentAllocations).values(
    lines.map((line) => ({
      paymentId: input.paymentId,
      invoiceId: line.invoiceId,
      amountCentavos: line.amountCentavos,
      allocationType
    }))
  );

  for (const line of lines) {
    const [invoice] = await executor
      .select({
        id: invoices.id,
        totalCentavos: invoices.totalCentavos,
        paidCentavos: invoices.paidCentavos,
        balanceCentavos: invoices.balanceCentavos,
        dueDate: invoices.dueDate,
        status: invoices.status
      })
      .from(invoices)
      .where(eq(invoices.id, line.invoiceId))
      .limit(1);
    if (!invoice) {
      throw notFound("Invoice", line.invoiceId);
    }

    const paid = invoice.paidCentavos + line.amountCentavos;
    const balance = invoice.totalCentavos - paid;
    const status = deriveInvoiceStatus(balance, paid, invoice.dueDate, invoice.status);

    await executor
      .update(invoices)
      .set({ paidCentavos: paid, balanceCentavos: balance, status, updatedAt: new Date() })
      .where(eq(invoices.id, line.invoiceId));
  }

  return lines.map((line) => ({ ...line, allocationType }));
}

/**
 * Consumes a subscriber's existing advance against newly generated invoices.
 *
 * Called by the billing generator after an invoice is created, so a subscriber
 * who overpaid last month has that credit consumed by this month's invoice
 * instead of sitting unused. The advance moves from `advance_centavos` to
 * `credit_applied_centavos` on the original payment; no new cash is recorded.
 *
 * Oldest payments are consumed first so the credit is consumed in the order the
 * money was actually received.
 */
export async function applyExistingAdvance(
  executor: Executor,
  serviceAccountId: string,
  invoiceId: string,
  invoiceBalanceCentavos: number
): Promise<number> {
  if (invoiceBalanceCentavos <= 0) {
    return 0;
  }

  const holders = await executor
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCentavos: payments.amountCentavos,
      advanceCentavos: payments.advanceCentavos,
      creditAppliedCentavos: payments.creditAppliedCentavos
    })
    .from(payments)
    .where(and(eq(payments.serviceAccountId, serviceAccountId), eq(payments.status, "POSTED")))
    .orderBy(payments.paymentDate, payments.receiptNumber);

  let remaining = invoiceBalanceCentavos;
  let applied = 0;

  for (const holder of holders) {
    if (remaining <= 0) {
      break;
    }
    if (holder.advanceCentavos <= 0) {
      continue;
    }
    const use = Math.min(holder.advanceCentavos, remaining);
    remaining -= use;
    applied += use;

    await executor
      .update(payments)
      .set({
        advanceCentavos: holder.advanceCentavos - use,
        creditAppliedCentavos: holder.creditAppliedCentavos + use
      })
      .where(eq(payments.id, holder.id));

    await executor.insert(paymentAllocations).values({
      paymentId: holder.id,
      invoiceId,
      amountCentavos: use,
      allocationType: "AUTO"
    });
  }

  if (applied > 0) {
    const [invoice] = await executor
      .select({
        totalCentavos: invoices.totalCentavos,
        paidCentavos: invoices.paidCentavos,
        balanceCentavos: invoices.balanceCentavos,
        dueDate: invoices.dueDate,
        status: invoices.status
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (invoice) {
      const paid = invoice.paidCentavos + applied;
      const balance = invoice.totalCentavos - paid;
      await executor
        .update(invoices)
        .set({
          paidCentavos: paid,
          balanceCentavos: balance,
          status: deriveInvoiceStatus(balance, paid, invoice.dueDate, invoice.status),
          updatedAt: new Date()
        })
        .where(eq(invoices.id, invoiceId));
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Reversals (§3.6)
// ---------------------------------------------------------------------------

export interface ReversePaymentResult {
  paymentId: string;
  reversalNumber: string;
  receiptNumber: string;
  amountCentavos: number;
  /** Allocation rows removed, i.e. money returned to the invoices. */
  creditRestoredCentavos: number;
  /** Cash that was never applied to an invoice, now returned as advance. */
  unallocatedCentavos: number;
  restoredInvoices: Array<{ invoiceNumber: string; amountCentavos: number }>;
}

/**
 * Reverses a posted payment.
 *
 * The payment row is never deleted and keeps its original receipt number. What
 * this does is: remove its allocations, restore each affected invoice's paid and
 * balance figures, restore the unallocated part as advance, and write a ledger
 * debit for the full amount so the subscriber's balance returns to what it was
 * before the payment existed.
 *
 * Like `postPayment`, this runs on the caller's transaction so the route decides
 * where the transaction begins.
 */
export async function reversePayment(
  executor: Transaction,
  paymentId: string,
  reason: string,
  actor?: Actor
): Promise<ReversePaymentResult> {
  if (!reason || reason.trim().length < 3) {
    throw validationFailed("A reason is required to reverse a payment.");
  }

  const tx = executor;
  const rows = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const payment = rows[0];
  if (!payment) {
    throw notFound("Payment", paymentId);
  }
  if (payment.status === "REVERSED") {
    throw conflict("This payment has already been reversed.");
  }

  // Lock the payment row so two reversals cannot both pass the check above.
  await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId)).for("update");

  const allocationRows = await queryRows<{
    id: string;
    invoice_id: string;
    amount_centavos: number;
    invoice_number: string;
  }>(
    tx,
    sql`
      select pa.id, pa.invoice_id, pa.amount_centavos, i.invoice_number
      from payment_allocations pa
      inner join invoices i on pa.invoice_id = i.id
      where pa.payment_id = ${paymentId}
      order by i.due_date asc, i.invoice_number asc
      for update of i
    `
  );

  const restoredInvoices: Array<{ invoiceNumber: string; amountCentavos: number }> = [];

  for (const allocation of allocationRows) {
    const [invoice] = await tx
      .select({
        id: invoices.id,
        totalCentavos: invoices.totalCentavos,
        paidCentavos: invoices.paidCentavos,
        dueDate: invoices.dueDate,
        status: invoices.status
      })
      .from(invoices)
      .where(eq(invoices.id, allocation.invoice_id))
      .limit(1);
    if (!invoice) {
      continue;
    }
    const amount = Number(allocation.amount_centavos);
    // Never let a reversal drive an invoice's paid figure below zero; that
    // would mean the original allocation had already been clawed back.
    const paid = Math.max(0, invoice.paidCentavos - amount);
    const balance = invoice.totalCentavos - paid;
    await tx
      .update(invoices)
      .set({
        paidCentavos: paid,
        balanceCentavos: balance,
        status: deriveInvoiceStatus(balance, paid, invoice.dueDate, invoice.status),
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id));
    restoredInvoices.push({
      invoiceNumber: String(allocation.invoice_number),
      amountCentavos: amount
    });
  }

  if (allocationRows.length > 0) {
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));
  }

  const creditRestoredCentavos = sumCentavos(restoredInvoices.map((row) => row.amountCentavos));
  const unallocatedCentavos = payment.amountCentavos - creditRestoredCentavos;

  const [reversed] = await tx
    .update(payments)
    .set({
      status: "REVERSED",
      reversedAt: new Date(),
      reversedBy: actor?.id ?? null,
      reversalReason: reason,
      allocatedCentavos: 0,
      creditAppliedCentavos: 0,
      advanceCentavos: 0
    })
    .where(eq(payments.id, paymentId))
    .returning();

  const reversalNumber = await nextDocument(tx, "REVERSAL", new Date().getUTCFullYear());
  await tx.insert(paymentReversals).values({
    reversalNumber,
    paymentId,
    reason,
    amountCentavos: payment.amountCentavos,
    unallocatedCentavos,
    creditRestoredCentavos,
    reversedBy: actor?.id ?? null,
    reversedByName: actor?.displayName ?? null
  });

  // The receipt stays in the register and is marked void: a receipt number is
  // never reissued (§3.11).
  await tx
    .update(receipts)
    .set({ voidedAt: new Date(), voidedBy: actor?.id ?? null, voidReason: reason })
    .where(eq(receipts.paymentId, paymentId));

  // The mirror of the original credit: a debit for the full amount.
  await postLedgerEntry(tx, {
    serviceAccountId: payment.serviceAccountId,
    entryDate: new Date().toISOString().slice(0, 10),
    reference: `${payment.receiptNumber} reversed`,
    description: `${labelForMethod(payment.method)} payment reversed: ${reason}`,
    entryType: "PAYMENT_REVERSAL",
    debitCentavos: payment.amountCentavos,
    sourceType: "REVERSAL",
    sourceId: paymentId,
    actor
  });

  const { balanceCentavos } = await accountBalance(tx, payment.serviceAccountId);

  await writeAudit(tx, actor, {
    action: auditActions.PAYMENT_REVERSED,
    entityType: "payment",
    entityId: paymentId,
    reason,
    changes: {
      status: { old: payment.status, new: reversed.status },
      allocatedCentavos: { old: payment.allocatedCentavos, new: 0 }
    },
    metadata: {
      receiptNumber: payment.receiptNumber,
      reversalNumber,
      amountCentavos: payment.amountCentavos,
      creditRestoredCentavos,
      unallocatedCentavos,
      restoredInvoices
    }
  });

  return {
    paymentId,
    reversalNumber,
    receiptNumber: payment.receiptNumber,
    amountCentavos: payment.amountCentavos,
    creditRestoredCentavos,
    unallocatedCentavos,
    restoredInvoices
  };
}

// ---------------------------------------------------------------------------
// GCash (§3.5)
// ---------------------------------------------------------------------------

export interface SubmitGcashProofInput {
  serviceAccountId: string;
  referenceNumber: string;
  senderName: string;
  amountCentavos: number;
  proofNote?: string | null;
  attachmentId?: string | null;
}

export async function submitGcashProof(executor: Transaction, input: SubmitGcashProofInput, actor?: Actor) {
  if (!input.referenceNumber.trim()) {
    throw validationFailed("The GCash reference number is required.");
  }
  if (!Number.isInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    throw validationFailed("The claimed amount must be greater than zero.");
  }

  const tx = executor;
  await lockAccount(tx, input.serviceAccountId);

  // A pending proof with the same reference is a strong signal of a double
  // submission, so it is flagged for the reviewer rather than silently
  // accepted as a second, separate claim.
  const prior = await tx
    .select({ id: paymentProofs.id, status: paymentProofs.status })
    .from(paymentProofs)
    .where(
      and(
        sql`upper(${paymentProofs.referenceNumber}) = upper(${input.referenceNumber})`,
        inArray(paymentProofs.status, ["PENDING", "VERIFIED"])
      )
    )
    .limit(1);

  if (prior[0]?.status === "VERIFIED") {
    throw duplicateReference(
      `GCash reference ${input.referenceNumber} has already been verified as a payment.`
    );
  }

  const [proof] = await tx
    .insert(paymentProofs)
    .values({
      serviceAccountId: input.serviceAccountId,
      referenceNumber: input.referenceNumber.trim(),
      senderName: input.senderName.trim(),
      amountCentavos: input.amountCentavos,
      proofNote: input.proofNote ?? null,
      attachmentId: input.attachmentId ?? null,
      status: "PENDING",
      isDuplicateSuspect: prior.length > 0,
      submittedBy: actor?.id ?? null,
      submittedByName: actor?.displayName ?? null
    })
    .returning();

  await writeAudit(tx, actor, {
    action: auditActions.GCASH_PROOF_SUBMITTED,
    entityType: "payment_proof",
    entityId: proof.id,
    changes: {
      amountCentavos: { new: input.amountCentavos },
      referenceNumber: { new: input.referenceNumber }
    },
    metadata: { serviceAccountId: input.serviceAccountId, isDuplicateSuspect: proof.isDuplicateSuspect }
  });

  return proof;
}

export interface VerifyGcashProofResult {
  proofId: string;
  approved: boolean;
  status: "VERIFIED" | "REJECTED";
  payment: PostPaymentResult | null;
}

/**
 * Approves or rejects a pending GCash proof.
 *
 * A screenshot is evidence, never proof: nothing is posted to `payments` and
 * nothing enters the ledger until a reviewer with `gcash.verify` approves it.
 *
 * The approval runs on the caller's transaction, so marking the proof VERIFIED
 * and posting its payment commit together. A duplicate GCash reference therefore
 * cannot leave a proof marked verified with no payment behind it — the duplicate
 * check inside `postPayment` throws and the whole review rolls back.
 */
export async function verifyGcashProof(
  executor: Transaction,
  proofId: string,
  input: { approved: boolean; rejectionReason?: string | null; note?: string | null },
  actor?: Actor
): Promise<VerifyGcashProofResult> {
  const tx = executor;
  const rows = await tx.select().from(paymentProofs).where(eq(paymentProofs.id, proofId)).limit(1);
  const proof = rows[0];
  if (!proof) {
    throw notFound("GCash proof", proofId);
  }
  if (proof.status !== "PENDING") {
    throw conflict(`This proof has already been ${proof.status.toLowerCase()}.`);
  }

  if (!input.approved) {
    if (!input.rejectionReason || input.rejectionReason.trim().length < 3) {
      throw validationFailed("A reason is required to reject a GCash proof.");
    }
    await tx
      .update(paymentProofs)
      .set({
        status: "REJECTED",
        verifiedBy: actor?.id ?? null,
        verifiedByName: actor?.displayName ?? null,
        verifiedAt: new Date(),
        rejectionReason: input.rejectionReason.trim()
      })
      .where(eq(paymentProofs.id, proofId));

    await writeAudit(tx, actor, {
      action: auditActions.GCASH_PROOF_REJECTED,
      entityType: "payment_proof",
      entityId: proofId,
      reason: input.rejectionReason,
      changes: { status: { old: proof.status, new: "REJECTED" } }
    });

    return { proofId, approved: false, status: "REJECTED", payment: null };
  }

  // Approved: mark verified and post the payment on the same transaction.
  await tx
    .update(paymentProofs)
    .set({
      status: "VERIFIED",
      verifiedBy: actor?.id ?? null,
      verifiedByName: actor?.displayName ?? null,
      verifiedAt: new Date(),
      proofNote: input.note ?? proof.proofNote
    })
    .where(eq(paymentProofs.id, proofId));

  const payment = await postPayment(
    tx,
    {
      serviceAccountId: proof.serviceAccountId,
      amountCentavos: proof.amountCentavos,
      method: "GCASH",
      referenceNumber: proof.referenceNumber,
      notes: proof.proofNote ?? null,
      proofId: proof.id
    },
    actor
  );

  await writeAudit(tx, actor, {
    action: auditActions.GCASH_PROOF_VERIFIED,
    entityType: "payment_proof",
    entityId: proofId,
    changes: { status: { old: "PENDING", new: "VERIFIED" } },
    metadata: { paymentId: payment.paymentId, receiptNumber: payment.receiptNumber }
  });

  return { proofId, approved: true, status: "VERIFIED", payment };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface PaymentListQuery {
  serviceAccountId?: string;
  subscriberId?: string;
  method?: string;
  status?: string;
  collectorId?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export async function listPayments(executor: Executor, query: PaymentListQuery) {
  const filters = [];
  if (query.serviceAccountId) {
    filters.push(eq(payments.serviceAccountId, query.serviceAccountId));
  }
  if (query.subscriberId) {
    filters.push(eq(payments.subscriberId, query.subscriberId));
  }
  if (query.method) {
    filters.push(eq(payments.method, query.method as never));
  }
  if (query.status) {
    filters.push(eq(payments.status, query.status as never));
  }
  if (query.collectorId) {
    filters.push(eq(payments.collectorId, query.collectorId));
  }
  if (query.from) {
    filters.push(sql`${payments.paymentDate} >= ${query.from}`);
  }
  if (query.to) {
    filters.push(sql`${payments.paymentDate} < (${query.to}::date + interval '1 day')`);
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      sql`(${payments.receiptNumber} ilike ${pattern} or ${payments.referenceNumber} ilike ${pattern})`
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(payments)
    .where(where);

  const [sumRow] = await executor
    .select({
      total: sql<number>`coalesce(sum(case when ${payments.status} = 'POSTED' then ${payments.amountCentavos} else 0 end), 0)::bigint`
    })
    .from(payments)
    .where(where);

  const rows = await executor
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      paymentDate: payments.paymentDate,
      amountCentavos: payments.amountCentavos,
      allocatedCentavos: payments.allocatedCentavos,
      advanceCentavos: payments.advanceCentavos,
      method: payments.method,
      referenceNumber: payments.referenceNumber,
      status: payments.status,
      notes: payments.notes,
      postedByName: payments.postedByName,
      reversalReason: payments.reversalReason,
      serviceAccountId: payments.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber
    })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .where(where)
    .orderBy(desc(payments.paymentDate), desc(payments.receiptNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({
      ...row,
      amount: formatCentavos(row.amountCentavos),
      allocated: formatCentavos(row.allocatedCentavos),
      advance: formatCentavos(row.advanceCentavos, { blankZero: true })
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0,
    totalPostedCentavos: Number(sumRow?.total ?? 0)
  };
}

export async function getPayment(executor: Executor, paymentId: string) {
  const rows = await executor
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      paymentDate: payments.paymentDate,
      amountCentavos: payments.amountCentavos,
      allocatedCentavos: payments.allocatedCentavos,
      advanceCentavos: payments.advanceCentavos,
      creditAppliedCentavos: payments.creditAppliedCentavos,
      method: payments.method,
      referenceNumber: payments.referenceNumber,
      notes: payments.notes,
      status: payments.status,
      postedByName: payments.postedByName,
      reversalReason: payments.reversalReason,
      serviceAccountId: payments.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber
    })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .where(eq(payments.id, paymentId))
    .limit(1);

  const payment = rows[0];
  if (!payment) {
    throw notFound("Payment", paymentId);
  }

  const allocationRows = await executor
    .select({
      id: paymentAllocations.id,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      period: invoices.period,
    invoiceStatus: invoices.status,
    invoiceTotalCentavos: invoices.totalCentavos,
    invoicePaidCentavos: invoices.paidCentavos,
    invoiceBalanceCentavos: invoices.balanceCentavos,
      amountCentavos: paymentAllocations.amountCentavos,
      allocationType: paymentAllocations.allocationType
    })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .where(eq(paymentAllocations.paymentId, paymentId))
    .orderBy(invoices.dueDate, invoices.invoiceNumber);

  const receipt = await executor
    .select()
    .from(receipts)
    .where(eq(receipts.paymentId, paymentId))
    .limit(1);

  const reversal = await executor
    .select()
    .from(paymentReversals)
    .where(eq(paymentReversals.paymentId, paymentId))
    .limit(1);

  return {
    ...payment,
    allocations: allocationRows.map((row) => ({
      ...row,
      amount: formatCentavos(row.amountCentavos),
      invoiceTotal: formatCentavos(row.invoiceTotalCentavos),
      invoicePaid: formatCentavos(row.invoicePaidCentavos),
      invoiceBalance: formatCentavos(row.invoiceBalanceCentavos)
    })),
    receipt: receipt[0] ?? null,
    reversal: reversal[0] ?? null,
    totals: {
      amount: formatCentavos(payment.amountCentavos),
      allocated: formatCentavos(payment.allocatedCentavos),
      advance: formatCentavos(payment.advanceCentavos, { blankZero: true }),
      creditApplied: formatCentavos(payment.creditAppliedCentavos, { blankZero: true })
    }
  };
}

export interface ProofListQuery {
  status?: string;
  serviceAccountId?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export async function listPaymentProofs(executor: Executor, query: ProofListQuery) {
  const filters = [];
  if (query.status) {
    filters.push(eq(paymentProofs.status, query.status as never));
  }
  if (query.serviceAccountId) {
    filters.push(eq(paymentProofs.serviceAccountId, query.serviceAccountId));
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      sql`(${paymentProofs.referenceNumber} ilike ${pattern} or ${paymentProofs.senderName} ilike ${pattern})`
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(paymentProofs)
    .where(where);

  const rows = await executor
    .select({
      id: paymentProofs.id,
      referenceNumber: paymentProofs.referenceNumber,
      senderName: paymentProofs.senderName,
      amountCentavos: paymentProofs.amountCentavos,
      status: paymentProofs.status,
      submittedByName: paymentProofs.submittedByName,
      submittedAt: paymentProofs.submittedAt,
      verifiedByName: paymentProofs.verifiedByName,
      verifiedAt: paymentProofs.verifiedAt,
      rejectionReason: paymentProofs.rejectionReason,
      isDuplicateSuspect: paymentProofs.isDuplicateSuspect,
      serviceAccountId: paymentProofs.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberName: subscribers.fullName
    })
    .from(paymentProofs)
    .innerJoin(serviceAccounts, eq(paymentProofs.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(where)
    .orderBy(desc(paymentProofs.submittedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({ ...row, amount: formatCentavos(row.amountCentavos) })),
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0
  };
}
