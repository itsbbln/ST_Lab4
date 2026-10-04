import { describe, expect, it } from "vitest";

import { planAllocation } from "../src/services/payments.js";

/**
 * Oldest-first allocation planning (§3.4).
 *
 * This is the function that decides which invoice a subscriber's money settles.
 * It is pure, so it is tested without a database. The properties below are the
 * ones the acceptance tests rely on at runtime:
 *
 *  - an older debt is never left behind while a newer one is paid;
 *  - an invoice is never over-applied past its outstanding balance;
 *  - whatever cannot be matched becomes advance, never a silently dropped peso.
 */

interface Row {
  id: string;
  invoice_number: string;
  period: string;
  due_date: string;
  balance_centavos: number;
}

function row(id: string, balance: number, dueDate: string, period: string): Row {
  return {
    id,
    invoice_number: `INV-${id}`,
    period,
    due_date: dueDate,
    balance_centavos: balance
  };
}

/** Invoices as the query returns them: already ordered oldest first. */
const OPEN = [row("a", 10_000, "2026-07-05", "2026-07"), row("b", 15_000, "2026-08-05", "2026-08")];

const applied = (lines: ReturnType<typeof planAllocation>) => lines.map((line) => line.amountCentavos);
const total = (lines: ReturnType<typeof planAllocation>) => lines.reduce((sum, line) => sum + line.amountCentavos, 0);

describe("planAllocation", () => {
  it("settles the oldest invoice first, then spills onto the next", () => {
    // "a" only owes 10_000, so the remaining 2_000 must go to "b" rather than
    // being parked as advance on a current invoice while the old debt stands.
    const lines = planAllocation(OPEN as never, 12_000);
    expect(lines.map((line) => line.invoiceId)).toEqual(["a", "b"]);
    expect(applied(lines)).toEqual([10_000, 2_000]);
    expect(total(lines)).toBe(12_000);
  });

  it("stops at the oldest invoice when the payment does not clear it", () => {
    const lines = planAllocation(OPEN as never, 5_000);
    expect(lines).toHaveLength(1);
    expect(lines[0].invoiceId).toBe("a");
    expect(lines[0].amountCentavos).toBe(5_000);
  });

  it("spills onto the next invoice when the payment clears the first", () => {
    const lines = planAllocation(OPEN as never, 20_000);
    expect(applied(lines)).toEqual([10_000, 10_000]);
    expect(lines[1].invoiceId).toBe("b");
    expect(total(lines)).toBe(20_000);
  });

  it("leaves any remainder as advance rather than inventing an allocation", () => {
    const lines = planAllocation(OPEN as never, 30_000);
    expect(applied(lines)).toEqual([10_000, 15_000]);
    // 30_000 collected, 25_000 applied, 5_000 becomes advance on the payment.
    expect(total(lines)).toBeLessThan(30_000);
    expect(30_000 - total(lines)).toBe(5_000);
  });

  it("never applies more than an invoice's outstanding balance", () => {
    for (const amount of [1, 9_999, 10_000, 10_001, 24_999, 25_000, 25_001, 99_999]) {
      for (const line of planAllocation(OPEN as never, amount)) {
        expect(line.amountCentavos).toBeLessThanOrEqual(line.outstandingCentavos);
        expect(line.amountCentavos).toBeGreaterThan(0);
      }
    }
  });

  it("allocates nothing when every invoice is already settled", () => {
    expect(planAllocation([] as never, 5_000)).toEqual([]);
  });

  it("allocates nothing for a zero or negative amount", () => {
    expect(planAllocation(OPEN as never, 0)).toEqual([]);
    expect(planAllocation(OPEN as never, -5_000)).toEqual([]);
  });

  it("skips rows with no outstanding balance even if they are listed", () => {
    const withSettled = [row("a", 0, "2026-07-05", "2026-07"), row("b", 15_000, "2026-08-05", "2026-08")];
    const lines = planAllocation(withSettled as never, 5_000);
    expect(applied(lines)).toEqual([5_000]);
    expect(lines[0].invoiceId).toBe("b");
  });

  it("always consumes the payment in the order the rows were given", () => {
    // The service relies on the SQL ORDER BY for this; the function must not
    // re-sort, or a caller passing unsorted rows would allocate out of order.
    const unsorted = [row("b", 15_000, "2026-08-05", "2026-08"), row("a", 10_000, "2026-07-05", "2026-07")];
    const lines = planAllocation(unsorted as never, 20_000);
    expect(lines.map((line) => line.invoiceId)).toEqual(["b", "a"]);
  });

  it("reports the invoice metadata the receipt needs", () => {
    const [line] = planAllocation(OPEN as never, 5_000);
    expect(line.invoiceNumber).toBe("INV-a");
    expect(line.period).toBe("2026-07");
    expect(line.dueDate).toBe("2026-07-05");
    expect(line.outstandingCentavos).toBe(10_000);
  });
});
