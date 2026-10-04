import { sql, type SQL } from "drizzle-orm";

import { queryRow, queryRows, type Executor } from "../db/client.js";
import { getSettings } from "./settings.js";

/**
 * Receivables and overdue monitoring (A3.9).
 *
 * Every figure here is derived from one source of truth: the stored
 * `invoices.balance_centavos` of invoices that are still collectable. Nothing
 * recomputes a subscriber's arrears from payment history, so the dashboard, the
 * aging report, the follow-up list and the collection route sheet can never
 * disagree with each other or with the account ledger.
 *
 * Two independent thresholds, deliberately not conflated:
 *
 * - The aging buckets are *purely* a function of days past the invoice due date
 *   (Current, 1-30, 31-60, 61-90, 90+). The dashboard's overdue total is the sum
 *   of the four overdue buckets, so the headline figure is always explainable as
 *   "the buckets add up".
 * - The configurable grace period and suspension threshold (A3.10) decide when
 *   an account becomes *actionable*: it appears on the follow-up list and becomes
 *   a suspension candidate only once its oldest unpaid invoice is past the grace
 *   period. This keeps "how old is the money" (an accounting question) separate
 *   from "should we act on this account" (a collections policy question).
 */

export type AgingBucket = "CURRENT" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";

export const agingBucketLabels: Record<AgingBucket, string> = {
  CURRENT: "Current",
  D1_30: "1-30 days",
  D31_60: "31-60 days",
  D61_90: "61-90 days",
  D90_PLUS: "90+ days"
};

const bucketOrder = Object.keys(agingBucketLabels) as AgingBucket[];

/**
 * Every collectable invoice. Deliberately expressed against the persisted
 * balance rather than the invoice status list, so a new status value can never
 * silently drop money out of the receivables.
 */
const openInvoices = sql`i.is_finalized = true
  and i.voided_at is null
  and i.balance_centavos > 0`;

function asDate(asOf?: string): string {
  const value = asOf ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("The as-of date must be in YYYY-MM-DD format.");
  }
  return value;
}

/** Whole days from the due date to the as-of date; negative means not yet due. */
function daysPastDueSql(asOf: string) {
  return sql<number>`(${asOf}::date - i.due_date)`;
}

function bucketCase(daysPastDue: SQL) {
  return sql<AgingBucket>`case
    when ${daysPastDue} < 0 then 'CURRENT'
    when ${daysPastDue} <= 30 then 'D1_30'
    when ${daysPastDue} <= 60 then 'D31_60'
    when ${daysPastDue} <= 90 then 'D61_90'
    else 'D90_PLUS'
  end`;
}

export interface AgingRow {
  bucket: AgingBucket;
  label: string;
  amountCentavos: number;
  invoiceCount: number;
  accountCount: number;
}

/** Aging profile across the five buckets, always in report order and never sparse. */
export async function agingProfile(
  executor: Executor,
  options: { asOf?: string } = {}
): Promise<AgingRow[]> {
  const asOf = asDate(options.asOf);
  const bucket = bucketCase(daysPastDueSql(asOf));

  const rows = await queryRows<{
    bucket: AgingBucket;
    amount: string | null;
    invoice_count: string | null;
    account_count: string | null;
  }>(
    executor,
    sql`
      select
        ${bucket} as bucket,
        sum(i.balance_centavos) as amount,
        count(*) as invoice_count,
        count(distinct i.service_account_id) as account_count
      from invoices i
      where ${openInvoices}
      group by 1
    `
  );

  const byBucket = new Map(rows.map((row) => [row.bucket, row]));

  // A bucket with nothing in it still has to appear, otherwise a report where
  // nothing is 90+ days late would silently omit the row an auditor expects.
  return bucketOrder.map((key) => {
    const row = byBucket.get(key);
    return {
      bucket: key,
      label: agingBucketLabels[key],
      amountCentavos: Number(row?.amount ?? 0),
      invoiceCount: Number(row?.invoice_count ?? 0),
      accountCount: Number(row?.account_count ?? 0)
    };
  });
}

export interface AccountArrearsSnapshot {
  overdueCentavos: number;
  currentCentavos: number;
  oldestDaysPastDue: number | null;
  openInvoiceCount: number;
}

/**
 * One account's arrears at an instant, using the exact same open-invoice
 * definition as the dashboard (A3.9, A3.10).
 *
 * This is what gets frozen into `suspension_records.arrears_at_suspension`: the
 * snapshot is taken at request time, so a later payment or reversal cannot
 * rewrite how much the account owed on the day the suspension was opened.
 */
export async function accountArrearsSnapshot(
  executor: Executor,
  serviceAccountId: string,
  options: { asOf?: string } = {}
): Promise<AccountArrearsSnapshot> {
  const asOf = asDate(options.asOf);

  const row = await queryRow<{
    overdue: string | null;
    current: string | null;
    oldest: string | null;
    open_count: string | null;
  }>(
    executor,
    sql`
      with open as (
        select
          balance_centavos,
          ${daysPastDueSql(asOf)} as days_past_due
        from invoices i
        where i.service_account_id = ${serviceAccountId}
          and ${openInvoices}
      )
      select
        coalesce(sum(balance_centavos) filter (where days_past_due >= 0), 0) as overdue,
        coalesce(sum(balance_centavos) filter (where days_past_due < 0), 0) as current,
        max(days_past_due) filter (where days_past_due >= 0) as oldest,
        count(*) as open_count
      from open
    `
  );

  return {
    overdueCentavos: Number(row?.overdue ?? 0),
    currentCentavos: Number(row?.current ?? 0),
    oldestDaysPastDue: row?.oldest === null ? null : Number(row?.oldest ?? null),
    openInvoiceCount: Number(row?.open_count ?? 0)
  };
}

export interface ReceivablesSummary {
  asOf: string;
  currentReceivableCentavos: number;
  overdueReceivableCentavos: number;
  totalOutstandingCentavos: number;
  overdueAccountCount: number;
  overdueSubscriberCount: number;
  followUpAccountCount: number;
  suspensionCandidateCount: number;
  gracePeriodDays: number;
  suspensionThresholdMonths: number;
  aging: AgingRow[];
}

/**
 * The dashboard headline figures (A3.9).
 *
 * One pass over the open invoices, so the counts and the peso totals are
 * guaranteed to describe the same instant. `current` and `arrears` are split per
 * account, then summed, which is what makes the total equal to current plus
 * arrears by construction rather than by coincidence.
 */
export async function receivablesSummary(
  executor: Executor,
  options: { asOf?: string } = {}
): Promise<ReceivablesSummary> {
  const asOf = asDate(options.asOf);
  const settings = await getSettings(executor);
  const daysPastDue = daysPastDueSql(asOf);

  const row = await queryRow<{
    current_amount: string | null;
    overdue_amount: string | null;
    total_amount: string | null;
    overdue_accounts: string | null;
    overdue_subscribers: string | null;
    follow_up_accounts: string | null;
    suspension_candidates: string | null;
  }>(
    executor,
    sql`
      with open as (
        select
          sa.subscriber_id,
          i.service_account_id,
          i.balance_centavos,
          ${daysPastDue} as days_past_due
        from invoices i
        join service_accounts sa on sa.id = i.service_account_id
        where ${openInvoices}
      ),
      -- Grouped per *account*, not per subscriber: one subscriber may hold
      -- several services, and "accounts for follow up" has to be a different
      -- number from "subscribers overdue" or the dashboard reports nothing.
      per_account as (
        select
          service_account_id,
          subscriber_id,
          sum(balance_centavos) filter (where days_past_due < 0) as current_amount,
          sum(balance_centavos) filter (where days_past_due >= 0) as overdue_amount,
          -- max, not min: days_past_due is negative for a not-yet-due invoice,
          -- so min would return the *most recent* bill rather than the oldest
          -- one, and an account with a future invoice would look like it had no
          -- arrears at all.
          max(days_past_due) as oldest_days_past_due,
          count(*) filter (where days_past_due >= 0) as overdue_invoices
        from open
        group by service_account_id, subscriber_id
      )
      select
        coalesce(sum(current_amount) filter (where current_amount is not null), 0) as current_amount,
        coalesce(sum(overdue_amount) filter (where overdue_amount is not null), 0) as overdue_amount,
        coalesce(
          -- coalesce on each side, not on the sum: an aggregate with a FILTER
          -- returns NULL when nothing matches, so a delinquent account with
          -- arrears but nothing currently due would sum NULL + arrears = NULL
          -- and the dashboard would report a total of zero.
          sum(coalesce(current_amount, 0) + coalesce(overdue_amount, 0))
            filter (where current_amount is not null or overdue_amount is not null),
          0
        ) as total_amount,
        count(*) filter (where overdue_amount is not null) as overdue_accounts,
        count(distinct subscriber_id) filter (where overdue_amount is not null) as overdue_subscribers,
        count(*) filter (
          where overdue_amount is not null and oldest_days_past_due > ${settings.gracePeriodDays}
        ) as follow_up_accounts,
        count(*) filter (
          where overdue_amount is not null
            and oldest_days_past_due > ${settings.gracePeriodDays}
            and overdue_invoices >= ${settings.suspensionThresholdMonths}
        ) as suspension_candidates
      from per_account
    `
  );

  return {
    asOf,
    currentReceivableCentavos: Number(row?.current_amount ?? 0),
    overdueReceivableCentavos: Number(row?.overdue_amount ?? 0),
    totalOutstandingCentavos: Number(row?.total_amount ?? 0),
    overdueAccountCount: Number(row?.overdue_accounts ?? 0),
    overdueSubscriberCount: Number(row?.overdue_subscribers ?? 0),
    followUpAccountCount: Number(row?.follow_up_accounts ?? 0),
    suspensionCandidateCount: Number(row?.suspension_candidates ?? 0),
    gracePeriodDays: settings.gracePeriodDays,
    suspensionThresholdMonths: settings.suspensionThresholdMonths,
    aging: await agingProfile(executor, { asOf })
  };
}

export interface OverdueFilters {
  /** Evaluate the position as at this date instead of today. */
  asOf?: string;
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceTypeId?: string;
  accountStatus?: string;
  minDaysPastDue?: number;
  maxDaysPastDue?: number;
  suspensionCandidatesOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface OverdueRow {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  subscriberAccountNumber: string;
  contactNumber: string | null;
  installationAddress: string;
  accountStatus: string;
  planCode: string;
  planName: string;
  serviceTypeName: string;
  collectorCode: string | null;
  collectorName: string | null;
  areaCode: string | null;
  areaName: string | null;
  monthsUnpaid: number;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalArrearsCentavos: number;
  oldestUnpaidInvoice: {
    invoiceNumber: string;
    period: string;
    dueDate: string;
    daysPastDue: number;
  } | null;
  lastPayment: { receiptNumber: string; paidAt: string; method: string } | null;
  isSuspensionCandidate: boolean;
}

/**
 * The join tree behind the overdue list, built once and reused for both the page
 * and its count so the two can never disagree.
 *
 * `months_unpaid` is the number of collectable invoices, which is the spec's
 * "months unpaid". The oldest unpaid invoice is found with `age_rank` rather
 * than `min(due_date)` so its number and period can be reported alongside the
 * date without a second lookup.
 */
function overdueSource(asOf: string): SQL {
  const daysPastDue = daysPastDueSql(asOf);

  return sql`
    with open as (
      select
        i.id,
        i.invoice_number,
        i.period,
        i.due_date,
        i.balance_centavos,
        i.service_account_id,
        ${daysPastDue} as days_past_due,
        row_number() over (
          partition by i.service_account_id order by i.due_date asc, i.issue_date asc
        ) as age_rank
      from invoices i
      where ${openInvoices}
    ),
    per_account as (
      select
        o.service_account_id,
        count(*) as months_unpaid,
        sum(o.balance_centavos) filter (where o.days_past_due < 0) as current_bill,
        sum(o.balance_centavos) filter (where o.days_past_due >= 0) as arrears,
        -- See the note in receivablesSummary: max is the oldest *overdue* bill.
        max(o.days_past_due) as oldest_days_past_due,
        count(*) filter (where o.days_past_due >= 0) as overdue_invoices
      from open o
      group by o.service_account_id
    ),
    oldest as (
      select distinct on (o.service_account_id)
        o.service_account_id,
        o.invoice_number,
        o.period,
        o.due_date,
        o.days_past_due
      from open o
      where o.age_rank = 1
    ),
    last_pay as (
      select distinct on (p.service_account_id)
        p.service_account_id,
        p.receipt_number,
        p.payment_date,
        p.method
      from payments p
      where p.reversed_at is null
      order by p.service_account_id, p.payment_date desc
    )
    select
      sa.id as service_account_id,
      sa.service_account_number,
      sa.status as account_status,
      sa.installation_address,
      sa.collector_id,
      sub.id as subscriber_id,
      sub.full_name as subscriber_name,
      sub.account_number as subscriber_account_number,
      sub.contact_number,
      sub.collection_area_id as area_id,
      pl.id as plan_id,
      pl.code as plan_code,
      pl.name as plan_name,
      st.id as service_type_id,
      st.name as service_type_name,
      a.code as area_code,
      a.name as area_name,
      c.code as collector_code,
      c.full_name as collector_name,
      pa.months_unpaid,
      coalesce(pa.current_bill, 0) as current_bill,
      coalesce(pa.arrears, 0) as arrears,
      pa.oldest_days_past_due,
      pa.overdue_invoices,
      o.invoice_number as oldest_invoice_number,
      o.period as oldest_period,
      o.due_date as oldest_due_date,
      o.days_past_due as oldest_days,
      lp.receipt_number as last_receipt_number,
      lp.payment_date as last_payment_date,
      lp.method as last_payment_method
    from per_account pa
    join service_accounts sa on sa.id = pa.service_account_id
    join subscribers sub on sub.id = sa.subscriber_id
    join service_plans pl on pl.id = sa.plan_id
    join service_types st on st.id = pl.service_type_id
    left join collection_areas a on a.id = sub.collection_area_id
    left join collectors c on c.id = sa.collector_id
    left join oldest o on o.service_account_id = sa.id
    left join last_pay lp on lp.service_account_id = sa.id
    where pa.overdue_invoices > 0
  `;
}

/**
 * Filters are written against the projected column names rather than the base
 * tables, so a filter never has to re-join anything.
 */
function overdueWhere(
  query: OverdueFilters,
  settings: { gracePeriodDays: number; suspensionThresholdMonths: number }
): SQL {
  const clauses: SQL[] = [sql`oldest_days_past_due >= ${query.minDaysPastDue ?? 0}`];

  if (query.maxDaysPastDue !== undefined) {
    clauses.push(sql`oldest_days_past_due <= ${query.maxDaysPastDue}`);
  }
  if (query.collectorId) {
    clauses.push(sql`collector_id = ${query.collectorId}::uuid`);
  }
  if (query.areaId) {
    clauses.push(sql`area_id = ${query.areaId}::uuid`);
  }
  if (query.planId) {
    clauses.push(sql`plan_id = ${query.planId}::uuid`);
  }
  if (query.serviceTypeId) {
    clauses.push(sql`service_type_id = ${query.serviceTypeId}::uuid`);
  }
  if (query.accountStatus) {
    clauses.push(sql`account_status = ${query.accountStatus}::service_account_status`);
  }
  if (query.search) {
    const like = `%${query.search}%`;
    clauses.push(sql`(
      subscriber_name ilike ${like}
      or subscriber_account_number ilike ${like}
      or service_account_number ilike ${like}
      or installation_address ilike ${like}
    )`);
  }
  if (query.suspensionCandidatesOnly) {
    // The same "past the grace period, enough months" rule the dashboard counts,
    // so this button and the headline number can never disagree.
    clauses.push(sql`oldest_days_past_due > ${settings.gracePeriodDays}`);
    clauses.push(sql`overdue_invoices >= ${settings.suspensionThresholdMonths}`);
  }

  // Two traps here, both of which produce valid-looking SQL fragments that
  // Postgres then rejects: `Array.join` would stringify the fragments to
  // "[object Object]", and a raw string separator is silently dropped, welding
  // the clauses together as `a >= $4$5b > $6`. The separator has to be a sql
  // chunk, exactly as the collection service's uuid list does it.
  return sql`(${sql.join(clauses, sql` and `)})`;
}

/**
 * The overdue list (A3.9). Every column the spec asks for is produced here:
 * subscriber, service, area, collector, months unpaid, oldest unpaid invoice,
 * last payment and total arrears.
 *
 * Ordering is by severity rather than by name - the most overdue account first,
 * ties broken by the largest arrears - because that is the account a collector
 * should visit next. The sort is `desc` on days past due: `asc` would put the
 * account that is one day late ahead of the one that is ninety days late, which
 * is the exact opposite of useful.
 */
export async function listOverdueAccounts(executor: Executor, query: OverdueFilters = {}) {
  const asOf = asDate(query.asOf);
  const settings = await getSettings(executor);
  const source = overdueSource(asOf);
  const where = overdueWhere(query, settings);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

  const rows = await queryRows<Record<string, unknown>>(
    executor,
    sql`
      select f.*,
        (f.oldest_days_past_due > ${settings.gracePeriodDays}
          and f.overdue_invoices >= ${settings.suspensionThresholdMonths}) as is_candidate
      from (${source}) f
      where ${where}
      order by f.oldest_days_past_due desc, f.arrears desc, f.service_account_number asc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `
  );

  const countRow = await queryRow<{ total: string }>(
    executor,
    sql`select count(*) as total from (${source}) f where ${where}`
  );

  return {
    asOf,
    page,
    pageSize,
    total: Number(countRow?.total ?? 0),
    items: rows.map(mapOverdueRow)
  };
}

function mapOverdueRow(row: Record<string, unknown>): OverdueRow {
  const currentBill = Number(row.current_bill ?? 0);
  const arrears = Number(row.arrears ?? 0);

  return {
    serviceAccountId: String(row.service_account_id),
    serviceAccountNumber: String(row.service_account_number),
    subscriberId: String(row.subscriber_id),
    subscriberName: String(row.subscriber_name ?? ""),
    subscriberAccountNumber: String(row.subscriber_account_number ?? ""),
    contactNumber: (row.contact_number as string | null) ?? null,
    installationAddress: String(row.installation_address ?? ""),
    accountStatus: String(row.account_status ?? ""),
    planCode: String(row.plan_code ?? ""),
    planName: String(row.plan_name ?? ""),
    serviceTypeName: String(row.service_type_name ?? ""),
    collectorCode: (row.collector_code as string | null) ?? null,
    collectorName: (row.collector_name as string | null) ?? null,
    areaCode: (row.area_code as string | null) ?? null,
    areaName: (row.area_name as string | null) ?? null,
    monthsUnpaid: Number(row.months_unpaid ?? 0),
    currentBillCentavos: currentBill,
    arrearsCentavos: arrears,
    totalArrearsCentavos: currentBill + arrears,
    oldestUnpaidInvoice: row.oldest_invoice_number
      ? {
          invoiceNumber: String(row.oldest_invoice_number),
          period: String(row.oldest_period ?? ""),
          dueDate: String(row.oldest_due_date ?? ""),
          daysPastDue: Number(row.oldest_days ?? 0)
        }
      : null,
    lastPayment: row.last_receipt_number
      ? {
          receiptNumber: String(row.last_receipt_number),
          paidAt: new Date(String(row.last_payment_date)).toISOString(),
          method: String(row.last_payment_method ?? "")
        }
      : null,
    isSuspensionCandidate: row.is_candidate === true || row.is_candidate === "t"
  };
}

/**
 * Accounts that satisfy the configured suspension rule (A3.10).
 *
 * Kept as a separate call rather than a flag on the overdue list so an officer
 * can review the candidate list and act on a subset - the system proposes, a
 * person disposes. Nothing here suspends anybody on its own.
 */
export async function listSuspensionCandidates(
  executor: Executor,
  query: { asOf?: string; limit?: number } = {}
) {
  const settings = await getSettings(executor);
  const limit = Math.min(500, Math.max(1, query.limit ?? 200));
  const result = await listOverdueAccounts(executor, {
    suspensionCandidatesOnly: true,
    accountStatus: "ACTIVE",
    pageSize: limit
  });

  return {
    gracePeriodDays: settings.gracePeriodDays,
    suspensionThresholdMonths: settings.suspensionThresholdMonths,
    items: result.items
  };
}
