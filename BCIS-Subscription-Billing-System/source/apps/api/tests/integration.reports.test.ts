import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction } from "../src/db/client.js";
import { collectionAreas, invoices, servicePlans, serviceTypes, subscribers, serviceAccounts, users } from "../src/db/schema/index.js";
import { adjustInvoice, generateMonthlyBilling } from "../src/services/billing.js";
import { postPayment, reversePayment } from "../src/services/payments.js";
import {
  adjustmentRegister,
  billingVsCollectionReport,
  collectionReport,
  paymentRegister,
  revenueReport
} from "../src/services/reports.js";
import type { Actor } from "../src/services/types.js";

/**
 * Management reports (§3.11) against a real PostgreSQL database.
 *
 * The suite builds a small book of business (two active accounts across two
 * plans, one billing period, two posted payments) and asserts that every report
 * derives exactly the numbers the fixtures imply. The describes run serially and
 * build on the shared set, mirroring how the lab walks through the modules.
 *
 * ## Safety
 *
 * Refuses to run unless the database name ends in `_test`, then truncates,
 * exactly like the other integration suites.
 */

const { db } = getDatabase();

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

const BRONZE_MONTHLY = 150_000; // 1,500.00
const GOLD_MONTHLY = 250_000; // 2,500.00

let officer: Actor;
let areaId: string;
let bronzePlanId: string;
let goldPlanId: string;
let aliceAccountId: string;
let benAccountId: string;
let benPaymentId = "";

/** Noon in Philippines time: immune to the machine's own timezone for these tests. */
function atNoon(date: string): Date {
  return new Date(`${date}T12:00:00+08:00`);
}

async function createArea(name: string): Promise<string> {
  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `AR-${randomUUID().slice(0, 6).toUpperCase()}`, name, description: "Test area" })
    .returning();
  return area.id;
}

async function createPlan(name: string, typeName: string, typeCode: string, monthly: number): Promise<string> {
  const [type] = await db.insert(serviceTypes).values({ code: typeCode, name: typeName }).returning();
  const [plan] = await db
    .insert(servicePlans)
    .values({ code: `p-${randomUUID().slice(0, 6)}`, name, serviceTypeId: type.id, monthlyPriceCentavos: monthly })
    .returning();
  return plan.id;
}

async function createAccount(fullName: string, planId: string): Promise<string> {
  const [subscriber] = await db
    .insert(subscribers)
    .values({
      accountNumber: `ACC-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName,
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
      currentRateCentavos: goldPlanId === planId ? GOLD_MONTHLY : BRONZE_MONTHLY,
      status: "ACTIVE",
      creditBalanceCentavos: 0
    })
    .returning();
  return account.id;
}

async function post(serviceAccountId: string, amount: number, method: "CASH" | "GCASH", date: string): Promise<{ paymentId: string; receiptNumber: string }> {
  return inTransaction(async (tx) => {
    const payment = await postPayment(
      tx,
      { serviceAccountId, amountCentavos: amount, method, paymentDate: atNoon(date) },
      officer
    );
    return { paymentId: String(payment.paymentId), receiptNumber: String(payment.receiptNumber) };
  });
}

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  const [user] = await db
    .insert(users)
    .values({ username: "report.officer", displayName: "Report Officer", passwordHash: "x", passwordSalt: "y" })
    .returning();

  officer = {
    id: user.id,
    username: "report.officer",
    displayName: "Report Officer",
    permissions: ["report.view", "report.export", "payment.create", "payment.reverse", "billing.generate"]
  };

  areaId = await createArea("Brgy Sun");
  bronzePlanId = await createPlan("Bronze 35Mbps", "Copper", "COPPER", BRONZE_MONTHLY);
  goldPlanId = await createPlan("Gold 100Mbps", "Fiber", "FIBER", GOLD_MONTHLY);

  aliceAccountId = await createAccount("Alice Reyes", bronzePlanId);
  benAccountId = await createAccount("Ben Cruz", goldPlanId);

  // One billing cycle, two invoices; both are paid in full, one by cash and one
  // by GCash, posted on different days of September 2026.
  await generateMonthlyBilling({ period: "2026-05" });
  await post(aliceAccountId, BRONZE_MONTHLY, "CASH", "2026-09-10");
  const benPayment = await post(benAccountId, GOLD_MONTHLY, "GCASH", "2026-09-12");
  benPaymentId = benPayment.paymentId;
});

afterAll(async () => {
  await closeDatabase();
});

describe("revenue report", () => {
  it("breaks billed and collected money down by plan, service type and area", async () => {
    const byPlan = await revenueReport(db, { by: "plan" });
    const bronze = byPlan.rows.find((row) => row.dimension === "Bronze 35Mbps");
    const gold = byPlan.rows.find((row) => row.dimension === "Gold 100Mbps");
    expect(bronze).toBeDefined();
    expect(gold).toBeDefined();
    expect(bronze?.billedCentavos).toBe(BRONZE_MONTHLY);
    expect(bronze?.collectedCentavos).toBe(BRONZE_MONTHLY);
    expect(bronze?.outstandingCentavos).toBe(0);
    expect(bronze?.collectionRate).toBe(100);
    expect(gold?.billedCentavos).toBe(GOLD_MONTHLY);
    expect(gold?.collectedCentavos).toBe(GOLD_MONTHLY);

    const byType = await revenueReport(db, { by: "service-type" });
    const copper = byType.rows.find((row) => row.dimension === "Copper");
    const fiber = byType.rows.find((row) => row.dimension === "Fiber");
    expect(copper?.billedCentavos).toBe(BRONZE_MONTHLY);
    expect(fiber?.billedCentavos).toBe(GOLD_MONTHLY);

    const byArea = await revenueReport(db, { by: "area" });
    const sun = byArea.rows.find((row) => row.dimension === "Brgy Sun");
    expect(sun?.billedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
    expect(sun?.collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
  });
});

describe("collection report", () => {
  it("buckets collections daily with a method split", async () => {
    const result = await collectionReport(db, {
      from: "2026-09-01",
      to: "2026-09-30",
      granularity: "daily"
    });
    expect(result.buckets.map((bucket) => bucket.period).sort()).toEqual(["2026-09-10", "2026-09-12"]);
    expect(result.totals.postedCount).toBe(2);
    expect(result.totals.collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
    expect(result.totals.methods.CASH).toBe(BRONZE_MONTHLY);
    expect(result.totals.methods.GCASH).toBe(GOLD_MONTHLY);

    const byDay = new Map(result.buckets.map((bucket) => [bucket.period, bucket]));
    expect(byDay.get("2026-09-10")?.methods.CASH).toBe(BRONZE_MONTHLY);
    expect(byDay.get("2026-09-10")?.postedCount).toBe(1);
    expect(byDay.get("2026-09-12")?.methods.GCASH).toBe(GOLD_MONTHLY);
  });

  it("collapses the same window into a week, a month and a year", async () => {
    const weekly = await collectionReport(db, { from: "2026-09-01", to: "2026-09-30", granularity: "weekly" });
    expect(weekly.buckets.length).toBe(1);
    expect(weekly.totals.collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);

    const monthly = await collectionReport(db, { from: "2026-09-01", to: "2026-09-30", granularity: "monthly" });
    expect(monthly.buckets.map((bucket) => bucket.period)).toEqual(["2026-09"]);
    expect(monthly.totals.postedCount).toBe(2);

    const annual = await collectionReport(db, { from: "2026-09-01", to: "2026-09-30", granularity: "annual" });
    expect(annual.buckets.map((bucket) => bucket.period)).toEqual(["2026"]);
    expect(annual.totals.collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
  });

  it("defaults to the current month and monthly granularity", async () => {
    const result = await collectionReport(db, {});
    expect(result.granularity).toBe("monthly");
    expect(result.buckets.map((bucket) => bucket.period)).toEqual(["2026-09"]);
    expect(result.totals.collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
  });
});

describe("billing vs collection", () => {
  it("shows a 100% collection rate when every bill is paid", async () => {
    const result = await billingVsCollectionReport(db, { from: "2026-05", to: "2026-05" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].period).toBe("2026-05");
    expect(result.rows[0].billedCount).toBe(2);
    expect(result.rows[0].billedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
    expect(result.rows[0].collectedCentavos).toBe(BRONZE_MONTHLY + GOLD_MONTHLY);
    expect(result.rows[0].outstandingCentavos).toBe(0);
    expect(result.rows[0].collectionRate).toBe(100);
  });

  it("shows the shortfall after a payment is reversed", async () => {
    await inTransaction(async (tx) => {
      await reversePayment(tx, benPaymentId, "Office reversal test", officer);
    });

    const result = await billingVsCollectionReport(db, { from: "2026-05", to: "2026-05" });
    expect(result.rows[0].collectedCentavos).toBe(BRONZE_MONTHLY);
    expect(result.rows[0].outstandingCentavos).toBe(GOLD_MONTHLY);
    expect(result.rows[0].collectionRate).toBe(37.5);
  });
});

describe("payments register", () => {
  const register = async () =>
    paymentRegister(db, { page: 1, pageSize: 20 });

  it("lists every issued receipt including the reversed one", async () => {
    const result = await register();
    expect(result.total).toBe(2);
    expect(result.totals.postedCount).toBe(1);
    expect(result.totals.postedCentavos).toBe(BRONZE_MONTHLY);

    const alice = result.items.find((row) => row.subscriberName === "Alice Reyes");
    const ben = result.items.find((row) => row.subscriberName === "Ben Cruz");

    expect(alice?.status).toBe("POSTED");
    expect(alice?.method).toBe("CASH");
    expect(alice?.amountCentavos).toBe(BRONZE_MONTHLY);
    expect(alice?.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);

    expect(ben?.status).toBe("REVERSED");
    expect(ben?.amountCentavos).toBe(GOLD_MONTHLY);
    expect(ben?.reversalReason).toBe("Office reversal test");
    expect(ben?.voidReason).toBeTruthy();
  });

  it("filters by method, search text and date window", async () => {
    const onlyGcash = await paymentRegister(db, { page: 1, pageSize: 10, method: "GCASH" });
    expect(onlyGcash.total).toBe(1);
    expect(onlyGcash.items[0].subscriberName).toBe("Ben Cruz");

    const byName = await paymentRegister(db, { page: 1, pageSize: 10, q: "Alice" });
    expect(byName.total).toBe(1);
    expect(byName.items[0].subscriberName).toBe("Alice Reyes");

    const inWindow = await paymentRegister(db, { page: 1, pageSize: 10, from: "2026-09-12", to: "2026-09-30" });
    expect(inWindow.total).toBe(1);
    expect(inWindow.items[0].subscriberName).toBe("Ben Cruz");
  });
});

describe("adjustment register", () => {
  it("records the invoice correction with requester and approval trail", async () => {
    const [invoiceRow] = await db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.serviceAccountId, aliceAccountId))
      .limit(1);
    expect(invoiceRow).toBeDefined();

    await adjustInvoice(db, invoiceRow!.id, { adjustmentType: "DISCOUNT", reason: "Loyalty discount", amountCentavos: 20_000 }, officer);

    const result = await adjustmentRegister(db, { page: 1, pageSize: 10 });
    expect(result.total).toBe(1);
    expect(result.items[0].invoiceNumber).toBe(invoiceRow!.invoiceNumber);
    expect(result.items[0].adjustmentType).toBe("DISCOUNT");
    expect(result.items[0].amountCentavos).toBe(-20_000);
    expect(result.items[0].previousTotalCentavos).toBe(BRONZE_MONTHLY);
    expect(result.items[0].newTotalCentavos).toBe(BRONZE_MONTHLY - 20_000);
    expect(result.items[0].requestedByName).toBe("Report Officer");
    expect(result.items[0].subscriberName).toBe("Alice Reyes");
  });
});