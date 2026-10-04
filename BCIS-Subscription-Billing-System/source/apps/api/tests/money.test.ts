import { describe, expect, it } from "vitest";

import {
  CENTAVOS_PER_PESO,
  MoneyError,
  add,
  assertCentavos,
  distribute,
  formatCentavos,
  parseCentavos,
  subtract,
  sum,
  toDecimalString,
  toPesos
} from "@bcis/shared";

/**
 * The lab specification forbids floating-point arithmetic for money, so these
 * tests exist to pin down the integer-centavos contract. Every assertion here is
 * about exactness, not formatting taste.
 */
describe("money", () => {
  describe("parseCentavos", () => {
    it("converts pesos to integer centavos without float rounding", () => {
      expect(parseCentavos(999)).toBe(99_900);
      expect(parseCentavos("999")).toBe(99_900);
      expect(parseCentavos("1234.56")).toBe(123_456);
      expect(parseCentavos(1234.56)).toBe(123_456);
      expect(parseCentavos(".5")).toBe(50);
      expect(parseCentavos("1,234.56")).toBe(123_456);
    });

    it("keeps cent precision that binary floats cannot represent", () => {
      // 0.1 + 0.2 !== 0.3 in IEEE-754; the centavos path must still be exact.
      expect(add(parseCentavos("0.1"), parseCentavos("0.2"))).toBe(parseCentavos("0.3"));
      expect(sum([parseCentavos("10.10"), parseCentavos("20.20")])).toBe(3_030);
    });

    it("pads a single decimal place rather than dropping it", () => {
      expect(parseCentavos("12.5")).toBe(1_250);
      expect(parseCentavos("12.05")).toBe(1_205);
    });

    it("rejects amounts that are not exact to the centavo", () => {
      expect(() => parseCentavos("12.345")).toThrow(MoneyError);
      expect(() => parseCentavos(12.345)).toThrow(MoneyError);
      expect(() => parseCentavos(".")).toThrow(MoneyError);
      expect(() => parseCentavos(" pesos")).toThrow(MoneyError);
    });

    it("rejects empty, non-numeric and non-finite input", () => {
      expect(() => parseCentavos("")).toThrow(MoneyError);
      expect(() => parseCentavos(null)).toThrow(MoneyError);
      expect(() => parseCentavos(undefined)).toThrow(MoneyError);
      expect(() => parseCentavos("abc")).toThrow(MoneyError);
      expect(() => parseCentavos(Number.NaN)).toThrow(MoneyError);
      expect(() => parseCentavos(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    });

    it("allows negative values so credits and reversals can be represented", () => {
      expect(parseCentavos("-50.25")).toBe(-5_025);
      expect(toDecimalString(-5_025)).toBe("-50.25");
    });
  });

  describe("arithmetic", () => {
    it("refuses non-integer operands instead of silently rounding", () => {
      expect(() => add(1_000, 0.5)).toThrow(MoneyError);
      expect(() => assertCentavos(1.5)).toThrow(MoneyError);
      expect(() => subtract(1_000.5, 100)).toThrow(MoneyError);
    });

    it("computes differences exactly", () => {
      expect(subtract(10_000, 2_500)).toBe(7_500);
      expect(subtract(2_500, 10_000)).toBe(-7_500);
    });

    it("sums an empty list to zero", () => {
      expect(sum([])).toBe(0);
    });
  });

  describe("distribute", () => {
    it("splits an amount without creating or destroying a centavo", () => {
      const parts = distribute(10_000, [1, 1, 1]);
      expect(sum(parts)).toBe(10_000);
      expect(parts).toEqual([3_334, 3_333, 3_333]);
    });

    it("splits proportionally by weight and still reconciles exactly", () => {
      const parts = distribute(1_000, [70, 20, 10]);
      expect(parts).toEqual([700, 200, 100]);
      expect(sum(parts)).toBe(1_000);
    });

    it("handles an indivisible amount and zero weights", () => {
      expect(sum(distribute(100, [1, 1, 1]))).toBe(100);
      expect(sum(distribute(101, [0, 0, 0]))).toBe(101);
      expect(distribute(0, [1, 2])).toEqual([0, 0]);
    });

    it("returns nothing when there is nothing to distribute", () => {
      expect(distribute(1_000, [])).toEqual([]);
    });
  });

  describe("formatting", () => {
    it("renders pesos for display only", () => {
      expect(formatCentavos(99_900)).toBe("₱999.00");
      expect(formatCentavos(99_900, { withSymbol: false })).toBe("999.00");
      expect(formatCentavos(0, { blankZero: true })).toBe("—");
      expect(formatCentavos(-5_025)).toBe("₱-50.25");
      expect(toPesos(123_456)).toBe(1234.56);
      expect(CENTAVOS_PER_PESO).toBe(100);
    });
  });
});
