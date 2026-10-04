import { sql } from "drizzle-orm";

import type { Executor } from "../db/client.js";
import { queryRows, queryRow } from "../db/client.js";

/**
 * Management reports (§3.11).
 *
 * Every amount is integer centavos. Aggregations sum `bigint` columns and the
 * arithmetic below never leaves PostgreSQL, so a report cannot drift from the
 * books it summarises. Where the underlying data already has a dedicated
 * service (collector performance, subscriber master, statements, the audit
 * trail) this module delegates to it rather than re-querying the same tables a
 * second way.
 */

export type ReportGranularity = "daily" | "weekly" | "monthly" | "annual";

export const reportGranularities: ReportGranularity[] = ["daily", "weekly", "monthly", "annual"];
export type RevenueDimension = "plan" | "service-type" | "area";

interface CollectionBucketRaw {
  bucket: string | null;
  posted_count: number | null;
  collected_centavos: number | null;
  cash: number | null;
  gcash: number | null;
  bank_transfer: number | null;
  cheque: number | null;
  other: number | null;
}

export interface CollectionBucket {
  period: string;
  postedCount: number;
  collectedCentavos: number;
  methods: Record<string, number>;
}

export interface CollectionReportResult {
  from: string;
  to: string;
  granularity: ReportGranularity;
  buckets: CollectionBucket[];
  totals: { postedCount: number; collectedCentavos: number; methods: Record<string, number> };
}

/**
 * Daily / weekly / monthly / annual collections. A bucket counts posted,
 * non-reversed payments whose collection date falls in the window, and splits
 * the peso value by payment method.
 */
export async function collectionReport(
  executor: Executor,
  input: { from?: string; to?: string; granularity?: ReportGranularity }
): Promise<CollectionReportResult> {
  const granularity: ReportGranularity = input.granularity ?? "monthly";
  const now = new Date();
  const fromDefault = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const from = input.from ?? fromDefault;
  const to = input.to ?? new Date().toISOString().slice(0, 10);

  const rows = await queryRows<CollectionBucketRaw>(
    executor,
    sql`
      select
        t.bucket,
        count(*)::int as posted_count,
        coalesce(sum(t.amount_centavos), 0)::bigint as collected_centavos,
        coalesce(sum(case when t.method = 'CASH' then t.amount_centavos else 0 end), 0)::bigint as cash,
        coalesce(sum(case when t.method = 'GCASH' then t.amount_centavos else 0 end), 0)::bigint as gcash,
        coalesce(sum(case when t.method = 'BANK_TRANSFER' then t.amount_centavos else 0 end), 0)::bigint as bank_transfer,
        coalesce(sum(case when t.method = 'CHEQUE' then t.amount_centavos else 0 end), 0)::bigint as cheque,
        coalesce(sum(case when t.method = 'OTHER' then t.amount_centavos else 0 end), 0)::bigint as other
      from (
        select
          p.method,
          p.amount_centavos,
          case ${granularity}
            when 'daily' then to_char(date_trunc('day', p.payment_date::timestamp), 'YYYY-MM-DD')
            when 'weekly' then to_char(date_trunc('week', p.payment_date::timestamp), 'IYYY-"W"IW')
            when 'monthly' then to_char(date_trunc('month', p.payment_date::timestamp), 'YYYY-MM')
            when 'annual' then to_char(date_trunc('year', p.payment_date::timestamp), 'YYYY')
          end as bucket
        from payments p
        where p.status = 'POSTED'
          and p.payment_date::date >= ${from}::date
          and p.payment_date::date <= ${to}::date
      ) t
      group by t.bucket
      order by t.bucket asc
    `
  );

  const buckets: CollectionBucket[] = rows.map((row) => ({
    period: row.bucket ?? "-",
    postedCount: Number(row.posted_count ?? 0),
    collectedCentavos: Number(row.collected_centavos ?? 0),
    methods: {
      CASH: Number(row.cash ?? 0),
      GCASH: Number(row.gcash ?? 0),
      BANK_TRANSFER: Number(row.bank_transfer ?? 0),
      CHEQUE: Number(row.cheque ?? 0),
      OTHER: Number(row.other ?? 0)
    }
  }));

  return {
    from,
    to,
    granularity,
    buckets,
    totals: buckets.reduce(
      (acc, bucket) => {
        acc.postedCount += bucket.postedCount;
        acc.collectedCentavos += bucket.collectedCentavos;
        for (const [method, amount] of Object.entries(bucket.methods)) {
          acc.methods[method] = (acc.methods[method] ?? 0) + amount;
        }
        return acc;
      },
      { postedCount: 0, collectedCentavos: 0, methods: {} as Record<string, number> }
    )
  };
}

interface BillingVsCollectionRow {
  period: string;
  billed_count: number | null;
  billed_centavos: number | null;
  collected_count: number | null;
  collected_centavos: number | null;
}

export interface BillingVsCollectionPeriod {
  period: string;
  billedCount: number;
  billedCentavos: number;
  collectedCount: number;
  collectedCentavos: number;
  outstandingCentavos: number;
  collectionRate: number;
}

/**
 * Billing versus collection, month by month (`invoice.period` is the billing
 * period, not the collection date, so both sides of the comparison are judged
 * against the same money). Outstanding is the difference, collection rate the
 * percentage of the billed amount that has actually been collected.
 */
export async function billingVsCollectionReport(
  executor: Executor,
  input: { from?: string; to?: string }
): Promise<{ from?: string; to?: string; rows: BillingVsCollectionPeriod[] }> {
  // `invoice.period` is always 'YYYY-MM', so a (from, to) date window is
  // translated to its year-month before comparing - otherwise '2026-05-15'
  // would silently exclude period '2026-05'.
  const where = sql`
    where i.is_finalized = true and i.voided_at is null
      and (${input.from ?? null}::text is null or i.period >= left(${input.from ?? null}::text, 7))
      and (${input.to ?? null}::text is null or i.period <= left(${input.to ?? null}::text, 7))
  `;

  const [billedRows, collectedRows] = await Promise.all([
    queryRows<{ period: string; billed_count: number | null; billed_centavos: number | null }>(
      executor,
      sql`
        select i.period,
          count(*)::int as billed_count,
          coalesce(sum(i.total_centavos), 0)::bigint as billed_centavos
        from invoices i
        ${where}
        group by i.period
      `
    ),
    queryRows<{ period: string; collected_count: number | null; collected_centavos: number | null }>(
      executor,
      sql`
        select inv.period,
          count(distinct pa.payment_id)::int as collected_count,
          coalesce(sum(pa.amount_centavos), 0)::bigint as collected_centavos
        from payment_allocations pa
        join invoices inv on inv.id = pa.invoice_id and inv.voided_at is null
        join payments p on p.id = pa.payment_id and p.status = 'POSTED'
        where (${input.from ?? null}::text is null or inv.period >= left(${input.from ?? null}::text, 7))
          and (${input.to ?? null}::text is null or inv.period <= left(${input.to ?? null}::text, 7))
        group by inv.period
      `
    )
  ]);

  const collectedByPeriod = new Map(collectedRows.map((row) => [row.period, row]));

  const rows: BillingVsCollectionPeriod[] = billedRows.map((row) => {
    const collected = collectedByPeriod.get(row.period);
    const billedCentavos = Number(row.billed_centavos ?? 0);
    const collectedCentavos = Number(collected?.collected_centavos ?? 0);
    return {
      period: row.period,
      billedCount: Number(row.billed_count ?? 0),
      billedCentavos,
      collectedCount: Number(collected?.collected_count ?? 0),
      collectedCentavos,
      outstandingCentavos: billedCentavos - collectedCentavos,
      collectionRate: billedCentavos === 0 ? 0 : Math.round((collectedCentavos / billedCentavos) * 10000) / 100
    };
  });

  return { from: input.from, to: input.to, rows };
}

interface RevenueRawRow {
  dimension: string | null;
  billed_count: number | null;
  billed_centavos: number | null;
  collected_centavos: number | null;
}

export interface RevenueRow {
  dimension: string;
  billedCount: number;
  billedCentavos: number;
  collectedCentavos: number;
  outstandingCentavos: number;
  collectionRate: number;
}

/**
 * Revenue by service plan, service type or collection area. Both billed and
 * collected amounts share the same invoice dimension so the two numbers always
 * add up to the same book of business.
 */
export async function revenueReport(
  executor: Executor,
  input: { by: RevenueDimension; from?: string; to?: string }
): Promise<{ by: RevenueDimension; rows: RevenueRow[] }> {
  const rows = await queryRows<RevenueRawRow>(
    executor,
    sql`
      select
        d.dimension,
        count(*)::int as billed_count,
        coalesce(sum(d.invoice_total_centavos), 0)::bigint as billed_centavos,
        coalesce(sum(d.collected_centavos), 0)::bigint as collected_centavos
      from (
        select
          inv.id,
          inv.total_centavos as invoice_total_centavos,
          coalesce(pc.collected_centavos, 0) as collected_centavos,
          case ${input.by}
            when 'plan' then coalesce(pl.name, 'Unassigned')
            when 'service-type' then coalesce(st.name, 'Unassigned')
            when 'area' then coalesce(ar.name, 'Unassigned')
          end as dimension
        from invoices inv
        join service_accounts sa on sa.id = inv.service_account_id
        join subscribers sub on sub.id = sa.subscriber_id
        left join service_plans pl on pl.id = sa.plan_id
        left join service_types st on st.id = pl.service_type_id
        left join collection_areas ar on ar.id = sub.collection_area_id
        left join (
          select pa.invoice_id, sum(pa.amount_centavos)::bigint as collected_centavos
          from payment_allocations pa
          join payments p on p.id = pa.payment_id and p.status = 'POSTED'
          group by pa.invoice_id
        ) pc on pc.invoice_id = inv.id
        where inv.is_finalized = true and inv.voided_at is null
          and (${input.from ?? null}::text is null or inv.period >= left(${input.from ?? null}::text, 7))
          and (${input.to ?? null}::text is null or inv.period <= left(${input.to ?? null}::text, 7))
      ) d
      group by d.dimension
      order by coalesce(sum(d.invoice_total_centavos), 0) desc, d.dimension asc
    `
  );

  return {
    by: input.by,
    rows: rows.map((row) => {
      const billedCentavos = Number(row.billed_centavos ?? 0);
      const collectedCentavos = Number(row.collected_centavos ?? 0);
      return {
        dimension: row.dimension ?? "-",
        billedCount: Number(row.billed_count ?? 0),
        billedCentavos,
        collectedCentavos,
        outstandingCentavos: billedCentavos - collectedCentavos,
        collectionRate: billedCentavos === 0 ? 0 : Math.round((collectedCentavos / billedCentavos) * 10000) / 100
      };
    })
  };
}

export type PaymentRegisterStatus = "POSTED" | "REVERSED" | "VOID";

export interface PaymentRegisterRow {
  receiptNumber: string | null;
  paymentDate: string | null;
  serviceAccountNumber: string | null;
  accountNumber: string | null;
  subscriberName: string | null;
  method: string | null;
  amountCentavos: number;
  status: PaymentRegisterStatus;
  postedByName: string | null;
  reversalReason: string | null;
  voidReason: string | null;
}

export interface PaymentRegisterResult {
  items: PaymentRegisterRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: { postedCount: number; postedCentavos: number };
}

interface PaymentRegisterRawRow {
  receipt_number: string | null;
  payment_date: string | null;
  service_account_number: string | null;
  account_number: string | null;
  subscriber_name: string | null;
  method: string | null;
  amount_centavos: number | null;
  record_status: PaymentRegisterStatus | null;
  posted_by_name: string | null;
  reversal_reason: string | null;
  void_reason: string | null;
}

export interface PaymentRegisterQuery {
  from?: string;
  to?: string;
  method?: string;
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * The payments register: every issued receipt including reversals and voided
 * receipts. Voided receipts keep their number (a number is never reissued), so
 * this is the list a reviewer uses to confirm that the register is complete.
 */
export async function paymentRegister(
  executor: Executor,
  query: PaymentRegisterQuery
): Promise<PaymentRegisterResult> {
  const conditions = [];
  if (query.from) {
    conditions.push(sql`p.payment_date::date >= ${query.from}::date`);
  }
  if (query.to) {
    conditions.push(sql`p.payment_date::date <= ${query.to}::date`);
  }
  if (query.method) {
    conditions.push(sql`p.method = ${query.method}`);
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(
      sql`(upper(coalesce(r.receipt_number, p.receipt_number)) ilike upper(${pattern})
        or sub.full_name ilike ${pattern}
        or sa.service_account_number ilike ${pattern}
        or sub.account_number ilike ${pattern})`
    );
  }
  const where = conditions.length > 0 ? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}` : sql``;

  const [countRow, row] = await Promise.all([
    queryRow<{ total: number | null }>(
      executor,
      sql`
        select count(*)::int as total
        from payments p
        left join receipts r on r.payment_id = p.id
        join service_accounts sa on sa.id = p.service_account_id
        join subscribers sub on sub.id = p.subscriber_id
        ${where}
      `
    ),
    queryRows<PaymentRegisterRawRow>(
      executor,
      sql`
        select
          coalesce(r.receipt_number, p.receipt_number) as receipt_number,
          to_char(p.payment_date::date, 'YYYY-MM-DD') as payment_date,
          sa.service_account_number,
          sub.account_number,
          sub.full_name as subscriber_name,
          p.method,
          p.amount_centavos,
          case
            when p.status = 'REVERSED' then 'REVERSED'
            when r.voided_at is not null then 'VOID'
            else 'POSTED'
          end as record_status,
          p.posted_by_name,
          p.reversal_reason,
          r.void_reason
        from payments p
        left join receipts r on r.payment_id = p.id
        join service_accounts sa on sa.id = p.service_account_id
        join subscribers sub on sub.id = p.subscriber_id
        ${where}
        order by p.payment_date desc, coalesce(r.receipt_number, p.receipt_number) desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `
    )
  ]);

  const items: PaymentRegisterRow[] = row.map((item) => ({
    receiptNumber: item.receipt_number,
    paymentDate: item.payment_date,
    serviceAccountNumber: item.service_account_number,
    accountNumber: item.account_number,
    subscriberName: item.subscriber_name,
    method: item.method,
    amountCentavos: Number(item.amount_centavos ?? 0),
    status: item.record_status ?? "POSTED",
    postedByName: item.posted_by_name,
    reversalReason: item.reversal_reason,
    voidReason: item.void_reason
  }));

  const [sumRow] = await queryRows<{ posted_centavos: number | null; posted_count: number | null }>(
    executor,
    sql`
      select coalesce(sum(case when p.status = 'POSTED' then p.amount_centavos else 0 end), 0)::bigint as posted_centavos,
        count(*) filter (where p.status = 'POSTED')::int as posted_count
      from payments p
      left join receipts r on r.payment_id = p.id
      join service_accounts sa on sa.id = p.service_account_id
      join subscribers sub on sub.id = p.subscriber_id
      ${where}
    `
  );

  return {
    items,
    total: Number(countRow?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    totals: {
      postedCount: Number(sumRow?.posted_count ?? 0),
      postedCentavos: Number(sumRow?.posted_centavos ?? 0)
    }
  };
}

interface AdjustmentRawRow {
  id: string;
  created_at: string | null;
  invoice_number: string | null;
  service_account_number: string | null;
  subscriber_name: string | null;
  period: string | null;
  adjustment_type: string | null;
  reason: string | null;
  amount_centavos: number | null;
  previous_total_centavos: number | null;
  new_total_centavos: number | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
}

export interface AdjustmentRow {
  id: string;
  createdAt: string | null;
  invoiceNumber: string | null;
  serviceAccountNumber: string | null;
  subscriberName: string | null;
  period: string | null;
  adjustmentType: string | null;
  reason: string | null;
  amountCentavos: number;
  previousTotalCentavos: number;
  newTotalCentavos: number;
  requestedByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
}

export interface AdjustmentRegisterResult {
  items: AdjustmentRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Payment adjustments (invoice corrections) with who requested and who approved. */
export async function adjustmentRegister(
  executor: Executor,
  query: { from?: string; to?: string; page: number; pageSize: number }
): Promise<AdjustmentRegisterResult> {
  const conditions = [];
  if (query.from) {
    conditions.push(sql`adj.created_at >= ${query.from}::date`);
  }
  if (query.to) {
    conditions.push(sql`adj.created_at < (${query.to}::date + interval '1 day')`);
  }
  const where = conditions.length > 0 ? sql`where ${conditions.reduce((a, b) => sql`${a} and ${b}`)}` : sql``;

  const [countRow, rows] = await Promise.all([
    queryRow<{ total: number | null }>(
      executor,
      sql`
        select count(*)::int as total
        from invoice_adjustments adj
        join invoices inv on inv.id = adj.invoice_id
        ${where}
      `
    ),
    queryRows<AdjustmentRawRow>(
      executor,
      sql`
        select
          adj.id,
          to_char(adj.created_at, 'YYYY-MM-DD HH24:MI') as created_at,
          inv.invoice_number,
          sa.service_account_number,
          sub.full_name as subscriber_name,
          inv.period,
          adj.adjustment_type,
          adj.reason,
          adj.amount_centavos,
          adj.previous_total_centavos,
          adj.new_total_centavos,
          adj.requested_by_name,
          adj.approved_by_name,
          to_char(adj.approved_at, 'YYYY-MM-DD HH24:MI') as approved_at
        from invoice_adjustments adj
        join invoices inv on inv.id = adj.invoice_id
        join service_accounts sa on sa.id = inv.service_account_id
        join subscribers sub on sub.id = sa.subscriber_id
        ${where}
        order by adj.created_at desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `
    )
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      invoiceNumber: row.invoice_number,
      serviceAccountNumber: row.service_account_number,
      subscriberName: row.subscriber_name,
      period: row.period,
      adjustmentType: row.adjustment_type,
      reason: row.reason,
      amountCentavos: Number(row.amount_centavos ?? 0),
      previousTotalCentavos: Number(row.previous_total_centavos ?? 0),
      newTotalCentavos: Number(row.new_total_centavos ?? 0),
      requestedByName: row.requested_by_name,
      approvedByName: row.approved_by_name,
      approvedAt: row.approved_at
    })),
    total: Number(countRow?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize
  };
}