/**
 * Economic money representation (economics module domain; WORK-032).
 *
 * The SAME canonical representation the budgets module froze (WORK-004):
 * integer micro-USD decimal strings end to end. Floating point and
 * negative amounts are unrepresentable; every amount parses through
 * `parseEconomicMicroUsd` (typed failure, never coercion) and all
 * arithmetic/comparison is `bigint`.
 *
 * This is a representation convention, NOT a second ledger: the economics
 * module owns no balances, no wallets and no ledger of its own — every
 * money MOVEMENT happens through the budgets module's `BudgetAuthority`
 * (reservation/settlement), and economics only carries request-side
 * amounts (intent bounds, authorization ceilings, observed settlement
 * amounts as correlated evidence).
 */

/** Integer micro-USD decimal string (same shape as budgets MicroUsd). */
export type EconomicMicroUsd = string;

/** Upper bound identical to budgets MAX_MICRO_USD (the platform-wide safe bigint window). */
export const MAX_ECONOMIC_MICRO_USD = "9223372036854775807" as const;

const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

/** Total, deterministic micro-USD parse: typed failure on any non-canonical form. */
export function parseEconomicMicroUsd(value: string): bigint {
  if (typeof value !== "string" || !MICRO_USD_PATTERN.test(value)) {
    throw new Error(
      `amount must be a non-negative integer micro-USD decimal string (got: ${String(value)})`,
    );
  }
  return BigInt(value);
}

/** Structural check (no throw) — used by request validation. */
export function isEconomicMicroUsd(value: unknown): value is EconomicMicroUsd {
  return typeof value === "string" && MICRO_USD_PATTERN.test(value);
}

/** Deterministic comparison: negative when a < b, zero when equal, positive when a > b. */
export function compareEconomicMicroUsd(a: string, b: string): number {
  const left = parseEconomicMicroUsd(a);
  const right = parseEconomicMicroUsd(b);
  return left < right ? -1 : left === right ? 0 : 1;
}

/** Deterministic bound check: min <= value <= max. */
export function amountWithinBounds(value: string, min: string, max: string): boolean {
  const candidate = parseEconomicMicroUsd(value);
  return candidate >= parseEconomicMicroUsd(min) && candidate <= parseEconomicMicroUsd(max);
}
