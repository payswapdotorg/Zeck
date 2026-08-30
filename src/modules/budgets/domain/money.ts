/**
 * Money as integer minor units (budgets module domain).
 *
 * Every amount in this module is an integer count of micro-USD (1e-6 USD),
 * represented in TypeScript as a canonical DECIMAL STRING and in
 * PostgreSQL as `bigint`. Floating point is unrepresentable: values parse
 * through `parseMicroUsd`, which rejects signs, exponents, decimals and
 * any non-canonical form. Arithmetic happens on `bigint` only
 * (`IMPLEMENTATION.md` §8: transactional accounting, no silent rounding).
 */

/** Integer micro-USD amount — canonical non-negative decimal string. */
export type MicroUsd = string & { readonly __microUsd: unique symbol };

const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

/** Maximum representable amount (10^18 - 1 micro-USD, the bigint column range). */
export const MAX_MICRO_USD = "999999999999999999" as MicroUsd;

export function isMicroUsd(value: string): value is MicroUsd {
  return MICRO_USD_PATTERN.test(value);
}

/**
 * Parse a micro-USD amount from a string or bigint. Rejects floats,
 * negative values, leading zeros, whitespace and values beyond the
 * PostgreSQL `bigint` column range — money never silently coerces.
 */
export function parseMicroUsd(value: string | bigint): MicroUsd {
  const canonical = typeof value === "bigint" ? value.toString() : value;
  if (!MICRO_USD_PATTERN.test(canonical)) {
    throw new RangeError(`not an integer micro-USD amount in [0, 10^18): ${String(value)}`);
  }
  return canonical as MicroUsd;
}

export function toMicroUsdBigint(value: MicroUsd): bigint {
  return BigInt(value);
}

export function microUsdFromBigint(value: bigint): MicroUsd {
  return parseMicroUsd(value);
}

export function addMicroUsd(a: MicroUsd, b: MicroUsd): MicroUsd {
  return microUsdFromBigint(BigInt(a) + BigInt(b));
}

export function subMicroUsd(a: MicroUsd, b: MicroUsd): MicroUsd {
  return microUsdFromBigint(BigInt(a) - BigInt(b));
}

export function compareMicroUsd(a: MicroUsd, b: MicroUsd): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `a > b` for micro-USD amounts. */
export function greaterThan(a: MicroUsd, b: MicroUsd): boolean {
  return compareMicroUsd(a, b) > 0;
}

/**
 * Deterministic UTC calendar-month key of a moment in time: `YYYY-MM`.
 *
 * The monthly budget window is DERIVED from the UTC timestamp — never from
 * wall-clock locale or a configurable window — so a reservation's month is
 * a pure function of when it was created (BUD-001 "monthly" determinism).
 */
export function monthKeyOf(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  return `${year}-${month < 10 ? "0" : ""}${month}`;
}

const MONTH_KEY_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_KEY_PATTERN.test(value);
}
