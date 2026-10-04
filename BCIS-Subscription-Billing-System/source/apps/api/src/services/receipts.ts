import { formatCentavos } from "@bcis/shared";
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import { getDatabase, type Executor } from "../db/client.js";
import { payments, receipts, serviceAccounts, subscribers } from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { businessRule, notFound, validationFailed } from "./errors.js";
import type { Actor, Page } from "./types.js";

/**
 * The receipt register (§3.11, §4.2).
 *
 * `receipts` is the authoritative list of numbers that have ever been issued.
 * Two properties matter and both are enforced here rather than assumed:
 *
 *  - **A number is never reissued.** Voiding keeps the row and only stamps
 *    `voidedAt`/`voidReason`. The row is never deleted, so the gap-free sequence
 *    in `document_sequences` and the unique index both stay truthful: a number
 *    that has been used once is used forever, including if it was voided.
 *  - **A void is a document action, not a financial one.** Voiding a receipt
 *    says "this piece of paper is not valid evidence"; it does not un-post the
 *    money. If the payment itself is wrong, the payment has to be *reversed*,
 *    which is a separate, separately-audited operation that moves the ledger.
 *    Confusing the two is how a ledger and its paperwork drift apart, so this
 *    module refuses to void a receipt whose payment has already been reversed -
 *    that receipt was voided as part of the reversal and re-voiding it would
 *    overwrite the reversal's reason with an unrelated one.
 *
 * The receipt number is the customer-facing identifier, so it is the natural key
 * for lookups; the internal `id` is accepted too because the UI holds both.
 */

export interface ReceiptListQuery {
  page?: number;
  pageSize?: number;
  /** Free text over the receipt number, reference number and subscriber name. */
  q?: string;
  subscriberId?: string;
  serviceAccountId?: string;
  method?: string;
  /** `true` for voided only, `false` for live only, omitted for both. */
  voided?: boolean;
  from?: string;
  to?: string;
}

export interface ReceiptRow {
  id: string;
  receiptNumber: string;
  paymentId: string;
  issuedAt: Date;
  issuedByName: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  amountCentavos: number;
  amount: string;
  paymentStatus: string;
  method: string;
  paymentDate: Date;
  referenceNumber: string | null;
  accountNumber: string | null;
  serviceAccountNumber: string | null;
  subscriberName: string | null;
}

export async function listReceipts(executor: Executor, query: ReceiptListQuery = {}): Promise<Page<ReceiptRow> & { totals: { count: number; amount: string } }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));

  const filters: SQL[] = [];
  if (query.subscriberId) {
    filters.push(eq(payments.subscriberId, query.subscriberId));
  }
  if (query.serviceAccountId) {
    filters.push(eq(payments.serviceAccountId, query.serviceAccountId));
  }
  if (query.method) {
    filters.push(eq(payments.method, query.method as never));
  }
  if (query.voided === true) {
    filters.push(isNotNull(receipts.voidedAt));
  } else if (query.voided === false) {
    filters.push(isNull(receipts.voidedAt));
  }
  if (query.from) {
    filters.push(sql`${receipts.issuedAt} >= ${query.from}::date`);
  }
  if (query.to) {
    // Inclusive of the whole `to` day, which a bare `<=` would truncate at midnight.
    filters.push(sql`${receipts.issuedAt} < (${query.to}::date + interval '1 day')`);
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      sql`(${receipts.receiptNumber} ilike ${pattern}
            or ${payments.referenceNumber} ilike ${pattern}
            or ${subscribers.fullName} ilike ${pattern}
            or ${subscribers.accountNumber} ilike ${pattern})`
    );
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(receipts)
    .innerJoin(payments, eq(receipts.paymentId, payments.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .where(where);

  // Voided receipts are excluded from the total: a printed total that silently
  // included voided documents would overstate collections, which is the one
  // number on this screen nobody cross-checks.
  const [sumRow] = await executor
    .select({
      total: sql<number>`coalesce(sum(case when ${receipts.voidedAt} is null then ${payments.amountCentavos} else 0 end), 0)::bigint`
    })
    .from(receipts)
    .innerJoin(payments, eq(receipts.paymentId, payments.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .where(where);

  const rows = await executor
    .select({
      id: receipts.id,
      receiptNumber: receipts.receiptNumber,
      paymentId: receipts.paymentId,
      issuedAt: receipts.issuedAt,
      issuedByName: receipts.issuedByName,
      voidedAt: receipts.voidedAt,
      voidReason: receipts.voidReason,
      amountCentavos: payments.amountCentavos,
      paymentStatus: payments.status,
      method: payments.method,
      paymentDate: payments.paymentDate,
      referenceNumber: payments.referenceNumber,
      accountNumber: subscribers.accountNumber,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberName: subscribers.fullName
    })
    .from(receipts)
    .innerJoin(payments, eq(receipts.paymentId, payments.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .leftJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .where(where)
    // Newest first, but by issue date rather than void date, so the register
    // reads in the same order the numbers were handed out.
    .orderBy(desc(receipts.issuedAt), desc(receipts.receiptNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const total = Number(totalRow?.value ?? 0);
  const amountCentavos = Number(sumRow?.total ?? 0);

  return {
    items: rows.map((row) => ({
      ...row,
      amount: formatCentavos(row.amountCentavos)
    })),
    page,
    pageSize,
    total,
    totals: { count: total, amount: formatCentavos(amountCentavos) }
  };
}

const receiptColumns = {
  id: receipts.id,
  receiptNumber: receipts.receiptNumber,
  paymentId: receipts.paymentId,
  issuedAt: receipts.issuedAt,
  issuedByName: receipts.issuedByName,
  voidedAt: receipts.voidedAt,
  voidReason: receipts.voidReason,
  amountCentavos: payments.amountCentavos,
  paymentStatus: payments.status,
  method: payments.method,
  paymentDate: payments.paymentDate,
  referenceNumber: payments.referenceNumber,
  accountNumber: subscribers.accountNumber,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberName: subscribers.fullName
};

/** Looks a receipt up by its customer-facing number, or by internal id. */
export async function getReceipt(executor: Executor, key: string): Promise<ReceiptRow> {
  const [row] = await executor
    .select(receiptColumns)
    .from(receipts)
    .innerJoin(payments, eq(receipts.paymentId, payments.id))
    .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
    .leftJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .where(
      // Case-insensitive because these numbers get read aloud and retyped, and
      // because the unique index is on `upper(receipt_number)`.
      sql`(${receipts.receiptNumber} = ${key} or upper(${receipts.receiptNumber}) = upper(${key}) or ${receipts.id} = ${key}::uuid)`
    )
    .limit(1);

  if (!row) {
    throw notFound("Receipt", key);
  }
  return { ...row, amount: formatCentavos(row.amountCentavos) };
}

export interface VoidReceiptResult {
  receipt: ReceiptRow;
  /** True when this call was the one that voided it. */
  voided: boolean;
}

/**
 * Voids a receipt.
 *
 * The row is kept, so the number is never handed out again. The operation is
 * idempotent in the sense that voiding an already-voided receipt is reported as
 * `voided: false` rather than overwriting the original reason - the first reason
 * given is the one that explains why the document is invalid, and a later
 * correction must not erase it.
 */
export async function voidReceipt(
  key: string,
  input: { reason: string },
  actor?: Actor
): Promise<VoidReceiptResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5) {
    throw validationFailed("A void reason of at least 5 characters is required.");
  }

  const { db } = getDatabase();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: receipts.id,
        receiptNumber: receipts.receiptNumber,
        voidedAt: receipts.voidedAt,
        voidReason: receipts.voidReason,
        paymentStatus: payments.status,
        reversalReason: payments.reversalReason
      })
      .from(receipts)
      .innerJoin(payments, eq(receipts.paymentId, payments.id))
      .where(sql`(${receipts.receiptNumber} = ${key} or upper(${receipts.receiptNumber}) = upper(${key}) or ${receipts.id} = ${key}::uuid)`)
      .limit(1);

    if (!existing) {
      throw notFound("Receipt", key);
    }

    // Already void: report success without touching the stored reason.
    if (existing.voidedAt) {
      const receipt = await getReceipt(tx, existing.id);
      return { receipt, voided: false };
    }

    if (existing.paymentStatus === "REVERSED") {
      throw businessRule(
        `Receipt ${existing.receiptNumber} belongs to a reversed payment. Reverse the payment instead of voiding the receipt.`
      );
    }

    const [updated] = await tx
      .update(receipts)
      .set({
        voidedAt: new Date(),
        voidedBy: actor?.id ?? null,
        voidReason: reason
      })
      .where(eq(receipts.id, existing.id))
      .returning();

    await writeAudit(tx, actor, {
      action: auditActions.RECEIPT_VOIDED,
      entityType: "receipt",
      entityId: existing.receiptNumber,
      reason,
      changes: { voidedAt: { old: null, new: updated.voidedAt } },
      metadata: {
        receiptId: existing.id,
        paymentId: updated.paymentId,
        // The payment is deliberately untouched: voiding a document must not
        // move money, or the ledger would stop agreeing with the receipts.
        paymentStatus: existing.paymentStatus,
        paymentUnchanged: true
      }
    });

    return { receipt: await getReceipt(tx, existing.id), voided: true };
  });
}
