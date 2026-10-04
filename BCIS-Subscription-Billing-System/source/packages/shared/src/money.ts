/**
 * Authoritative money handling for BCIS.
 *
 * The laboratory specification forbids JavaScript floating-point arithmetic for
 * monetary calculations. Every monetary value in this system is therefore
 * represented as an integer number of centavos (1 peso = 100 centavos) and is
 * persisted in PostgreSQL as `bigint`.
 *
 * 2^53 centavos is 90 trillion pesos, so JS `number` is exact for every value
 * this application can realistically hold while remaining integer-only.
 */

export type Centavos = number;

export const CENTAVOS_PER_PESO = 100;

// A peso amount with at most two decimal places. The integer part is optional so
// that a cashier typing ".50" in a peso field is understood as 50 centavos, but
// at least one digit is always required, so "." alone is still rejected.
const PESO_PATTERN = /^-?(?:\d{1,15}(?:\.\d{1,2})?|\.\d{1,2})$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Parse user input into integer centavos without ever performing float math.
 * Accepts `1234.56`, `"1234.56"`, `1234`, `".5"`, `"1,234.56"`.
 */
export function parseCentavos(input: string | number | null | undefined): Centavos {
  if (input === null || input === undefined || input === "") {
    throw new MoneyError("Amount is required.");
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new MoneyError("Amount must be a finite number.");
    }
    // Numbers reaching us from JSON are already doubles; reject anything that
    // cannot be expressed with at most two decimal places.
    const asString = String(input);
    if (!PESO_PATTERN.test(asString)) {
      throw new MoneyError("Amount must have at most two decimal places.");
    }
    return fromDecimalString(asString);
  }

  const normalized = input.trim().replace(/,/g, "").replace(/^\+/, "");
  if (!PESO_PATTERN.test(normalized)) {
    throw new MoneyError("Amount must be a positive number with at most two decimal places.");
  }
  return fromDecimalString(normalized);
}

function fromDecimalString(value: string): Centavos {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = fraction.padEnd(2, "0").slice(0, 2);
  const centavos = Number(whole) * CENTAVOS_PER_PESO + Number(padded);
  return negative ? -centavos : centavos;
}

export function assertCentavos(value: number, label = "Amount"): Centavos {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of centavos (received ${value}).`);
  }
  return value;
}

export function add(...values: number[]): Centavos {
  return assertCentavos(
    values.reduce((total, value) => total + assertCentavos(value), 0)
  );
}

export function subtract(left: number, right: number): Centavos {
  return assertCentavos(assertCentavos(left) - assertCentavos(right));
}

export function sum(values: readonly number[]): Centavos {
  return add(...values);
}

export function negate(value: number): Centavos {
  return assertCentavos(-assertCentavos(value));
}

export function isZero(value: number): boolean {
  return assertCentavos(value) === 0;
}

export function clampNonNegative(value: number): Centavos {
  const checked = assertCentavos(value);
  return checked < 0 ? 0 : checked;
}

export function toPesos(centavos: number): number {
  return assertCentavos(centavos) / CENTAVOS_PER_PESO;
}

/** Exact pesos string, e.g. 123456 -> "1234.56". Never used for arithmetic. */
export function toDecimalString(centavos: number): string {
  const checked = assertCentavos(centavos);
  const negative = checked < 0;
  const absolute = Math.abs(checked);
  const whole = Math.trunc(absolute / CENTAVOS_PER_PESO);
  const fraction = String(absolute % CENTAVOS_PER_PESO).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

const pesoFormatter = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** Display helper only. `₱1,234.56`. */
export function formatCentavos(centavos: number, options: { withSymbol?: boolean; blankZero?: boolean } = {}): string {
  const checked = assertCentavos(centavos);
  if (options.blankZero && checked === 0) {
    return "—";
  }
  const formatted = pesoFormatter.format(toPesos(checked));
  return options.withSymbol === false ? formatted : `₱${formatted}`;
}

/**
 * Convert centavos to a PostgreSQL-safe bigint string. `pg` returns `bigint`
 * columns as strings to avoid precision loss; keeping the same convention in
 * reports keeps behaviour identical on both sides of the wire.
 */
export function toBigIntString(centavos: number): string {
  return String(assertCentavos(centavos));
}

/**
 * Split `amount` across `weights` proportionally, guaranteeing that the parts
 * sum exactly back to `amount`. The remainder centavo is distributed to the
 * earliest parts so no peso is created or destroyed.
 */
export function distribute(amount: Centavos, weights: readonly number[]): Centavos[] {
  const total = assertCentavos(amount);
  if (weights.length === 0) {
    return [];
  }
  const weightTotal = sum(weights.map((weight) => assertCentavos(weight)));
  if (weightTotal === 0) {
    const even = Math.trunc(total / weights.length);
    const parts = new Array<Centavos>(weights.length).fill(even);
    let remainder = total - even * weights.length;
    for (let index = 0; remainder !== 0; index = (index + 1) % weights.length) {
      const step = remainder > 0 ? 1 : -1;
      parts[index] += step;
      remainder -= step;
    }
    return parts;
  }

  const parts = weights.map((weight) => Math.trunc((total * assertCentavos(weight)) / weightTotal));
  let remainder = total - sum(parts);
  for (let index = 0; remainder !== 0; index = (index + 1) % weights.length) {
    const step = remainder > 0 ? 1 : -1;
    parts[index] += step;
    remainder -= step;
  }
  return parts;
}
