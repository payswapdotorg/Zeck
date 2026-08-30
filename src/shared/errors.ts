/**
 * Canonical error taxonomy (`spec/contracts.md` — "Error taxonomy").
 *
 * Errors are typed and machine-readable. Provider-specific errors are
 * normalized into one of these provider-neutral classes and retained as
 * adapter detail in evidence — never as domain control flow.
 *
 * `tests/unit/errors.test.ts` keeps this list in exact sync with the
 * governing contract document.
 */
export const ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_DENIED",
  "TENANT_SCOPE_VIOLATION",
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "IDEMPOTENCY_KEY_REUSED",
  "CAPABILITY_UNAVAILABLE",
  "NO_ELIGIBLE_ROUTE",
  "PROVIDER_ERROR",
  "TOOL_ERROR",
  "AGENT_ERROR",
  "SANDBOX_ERROR",
  "VERIFICATION_FAILED",
  "VERIFICATION_INCONCLUSIVE",
  "NON_CONVERGENT_EXTERNAL_EFFECT",
  "INVALID_STATE_TRANSITION",
  "EXPIRED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PlatformErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  /** Whether retrying the same logical operation may succeed. Defaults to false. */
  readonly retryable?: boolean;
  /** Machine-readable structured detail (never secret material). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Machine-readable shape used at transport boundaries. */
export interface PlatformErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The single error type crossing module and transport boundaries.
 * Application APIs serialize the `toJSON()` shape, not error internals.
 */
export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: PlatformErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "PlatformError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): PlatformErrorBody {
    if (this.details === undefined) {
      return {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      };
    }
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}
