/**
 * The tail-pacing configuration plane — the evaluation's app-local
 * mirror of the PCL-002 plane (ACR-010 §3–§4; work order PCL-003).
 *
 * THE BOUNDARY DISCIPLINE (VAL-002 AC7 — never `src/**` from the
 * application tree): the PCL-002 declarative pacing plane lives at
 * `src/modules/executions/domain/tail-pacing-configuration.ts` (a
 * domain file with NO public-barrel re-export) with its wired seam at
 * `src/modules/executions/adapters/tail-pacing.ts`, so neither is
 * importable from the application tree. This module mirrors the plane
 * the established way (the PCS-004 precedent): closed vocabularies and
 * bounds mirrored BY VALUE, the validation + resolution functions
 * projected locally, and EVERY projection pinned in-suite
 * (`tests/unit/validation/pcl-003-mirror-pins.test.ts`) against the
 * REAL `validateTailPacingConfiguration` / `resolveTailPacing` /
 * `retryBackoffDelayMs` / `cooldownStateAtDispatch` /
 * `cooldownReentryAdmission` / `resolveProgressDelivery` /
 * `progressDeliveryFactsOf` — verdict-for-verdict over a fixed query
 * corpus AND over the FULL evaluation (the suite re-runs the complete
 * evaluation with the REAL port injected and requires the evaluation
 * digest to be byte-identical — the PCR-003 plan-artifact injection
 * precedent). Drift is a typed failure, never silent. The real plane is
 * consumed READ-ONLY; a defect is REPORTED to the Lead with an owner,
 * never patched here.
 *
 * THE PORT DISCIPLINE: the evaluation consumes the pacing plane through
 * `PacingPort` — one narrow interface over the plane's own public
 * functions. The standalone run uses `LOCAL_PACING_PORT` (this
 * module's mirrors); the test suites inject the REAL functions and
 * prove byte-identical evaluation digests. The port is the ONLY pacing
 * authority the evaluation consults (no ambient configuration, no
 * second engine — the ACR-010 §6 laws bind the evaluation too).
 *
 * THE MECHANICS THIS MODULE TYPES (ACR-010 §3): bounded, jittered retry
 * backoff with a declared ceiling; failure-class-aware provider
 * cooldowns with explicit re-entry; event-stream-else-polled progress
 * delivery (the transport's own typed capability facts decide); and
 * THE TIMEOUT/TERMINAL-FAILURE PRESERVATION GATE — a configuration
 * that would mask a terminal failure as success (a terminal class
 * declared retryable) or extend a declared timeout beyond its contract
 * (the schedule's worst case exceeding the dispatch budget; a poll
 * beyond the attempt timeout) is REJECTED typed at the configuration
 * boundary, fail-closed.
 *
 * Pure and total: no environment reads, no clock, no randomness (the
 * jitter draw is ALWAYS injected by the caller), no I/O.
 */

import type {
  DispatchCooldownState,
  LatencyMeasurement,
  OutcomeFailureClass,
  ProgressDeliveryFacts,
  ProgressDeliveryMode,
} from "./facts";

// ---------------------------------------------------------------------------
// The frozen vocabularies (the mirror of the PCL-002 authority — pinned
// by test; widening is a reviewed change the pin catches)
// ---------------------------------------------------------------------------

/** The closed configuration-surface version (exactly 1). */
export const TAIL_PACING_CONFIGURATION_VERSION = 1;
export type TailPacingConfigurationVersion = 1;

/** The closed backoff-shape vocabulary. */
export const RETRY_BACKOFF_SHAPES = ["linear", "exponential"] as const;
export type RetryBackoffShape = (typeof RETRY_BACKOFF_SHAPES)[number];

/** The closed cooldown re-entry vocabulary. */
export const COOLDOWN_REENTRY_MODES = ["expiry", "early-probe"] as const;
export type CooldownReentryMode = (typeof COOLDOWN_REENTRY_MODES)[number];

/** The closed progress-preference vocabulary. */
export const PROGRESS_PREFERENCES = ["event-stream-else-polled", "polled-only"] as const;
export type ProgressPreference = (typeof PROGRESS_PREFERENCES)[number];

/**
 * THE FROZEN TERMINAL FAILURE CLASSES (the preservation gate's own set):
 * budget-exhausted and policy-denied are TERMINAL BY CONTRACT — an
 * authority's denial is never tunable into a retry-until-success.
 */
export const TERMINAL_PACING_FAILURE_CLASSES: readonly OutcomeFailureClass[] = [
  "budget-exhausted",
  "policy-denied",
];

// ---------------------------------------------------------------------------
// The mirrored platform bounds (the authority's own numbers — pinned by test)
// ---------------------------------------------------------------------------

/** The retry-count bound. */
export const MAX_PACING_RETRIES = 10;
/** The backoff base bound (ms). */
export const MAX_BACKOFF_BASE_MS = 60_000;
/** The backoff ceiling bound (ms). */
export const MAX_BACKOFF_CEILING_MS = 600_000;
/** The jitter fraction bound — symmetric ±fraction around the schedule. */
export const MAX_JITTER_FRACTION = 0.5;
/** The cooldown duration bound (ms). */
export const MAX_COOLDOWN_MS = 3_600_000;
/** The poll-interval bounds (ms). */
export const MIN_POLLING_INTERVAL_MS = 50;
export const MAX_POLLING_INTERVAL_MS = 5_000;
/** The timeout-contract bound (ms). */
export const MAX_TIMEOUT_CONTRACT_MS = 3_600_000;
/** The early-probe fraction bounds: a probe may re-enter at (0, 1] of the duration. */
export const MIN_PROBE_FRACTION = 0.05;

// ---------------------------------------------------------------------------
// The typed configuration block (data, never an engine — structurally the
// authority's shapes)
// ---------------------------------------------------------------------------

/** Retry pacing: the bounded, jittered backoff with a declared ceiling. */
export interface RetryPacingConfiguration {
  readonly maxRetries: number;
  readonly backoff: {
    readonly shape: RetryBackoffShape;
    readonly baseMs: number;
    readonly ceilingMs: number;
    readonly jitterFraction: number;
  };
  readonly retryableFailureClasses: readonly OutcomeFailureClass[];
}

/** One failure-class-aware cooldown rule with explicit re-entry. */
export interface CooldownRule {
  readonly failureClass: OutcomeFailureClass;
  readonly cooldownMs: number;
  readonly reentry: CooldownReentryMode;
  readonly probeAtFraction?: number;
}

/** The cooldown discipline: per-failure-class rules, duplicate-free, possibly partial. */
export interface CooldownDisciplineConfiguration {
  readonly rules: readonly CooldownRule[];
}

/** Progress delivery: the declared preference and polling interval. */
export interface ProgressDeliveryConfiguration {
  readonly preference: ProgressPreference;
  readonly pollingIntervalMs: number;
}

/** THE TIMEOUT CONTRACT (the preservation gate's reference — required). */
export interface TimeoutContract {
  readonly attemptTimeoutMs: number;
  readonly dispatchBudgetMs: number;
}

/** The declarative tail-pacing configuration (typed, closed, versioned). */
export interface TailPacingConfiguration {
  readonly version: TailPacingConfigurationVersion;
  readonly retryPacing?: RetryPacingConfiguration;
  readonly cooldownDiscipline?: CooldownDisciplineConfiguration;
  readonly progressDelivery?: ProgressDeliveryConfiguration;
  readonly timeoutContract: TimeoutContract;
}

/** Pure validation verdict (the authority's spelling). */
export type PacingValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** The closed two-verdict cooldown re-entry admission vocabulary. */
export type CooldownReentryAdmission =
  | { readonly admissible: true; readonly basis: "no-rule" | "expired" | "probe" }
  | {
      readonly admissible: false;
      readonly basis: "cooldown-active";
      readonly failureClass: OutcomeFailureClass;
      readonly remainingMs: number;
    };

/** The transport's typed progress capabilities (the caller supplies the transport's OWN facts). */
export interface TransportProgressCapabilities {
  readonly eventStream: boolean;
}

/** The resolved progress delivery (the mode + the applied interval). */
export interface ResolvedProgressDelivery {
  readonly mode: ProgressDeliveryMode;
  readonly pollingIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// The validation mirror (fail-closed at the configuration boundary — the
// same frozen check order and the same reasons as the authority's
// validator; pinned verdict-for-verdict in-suite)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedVocabularyReason(
  field: string,
  vocabulary: readonly string[],
  value: unknown,
): string {
  return `tailPacingConfiguration.${field} must be one of ${vocabulary.join("|")}: ${String(value)}`;
}

function validateBoundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  integer: boolean,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `tailPacingConfiguration.${field} must be a finite number: ${String(value)}`;
  }
  if (integer && !Number.isInteger(value)) {
    return `tailPacingConfiguration.${field} must be an integer: ${String(value)}`;
  }
  if (value < min || value > max) {
    return `tailPacingConfiguration.${field} must be in [${min}, ${max}]: ${String(value)}`;
  }
  return null;
}

function validateRetryPacing(value: unknown): string | null {
  if (!isRecord(value)) {
    return `tailPacingConfiguration.retryPacing must be the retry pacing {maxRetries, backoff, retryableFailureClasses}`;
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
    return "tailPacingConfiguration.retryPacing.backoff must be the backoff shape {shape, baseMs, ceilingMs, jitterFraction}";
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
  const ceilingMs = backoff.ceilingMs as number;
  const baseMs = backoff.baseMs as number;
  if (ceilingMs < baseMs) {
    return `tailPacingConfiguration.retryPacing.backoff.ceilingMs must not be below baseMs (the declared ceiling bounds the schedule from above): ceilingMs=${ceilingMs}, baseMs=${baseMs}`;
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
    return "tailPacingConfiguration.retryPacing.retryableFailureClasses must be an array of the failure taxonomy";
  }
  const seen = new Set<string>();
  for (const entry of value.retryableFailureClasses) {
    if (typeof entry !== "string") {
      return closedVocabularyReason(
        "retryPacing.retryableFailureClasses entry",
        [
          "provider-5xx",
          "provider-timeout",
          "provider-throttle",
          "connection-error",
          "verification-retry",
          "budget-exhausted",
          "policy-denied",
        ],
        entry,
      );
    }
    if (seen.has(entry)) {
      return `tailPacingConfiguration.retryPacing.retryableFailureClasses must not contain duplicates: ${entry}`;
    }
    seen.add(entry);
    // THE TERMINAL-FAILURE PRESERVATION GATE: a terminal failure class
    // declared retryable is the mask-a-terminal-failure-as-success shape.
    if ((TERMINAL_PACING_FAILURE_CLASSES as readonly string[]).includes(entry)) {
      return `tailPacingConfiguration.retryPacing.retryableFailureClasses cannot include the terminal failure class ${entry} (the timeout/terminal-failure preservation gate: a terminal failure is never tunable into a retry-until-success — masking a terminal failure as success is the automatic-void shape)`;
    }
  }
  return null;
}

function validateCooldownDiscipline(value: unknown): string | null {
  if (!isRecord(value)) {
    return "tailPacingConfiguration.cooldownDiscipline must be the cooldown discipline {rules}";
  }
  if (!Array.isArray(value.rules)) {
    return "tailPacingConfiguration.cooldownDiscipline.rules must be an array of cooldown rules";
  }
  const seen = new Set<string>();
  for (const rule of value.rules) {
    if (!isRecord(rule)) {
      return "tailPacingConfiguration.cooldownDiscipline.rules entry must be a cooldown rule {failureClass, cooldownMs, reentry, probeAtFraction?}";
    }
    if (typeof rule.failureClass !== "string") {
      return closedVocabularyReason(
        "cooldownDiscipline.rules entry.failureClass",
        [
          "provider-5xx",
          "provider-timeout",
          "provider-throttle",
          "connection-error",
          "verification-retry",
          "budget-exhausted",
          "policy-denied",
        ],
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
    return "tailPacingConfiguration.progressDelivery must be the progress delivery {preference, pollingIntervalMs}";
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
    return "tailPacingConfiguration.timeoutContract must be the timeout contract {attemptTimeoutMs, dispatchBudgetMs}";
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
  const attemptTimeoutMs = value.attemptTimeoutMs as number;
  const dispatchBudgetMs = value.dispatchBudgetMs as number;
  if (dispatchBudgetMs < attemptTimeoutMs) {
    return `tailPacingConfiguration.timeoutContract.dispatchBudgetMs must not be below attemptTimeoutMs (a budget smaller than one attempt is incoherent): dispatchBudgetMs=${dispatchBudgetMs}, attemptTimeoutMs=${attemptTimeoutMs}`;
  }
  return null;
}

/**
 * THE TIMEOUT/TERMINAL-FAILURE PRESERVATION GATE (the cross-dimension
 * checks): G1 — the retry schedule's worst case ((maxRetries + 1) *
 * attemptTimeoutMs + maxRetries * ceilingMs) must fit the dispatch
 * budget; G2 — the polling interval must not exceed the per-attempt
 * timeout.
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
 * pacing configuration (THE CONFIGURATION BOUNDARY) — the authority's
 * own frozen check order (version, contract presence, retryPacing,
 * cooldownDiscipline, progressDelivery, timeoutContract shape,
 * preservation gate). Pinned verdict-for-verdict in-suite.
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
    const gate = preservationGate(value as unknown as TailPacingConfiguration);
    if (gate !== null) {
      return { valid: false, reason: gate };
    }
  }
  return { valid: true };
}

/**
 * Resolve the OPTIONAL configuration at the seam: absence (undefined
 * AND null — both the absent spelling) resolves UNARMED; a present
 * configuration is validated fail-closed AT THE BOUNDARY and resolves
 * ARMED (a malformed configuration throws the typed error).
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
    throw new Error(validation.reason);
  }
  return { armed: true, configuration: value };
}

// ---------------------------------------------------------------------------
// The pure resolution functions (the local projections — each pinned
// verdict-for-verdict in-suite against the authority's own functions)
// ---------------------------------------------------------------------------

/**
 * The bounded, jittered backoff delay (ms) for the NEXT retry attempt:
 * the deterministic schedule is base * attempt (linear) or
 * base * 2^(attempt-1) (exponential), clamped at the ceiling; the
 * declared jitter fraction spreads the delay symmetrically ±fraction
 * around the schedule AND THE CEILING STILL BINDS. The draw ([0, 1]) is
 * ALWAYS injected — this module never reads randomness.
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

/** The cooldown rule keyed to a failure class, or null when unkeyed. */
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

/** The cooldown state at dispatch (the facts vocabulary, read-only). */
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
 * The EXPLICIT re-entry admission: no rule → admissible (no-rule);
 * expiry → admissible only after the full duration; early-probe → ONE
 * probe admissible from the declared fraction onward, held otherwise
 * (naming the class and the bounded remaining milliseconds).
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
 * Resolve the progress-delivery mode from the DECLARED configuration
 * and the transport's OWN typed capability facts: event-stream exactly
 * when the preference admits it AND the transport's facts declare
 * support; polled as the honest fallback.
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
 * THE MECHANICS RECORD: project the APPLIED mechanics into the facts
 * block's progress-delivery record. The polling interval renders as a
 * MEASURED latency fact exactly when the applied mode is `polled` and
 * is explicitly absent for `event-stream`.
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

// ---------------------------------------------------------------------------
// THE PACING RESOLVER PORT (the evaluation's single pacing authority —
// the local mirror by default; the REAL PCL-002 seam factory injectable
// in-suite)
// ---------------------------------------------------------------------------

/**
 * The pacing-reading seam the evaluation consults — the mirror of the
 * PCL-002 wired resolver surface (the adapter's own interface shape):
 * every read is a PURE resolution over the declared configuration;
 * absent verdicts are the byte-identical-today spellings. The
 * standalone run uses the local mirror factory; the suites inject the
 * REAL `createTailPacingResolver` (signature-compatible — the factory
 * shape is the real seam's own) and require the evaluation digest to be
 * byte-identical.
 */
export interface PacingResolver {
  /**
   * The bounded, jittered retry delay (ms) for the next retry attempt —
   * `undefined` when no retry pacing is authored. The jitter draw is
   * the caller's own (composition-injected — deterministic here).
   */
  retryDelayFor(nextAttempt: number): number | undefined;
  /** Whether the retry pacing admits a retry for the failure class. */
  retryAdmits(failureClass: OutcomeFailureClass): boolean;
  /**
   * The cooldown state at dispatch (the facts vocabulary) — the `none`
   * state when no cooldown discipline is authored or the class carries
   * no rule.
   */
  cooldownAtDispatch(failureClass: OutcomeFailureClass, elapsedMs: number): DispatchCooldownState;
  /** The explicit re-entry admission for a dispatch. */
  admitCooldownReentry(
    failureClass: OutcomeFailureClass,
    elapsedMs: number,
  ): CooldownReentryAdmission;
  /**
   * The resolved progress delivery (mode + applied interval) — `null`
   * when no progress configuration is authored.
   */
  resolveProgress(capabilities: TransportProgressCapabilities): ResolvedProgressDelivery | null;
  /**
   * THE MECHANICS RECORD: the progress-delivery facts block the outcome
   * record carries — `null` when no progress configuration is authored.
   */
  progressFacts(
    capabilities: TransportProgressCapabilities,
    cooldownAtDispatch: DispatchCooldownState,
  ): ProgressDeliveryFacts | null;
  /** The armed configuration (evaluation evidence), or null when absent. */
  readonly configuration: TailPacingConfiguration | null;
}

/** The resolver factory (the real seam's own composition shape). */
export type PacingResolverFactory = (deps: {
  readonly configuration?: TailPacingConfiguration | null;
  readonly jitterDraw?: () => number;
}) => PacingResolver;

/**
 * The app-local mirror factory (pinned verdict-for-verdict in-suite
 * against the REAL `createTailPacingResolver`, and over the FULL
 * evaluation by digest identity). Fail-closed at the configuration
 * boundary: a malformed configuration throws the typed error; an armed
 * retry pacing requires the injected jitter draw (never ambient).
 */
export const LOCAL_PACING_RESOLVER_FACTORY: PacingResolverFactory = (deps) => {
  const resolved = resolveTailPacing(deps.configuration);
  const armed = resolved.armed ? resolved.configuration : null;
  if (armed !== null && armed.retryPacing !== undefined && deps.jitterDraw === undefined) {
    throw new Error(
      "the tail-pacing resolver requires an injected jitterDraw when retry pacing is authored (the entropy source is the composition's own — never ambient, never module-owned)",
    );
  }
  const retryPacing: RetryPacingConfiguration | undefined =
    armed?.retryPacing !== undefined && armed.retryPacing !== null ? armed.retryPacing : undefined;
  const cooldownDiscipline: CooldownDisciplineConfiguration | undefined =
    armed?.cooldownDiscipline !== undefined && armed.cooldownDiscipline !== null
      ? armed.cooldownDiscipline
      : undefined;
  const progressDelivery: ProgressDeliveryConfiguration | undefined =
    armed?.progressDelivery !== undefined && armed.progressDelivery !== null
      ? armed.progressDelivery
      : undefined;
  return {
    configuration: armed,
    retryDelayFor(nextAttempt: number): number | undefined {
      if (retryPacing === undefined) {
        return undefined;
      }
      return retryBackoffDelayMs(retryPacing, nextAttempt, deps.jitterDraw?.() ?? 0.5);
    },
    retryAdmits(failureClass: OutcomeFailureClass): boolean {
      if (retryPacing === undefined) {
        return false;
      }
      return retryPacing.retryableFailureClasses.includes(failureClass);
    },
    cooldownAtDispatch(
      failureClass: OutcomeFailureClass,
      elapsedMs: number,
    ): DispatchCooldownState {
      return cooldownStateAtDispatch(cooldownDiscipline, failureClass, elapsedMs);
    },
    admitCooldownReentry(
      failureClass: OutcomeFailureClass,
      elapsedMs: number,
    ): CooldownReentryAdmission {
      return cooldownReentryAdmission(cooldownDiscipline, failureClass, elapsedMs);
    },
    resolveProgress(capabilities: TransportProgressCapabilities): ResolvedProgressDelivery | null {
      if (progressDelivery === undefined) {
        return null;
      }
      return resolveProgressDelivery(progressDelivery, capabilities);
    },
    progressFacts(
      capabilities: TransportProgressCapabilities,
      cooldownAtDispatch: DispatchCooldownState,
    ): ProgressDeliveryFacts | null {
      const resolvedProgress =
        progressDelivery === undefined
          ? null
          : resolveProgressDelivery(progressDelivery, capabilities);
      if (resolvedProgress === null) {
        return null;
      }
      return progressDeliveryFactsOf(resolvedProgress, cooldownAtDispatch);
    },
  };
};
