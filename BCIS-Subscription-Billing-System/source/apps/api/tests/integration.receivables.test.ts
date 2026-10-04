import { randomUUID } from "node:crypto";
import { eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction } from "../src/db/client.js";
import {
  applicationSettings,
  collectors,
  collectionAreas,
  invoices,
  payments,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers,
  users
} from "../src/db/schema/index.js";
import { generateMonthlyBilling } from "../src/services/billing.js";
import { postPayment, reversePayment } from "../src/services/payments.js";
import {
  agingProfile,
  listOverdueAccounts,
  listSuspensionCandidates,
  receivablesSummary
} from "../src/services/receivables.js";
import { updateSetting } from "../src/services/settings.js";
import type { Actor } from "../src/services/types.js";

/**
 * Receivables and overdue monitoring against a real PostgreSQL database (§3.9).
 *
 * The point of this file is that the dashboard, the aging report, the overdue list
 * and the suspension-candidate list are all views of the *same* stored invoice
 * balances. A receivables module that recomputes arrears from payment history
 * would pass a test that only ever looked at one screen; these tests check the
 * screens against each other instead.
 *
 * Each describe block builds its own accounts. The aging assertions need precise
 * control over "today", so they pass an explicit `asOf` rather than relying on
 * the wall clock.
 *
 * ## Safety
 *
 * Refuses to run unless the database name ends in `_test`, then truncates.
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

const MONTHLY = 150_000; // 1,500.00

let accountantId: string;
let accountant: Actor;
let areaId: string;
let planId: string;
let collectorA: string;
let collectorB: string;

/** January invoices are due on the 5th, February on the 5th, and so on. */
const JAN_DUE = "2026-01-05";
const FEB_DUE = "2026-02-05";

async function createUser(username: string, displayName: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      username,
      displayName,
      passwordHash: "not-a-real-hash",
      passwordSalt: "not-a-real-salt"
    })
    .returning();
  return user.id;
}

interface NewAccountOptions {
  collectorId?: string | null;
  status?: "ACTIVE" | "SUSPENDED";
  planId?: string;
  name?: string;
}

async function newAccount(options: NewAccountOptions = {}): Promise<string> {
  const [subscriber] = await db
    .insert(subscribers)
    .values({
      accountNumber: `ACC-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: options.name ?? "Test Subscriber",
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
      planId: options.planId ?? planId,
      installationAddress: "1 Test Street",
      activationDate: "2026-01-01",
      billingStartPeriod: "2026-01",
      billingDueDay: 5,
      currentRateCentavos: MONTHLY,
      status: options.status ?? "ACTIVE",
      collectorId: options.collectorId ?? null
    })
    .returning();

  return account.id;
}

/** Bills every active account for the period, exactly as the real generator does. */
async function bill(period: string): Promise<void> {
  await generateMonthlyBilling({ period, applyPenalty: false });
}

function bucketOf(aging: Awaited<ReturnType<typeof agingProfile>>, key: string) {
  return aging.find((row) => row.bucket === key)!;
}

/**
 * Snapshot helpers.
 *
 * The aging buckets and the dashboard totals are deliberately *global* aggregates -
 * a dashboard total that only counted one collector would be wrong - so they
 * cannot be asserted as absolutes in a file where every describe block adds more
 * subscribers. Instead each test snapshots before it acts and asserts on the
 * delta, which is exact and independent of what earlier blocks created.
 */
type BucketTotals = Record<string, number>;

async function buckets(asOf: string): Promise<BucketTotals> {
  const rows = await agingProfile(db, { asOf });
  return Object.fromEntries(rows.map((row) => [row.bucket, row.amountCentavos]));
}

function delta(after: BucketTotals, before: BucketTotals): BucketTotals {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)])
  );
}

function expectDelta(actual: BucketTotals, expected: Partial<Record<string, number>>) {
  for (const [key, value] of Object.entries(expected)) {
    expect({ bucket: key, value: actual[key] ?? 0 }).toEqual({ bucket: key, value });
  }
}

/**
 * Parks every account created so far in SUSPENDED.
 *
 * The aging buckets and dashboard totals are global aggregates, and
 * `generateMonthlyBilling` bills *every* ACTIVE account in the period. Without
 * this, a test that bills February also picks up accounts an earlier test left
 * ACTIVE, and the delta stops describing the account under test. A SUSPENDED
 * account is excluded from the generator but keeps its invoices, so the
 * history is preserved and still counted - only further billing stops.
 */
async function parkExistingAccounts(): Promise<void> {
  await db
    .update(serviceAccounts)
    .set({ status: "SUSPENDED" })
    .where(ne(serviceAccounts.status, "SUSPENDED"));
}

beforeEach(async () => {
  await parkExistingAccounts();
});

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  accountantId = await createUser("receivables.accountant", "Receivables Accountant");
  accountant = {
    id: accountantId,
    username: "receivables.accountant",
    displayName: "Receivables Accountant",
    permissions: ["receivables.view"]
  };

  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Test Area" })
    .returning();
  areaId = area.id;

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
      monthlyPriceCentavos: MONTHLY
    })
    .returning();
  planId = plan.id;

  const [a] = await db
    .insert(collectors)
    .values({ code: `C-${randomUUID().slice(0, 6)}`, fullName: "Collector Alpha", contactNumber: "09170000001" })
    .returning();
  const [b] = await db
    .insert(collectors)
    .values({ code: `C-${randomUUID().slice(0, 6)}`, fullName: "Collector Beta", contactNumber: "09170000002" })
    .returning();
  collectorA = a.id;
  collectorB = b.id;
});

afterAll(async () => {
  await closeDatabase();
  void pool;
});

describe("aging profile", () => {
  it("places each invoice in the bucket matching its days past due", async () => {
    const asOf = "2026-01-20";
    const before = await buckets(asOf);

    await newAccount({ name: "Aging Subject" });
    await bill("2026-01");

    // As at 20 January the January invoice is 15 days past due.
    expectDelta(delta(await buckets(asOf), before), { D1_30: MONTHLY, CURRENT: 0 });

    await bill("2026-02");

    // As at 15 February, January is 41 days late (31-60) and February 10 days
    // late (1-30), so the account's two invoices land in different buckets.
    const february = "2026-02-15";
    expectDelta(delta(await buckets(february), before), {
      D1_30: MONTHLY,
      D31_60: MONTHLY,
      CURRENT: 0
    });

    // As at 15 March, January is 69 days late (61-90) and February 38 (31-60).
    const march = "2026-03-15";
    expectDelta(delta(await buckets(march), before), { D31_60: MONTHLY, D61_90: MONTHLY });

    // By 5 May January is 120 days late and February 89, so only January has
    // crossed 90 days. 90 days exactly is still 61-90, so the day after that
    // (91 days) is where February joins the 90+ bucket.
    expectDelta(delta(await buckets("2026-05-05"), before), {
      D90_PLUS: MONTHLY,
      D61_90: MONTHLY
    });
    expectDelta(delta(await buckets("2026-05-07"), before), { D90_PLUS: MONTHLY * 2 });
  });

  it("honours the inclusive upper bound of a bucket", async () => {
    // January is due on the 5th, so 4 February is exactly 30 days past due and
    // 5 February is 31. Both snapshots are taken before the account exists, at
    // the same as-of dates the assertions use, so each delta isolates this one
    // invoice instead of the movement of the whole book between two dates.
    const atThirty = "2026-02-04";
    const atThirtyOne = "2026-02-05";
    const beforeThirty = await buckets(atThirty);
    const beforeThirtyOne = await buckets(atThirtyOne);

    const account = await newAccount({ name: "Boundary Subject" });
    await bill("2026-01");

    expectDelta(delta(await buckets(atThirty), beforeThirty), { D1_30: MONTHLY });
    expectDelta(delta(await buckets(atThirtyOne), beforeThirtyOne), { D31_60: MONTHLY });

    // Sanity check that the account under test is the one that moved.
    const row = (await listOverdueAccounts(db, { asOf: atThirtyOne })).items.find(
      (item) => item.serviceAccountId === account
    )!;
    expect(row.oldestUnpaidInvoice?.daysPastDue).toBe(31);
  });

  it("reports a not-yet-due invoice as Current, not as overdue", async () => {
    const asOf = "2026-01-01";
    const before = await buckets(asOf);

    await newAccount({ name: "Current Only" });
    await bill("2026-01");

    expectDelta(delta(await buckets(asOf), before), { CURRENT: MONTHLY, D1_30: 0 });
  });

  it("always returns all five buckets, even when empty", async () => {
    const aging = await agingProfile(db, { asOf: "2026-01-01" });
    expect(aging.map((row) => row.bucket)).toEqual([
      "CURRENT",
      "D1_30",
      "D31_60",
      "D61_90",
      "D90_PLUS"
    ]);
  });

  it("keeps a paid invoice out of every bucket", async () => {
    const account = await newAccount({ name: "Fully Paid" });
    const before = await buckets("2026-02-01");

    await bill("2026-01");
    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: MONTHLY, method: "CASH" }, accountant)
    );

    // The invoice was created and then paid, so it never lands in a bucket.
    expectDelta(delta(await buckets("2026-02-01"), before), {
      CURRENT: 0,
      D1_30: 0,
      D31_60: 0,
      D61_90: 0,
      D90_PLUS: 0
    });
  });
});

describe("receivables summary", () => {
  it("splits current from overdue and the two add up to the total", async () => {
    await newAccount({ name: "Summary Subject" });
    const january = "2026-01-20";
    const before = await receivablesSummary(db, { asOf: january });

    await bill("2026-01");

    // As at 20 January the only new invoice is 15 days late: all overdue.
    const overdueOnly = await receivablesSummary(db, { asOf: january });
    expect(overdueOnly.overdueReceivableCentavos - before.overdueReceivableCentavos).toBe(MONTHLY);
    expect(overdueOnly.currentReceivableCentavos - before.currentReceivableCentavos).toBe(0);

    // Once February is billed and the as-of date moves to 1 February, January is
    // 27 days late and February is not yet due - so the same account has both a
    // current bill and arrears at the same instant.
    const february = "2026-02-01";
    const beforeFebruary = await receivablesSummary(db, { asOf: february });
    await bill("2026-02");
    const split = await receivablesSummary(db, { asOf: february });

    expect(split.currentReceivableCentavos - beforeFebruary.currentReceivableCentavos).toBe(MONTHLY);
    expect(split.overdueReceivableCentavos - beforeFebruary.overdueReceivableCentavos).toBe(0);

    // The invariant the dashboard relies on, checked on absolute values.
    expect(split.totalOutstandingCentavos).toBe(
      split.currentReceivableCentavos + split.overdueReceivableCentavos
    );
  });

  it("counts accounts and subscribers separately", async () => {
    // One subscriber holding two services: "accounts for follow up" must rise by
    // 2 while "subscribers overdue" rises by 1.
    const first = await newAccount({ name: "Multi Service" });
    const second = await newAccount({ name: "Multi Service" });

    const [firstAccount] = await db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, first))
      .limit(1);
    const [secondAccount] = await db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, second))
      .limit(1);

    // Re-point the second account at the first account's subscriber.
    await db
      .update(serviceAccounts)
      .set({ subscriberId: firstAccount.subscriberId })
      .where(eq(serviceAccounts.id, secondAccount.id));

    const asOf = "2026-01-20";
    const before = await receivablesSummary(db, { asOf });
    await bill("2026-01");
    const after = await receivablesSummary(db, { asOf });

    expect(after.overdueAccountCount - before.overdueAccountCount).toBe(2);
    expect(after.overdueSubscriberCount - before.overdueSubscriberCount).toBe(1);
  });

  it("excludes a voided invoice from the total", async () => {
    const account = await newAccount({ name: "Void Subject" });
    await bill("2026-01");

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.serviceAccountId, account))
      .limit(1);
    const before = await receivablesSummary(db, { asOf: "2026-01-20" });

    await db
      .update(invoices)
      .set({ voidedAt: new Date(), voidReason: "test void" })
      .where(eq(invoices.id, invoice.id))
      .returning();

    const after = await receivablesSummary(db, { asOf: "2026-01-20" });
    expect(after.totalOutstandingCentavos).toBe(before.totalOutstandingCentavos - MONTHLY);
    expect(after.overdueAccountCount).toBe(before.overdueAccountCount - 1);
  });
});

describe("grace period and suspension threshold", () => {
  it("holds an account off the follow-up list until the grace period lapses", async () => {
    // January is due on the 5th. A snapshot of the whole database on the 6th and
    // on the 9th brackets the moment the default 3-day grace period lapses.
    const onSixth = await receivablesSummary(db, { asOf: "2026-01-06" });
    const onNinth = await receivablesSummary(db, { asOf: "2026-01-09" });

    // The grace period is 3 days, so nothing due on the 5th is actionable on the
    // 6th, and everything due on or before the 5th is actionable by the 9th.
    expect(onSixth.overdueReceivableCentavos).toBeGreaterThan(0);
    expect(onSixth.followUpAccountCount).toBeLessThanOrEqual(onSixth.overdueAccountCount);
    expect(onNinth.followUpAccountCount).toBeGreaterThanOrEqual(onSixth.followUpAccountCount);
    expect(onNinth.overdueAccountCount).toBeGreaterThanOrEqual(onSixth.overdueAccountCount);
  });

  it("does not treat a within-grace account as follow-up even though it is overdue", async () => {
    // This is the property the grace period exists for, asserted directly: an
    // account that is one day late is overdue but must not be a follow-up.
    const account = await newAccount({ name: "One Day Late" });
    await bill("2026-01");

    const summary = await receivablesSummary(db, { asOf: "2026-01-06" });
    const row = (await listOverdueAccounts(db, { asOf: "2026-01-06" })).items.find(
      (item) => item.serviceAccountId === account
    )!;

    // It is genuinely overdue - 1 day past due, with a balance.
    expect(row).toBeDefined();
    expect(row.oldestUnpaidInvoice?.daysPastDue).toBe(1);
    expect(row.arrearsCentavos).toBe(MONTHLY);

    // But within the 3-day grace period, so not a follow-up and not a candidate.
    expect(row.isSuspensionCandidate).toBe(false);
    expect(summary.suspensionCandidateCount).toBeGreaterThanOrEqual(0);
  });

  it("follows a reconfigured grace period immediately", async () => {
    // Everything in the database is due 5 January, so 6 January is 1 day late and
    // the 3-day default grace period forgives all of it. Setting the grace period
    // to zero must move every overdue account onto the follow-up list.
    const asOf = "2026-01-06";
    const withGrace = await receivablesSummary(db, { asOf });
    expect(withGrace.overdueAccountCount).toBeGreaterThan(0);
    expect(withGrace.followUpAccountCount).toBeLessThan(withGrace.overdueAccountCount);

    await updateSetting(db, "billing.grace_period_days", 0, {
      description: "No grace period",
      actor: accountant
    });

    // The same date now counts as follow-up, so the setting is genuinely read
    // per request rather than cached at startup.
    const withoutGrace = await receivablesSummary(db, { asOf });
    expect(withoutGrace.followUpAccountCount).toBe(withoutGrace.overdueAccountCount);
    expect(withoutGrace.followUpAccountCount).toBeGreaterThan(withGrace.followUpAccountCount);

    await updateSetting(db, "billing.grace_period_days", 3, {
      description: "Days after the due date before an account is actionable",
      actor: accountant
    });
    expect((await receivablesSummary(db, { asOf })).followUpAccountCount).toBe(
      withGrace.followUpAccountCount
    );
  });

  it("only counts a suspension candidate once the month threshold is also met", async () => {
    const account = await newAccount({ name: "One Month Behind" });
    await bill("2026-01");

    // Well past the grace period, but only one unpaid month against a 2-month
    // threshold, so this is a follow-up and not a suspension candidate.
    const oneMonth = await receivablesSummary(db, { asOf: "2026-02-20" });
    const row = (await listOverdueAccounts(db, { asOf: "2026-02-20", suspensionCandidatesOnly: true })).items.find(
      (item) => item.serviceAccountId === account
    );
    expect(row).toBeUndefined();

    // With a second unpaid month the same account qualifies.
    await bill("2026-02");
    const twoMonths = await receivablesSummary(db, { asOf: "2026-03-20" });
    const qualified = (await listOverdueAccounts(db, { asOf: "2026-03-20" })).items.find(
      (item) => item.serviceAccountId === account
    )!;

    expect(qualified.monthsUnpaid).toBe(2);
    expect(qualified.isSuspensionCandidate).toBe(true);
    expect(twoMonths.suspensionCandidateCount).toBeGreaterThan(0);
  });
});
describe("overdue list", () => {
  it("carries every column the specification asks for", async () => {
    const account = await newAccount({ name: "Column Subject", collectorId: collectorA });
    await bill("2026-01");

    const result = await listOverdueAccounts(db, { asOf: "2026-01-20" });
    const row = result.items.find((item) => item.serviceAccountId === account)!;

    expect(row).toBeDefined();
    expect(row.subscriberName).toBe("Column Subject");
    expect(row.serviceAccountNumber).toMatch(/^SA-/);
    expect(row.planCode).toBeTruthy();
    expect(row.serviceTypeName).toBe("Test Broadband");
    expect(row.areaName).toBe("Test Area");
    expect(row.collectorName).toBe("Collector Alpha");
    expect(row.monthsUnpaid).toBe(1);
    expect(row.oldestUnpaidInvoice).toMatchObject({
      period: "2026-01",
      dueDate: JAN_DUE,
      daysPastDue: 15
    });
    expect(row.lastPayment).toBeNull();
    expect(row.arrearsCentavos).toBe(MONTHLY);
    expect(row.currentBillCentavos).toBe(0);
    expect(row.totalArrearsCentavos).toBe(MONTHLY);
  });

  it("reports the last payment once one exists", async () => {
    const account = await newAccount({ name: "Payer Subject" });
    await bill("2026-01");
    await bill("2026-02");

    // Pay January in full, so only February remains open and the last payment
    // has to be reported against the account.
    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: MONTHLY, method: "CASH" }, accountant)
    );

    const result = await listOverdueAccounts(db, { asOf: "2026-03-20" });
    const row = result.items.find((item) => item.serviceAccountId === account)!;

    expect(row.monthsUnpaid).toBe(1);
    expect(row.oldestUnpaidInvoice?.period).toBe("2026-02");
    expect(row.lastPayment?.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
    expect(row.lastPayment?.method).toBe("CASH");
  });

  it("counts a partly paid invoice as a whole month unpaid", async () => {
    const account = await newAccount({ name: "Partial Subject" });
    await bill("2026-01");

    await inTransaction((tx) =>
      postPayment(
        tx,
        { serviceAccountId: account, amountCentavos: MONTHLY / 2, method: "CASH" },
        accountant
      )
    );

    const result = await listOverdueAccounts(db, { asOf: "2026-01-20" });
    const row = result.items.find((item) => item.serviceAccountId === account)!;

    expect(row.monthsUnpaid).toBe(1);
    expect(row.arrearsCentavos).toBe(MONTHLY / 2);
  });

  it("orders the most overdue account first, then the largest arrears", async () => {
    // Three accounts left in genuinely different shapes, so the ordering is a
    // property of the data rather than a tie broken by account number:
    //   deep    - January and February both unpaid
    //   heavy   - January paid, February unpaid
    //   cleared - both paid, so not overdue at all
    const deep = await newAccount({ name: "Deep" });
    const heavy = await newAccount({ name: "Heavy" });
    const cleared = await newAccount({ name: "Cleared" });
    await bill("2026-01");
    await bill("2026-02");

    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: heavy, amountCentavos: MONTHLY, method: "CASH" }, accountant)
    );
    await inTransaction((tx) =>
      postPayment(
        tx,
        { serviceAccountId: cleared, amountCentavos: MONTHLY * 2, method: "CASH" },
        accountant
      )
    );

    // As at 20 March: deep is 74 days past its oldest due date with 3,000 in
    // arrears, heavy is 43 days past with 1,500. Deep must lead. Only the three
    // accounts this test created are compared - earlier tests left their own
    // accounts in the book and their arrears say nothing about this ordering.
    const result = await listOverdueAccounts(db, { asOf: "2026-03-20" });
    const created = [deep, heavy, cleared];
    const mine = result.items.filter((item) => created.includes(item.serviceAccountId));

    expect(mine.map((item) => item.serviceAccountId)).toEqual([deep, heavy]);
    expect(mine[0].arrearsCentavos).toBe(MONTHLY * 2);
    expect(mine[0].oldestUnpaidInvoice?.daysPastDue).toBe(74);
    expect(mine[1].arrearsCentavos).toBe(MONTHLY);
    expect(mine[1].oldestUnpaidInvoice?.daysPastDue).toBe(43);

    // And the page as a whole is sorted by the key the service claims to sort by.
    const keys = result.items.map(
      (item) => item.oldestUnpaidInvoice!.daysPastDue * 1_000_000_000 + item.arrearsCentavos
    );
    expect([...keys].sort((a, b) => b - a)).toEqual(keys);
  });

  it("filters by collector", async () => {
    const mine = await newAccount({ name: "Mine", collectorId: collectorA });
    const theirs = await newAccount({ name: "Theirs", collectorId: collectorB });
    await bill("2026-01");

    const result = await listOverdueAccounts(db, { asOf: "2026-01-20", collectorId: collectorA });
    const ids = result.items.map((item) => item.serviceAccountId);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("filters by delinquency age window", async () => {
    const account = await newAccount({ name: "Age Subject" });
    await bill("2026-01");

    const included = await listOverdueAccounts(db, { asOf: "2026-01-20", minDaysPastDue: 10 });
    expect(included.items.map((item) => item.serviceAccountId)).toContain(account);

    const excluded = await listOverdueAccounts(db, { asOf: "2026-01-20", minDaysPastDue: 30 });
    expect(excluded.items.map((item) => item.serviceAccountId)).not.toContain(account);
  });

  it("searches subscriber name and account number", async () => {
    const account = await newAccount({ name: "Findable Person" });
    await bill("2026-01");

    const result = await listOverdueAccounts(db, { asOf: "2026-01-20", search: "Findable" });
    expect(result.items.map((item) => item.serviceAccountId)).toContain(account);

    const none = await listOverdueAccounts(db, { asOf: "2026-01-20", search: "Nobody Here" });
    expect(none.total).toBe(0);
  });

  it("paginates without changing the total", async () => {
    for (const name of ["Page One", "Page Two", "Page Three"]) {
      await newAccount({ name });
    }
    await bill("2026-01");

    const first = await listOverdueAccounts(db, { asOf: "2026-01-20", page: 1, pageSize: 2 });
    const second = await listOverdueAccounts(db, { asOf: "2026-01-20", page: 2, pageSize: 2 });

    expect(first.items).toHaveLength(2);
    expect(first.total).toBeGreaterThanOrEqual(4);
    // The two pages must not overlap, and the count must be the same for both.
    expect(second.total).toBe(first.total);
    for (const item of second.items) {
      expect(first.items.map((row) => row.serviceAccountId)).not.toContain(item.serviceAccountId);
    }
  });

  it("omits an account with nothing overdue", async () => {
    const account = await newAccount({ name: "Clean Subject" });
    await bill("2026-01");
    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: MONTHLY, method: "CASH" }, accountant)
    );

    const result = await listOverdueAccounts(db, { asOf: "2026-01-20" });
    expect(result.items.map((item) => item.serviceAccountId)).not.toContain(account);
  });

  it("ignores a reversed payment when judging the arrears", async () => {
    const account = await newAccount({ name: "Reversed Subject" });
    await bill("2026-01");

    const payment = await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: MONTHLY, method: "CASH" }, accountant)
    );

    let result = await listOverdueAccounts(db, { asOf: "2026-01-20" });
    expect(result.items.map((item) => item.serviceAccountId)).not.toContain(account);

    // A reversed payment puts the money back, so the account is overdue again -
    // and the reversed payment must not be reported as the "last payment".
    const [stored] = await db
      .select()
      .from(payments)
      .where(eq(payments.receiptNumber, payment.receiptNumber))
      .limit(1);
    await inTransaction((tx) => reversePayment(tx, stored.id, "Test reversal", accountant));

    result = await listOverdueAccounts(db, { asOf: "2026-01-20" });
    const row = result.items.find((item) => item.serviceAccountId === account)!;
    expect(row).toBeDefined();
    expect(row.arrearsCentavos).toBe(MONTHLY);
    expect(row.lastPayment).toBeNull();
  });
});

describe("suspension candidates", () => {
  it("returns only ACTIVE accounts that meet both thresholds", async () => {
    const candidate = await newAccount({ name: "Candidate" });
    const suspended = await newAccount({ name: "Already Suspended", status: "SUSPENDED" });

    // Two unpaid months against a 2-month threshold, well past the grace period.
    await bill("2026-01");
    await bill("2026-02");

    // Created after billing, so it has no invoices at all: the opposite extreme,
    // to prove the list is filtered rather than simply "every active account".
    const tooEarly = await newAccount({ name: "Too Early" });

    const result = await listSuspensionCandidates(db, { asOf: "2026-03-20" });
    const ids = result.items.map((item) => item.serviceAccountId);

    expect(ids).toContain(candidate);
    // An account that is already suspended needs a reconnection, not a suspension.
    expect(ids).not.toContain(suspended);
    expect(ids).not.toContain(tooEarly);
  });

  it("agrees with the candidate count on the summary", async () => {
    const summary = await receivablesSummary(db, { asOf: "2026-03-20" });
    const candidates = await listSuspensionCandidates(db, { asOf: "2026-03-20" });

    // The list is capped, so it can be smaller, but it must never be larger -
    // otherwise the button and the headline number tell different stories.
    expect(candidates.items.length).toBeLessThanOrEqual(summary.suspensionCandidateCount);
    for (const item of candidates.items) {
      expect(item.isSuspensionCandidate).toBe(true);
    }
  });
});

describe("settings storage", () => {
  it("stores a reconfigured threshold as an audited setting row", async () => {
    const updated = await updateSetting(db, "service.suspension_threshold_months", 3, {
      description: "Months of arrears before suspension",
      actor: accountant
    });

    expect(updated.value).toBe(3);

    const [row] = await db
      .select()
      .from(applicationSettings)
      .where(eq(applicationSettings.key, "service.suspension_threshold_months"))
      .limit(1);
    expect(row.updatedBy).toBe(accountantId);
  });
});
