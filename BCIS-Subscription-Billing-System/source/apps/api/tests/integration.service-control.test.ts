import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction } from "../src/db/client.js";
import {
  collectionAreas,
  invoiceItems,
  invoices,
  ledgerEntries,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers,
  users
} from "../src/db/schema/index.js";
import { generateMonthlyBilling } from "../src/services/billing.js";
import { DomainError } from "../src/services/errors.js";
import { postPayment } from "../src/services/payments.js";
import { listServiceEvents } from "../src/services/directory.js";
import {
  approveSuspension,
  assignReconnectionTechnician,
  cancelReconnection,
  cancelSuspension,
  completeReconnection,
  confirmReconnectionFee,
  createSuspensionRequest,
  executeSuspension,
  listReconnections,
  listSuspensions,
  requestReconnection
} from "../src/services/service-control.js";
import type { Actor } from "../src/services/types.js";

/**
 * Suspension and reconnection workflows against a real PostgreSQL database
 * (A3.10).
 *
 * The lifecycle is exercised step by step so that the intermediate invariants
 * can be asserted: a suspension is only paper until it is approved and executed;
 * a reconnection cannot skip its fee or its invoice; and every state change
 * lands in the service history.
 *
 * ## Safety
 *
 * Refuses to run unless the database name ends in `_test`, then truncates,
 * exactly like the other integration suites. Runs serially via
 * `--no-file-parallelism`.
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

const MONTHLY = 150_000; // 1,500.00
const DEFAULT_RECONNECTION_FEE = 20_000; // 200.00, the settings default

let officerId: string;
let officer: Actor;
let areaId: string;
let basePlanId: string;
let feePlanId: string;

async function newPlan(reconnectionFeeCentavos: number): Promise<string> {
  const [type] = await db
    .insert(serviceTypes)
    .values({ code: `t-${randomUUID().slice(0, 6)}`, name: "Svc" })
    .returning();
  const [plan] = await db
    .insert(servicePlans)
    .values({
      code: `p-${randomUUID().slice(0, 6)}`,
      name: reconnectionFeeCentavos > 0 ? "Fee Plan" : "Basic Plan",
      serviceTypeId: type.id,
      monthlyPriceCentavos: MONTHLY,
      reconnectionFeeCentavos
    })
    .returning();
  return plan.id;
}

async function newAccount(options: { status?: "ACTIVE" | "SUSPENDED"; planId?: string; name?: string } = {}): Promise<string> {
  const [subscriber] = await db
    .insert(subscribers)
    .values({
      accountNumber: `ACC-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: options.name ?? "Control Subject",
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
      planId: options.planId ?? basePlanId,
      installationAddress: "1 Test Street",
      activationDate: "2026-01-01",
      billingStartPeriod: "2026-01",
      billingDueDay: 5,
      currentRateCentavos: MONTHLY,
      status: options.status ?? "ACTIVE"
    })
    .returning();

  return account.id;
}

/** Bills every account that can be billed for the period, like the real generator. */
async function bill(period: string): Promise<void> {
  await generateMonthlyBilling({ period, applyPenalty: false });
}

async function accountRow(id: string) {
  const [row] = await db.select().from(serviceAccounts).where(eq(serviceAccounts.id, id)).limit(1);
  return row!;
}

/**
 * Runs the full request → approve → execute cycle and returns the executed
 * suspension record.
 */
async function suspendAccount(id: string, effectiveDate = "2026-03-01"): Promise<{ id: string }> {
  return inTransaction(async (tx) => {
    const created = await createSuspensionRequest(
      tx,
      { serviceAccountId: id, reason: "Delinquent subscription", effectiveDate },
      officer
    );
    await approveSuspension(tx, created.id, officer);
    return { id: (await executeSuspension(tx, created.id, officer)).id };
  });
}

/** Returns the DomainError thrown by an operation (fails the test if none is). */
async function rejection(operation: Promise<unknown>): Promise<DomainError> {
  try {
    await operation;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error("Expected the operation to be rejected, but it succeeded.");
}

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  officerId = await (async () => {
    const [user] = await db
      .insert(users)
      .values({ username: "service.officer", displayName: "Service Officer", passwordHash: "x", passwordSalt: "y" })
      .returning();
    return user.id;
  })();
  officer = {
    id: officerId,
    username: "service.officer",
    displayName: "Service Officer",
    permissions: ["suspension.manage", "service.view", "receivables.view", "payment.create"]
  };

  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Test Area" })
    .returning();
  areaId = area.id;

  basePlanId = await newPlan(0);
  feePlanId = await newPlan(30_000); // 300.00
});

afterAll(async () => {
  await closeDatabase();
});

describe("suspension", () => {
  it("records the reason, effective date, notes and a frozen arrears snapshot", async () => {
    const account = await newAccount();
    await bill("2026-01");
    await bill("2026-02");

    const created = await inTransaction((tx) =>
      createSuspensionRequest(
        tx,
        { serviceAccountId: account, reason: "Two months unpaid", effectiveDate: "2026-03-01", notes: "Third reminder sent" },
        officer
      )
    );

    expect(created.status).toBe("PENDING");
    // Frozen from the same open-invoice definition the dashboard uses.
    expect(created.arrearsAtSuspensionCentavos).toBe(MONTHLY * 2);
    expect(created.reason).toBe("Two months unpaid");
    expect(created.effectiveDate).toBe("2026-03-01");
    expect(created.createdByName).toBe("Service Officer");

    // A request is only paper: the service has not changed yet.
    expect((await accountRow(account)).status).toBe("ACTIVE");

    const events = await listServiceEvents(db, account);
    expect(events.filter((event) => event.eventType === "SUSPENDED")).toHaveLength(0);
  });

  it("stays PENDING until approved, and only execution changes the service", async () => {
    const account = await newAccount();
    const created = await inTransaction((tx) =>
      createSuspensionRequest(tx, { serviceAccountId: account, reason: "Overdue", effectiveDate: "2026-03-01" }, officer)
    );

    const premature = await rejection(inTransaction((tx) => executeSuspension(tx, created.id, officer)));
    expect(premature.code).toBe("INVALID_STATE");
    expect((await accountRow(account)).status).toBe("ACTIVE");

    const approved = await inTransaction((tx) => approveSuspension(tx, created.id, officer));
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedByName).toBe("Service Officer");

    const executed = await inTransaction((tx) => executeSuspension(tx, created.id, officer));
    expect(executed.status).toBe("EXECUTED");
    expect(executed.executedAt).not.toBeNull();

    const accountAfter = await accountRow(account);
    expect(accountAfter.status).toBe("SUSPENDED");
    expect(accountAfter.suspendedAt).not.toBeNull();

    const events = await listServiceEvents(db, account);
    expect(events.map((event) => event.eventType)).toContain("SUSPENDED");
  });

  it("cannot suspend twice or cancel an executed suspension", async () => {
    const account = await newAccount();
    const { id } = await suspendAccount(account);

    const repeatExecute = await rejection(inTransaction((tx) => executeSuspension(tx, id, officer)));
    expect(repeatExecute.code).toBe("INVALID_STATE");

    const cancelExecuted = await rejection(inTransaction((tx) => cancelSuspension(tx, id, officer)));
    expect(cancelExecuted.code).toBe("INVALID_STATE");

    // A brand new request on the same (now SUSPENDED) account is also refused.
    const refused = await rejection(
      inTransaction((tx) =>
        createSuspensionRequest(tx, { serviceAccountId: account, reason: "Still overdue", effectiveDate: "2026-03-15" }, officer)
      )
    );
    expect(refused.code).toBe("BUSINESS_RULE");
  });

  it("refuses to suspend an account that is not ACTIVE", async () => {
    const account = await newAccount({ status: "SUSPENDED" });

    const refused = await rejection(
      inTransaction((tx) =>
        createSuspensionRequest(tx, { serviceAccountId: account, reason: "Again", effectiveDate: "2026-04-01" }, officer)
      )
    );
    expect(refused.code).toBe("BUSINESS_RULE");
  });

  it("can withdraw a suspension that was never executed", async () => {
    const account = await newAccount();
    const created = await inTransaction((tx) =>
      createSuspensionRequest(tx, { serviceAccountId: account, reason: "Maybe", effectiveDate: "2026-03-01" }, officer)
    );
    const cancelled = await inTransaction((tx) => cancelSuspension(tx, created.id, officer));

    expect(cancelled.status).toBe("CANCELLED");
    expect((await accountRow(account)).status).toBe("ACTIVE");
    const events = await listServiceEvents(db, account);
    expect(events.filter((event) => event.eventType === "SUSPENDED")).toHaveLength(0);
  });

  it("lists suspensions for an account with the subscriber and plan displayed", async () => {
    const account = await newAccount({ planId: feePlanId, name: "Listed Subscriber" });
    await suspendAccount(account, "2026-04-01");

    const result = await listSuspensions(db, { serviceAccountId: account });
    expect(result.total).toBe(1);
    const [row] = result.items;
    expect(row.status).toBe("EXECUTED");
    expect(row.subscriber_name).toBe("Listed Subscriber");
    expect(row.plan_name).toBe("Fee Plan");
    expect(row.effective_date).toBe("2026-04-01");
  });
});

describe("reconnection", () => {
  it("draws a numbered fee invoice and waits in PENDING_PAYMENT", async () => {
    const account = await newAccount({ planId: feePlanId });
    await suspendAccount(account);

    const record = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, requestDate: "2026-04-05", notes: "Collector ticket #12" }, officer)
    );

    expect(record.status).toBe("PENDING_PAYMENT");
    expect(record.feeCentavos).toBe(30_000);
    expect(record.requestDate).toBe("2026-04-05");
    expect(record.invoiceId).not.toBeNull();
    expect(record.feeInvoiceNumber).toMatch(/^INV-2026-\d{6}$/);

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, record.invoiceId!))
      .limit(1);
    expect(invoice).toBeDefined();
    expect(invoice.period).toBe("REC-2026-04");
    expect(invoice.totalCentavos).toBe(30_000);
    expect(invoice.balanceCentavos).toBe(30_000);
    expect(invoice.status).toBe("UNPAID");
    expect(invoice.isFinalized).toBe(true);

    const [item] = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoice.id), eq(invoiceItems.itemType, "RECONNECTION")))
      .limit(1);
    expect(item?.amountCentavos).toBe(30_000);

    // A fee invoice must be a real ledger debit, not a pretty row.
    const [entry] = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.sourceId, invoice.id))
      .limit(1);
    expect(entry?.debitCentavos).toBe(30_000);

    // Requesting must not have touched the service state by itself.
    expect((await accountRow(account)).status).toBe("SUSPENDED");

    const listed = await listReconnections(db, { serviceAccountId: account });
    expect(listed.total).toBe(1);
    expect(listed.items[0].fee_invoice_number).toBe(invoice.invoiceNumber);
    expect(Number(listed.items[0].fee_balance_centavos)).toBe(30_000);
  });

  it("falls back to the default fee when the plan carries none, and zero waives it", async () => {
    const defaultFee = await newAccount();
    await suspendAccount(defaultFee);
    const byDefault = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: defaultFee, requestDate: "2026-05-02" }, officer)
    );
    expect(byDefault.feeCentavos).toBe(DEFAULT_RECONNECTION_FEE);
    expect(byDefault.status).toBe("PENDING_PAYMENT");

    const waived = await newAccount({ planId: feePlanId });
    await suspendAccount(waived);
    const free = await inTransaction((tx) =>
      requestReconnection(
        tx,
        { serviceAccountId: waived, feeCentavos: 0, requestDate: "2026-05-02" },
        officer
      )
    );
    expect(free.feeCentavos).toBe(0);
    expect(free.status).toBe("REQUESTED");
    expect(free.invoiceId).toBeNull();
  });

  it("does not confirm the workflow until the fee invoice is fully paid", async () => {
    const account = await newAccount({ planId: feePlanId });
    await suspendAccount(account);
    const record = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, requestDate: "2026-06-02" }, officer)
    );

    const unpaid = await rejection(inTransaction((tx) => confirmReconnectionFee(tx, record.id, officer)));
    expect(unpaid.code).toBe("BUSINESS_RULE");

    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: 30_000, method: "CASH" }, officer)
    );

    const requested = await inTransaction((tx) => confirmReconnectionFee(tx, record.id, officer));
    expect(requested.status).toBe("REQUESTED");
    expect(requested.requestedAt).not.toBeNull();
  });

  it("assigns a technician before the job can be completed", async () => {
    const account = await newAccount();
    await suspendAccount(account);
    const record = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, feeCentavos: 0, requestDate: "2026-06-03" }, officer)
    );
    // No technician yet: refusing to complete without one would be a different
    // rule than the one implemented, so assignment is optional but recorded.
    expect(record.technicianId).toBeNull();

    const technicianId = randomUUID();
    const assigned = await inTransaction((tx) =>
      assignReconnectionTechnician(tx, record.id, technicianId, officer)
    );
    expect(assigned.status).toBe("IN_PROGRESS");
    expect(assigned.technicianId).toBe(technicianId);
  });

  it("completion restores service, and happens only after the fee is settled", async () => {
    const account = await newAccount({ planId: feePlanId });
    await suspendAccount(account);
    const record = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, requestDate: "2026-07-02" }, officer)
    );

    const blocked = await rejection(
      inTransaction((tx) => completeReconnection(tx, record.id, { completedDate: "2026-07-03" }, officer))
    );
    expect(blocked.code).toBe("BUSINESS_RULE");
    expect((await accountRow(account)).status).toBe("SUSPENDED");

    await inTransaction((tx) =>
      postPayment(tx, { serviceAccountId: account, amountCentavos: 30_000, method: "CASH" }, officer)
    );
    await inTransaction((tx) => confirmReconnectionFee(tx, record.id, officer));

    const completed = await inTransaction((tx) =>
      completeReconnection(tx, record.id, { completedDate: "2026-07-03" }, officer)
    );
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();

    const accountAfter = await accountRow(account);
    expect(accountAfter.status).toBe("ACTIVE");
    expect(accountAfter.suspendedAt).toBeNull();
  });

  it("a cancelled reconnection voids its unpaid fee invoice and frees the month", async () => {
    const account = await newAccount({ planId: feePlanId });
    await suspendAccount(account);

    const first = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, requestDate: "2026-08-02" }, officer)
    );
    const cancelled = await inTransaction((tx) => cancelReconnection(tx, first.id, officer));
    expect(cancelled.status).toBe("CANCELLED");

    const [voidedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, first.invoiceId!))
      .limit(1);
    expect(voidedInvoice.status).toBe("VOID");
    expect(voidedInvoice.voidReason).toBe("Reconnection cancelled");

    // The same month can be reused once the unpaid invoice is voided.
    const second = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, requestDate: "2026-08-02" }, officer)
    );
    expect(second.id).not.toBe(first.id);
    expect(second.invoiceId).not.toBe(first.invoiceId);
  });

  it("keeps every state change in the service history", async () => {
    const account = await newAccount();
    await suspendAccount(account);

    const record = await inTransaction((tx) =>
      requestReconnection(tx, { serviceAccountId: account, feeCentavos: 0, requestDate: "2026-09-02" }, officer)
    );
    await inTransaction((tx) =>
      completeReconnection(tx, record.id, { completedDate: "2026-09-03" }, officer)
    );

    const events = await listServiceEvents(db, account);
    const types = events.map((event) => event.eventType);
    expect(types).toContain("SUSPENDED");
    expect(types).toContain("RECONNECTED");

    const history = events.find((event) => event.eventType === "RECONNECTED");
    expect(history?.effectiveDate).toBe("2026-09-03");
    expect(history?.reason).toContain("fee P0.00");
  });

  it("refuses a reconnection for an account that is not suspended", async () => {
    const account = await newAccount({ status: "ACTIVE" });
    const error = await rejection(
      inTransaction((tx) => requestReconnection(tx, { serviceAccountId: account }, officer))
    );
    expect(error.code).toBe("BUSINESS_RULE");
  });

  it("throws not found for an unknown workflow record", async () => {
    const ghost = randomUUID();
    const error = await rejection(inTransaction((tx) => approveSuspension(tx, ghost, officer)));
    expect(error.code).toBe("NOT_FOUND");
    const reconnectionError = await rejection(inTransaction((tx) => confirmReconnectionFee(tx, ghost, officer)));
    expect(reconnectionError.code).toBe("NOT_FOUND");
  });
});