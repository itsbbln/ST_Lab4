import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL
} from "drizzle-orm";
import { formatCentavos, sum as sumCentavos, type InvoiceStatus } from "@bcis/shared";

import { inTransaction, queryRows, type Executor } from "../db/client.js";
import {
  billingCycles,
  collectionAreas,
  collectors,
  invoiceAdjustments,
  invoiceItems,
  invoices,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers
} from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { DomainError, businessRule, notFound } from "./errors.js";
import { postInvoiceDebit, postLedgerEntry } from "./ledger.js";
import { nextDocument } from "./numbering.js";
import { getSettings } from "./settings.js";
import type { Actor } from "./types.js";

/**
 * Monthly billing and the invoice lifecycle (§3.4).
 *
 * Three decisions carry most of the weight here:
 *
 *  1. **Rate snapshot.** The charge comes from
 *     `service_accounts.current_rate_centavos`, not from the live plan price.
 *     Editing a plan therefore only affects future billing, and every historical
 *     invoice keeps the rate that was actually billed (§3.3).
 *  2. **Duplicate prevention is a database constraint.** Generation inserts with
 *     `ON CONFLICT DO NOTHING` against the partial unique index on
 *     `(service_account_id, period) WHERE status <> 'VOID'`. A second run for
 *     the same period is a no-op, not an application-level check that two
 *     concurrent clients could both pass (AT-11).
 *  3. **Finalized invoices are immutable.** Generation produces a finalized
 *     `UNPAID` invoice plus its ledger debit. The only sanctioned ways to change
 *     a total afterwards are `voidInvoice` (which writes a reversing ledger
 *     entry) and an approved `adjustInvoice`, both of which leave the original
 *     row in place (§3.4).
 */

/** Days in a `YYYY-MM` period. */
export function lastDayOfPeriod(period: string): number {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface BillingPeriod {
  period: string;
}

/** Validates and normalizes a `YYYY-MM` period. */
export function normalizePeriod(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new DomainError("VALIDATION_FAILED", "Billing period must use the YYYY-MM format.", 400);
  }
  return period;
}

export function dueDateForPeriod(period: string, dueDay: number): string {
  const [year, month] = period.split("-").map(Number);
  // Clamp rather than roll over: a due day of 31 must produce a date inside the
  // billed month (28 Feb, not 3 March), otherwise the invoice would be overdue
  // the moment it was issued.
  const day = Math.min(Math.max(dueDay, 1), lastDayOfPeriod(period));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function periodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  return `${names[month - 1]} ${year}`;
}

/** Periods on the configured cadence between `start` and `end`, inclusive. */
export function monthsBetween(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const periods: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (periods.length > 600) {
      break;
    }
  }
  return periods;
}

export interface GenerateBillingResult {
  period: string;
  billingCycleId: string | null;
  /** Accounts that received a new invoice. */
  created: number;
  /** Accounts skipped because the period was already billed (AT-11). */
  skipped: number;
  totalBilledCentavos: number;
  invoiceNumbers: string[];
  penaltyAppliedCentavos: number;
  /** Credit already on account that was consumed by this run's invoices. */
  appliedAdvanceCentavos: number;
  /** totalBilledCentavos less appliedAdvanceCentavos: still to collect. */
  netCollectibleCentavos: number;
  asOf: string;
}

interface CandidateAccount {
  id: string;
  serviceAccountNumber: string;
  currentRateCentavos: number;
  effectiveRateCentavos: number;
  billingStartPeriod: string;
  billingDueDay: number;
  installationFeeCentavos: number;
  planName: string;
  planCode: string;
  serviceTypeName: string;
  overduePriorBalanceCentavos: number;
}

/** One row as the billable-accounts query returns it, with snake_case keys. */
interface CandidateAccountSqlRow extends Record<string, unknown> {
  id: string;
  service_account_number: string;
  current_rate_centavos: number;
  effective_rate_centavos: number;
  billing_start_period: string;
  billing_due_day: number;
  installation_fee_centavos: number;
  plan_name: string;
  plan_code: string;
  service_type_name: string;
  overdue_prior_balance_centavos: number;
}

/**
 * Generates (or re-runs) monthly billing for one period.
 *
 * The whole run is a single transaction: either the cycle, every invoice and
 * every ledger debit are all committed, or nothing is. A failure on the last
 * account cannot leave the first thirty accounts billed with no record of it.
 */
export async function generateMonthlyBilling(
  input: { period: string; applyPenalty?: boolean },
  actor?: Actor
): Promise<GenerateBillingResult> {
  const period = normalizePeriod(input.period);
  const asOf = new Date().toISOString().slice(0, 10);

  return inTransaction(async (tx) => {
    const settings = await getSettings(tx);
    const applyPenalty = input.applyPenalty ?? settings.penaltyEnabled;

    // Upsert the cycle first so that invoice rows can reference it.
    const [cycle] = await tx
      .insert(billingCycles)
      .values({ period, status: "OPEN" })
      .onConflictDoUpdate({
        target: billingCycles.period,
        set: { status: "OPEN" }
      })
      .returning();

    const candidates = await billableAccounts(tx, period, asOf);

    let created = 0;
    let skipped = 0;
    let totalBilled = 0;
    let penaltyApplied = 0;
    let appliedAdvance = 0;
    const invoiceNumbers: string[] = [];
    const year = Number(period.split("-")[0]);

    for (const account of candidates) {
      const items: Array<{
        itemType: "SUBSCRIPTION" | "INSTALLATION" | "PENALTY";
        description: string;
        amountCentavos: number;
      }> = [
        {
          itemType: "SUBSCRIPTION",
          description: `${account.planName} monthly subscription (${periodLabel(period)})`,
          amountCentavos: account.effectiveRateCentavos
        }
      ];

      // The installation fee is charged once, in the account's first billed
      // period, so a re-run of a later period can never charge it twice.
      const isFirstPeriod = account.billingStartPeriod === period;
      if (isFirstPeriod && account.installationFeeCentavos > 0) {
        items.push({
          itemType: "INSTALLATION",
          description: `${account.planName} installation fee`,
          amountCentavos: account.installationFeeCentavos
        });
      }

      if (applyPenalty && account.overduePriorBalanceCentavos > 0 && settings.latePenaltyCentavos > 0) {
        items.push({
          itemType: "PENALTY",
          description: `Late payment penalty on overdue balance of ${formatCentavos(
            account.overduePriorBalanceCentavos
          )}`,
          amountCentavos: settings.latePenaltyCentavos
        });
        penaltyApplied += settings.latePenaltyCentavos;
      }

      const subtotal = sumCentavos(items.map((item) => item.amountCentavos));
      const total = subtotal;
      const dueDate = dueDateForPeriod(period, account.billingDueDay);

      // The unique partial index on (service_account_id, period) is the real
      // guarantee. `ON CONFLICT DO NOTHING` with no target covers every unique
      // constraint on the table, and an empty `returning` array tells us this
      // account was already billed.
      const inserted = await tx
        .insert(invoices)
        .values({
          invoiceNumber: "PENDING",
          serviceAccountId: account.id,
          billingCycleId: cycle.id,
          period,
          issueDate: asOf,
          dueDate,
          subtotalCentavos: subtotal,
          totalCentavos: total,
          paidCentavos: 0,
          balanceCentavos: total,
          status: "UNPAID",
          rateSnapshotCentavos: account.effectiveRateCentavos,
          isFinalized: true,
          finalizedAt: new Date()
        })
        .onConflictDoNothing()
        .returning({ id: invoices.id });

      const createdInvoice = inserted[0];
      if (!createdInvoice) {
        skipped += 1;
        continue;
      }

      // The invoice number is allocated only for invoices that were actually
      // created, so a skipped re-run does not burn numbers.
      const invoiceNumber = await nextDocument(tx, "INVOICE", year);
      await tx
        .update(invoices)
        .set({ invoiceNumber })
        .where(eq(invoices.id, createdInvoice.id));

      await tx.insert(invoiceItems).values(
        items.map((item, index) => ({
          invoiceId: createdInvoice.id,
          itemType: item.itemType,
          description: item.description,
          quantity: "1",
          unitPriceCentavos: item.amountCentavos,
          amountCentavos: item.amountCentavos,
          sortOrder: index
        }))
      );

      await postInvoiceDebit(
        tx,
        {
          serviceAccountId: account.id,
          invoiceNumber,
          period,
          totalCentavos: total,
          invoiceId: createdInvoice.id,
          issueDate: asOf
        },
        actor
      );

      // Consume any credit the subscriber already paid on account. This is
      // imported lazily: payments.ts needs `deriveInvoiceStatus` from this
      // module, and a static import would make the pair circular at
      // module-evaluation time. Both are only called at runtime, so the
      // deferred import resolves cleanly.
      const { applyExistingAdvance } = await import("./payments.js");
      const appliedFromAdvance = await applyExistingAdvance(tx, account.id, createdInvoice.id, total);
      appliedAdvance += appliedFromAdvance;

      created += 1;
      totalBilled += total;
      invoiceNumbers.push(invoiceNumber);
    }

    await tx
      .update(billingCycles)
      .set({
        status: "FINALIZED",
        generatedAt: new Date(),
        generatedBy: actor?.id ?? null,
        generatedByName: actor?.displayName ?? null,
        invoiceCount: created,
        totalBilledCentavos: totalBilled,
        finalizedAt: new Date()
      })
      .where(eq(billingCycles.id, cycle.id));

    await writeAudit(tx, actor, {
      action: auditActions.BILLING_GENERATED,
      entityType: "billing_cycle",
      entityId: cycle.id,
      changes: {
        period: { new: period },
        invoiceCount: { new: created },
        totalBilledCentavos: { new: totalBilled }
      },
      metadata: {
        created,
        skipped,
        applyPenalty,
        penaltyAppliedCentavos: penaltyApplied,
        appliedAdvanceCentavos: appliedAdvance
      }
    });

    return {
      period,
      billingCycleId: cycle.id,
      created,
      skipped,
      totalBilledCentavos: totalBilled,
      invoiceNumbers,
      penaltyAppliedCentavos: penaltyApplied,
      appliedAdvanceCentavos: appliedAdvance,
      netCollectibleCentavos: totalBilled - appliedAdvance,
      asOf
    };
  });
}

/**
 * Accounts eligible to be billed for `period`.
 *
 * An account qualifies when it is ACTIVE or PENDING_ACTIVATION, its
 * `billing_start_period` is on or before the period, and no finalized invoice
 * already exists for the period.
 *
 * The rate is resolved *per period*, not read straight off the account row. A
 * plan change agreed today for a future effective period is stored as a
 * `PLAN_CHANGED` service event and leaves `current_rate_centavos` alone, so the
 * newest event whose `effective_date` falls on or before the end of the period
 * being billed supplies the charge. Without this, generating a month early
 * would bill the future rate (§3.3).
 */
async function billableAccounts(
  executor: Executor,
  period: string,
  asOf: string
): Promise<CandidateAccount[]> {
  const periodEnd = `${period}-${String(lastDayOfPeriod(period)).padStart(2, "0")}`;

  // The raw query below aliases `service_accounts` to `sa`, so the correlated
  // subqueries must reference `sa.*` by hand. Interpolating a Drizzle column
  // here would emit `"service_accounts"."id"`, and because the alias hides the
  // original relation name PostgreSQL rejects that with a missing FROM-clause
  // error. Types stay checked at the boundary by the CandidateAccount mapping.
  const effectivePlanId = sql`(select coalesce(
      (select (se.metadata::jsonb ->> 'planId')::uuid
         from service_events se
        where se.service_account_id = sa.id
          and se.event_type = 'PLAN_CHANGED'
          and se.effective_date <= ${periodEnd}::date
        order by se.effective_date desc, se.created_at desc
        limit 1),
      sa.plan_id
    ))`;

  const effectiveRate = sql<number>`coalesce(
      (select (se.metadata::jsonb ->> 'newRateCentavos')::bigint
         from service_events se
        where se.service_account_id = sa.id
          and se.event_type = 'PLAN_CHANGED'
          and se.effective_date <= ${periodEnd}::date
        order by se.effective_date desc, se.created_at desc
        limit 1),
      sa.current_rate_centavos
    )`;

  const rows = await queryRows<CandidateAccountSqlRow>(
    executor,
    sql`
    select
      sa.id,
      sa.service_account_number,
      sa.current_rate_centavos,
      (${effectiveRate})::bigint                                   as effective_rate_centavos,
      sa.billing_start_period,
      sa.billing_due_day,
      (${effectiveRate})::bigint = sp.monthly_price_centavos        as rate_matches_plan,
      sp.installation_fee_centavos,
      sp.name                                                      as plan_name,
      sp.code                                                      as plan_code,
      st.name                                                      as service_type_name,
      coalesce((
        select sum(i.balance_centavos) from invoices i
         where i.service_account_id = sa.id
           and i.period < ${period}
           and i.balance_centavos > 0
           and i.due_date < ${asOf}
           and i.status <> 'VOID'
      ), 0)::bigint                                            as overdue_prior_balance_centavos
    from service_accounts sa
    inner join service_plans sp on ${effectivePlanId} = sp.id
    inner join service_types st on sp.service_type_id = st.id
    where sa.status in ('ACTIVE', 'PENDING_ACTIVATION')
      and sa.billing_start_period <= ${period}
    order by sa.service_account_number asc
  `
  );

  return rows.map((row) => ({
    id: String(row.id),
    serviceAccountNumber: String(row.service_account_number),
    currentRateCentavos: Number(row.current_rate_centavos),
    effectiveRateCentavos: Number(row.effective_rate_centavos),
    billingStartPeriod: String(row.billing_start_period),
    billingDueDay: Number(row.billing_due_day),
    installationFeeCentavos: Number(row.installation_fee_centavos),
    planName: String(row.plan_name),
    planCode: String(row.plan_code),
    serviceTypeName: String(row.service_type_name),
    overduePriorBalanceCentavos: Number(row.overdue_prior_balance_centavos)
  }));
}

export interface InvoiceListQuery {
  q?: string;
  status?: string;
  period?: string;
  serviceAccountId?: string;
  subscriberId?: string;
  collectorId?: string;
  areaId?: string;
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}

export async function listInvoices(executor: Executor, query: InvoiceListQuery) {
  const filters: SQL[] = [ne(invoices.status, "VOID" as never)];
  if (query.status) {
    filters.push(eq(invoices.status, query.status as never));
  }
  if (query.period) {
    filters.push(eq(invoices.period, query.period));
  }
  if (query.serviceAccountId) {
    filters.push(eq(invoices.serviceAccountId, query.serviceAccountId));
  }
  if (query.subscriberId) {
    filters.push(eq(subscribers.id, query.subscriberId));
  }
  if (query.collectorId) {
    filters.push(eq(serviceAccounts.collectorId, query.collectorId));
  }
  if (query.areaId) {
    filters.push(eq(subscribers.collectionAreaId, query.areaId));
  }
  if (query.overdueOnly) {
    filters.push(
      sql`${invoices.balanceCentavos} > 0`,
      lte(invoices.dueDate, new Date().toISOString().slice(0, 10))
    );
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      or(
        ilike(invoices.invoiceNumber, `%${query.q}%`),
        ilike(subscribers.fullName, pattern),
        ilike(subscribers.accountNumber, `%${query.q}%`),
        ilike(serviceAccounts.serviceAccountNumber, `%${query.q}%`)
      )!
    );
  }
  const where = and(...filters);

  // The joins below are always present: the list is filtered and labelled by
  // subscriber, area, collector and plan even when the caller did not ask for
  // those filters.
  const base = executor
    .select({ value: count() })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .leftJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .leftJoin(collectors, eq(serviceAccounts.collectorId, collectors.id))
    .leftJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .leftJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id));

  const [totalRow] = await base.where(where);

  const [sumRow] = await executor
    .select({
      total: sql<number>`coalesce(sum(${invoices.balanceCentavos}), 0)::bigint`
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .leftJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .leftJoin(collectors, eq(serviceAccounts.collectorId, collectors.id))
    .leftJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .leftJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(where);

  const rows = await executor
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      period: invoices.period,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalCentavos: invoices.totalCentavos,
      paidCentavos: invoices.paidCentavos,
      balanceCentavos: invoices.balanceCentavos,
      status: invoices.status,
      serviceAccountId: invoices.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber,
      areaName: collectionAreas.name,
      collectorName: collectors.fullName,
      planName: servicePlans.name,
      serviceType: serviceTypes.code
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .leftJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .leftJoin(collectors, eq(serviceAccounts.collectorId, collectors.id))
    .leftJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .leftJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(where)
    .orderBy(desc(invoices.issueDate), desc(invoices.invoiceNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({
      ...row,
      total: formatCentavos(row.totalCentavos),
      paid: formatCentavos(row.paidCentavos),
      balance: formatCentavos(row.balanceCentavos)
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0,
    totalBalanceCentavos: Number(sumRow?.total ?? 0)
  };
}

export async function getInvoice(executor: Executor, invoiceId: string) {
  const rows = await executor
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      period: invoices.period,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      subtotalCentavos: invoices.subtotalCentavos,
      discountCentavos: invoices.discountCentavos,
      penaltyCentavos: invoices.penaltyCentavos,
      totalCentavos: invoices.totalCentavos,
      paidCentavos: invoices.paidCentavos,
      balanceCentavos: invoices.balanceCentavos,
      status: invoices.status,
      isFinalized: invoices.isFinalized,
      voidReason: invoices.voidReason,
      serviceAccountId: invoices.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber,
      installationAddress: serviceAccounts.installationAddress
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) {
    throw notFound("Invoice", invoiceId);
  }

  const items = await executor
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.sortOrder));

  const allocations = await queryRows<{
    id: string;
    amount_centavos: number;
    allocation_type: string;
    receipt_number: string;
    method: string;
    payment_date: string;
  }>(
    executor,
    sql`
      select pa.id, pa.amount_centavos, pa.allocation_type, p.receipt_number, p.method, p.payment_date
      from payment_allocations pa
      inner join payments p on pa.payment_id = p.id
      where pa.invoice_id = ${invoiceId}
      order by p.payment_date asc, p.receipt_number asc
    `
  );

  return {
    ...invoice,
    items: items.map((item) => ({
      ...item,
      amount: formatCentavos(item.amountCentavos)
    })),
    payments: allocations.map((row) => ({
      id: String(row.id),
      amount: formatCentavos(Number(row.amount_centavos ?? 0)),
      amountCentavos: Number(row.amount_centavos ?? 0),
      allocationType: String(row.allocation_type),
      receiptNumber: String(row.receipt_number),
      method: String(row.method),
      paymentDate: new Date(String(row.payment_date))
    })),
    totals: {
      subtotal: formatCentavos(invoice.subtotalCentavos),
      discount: formatCentavos(invoice.discountCentavos),
      penalty: formatCentavos(invoice.penaltyCentavos),
      total: formatCentavos(invoice.totalCentavos),
      paid: formatCentavos(invoice.paidCentavos),
      balance: formatCentavos(invoice.balanceCentavos)
    }
  };
}

/**
 * Controlled void of a finalized invoice (§3.4).
 *
 * The invoice row survives with `status = 'VOID'` and a reason, a reversing
 * ledger entry restores the subscriber's balance, and a cleared allocation
 * history returns any money that had been applied to it. Nothing is deleted.
 */
export async function voidInvoice(
  executor: Executor,
  invoiceId: string,
  reason: string,
  actor?: Actor
): Promise<{ invoiceId: string; reversedTotalCentavos: number }> {
  const rows = await executor.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const invoice = rows[0];
  if (!invoice) {
    throw notFound("Invoice", invoiceId);
  }
  if (invoice.status === "VOID") {
    throw businessRule("This invoice has already been voided.");
  }
  if (invoice.paidCentavos > 0) {
    throw businessRule(
      "This invoice has payments applied to it. Reverse the payment first, then void the invoice."
    );
  }

  const [voided] = await executor
    .update(invoices)
    .set({
      status: "VOID",
      isFinalized: false,
      voidedAt: new Date(),
      voidedBy: actor?.id ?? null,
      voidReason: reason,
      updatedAt: new Date()
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  // The debit that was posted when the invoice was finalized is undone by an
  // equal and opposite ledger credit, so the running balance stays truthful.
  await postLedgerEntry(executor, {
    serviceAccountId: invoice.serviceAccountId,
    entryDate: new Date().toISOString().slice(0, 10),
    reference: invoice.invoiceNumber,
    description: `Invoice voided: ${reason}`,
    entryType: "INVOICE_VOID",
    creditCentavos: invoice.totalCentavos,
    sourceType: "ADJUSTMENT",
    sourceId: invoice.id,
    actor
  });

  await writeAudit(executor, actor, {
    action: auditActions.INVOICE_VOIDED,
    entityType: "invoice",
    entityId: invoiceId,
    reason,
    changes: {
      status: { old: invoice.status, new: voided.status },
      totalCentavos: { old: invoice.totalCentavos, new: 0 }
    }
  });

  return { invoiceId, reversedTotalCentavos: invoice.totalCentavos };
}

export interface InvoiceAdjustmentInput {
  adjustmentType: "ADJUSTMENT_DEBIT" | "ADJUSTMENT_CREDIT" | "DISCOUNT" | "PENALTY";
  reason: string;
  amountCentavos: number;
}

/**
 * Approved adjustment to a finalized invoice (§3.4).
 *
 * The original total is preserved on the invoice row *and* recorded in
 * `invoice_adjustments` with both the previous and the new total, and a
 * matching ledger entry keeps the balance consistent. This is the "controlled
 * adjustment workflow" the guide requires, as opposed to editing an invoice.
 */
export async function adjustInvoice(
  executor: Executor,
  invoiceId: string,
  input: InvoiceAdjustmentInput,
  actor?: Actor
): Promise<{ previousTotalCentavos: number; newTotalCentavos: number; adjustmentId: string }> {
  const rows = await executor.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const invoice = rows[0];
  if (!invoice) {
    throw notFound("Invoice", invoiceId);
  }
  if (invoice.status === "VOID") {
    throw businessRule("A voided invoice cannot be adjusted.");
  }
  if (invoice.isFinalized === false && invoice.status === "DRAFT") {
    throw businessRule("Draft invoices are edited directly, not adjusted.");
  }
  if (input.amountCentavos <= 0) {
    throw new DomainError("VALIDATION_FAILED", "Adjustment amount must be greater than zero.", 400);
  }

  const isCredit = input.adjustmentType === "ADJUSTMENT_CREDIT" || input.adjustmentType === "DISCOUNT";
  const signedDelta = isCredit ? -input.amountCentavos : input.amountCentavos;
  const newTotal = invoice.totalCentavos + signedDelta;
  if (newTotal < 0) {
    throw businessRule("This adjustment would make the invoice total negative.");
  }

  const newPaid = Math.min(invoice.paidCentavos, newTotal);
  const newBalance = newTotal - newPaid;
  const nextStatus = deriveInvoiceStatus(newBalance, newPaid, invoice.dueDate, invoice.status);

  const [updated] = await executor
    .update(invoices)
    .set({
      totalCentavos: newTotal,
      paidCentavos: newPaid,
      balanceCentavos: newBalance,
      status: nextStatus,
      discountCentavos:
        input.adjustmentType === "DISCOUNT"
          ? invoice.discountCentavos + input.amountCentavos
          : invoice.discountCentavos,
      penaltyCentavos:
        input.adjustmentType === "PENALTY"
          ? invoice.penaltyCentavos + input.amountCentavos
          : invoice.penaltyCentavos,
      updatedAt: new Date()
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  const [adjustment] = await executor
    .insert(invoiceAdjustments)
    .values({
      invoiceId,
      adjustmentType: input.adjustmentType,
      reason: input.reason,
      amountCentavos: signedDelta,
      previousTotalCentavos: invoice.totalCentavos,
      newTotalCentavos: newTotal,
      requestedBy: actor?.id ?? null,
      requestedByName: actor?.displayName ?? null,
      approvedBy: actor?.id ?? null,
      approvedByName: actor?.displayName ?? null,
      approvedAt: new Date()
    })
    .returning();

  await postLedgerEntry(executor, {
    serviceAccountId: invoice.serviceAccountId,
    entryDate: new Date().toISOString().slice(0, 10),
    reference: invoice.invoiceNumber,
    description: `${labelForAdjustment(input.adjustmentType)}: ${input.reason}`,
    entryType: "INVOICE_ADJUSTMENT",
    ...(isCredit ? { creditCentavos: input.amountCentavos } : { debitCentavos: input.amountCentavos }),
    sourceType: "ADJUSTMENT",
    sourceId: adjustment.id,
    actor
  });

  await writeAudit(executor, actor, {
    action: auditActions.INVOICE_ADJUSTED,
    entityType: "invoice",
    entityId: invoiceId,
    reason: input.reason,
    changes: {
      totalCentavos: { old: invoice.totalCentavos, new: updated.totalCentavos },
      balanceCentavos: { old: invoice.balanceCentavos, new: updated.balanceCentavos },
      status: { old: invoice.status, new: updated.status }
    }
  });

  return {
    previousTotalCentavos: invoice.totalCentavos,
    newTotalCentavos: updated.totalCentavos,
    adjustmentId: adjustment.id
  };
}

function labelForAdjustment(type: InvoiceAdjustmentInput["adjustmentType"]): string {
  switch (type) {
    case "DISCOUNT":
      return "Discount applied";
    case "PENALTY":
      return "Penalty applied";
    case "ADJUSTMENT_CREDIT":
      return "Credit adjustment";
    default:
      return "Debit adjustment";
  }
}

/**
 * Recomputes an invoice's status from its balance. A finalized invoice that is
 * unpaid and past its due date reads as OVERDUE, which is a *derived* view: no
 * scheduled job is needed, so the overdue list can never be stale.
 */
export function deriveInvoiceStatus(
  balanceCentavos: number,
  paidCentavos: number,
  dueDate: string,
  currentStatus: InvoiceStatus
): InvoiceStatus {
  if (currentStatus === "VOID" || currentStatus === "DRAFT" || currentStatus === "CREDITED") {
    return currentStatus;
  }
  if (balanceCentavos <= 0) {
    return "PAID";
  }
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) {
    return "OVERDUE";
  }
  return paidCentavos > 0 ? "PARTIALLY_PAID" : "UNPAID";
}

/**
 * Refreshes OVERDUE status for unpaid finalized invoices. Called before
 * receivables queries and by a daily maintenance entry point so that the stored
 * status matches the derived one.
 */
export async function refreshOverdueStatuses(executor: Executor, asOf = new Date()): Promise<number> {
  const today = asOf.toISOString().slice(0, 10);
  const updated = await executor
    .update(invoices)
    .set({ status: "OVERDUE", updatedAt: new Date() })
    .where(
      and(
        inArray(invoices.status, ["UNPAID", "PARTIALLY_PAID"]),
        sql`${invoices.balanceCentavos} > 0`,
        lte(invoices.dueDate, today)
      )
    )
    .returning({ id: invoices.id });
  return updated.length;
}

export async function listBillingCycles(executor: Executor, limit = 24) {
  return executor
    .select()
    .from(billingCycles)
    .orderBy(desc(billingCycles.period))
    .limit(limit);
}

export async function getBillingCycleSummary(executor: Executor, period: string) {
  const rows = await executor
    .select({
      status: invoices.status,
      totalCentavos: sql<number>`coalesce(sum(${invoices.totalCentavos}), 0)::bigint`,
      balanceCentavos: sql<number>`coalesce(sum(${invoices.balanceCentavos}), 0)::bigint`,
      invoiceCount: sql<number>`count(*)::int`
    })
    .from(invoices)
    .where(and(eq(invoices.period, period), ne(invoices.status, "VOID" as never)))
    .groupBy(invoices.status);

  return rows;
}

export async function invoiceExistsForPeriod(
  executor: Executor,
  serviceAccountId: string,
  period: string
): Promise<boolean> {
  const rows = await executor
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.serviceAccountId, serviceAccountId),
        eq(invoices.period, period),
        ne(invoices.status, "VOID" as never)
      )
    )
    .limit(1);
  return rows.length > 0;
}
