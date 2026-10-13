/**
 * Tail-pacing configuration (executions module domain, ACR-010 §3–§4;
 * work order PCL-002 — the declarative retry/cooldown/progress
 * configuration, default-off and absence-equivalent).
 *
 * THE MEASURED MECHANICS THIS MODULE TYPES (ACR-010 §1/§3): the
 * execution pipeline's pacing parameters — retry delays and backoff
 * shape, provider cooldown entry/exit by failure class, status-polling
 * interval and compression, and event-vs-polled progress delivery —
 * lived as scattered code constants and environment-read configuration
 * (`ZECK_QUEUE_RETRY_BACKOFF_MS` and siblings: repository-declared
 * defaults, process-environment overrides), so a tail-tuned posture
 * could not be DECLARED, VERSIONED and EVALUATED as one typed object.
 * `TailPacingConfiguration` is that object: a typed, closed, VERSIONED
 * block of CONFIGURATION DATA describing the pacing the existing
 * pipeline applies — DATA, never an engine (no new router, no second
 * planner, no retry executor, no verification service, no evidence
 * authority — the E1.1 non-redundancy invariant and ACR-010 §6). The
 * existing machinery reads its parameters from this configuration at
 * the wired seam (`adapters/tail-pacing.ts`); this module wires itself
 * into NOTHING.
 *
 * PLACEMENT (the location study, in the PCL-001 tradition): the
 * configuration types the EXECUTION pipeline's pacing, and the
 * mechanics it configures RECORD through the executions module's own
 * outcome-latency facts (PCL-001 — the per-failure-class evidence
 * plane). The pure configuration plane therefore lives in the
 * executions module's domain layer, beside `outcome-latency-facts.ts`
 * (the artifact it consumes READ-ONLY: the failure taxonomy, the
 * progress-delivery vocabularies and the cooldown-state vocabulary are
 * IMPORTED from it, never mirrored, never redefined — the work order's
 * read-only-consumption law), exactly as PCL-001 placed its typed
 * facts beside the outcome record they type. Domain layering
 * (AGENTS.md + the enforced dependency rules): this file imports
 * SAME-MODULE domain files only — never a platform plane, never a
 * cross-module surface, never a runtime package.
 *
 * THE FOUR CONFIGURATION DIMENSIONS (ACR-010 §3, each DATA):
 *
 *   retry pacing      → bounded, jittered backoff with a declared
 *                       ceiling; the SHAPE (linear | exponential) and
 *                       the bounds are configuration data. The jitter
 *                       fraction is declared; the jitter DRAW is always
 *                       INJECTED at the seam (this module never reads
 *                       randomness — the PCL-001 no-ambient law); the
 *                       declared ceiling binds AFTER jitter (a jittered
 *                       delay never exceeds the ceiling);
 *   cooldown          → failure-class-aware provider cooldowns with
 *                       EXPLICIT re-entry, keyed to the PCL-001 failure
 *                       taxonomy (a throttle cools differently than a
 *                       5xx — each rule names its class, its duration
 *                       and its re-entry discipline; an unkeyed class
 *                       cools nothing — absence by omission);
 *   progress delivery → event/stream subscription where the transport's
 *                       typed capability facts support it, polled as
 *                       the honest fallback (the ACR-009 pattern: the
 *                       CALLER supplies the transport's typed
 *                       capability truth; this module never imports a
 *                       transport); the polling interval is a declared
 *                       quantity;
 *   timeout gate      → the timeout/terminal-failure preservation
 *                       gate: a configuration that would MASK a
 *                       terminal failure as success (a terminal failure
 *                       class declared retryable) or EXTEND a declared
 *                       timeout beyond its contract (a retry schedule
 *                       or polling interval exceeding the declared
 *                       budget) is REJECTED typed at the configuration
 *                       boundary — fail-closed, invariant-preserving.
 *
 * ABSENCE EQUIVALENCE (ACR-010 §4; the PCR-002/ACR-009 discipline): the
 * configuration is OPTIONAL — `undefined` and `null` are BOTH the
 * absent spelling (the PCL-01 absence law), and an absent
 * configuration selects and records byte-identically to today's
 * behavior at every existing call site: the wired seam is INERT when
 * no configuration is authored (no delay is read, no cooldown is
 * entered, no progress mode is resolved — the caller's existing path
 * runs unchanged, discrimination- and integration-tested). A PRESENT
 * but malformed configuration is REJECTED typed at the boundary —
 * never a silent default, never a partial arm.
 *
 * NO AMBIENT TUNING (ACR-010 §6): no environment read, no clock, no
 * randomness, no I/O anywhere in this module — the pacing
 * configuration is DECLARED and VERSIONED (the `version` field is
 * closed: exactly 1), never environment-scattered flags. Pure and
 * total: the same configuration always produces the byte-identical
 * validation verdict, backoff schedule, cooldown state and progress
 * resolution (invariant 5).
 *
 * NO DURABLE SURFACE, NO ENGINE: this module declares no store, no
 * SQL, no state machine, no route decision, no retry loop, no
 * cooldown timer, no poll loop — it validates configuration data and
 * resolves pacing quantities by pure function. The platform bounds the
 * configuration's quantities mirror are MIRRORED BY VALUE from the
 * planes that own them (the queue plane's backoff base bound, the
 * execution compiler's retry backoff ceiling, the platform recovery
 * plane's (WORK-055) retry-attempt and cooldown bounds, the compute
 * plane's poll interval bounds) — alignment by value, never by import (the PCL-001
 * mirroring discipline; widening a mirrored bound is a reviewed
 * change).
 */

import type {
  DispatchCooldownState,
  LatencyMeasurement,
  OutcomeFailureClass,
  ProgressDeliveryFacts,
  ProgressDeliveryMode,
} from "./outcome-latency-facts";
import { OUTCOME_FAILURE_CLASSES } from "./outcome-latency-facts";

// ---------------------------------------------------------------------------
// The frozen vocabularies (closed — widening is a reviewed change)
// ---------------------------------------------------------------------------

/**
 * The configuration surface version (ACR-010 §3 "versioned"): the
 * closed single-member vocabulary. A configuration carrying any other
 * version is rejected typed at the boundary — never coerced, never
 * defaulted forward.
 */
export const TAIL_PACING_CONFIGURATION_VERSION = 1;
export type TailPacingConfigurationVersion = 1;

/**
 * The closed backoff-shape vocabulary (ACR-010 §3 "the shape and
 * bounds are configuration data"): deterministic linear (`base *
 * attempt`, the queue plane's own shape) or exponential
 * (`base * 2^(attempt-1)`) — both bounded by the declared ceiling.
 */
export const RETRY_BACKOFF_SHAPES = ["linear", "exponential"] as const;
export type RetryBackoffShape = (typeof RETRY_BACKOFF_SHAPES)[number];

/**
 * The closed cooldown re-entry vocabulary (ACR-010 §3 "explicit
 * re-entry"): `expiry` — the cooldown lifts only when its declared
 * duration has fully elapsed; `early-probe` — ONE declared probe may
 * re-enter at a declared fraction of the duration (the remainder of
 * the cooldown re-arms after a failed probe — a probe is one dispatch,
 * never an unbounded probe stream).
 */
export const COOLDOWN_REENTRY_MODES = ["expiry", "early-probe"] as const;
export type CooldownReentryMode = (typeof COOLDOWN_REENTRY_MODES)[number];

/**
 * The closed progress-preference vocabulary (ACR-010 §3 "event/stream
 * subscription where the transport's typed capability facts support
 * it, polled as the honest fallback"): `event-stream-else-polled` —
 * subscribe where the transport's typed capability facts declare
 * event-stream support, poll otherwise; `polled-only` — poll even
 * where the transport could stream (the honest conservative posture).
 */
export const PROGRESS_PREFERENCES = ["event-stream-else-polled", "polled-only"] as const;
export type ProgressPreference = (typeof PROGRESS_PREFERENCES)[number];

/**
 * THE FROZEN TERMINAL FAILURE CLASSES (the preservation gate's own
 * closed set — ACR-010 §3 "terminal-failure behavior is NOT tunable
 * away"): the failure classes that are TERMINAL BY CONTRACT because
 * they are an AUTHORITY's denial — budget exhaustion (the budget
 * authority stays the authority) and policy denial (the policy
 * authority stays the authority). A configuration declaring one of
 * these retryable is the mask-a-terminal-failure-as-success shape and
 * is REJECTED typed at the configuration boundary. The vocabulary
 * aligns BY VALUE with the executions module's governed-rejection
 * codes (BUDGET_EXCEEDED, POLICY_DENIED — the adapters' own
 * "retrying cannot change the decision" set) and with the platform
 * recovery plane's (WORK-055) retry discipline ("budget exhaustion
 * is never retryable"); it is keyed to the PCL-001 failure taxonomy
 * (read-only consumption).
 */
export const TERMINAL_PACING_FAILURE_CLASSES: readonly OutcomeFailureClass[] = [
  "budget-exhausted",
  "policy-denied",
];

/**
 * The closed two-verdict cooldown re-entry admission vocabulary: the
 * dispatch may re-enter now, or the cooldown holds it (naming the
 * class and the bounded milliseconds remaining — the PCL-01
 * cooldown-state vocabulary).
 */
export type CooldownReentryAdmission =
  | { readonly admissible: true; readonly basis: "no-rule" | "expired" | "probe" }
  | {
      readonly admissible: false;
      readonly basis: "cooldown-active";
      readonly failureClass: OutcomeFailureClass;
      readonly remainingMs: number;
    };

// ---------------------------------------------------------------------------
// The mirrored platform bounds (alignment by value, never by import)
// ---------------------------------------------------------------------------

/** The retry-count bound — the platform recovery plane's (WORK-055) MAX_RETRY_ATTEMPTS. */
export const MAX_PACING_RETRIES = 10;
/** The backoff base bound (ms) — the queue plane's MAX_RETRY_BACKOFF_MS. */
export const MAX_BACKOFF_BASE_MS = 60_000;
/** The backoff ceiling bound (ms) — the execution compiler's RETRY_MAX_BACKOFF_MS. */
export const MAX_BACKOFF_CEILING_MS = 600_000;
/** The jitter fraction bound — symmetric ±fraction around the deterministic schedule. */
export const MAX_JITTER_FRACTION = 0.5;
/** The cooldown duration bound (ms) — the platform recovery plane's (WORK-055) MAX_MEASURED_COOLDOWN_MS. */
export const MAX_COOLDOWN_MS = 3_600_000;
/** The poll-interval bounds (ms) — the compute plane's container-runtime POLL_INTERVAL_BOUNDS. */
export const MIN_POLLING_INTERVAL_MS = 50;
export const MAX_POLLING_INTERVAL_MS = 5_000;
/**
 * The timeout-contract bounds (ms): the per-attempt dispatch timeout
 * and the total logical-dispatch budget are each bounded by the
 * PCL-01 latency bound (MAX_LATENCY_MS — one hour).
 */
export const MAX_TIMEOUT_CONTRACT_MS = 3_600_000;
/** The early-probe fraction bounds: a probe may re-enter at (0, 1] of the duration. */
export const MIN_PROBE_FRACTION = 0.05;
/** The bounded rendering of an offending value inside a reason. */
const REASON_VALUE_LIMIT = 200;

// ---------------------------------------------------------------------------
// The typed configuration block (data, never an engine)
// ---------------------------------------------------------------------------

/**
 * Retry pacing (ACR-010 §3): the bounded, jittered backoff with a
 * declared ceiling — the SHAPE and the BOUNDS are configuration data.
 */
export interface RetryPacingConfiguration {
  /** The maximum retries one logical dispatch may take ([0, 10]). */
  readonly maxRetries: number;
  /** The backoff shape and bounds (the declared ceiling binds AFTER jitter). */
  readonly backoff: {
    readonly shape: RetryBackoffShape;
    /** The deterministic base (ms) — the schedule's unit. */
    readonly baseMs: number;
    /** The declared ceiling (ms) — no jittered delay ever exceeds it. */
    readonly ceilingMs: number;
    /**
     * The declared jitter fraction ([0, 0.5]) — the delay is
     * symmetrically spread ±fraction around the deterministic
     * schedule; the DRAW is always injected at the seam (this module
     * never reads randomness).
     */
    readonly jitterFraction: number;
  };
  /**
   * The failure classes a retry may be paced for, keyed to the PCL-001
   * failure taxonomy (read-only consumption; duplicate-free). A
   * TERMINAL class here is the mask-a-terminal-failure-as-success
   * shape — REJECTED typed at the boundary (the preservation gate).
   */
  readonly retryableFailureClasses: readonly OutcomeFailureClass[];
}

/**
 * One failure-class-aware cooldown rule (ACR-010 §3: "a throttle cools
 * differently than a 5xx"): the class (the PCL-01 taxonomy), the
 * duration, and the EXPLICIT re-entry discipline.
 */
export interface CooldownRule {
  readonly failureClass: OutcomeFailureClass;
  /** The cooldown duration (ms) in [0, MAX_COOLDOWN_MS]. */
  readonly cooldownMs: number;
  /** The explicit re-entry discipline (closed vocabulary). */
  readonly reentry: CooldownReentryMode;
  /**
   * The early-probe fraction — REQUIRED exactly when reentry is
   * `early-probe` (the fraction of the duration at which ONE probe may
   * re-enter, in (0, 1]); explicitly absent for `expiry` (the
   * incoherent shape is rejected typed).
   */
  readonly probeAtFraction?: number;
}

/**
 * The cooldown discipline (ACR-010 §3): the per-failure-class rules —
 * duplicate-free by class, possibly PARTIAL (an unkeyed class cools
 * nothing: absence by omission, the honest spelling).
 */
export interface CooldownDisciplineConfiguration {
  readonly rules: readonly CooldownRule[];
}

/**
 * Progress delivery (ACR-010 §3): the declared preference (the
 * transport's own typed capability facts decide whether the
 * event-stream leg is available — the ACR-009 pattern) and the
 * declared polling interval (the honest fallback's quantity).
 */
export interface ProgressDeliveryConfiguration {
  readonly preference: ProgressPreference;
  /** The declared polling interval (ms), in [50, 5000]. */
  readonly pollingIntervalMs: number;
}

/**
 * THE TIMEOUT CONTRACT (the preservation gate's reference — ACR-010
 * §3): the declared timeouts the pacing must not extend beyond.
 * REQUIRED whenever any pacing dimension is authored — the gate is
 * never ambient, never defaulted.
 */
export interface TimeoutContract {
  /**
   * The per-attempt dispatch timeout (ms), in [1, 3_600_000] — the
   * adapter-call contract (today's `defaultTimeoutMs` shape).
   */
  readonly attemptTimeoutMs: number;
  /**
   * The total logical-dispatch budget (ms), in [attemptTimeoutMs,
   * 3_600_000] — the wall-clock contract ONE logical dispatch (all its
   * attempts and paced waits) must fit within.
   */
  readonly dispatchBudgetMs: number;
}

/**
 * THE DECLARATIVE TAIL-PACING CONFIGURATION (ACR-010 §3–§4): a typed,
 * closed, versioned block of pacing DATA — OPTIONAL everywhere
 * (undefined | null = the absent spelling = today's byte-identical
 * behavior). Every dimension is independently optional (each mechanics
 * dimension discriminates on/off through the declared configuration
 * alone); the timeout contract is REQUIRED when any dimension is
 * authored (the preservation gate's reference).
 */
export interface TailPacingConfiguration {
  /** The closed configuration-surface version (exactly 1). */
  readonly version: TailPacingConfigurationVersion;
  readonly retryPacing?: RetryPacingConfiguration;
  readonly cooldownDiscipline?: CooldownDisciplineConfiguration;
  readonly progressDelivery?: ProgressDeliveryConfiguration;
  readonly timeoutContract: TimeoutContract;
}

// ---------------------------------------------------------------------------
// Total, deterministic, fail-closed validation (the configuration
// boundary — unknown values are rejected typed, never defaulted)
// ---------------------------------------------------------------------------

/** Pure validation verdict (the PCL-01 FactValidation spelling, consumed read-only). */
export type PacingValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** The typed, bounded pacing-configuration rejection. */
export class TailPacingConfigurationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "TailPacingConfigurationError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an offending value bounded — the reason names it, never floods. */
function boundedValue(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : value === undefined
          ? "undefined"
          : JSON.stringify(value);
  return rendered.length > REASON_VALUE_LIMIT
    ? `${rendered.slice(0, REASON_VALUE_LIMIT)}…`
    : rendered;
}

function closedVocabularyReason(
  field: string,
  vocabulary: readonly string[],
  value: unknown,
): string {
  return `tailPacingConfiguration.${field} must be one of ${vocabulary.join("|")}: ${boundedValue(value)}`;
}

function validateBoundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  integer: boolean,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `tailPacingConfiguration.${field} must be a finite number: ${boundedValue(value)}`;
  }
  if (integer && !Number.isInteger(value)) {
    return `tailPacingConfiguration.${field} must be an integer: ${boundedValue(value)}`;
  }
  if (value < min || value > max) {
    return `tailPacingConfiguration.${field} must be in [${min}, ${max}]: ${boundedValue(value)}`;
  }
  return null;
}

function validateRetryPacing(value: unknown): string | null {
  if (!isRecord(value)) {
    return `tailPacingConfiguration.retryPacing must be the retry pacing {maxRetries, backoff, retryableFailureClasses}: ${boundedValue(value)}`;
  }
  const maxRetriesError = validateBoundedNumber(
    value.maxRetries,
    "retryPacing.maxRetries",
    0,
    MAX_PACING_RETRIES,
    true,
  );
  if (maxRetriesError !== null) {
    return maxRetriesError;
  }
  const backoff = value.backoff;
  if (!isRecord(backoff)) {
    return `tailPacingConfiguration.retryPacing.backoff must be the backoff shape {shape, baseMs, ceilingMs, jitterFraction}: ${boundedValue(backoff)}`;
  }
  if (
    typeof backoff.shape !== "string" ||
    !(RETRY_BACKOFF_SHAPES as readonly string[]).includes(backoff.shape)
  ) {
    return closedVocabularyReason("retryPacing.backoff.shape", RETRY_BACKOFF_SHAPES, backoff.shape);
  }
  const baseError = validateBoundedNumber(
    backoff.baseMs,
    "retryPacing.backoff.baseMs",
    1,
    MAX_BACKOFF_BASE_MS,
    true,
  );
  if (baseError !== null) {
    return baseError;
  }
  const ceilingError = validateBoundedNumber(
    backoff.ceilingMs,
    "retryPacing.backoff.ceilingMs",
    1,
    MAX_BACKOFF_CEILING_MS,
    true,
  );
  if (ceilingError !== null) {
    return ceilingError;
  }
  // Both bounds are validated numbers here (the PCL-01 validated-local
  // discipline — the comparison never sees an unknown).
  const ceilingMs = backoff.ceilingMs as number;
  const baseMs = backoff.baseMs as number;
  if (ceilingMs < baseMs) {
    return `tailPacingConfiguration.retryPacing.backoff.ceilingMs must not be below baseMs (the declared ceiling bounds the schedule from above): ceilingMs=${boundedValue(ceilingMs)}, baseMs=${boundedValue(baseMs)}`;
  }
  const jitterError = validateBoundedNumber(
    backoff.jitterFraction,
    "retryPacing.backoff.jitterFraction",
    0,
    MAX_JITTER_FRACTION,
    false,
  );
  if (jitterError !== null) {
    return jitterError;
  }
  if (!Array.isArray(value.retryableFailureClasses)) {
    return `tailPacingConfiguration.retryPacing.retryableFailureClasses must be an array of the PCL-001 failure taxonomy: ${boundedValue(value.retryableFailureClasses)}`;
  }
  const seen = new Set<string>();
  for (const entry of value.retryableFailureClasses) {
    if (
      typeof entry !== "string" ||
      !(OUTCOME_FAILURE_CLASSES as readonly string[]).includes(entry)
    ) {
      return closedVocabularyReason(
        "retryPacing.retryableFailureClasses entry",
        OUTCOME_FAILURE_CLASSES,
        entry,
      );
    }
    if (seen.has(entry)) {
      return `tailPacingConfiguration.retryPacing.retryableFailureClasses must not contain duplicates: ${boundedValue(entry)}`;
    }
    seen.add(entry);
    // THE TERMINAL-FAILURE PRESERVATION GATE (ACR-010 §3): a terminal
    // failure class declared retryable is the mask-a-terminal-failure-
    // as-success shape — rejected typed, never silently blessed.
    if ((TERMINAL_PACING_FAILURE_CLASSES as readonly string[]).includes(entry)) {
      return `tailPacingConfiguration.retryPacing.retryableFailureClasses cannot include the terminal failure class ${entry} (the timeout/terminal-failure preservation gate: a terminal failure is never tunable into a retry-until-success — masking a terminal failure as success is the automatic-void shape)`;
    }
  }
  return null;
}

function validateCooldownDiscipline(value: unknown): string | null {
  if (!isRecord(value)) {
    return `tailPacingConfiguration.cooldownDiscipline must be the cooldown discipline {rules}: ${boundedValue(value)}`;
  }
  if (!Array.isArray(value.rules)) {
    return `tailPacingConfiguration.cooldownDiscipline.rules must be an array of cooldown rules: ${boundedValue(value.rules)}`;
  }
  const seen = new Set<string>();
  for (const rule of value.rules) {
    if (!isRecord(rule)) {
      return `tailPacingConfiguration.cooldownDiscipline.rules entry must be a cooldown rule {failureClass, cooldownMs, reentry, probeAtFraction?}: ${boundedValue(rule)}`;
    }
    if (
      typeof rule.failureClass !== "string" ||
      !(OUTCOME_FAILURE_CLASSES as readonly string[]).includes(rule.failureClass)
    ) {
      return closedVocabularyReason(
        "cooldownDiscipline.rules entry.failureClass",
        OUTCOME_FAILURE_CLASSES,
        rule.failureClass,
      );
    }
    if (seen.has(rule.failureClass)) {
      return `tailPacingConfiguration.cooldownDiscipline.rules must not carry duplicate rules for ${rule.failureClass} (one rule per failure class — a throttle cools exactly as its one rule declares)`;
    }
    seen.add(rule.failureClass);
    const durationError = validateBoundedNumber(
      rule.cooldownMs,
      `cooldownDiscipline.rules[${rule.failureClass}].cooldownMs`,
      0,
      MAX_COOLDOWN_MS,
      true,
    );
    if (durationError !== null) {
      return durationError;
    }
    if (
      typeof rule.reentry !== "string" ||
      !(COOLDOWN_REENTRY_MODES as readonly string[]).includes(rule.reentry)
    ) {
      return closedVocabularyReason(
        `cooldownDiscipline.rules[${rule.failureClass}].reentry`,
        COOLDOWN_REENTRY_MODES,
        rule.reentry,
      );
    }
    if (rule.reentry === "expiry") {
      if (rule.probeAtFraction !== undefined) {
        return `tailPacingConfiguration.cooldownDiscipline.rules[${rule.failureClass}].probeAtFraction cannot ride reentry expiry (the incoherent shape is rejected — expiry probes nothing)`;
      }
    } else {
      const fractionError = validateBoundedNumber(
        rule.probeAtFraction,
        `cooldownDiscipline.rules[${rule.failureClass}].probeAtFraction`,
        MIN_PROBE_FRACTION,
        1,
        false,
      );
      if (fractionError !== null) {
        return fractionError;
      }
    }
  }
  return null;
}

function validateProgressDelivery(value: unknown): string | null {
  if (!isRecord(value)) {
    return `tailPacingConfiguration.progressDelivery must be the progress delivery {preference, pollingIntervalMs}: ${boundedValue(value)}`;
  }
  if (
    typeof value.preference !== "string" ||
    !(PROGRESS_PREFERENCES as readonly string[]).includes(value.preference)
  ) {
    return closedVocabularyReason(
      "progressDelivery.preference",
      PROGRESS_PREFERENCES,
      value.preference,
    );
  }
  return validateBoundedNumber(
    value.pollingIntervalMs,
    "progressDelivery.pollingIntervalMs",
    MIN_POLLING_INTERVAL_MS,
    MAX_POLLING_INTERVAL_MS,
    true,
  );
}

function validateTimeoutContract(value: unknown): string | null {
  if (!isRecord(value)) {
    return `tailPacingConfiguration.timeoutContract must be the timeout contract {attemptTimeoutMs, dispatchBudgetMs}: ${boundedValue(value)}`;
  }
  const attemptError = validateBoundedNumber(
    value.attemptTimeoutMs,
    "timeoutContract.attemptTimeoutMs",
    1,
    MAX_TIMEOUT_CONTRACT_MS,
    true,
  );
  if (attemptError !== null) {
    return attemptError;
  }
  const budgetError = validateBoundedNumber(
    value.dispatchBudgetMs,
    "timeoutContract.dispatchBudgetMs",
    1,
    MAX_TIMEOUT_CONTRACT_MS,
    true,
  );
  if (budgetError !== null) {
    return budgetError;
  }
  // Both quantities are validated numbers here (the validated-local
  // discipline).
  const attemptTimeoutMs = value.attemptTimeoutMs as number;
  const dispatchBudgetMs = value.dispatchBudgetMs as number;
  if (dispatchBudgetMs < attemptTimeoutMs) {
    return `tailPacingConfiguration.timeoutContract.dispatchBudgetMs must not be below attemptTimeoutMs (a budget smaller than one attempt is incoherent): dispatchBudgetMs=${boundedValue(dispatchBudgetMs)}, attemptTimeoutMs=${boundedValue(attemptTimeoutMs)}`;
  }
  return null;
}

/**
 * THE TIMEOUT/TERMINAL-FAILURE PRESERVATION GATE (ACR-010 §3 — the
 * cross-dimension checks, pure and deterministic): the declared pacing
 * may never EXTEND a declared timeout beyond its contract —
 *
 *  - G1 the retry schedule's worst case — every retry takes the full
 *    per-attempt timeout and sleeps the full ceiling — must fit the
 *    total logical-dispatch budget: (maxRetries + 1) * attemptTimeoutMs
 *    + maxRetries * ceilingMs <= dispatchBudgetMs;
 *  - G2 the declared polling interval must not exceed the per-attempt
 *    timeout (a poll scheduled beyond the attempt's own timeout
 *    extends the observation beyond its contract).
 *
 * The terminal-failure leg of the gate lives in the retryable-set
 * validation (TERMINAL_PACING_FAILURE_CLASSES — above). Every
 * rejection names the gate and both sides' numbers.
 */
function preservationGate(configuration: TailPacingConfiguration): string | null {
  const contract = configuration.timeoutContract;
  if (configuration.retryPacing !== undefined && configuration.retryPacing !== null) {
    const pacing = configuration.retryPacing;
    const worstCase =
      (pacing.maxRetries + 1) * contract.attemptTimeoutMs +
      pacing.maxRetries * pacing.backoff.ceilingMs;
    if (worstCase > contract.dispatchBudgetMs) {
      return `tailPacingConfiguration violates the timeout/terminal-failure preservation gate: the retry schedule's worst case (maxRetries + 1) * attemptTimeoutMs + maxRetries * ceilingMs = ${worstCase} exceeds the declared dispatchBudgetMs ${contract.dispatchBudgetMs} (a configuration that would extend a declared timeout beyond its contract is rejected typed at the configuration boundary — fail-closed)`;
    }
  }
  if (
    configuration.progressDelivery !== undefined &&
    configuration.progressDelivery !== null &&
    configuration.progressDelivery.pollingIntervalMs > contract.attemptTimeoutMs
  ) {
    return `tailPacingConfiguration violates the timeout/terminal-failure preservation gate: progressDelivery.pollingIntervalMs ${configuration.progressDelivery.pollingIntervalMs} exceeds the declared attemptTimeoutMs ${contract.attemptTimeoutMs} (a poll scheduled beyond the attempt's own timeout extends the observation beyond its contract — rejected typed at the configuration boundary)`;
  }
  return null;
}

/**
 * Total, deterministic, fail-closed validation of the declarative
 * pacing configuration (THE CONFIGURATION BOUNDARY): every vocabulary
 * is closed, every bound typed, every rejection's reason names the
 * field and the offending value, and the preservation gate runs over
 * the cross-dimension timeout contracts. The same input always yields
 * the byte-identical first rejection (the frozen check order:
 * version, timeoutContract presence, retryPacing, cooldownDiscipline,
 * progressDelivery, timeoutContract shape, preservation gate).
 * Absence is NOT handled here (the seam decides the absence spelling)
 * — this function validates a PRESENT configuration only.
 */
export function validateTailPacingConfiguration(value: unknown): PacingValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      reason: "tailPacingConfiguration must be an object (the closed configuration block)",
    };
  }
  if (value.version !== TAIL_PACING_CONFIGURATION_VERSION) {
    return {
      valid: false,
      reason: closedVocabularyReason(
        "version",
        [String(TAIL_PACING_CONFIGURATION_VERSION)],
        value.version,
      ),
    };
  }
  const hasRetry = value.retryPacing !== undefined && value.retryPacing !== null;
  const hasCooldown = value.cooldownDiscipline !== undefined && value.cooldownDiscipline !== null;
  const hasProgress = value.progressDelivery !== undefined && value.progressDelivery !== null;
  const hasContract = value.timeoutContract !== undefined && value.timeoutContract !== null;
  if ((hasRetry || hasCooldown || hasProgress) && !hasContract) {
    return {
      valid: false,
      reason:
        "tailPacingConfiguration.timeoutContract is required when any pacing dimension is authored (the timeout/terminal-failure preservation gate is never ambient, never defaulted)",
    };
  }
  if (hasRetry) {
    const error = validateRetryPacing(value.retryPacing);
    if (error !== null) {
      return { valid: false, reason: error };
    }
  }
  if (hasCooldown) {
    const error = validateCooldownDiscipline(value.cooldownDiscipline);
    if (error !== null) {
      return { valid: false, reason: error };
    }
  }
  if (hasProgress) {
    const error = validateProgressDelivery(value.progressDelivery);
    if (error !== null) {
      return { valid: false, reason: error };
    }
  }
  if (hasContract) {
    const error = validateTimeoutContract(value.timeoutContract);
    if (error !== null) {
      return { valid: false, reason: error };
    }
    // All present dimensions are validated here; the gate runs over
    // the validated whole (the PCL-01 validated-whole discipline).
    const gate = preservationGate(value as unknown as TailPacingConfiguration);
    if (gate !== null) {
      return { valid: false, reason: gate };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The absence seam (undefined AND null are both the absent spelling)
// ---------------------------------------------------------------------------

/**
 * Resolve the OPTIONAL configuration at the wired seam: absence
 * (undefined AND null — both the absent spelling) resolves UNARMED
 * (the byte-identical-today state; the seam stays inert); a present
 * configuration is validated fail-closed AT THE BOUNDARY and resolves
 * ARMED. Pure and total.
 */
export function resolveTailPacing(
  value: TailPacingConfiguration | null | undefined,
):
  | { readonly armed: false }
  | { readonly armed: true; readonly configuration: TailPacingConfiguration } {
  if (value === undefined || value === null) {
    return { armed: false };
  }
  const validation = validateTailPacingConfiguration(value);
  if (!validation.valid) {
    throw new TailPacingConfigurationError(validation.reason);
  }
  return { armed: true, configuration: value };
}

// ---------------------------------------------------------------------------
// The pure resolution functions (data → the mechanics the pipeline applies)
// ---------------------------------------------------------------------------

/**
 * The bounded, jittered backoff delay (ms) for the NEXT retry attempt
 * (ACR-010 §3). Pure and deterministic GIVEN THE INJECTED DRAW: the
 * deterministic schedule is `base * attempt` (linear) or
 * `base * 2^(attempt-1)` (exponential), clamped at the declared
 * ceiling; the declared jitter fraction then spreads the delay
 * symmetrically ±fraction around the schedule AND THE CEILING STILL
 * BINDS (a jittered delay never exceeds the declared ceiling — the
 * bound is hard, never soft). The draw ([0, 1]) is ALWAYS injected by
 * the caller's seam — this module never reads randomness (the
 * no-ambient law). A zero jitter fraction reproduces the deterministic
 * schedule exactly (the observable-and-replayable evidence
 * discipline).
 */
export function retryBackoffDelayMs(
  pacing: RetryPacingConfiguration,
  nextAttempt: number,
  jitterDraw: number,
): number {
  const attempt = Math.max(1, Math.floor(nextAttempt));
  const raw =
    pacing.backoff.shape === "linear"
      ? pacing.backoff.baseMs * attempt
      : pacing.backoff.baseMs * 2 ** (attempt - 1);
  const scheduled = Math.min(raw, pacing.backoff.ceilingMs);
  if (pacing.backoff.jitterFraction === 0) {
    return scheduled;
  }
  const draw = Math.min(1, Math.max(0, jitterDraw));
  const jittered = scheduled * (1 + pacing.backoff.jitterFraction * (2 * draw - 1));
  return Math.min(Math.max(0, Math.round(jittered)), pacing.backoff.ceilingMs);
}

/**
 * The cooldown rule keyed to a failure class, or null when the
 * discipline carries no rule for the class (absence by omission — the
 * class cools nothing). Pure.
 */
export function cooldownRuleFor(
  discipline: CooldownDisciplineConfiguration | undefined,
  failureClass: OutcomeFailureClass,
): CooldownRule | null {
  if (discipline === undefined || discipline === null) {
    return null;
  }
  for (const rule of discipline.rules) {
    if (rule.failureClass === failureClass) {
      return rule;
    }
  }
  return null;
}

/**
 * The cooldown state at dispatch (the PCL-01 vocabulary, consumed
 * read-only): no rule (or an expired cooldown) is the `none` state; an
 * active cooldown names its failure class and the bounded milliseconds
 * remaining at dispatch. Pure and total.
 */
export function cooldownStateAtDispatch(
  discipline: CooldownDisciplineConfiguration | undefined,
  failureClass: OutcomeFailureClass,
  elapsedMs: number,
): DispatchCooldownState {
  const rule = cooldownRuleFor(discipline, failureClass);
  if (rule === null || rule.cooldownMs === 0) {
    return { kind: "none" };
  }
  const remaining = rule.cooldownMs - Math.max(0, elapsedMs);
  if (remaining <= 0) {
    return { kind: "none" };
  }
  return { kind: "active", failureClass, remainingMs: remaining };
}

/**
 * The EXPLICIT re-entry admission (ACR-010 §3): whether a dispatch may
 * re-enter the provider NOW, under the class's declared rule —
 *
 *  - no rule → admissible (basis `no-rule`: the class cools nothing);
 *  - `expiry` → admissible only after the full declared duration
 *    (basis `expired`), held otherwise;
 *  - `early-probe` → ONE probe admissible from the declared fraction
 *    onward (basis `probe`); before the probe point the cooldown holds
 *    (basis `cooldown-active`, naming the class and the bounded
 *    remaining milliseconds — the PCL-01 vocabulary).
 *
 * A probe is admission for ONE dispatch, never an unbounded probe
 * stream (the caller's seam records the probe it consumed; a failed
 * probe re-arms the remainder). Pure and total.
 */
export function cooldownReentryAdmission(
  discipline: CooldownDisciplineConfiguration | undefined,
  failureClass: OutcomeFailureClass,
  elapsedMs: number,
): CooldownReentryAdmission {
  const rule = cooldownRuleFor(discipline, failureClass);
  if (rule === null) {
    return { admissible: true, basis: "no-rule" };
  }
  const elapsed = Math.max(0, elapsedMs);
  if (rule.cooldownMs === 0) {
    return { admissible: true, basis: "expired" };
  }
  if (rule.reentry === "expiry") {
    if (elapsed >= rule.cooldownMs) {
      return { admissible: true, basis: "expired" };
    }
    return {
      admissible: false,
      basis: "cooldown-active",
      failureClass,
      remainingMs: rule.cooldownMs - elapsed,
    };
  }
  const probeAtMs = rule.cooldownMs * (rule.probeAtFraction ?? 1);
  if (elapsed >= probeAtMs) {
    return { admissible: true, basis: "probe" };
  }
  return {
    admissible: false,
    basis: "cooldown-active",
    failureClass,
    remainingMs: Math.ceil(probeAtMs - elapsed),
  };
}

/**
 * The transport's typed progress capabilities (the ACR-009 pattern:
 * the CALLER supplies the transport's OWN typed capability truth —
 * this module never imports a transport, never guesses support). A
 * transport declaring `eventStream: true` supports event/stream-driven
 * progress; `false` is the honest unsupported declaration (polled is
 * the fallback everywhere else too).
 */
export interface TransportProgressCapabilities {
  readonly eventStream: boolean;
}

/** The resolved progress delivery (the PCL-01 mode + the applied interval). */
export interface ResolvedProgressDelivery {
  readonly mode: ProgressDeliveryMode;
  /**
   * The applied polling interval — present exactly when the mode is
   * `polled` (the PCL-01 incoherent-shape law: a polling interval
   * riding an event stream is unrepresentable at the facts boundary).
   */
  readonly pollingIntervalMs?: number;
}

/**
 * Resolve the progress-delivery mode from the DECLARED configuration
 * and the transport's OWN typed capability facts (ACR-010 §3, the
 * ACR-009 selection pattern): event-stream exactly when the preference
 * admits it AND the transport's facts declare support; polled as the
 * honest fallback (unsupported transports, or the conservative
 * `polled-only` preference). The interval applies exactly when the
 * mode is polled. Pure and total.
 */
export function resolveProgressDelivery(
  progress: ProgressDeliveryConfiguration,
  capabilities: TransportProgressCapabilities,
): ResolvedProgressDelivery {
  if (progress.preference === "event-stream-else-polled" && capabilities.eventStream) {
    return { mode: "event-stream" };
  }
  return { mode: "polled", pollingIntervalMs: progress.pollingIntervalMs };
}

/**
 * THE MECHANICS RECORD (PCL-002 deliverable: the outcome record carries
 * the mechanics actually applied — progress mode, polling interval,
 * cooldown state at dispatch — through the PCL-001 facts, READ-ONLY
 * consumption): project the APPLIED mechanics into the PCL-01
 * `ProgressDeliveryFacts` block the outcome record rides. The polling
 * interval renders as a MEASURED latency fact exactly when the applied
 * mode is `polled` and is explicitly absent for `event-stream` (the
 * PCL-01 incoherent-shape law — an interval riding an event stream is
 * rejected at the facts boundary, so it is never produced here). The
 * cooldown state passes through in the PCL-01 vocabulary untouched.
 * Pure and total; the block is validated by the PCL-01 optional seam
 * at the riding point.
 */
export function progressDeliveryFactsOf(
  applied: ResolvedProgressDelivery,
  cooldownAtDispatch: DispatchCooldownState,
): ProgressDeliveryFacts {
  if (applied.mode === "polled") {
    const interval: LatencyMeasurement = {
      kind: "measured",
      milliseconds: applied.pollingIntervalMs ?? 0,
    };
    return { mode: "polled", pollingInterval: interval, cooldownAtDispatch };
  }
  return { mode: "event-stream", cooldownAtDispatch };
}
