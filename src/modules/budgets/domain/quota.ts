/**
 * Sandbox quota domain (budgets module; DEP-014).
 *
 * The QUOTA vocabulary: per-owner-scope limits over the sandbox lifecycle
 * dimensions a developer must see and control — spend, wall-clock time,
 * concurrent runs, artifact count and artifact bytes. The budgets module
 * remains the ONE budget/quota authority: spend quotas resolve through
 * the existing fail-closed reservation discipline; time/concurrency/
 * artifact quotas enforce at sandbox admission with the same discipline.
 *
 * Money: integer micro-USD decimal strings (the module convention).
 * Windows: calendar-month (aligned with the budget period) or
 * per-identity (the disposable-sandbox lifetime). Rolling windows are a
 * future dimension — not invented here.
 */

/** The quota dimensions the sandbox lifecycle governs (DEP-014 AC1/2). */
export const QUOTA_DIMENSIONS = [
  "spend-micro-usd",
  "wall-clock-ms",
  "concurrent-runs",
  "artifact-count",
  "artifact-bytes",
] as const;

export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

export function isQuotaDimension(value: string): value is QuotaDimension {
  return (QUOTA_DIMENSIONS as readonly string[]).includes(value);
}

/** The consumption window + reset semantics of a quota record. */
export const QUOTA_WINDOWS = ["calendar-month", "per-identity"] as const;

export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export function isQuotaWindow(value: string): value is QuotaWindow {
  return (QUOTA_WINDOWS as readonly string[]).includes(value);
}

/** The quota status vocabulary (an exhausted quota fails closed). */
export const QUOTA_STATUSES = ["active", "exhausted"] as const;

export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

/**
 * One quota record: the limit, the current consumption, the window and
 * the status for one (scope, dimension) pair. Consumption is a decimal
 * string in the dimension's unit (micro-USD for spend; ms; runs; count;
 * bytes) — integer arithmetic end to end, never floats.
 */
export interface QuotaRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly dimension: QuotaDimension;
  readonly limit: string;
  readonly consumed: string;
  readonly window: QuotaWindow;
  readonly status: QuotaStatus;
  /** The identity the per-identity window is anchored to (else null). */
  readonly identityId: string | null;
  readonly updatedAt: string;
}

/** A recorded quota violation: facts only (dimension, decision) — never payloads. */
export interface QuotaViolationFact {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly dimension: QuotaDimension;
  readonly decision: "denied";
  readonly occurredAt: string;
}

/**
 * Fail-closed comparison: returns true when consuming `amount` more of
 * `dimension` would exceed `limit`. Oversized or malformed values deny
 * (fail-closed) — never default-allow.
 */
export function quotaWouldExceed(
  dimension: QuotaDimension,
  limit: string,
  consumed: string,
  amount: string,
): boolean {
  const parse = (value: string, what: string): bigint | null => {
    if (!/^\d+$/.test(value)) {
      return null;
    }
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  };
  const limitB = parse(limit, "limit");
  const consumedB = parse(consumed, "consumed");
  const amountB = parse(amount, "amount");
  if (limitB === null || consumedB === null || amountB === null) {
    return true;
  }
  return consumedB + amountB > limitB;
}
