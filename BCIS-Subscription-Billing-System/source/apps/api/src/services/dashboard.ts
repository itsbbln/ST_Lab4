import { sql, type SQL } from "drizzle-orm";

import { formatCentavos } from "@bcis/shared";

import { getDatabase, type Executor } from "../db/client.js";
import { actorCan, type Actor } from "./types.js";

/**
 * The management dashboard (§4.1, AT-07).
 *
 * Every figure here is a count or a sum over the *financial* tables, computed in
 * SQL rather than by loading rows into Node and adding them up. That is not a
 * performance preference: a PHP float accumulating twenty thousand
 * `amount_centavos` values will drift, and the dashboard is the screen the owner
 * uses to decide whether the business is healthy. `sum()` over a `bigint` column
 * in PostgreSQL is exact.
 *
 * Three conventions are applied consistently so these numbers can be compared
 * with the reports and the ledger:
 *
 *  - **Voided documents are excluded everywhere.** A voided invoice is not a
 *    receivable and a reversed payment is not a collection, so both are filtered
 *    out of the totals rather than netted off at the end.
 *  - **Receivables are read from `invoices.balance_centavos`**, the balance the
 *    billing service maintains inside the same transaction that allocates a
 *    payment. Re-deriving it here from allocations would duplicate that logic
 *    and could disagree with the ledger on exactly the rows that matter.
 *  - **A payment counts once, at its own date.** `collections` reads
 *    `payment_date`, not `created_at`, so a receipt entered on the 1st for a
 *    payment made on the 31st lands on the day the money moved.
 *
 * Note that *subscribers* are never suspended - suspension is a property of a
 * service account (§4.2). The subscriber figures therefore report `INACTIVE`
 * separately, and a naive `status = 'SUSPENDED'` filter on `subscribers` would
 * always return zero.
 */

/** Invoice statuses that can still carry a balance. */
const OUTSTANDING = "('DRAFT','UNPAID','PARTIALLY_PAID','OVERDUE')";

/** Service accounts that are still expected to pay. */
const LIVE_ACCOUNTS = "('PENDING_ACTIVATION','ACTIVE','SUSPENDED')";

export interface DashboardQuery {
  /** Inclusive ISO date (YYYY-MM-DD), defaults to today. */
  from?: string;
  /** Inclusive ISO date (YYYY-MM-DD), defaults to today. */
  to?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: string, field: string): string {
  const date = value.trim();
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw Object.assign(new Error(`"${field}" must be a calendar date in YYYY-MM-DD form.`), {
      statusCode: 400,
      name: "ValidationError"
    });
  }
  return date;
}

/** Resolves the reporting window once, so every figure uses identical bounds. */
function resolveWindow(query: DashboardQuery): { from: string; to: string; days: number } {
  const today = new Date().toISOString().slice(0, 10);
  const to = query.to ? isoDate(query.to, "to") : today;
  const from = query.from ? isoDate(query.from, "from") : to;
  if (from > to) {
    throw Object.assign(new Error("The start of the reporting period must not be after its end."), {
      statusCode: 400,
      name: "ValidationError"
    });
  }
  const days =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { from, to, days };
}

/**
 * Runs an aggregate and returns its first row.
 *
 * `executor.execute` hands back a `pg` QueryResult, which is not iterable, so
 * without this every figure below would be destructured as if it were a tuple.
 * The alternative - selecting through the query builder - means losing `sum()`
 * and `filter (where ...)` over `bigint`, which is the whole reason for doing
 * this in SQL.
 */
async function firstRow<T>(executor: Executor, query: SQL): Promise<T | undefined> {
  const result = await executor.execute(query);
  return result.rows[0] as T | undefined;
}

export interface DashboardSummary {
  generatedAt: string;
  period: { from: string; to: string; days: number };

  subscribers: {
    total: number;
    active: number;
    inactive: number;
    newInPeriod: number;
  };

  accounts: {
    total: number;
    pendingActivation: number;
    active: number;
    suspended: number;
    disconnected: number;
    terminated: number;
  };

  receivables: {
    /** Billed, not yet due, and still expected to be paid. */
    currentCentavos: number;
    current: string;
    /** Billed and past its due date. */
    overdueCentavos: number;
    overdue: string;
    /** `current + overdue`: the whole amount owed. */
    totalOutstandingCentavos: number;
    totalOutstanding: string;
    overdueAccounts: number;
    /** Share of what has already fallen due that has been collected, 0-100. */
    collectionRate: number;
  };

  collections: {
    receivedCentavos: number;
    received: string;
    paymentsInPeriod: number;
    /** Mean posted payment in the period, formatted. */
    averagePayment: string;
    byMethod: Array<{ method: string; count: number; amountCentavos: number; amount: string }>;
  };

  gcash: {
    pending: number;
    verifiedInPeriod: number;
    rejectedInPeriod: number;
  };

  billing: {
    issuedInPeriod: number;
    paidInPeriod: number;
    voidedInPeriod: number;
    outstandingInvoices: number;
  };

  collectionBatches: {
    open: number;
    inProgress: number;
    submitted: number;
    remitted: number;
    reconciled: number;
    uncollectedCentavos: number;
    uncollected: string;
  };

  /** Only present when the caller is allowed to see receivables. */
  topOverdue?: Array<{
    accountNumber: string;
    subscriberName: string;
    amountCentavos: number;
    amount: string;
    daysOverdue: number;
  }>;
}

export async function buildDashboard(
  executor: Executor,
  query: DashboardQuery = {},
  actor?: Actor
): Promise<DashboardSummary> {
  const { from, to, days } = resolveWindow(query);

  // --- Subscribers and service accounts -----------------------------------
  const subscriberRow = await firstRow<{
    total: number;
    active: number;
    inactive: number;
    new_in_period: number;
  }>(executor, sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'ACTIVE')::int as active,
      count(*) filter (where status in ('INACTIVE', 'TERMINATED'))::int as inactive,
      count(*) filter (
        where created_at >= ${from}::date and created_at < (${to}::date + interval '1 day')
      )::int as new_in_period
    from subscribers
  `);

  const accountRow = await firstRow<{
    total: number;
    pending: number;
    active: number;
    suspended: number;
    disconnected: number;
    terminated: number;
  }>(executor, sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'PENDING_ACTIVATION')::int as pending,
      count(*) filter (where status = 'ACTIVE')::int as active,
      count(*) filter (where status = 'SUSPENDED')::int as suspended,
      count(*) filter (where status = 'DISCONNECTED')::int as disconnected,
      count(*) filter (where status = 'TERMINATED')::int as terminated
    from service_accounts
  `);

  // --- Receivables ---------------------------------------------------------
  //
  // One query, so that `totalOutstanding = current + overdue` holds by
  // construction rather than by three aggregates happening to agree.
  //
  // The split matches `receivablesSummary` exactly: **current** is what has been
  // billed but has not yet fallen due, **overdue** is what is past its due date.
  // Reading "current" as "everything still owed" would double-count every peso
  // once a subscriber was late, which is precisely the figure the owner compares
  // against the aging report.
  const receivableRow = await firstRow<{
    current_centavos: number;
    overdue_centavos: number;
    total_outstanding_centavos: number;
    overdue_accounts: number;
  }>(executor, sql`
    select
      coalesce(sum(i.balance_centavos) filter (where i.due_date >= ${to}::date), 0)::bigint as current_centavos,
      coalesce(sum(i.balance_centavos) filter (where i.due_date < ${to}::date), 0)::bigint as overdue_centavos,
      coalesce(sum(i.balance_centavos), 0)::bigint as total_outstanding_centavos,
      count(distinct i.service_account_id) filter (where i.due_date < ${to}::date)::int as overdue_accounts
    from invoices i
    join service_accounts sa on sa.id = i.service_account_id
    where i.status in ${sql.raw(OUTSTANDING)}
      and sa.status in ${sql.raw(LIVE_ACCOUNTS)}
      and i.balance_centavos > 0
  `);

  // Collection rate: share of what has already fallen due that has been settled
  // by a posted payment. Capped at 100 so an overpayment on an early invoice
  // cannot push the reported rate above the whole.
  const rateRow = await firstRow<{ rate: number }>(executor, sql`
    with due as (
      select coalesce(sum(total_centavos), 0)::bigint as amount
      from invoices
      where status not in ('VOID', 'PAID', 'CREDITED')
        and due_date < ${to}::date
    ),
    settled as (
      select coalesce(sum(pa.amount_centavos), 0)::bigint as amount
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where p.status = 'POSTED'
        and p.payment_date < (${to}::date + interval '1 day')
    )
    select
      case
        when due.amount = 0 then 0
        else round(least(settled.amount::numeric / due.amount::numeric, 1) * 100, 1)
      end as rate
    from due, settled
  `);

  // --- Collections in the period ------------------------------------------
  const collectionRow = await firstRow<{ received: number; payment_count: number }>(executor, sql`
    select
      coalesce(sum(amount_centavos), 0)::bigint as received,
      count(*)::int as payment_count
    from payments
    where status = 'POSTED'
      and payment_date >= ${from}::date
      and payment_date < (${to}::date + interval '1 day')
  `);

  const methodResult = await executor.execute(sql`
    select
      method,
      count(*)::int as count,
      coalesce(sum(amount_centavos), 0)::bigint as amount
    from payments
    where status = 'POSTED'
      and payment_date >= ${from}::date
      and payment_date < (${to}::date + interval '1 day')
    group by method
    order by sum(amount_centavos) desc, method
  `);

  // --- GCash queue ---------------------------------------------------------
  const gcashRow = await firstRow<{ pending: number; verified: number; rejected: number }>(
    executor,
    sql`
      select
        count(*) filter (where status = 'PENDING')::int as pending,
        count(*) filter (
          where status = 'VERIFIED'
            and verified_at >= ${from}::date
            and verified_at < (${to}::date + interval '1 day')
        )::int as verified,
        count(*) filter (
          where status = 'REJECTED'
            and verified_at >= ${from}::date
            and verified_at < (${to}::date + interval '1 day')
        )::int as rejected
      from payment_proofs
    `
  );

  // --- Billing in the period ----------------------------------------------
  const billingRow = await firstRow<{
    issued: number;
    paid: number;
    voided: number;
    outstanding: number;
  }>(executor, sql`
    select
      count(*) filter (where status <> 'VOID')::int as issued,
      count(*) filter (where status = 'PAID')::int as paid,
      count(*) filter (where status = 'VOID')::int as voided,
      (
        select count(*)::int from invoices
        where status in ('UNPAID', 'PARTIALLY_PAID', 'OVERDUE')
      ) as outstanding
    from invoices
    where issue_date >= ${from}::date
      and issue_date < (${to}::date + interval '1 day')
  `);

  // --- Collector batches ---------------------------------------------------
  const batchRow = await firstRow<{
    open: number;
    in_progress: number;
    submitted: number;
    remitted: number;
    reconciled: number;
    uncollected: number;
  }>(executor, sql`
    select
      count(*) filter (where status = 'OPEN')::int as open,
      count(*) filter (where status = 'IN_PROGRESS')::int as in_progress,
      count(*) filter (where status = 'SUBMITTED')::int as submitted,
      count(*) filter (where status = 'REMITTED')::int as remitted,
      count(*) filter (where status in ('RECONCILED', 'CLOSED'))::int as reconciled,
      coalesce(sum(uncollected_centavos) filter (where status not in ('RECONCILED', 'CLOSED')), 0)::bigint as uncollected
    from collection_batches
  `);

  const receivedCentavos = Number(collectionRow?.received ?? 0);
  const paymentCount = Number(collectionRow?.payment_count ?? 0);
  const currentCentavos = Number(receivableRow?.current_centavos ?? 0);
  const overdueCentavos = Number(receivableRow?.overdue_centavos ?? 0);
  const totalOutstandingCentavos = Number(receivableRow?.total_outstanding_centavos ?? 0);
  const uncollectedCentavos = Number(batchRow?.uncollected ?? 0);

  const summary: DashboardSummary = {
    generatedAt: new Date().toISOString(),
    period: { from, to, days },

    subscribers: {
      total: Number(subscriberRow?.total ?? 0),
      active: Number(subscriberRow?.active ?? 0),
      inactive: Number(subscriberRow?.inactive ?? 0),
      newInPeriod: Number(subscriberRow?.new_in_period ?? 0)
    },

    accounts: {
      total: Number(accountRow?.total ?? 0),
      pendingActivation: Number(accountRow?.pending ?? 0),
      active: Number(accountRow?.active ?? 0),
      suspended: Number(accountRow?.suspended ?? 0),
      disconnected: Number(accountRow?.disconnected ?? 0),
      terminated: Number(accountRow?.terminated ?? 0)
    },

    receivables: {
      currentCentavos,
      current: formatCentavos(currentCentavos),
      overdueCentavos,
      overdue: formatCentavos(overdueCentavos),
      totalOutstandingCentavos,
      totalOutstanding: formatCentavos(totalOutstandingCentavos),
      overdueAccounts: Number(receivableRow?.overdue_accounts ?? 0),
      collectionRate: Number(rateRow?.rate ?? 0)
    },

    collections: {
      receivedCentavos,
      received: formatCentavos(receivedCentavos),
      paymentsInPeriod: paymentCount,
      averagePayment:
        paymentCount === 0 ? formatCentavos(0) : formatCentavos(Math.round(receivedCentavos / paymentCount)),
      byMethod: (
        methodResult.rows as Array<{ method: string; count: number; amount: number | string }>
      ).map((row) => {
        const amountCentavos = Number(row.amount ?? 0);
        return {
          method: row.method,
          count: Number(row.count),
          amountCentavos,
          amount: formatCentavos(amountCentavos)
        };
      })
    },

    gcash: {
      pending: Number(gcashRow?.pending ?? 0),
      verifiedInPeriod: Number(gcashRow?.verified ?? 0),
      rejectedInPeriod: Number(gcashRow?.rejected ?? 0)
    },

    billing: {
      issuedInPeriod: Number(billingRow?.issued ?? 0),
      paidInPeriod: Number(billingRow?.paid ?? 0),
      voidedInPeriod: Number(billingRow?.voided ?? 0),
      outstandingInvoices: Number(billingRow?.outstanding ?? 0)
    },

    collectionBatches: {
      open: Number(batchRow?.open ?? 0),
      inProgress: Number(batchRow?.in_progress ?? 0),
      submitted: Number(batchRow?.submitted ?? 0),
      remitted: Number(batchRow?.remitted ?? 0),
      reconciled: Number(batchRow?.reconciled ?? 0),
      uncollectedCentavos,
      uncollected: formatCentavos(uncollectedCentavos)
    }
  };

  // --- The arrears table is only shown to people who may see receivables ----
  if (actorCan(actor, "receivables.view")) {
    const result = await executor.execute(sql`
      select
        sa.service_account_number as "accountNumber",
        s.full_name as "subscriberName",
        i.balance_centavos as "amountCentavos",
        (${to}::date - i.due_date) as "daysOverdue"
      from invoices i
      join service_accounts sa on sa.id = i.service_account_id
      join subscribers s on s.id = sa.subscriber_id
      where i.status in ${sql.raw(OUTSTANDING)}
        and sa.status in ${sql.raw(LIVE_ACCOUNTS)}
        and i.balance_centavos > 0
        and i.due_date < ${to}::date
      order by i.balance_centavos desc, i.due_date
      limit 10
    `);

    summary.topOverdue = (
      result.rows as Array<{
        accountNumber: string;
        subscriberName: string;
        amountCentavos: number | string;
        daysOverdue: number | string;
      }>
    ).map((row) => {
      const amountCentavos = Number(row.amountCentavos);
      return {
        accountNumber: row.accountNumber,
        subscriberName: row.subscriberName,
        amountCentavos,
        amount: formatCentavos(amountCentavos),
        daysOverdue: Number(row.daysOverdue)
      };
    });
  }

  return summary;
}

/** Convenience wrapper for the route. */
export async function getDashboard(query: DashboardQuery = {}, actor?: Actor): Promise<DashboardSummary> {
  return buildDashboard(getDatabase().db, query, actor);
}
