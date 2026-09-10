/**
 * The closed vocabularies, typed errors and bounds of the failure-recovery
 * plane (platform failure-recovery plane; WORK-055 / E1.1 charter member
 * "Failure-aware recovery, fresh escalation and continuation" — ADR-0019,
 * ADR-0020).
 *
 * THE UNIFIED FAILURE ATTRIBUTION VOCABULARY: ADR-0020 demands that
 * "intelligence failures and infrastructure/provider/tool failures must
 * be distinguished so retries and routing do not create runaway token
 * inflation or misattribute environmental defects to model quality".
 * This catalog closes that taxonomy ONCE, fail-closed:
 *
 *  - the five FAILURE CLASSES are closed and typed
 *    (infrastructure/provider/tool/resource/intelligence — architecture
 *    invariant 6: unattributed or cross-classified failures are
 *    rejected, never guessed);
 *  - the closed observation-signal vocabulary is the ONLY input an
 *    attribution may be built from — every signal maps to its closed
 *    set of ADMISSIBLE classes (a signal that means an unreachable
 *    transport can never become an intelligence failure — the
 *    misattribution ADR-0020 forbids is structurally unrepresentable);
 *  - the recovery strategy vocabulary is closed
 *    (retry / re-route / escalate-fresh / fail) — `fail` is the
 *    zero-recovery strategy, always representable (architecture
 *    invariant 7);
 *  - every bound (component refs, details, attempt counts, evidence
 *    entries) is explicit and total: unbounded values are typed
 *    rejections, never silent defaults.
 *
 * Everything here is neutral vocabulary: component references are
 * OPAQUE bounded slugs (no vendor, no provider SDK semantics — the
 * discipline shared with the whole E1.1 family).
 */

// ---------------------------------------------------------------------------
// The closed failure taxonomy (ADR-0020's required distinction)
// ---------------------------------------------------------------------------

/**
 * THE five failure classes of the unified taxonomy. Closed: a failure
 * outside these classes is unrepresentable (typed rejection).
 */
export const FAILURE_CLASSES = [
  "infrastructure",
  "provider",
  "tool",
  "resource",
  "intelligence",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * The closed observation-signal vocabulary — the ONLY failure shapes an
 * execution seam may report into this plane. Each signal carries its
 * closed admissible-class set (below): attribution is the act of
 * choosing ONE admissible class with its class-specific evidence.
 */
export const FAILURE_SIGNALS = [
  "transport-unreachable",
  "transport-timeout",
  "provider-rate-limited",
  "provider-server-error",
  "provider-capacity",
  "tool-invocation-error",
  "tool-rejected",
  "resource-exhausted",
  "verification-failed",
  "quality-below-expectation",
] as const;
export type FailureSignal = (typeof FAILURE_SIGNALS)[number];

/**
 * The closed signal → admissible-classes discipline. This table IS the
 * anti-misattribution invariant (ADR-0020): an infrastructure signal
 * can never be attributed to intelligence; a quality signal can never
 * be attributed to infrastructure. Cross-classification is a typed
 * rejection, not a reinterpretation.
 */
export const SIGNAL_CLASS_ADMISSIBILITY: Readonly<Record<FailureSignal, readonly FailureClass[]>> =
  {
    "transport-unreachable": ["infrastructure"],
    "transport-timeout": ["infrastructure"],
    "provider-rate-limited": ["provider"],
    "provider-server-error": ["provider"],
    "provider-capacity": ["provider"],
    "tool-invocation-error": ["tool"],
    "tool-rejected": ["tool"],
    "resource-exhausted": ["resource"],
    "verification-failed": ["intelligence"],
    "quality-below-expectation": ["intelligence"],
  };

/** The closed provider error-surface vocabulary (class evidence). */
export const PROVIDER_ERROR_CLASSES = ["rate-limited", "server-error", "capacity"] as const;
export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

/** The closed resource-exhaustion vocabulary (class evidence). */
export const RESOURCE_KINDS = ["budget", "quota", "capacity"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The signal → provider-error-class coherence (typed evidence binding). */
export const SIGNAL_PROVIDER_ERROR_CLASS: Readonly<
  Record<"provider-rate-limited" | "provider-server-error" | "provider-capacity", ProviderErrorClass>
> = {
  "provider-rate-limited": "rate-limited",
  "provider-server-error": "server-error",
  "provider-capacity": "capacity",
};

// ---------------------------------------------------------------------------
// The closed recovery vocabulary
// ---------------------------------------------------------------------------

/**
 * THE four recovery strategies (the Work Order's closed vocabulary).
 * `fail` is the zero-recovery strategy — always representable, always
 * honest (architecture invariant 7: fail-closed when no recovery
 * strategy is economically justified).
 */
export const RECOVERY_STRATEGIES = ["retry", "re-route", "escalate-fresh", "fail"] as const;
export type RecoveryStrategy = (typeof RECOVERY_STRATEGIES)[number];

/** The closed re-route dimensions (the two declared economics planes). */
export const REROUTE_DIMENSIONS = ["model", "substrate"] as const;
export type RerouteDimension = (typeof REROUTE_DIMENSIONS)[number];

/**
 * The closed reason-code vocabulary for strategy inadmissibility and
 * the fail-closed outcome — every rejection carries EXACTLY ONE code
 * (recorded, never silent).
 */
export const RECOVERY_INADMISSIBLE_CODES = [
  "class-not-retryable",
  "retry-attempt-bound",
  "retry-not-transient",
  "budget-resource-not-retryable",
  "no-alternative-route",
  "no-substrate-selection",
  "escalation-not-justified",
  "quality-below-hard-floor",
  "quality-below-assurance",
  "reliability-below-floor",
  "budget-ceiling",
  "latency-ceiling",
] as const;
export type RecoveryInadmissibleCode = (typeof RECOVERY_INADMISSIBLE_CODES)[number];

/** The closed fail-closed reason vocabulary (the zero-recovery evidence). */
export const RECOVERY_FAIL_CLOSED_CODES = [
  "no-admissible-strategy",
  "no-economic-justification",
] as const;
export type RecoveryFailClosedCode = (typeof RECOVERY_FAIL_CLOSED_CODES)[number];

// ---------------------------------------------------------------------------
// Bounds (every value the plane admits is bounded)
// ---------------------------------------------------------------------------

/** Bounded opaque component references (neutral slugs, no vendor words). */
export const COMPONENT_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Bounded step/component detail text. */
export const DETAIL_MAX = 500;
/** The hard bound on retry attempts the configuration may declare. */
export const MAX_RETRY_ATTEMPTS = 10;
/** The hard bound on evidence entries an escalation package may carry. */
export const MAX_ESCALATION_EVIDENCE_ENTRIES = 64;
/** The hard bound on step entries a continuation package may carry. */
export const MAX_CONTINUATION_STEPS = 256;
/** The hard bound on environment fingerprint entries. */
export const MAX_FINGERPRINT_ENTRIES = 128;
/** Bounded tool error codes (class evidence). */
export const TOOL_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** sha256 hex digest shape (content addressing across the plane). */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** The bounded detail ceiling shared with the sibling planes. */
export const BASIS_DETAIL_MAX = 500;

/** Bounded detail helper (the sibling planes' own discipline). */
export function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

// ---------------------------------------------------------------------------
// The typed, bounded failure-recovery error
// ---------------------------------------------------------------------------

/**
 * The closed invariant-code vocabulary of the failure-recovery plane.
 * Every rejection names exactly one — machine-checkable, bounded
 * evidence:
 *
 *  - `observation-shape` — a failure observation failed its total
 *    validation (signal vocabulary, component ref, bounds, digest);
 *  - `attribution-unattributed` — an attribution input carries no
 *    class or no class-specific evidence (no attribution → no
 *    recovery action — invariant 1);
 *  - `attribution-cross-classified` — the claimed class is outside
 *    the signal's admissible set, or the class evidence does not
 *    match the claimed class (the ADR-0020 misattribution guard);
 *  - `attribution-shape` — the attribution value failed round-trip
 *    validation (identity, evidence coherence);
 *  - `recovery-input-shape` — the strategy-selection input failed its
 *    total validation (configuration bounds, context bounds, claims);
 *  - `strategy-shape` — a strategy candidate/verdict is invalid;
 *  - `fingerprint-shape` — an environment fingerprint failed its
 *    total validation (entry vocabulary, bounds, identity);
 *  - `continuation-shape` — a continuation package failed its total
 *    validation (shape, bounds, identity);
 *  - `continuation-drift` — the resumed environment does not match
 *    the package's fingerprint (fail-closed drift rejection);
 *  - `escalation-shape` — an escalation package failed its total
 *    validation (bounds, evidence coherence, continuation payload);
 *  - `decision-invalid` — a WORK-049 decision record failed its own
 *    total validation (fail closed — never emitted unvalidated).
 */
export const FAILURE_RECOVERY_INVARIANT_CODES = [
  "observation-shape",
  "attribution-unattributed",
  "attribution-cross-classified",
  "attribution-shape",
  "recovery-input-shape",
  "strategy-shape",
  "fingerprint-shape",
  "continuation-shape",
  "continuation-drift",
  "escalation-shape",
  "decision-invalid",
] as const;
export type FailureRecoveryInvariantCode = (typeof FAILURE_RECOVERY_INVARIANT_CODES)[number];

/** The typed, bounded failure-recovery error. */
export class FailureRecoveryError extends Error {
  readonly invariant: FailureRecoveryInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: FailureRecoveryInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "FailureRecoveryError";
    this.invariant = invariant;
    const boundedDetails: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        boundedDetails[key] = typeof value === "string" ? boundedDetail(value) : value;
      }
    }
    this.details = Object.freeze(boundedDetails);
  }
}

const DETAIL_LIMIT = 200;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** Fail closed with the typed error (never a silent default). */
export function reject(
  invariant: FailureRecoveryInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new FailureRecoveryError(invariant, message, details);
}
