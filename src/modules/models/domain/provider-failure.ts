/**
 * Provider failure taxonomy (models module domain, CON-005).
 *
 * Provider transport/protocol failures normalize into `ProviderFailure` —
 * a DURABLY DISTINCT class from task-quality/verification failure. The
 * canonical platform taxonomy (`spec/contracts.md`) keeps both axes separate:
 * a provider failure is `PROVIDER_ERROR`; quality failure belongs to the
 * verification axis (`VERIFICATION_FAILED`, `VERIFICATION_INCONCLUSIVE`) and
 * is produced only by verification authorities (`spec/architecture.md` §18:
 * "The platform must distinguish provider success, execution success, quality
 * success, policy success"). No provider mapping may ever produce a
 * verification code — proven by
 * `tests/discrimination/provider-quality-distinction.discrimination.test.ts`.
 */

import { PlatformError } from "../../../shared/errors";

/** Normalized provider-error categories (`spec/contracts.md` error taxonomy). */
export const PROVIDER_ERROR_CATEGORIES = [
  "authentication",
  "authorization",
  "rate-limit",
  "quota",
  "invalid-request",
  "content-policy",
  "provider-unavailable",
  "timeout",
  "network",
  "malformed-response",
  "canceled",
  "unknown",
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

/** Whether retrying the same logical dispatch may succeed. */
const RETRYABLE_CATEGORIES: readonly ProviderErrorCategory[] = [
  "rate-limit",
  "provider-unavailable",
  "timeout",
  "network",
];

export interface ProviderFailure {
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  /** Rail the failure came from (slug, not a provider type). */
  readonly rail: string;
  /** Provider-reported error code/token (sanitized, never credentials). */
  readonly providerCode: string | null;
  /** Human-readable provider message, length-capped and credential-free. */
  readonly providerMessage: string | null;
  /** HTTP status when the failure came from an HTTP exchange. */
  readonly httpStatus: number | null;
  /** Wall-clock duration of the failed attempt in milliseconds. */
  readonly durationMs: number | null;
}

export function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.includes(category);
}

/**
 * Structural guard identifying a normalized `ProviderFailure` among unknown
 * thrown values. The gateway uses this as defense-in-depth: an adapter that
 * violates the port contract ("never a thrown provider error") still gets its
 * KNOWN provider failure durably recorded instead of leaving the attempt at
 * `dispatching`. Unknown crash values fail this guard and rethrow — honest
 * evidence of an unknown external outcome.
 */
export function isProviderFailure(value: unknown): value is ProviderFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.category === "string" &&
    (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(candidate.category) &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.rail === "string" &&
    (candidate.providerCode === null || typeof candidate.providerCode === "string") &&
    (candidate.providerMessage === null || typeof candidate.providerMessage === "string") &&
    (candidate.httpStatus === null || typeof candidate.httpStatus === "number") &&
    (candidate.durationMs === null || typeof candidate.durationMs === "number")
  );
}

/** Maximum retained provider message length — normalization truncates beyond this. */
const MAX_PROVIDER_MESSAGE_LENGTH = 300;

export function sanitizeProviderMessage(message: string | null | undefined): string | null {
  if (typeof message !== "string") {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= MAX_PROVIDER_MESSAGE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…`;
}

/**
 * Convert a normalized provider failure into the canonical platform error.
 * ALWAYS `PROVIDER_ERROR` — provider failures never masquerade as quality or
 * verification outcomes (CON-005).
 */
export function toPlatformProviderError(failure: ProviderFailure): PlatformError {
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: `provider failure (${failure.rail}/${failure.category})`,
    retryable: failure.retryable,
    details: {
      rail: failure.rail,
      category: failure.category,
      providerCode: failure.providerCode,
      httpStatus: failure.httpStatus,
    },
  });
}
