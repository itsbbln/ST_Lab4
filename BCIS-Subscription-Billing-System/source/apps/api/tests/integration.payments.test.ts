import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction, queryRows } from "../src/db/client.js";
import { collectionAreas, invoices, ledgerEntries, serviceAccounts, servicePlans, serviceTypes, subscribers } from "../src/db/schema/index.js";
import { generateMonthlyBilling } from "../src/services/billing.js";
import { accountBalance, listLedger } from "../src/services/ledger.js";
import { getPayment, postPayment, previewAllocation, reversePayment, submitGcashProof, verifyGcashProof } from "../src/services/payments.js";

/**
 * End-to-end money tests against a real PostgreSQL database.
 *
 * These exist because TypeScript cannot see a missing FROM-clause alias or a
 * window function evaluated after its own WHERE clause. Both of those bugs were
 * written, typechecked cleanly, and would only have surfaced when a real
 * customer hit the screen. So the flow below is exercised against real tables.
 *
 * ## Safety
 *
 * The suite refuses to run unless the target database name ends in `_test`, and
 * it truncates only after that check. `source/.env` points at the working
 * database, so running this by accident would otherwise be destructive.
 */

const { db, pool } = getDatabase();

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against database "${name}". ` +
        "Set DATABASE_URL to a database whose name ends in _test."
    );
  }
}

/**
 * Empties the database so each run starts from a known state.
 *
 * Earlier versions of this suite only truncated the financial tables, which
 * meant every run left behind another service account. The next run's billing
 * then invoiced all of them, and assertions like "one invoice was created"
 * failed for reasons that had nothing to do with the code under test. The
 * suite is only ever pointed at a `_test` database, so wiping it entirely is
 * both safe and the only way to keep runs independent.
 */
async function resetDatabase(): Promise<void> {
  await db.execute(`
    truncate table
      audit_logs, receipts, payment_reversals, payment_allocations, payment_proofs,
      ledger_entries, payments, invoice_items, invoice_adjustments, invoices, billing_cycles,
      document_sequences, application_settings,
      service_events, service_devices, service_accounts, subscriber_addresses,
      subscribers, service_plans, service_types, collection_areas,
      collection_routes, collector_assignments, collection_batches, batch_accounts,
      collector_remittances, collectors, technicians, attachments,
      reconnection_records, suspension_records, backup_history,
      sessions, users, user_roles, role_permissions, roles, permissions
    restart identity cascade`);
}

let accountId: string;
let subscriberId: string;
let planId: string;
const MONTHLY = 150_000; // 1,500.00

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  const [type] = await db
    .insert(serviceTypes)
    .values({ code: `t-${randomUUID().slice(0, 6)}`, name: "Test Broadband" })
    .returning();
  const [plan] = await db
    .insert(servicePlans)
    .values({
      code: `p-${randomUUID().slice(0, 6)}`,
      name: "Test Plan",
      serviceTypeId: type.id,
      monthlyPriceCentavos: MONTHLY,
      installationFeeCentavos: 0
    })
    .returning();
  planId = plan.id;

  // A subscriber cannot exist without a collection area: the column is NOT NULL
  // and the foreign key is ON DELETE RESTRICT, because doorstep collection is
  // organised by area.
  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Test Area" })
    .returning();

  const [subscriber] = await db
    .insert(subscribers)
    .values({
      accountNumber: `ACC-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: "Integration Test Subscriber",
      contactNumber: "09170000000",
      addressLine: "1 Test Street",
      city: "Manila",
      collectionAreaId: area.id,
      billingDueDay: 5
    })
    .returning();
  subscriberId = subscriber.id;

  const [account] = await db
    .insert(serviceAccounts)
    .values({
      serviceAccountNumber: `SA-${randomUUID().slice(0, 8).toUpperCase()}`,
      subscriberId,
      planId,
      installationAddress: "1 Test Street",
      activationDate: "2026-01-01",
      billingStartPeriod: "2026-01",
      billingDueDay: 5,
      currentRateCentavos: MONTHLY,
      status: "ACTIVE"
    })
    .returning();
  accountId = account.id;
});

afterAll(async () => {
  await resetDatabase();
  await closeDatabase();
  await pool.end().catch(() => undefined);
});

describe("billing then payment, end to end", () => {
  it("generates an invoice whose rate comes from the plan, and debits the ledger", async () => {
    const result = await inTransaction((tx) => generateMonthlyBilling({ period: "2026-01", applyPenalty: false }));
    expect(result.created).toBe(1);
    expect(result.totalBilledCentavos).toBe(MONTHLY);
    expect(result.invoiceNumbers).toHaveLength(1);

    const { balanceCentavos } = await accountBalance(db, accountId);
    expect(balanceCentavos).toBe(MONTHLY);
  });

  it("does not bill the same period twice", async () => {
    const result = await inTransaction((tx) => generateMonthlyBilling({ period: "2026-01", applyPenalty: false }));
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("previews the allocation without writing anything", async () => {
    const before = await accountBalance(db, accountId);
    const preview = await previewAllocation(db, accountId, MONTHLY);

    expect(preview.allocations).toHaveLength(1);
    expect(preview.allocations[0].amountCentavos).toBe(MONTHLY);
    expect(preview.advanceCentavos).toBe(0);

    const after = await accountBalance(db, accountId);
    expect(after.balanceCentavos).toBe(before.balanceCentavos);
  });

  it("posts a payment that clears the invoice, credits the ledger, and leaves no advance", async () => {
    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: accountId, amountCentavos: MONTHLY, method: "CASH" })
    );

    expect(payment.allocatedCentavos).toBe(MONTHLY);
    expect(payment.advanceCentavos).toBe(0);
    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0].allocationType).toBe("AUTO");
    expect(payment.balanceAfterCentavos).toBe(0);

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.serviceAccountId, accountId))
      .limit(1);
    expect(invoice.paidCentavos).toBe(MONTHLY);
    expect(invoice.balanceCentavos).toBe(0);
    expect(invoice.status).toBe("PAID");

    // Debit for the invoice, credit for the cash: back to zero.
    const { balanceCentavos } = await accountBalance(db, accountId);
    expect(balanceCentavos).toBe(0);
  });

  it("holds an overpayment as advance instead of losing it", async () => {
    // February must exist first: January was just paid in full, so an
    // overpayment with nothing open would correctly become advance outright.
    await inTransaction((tx) => generateMonthlyBilling({ period: "2026-02", applyPenalty: false }));

    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: accountId, amountCentavos: MONTHLY + 25_000, method: "CASH" })
    );

    expect(payment.allocatedCentavos).toBe(MONTHLY);
    expect(payment.advanceCentavos).toBe(25_000);
    // Advance is a credit, so the account is 250.00 in the subscriber's favour.
    expect(payment.balanceAfterCentavos).toBe(-25_000);
  });

  it("spends the advance on the next month's invoice instead of leaving it idle", async () => {
    const result = await inTransaction((tx) => generateMonthlyBilling({ period: "2026-03", applyPenalty: false }));
    expect(result.created).toBe(1);
    expect(result.totalBilledCentavos).toBe(MONTHLY);
    expect(result.appliedAdvanceCentavos).toBe(25_000);
    expect(result.netCollectibleCentavos).toBe(MONTHLY - 25_000);

    const march = await db
      .select()
      .from(invoices)
      .where(eq(invoices.period, "2026-03"))
      .limit(1);
    expect(march[0].paidCentavos).toBe(25_000);
    expect(march[0].balanceCentavos).toBe(MONTHLY - 25_000);

    // The March debit is on the ledger, but the advance already paid part of
    // it, so what is owed shrinks rather than the cash being counted twice.
    const { balanceCentavos } = await accountBalance(db, accountId);
    expect(balanceCentavos).toBe(MONTHLY - 25_000);
  });

  it("keeps the payment's allocation invariant intact", async () => {
    const rows = await queryRows<{
      amount_centavos: number;
      allocated_centavos: number;
      credit_applied_centavos: number;
      advance_centavos: number;
    }>(
      db,
      sql`
        select amount_centavos, allocated_centavos, credit_applied_centavos, advance_centavos
        from payments where service_account_id = ${accountId}`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.allocated_centavos + row.credit_applied_centavos + row.advance_centavos).toBe(
        row.amount_centavos
      );
    }
  });

  it("reverses a payment, restores the invoice, and debits the ledger back", async () => {
    // March is still partly open, so a small payment lands on it and can be
    // reversed with a real allocation to unwind.
    const before = await accountBalance(db, accountId);
    const open = await db
      .select()
      .from(invoices)
      .where(eq(invoices.serviceAccountId, accountId))
      .orderBy(invoices.period)
      .limit(1);
    const target = open[0];
    const paidBefore = target.paidCentavos;

    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: accountId, amountCentavos: 10_000, method: "CASH" })
    );
    expect(payment.allocatedCentavos).toBe(10_000);

    const reversal = await inTransaction((tx) =>
      reversePayment(tx, payment.paymentId, "Integration test reversal", undefined)
    );

    expect(reversal.creditRestoredCentavos).toBe(10_000);
    expect(reversal.unallocatedCentavos).toBe(0);
    expect(reversal.reversalNumber).toBeTruthy();

    const [afterInvoice] = await db.select().from(invoices).where(eq(invoices.id, target.id)).limit(1);
    expect(afterInvoice.paidCentavos).toBe(paidBefore);

    // The reversal debit is the exact mirror of the original credit.
    const after = await accountBalance(db, accountId);
    expect(after.balanceCentavos).toBe(before.balanceCentavos);
  });

  it("refuses to reverse the same payment twice", async () => {
    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: accountId, amountCentavos: 5_000, method: "CASH" })
    );
    await inTransaction((tx) => reversePayment(tx, payment.paymentId, "First reversal", undefined));
    await expect(
      inTransaction((tx) => reversePayment(tx, payment.paymentId, "Second reversal", undefined))
    ).rejects.toThrow(/already been reversed/i);
  });

  it("returns receipt allocation details with the current invoice paid status", async () => {
    const [freshAccount] = await db
      .insert(serviceAccounts)
      .values({
        serviceAccountNumber: `SA-${randomUUID().slice(0, 8).toUpperCase()}`,
        subscriberId,
        planId,
        installationAddress: "2 Test Street",
        activationDate: "2026-01-01",
        billingStartPeriod: "2026-01",
        billingDueDay: 5,
        currentRateCentavos: MONTHLY,
        status: "ACTIVE"
      })
      .returning();
    await inTransaction((tx) => generateMonthlyBilling({ period: "2026-11", applyPenalty: false }));
    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: freshAccount.id, amountCentavos: 50_000, method: "CASH" })
    );

    const detail = await getPayment(db, payment.paymentId);

    expect(detail.receiptNumber).toBe(payment.receiptNumber);
    expect(detail.allocations).toHaveLength(1);
    expect(detail.allocations[0]).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      invoiceTotalCentavos: MONTHLY,
      invoicePaidCentavos: 50_000,
      invoiceBalanceCentavos: MONTHLY - 50_000
    });
    expect(detail.allocations[0].invoiceTotal).toContain("1,500.00");
    expect(detail.allocations[0].invoicePaid).toContain("500.00");
    expect(detail.allocations[0].invoiceBalance).toContain("1,000.00");
  });
});

describe("GCash approval", () => {
  it("records a claim without moving money, then posts on approval", async () => {
    const before = await accountBalance(db, accountId);

    const proof = await inTransaction((tx) =>
      submitGcashProof(
        tx,
        {
          serviceAccountId: accountId,
          referenceNumber: `GC-${randomUUID().slice(0, 8).toUpperCase()}`,
          senderName: "Juan Dela Cruz",
          amountCentavos: 20_000
        },
        undefined
      )
    );
    expect(proof.status).toBe("PENDING");

    // A screenshot alone is not money.
    const midway = await accountBalance(db, accountId);
    expect(midway.balanceCentavos).toBe(before.balanceCentavos);

    const review = await inTransaction((tx) =>
      verifyGcashProof(tx, proof.id, { approved: true }, undefined)
    );
    expect(review.status).toBe("VERIFIED");
    expect(review.payment).not.toBeNull();
    expect(review.payment?.amountCentavos).toBe(20_000);

    const after = await accountBalance(db, accountId);
    expect(after.balanceCentavos).toBe(before.balanceCentavos - 20_000);
  });

  it("rejects without posting anything", async () => {
    const before = await accountBalance(db, accountId);
    const proof = await inTransaction((tx) =>
      submitGcashProof(
        tx,
        {
          serviceAccountId: accountId,
          referenceNumber: `GC-${randomUUID().slice(0, 8).toUpperCase()}`,
          senderName: "Maria Santos",
          amountCentavos: 30_000
        },
        undefined
      )
    );

    const review = await inTransaction((tx) =>
      verifyGcashProof(tx, proof.id, { approved: false, rejectionReason: "Screenshot is unreadable" }, undefined)
    );
    expect(review.status).toBe("REJECTED");
    expect(review.payment).toBeNull();

    const after = await accountBalance(db, accountId);
    expect(after.balanceCentavos).toBe(before.balanceCentavos);
  });

  it("will not approve the same GCash reference twice", async () => {
    const referenceNumber = `GC-${randomUUID().slice(0, 8).toUpperCase()}`;
    const first = await inTransaction((tx) =>
      submitGcashProof(
        tx,
        { serviceAccountId: accountId, referenceNumber, senderName: "Ana Reyes", amountCentavos: 7_500 },
        undefined
      )
    );
    await inTransaction((tx) => verifyGcashProof(tx, first.id, { approved: true }, undefined));

    // A second claim on a reference that is already cash is refused outright.
    await expect(
      inTransaction((tx) =>
        submitGcashProof(
          tx,
          { serviceAccountId: accountId, referenceNumber, senderName: "Ana Reyes", amountCentavos: 7_500 },
          undefined
        )
      )
    ).rejects.toThrow(/already been verified/i);
  });
});

describe("statement of account", () => {
  it("carries the opening balance into the running balance and reconciles", async () => {
    const { balanceCentavos: accountTotal } = await accountBalance(db, accountId);

    const all = await listLedger(db, accountId, { page: 1, pageSize: 200 });
    expect(all.openingBalanceCentavos).toBe(0);
    expect(all.closingBalanceCentavos).toBe(accountTotal);
    expect(all.items.at(-1)?.balanceCentavos).toBe(accountTotal);

    // Every running balance must equal debits less credits to that point. This
    // is the property that broke when the window was evaluated after the date
    // filter.
    let running = 0;
    for (const item of all.items) {
      running += item.debitCentavos - item.creditCentavos;
      expect(item.balanceCentavos).toBe(running);
    }
  });

  it("keeps a dated range consistent with the account balance", async () => {
    const { balanceCentavos: accountTotal } = await accountBalance(db, accountId);
    const rows = await db
      .select({ date: ledgerEntries.entryDate })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.serviceAccountId, accountId))
      .orderBy(ledgerEntries.entryDate);
    expect(rows.length).toBeGreaterThan(1);

    const firstDate = String(rows[0].date).slice(0, 10);
    const ranged = await listLedger(db, accountId, { from: firstDate, page: 1, pageSize: 200 });

    // Nothing exists before the first entry, so a range starting there must
    // still reconcile to the live balance.
    expect(ranged.openingBalanceCentavos).toBe(0);
    expect(ranged.closingBalanceCentavos).toBe(accountTotal);
    expect(ranged.items[0].balanceCentavos).toBe(
      ranged.items[0].debitCentavos - ranged.items[0].creditCentavos
    );
  });

  it("reports the same closing balance regardless of page size", async () => {
    const small = await listLedger(db, accountId, { page: 1, pageSize: 5 });
    const large = await listLedger(db, accountId, { page: 1, pageSize: 200 });
    // The small page returns 5 of many rows; its closing figure must still be
    // the account's true balance, not the sum of the 5 rows on screen.
    expect(small.closingBalanceCentavos).toBe(large.closingBalanceCentavos);
    expect(small.total).toBe(large.total);
  });
});
