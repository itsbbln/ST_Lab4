import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, inTransaction, queryRows } from "../src/db/client.js";
import {
  collectionAreas,
  invoices,
  payments,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers
} from "../src/db/schema/index.js";
import { generateMonthlyBilling } from "../src/services/billing.js";
import { accountBalance } from "../src/services/ledger.js";
import { postPayment, submitGcashProof, verifyGcashProof } from "../src/services/payments.js";

const { db, pool } = getDatabase();

const MONTHLY = 150_000;

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

let accountIds: string[] = [];

beforeAll(async () => {
  assertTestDatabase();
  await resetDatabase();

  const [type] = await db
    .insert(serviceTypes)
    .values({ code: `t-${randomUUID().slice(0, 6)}`, name: "Concurrency Broadband" })
    .returning();
  const [plan] = await db
    .insert(servicePlans)
    .values({
      code: `p-${randomUUID().slice(0, 6)}`,
      name: "Concurrency Plan",
      serviceTypeId: type.id,
      monthlyPriceCentavos: MONTHLY,
      installationFeeCentavos: 0
    })
    .returning();
  const [area] = await db
    .insert(collectionAreas)
    .values({ code: `A-${randomUUID().slice(0, 6)}`, name: "Concurrency Area" })
    .returning();

  accountIds = [];
  for (let index = 0; index < 4; index += 1) {
    const [subscriber] = await db
      .insert(subscribers)
      .values({
        accountNumber: `CC-${randomUUID().slice(0, 8).toUpperCase()}`,
        fullName: `Concurrency Subscriber ${index + 1}`,
        contactNumber: "09170000000",
        addressLine: `${index + 1} Concurrency Street`,
        city: "Manila",
        collectionAreaId: area.id,
        billingDueDay: 5
      })
      .returning();

    const [account] = await db
      .insert(serviceAccounts)
      .values({
        serviceAccountNumber: `SA-${randomUUID().slice(0, 8).toUpperCase()}`,
        subscriberId: subscriber.id,
        planId: plan.id,
        installationAddress: `${index + 1} Concurrency Street`,
        activationDate: "2026-01-01",
        billingStartPeriod: "2026-01",
        billingDueDay: 5,
        currentRateCentavos: MONTHLY,
        status: "ACTIVE"
      })
      .returning();
    accountIds.push(account.id);
  }
});

afterAll(async () => {
  await resetDatabase();
  await closeDatabase();
  await pool.end().catch(() => undefined);
});

describe("AT-09 concurrent office clients", () => {
  it("two simultaneous billing runs create exactly one invoice per account", async () => {
    const [first, second] = await Promise.all([
      inTransaction((tx) => generateMonthlyBilling({ period: "2026-05", applyPenalty: false })),
      inTransaction((tx) => generateMonthlyBilling({ period: "2026-05", applyPenalty: false }))
    ]);

    expect(first.created + second.created).toBe(accountIds.length);

    const rows = await db
      .select({ serviceAccountId: invoices.serviceAccountId, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.period, "2026-05"));

    expect(rows).toHaveLength(accountIds.length);

    const distinctAccounts = new Set(rows.map((row) => row.serviceAccountId));
    expect(distinctAccounts.size).toBe(accountIds.length);

    const distinctNumbers = new Set(rows.map((row) => row.invoiceNumber));
    expect(distinctNumbers.size).toBe(accountIds.length);
  });

  it("three simultaneous cash payments receive distinct receipt numbers", async () => {
    const results = await Promise.all(
      accountIds.slice(0, 3).map((serviceAccountId) =>
        inTransaction((tx) =>
          postPayment(tx, { serviceAccountId, amountCentavos: MONTHLY, method: "CASH" })
        )
      )
    );

    const receiptNumbers = results.map((result) => result.receiptNumber);
    expect(new Set(receiptNumbers).size).toBe(3);
    for (const result of results) {
      expect(result.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
      expect(result.allocatedCentavos).toBe(MONTHLY);
      expect(result.balanceAfterCentavos).toBe(0);
    }

    const stored = await queryRows<{ receipt_number: string; count: number }>(
      db,
      sql`
        select receipt_number, count(*)::int as count
        from payments
        group by receipt_number
        having count(*) > 1
      `
    );
    expect(stored).toHaveLength(0);

    for (const serviceAccountId of accountIds.slice(0, 3)) {
      const { balanceCentavos } = await accountBalance(db, serviceAccountId);
      expect(balanceCentavos).toBe(0);

      const crossAccount = await queryRows<{ count: number }>(
        db,
        sql`
          select count(*)::int as count
          from payment_allocations pa
          inner join payments p on pa.payment_id = p.id
          inner join invoices i on pa.invoice_id = i.id
          where p.service_account_id = ${serviceAccountId}
            and i.service_account_id <> ${serviceAccountId}
        `
      );
      expect(crossAccount[0].count).toBe(0);
    }
  });

  it("two simultaneous approvals of one GCash reference post exactly one payment", async () => {
    await inTransaction((tx) => generateMonthlyBilling({ period: "2026-06", applyPenalty: false }));

    const target = accountIds[3];
    const referenceNumber = `GC-${randomUUID().slice(0, 8).toUpperCase()}`;

    const proof = await inTransaction((tx) =>
      submitGcashProof(
        tx,
        {
          serviceAccountId: target,
          referenceNumber,
          senderName: "Concurrency Reviewer Test",
          amountCentavos: MONTHLY
        },
        undefined
      )
    );

    const outcomes = await Promise.allSettled([
      inTransaction((tx) => verifyGcashProof(tx, proof.id, { approved: true }, undefined)),
      inTransaction((tx) => verifyGcashProof(tx, proof.id, { approved: true }, undefined))
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const posted = await db
      .select({ id: payments.id, receiptNumber: payments.receiptNumber })
      .from(payments)
      .where(
        sql`${payments.method} = 'GCASH' and upper(${payments.referenceNumber}) = upper(${referenceNumber}) and ${payments.status} = 'POSTED'`
      );
    expect(posted).toHaveLength(1);

    const storedReceipts = await queryRows<{ count: number }>(
      db,
      sql`select count(*)::int as count from receipts where receipt_number = ${posted[0].receiptNumber}`
    );
    expect(storedReceipts[0].count).toBe(1);
  });
});
