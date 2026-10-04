import { formatCentavos } from "@bcis/shared";

/**
 * Response presentation helpers.
 *
 * Shared by every route module that returns peso amounts, so the "attach the
 * formatted value next to the integer" convention is defined once. The rule is
 * that a `*Centavos` number is never replaced - the renderer and any external
 * consumer keep the exact integer and simply get a sibling `money` entry to
 * display. Re-deriving the string in the renderer is how a peso figure ends up
 * disagreeing with the ledger.
 */
export function withMoney<T extends object>(row: T): T & { money: Record<string, string> } {
  return {
    ...row,
    money: Object.fromEntries(
      Object.entries(row as Record<string, unknown>)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => [key, formatCentavos(value as number)])
    )
  };
}

/** Applies {@link withMoney} to each item of a paged result. */
export function withMoneyItems<T extends object, R extends { items: T[] }>(
  result: R
): R & { items: (T & { money: Record<string, string> })[] } {
  return { ...result, items: result.items.map((item) => withMoney(item)) };
}
