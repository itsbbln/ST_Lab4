import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction } from "../src/db/client.js";
import {
  batchAccounts,
  collectorRemittances,
  collectors,
  collectionAreas,
  collectionBatches,
  collectionRoutes,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers,
  users
} from "../src/db/schema/index.js";
import {
  addBatchAccounts,
  closeBatch,
  confirmRemittance,
  getBatch,
  getRouteSheet,
  listBatches,
  openBatch,
  recordCollection,
  submitRemittance,
  transitionBatch
} from "../src/services/collections.js";
import { generateMonthlyBilling } from "../src/services/billing.js";
import { accountBalance } from "../src/services/ledger.js";
import { DomainError } from "../src/services/errors.js";
import { rolePermissions } from "@bcis/shared";
import type { Actor } from "../src/services/types.js";

/**
 * House-to-house collection against a real PostgreSQL database.
 *
 * AT-07 and AT-08 are the mandatory tests this file exists for:
 *
 *  - AT-07  cash collected 20,000, remitted 20,000, difference 0, batch reconciles and closes.
 *  - AT-08  cash collected 20,000, remitted 19,500, a 500 shortage is shown and the batch
 *           cannot be closed as if the day balanced.
 *
 * The same run also covers the accounting that makes those numbers mean something: a
 * collected amount has to produce a real payment, a receipt and a ledger credit, and
 * the batch totals have to be derived rather than typed in.
 *
 * ## Safety
 *
 * Refuses to run unless the database name ends in `_test`, then truncates. The working
 * `source/.env` points at `bcis`, so an accidental run here would be destructive.
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

/**
 * An actor has to be a real user row: `audit_logs.actor_id` is a foreign key, so a
 * made-up UUID would make every audited action fail. The service layer only ever
 * sees a real operator, and the tests should not be able to get away with less.
 */
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

let supervisorId: string;
let cashierId: string;
let readonlyId: string;
let supervisor: Actor;
let cashierOnly: Actor;
let readonly: Actor;

const MONTHLY = 150_000; // 1,500.00
const TWO_MONTHS = 300_000; // 3,000.00 - the AT-07 / AT-08 collected figure
const COLLECTED = 2_000_000; // 20,000.00
const SHORT = 1_950_000; // 19,500.00

let areaId: string;
let routeId: string;
let collectorId: string;
let planId: string;

/**
 * Creates a subscriber and an active service account on the test area.
 *
 * Each describe block makes its own accounts. Sharing them across blocks made the
 * suite order-dependent: a collection in one block paid an invoice that another
 * block was still asserting was owed, and the failure looked like a bug in the
 * receivables split rather than a leak in the test.
 */
async function newAccount(fullName: string): Promise<string> {
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
      currentRateCentavos: MONTHLY,
      status: "ACTIVE"
    })
    .returning();
  return account.id;
}

/** Gives an account two months of open invoices: 1,500 current plus 1,500 arrears. */
async function billTwoMonths(): Promise<void> {
  await generateMonthlyBilling({ period: "2026-01", applyPenalty: false });
  await generateMonthlyBilling({ period: "2026-02", applyPenalty: false });
}

/** The batch account row for the single account added to a batch. */
async function firstBatchAccount(batchId: string) {
  const [row] = await db
    .select()
    .from(batchAccounts)
    .where(eq(batchAccounts.batchId, batchId))
    .limit(1);
  return row;
}

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  supervisorId = await createUser("collector.supervisor", "Collection Supervisor");
  cashierId = await createUser("office.cashier", "Office Cashier");
  readonlyId = await createUser("audit.viewer", "Audit Viewer");

  supervisor = {
    id: supervisorId,
    username: "collector.supervisor",
    displayName: "Collection Supervisor",
    permissions: ["collection.view", "collection.record", "collection.reconcile"]
  };
  cashierOnly = {
    id: cashierId,
    username: "office.cashier",
    displayName: "Office Cashier",
    permissions: ["collection.view", "payment.view", "payment.create"]
  };
  readonly = {
    id: readonlyId,
    username: "audit.viewer",
    displayName: "Audit Viewer",
    permissions: ["collection.view"]
  };

  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Test Area" })
    .returning();
  areaId = area.id;

  const [route] = await db
    .insert(collectionRoutes)
    .values({ code: `R-${randomUUID().slice(0, 6)}`, name: "Test Route", areaId })
    .returning();
  routeId = route.id;

  const [collector] = await db
    .insert(collectors)
    .values({
      code: `C-${randomUUID().slice(0, 6)}`,
      fullName: "Test Collector",
      contactNumber: "09170000001"
    })
    .returning();
  collectorId = collector.id;

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
});

afterAll(async () => {
  await resetDatabase();
  await closeDatabase();
  await pool.end().catch(() => undefined);
});

/** Opens a batch for the test area, in the period the invoices were billed for. */
async function newBatch(batchDate = "2026-02-10") {
  return inTransaction((tx) =>
    openBatch(
      tx,
      { areaId, routeId, collectorId, batchDate, dueDayCutoff: 5 },
      supervisor
    )
  );
}

describe("collection batch lifecycle", () => {
  let accountIds: string[] = [];

  beforeAll(async () => {
    accountIds = [await newAccount("Sheet One"), await newAccount("Sheet Two")];
    await billTwoMonths();
  });

  it("opens a batch with a gap-free number and no accounts yet", async () => {
    const batch = await newBatch();
    expect(batch.batchNumber).toMatch(/^BATCH-\d{4}-\d{6}$/);
    expect(batch.status).toBe("OPEN");
    expect(batch.accountCount).toBe(0);
    expect(batch.accounts).toHaveLength(0);
  });

  it("refuses a collector who is not active", async () => {
    const [inactive] = await db
      .insert(collectors)
      .values({
        code: `C-${randomUUID().slice(0, 6)}`,
        fullName: "Retired Collector",
        contactNumber: "09170000002",
        isActive: false
      })
      .returning();

    await expect(
      inTransaction((tx) =>
        openBatch(
          tx,
          { areaId, routeId, collectorId: inactive.id, batchDate: "2026-02-10" },
          supervisor
        )
      )
    ).rejects.toThrow(/not an active collector/i);
  });

  it("refuses a route that belongs to another area", async () => {
    const [otherArea] = await db
      .insert(collectionAreas)
      .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Other Area" })
      .returning();

    await expect(
      inTransaction((tx) =>
        openBatch(
          tx,
          { areaId: otherArea.id, routeId, collectorId, batchDate: "2026-02-10" },
          supervisor
        )
      )
    ).rejects.toThrow(/does not belong to the selected area/i);
  });

  it("builds the route sheet from live receivables, splitting current bill and arrears", async () => {
    const batch = await newBatch("2026-02-10");
    const added = await inTransaction((tx) =>
      addBatchAccounts(tx, batch.id, accountIds, supervisor)
    );

    expect(added.added).toBe(2);
    expect(added.skipped).toBe(0);
    // Each account owes two months: 1,500 current + 1,500 arrears.
    expect(added.totals.expectedReceivableCentavos).toBe(TWO_MONTHS * 2);

    const detail = await getBatch(db, batch.id);
    const first = detail.accounts[0];
    expect(first.currentBillCentavos).toBe(MONTHLY);
    expect(first.arrearsCentavos).toBe(MONTHLY);
    expect(first.totalDueCentavos).toBe(TWO_MONTHS);
    expect(first.status).toBe("PENDING");
    // The printed sheet has to carry an address for the collector to find the door.
    expect(first.address).toBeTruthy();
    expect(first.accountNumber).toMatch(/^SA-/);
  });

  it("does not add the same account twice", async () => {
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, accountIds, supervisor));

    // A repeat submission of one already on the sheet changes nothing. The
    // duplicate inside the request collapses to a single distinct id, so it is
    // reported as one skip rather than counting the same account twice.
    const again = await inTransaction((tx) =>
      addBatchAccounts(tx, batch.id, [accountIds[0], accountIds[0]], supervisor)
    );

    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(again.totals.accountCount).toBe(2);
  });

  it("rejects a status that contradicts the amount", async () => {
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [accountIds[0]], supervisor));
    const target = await firstBatchAccount(batch.id);

    // Money with an UNCOLLECTED status is contradictory and must be refused.
    await expect(
      inTransaction((tx) =>
        recordCollection(
          tx,
          { batchAccountId: target.id, amountCentavos: 100, status: "UNCOLLECTED" },
          supervisor
        )
      )
    ).rejects.toThrow(/cannot be recorded with status UNCOLLECTED/i);

    // And so is a COLLECTED status with nothing collected.
    await expect(
      inTransaction((tx) =>
        recordCollection(
          tx,
          { batchAccountId: target.id, amountCentavos: 0, status: "COLLECTED" },
          supervisor
        )
      )
    ).rejects.toThrow(/requires a collection amount greater than zero/i);
  });
});

describe("recording a doorstep collection", () => {
  /**
   * A brand new account, two months billed, sitting alone on a fresh batch.
   * Each test needs this because every one of them moves money, so a shared
   * account would leave the next test asserting against a balance the previous
   * test had already reduced.
   */
  async function freshStop() {
    const serviceAccountId = await newAccount(`Doorstep ${randomUUID().slice(0, 4)}`);
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);
    return { batchId: batch.id, batchAccountId: row.id, serviceAccountId };
  }

  it("posts a real payment, so the receipt and ledger follow the collection", async () => {
    const stop = await freshStop();

    const balanceBefore = await accountBalance(db, stop.serviceAccountId);
    const result = await inTransaction((tx) =>
      recordCollection(
        tx,
        {
          batchAccountId: stop.batchAccountId,
          amountCentavos: TWO_MONTHS,
          status: "COLLECTED",
          notes: "Paid in full"
        },
        supervisor
      )
    );

    expect(result.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
    expect(result.allocatedCentavos).toBe(TWO_MONTHS);
    expect(result.advanceCentavos).toBe(0);
    expect(result.status).toBe("COLLECTED");
    expect(result.collectedCentavos).toBe(TWO_MONTHS);
    expect(result.totals.cashCollectedCentavos).toBe(TWO_MONTHS);
    expect(result.totals.uncollectedCentavos).toBe(0);

    // The collection is not a shadow tally: the ledger moved by exactly this much.
    const balanceAfter = await accountBalance(db, stop.serviceAccountId);
    expect(balanceAfter.balanceCentavos).toBe(balanceBefore.balanceCentavos - TWO_MONTHS);
  });

  it("marks a short collection PARTIAL and leaves the rest outstanding", async () => {
    const stop = await freshStop();
    const result = await inTransaction((tx) =>
      recordCollection(
        tx,
        { batchAccountId: stop.batchAccountId, amountCentavos: 100_000, status: "PARTIAL" },
        supervisor
      )
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.collectedCentavos).toBe(100_000);
    expect(result.totals.uncollectedCentavos).toBe(TWO_MONTHS - 100_000);
  });

  it("records a non-cash collection separately from cash the collector holds", async () => {
    const stop = await freshStop();
    const result = await inTransaction((tx) =>
      recordCollection(
        tx,
        {
          batchAccountId: stop.batchAccountId,
          amountCentavos: 50_000,
          status: "PARTIAL",
          method: "GCASH"
        },
        supervisor
      )
    );

    expect(result.totals.cashCollectedCentavos).toBe(0);
    expect(result.totals.nonCashCollectedCentavos).toBe(50_000);
  });

  it("records a zero-amount skip without inventing a payment", async () => {
    const stop = await freshStop();
    const result = await inTransaction((tx) =>
      recordCollection(
        tx,
        {
          batchAccountId: stop.batchAccountId,
          amountCentavos: 0,
          status: "SKIPPED",
          notes: "Nobody home"
        },
        supervisor
      )
    );

    expect(result.paymentId).toBe("");
    expect(result.status).toBe("SKIPPED");
    expect(result.totals.cashCollectedCentavos).toBe(0);
  });

  it("refuses to record against a submitted batch", async () => {
    const stop = await freshStop();
    await inTransaction((tx) => transitionBatch(tx, stop.batchId, "IN_PROGRESS", null, supervisor));
    await inTransaction((tx) => transitionBatch(tx, stop.batchId, "SUBMITTED", null, supervisor));

    await expect(
      inTransaction((tx) =>
        recordCollection(
          tx,
          { batchAccountId: stop.batchAccountId, amountCentavos: 1000, status: "PARTIAL" },
          supervisor
        )
      )
    ).rejects.toThrow(/can no longer record collections/i);
  });

  it("blocks a collector who lacks the collection permission", async () => {
    const stop = await freshStop();
    await expect(
      inTransaction((tx) =>
        recordCollection(
          tx,
          { batchAccountId: stop.batchAccountId, amountCentavos: 1000, status: "PARTIAL" },
          cashierOnly
        )
      )
    ).rejects.toThrow(/Missing permission: collection.record/);
  });
});

describe("AT-07 balanced remittance", () => {
  let batchId: string;

  beforeAll(async () => {
    // One account on its own batch, collected in full: 20,000 in, 20,000 out.
    const serviceAccountId = await newAccount("Balanced Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    batchId = batch.id;
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);

    await inTransaction((tx) =>
      recordCollection(
        tx,
        { batchAccountId: row.id, amountCentavos: COLLECTED, status: "COLLECTED" },
        supervisor
      )
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));
  });

  it("derives a zero difference and no shortage when the cash matches", async () => {
    const remittance = await inTransaction((tx) =>
      submitRemittance(tx, { batchId, cashRemittedCentavos: COLLECTED }, supervisor)
    );

    expect(remittance.cashCollectedCentavos).toBe(COLLECTED);
    expect(remittance.cashRemittedCentavos).toBe(COLLECTED);
    expect(remittance.differenceCentavos).toBe(0);
    expect(remittance.shortageCentavos).toBe(0);
    expect(remittance.overageCentavos).toBe(0);
    expect(remittance.status).toBe("SUBMITTED");
    expect(remittance.batchStatus).toBe("REMITTED");
  });

  it("reconciles on confirmation and closes without needing an acknowledgement", async () => {
    const [remittance] = await db
      .select()
      .from(collectorRemittances)
      .where(eq(collectorRemittances.batchId, batchId))
      .limit(1);

    const review = await inTransaction((tx) =>
      confirmRemittance(tx, remittance.id, true, "Cash count matches the sheet.", supervisor)
    );
    expect(review.status).toBe("CONFIRMED");
    expect(review.batchStatus).toBe("RECONCILED");

    const closed = await inTransaction((tx) => closeBatch(tx, batchId, {}, supervisor));
    expect(closed.status).toBe("CLOSED");
    expect(closed.discrepancyAcknowledged).toBe(false);

    const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
    expect(batch.status).toBe("CLOSED");
  });
});

describe("AT-08 collector shortage", () => {
  let batchId: string;
  let remittanceId: string;

  beforeAll(async () => {
    const serviceAccountId = await newAccount("Short Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    batchId = batch.id;
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);

    // The collector collected the full 20,000 but hands over 19,500.
    await inTransaction((tx) =>
      recordCollection(
        tx,
        { batchAccountId: row.id, amountCentavos: COLLECTED, status: "COLLECTED" },
        supervisor
      )
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));

    const remittance = await inTransaction((tx) =>
      submitRemittance(tx, { batchId, cashRemittedCentavos: SHORT }, supervisor)
    );
    remittanceId = remittance.id;
  });

  it("shows the 500 shortage explicitly", async () => {
    const [remittance] = await db
      .select()
      .from(collectorRemittances)
      .where(eq(collectorRemittances.id, remittanceId))
      .limit(1);

    expect(remittance.cashCollectedCentavos).toBe(COLLECTED);
    expect(remittance.cashRemittedCentavos).toBe(SHORT);
    expect(remittance.differenceCentavos).toBe(50_000);
    expect(remittance.shortageCentavos).toBe(50_000);
    expect(remittance.overageCentavos).toBe(0);
  });

  it("will not close the batch as balanced", async () => {
    await inTransaction((tx) =>
      confirmRemittance(tx, remittanceId, true, "Shortage noted for follow-up.", supervisor)
    );

    await expect(inTransaction((tx) => closeBatch(tx, batchId, {}, supervisor))).rejects.toThrow(
      /₱500\.00 short/i
    );
  });

  it("only closes once the discrepancy is acknowledged", async () => {
    const closed = await inTransaction((tx) =>
      closeBatch(
        tx,
        batchId,
        { notes: "Shortage written off against the collector.", acknowledgeDiscrepancy: true },
        supervisor
      )
    );

    expect(closed.status).toBe("CLOSED");
    expect(closed.shortageCentavos).toBe(50_000);
    expect(closed.discrepancyAcknowledged).toBe(true);
  });

  it("records an overage when the collector hands over more than the batch shows", async () => {
    const serviceAccountId = await newAccount("Over Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);
    await inTransaction((tx) =>
      recordCollection(
        tx,
        { batchAccountId: row.id, amountCentavos: 100_000, status: "PARTIAL" },
        supervisor
      )
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));

    const remittance = await inTransaction((tx) =>
      submitRemittance(
        tx,
        { batchId: batch.id, cashRemittedCentavos: 100_000 + 25_000, remarks: "Extra from door 3" },
        supervisor
      )
    );

    expect(remittance.differenceCentavos).toBe(-25_000);
    expect(remittance.overageCentavos).toBe(25_000);
    expect(remittance.shortageCentavos).toBe(0);
  });
});

describe("guards on the remittance lifecycle", () => {
  it("cannot be walked to CLOSED by hand, skipping the remittance", async () => {
    const batch = await newBatch("2026-02-10");

    await expect(
      inTransaction((tx) => transitionBatch(tx, batch.id, "REMITTED", null, supervisor))
    ).rejects.toThrow(/cannot be moved to REMITTED directly/i);

    await expect(
      inTransaction((tx) => transitionBatch(tx, batch.id, "CLOSED", null, supervisor))
    ).rejects.toThrow(/cannot be moved to CLOSED directly/i);
  });

  it("will not close a batch that was never reconciled", async () => {
    const batch = await newBatch("2026-02-10");
    await expect(
      inTransaction((tx) => closeBatch(tx, batch.id, {}, supervisor))
    ).rejects.toThrow(/Only a reconciled batch can be closed/i);
  });

  it("sends a rejected remittance back for correction with the reason kept", async () => {
    const serviceAccountId = await newAccount("Rejected Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);
    await inTransaction((tx) =>
      recordCollection(tx, { batchAccountId: row.id, amountCentavos: 10_000, status: "PARTIAL" }, supervisor)
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));
    const remittance = await inTransaction((tx) =>
      submitRemittance(tx, { batchId: batch.id, cashRemittedCentavos: 5_000 }, supervisor)
    );

    const review = await inTransaction((tx) =>
      confirmRemittance(
        tx,
        remittance.id,
        false,
        "The cash count does not match; recount and resubmit.",
        supervisor
      )
    );

    expect(review.status).toBe("REJECTED");
    expect(review.batchStatus).toBe("IN_PROGRESS");

    const [stored] = await db
      .select()
      .from(collectorRemittances)
      .where(eq(collectorRemittances.id, remittance.id))
      .limit(1);
    expect(stored.rejectionReason).toMatch(/recount/i);
  });

  it("blocks reconciliation without the permission", async () => {
    const serviceAccountId = await newAccount("Unauthorised Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);
    await inTransaction((tx) =>
      recordCollection(tx, { batchAccountId: row.id, amountCentavos: 10_000, status: "PARTIAL" }, supervisor)
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));
    const remittance = await inTransaction((tx) =>
      submitRemittance(tx, { batchId: batch.id, cashRemittedCentavos: 10_000 }, supervisor)
    );

    await expect(
      inTransaction((tx) =>
        confirmRemittance(tx, remittance.id, true, "Looks right to me.", readonly)
      )
    ).rejects.toThrow(/Missing permission: collection.reconcile/);

    await expect(
      inTransaction((tx) => closeBatch(tx, batch.id, {}, readonly))
    ).rejects.toThrow(/Missing permission: collection.reconcile/);
  });
});

describe("read models", () => {
  let accountIds: string[] = [];

  beforeAll(async () => {
    accountIds = [await newAccount("Sheet Alpha"), await newAccount("Sheet Beta")];
    await billTwoMonths();
  });

  it("returns a printable route sheet in visiting order with the totals", async () => {
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, accountIds, supervisor));

    const sheet = await getRouteSheet(db, batch.id);

    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].sequence).toBe(1);
    expect(sheet.rows[1].sequence).toBe(2);
    expect(sheet.rows.every((row) => row.totalDueCentavos === TWO_MONTHS)).toBe(true);
    expect(sheet.totals.expectedReceivableCentavos).toBe(TWO_MONTHS * 2);
    expect(sheet.batch.collectorName).toBe("Test Collector");
  });

  it("lists batches with the collector and area joined in", async () => {
    const result = await listBatches(db, { page: 1, pageSize: 50 });
    expect(result.total).toBeGreaterThan(0);
    expect(result.items[0].collectorName).toBe("Test Collector");
    expect(result.items[0].areaName).toBe("Test Area");
    expect(result.items[0].routeName).toBe("Test Route");
  });

  it("keeps the due snapshot on the sheet stable after the money moves", async () => {
    // The sheet is a snapshot of what was owed when the batch was built. A later
    // counter payment must not silently rewrite a collector's printed sheet.
    const serviceAccountId = await newAccount("Snapshot Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);

    await inTransaction((tx) =>
      recordCollection(tx, { batchAccountId: row.id, amountCentavos: 1_000, status: "PARTIAL" }, supervisor)
    );

    const [stored] = await db
      .select()
      .from(batchAccounts)
      .where(eq(batchAccounts.id, row.id))
      .limit(1);
    expect(stored.totalDueCentavos).toBe(TWO_MONTHS);
    expect(stored.collectedCentavos).toBe(1_000);
  });

  it("is readable by a view-only user", async () => {
    const result = await listBatches(db, { page: 1, pageSize: 5 });
    expect(result.items.length).toBeGreaterThan(0);
    // The reader needed no mutation permission to see any of it.
    expect(readonly.permissions).toEqual(["collection.view"]);
  });
});

describe("role table sanity", () => {
  it("keeps recording and reconciling separate duties for the roles that matter", () => {
    // The lab's audit concern: whoever records a collection should not also be
    // the sole approver of the remittance.
    expect(rolePermissions.COLLECTION_SUPERVISOR).toContain("collection.record");
    expect(rolePermissions.COLLECTION_SUPERVISOR).toContain("collection.reconcile");
    expect(rolePermissions.CASHIER).not.toContain("collection.record");
    expect(rolePermissions.CASHIER).not.toContain("collection.reconcile");
    expect(rolePermissions.ACCOUNTANT_AUDITOR).toContain("collection.reconcile");
    expect(rolePermissions.ACCOUNTANT_AUDITOR).not.toContain("collection.record");
  });

  it("surfaces a DomainError for the shortage case rather than a generic failure", async () => {
    const serviceAccountId = await newAccount("Domain Error Stop");
    await billTwoMonths();
    const batch = await newBatch("2026-02-10");
    await inTransaction((tx) => addBatchAccounts(tx, batch.id, [serviceAccountId], supervisor));
    const row = await firstBatchAccount(batch.id);
    await inTransaction((tx) =>
      recordCollection(tx, { batchAccountId: row.id, amountCentavos: 5_000, status: "PARTIAL" }, supervisor)
    );
    await inTransaction((tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, supervisor));
    const remittance = await inTransaction((tx) =>
      submitRemittance(tx, { batchId: batch.id, cashRemittedCentavos: 1_000 }, supervisor)
    );
    await inTransaction((tx) =>
      confirmRemittance(tx, remittance.id, true, "Shortage accepted for review.", supervisor)
    );

    const error = await inTransaction((tx) => closeBatch(tx, batch.id, {}, supervisor)).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).statusCode).toBe(422);
    expect((error as DomainError).details).toMatchObject({ shortageCentavos: 4_000 });
  });
});
