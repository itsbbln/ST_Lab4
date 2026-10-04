import { describe, expect, it } from "vitest";

import {
  deriveInvoiceStatus,
  dueDateForPeriod,
  lastDayOfPeriod,
  monthsBetween,
  normalizePeriod
} from "../src/services/billing.js";

/**
 * Billing period arithmetic and invoice status derivation.
 *
 * These are the two pieces of billing logic that must be right before any money
 * moves, and both are pure functions, so they are tested without a database. The
 * end-to-end behaviour (duplicate prevention, ledger postings, allocation) is
 * covered by the AT-01..AT-12 acceptance tests against a real database.
 */

const PAST = "2020-01-01";
const FUTURE = "2099-01-01";

describe("normalizePeriod", () => {
  it("accepts a YYYY-MM period", () => {
    expect(normalizePeriod("2026-09")).toBe("2026-09");
    expect(normalizePeriod("2026-01")).toBe("2026-01");
    expect(normalizePeriod("2026-12")).toBe("2026-12");
  });

  it("rejects anything that is not a real month", () => {
    for (const invalid of ["2026-13", "2026-00", "2026-9", "2026-09-01", "26-09", "", "September 2026"]) {
      expect(() => normalizePeriod(invalid)).toThrow();
    }
  });
});

describe("dueDateForPeriod", () => {
  it("uses the account's due day inside the billed month", () => {
    expect(dueDateForPeriod("2026-09", 5)).toBe("2026-09-05");
    expect(dueDateForPeriod("2026-09", 28)).toBe("2026-09-28");
  });

  it("clamps a due day that does not exist in a short month", () => {
    // February 2026 has 28 days, so a due day of 31 must not roll into March.
    expect(dueDateForPeriod("2026-02", 31)).toBe("2026-02-28");
    expect(dueDateForPeriod("2024-02", 31)).toBe("2024-02-29");
  });

  it("always produces a date inside the billed period", () => {
    for (const period of ["2026-01", "2026-02", "2026-04", "2026-12", "2024-02"]) {
      const due = dueDateForPeriod(period, 31);
      expect(due.startsWith(period)).toBe(true);
    }
  });
});

describe("monthsBetween", () => {
  it("enumerates an inclusive range", () => {
    expect(monthsBetween("2026-07", "2026-10")).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10"
    ]);
  });

  it("returns a single period when start equals end", () => {
    expect(monthsBetween("2026-09", "2026-09")).toEqual(["2026-09"]);
  });

  it("rolls over the year boundary", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02"
    ]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(monthsBetween("2026-10", "2026-07")).toEqual([]);
  });
});

describe("deriveInvoiceStatus", () => {
  it("marks a settled invoice PAID regardless of the due date", () => {
    expect(deriveInvoiceStatus(0, 99_900, PAST, "UNPAID")).toBe("PAID");
    expect(deriveInvoiceStatus(0, 99_900, FUTURE, "OVERDUE")).toBe("PAID");
  });

  it("marks an unpaid invoice past its due date OVERDUE", () => {
    expect(deriveInvoiceStatus(99_900, 0, PAST, "UNPAID")).toBe("OVERDUE");
  });

  it("keeps a partially paid invoice distinct from an unpaid one", () => {
    expect(deriveInvoiceStatus(40_000, 59_900, FUTURE, "UNPAID")).toBe("PARTIALLY_PAID");
    expect(deriveInvoiceStatus(40_000, 59_900, PAST, "UNPAID")).toBe("OVERDUE");
  });

  it("leaves a not-yet-due invoice alone", () => {
    expect(deriveInvoiceStatus(99_900, 0, FUTURE, "UNPAID")).toBe("UNPAID");
  });

  it("never resurrects a voided, draft or credited invoice", () => {
    // These states are set deliberately by void/adjust, and re-deriving from the
    // balance must not quietly undo them.
    expect(deriveInvoiceStatus(0, 0, PAST, "VOID")).toBe("VOID");
    expect(deriveInvoiceStatus(99_900, 0, PAST, "DRAFT")).toBe("DRAFT");
    expect(deriveInvoiceStatus(0, 99_900, PAST, "CREDITED")).toBe("CREDITED");
  });

  it("treats an overpaid invoice as settled", () => {
    expect(deriveInvoiceStatus(-5_000, 104_900, FUTURE, "UNPAID")).toBe("PAID");
  });
});

describe("lastDayOfPeriod", () => {
  it("knows the length of each month, including leap years", () => {
    expect(lastDayOfPeriod("2026-02")).toBe(28);
    expect(lastDayOfPeriod("2024-02")).toBe(29);
    expect(lastDayOfPeriod("2026-01")).toBe(31);
    expect(lastDayOfPeriod("2026-04")).toBe(30);
    expect(lastDayOfPeriod("2026-12")).toBe(31);
  });
});
