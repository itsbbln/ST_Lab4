import { sql } from "drizzle-orm";

import { queryRows, type Executor } from "../db/client.js";

/**
 * Database integrity checks (§4.5, AT-12).
 *
 * These are the checks the guide asks for after a restore ("restored database
 * passes integrity check") and the ones the owner runs before trusting a
 * report. Each one is a single aggregate statement, so the whole suite stays
 * cheap even against the §4.5 target scale of 500,000 invoices.
 *
 * ## Why these are arithmetic identities, not row counts
 *
 * "No column is NULL" proves nothing about money. The only way to show a ledger
 * balance is right is to state the identity it must satisfy and then ask
 * PostgreSQL whether any row violates it:
 *
 * ```
 * ledger balance  =  SUM(finalized invoice totals)  -  SUM(posted payments)
 * ```
 *
 * That identity is the one documented in `ledger.ts`, and
 * `ledger_matches_receivables` below is the database-level proof of it. If a
 * future change ever posted an unbalanced entry, this check fails instead of the
 * discrepancy surfacing in a report printed for the owner.
 *
 * Every check states its invariant in `references`, so a failure is
 * self-describing in the acceptance-test evidence.
 */

export type IntegritySeverity = "ERROR" | "WARNING";

export interface IntegrityCheck {
  /** Stable identifier, e.g. `ledger_matches_receivables`. */
  name: string;
  /** The invariant in words. */
  description: string;
  passed: boolean;
  severity: IntegritySeverity;
  /** How many records violate the invariant. Zero when healthy. */
  violations: number;
  /** The offending keys, capped so a systemic failure does not return 500k rows. */
  samples: string[];
  /** The invariant restated formally. */
  references: string;
}

export interface IntegrityReport {
  /** True when no check failed. A WARNING failure also clears `passed`. */
  passed: boolean;
  checkedAt: string;
  total: number;
  failed: number;
  checks: IntegrityCheck[];
}

/** Caps the sample list so a systemic failure stays a readable response. */
const SAMPLE_LIMIT = 10;

interface CountRow extends Record<string, unknown> {
  violations: number;
}

interface SampledRow extends Record<string, unknown> {
  violations: number;
  labels: string[] | null;
}

/** A check that only needs a violation count. */
async function countCheck(
  executor: Executor,
  spec: {
    name: string;
    description: string;
    references: string;
    query: Parameters<typeof queryRows>[1];
    severity?: IntegritySeverity;
  }
): Promise<IntegrityCheck> {
  const rows = await queryRows<CountRow>(executor, spec.query);
  const violations = Number(rows[0]?.violations ?? 0);
  return {
    name: spec.name,
    description: spec.description,
    passed: violations === 0,
    severity: spec.severity ?? "ERROR",
    violations,
    samples: [],
    references: spec.references
  };
}

/**
 * A check that also names the offending records.
 *
 * Each such statement is written as a `with offending as (...)` CTE and then
 * counts the CTE while aggregating a bounded sample out of it. The count is
 * therefore exact even when the sample is truncated, and it still costs one
 * round trip.
 */
async function sampledCheck(
  executor: Executor,
  spec: {
    name: string;
    description: string;
    references: string;
    query: Parameters<typeof queryRows>[1];
  }
): Promise<IntegrityCheck> {
  const rows = await queryRows<SampledRow>(executor, spec.query);
  const violations = Number(rows[0]?.violations ?? 0);
  return {
    name: spec.name,
    description: spec.description,
    passed: violations === 0,
    severity: "ERROR",
    violations,
    samples: (rows[0]?.labels ?? []).map(String),
    references: spec.references
  };
}

/**
 * Runs every integrity check.
 *
 * A check that finds corruption is data, not an exception, so nothing here
 * throws for a failed check: the caller needs the list. Only a genuine database
 * failure propagates, which is a different situation entirely.
 */
export async function runIntegrityChecks(executor: Executor): Promise<IntegrityReport> {
  const checks: IntegrityCheck[] = [];

  // --- Money conservation on the payment header ---------------------------
  //
  // A posted payment's amount is fully explained by three buckets:
  //   - `allocated`       -> matched to a specific invoice by this payment
  //   - `advance`         -> unallocated cash this payment left on account
  //   - `credit_applied`  -> pre-existing advance this payment consumed
  //
  // The third bucket is not redundant. When a later payment draws down an
  // earlier payment's advance, the earlier row's `advance` shrinks while the
  // later row's `credit_applied` grows by the same amount, leaving both rows'
  // sums constant. A check that omitted it would report a false violation on
  // every correct advance-payment sequence, which is exactly what AT-03 covers.
  checks.push(
    await sampledCheck(executor, {
      name: "payment_amount_is_fully_explained",
      description:
        "Every posted payment's amount equals its allocated, advance and consumed-advance totals.",
      references: "amount_centavos = allocated_centavos + advance_centavos + credit_applied_centavos",
      query: sql`
        with offending as (
          select receipt_number as label
          from payments
          where status = 'POSTED'
            and amount_centavos <> allocated_centavos + advance_centavos + credit_applied_centavos
        )
        select
          (select count(*)::int from offending) as violations,
          coalesce(
            (select array_agg(label order by label) from (select label from offending order by label limit ${SAMPLE_LIMIT}) s),
            '{}'
          ) as labels
      `
    })
  );

  checks.push(
    await countCheck(executor, {
      name: "payment_buckets_are_not_negative",
      description: "Allocated, advance and consumed-advance amounts are never negative.",
      references:
        "allocated_centavos >= 0 and advance_centavos >= 0 and credit_applied_centavos >= 0",
      severity: "WARNING",
      query: sql`
        select count(*)::int as violations
        from payments
        where allocated_centavos < 0 or advance_centavos < 0 or credit_applied_centavos < 0
      `
    })
  );

  // --- Invoice arithmetic --------------------------------------------------
  //
  // `total = subtotal - discount + penalty` and `balance = total - paid` are
  // the two formulas the printed invoice shows, so if either drifts the document
  // and the ledger disagree.
  checks.push(
    await sampledCheck(executor, {
      name: "invoice_total_matches_its_components",
      description: "Each invoice total equals subtotal less discount plus penalty.",
      references: "total_centavos = subtotal_centavos - discount_centavos + penalty_centavos",
      query: sql`
        with offending as (
          select invoice_number as label
          from invoices
          where total_centavos <> subtotal_centavos - discount_centavos + penalty_centavos
        )
        select
          (select count(*)::int from offending) as violations,
          coalesce(
            (select array_agg(label order by label) from (select label from offending order by label limit ${SAMPLE_LIMIT}) s),
            '{}'
          ) as labels
      `
    })
  );

  checks.push(
    await countCheck(executor, {
      name: "invoice_balance_matches_amount_paid",
      description: "Each live invoice's balance equals its total less what has been paid.",
      references: "balance_centavos = total_centavos - paid_centavos",
      query: sql`
        select count(*)::int as violations
        from invoices
        where status <> 'VOID'
          and balance_centavos <> total_centavos - paid_centavos
      `
    })
  );

  // --- Allocation agrees with the invoice ---------------------------------
  //
  // `paid_centavos` is a denormalized running total maintained by the payment
  // service; the allocation rows are the detail behind it. If the two disagree,
  // an invoice shows a paid figure no allocation supports.
  checks.push(
    await countCheck(executor, {
      name: "invoice_paid_equals_its_allocations",
      description: "An invoice's paid total equals the sum of allocations from posted payments.",
      references:
        "paid_centavos = sum(payment_allocations.amount_centavos joined to POSTED payments)",
      query: sql`
        select count(*)::int as violations
        from invoices i
        left join (
          select a.invoice_id, sum(a.amount_centavos)::bigint as allocated
          from payment_allocations a
          join payments p on p.id = a.payment_id
          where p.status = 'POSTED'
          group by a.invoice_id
        ) alloc on alloc.invoice_id = i.id
        where i.status <> 'VOID'
          and i.paid_centavos <> coalesce(alloc.allocated, 0)
      `
    })
  );

  // --- The ledger identity -------------------------------------------------
  //
  // For every service account, the ledger running balance must equal billed
  // less collected. A negative result is advance on account and is expected; a
  // mismatch is a real defect, and this is the check that would catch one.
  checks.push(
    await sampledCheck(executor, {
      name: "ledger_matches_receivables",
      description:
        "Each account's ledger balance equals its finalized invoice totals less its posted payments.",
      references:
        "sum(ledger.debit - ledger.credit) = sum(invoice.total where not VOID) - sum(payment.amount where POSTED)",
      query: sql`
        with ledger as (
          select service_account_id, sum(debit_centavos - credit_centavos)::bigint as balance
          from ledger_entries
          group by service_account_id
        ),
        billed as (
          select service_account_id, sum(total_centavos)::bigint as total
          from invoices
          where status <> 'VOID'
          group by service_account_id
        ),
        collected as (
          select service_account_id, sum(amount_centavos)::bigint as total
          from payments
          where status = 'POSTED'
          group by service_account_id
        ),
        accounts as (
          select service_account_id from ledger
          union
          select service_account_id from billed
          union
          select service_account_id from collected
        ),
        offending as (
          select a.service_account_id as label
          from accounts a
          left join ledger on ledger.service_account_id = a.service_account_id
          left join billed on billed.service_account_id = a.service_account_id
          left join collected on collected.service_account_id = a.service_account_id
          where coalesce(ledger.balance, 0)
                <> coalesce(billed.total, 0) - coalesce(collected.total, 0)
        )
        select
          (select count(*)::int from offending) as violations,
          coalesce(
            (select array_agg(label order by label) from (select label from offending order by label limit ${SAMPLE_LIMIT}) s),
            '{}'
          ) as labels
      `
    })
  );

  checks.push(
    await countCheck(executor, {
      name: "allocation_never_exceeds_invoice",
      description: "No single allocation line is larger than the invoice it settles.",
      references: "payment_allocations.amount_centavos <= invoices.total_centavos",
      query: sql`
        select count(*)::int as violations
        from payment_allocations a
        join invoices i on i.id = a.invoice_id
        where a.amount_centavos > i.total_centavos
      `
    })
  );

  // --- Receipt register ----------------------------------------------------
  //
  // §3.11 requires unique receipt numbers that are never reused. Uniqueness is
  // a database index; this checks the complementary property that every payment
  // is backed by a register row. A shortfall would mean a payment row was
  // deleted outright, which §2.3 forbids.
  checks.push(
    await countCheck(executor, {
      name: "every_payment_has_a_receipt_record",
      description:
        "Each payment has a receipt register row, including reversed and voided ones.",
      references: "count(receipts) = count(payments)",
      query: sql`
        select
          (select count(*)::int from payments) - (select count(*)::int from receipts)
          as violations
      `
    })
  );

  checks.push(
    await countCheck(executor, {
      name: "reversed_payments_have_a_reversal_record",
      description: "A payment marked REVERSED always has a linked, numbered reversal row.",
      references: "payments.status = 'REVERSED' implies an existing payment_reversals row",
      query: sql`
        select count(*)::int as violations
        from payments p
        where p.status = 'REVERSED'
          and not exists (select 1 from payment_reversals r where r.payment_id = p.id)
      `
    })
  );

  // --- One invoice per service account and period --------------------------
  //
  // This is AT-11 enforced continuously rather than only by a test. The unique
  // index on `(service_account_id, period)` for non-void invoices already makes
  // this impossible, so a non-zero result means the constraint was dropped.
  checks.push(
    await countCheck(executor, {
      name: "no_duplicate_billing_periods",
      description: "No service account is billed twice for the same period.",
      references: "count(distinct period) per live service account = 1",
      query: sql`
        select count(*)::int as violations
        from (
          select service_account_id, period
          from invoices
          where status <> 'VOID'
          group by service_account_id, period
          having count(*) > 1
        ) duplicates
      `
    })
  );

  return {
    passed: checks.every((check) => check.passed),
    checkedAt: new Date().toISOString(),
    total: checks.length,
    failed: checks.filter((check) => !check.passed).length,
    checks
  };
}
