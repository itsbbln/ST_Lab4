import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { formatCentavos, sum as sumCentavos } from "@bcis/shared";

import { queryRow, queryRows, type Executor } from "../db/client.js";
import { ledgerEntries } from "../db/schema/index.js";
import type { Actor } from "./types.js";

/**
 * The subscriber ledger (§3.5).
 *
 * ## The invariant this module exists to protect
 *
 * ```
 * ledger balance  =  SUM(invoice totals)  -  SUM(posted payments)
 * ```
 *
 * Every invoice that is finalized writes exactly one DEBIT for its total, and
 * every payment that is posted writes exactly one CREDIT for its full amount.
 * A reversal writes a DEBIT for the same amount it originally credited. Because
 * the running balance is *recomputed* from the entry history with a SQL window
 * function rather than stored, it can never drift away from the postings that
 * produced it, which is how "obviously incorrect ledger balances" is avoided.
 *
 * Allocation is deliberately *not* represented in the ledger. Allocating a
 * payment to a specific invoice changes no cash position, so it would create a
 * balancing pair of entries with no economic meaning. Per-invoice balances live
 * on `invoices.balance_centavos`, maintained by the payment service.
 *
 * A negative balance is meaningful: it is money the subscriber has already paid
 * that has not yet been matched to an invoice, i.e. an advance on account.
 */

export type LedgerSourceType =
  | "INVOICE"
  | "PAYMENT"
  | "REVERSAL"
  | "ADJUSTMENT"
  | "OPENING"
  | "RECONNECTION_FEE";

export interface LedgerPosting {
  serviceAccountId: string;
  entryDate: string;
  reference: string;
  description: string;
  entryType: string;
  /** Positive amount that increases what the subscriber owes. */
  debitCentavos?: number;
  /** Positive amount that reduces what the subscriber owes. */
  creditCentavos?: number;
  sourceType: LedgerSourceType;
  sourceId: string;
  actor?: Actor;
}

/**
 * Appends one immutable ledger posting.
 *
 * Callers must pass exactly one of `debitCentavos` / `creditCentavos`, and it
 * must be greater than zero: a zero-value or ambiguous entry would make the
 * running balance ambiguous and is rejected here rather than silently stored.
 */
export async function postLedgerEntry(executor: Executor, posting: LedgerPosting): Promise<void> {
  const debit = posting.debitCentavos ?? 0;
  const credit = posting.creditCentavos ?? 0;

  if (debit < 0 || credit < 0) {
    throw new Error("Ledger amounts must be positive; use the opposite side instead.");
  }
  if (debit === 0 && credit === 0) {
    throw new Error("A ledger entry must carry a debit or a credit.");
  }
  if (debit !== 0 && credit !== 0) {
    throw new Error("A ledger entry must be a single-sided posting, not a compound one.");
  }

  await executor.insert(ledgerEntries).values({
    serviceAccountId: posting.serviceAccountId,
    entryDate: posting.entryDate,
    reference: posting.reference,
    description: posting.description,
    entryType: posting.entryType,
    debitCentavos: debit,
    creditCentavos: credit,
    sourceType: posting.sourceType,
    sourceId: posting.sourceId,
    createdBy: posting.actor?.id ?? null,
    createdByName: posting.actor?.displayName ?? null
  });
}

/** Convenience wrapper for the two-sided "finalized invoice" debit. */
export async function postInvoiceDebit(
  executor: Executor,
  input: {
    serviceAccountId: string;
    invoiceNumber: string;
    period: string;
    totalCentavos: number;
    invoiceId: string;
    issueDate: string;
  },
  actor?: Actor
): Promise<void> {
  await postLedgerEntry(executor, {
    serviceAccountId: input.serviceAccountId,
    entryDate: input.issueDate,
    reference: input.invoiceNumber,
    description: `${input.period} subscription invoice`,
    entryType: "INVOICE",
    debitCentavos: input.totalCentavos,
    sourceType: "INVOICE",
    sourceId: input.invoiceId,
    actor
  });
}

/** Convenience wrapper for a posted payment credit. */
export async function postPaymentCredit(
  executor: Executor,
  input: {
    serviceAccountId: string;
    receiptNumber: string;
    amountCentavos: number;
    paymentId: string;
    method: string;
    paymentDate: string;
  },
  actor?: Actor
): Promise<void> {
  await postLedgerEntry(executor, {
    serviceAccountId: input.serviceAccountId,
    entryDate: input.paymentDate,
    reference: input.receiptNumber,
    description: `${labelForMethod(input.method)} payment received`,
    entryType: "PAYMENT",
    creditCentavos: input.amountCentavos,
    sourceType: "PAYMENT",
    sourceId: input.paymentId,
    actor
  });
}

export function labelForMethod(method: string): string {
  switch (method) {
    case "GCASH":
      return "GCash";
    case "BANK_TRANSFER":
      return "Bank transfer";
    case "CHEQUE":
      return "Cheque";
    default:
      return "Cash";
  }
}

export interface LedgerQuery {
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface LedgerRow {
  id: string;
  entryDate: string;
  postingDate: Date;
  reference: string;
  description: string;
  entryType: string;
  debitCentavos: number;
  creditCentavos: number;
  balanceCentavos: number;
  sourceType: string;
  sourceId: string;
}

export interface LedgerResult {
  items: LedgerRow[];
  page: number;
  pageSize: number;
  total: number;
  /** Sum of debits less credits across the whole account, ignoring date filters. */
  balanceCentavos: number;
  openingBalanceCentavos: number;
  closingBalanceCentavos: number;
}

/**
 * Returns the chronological ledger for a service account with a reproducible
 * running balance.
 *
 * The running balance is a window sum inside PostgreSQL:
 * `SUM(debit - credit) OVER (ORDER BY entry_date, posting_date, id)`. The
 * ordering key ends in the primary key so two entries sharing a date and
 * timestamp always order deterministically, which is what makes the balance
 * reproducible rather than dependent on the storage engine.
 *
 * The window is seeded with the opening balance. This matters: a plain
 * `SUM(...) OVER (...)` is evaluated *after* `WHERE`, so without the seed the
 * first row of a date-filtered report would show the balance of that range
 * only, and a statement over March would not agree with the account balance
 * that February left behind.
 *
 * `openingBalanceCentavos` is the balance carried in from before `from`, and
 * `closingBalanceCentavos` is the balance at the end of the range — the sum
 * covers every row in the range, not just the page being returned, so paging
 * through a statement never changes the closing figure.
 */
export async function listLedger(
  executor: Executor,
  serviceAccountId: string,
  query: LedgerQuery
): Promise<LedgerResult> {
  // PostgreSQL `date` bottoms out at 4713 BC, and its proleptic Gregorian
  // calendar has no year zero, so "0000-01-01" is rejected outright with
  // `date/time field value out of range`. 0001-01-01 is the earliest date this
  // system will ever post to, so it is the correct open-ended lower bound.
  const from = query.from ?? "0001-01-01";
  const to = query.to ?? "9999-12-31";

  const [totalRow] = await executor
    .select({ value: count() })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, serviceAccountId),
        gte(ledgerEntries.entryDate, from),
        lte(ledgerEntries.entryDate, to)
      )
    );

  const balanceRow = await queryRow<{ balance: number }>(
    executor,
    sql`
      select coalesce(sum(debit_centavos - credit_centavos), 0)::bigint as balance
      from ledger_entries
      where service_account_id = ${serviceAccountId}
    `
  );

  const openingRow = await queryRow<{ balance: number }>(
    executor,
    sql`
      select coalesce(sum(debit_centavos - credit_centavos), 0)::bigint as balance
      from ledger_entries
      where service_account_id = ${serviceAccountId} and entry_date < ${from}
    `
  );

  const closingRow = await queryRow<{ balance: number }>(
    executor,
    sql`
      select coalesce(sum(debit_centavos - credit_centavos), 0)::bigint as balance
      from ledger_entries
      where service_account_id = ${serviceAccountId}
        and entry_date >= ${from} and entry_date <= ${to}
    `
  );

  const rows = await queryRows<LedgerSqlRow>(
    executor,
    sql`
    with opening as (
      select coalesce(sum(debit_centavos - credit_centavos), 0)::bigint as balance
      from ledger_entries
      where service_account_id = ${serviceAccountId} and entry_date < ${from}
    ),
    movements as (
      select id, entry_date, posting_date, reference, description, entry_type,
             debit_centavos, credit_centavos, source_type, source_id
      from ledger_entries
      where service_account_id = ${serviceAccountId}
        and entry_date >= ${from}
        and entry_date <= ${to}
    )
    select m.id, m.entry_date, m.posting_date, m.reference, m.description, m.entry_type,
           m.debit_centavos, m.credit_centavos, m.source_type, m.source_id,
           (o.balance + sum(m.debit_centavos - m.credit_centavos) over (
              order by m.entry_date asc, m.posting_date asc, m.id asc
            ))::bigint as balance_centavos
    from movements m cross join opening o
    order by m.entry_date asc, m.posting_date asc, m.id asc
    limit ${query.pageSize}
    offset ${(query.page - 1) * query.pageSize}
  `
  );

  return {
    items: rows.map((row) => ({
      id: String(row.id),
      entryDate: String(row.entry_date).slice(0, 10),
      postingDate: new Date(String(row.posting_date)),
      reference: String(row.reference),
      description: String(row.description),
      entryType: String(row.entry_type),
      debitCentavos: Number(row.debit_centavos ?? 0),
      creditCentavos: Number(row.credit_centavos ?? 0),
      balanceCentavos: Number(row.balance_centavos ?? 0),
      sourceType: String(row.source_type),
      sourceId: String(row.source_id)
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(totalRow?.value ?? 0),
    balanceCentavos: Number(balanceRow?.balance ?? 0),
    openingBalanceCentavos: Number(openingRow?.balance ?? 0),
    closingBalanceCentavos: Number(openingRow?.balance ?? 0) + Number(closingRow?.balance ?? 0)
  };
}

/** Live balance for an account, used by the cashier payment screen. */
export async function accountBalance(
  executor: Executor,
  serviceAccountId: string
): Promise<{ balanceCentavos: number }> {
  const row = await queryRow<{ balance: number }>(
    executor,
    sql`
      select coalesce(sum(debit_centavos - credit_centavos), 0)::bigint as balance
      from ledger_entries
      where service_account_id = ${serviceAccountId}
    `
  );
  return { balanceCentavos: Number(row?.balance ?? 0) };
}

/**
 * Statement of Account for a date range (§3.5).
 *
 * Returns the opening balance, every movement in range, and the closing
 * balance, so the statement can be printed on its own without the client needing
 * any other data.
 */
export async function statementOfAccount(
  executor: Executor,
  serviceAccountId: string,
  input: {
    from: string;
    to: string;
    accountLabel: string;
    subscriberName: string;
    accountNumber: string;
    installationAddress: string;
  }
) {
  const ledger = await listLedger(executor, serviceAccountId, {
    from: input.from,
    to: input.to,
    page: 1,
    pageSize: 500
  });

  const totalDebit = sumCentavos(ledger.items.map((row) => row.debitCentavos));
  const totalCredit = sumCentavos(ledger.items.map((row) => row.creditCentavos));

  return {
    ...input,
    rows: ledger.items.map((row) => ({
      ...row,
      debit: formatCentavos(row.debitCentavos, { blankZero: true }),
      credit: formatCentavos(row.creditCentavos, { blankZero: true }),
      balance: formatCentavos(row.balanceCentavos)
    })),
    totalDebitCentavos: totalDebit,
    totalCreditCentavos: totalCredit,
    openingBalanceCentavos: ledger.openingBalanceCentavos,
    closingBalanceCentavos: ledger.closingBalanceCentavos,
    totals: {
      totalDebit: formatCentavos(totalDebit),
      totalCredit: formatCentavos(totalCredit),
      openingBalance: formatCentavos(ledger.openingBalanceCentavos),
      closingBalance: formatCentavos(ledger.closingBalanceCentavos)
    }
  };
}

/** Newest ledger activity across all accounts, for the dashboard feed. */
export async function recentLedgerActivity(executor: Executor, limit = 20) {
  return executor
    .select()
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.postingDate), desc(ledgerEntries.id))
    .limit(limit);
}

/** One row as the running-balance query returns it, before mapping to cents. */
interface LedgerSqlRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  posting_date: string;
  reference: string;
  description: string;
  entry_type: string;
  debit_centavos: number;
  credit_centavos: number;
  source_type: string;
  source_id: string;
  balance_centavos: number;
}
