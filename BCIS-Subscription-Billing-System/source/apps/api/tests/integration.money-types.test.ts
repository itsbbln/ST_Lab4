import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase, type DatabaseHandle } from "../src/db/client.js";
import { formatCentavos } from "@bcis/shared";

/**
 * The money types on the wire.
 *
 * `sum()` over a `bigint` column returns `numeric` in PostgreSQL, and
 * node-postgres hands `numeric` back as a **string**. That is invisible to
 * TypeScript: a `sql<number>` fragment promises a number while delivering "0",
 * and the first thing to touch it - `formatCentavos` - throws
 * "Amount must be an integer number of centavos (received 0)".
 *
 * The symptom was a 500 on the subscriber and service-account lists, and only
 * for rows whose balance was zero, which is why it looked intermittent.
 *
 * The fix is the `::bigint` cast on those aggregates, so the INT8 parser in
 * `db/client.ts` produces a real number. This test pins both halves: that the
 * uncast form really does produce a string, and that the cast form produces a
 * number the money helpers accept.
 */

let handle: DatabaseHandle;
let db: DatabaseHandle["db"];

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  const databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!databaseName.endsWith("_test")) {
    // Second line of defence, after vitest.config.ts. An integration test that
    // writes to the live demo database is worse than no test at all.
    throw new Error(
      `Refusing to run integration tests against "${databaseName}". The name must end in _test.`
    );
  }

  handle = getDatabase();
  db = handle.db;
});

afterAll(async () => {
  await closeDatabase();
});

describe("centavos returned by aggregates", () => {
  it("sum() over bigint comes back as a string, which is the trap", async () => {
    const result = await db.execute<{ total: unknown }>(
      sql`select coalesce(sum(total_centavos), 0) as total from invoices`
    );
    // Documenting the driver behaviour: if a future pg version starts parsing
    // numeric as a number this test will fail and say why it is no longer needed.
    expect(typeof result.rows[0]?.total).toBe("string");
  });

  it("an explicit ::bigint cast yields a number the money helpers accept", async () => {
    const result = await db.execute<{ total: unknown }>(
      sql`select coalesce(sum(total_centavos), 0)::bigint as total from invoices`
    );
    const total = result.rows[0]?.total;
    expect(typeof total).toBe("number");
    expect(Number.isInteger(total as number)).toBe(true);
    // The exact call that used to throw.
    expect(() => formatCentavos(total as number)).not.toThrow();
  });

  it("zero is a valid amount, not a malformed one", () => {
    // `assertCentavos` only rejects non-integers. A subscriber with no arrears is
    // the normal case on the list screens, so this must not throw.
    expect(() => formatCentavos(0)).not.toThrow();
    expect(() => formatCentavos(0, { blankZero: true })).not.toThrow();
  });

  it("rejects a numeric-as-string, which is what made the lists 500", () => {
    expect(() => formatCentavos("0" as unknown as number)).toThrow(/integer number of centavos/);
  });

  it("count() aggregates are numbers too, so pagination totals are not strings", async () => {
    const result = await db.execute<{ total: unknown }>(sql`select count(*) as total from invoices`);
    expect(typeof result.rows[0]?.total).toBe("number");
  });
});
