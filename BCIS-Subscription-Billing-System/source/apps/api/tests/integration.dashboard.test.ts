import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../src/db/client.js";
import {
  collectionAreas,
  collectionBatches,
  collectors,
  invoices,
  paymentAllocations,
  paymentProofs,
  payments,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers,
  users
} from "../src/db/schema/index.js";
import { buildDashboard } from "../src/services/dashboard.js";
import { accountArrearsSnapshot } from "../src/services/receivables.js";
import type { Actor } from "../src/services/types.js";

/**
 * Tests for the management dashboard (AT-07, §4.1).
 *
 * The dashboard is the one screen a reviewer opens first, and it is the easiest
 * place in the system to quietly be wrong: every figure is an aggregate, an
 * aggregate can be computed from the wrong table, and a wrong total on a tile is
 * not obviously wrong to the person reading it. So these tests are written around
 * the mistakes that are actually available here:
 *
 *  - **An empty database must not throw.** The tiles have to render before any
 *    data exists. This is the test that would have caught a wrong column name in
 *    one of the aggregates, because every query is executed, not just the ones
 *    the fixtures happen to reach.
 *  - **Reversed payments and voided invoices are excluded**, and a test asserts
 *    that a reversal *changes* the total - an aggregate that silently ignored
 *    `status` would pass a suite that only ever inserted POSTED rows.
 *  - **A payment is counted at `payment_date`, not `created_at`**, because an
 *    operator backdating a receipt is routine and the day's cash must follow the
 *    money, not the keystroke.
 *  - **Suspension is a property of the service account, not the subscriber**
 *    (§4.2). A suspended account is still a receivable; a terminated one is not.
 *  - **The arrears table is filtered by permission server-side**, so it is
 *    asserted on the service result rather than on what a renderer chooses to
 *    draw.
 */

const { db, pool } = getDatabase();

const MONTHLY = 150_000; // 1,500.00

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

/**
 * Clears the transactional data but keeps the reference rows.
 *
 * The area, service type, plan and collector are created once in `beforeAll`
 * and referenced by id from every fixture. Truncating them between tests would
 * leave those ids dangling and every insert would fail on a foreign key, so this
 * leaves the directory alone and only empties what a test actually writes.
 */
async function resetFinancialData(): Promise<void> {
  await db.execute(`
    truncate table
      audit_logs, receipts, payment_reversals, payment_allocations, payment_proofs,
      ledger_entries, payments, invoice_items, invoice_adjustments, invoices, billing_cycles,
      document_sequences, application_settings, sessions,
      service_events, service_devices, service_accounts, subscriber_addresses, subscribers,
      collection_routes, collector_assignments, collection_batches, batch_accounts,
      collector_remittances, attachments, reconnection_records, suspension_records,
      backup_history
    restart identity cascade`);
}

let owner: Actor;
let areaId: string;
let planId: string;
let collectorId: string;

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  const [user] = await db
    .insert(users)
    .values({
      username: "bcis-dashboard-owner",
      displayName: "Dashboard Owner",
      passwordHash: "not-a-real-hash",
      passwordSalt: "not-a-real-salt"
    })
    .returning();

  owner = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    permissions: ["receivables.view", "billing.view", "collection.view", "payment.view"]
  };

  const [area] = await db
    .insert(collectionAreas)
    .values({ code: "DASH", name: "Dashboard Test Area" })
    .returning();
  areaId = area.id;

  const [type] = await db
    .insert(serviceTypes)
    .values({ code: "DASH-T", name: "Dashboard Test Type" })
    .returning();

  const [plan] = await db
    .insert(servicePlans)
    .values({
      code: "DASH-P",
      name: "Dashboard Test Plan",
      serviceTypeId: type.id,
      monthlyPriceCentavos: MONTHLY
    })
    .returning();
  planId = plan.id;

  const [collector] = await db
    .insert(collectors)
    .values({ code: "DASH-C1", fullName: "Dashboard Collector", contactNumber: "09170000001" })
    .returning();
  collectorId = collector.id;
});

beforeEach(async () => {
  // `users` survives `resetFinancialData`, so the owner created in `beforeAll`
  // - and the id that `posted_by` points at - stays valid throughout.
  await resetFinancialData();
});

afterAll(async () => {
  await closeDatabase();
});

/** Creates a subscriber plus a service account, and returns both ids. */
async function newAccount(
  options: {
    status?: "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED" | "DISCONNECTED" | "TERMINATED";
    name?: string;
  } = {}
): Promise<{ subscriberId: string; accountId: string }> {
  const [subscriber] = await db
    .insert(subscribers)
    .values({
      accountNumber: `ACC-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: options.name ?? "Dashboard Subscriber",
      contactNumber: "09170000000",
      addressLine: "1 Test Street",
      city: "Manila",
      collectionAreaId: areaId,
      billingDueDay: 5
    })
    .returning();

  const [account] = await db
    .insert(serviceAccounts)
    .values({
      serviceAccountNumber: `SA-${randomUUID().slice(0, 8).toUpperCase()}`,
      subscriberId: subscriber.id,
      planId,
      installationAddress: "1 Test Street",
      activationDate: "2026-01-01",
      billingStartPeriod: "2026-01",
      billingDueDay: 5,
      currentRateCentavos: MONTHLY,
      status: options.status ?? "ACTIVE"
    })
    .returning();

  return { subscriberId: subscriber.id, accountId: account.id };
}

let receiptCounter = 0;
let invoiceCounter = 0;

interface InvoiceOptions {
  totalCentavos: number;
  paidCentavos?: number;
  status?: "DRAFT" | "UNPAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "VOID";
  issueDate?: string;
  dueDate?: string;
  /**
   * Billing period. `(service_account_id, period)` is unique, which is the
   * database's guard against generating the same subscriber's invoice twice, so
   * a test that needs two invoices on one account must give them two periods.
   */
  period?: string;
}

/**
 * Writes an invoice with a consistent `paid_centavos` / `balance_centavos` pair.
 *
 * The pair has to agree or the dashboard - which reads `balance_centavos` - would
 * be tested against rows the billing service could never produce, and the
 * integrity check would reject them.
 */
async function newInvoice(accountId: string, options: InvoiceOptions): Promise<string> {
  const paid = options.paidCentavos ?? 0;
  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: `INV-${String(++invoiceCounter).padStart(6, "0")}`,
      serviceAccountId: accountId,
      period: options.period ?? "2026-01",
      issueDate: options.issueDate ?? "2026-01-01",
      dueDate: options.dueDate ?? "2026-01-05",
      subtotalCentavos: options.totalCentavos,
      discountCentavos: 0,
      penaltyCentavos: 0,
      totalCentavos: options.totalCentavos,
      paidCentavos: paid,
      balanceCentavos: options.totalCentavos - paid,
      status: options.status ?? "UNPAID",
      rateSnapshotCentavos: MONTHLY,
      isFinalized: true
    })
    .returning();
  return invoice.id;
}

interface PaymentOptions {
  amountCentavos: number;
  invoiceId?: string;
  method?: "CASH" | "GCASH" | "BANK_TRANSFER" | "CHEQUE" | "OTHER";
  status?: "POSTED" | "REVERSED";
  paymentDate?: Date;
}

/**
 * Posts a payment, allocating it to an invoice so the receivable actually falls.
 */
async function newPayment(
  account: { subscriberId: string; accountId: string },
  options: PaymentOptions
): Promise<string> {
  const [payment] = await db
    .insert(payments)
    .values({
      receiptNumber: `OR-${String(++receiptCounter).padStart(6, "0")}`,
      serviceAccountId: account.accountId,
      subscriberId: account.subscriberId,
      paymentDate: options.paymentDate ?? new Date("2026-01-10T09:00:00Z"),
      amountCentavos: options.amountCentavos,
      method: options.method ?? "CASH",
      status: options.status ?? "POSTED",
      postedBy: owner.id,
      postedByName: owner.displayName,
      allocatedCentavos: 0,
      advanceCentavos: 0,
      creditAppliedCentavos: 0
    })
    .returning();

  return payment.id;
}

/** Allocates an existing payment to an invoice, keeping both sides' totals in step. */
async function allocate(paymentId: string, invoiceId: string, amountCentavos: number): Promise<void> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);

  await db
    .insert(paymentAllocations)
    .values({ paymentId, invoiceId, amountCentavos, allocationType: "AUTO" });

  await db
    .update(payments)
    .set({ allocatedCentavos: payment.allocatedCentavos + amountCentavos })
    .where(eq(payments.id, paymentId));

  const paid = invoice.paidCentavos + amountCentavos;
  const balance = invoice.totalCentavos - paid;
  await db
    .update(invoices)
    .set({
      paidCentavos: paid,
      balanceCentavos: balance,
      // A reversal credits the invoice back rather than voiding it, so the status
      // still has to follow the new balance.
      status: balance <= 0 ? "PAID" : "PARTIALLY_PAID"
    })
    .where(eq(invoices.id, invoiceId));
}

/**
 * Unwinds an allocation against an invoice, the way `reversePayment` does.
 *
 * The allocation row itself is kept for history - a reversal is recorded, not
 * erased - so the invoice is returned to an outstanding balance while the
 * payment remains POSTED/REVERSED for the ledger to see.
 */
async function creditBack(invoiceId: string, amountCentavos: number): Promise<void> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const paid = invoice.paidCentavos - amountCentavos;
  const balance = invoice.totalCentavos - paid;

  await db
    .update(invoices)
    .set({
      paidCentavos: paid,
      balanceCentavos: balance,
      status: balance <= 0 ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID"
    })
    .where(eq(invoices.id, invoiceId));
}

describe("dashboard (AT-07)", () => {
  it("renders every figure on an empty database without throwing", async () => {
    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.period).toEqual({ from: "2026-01-01", to: "2026-01-31", days: 31 });
    expect(summary.subscribers).toEqual({ total: 0, active: 0, inactive: 0, newInPeriod: 0 });
    expect(summary.accounts).toEqual({
      total: 0,
      pendingActivation: 0,
      active: 0,
      suspended: 0,
      disconnected: 0,
      terminated: 0
    });
    expect(summary.receivables).toEqual({
      currentCentavos: 0,
      current: expect.any(String),
      overdueCentavos: 0,
      overdue: expect.any(String),
      totalOutstandingCentavos: 0,
      totalOutstanding: expect.any(String),
      overdueAccounts: 0,
      collectionRate: 0
    });
    expect(summary.collections).toEqual({
      receivedCentavos: 0,
      received: expect.any(String),
      paymentsInPeriod: 0,
      averagePayment: expect.any(String),
      byMethod: []
    });
    expect(summary.gcash).toEqual({ pending: 0, verifiedInPeriod: 0, rejectedInPeriod: 0 });
    expect(summary.billing).toEqual({
      issuedInPeriod: 0,
      paidInPeriod: 0,
      voidedInPeriod: 0,
      outstandingInvoices: 0
    });
    expect(summary.collectionBatches).toEqual({
      open: 0,
      inProgress: 0,
      submitted: 0,
      remitted: 0,
      reconciled: 0,
      uncollectedCentavos: 0,
      uncollected: expect.any(String)
    });
    expect(summary.topOverdue).toEqual([]);
  });

  it("defaults the window to today and accepts a single day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const summary = await buildDashboard(db, {}, owner);
    expect(summary.period).toEqual({ from: today, to: today, days: 1 });
  });

  it("counts a subscriber as active and never as suspended", async () => {
    await newAccount({ name: "Active Person" });
    await newAccount({ status: "SUSPENDED", name: "Suspended Person" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.subscribers.total).toBe(2);
    expect(summary.subscribers.active).toBe(2);
    // Suspension belongs to the service account, so the subscriber count must not
    // drop and the account count must.
    expect(summary.accounts.total).toBe(2);
    expect(summary.accounts.active).toBe(1);
    expect(summary.accounts.suspended).toBe(1);
  });

  it("sums outstanding invoice balances, and separates overdue from current", async () => {
    const account = await newAccount();
    // Not yet due at 2026-01-31, so this is *current* receivable.
    await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-02-05", period: "2026-01" });
    await newInvoice(account.accountId, { totalCentavos: 50_000, dueDate: "2026-03-05", period: "2026-02" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.receivables.currentCentavos).toBe(200_000);
    expect(summary.receivables.current).toBe("₱2,000.00");
    expect(summary.receivables.overdueCentavos).toBe(0);
    expect(summary.receivables.totalOutstandingCentavos).toBe(200_000);
    expect(summary.receivables.totalOutstanding).toBe("₱2,000.00");
  });

  it("excludes a voided invoice from receivable and billing counts", async () => {
    const account = await newAccount();
    await newInvoice(account.accountId, { totalCentavos: 150_000, period: "2026-01" });
    await newInvoice(account.accountId, { totalCentavos: 90_000, status: "VOID", period: "2026-02" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.receivables.totalOutstandingCentavos).toBe(150_000);
    expect(summary.receivables.overdueCentavos).toBe(150_000);
    expect(summary.billing.issuedInPeriod).toBe(1);
    expect(summary.billing.voidedInPeriod).toBe(1);
  });

  it("keeps a suspended account receivable but drops a terminated one", async () => {
    const suspended = await newAccount({ status: "SUSPENDED" });
    await newInvoice(suspended.accountId, { totalCentavos: 150_000, dueDate: "2026-12-31" });

    const terminated = await newAccount({ status: "TERMINATED" });
    await newInvoice(terminated.accountId, { totalCentavos: 150_000, dueDate: "2026-12-31" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);
    expect(summary.receivables.totalOutstandingCentavos).toBe(150_000);
  });

  it("splits overdue out of current and counts the overdue accounts", async () => {
    const late = await newAccount({ name: "Late Payer" });
    await newInvoice(late.accountId, { totalCentavos: 150_000, dueDate: "2026-01-05" });

    const current = await newAccount({ name: "Current Payer" });
    await newInvoice(current.accountId, {
      totalCentavos: 75_000,
      issueDate: "2026-01-28",
      dueDate: "2026-12-31"
    });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.receivables.totalOutstandingCentavos).toBe(225_000);
    expect(summary.receivables.currentCentavos).toBe(75_000);
    expect(summary.receivables.overdueCentavos).toBe(150_000);
    expect(summary.receivables.overdueAccounts).toBe(1);
    // The invariant the aging report is built on.
    expect(summary.receivables.totalOutstandingCentavos).toBe(
      summary.receivables.currentCentavos + summary.receivables.overdueCentavos
    );
  });

  it("lists the largest overdue accounts first", async () => {
    const small = await newAccount({ name: "Small Arrears" });
    await newInvoice(small.accountId, { totalCentavos: 25_000, dueDate: "2026-01-05" });

    const large = await newAccount({ name: "Large Arrears" });
    await newInvoice(large.accountId, { totalCentavos: 175_000, dueDate: "2026-01-05" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.topOverdue).toHaveLength(2);
    expect(summary.topOverdue?.[0].subscriberName).toBe("Large Arrears");
    expect(summary.topOverdue?.[0].amount).toBe("₱1,750.00");
    expect(summary.topOverdue?.[1].subscriberName).toBe("Small Arrears");
  });

  it("omits the arrears table from a caller without receivables.view", async () => {
    const account = await newAccount();
    await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-01-05" });

    const collector: Actor = { ...owner, permissions: ["collection.view"] };
    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, collector);

    // The tiles a collector is entitled to are still present...
    expect(summary.subscribers.total).toBe(1);
    // ...but the named arrears list, which identifies individual debtors, is not.
    expect(summary.topOverdue).toBeUndefined();
  });

  it("counts collections in the window by payment date, not created date", async () => {
    const account = await newAccount();
    await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-01-05" });
    const invoiceId = await newInvoice(account.accountId, {
      totalCentavos: 150_000,
      issueDate: "2026-01-28",
      dueDate: "2026-12-31",
      period: "2026-02"
    });

    // Created inside the window but the money moved in December.
    const paymentId = await newPayment(account, {
      amountCentavos: 60_000,
      paymentDate: new Date("2025-12-30T10:00:00Z")
    });
    await allocate(paymentId, invoiceId, 60_000);

    const january = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);
    expect(january.collections.receivedCentavos).toBe(0);
    expect(january.collections.paymentsInPeriod).toBe(0);

    const wide = await buildDashboard(db, { from: "2025-12-01", to: "2026-01-31" }, owner);
    expect(wide.collections.receivedCentavos).toBe(60_000);
    expect(wide.collections.received).toBe("₱600.00");
    expect(wide.collections.paymentsInPeriod).toBe(1);
  });

  it("excludes a reversed payment from collections and from the collection rate", async () => {
    const account = await newAccount();
    const invoiceId = await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-01-05" });

    const paymentId = await newPayment(account, {
      amountCentavos: 150_000,
      paymentDate: new Date("2026-01-10T10:00:00Z"),
      status: "REVERSED"
    });
    await allocate(paymentId, invoiceId, 150_000);

    // Then the reversal itself: `reversePayment` credits the allocation back, so
    // the invoice is outstanding again. Modelled explicitly here because the
    // dashboard must show a receivable that the reversal created.
    await creditBack(invoiceId, 150_000);

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.collections.receivedCentavos).toBe(0);
    expect(summary.collections.paymentsInPeriod).toBe(0);
    expect(summary.receivables.collectionRate).toBe(0);
    // The invoice was credited back, so it is receivable again - and it is past
    // its due date, so it lands in the overdue column.
    expect(summary.receivables.overdueCentavos).toBe(150_000);
    expect(summary.receivables.currentCentavos).toBe(0);
    expect(summary.receivables.totalOutstandingCentavos).toBe(150_000);
  });

  it("breaks collections down by method", async () => {
    const account = await newAccount();
    await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-12-31" });

    await newPayment(account, { amountCentavos: 10_000, method: "CASH" });
    await newPayment(account, { amountCentavos: 30_000, method: "GCASH" });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.collections.receivedCentavos).toBe(40_000);
    expect(summary.collections.averagePayment).toBe("₱200.00");
    expect(summary.collections.byMethod).toEqual([
      { method: "GCASH", count: 1, amountCentavos: 30_000, amount: "₱300.00" },
      { method: "CASH", count: 1, amountCentavos: 10_000, amount: "₱100.00" }
    ]);
  });

  it("reports the GCash verification queue", async () => {
    const account = await newAccount();

    await db.insert(paymentProofs).values({
      serviceAccountId: account.accountId,
      referenceNumber: "GC-1",
      senderName: "Pending Sender",
      amountCentavos: 10_000
    });
    await db.insert(paymentProofs).values({
      serviceAccountId: account.accountId,
      referenceNumber: "GC-2",
      senderName: "Verified Sender",
      amountCentavos: 20_000,
      status: "VERIFIED",
      verifiedAt: new Date("2026-01-12T08:00:00Z")
    });
    await db.insert(paymentProofs).values({
      serviceAccountId: account.accountId,
      referenceNumber: "GC-3",
      senderName: "Rejected Sender",
      amountCentavos: 30_000,
      status: "REJECTED",
      verifiedAt: new Date("2026-01-13T08:00:00Z")
    });

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);
    expect(summary.gcash).toEqual({ pending: 1, verifiedInPeriod: 1, rejectedInPeriod: 1 });
  });

  it("counts batch statuses and the outstanding uncollected amount", async () => {
    await db.insert(collectionBatches).values([
      {
        batchNumber: "BATCH-1",
        areaId,
        collectorId,
        batchDate: "2026-01-10",
        status: "OPEN",
        uncollectedCentavos: 40_000
      },
      {
        batchNumber: "BATCH-2",
        areaId,
        collectorId,
        batchDate: "2026-01-10",
        status: "IN_PROGRESS",
        uncollectedCentavos: 10_000
      },
      {
        batchNumber: "BATCH-3",
        areaId,
        collectorId,
        batchDate: "2026-01-09",
        status: "RECONCILED",
        uncollectedCentavos: 0
      }
    ]);

    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.collectionBatches.open).toBe(1);
    expect(summary.collectionBatches.inProgress).toBe(1);
    expect(summary.collectionBatches.reconciled).toBe(1);
    // A reconciled batch is history; its shortfall must not be carried forward.
    expect(summary.collectionBatches.uncollectedCentavos).toBe(50_000);
    expect(summary.collectionBatches.uncollected).toBe("₱500.00");
  });

  it("rejects a malformed or inverted reporting window", async () => {
    await expect(buildDashboard(db, { from: "not-a-date" }, owner)).rejects.toThrow(
      /must be a calendar date/
    );
    await expect(buildDashboard(db, { from: "2026-02-01", to: "2026-01-01" }, owner)).rejects.toThrow(
      /must not be after/
    );
  });

  it("agrees with the receivables snapshot the owner already trusts", async () => {
    const account = await newAccount();
    const invoiceId = await newInvoice(account.accountId, { totalCentavos: 150_000, dueDate: "2026-01-05" });
    const paymentId = await newPayment(account, { amountCentavos: 50_000, method: "GCASH" });
    await allocate(paymentId, invoiceId, 50_000);

    // One account in the database, so the global dashboard totals and this
    // account's own snapshot have to be the same numbers. If the two ever drift,
    // the suspension record and the dashboard would be quoting different debts
    // for the same subscriber.
    const snapshot = await accountArrearsSnapshot(db, account.accountId, { asOf: "2026-01-31" });
    const summary = await buildDashboard(db, { from: "2026-01-01", to: "2026-01-31" }, owner);

    expect(summary.receivables.currentCentavos).toBe(snapshot.currentCentavos);
    expect(summary.receivables.overdueCentavos).toBe(snapshot.overdueCentavos);
    expect(summary.receivables.totalOutstandingCentavos).toBe(
      snapshot.currentCentavos + snapshot.overdueCentavos
    );
    // Half of 1,500.00 was collected, and the rest fell due on the 5th.
    expect(summary.receivables.overdueCentavos).toBe(100_000);
    expect(summary.receivables.currentCentavos).toBe(0);
    expect(summary.topOverdue?.[0].daysOverdue).toBe(snapshot.oldestDaysPastDue);
  });
});
