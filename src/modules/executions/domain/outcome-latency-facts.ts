/**
 * Outcome-latency typed facts (executions module domain, ACR-010 §2;
 * work order PCL-001 — the per-failure-class evidence plane).
 *
 * THE MEASURED GAP THIS MODULE TYPES (ACR-010 §1): the execution/evidence
 * model reports aggregate model latency; it carries no typed distinction
 * between "a tail outcome was produced by a provider-5xx leg, a
 * verification retry and a fallback" and "the same wall-clock came from a
 * clean first attempt" — the per-failure-class, per-route latency and
 * cost semantics were prose, never machine-checkable. `OutcomeLatencyFacts`
 * is that typed distinction: a closed, OPTIONAL fact block describing the
 * outcome-latency and cost truth of ONE execution at a recorded revision
 * (DATA, never an engine — the continuation-package discipline), validated
 * fail-closed at the boundary and checked mechanically against the outcome
 * record's identity by pure function. It is the measurement truth the
 * PCL-002 tail mechanics and the PCL-003 evaluation consume READ-ONLY;
 * this module wires itself into NOTHING (the riding/wiring is PCL-002's
 * behind the existing execution/verification seams, default-off).
 *
 * PLACEMENT (the PCS-002 location study applied to this plane): the facts
 * type the EXECUTION outcome record, so the pure plane lives in the
 * executions module's domain layer, next to `execution.ts`,
 * `state-machine.ts` and `verification.ts` — exactly as PCS-002 placed
 * its typed-facts plane next to the capability record it types. Domain
 * layering (AGENTS.md + the enforced dependency rules): a domain file
 * imports at most same-module domain files and `src/shared/**`, never
 * platform planes — the `CostClaim` explicit-basis discipline and the
 * platform failure-signal vocabularies are therefore MIRRORED here
 * (alignment by value, never by import; studied read-only — a defect
 * there is reported, never patched).
 *
 * THE CLOSED FACT BLOCK (every field closed and typed; unknown values
 * fail closed with a reason naming the field and the offending value —
 * never a default, never a widening):
 *
 *   outcome class       → `succeeded-first-attempt` |
 *                         `succeeded-after-retry` |
 *                         `succeeded-on-fallback` |
 *                         `failed-terminal` — the closed outcome
 *                         classification ACR-010 measures tails over;
 *   failure classes     → the closed per-leg failure taxonomy
 *                         (provider-5xx, provider-timeout,
 *                         provider-throttle, connection-error,
 *                         verification-retry, budget-exhausted,
 *                         policy-denied) — each leg names its class when
 *                         it encountered a failure; a leg that met no
 *                         failure carries the ABSENT spelling (undefined
 *                         and null are BOTH the absent spelling — never a
 *                         widened "none" member); unknown classes fail
 *                         closed, never default;
 *   progress delivery   → the mode actually used (`event-stream` |
 *                         `polled`), the polling interval actually
 *                         applied (REQUIRED exactly when the mode is
 *                         `polled`; a polling interval riding an
 *                         event-stream is the incoherent shape, rejected
 *                         typed), and the cooldown state at dispatch
 *                         (none, or active naming its failure class and
 *                         bounded remaining milliseconds);
 *   per-leg latency     → the measured wall-clock of each route leg
 *                         (first byte, completion) — milliseconds,
 *                         non-negative, bounded; a point that cannot be
 *                         measured renders as the honest NOT RUN with an
 *                         owner, never a placeholder;
 *   attempt census      → the count of attempts by class (original,
 *                         retry, fallback, verification) plus the total —
 *                         the duplicate-attempt truth; the census
 *                         reconciles EXACTLY (attempts = original +
 *                         retry + fallback + verification — no failure
 *                         hiding) and agrees with the outcome class;
 *   cost                → the total cost INCLUDING duplicate attempts,
 *                         with verification cost carried as its own line
 *                         — each line either measured (integer micro-USD
 *                         in [0, 10^18), the CostClaim money bound, with
 *                         a bounded explicit attribution source — the
 *                         explicit-basis CostClaim discipline applied to
 *                         latency/cost facts) or the honest NOT RUN with
 *                         an owner, never a projection, never a
 *                         placeholder;
 *   resolution          → whether the outcome resolved (a succeeded
 *                         outcome records it true; a terminal failure
 *                         never records it — reclassifying failure is
 *                         the automatic-void shape, rejected typed);
 *   verification        → what verification proved — the existing
 *                         verification record REFERENCED by id, never
 *                         duplicated (proved: pass | fail |
 *                         inconclusive, with >= 1 bounded result-id
 *                         reference), or its honest not-run with an
 *                         owner;
 *   basis               → the EXPLICIT provenance on every fact: which
 *                         execution, which route, which revision, which
 *                         clock discipline (wall-clock | monotonic — the
 *                         label of the clock that produced the
 *                         measurements, recorded, never ambient). An
 *                         unattributed outcome-latency fact is
 *                         unrepresentable.
 *
 * ABSENCE EQUIVALENCE (ACR-010 §2/§4; the PCR-002/ACR-009 discipline):
 * the block is OPTIONAL — `undefined` and `null` are BOTH the absent
 * spelling everywhere an absence exists (the block itself, a leg's
 * failure class, the polling interval when the mode is event-stream),
 * and the canonical form renders every absence as key-omission, so all
 * absence spellings produce the byte-identical content address. Absence
 * of the block selects and records byte-identically to today's behavior
 * at every existing call site (this module adds no call sites — the
 * wiring is PCL-002's, default-off; the confinement is pinned by the
 * architecture test).
 *
 * NO DURABLE SURFACE, NO ENGINE (ACR-010 §6): this module declares no
 * store, no SQL, no state machine, no route decision, no retry, no
 * cooldown, no polling — it types facts about executions that already
 * happen. The frozen vocabularies here never widen the platform failure
 * taxonomies (alignment by value, never by import); the vocabulary
 * census is pinned by the architecture test (widening is a reviewed
 * change, never silent).
 *
 * Pure and total: no environment reads, no clock, no randomness, no
 * I/O — same facts always produce the byte-identical validation
 * verdict, canonical form and content address (invariant 5). The
 * module is fully self-contained: zero imports.
 */

// ---------------------------------------------------------------------------
// The frozen vocabularies (closed — widening is a reviewed change)
// ---------------------------------------------------------------------------

/**
 * The closed outcome classification ACR-010 §2 measures tails over: a
 * clean first attempt, a retry that recovered, a fallback that recovered,
 * or a terminal failure. Never interchangeable, never defaulted — the
 * class agrees with the attempt census or the fact is rejected typed.
 */
export const OUTCOME_CLASSES = [
  "succeeded-first-attempt",
  "succeeded-after-retry",
  "succeeded-on-fallback",
  "failed-terminal",
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * The closed per-leg failure taxonomy (ACR-010 §2's own closed list —
 * NOT the platform failure-signal vocabulary; alignment by value, never
 * by import). A leg names its class exactly when it encountered a
 * failure; a leg that met no failure carries the absent spelling
 * (undefined | null) — the taxonomy is never widened with a "none"
 * member. Unknown values fail closed at the boundary, never default.
 */
export const OUTCOME_FAILURE_CLASSES = [
  "provider-5xx",
  "provider-timeout",
  "provider-throttle",
  "connection-error",
  "verification-retry",
  "budget-exhausted",
  "policy-denied",
] as const;
export type OutcomeFailureClass = (typeof OUTCOME_FAILURE_CLASSES)[number];

/**
 * The progress-delivery mode actually used (ACR-010 §2): subscription
 * against the transport's own event stream, or the honest polled
 * fallback. The polling interval is required exactly when the mode is
 * `polled` and explicitly absent for `event-stream` (a polling interval
 * riding an event stream is the incoherent shape, rejected typed).
 */
export const PROGRESS_DELIVERY_MODES = ["event-stream", "polled"] as const;
export type ProgressDeliveryMode = (typeof PROGRESS_DELIVERY_MODES)[number];

/**
 * The clock discipline that produced the measurements, recorded as an
 * explicit fact — never ambient (domain code never reads the system
 * clock; the label says which clock the adapter used). Latencies are
 * wall-clock durations per ACR-010 §2; the discipline names the clock
 * that measured them.
 */
export const CLOCK_DISCIPLINES = ["wall-clock", "monotonic"] as const;
export type ClockDiscipline = (typeof CLOCK_DISCIPLINES)[number];

/**
 * The closed two-kind measurement vocabulary: every measured quantity
 * (a latency point, a cost line) is either a real measurement or the
 * honest NOT RUN with an owner. A value that cannot be measured never
 * renders as a placeholder, a zero or a projection (ACR-010 §2
 * measurement truth).
 */
export const MEASUREMENT_KINDS = ["measured", "not-run"] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

/**
 * The closed verification-proof vocabulary: what the existing
 * verification record proved (referenced by id, never duplicated), or
 * its honest not-run with an owner.
 */
export const VERIFICATION_PROOF_KINDS = ["proved", "not-run"] as const;
export type VerificationProofKind = (typeof VERIFICATION_PROOF_KINDS)[number];

/**
 * The closed verification-outcome vocabulary — the existing verification
 * module's own PASS | FAIL | INCONCLUSIVE semantics, mirrored (never
 * imported) in this module's lowercase spelling, exactly as PCS-002
 * mirrored the substrate modality atoms without importing them.
 */
export const VERIFICATION_PROOF_OUTCOMES = ["pass", "fail", "inconclusive"] as const;
export type VerificationProofOutcome = (typeof VERIFICATION_PROOF_OUTCOMES)[number];

/**
 * The closed cooldown-state-at-dispatch vocabulary (ACR-010 §2: the
 * mechanics that produced the measurement): no cooldown was active, or
 * one was active naming the failure class that entered it and the
 * bounded milliseconds remaining.
 */
export const DISPATCH_COOLDOWN_KINDS = ["none", "active"] as const;
export type DispatchCooldownKind = (typeof DISPATCH_COOLDOWN_KINDS)[number];

// ---------------------------------------------------------------------------
// The typed fact block
// ---------------------------------------------------------------------------

/**
 * Pure validation verdict for the closed fact block (the executions
 * domain's locally declared spelling of the capabilities module's
 * `FactValidation` discipline — this module is self-contained).
 */
export type FactValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** One measured latency point, or its honest NOT RUN with an owner. */
export type LatencyMeasurement =
  | {
      readonly kind: "measured";
      /** Wall-clock milliseconds in [0, MAX_LATENCY_MS]. */
      readonly milliseconds: number;
    }
  | {
      readonly kind: "not-run";
      /** Who owes the measurement — bounded, never a placeholder value. */
      readonly owner: string;
    };

/** One measured cost line, or its honest NOT RUN with an owner. */
export type CostLine =
  | {
      readonly kind: "measured";
      /** Integer micro-USD in [0, 10^18) — the CostClaim money bound. */
      readonly microUsd: string;
      /** The explicit attribution source (the CostClaim basis discipline). */
      readonly source: string;
    }
  | {
      readonly kind: "not-run";
      readonly owner: string;
    };

/** The cooldown state at dispatch: none, or active and typed. */
export type DispatchCooldownState =
  | { readonly kind: "none" }
  | {
      readonly kind: "active";
      /** The failure class that entered the cooldown (closed taxonomy). */
      readonly failureClass: OutcomeFailureClass;
      /** Bounded milliseconds remaining at dispatch. */
      readonly remainingMs: number;
    };

/** What verification proved — referenced, never duplicated. */
export type VerificationProof =
  | {
      readonly kind: "proved";
      readonly outcome: VerificationProofOutcome;
      /** The existing verification-result records, referenced by id (>= 1). */
      readonly resultIds: readonly string[];
    }
  | {
      readonly kind: "not-run";
      readonly owner: string;
    };

/**
 * The EXPLICIT basis of the whole fact block (the explicit-basis
 * `CostClaim` discipline applied to outcome-latency facts): which
 * execution produced the measurements, which route the block describes,
 * at which plan revision, under which clock discipline. Every element is
 * required; an unattributed outcome-latency fact is unrepresentable.
 */
export interface OutcomeLatencyBasis {
  /** The bounded identity of the execution the facts attach to. */
  readonly executionId: string;
  /** The route the block describes (neutral provider/model slugs). */
  readonly route: {
    readonly provider: string;
    readonly model: string;
  };
  /** The plan revision the measurements were taken at (>= 0, bounded). */
  readonly revision: number;
  readonly clockDiscipline: ClockDiscipline;
}

/**
 * One route leg of the execution: the leg's bounded identity, the
 * neutral route it ran, the failure class it encountered (absent when
 * it met none — undefined and null are both the absent spelling), and
 * the measured wall-clock of its two latency points (first byte,
 * completion) — each measured, or honestly NOT RUN with an owner.
 */
export interface OutcomeLatencyLeg {
  readonly legId: string;
  readonly route: {
    readonly provider: string;
    readonly model: string;
  };
  readonly failureClass?: OutcomeFailureClass | null;
  readonly firstByte: LatencyMeasurement;
  readonly completion: LatencyMeasurement;
}

/**
 * The attempt census — the duplicate-attempt truth (ACR-010 §2): the
 * count of attempts by class (original, retry, fallback, verification)
 * plus the total, which reconciles EXACTLY (attempts = original +
 * retry + fallback + verification — no failure hiding).
 */
export interface AttemptCensus {
  readonly original: number;
  readonly retry: number;
  readonly fallback: number;
  readonly verification: number;
  readonly attempts: number;
}

/** The queue/progress mechanics that produced the measurement. */
export interface ProgressDeliveryFacts {
  readonly mode: ProgressDeliveryMode;
  /**
   * The polling interval actually applied — REQUIRED when the mode is
   * `polled`; explicitly absent (undefined | null) for `event-stream`
   * (the incoherent shape is rejected typed).
   */
  readonly pollingInterval?: LatencyMeasurement | null;
  readonly cooldownAtDispatch: DispatchCooldownState;
}

/**
 * The cost truth: the total INCLUDING duplicate attempts, with
 * verification cost carried as its own line (ACR-010 §2) — each line
 * measured with an explicit attribution source, or honestly not-run.
 */
export interface OutcomeLatencyCost {
  readonly totalIncludingDuplicates: CostLine;
  readonly verification: CostLine;
}

/**
 * The closed outcome-latency fact block (ACR-010 §2): an OPTIONAL block
 * describing one execution's outcome-latency and cost truth. Absent
 * (undefined | null) = the byte-identical-today state.
 */
export interface OutcomeLatencyFacts {
  readonly outcomeClass: OutcomeClass;
  /** The route legs (bounded, duplicate-free by legId, possibly empty). */
  readonly legs: readonly OutcomeLatencyLeg[];
  readonly attemptCensus: AttemptCensus;
  readonly progress: ProgressDeliveryFacts;
  readonly cost: OutcomeLatencyCost;
  /** Whether the outcome resolved (consistent with the outcome class). */
  readonly resolved: boolean;
  readonly verification: VerificationProof;
  /** The EXPLICIT basis (required — provenance is never an afterthought). */
  readonly basis: OutcomeLatencyBasis;
}

// ---------------------------------------------------------------------------
// Total, deterministic, fail-closed validation
// ---------------------------------------------------------------------------

/** The wall-clock latency bound: milliseconds in [0, 3_600_000]. */
export const MAX_LATENCY_MS = 3_600_000;
/** The attempt-census bound: each counter is an integer in [0, 1000]. */
export const MAX_ATTEMPT_COUNT = 1000;
/** The plan-revision bound: a non-negative integer in [0, 2^31 - 1]. */
export const MAX_PLAN_REVISION = 2_147_483_647;
/** The route-leg census bound. */
export const MAX_LEGS = 100;
/** The verification-result reference bound. */
export const MAX_VERIFICATION_RESULT_REFS = 100;
/** Bounded identity fields (execution/leg/result identities). */
const IDENTITY_MAX = 128;
/** Bounded attribution sources and not-run owners (the CostClaim bound). */
const ATTRIBUTION_SOURCE_MAX = 200;
/** Neutral route slugs (the module's route discipline — provider/model). */
const ROUTE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Integer micro-USD in [0, 10^18) — the CostClaim money bound, as a pattern. */
const MICRO_USD_PATTERN = /^(0|[1-9]\d{0,17})$/;
/** The bounded rendering of an offending value inside a reason. */
const REASON_VALUE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an offending value bounded — the reason names it, never floods. */
function boundedValue(value: unknown): string {
  // Numbers render via String (NaN/Infinity keep their honest spelling —
  // JSON.stringify would flatten them to "null", naming the wrong value).
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

/** The closed-vocabulary rejection: names the field, the vocabulary and the offending value. */
function closedVocabularyReason(
  field: string,
  vocabulary: readonly string[],
  value: unknown,
): string {
  return `outcomeLatencyFacts.${field} must be one of ${vocabulary.join("|")}: ${boundedValue(value)}`;
}

/** The absence spelling: undefined and null are BOTH the absent spelling. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function validateBoundedIdentity(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > IDENTITY_MAX) {
    return `outcomeLatencyFacts.${field} must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(value)}`;
  }
  return null;
}

function validateRouteSlug(value: unknown, field: string): string | null {
  if (typeof value !== "string" || !ROUTE_SLUG_PATTERN.test(value)) {
    return `outcomeLatencyFacts.${field} must be a neutral route slug: ${boundedValue(value)}`;
  }
  return null;
}

function validateBoundedText(
  value: unknown,
  field: string,
  what: string,
  bound: number,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > bound) {
    return `outcomeLatencyFacts.${field} must be a bounded non-empty ${what} (<=${bound}): ${boundedValue(value)}`;
  }
  return null;
}

function validateLatencyMeasurement(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.${field} must be a latency measurement {kind: measured, milliseconds} | {kind: not-run, owner}: ${boundedValue(value)}`;
  }
  if (value.kind === "measured") {
    if (value.owner !== undefined) {
      return `outcomeLatencyFacts.${field}: measured cannot carry an owner (the incoherent shape is rejected)`;
    }
    if (
      typeof value.milliseconds !== "number" ||
      !Number.isFinite(value.milliseconds) ||
      value.milliseconds < 0 ||
      value.milliseconds > MAX_LATENCY_MS
    ) {
      return `outcomeLatencyFacts.${field}.milliseconds must be a finite number in [0, ${MAX_LATENCY_MS}]: ${boundedValue(value.milliseconds)}`;
    }
    return null;
  }
  if (value.kind === "not-run") {
    if (value.milliseconds !== undefined) {
      return `outcomeLatencyFacts.${field}: not-run cannot carry milliseconds (the incoherent shape is rejected)`;
    }
    return validateBoundedText(value.owner, `${field}.owner`, "owner", ATTRIBUTION_SOURCE_MAX);
  }
  return closedVocabularyReason(`${field}.kind`, MEASUREMENT_KINDS, value.kind);
}

function validateCostLine(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.${field} must be a cost line {kind: measured, microUsd, source} | {kind: not-run, owner}: ${boundedValue(value)}`;
  }
  if (value.kind === "measured") {
    if (value.owner !== undefined) {
      return `outcomeLatencyFacts.${field}: measured cannot carry an owner (the incoherent shape is rejected)`;
    }
    if (typeof value.microUsd !== "string" || !MICRO_USD_PATTERN.test(value.microUsd)) {
      return `outcomeLatencyFacts.${field}.microUsd must be an integer micro-USD string in [0, 10^18): ${boundedValue(value.microUsd)}`;
    }
    return validateBoundedText(
      value.source,
      `${field}.source`,
      "attribution source",
      ATTRIBUTION_SOURCE_MAX,
    );
  }
  if (value.kind === "not-run") {
    if (value.microUsd !== undefined || value.source !== undefined) {
      return `outcomeLatencyFacts.${field}: not-run cannot carry microUsd or source (the incoherent shape is rejected)`;
    }
    return validateBoundedText(value.owner, `${field}.owner`, "owner", ATTRIBUTION_SOURCE_MAX);
  }
  return closedVocabularyReason(`${field}.kind`, MEASUREMENT_KINDS, value.kind);
}

function validateRoute(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.${field} must be a route {provider, model}: ${boundedValue(value)}`;
  }
  const providerError = validateRouteSlug(value.provider, `${field}.provider`);
  if (providerError !== null) {
    return providerError;
  }
  return validateRouteSlug(value.model, `${field}.model`);
}

function validateLatencyLeg(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.${field} must be a route-leg object: ${boundedValue(value)}`;
  }
  const legIdError = validateBoundedIdentity(value.legId, `${field}.legId`);
  if (legIdError !== null) {
    return legIdError;
  }
  const legId = value.legId as string;
  const routeError = validateRoute(value.route, `${field}[legId=${legId}].route`);
  if (routeError !== null) {
    return routeError;
  }
  // The failure class is present exactly when the leg encountered a
  // failure; absent (undefined | null) is the no-failure spelling.
  if (!isAbsent(value.failureClass)) {
    if (
      typeof value.failureClass !== "string" ||
      !(OUTCOME_FAILURE_CLASSES as readonly string[]).includes(value.failureClass)
    ) {
      return closedVocabularyReason(
        `${field}[legId=${legId}].failureClass`,
        OUTCOME_FAILURE_CLASSES,
        value.failureClass,
      );
    }
  }
  const firstByteError = validateLatencyMeasurement(
    value.firstByte,
    `${field}[legId=${legId}].firstByte`,
  );
  if (firstByteError !== null) {
    return firstByteError;
  }
  return validateLatencyMeasurement(value.completion, `${field}[legId=${legId}].completion`);
}

function validateAttemptCensus(value: unknown): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.attemptCensus must be the attempt census {original, retry, fallback, verification, attempts}: ${boundedValue(value)}`;
  }
  const counters: readonly (keyof AttemptCensus)[] = [
    "original",
    "retry",
    "fallback",
    "verification",
    "attempts",
  ];
  for (const label of counters) {
    const counter = value[label];
    if (
      typeof counter !== "number" ||
      !Number.isInteger(counter) ||
      counter < 0 ||
      counter > MAX_ATTEMPT_COUNT
    ) {
      return `outcomeLatencyFacts.attemptCensus.${label} must be an integer in [0, ${MAX_ATTEMPT_COUNT}]: ${boundedValue(counter)}`;
    }
  }
  // All five counters are validated numbers here — the exact
  // outcome-census reconciliation (ACR-010 §2, no failure hiding):
  // attempts = original + retry + fallback + verification.
  const original = value.original as number;
  const retry = value.retry as number;
  const fallback = value.fallback as number;
  const verification = value.verification as number;
  const attempts = value.attempts as number;
  const sum = original + retry + fallback + verification;
  if (attempts !== sum) {
    return `outcomeLatencyFacts.attemptCensus.attempts must equal original + retry + fallback + verification (the exact outcome-census reconciliation — no failure hiding): attempts=${attempts}, original+retry+fallback+verification=${sum}`;
  }
  return null;
}

/** The outcome class agrees with the attempt census (the plain meanings of the closed classes). */
function outcomeClassCensusAgreement(
  outcomeClass: OutcomeClass,
  census: AttemptCensus,
): string | null {
  if (outcomeClass === "succeeded-first-attempt") {
    if (census.retry !== 0 || census.fallback !== 0) {
      return `outcomeLatencyFacts.outcomeClass succeeded-first-attempt is incoherent with the attempt census (retry and fallback must be 0 — a first-attempt success retried or fell back nothing): retry=${census.retry}, fallback=${census.fallback}`;
    }
    return null;
  }
  if (outcomeClass === "succeeded-after-retry") {
    if (census.retry < 1 || census.fallback !== 0) {
      return `outcomeLatencyFacts.outcomeClass succeeded-after-retry is incoherent with the attempt census (retry must be >= 1 and fallback must be 0 — a success on fallback is succeeded-on-fallback): retry=${census.retry}, fallback=${census.fallback}`;
    }
    return null;
  }
  if (outcomeClass === "succeeded-on-fallback") {
    if (census.fallback < 1) {
      return `outcomeLatencyFacts.outcomeClass succeeded-on-fallback is incoherent with the attempt census (fallback must be >= 1): fallback=${census.fallback}`;
    }
    return null;
  }
  // failed-terminal: a terminal failure may terminate after any census
  // (including a pre-dispatch policy denial with every counter at 0) —
  // the class never lies about the census, and the census never hides
  // the failure (recorded as the terminal failure it is).
  return null;
}

function validateProgressDelivery(value: unknown): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.progress must be the progress-delivery facts {mode, pollingInterval?, cooldownAtDispatch}: ${boundedValue(value)}`;
  }
  if (
    typeof value.mode !== "string" ||
    !(PROGRESS_DELIVERY_MODES as readonly string[]).includes(value.mode)
  ) {
    return closedVocabularyReason("progress.mode", PROGRESS_DELIVERY_MODES, value.mode);
  }
  const mode = value.mode as ProgressDeliveryMode;
  if (mode === "polled") {
    if (isAbsent(value.pollingInterval)) {
      return "outcomeLatencyFacts.progress.pollingInterval is required when progress.mode is polled (the interval actually applied): absent";
    }
    const intervalError = validateLatencyMeasurement(
      value.pollingInterval,
      "progress.pollingInterval",
    );
    if (intervalError !== null) {
      return intervalError;
    }
  } else if (!isAbsent(value.pollingInterval)) {
    // event-stream: a polling interval riding an event stream is the
    // incoherent shape (an event stream is not polled), rejected typed.
    return "outcomeLatencyFacts.progress.pollingInterval cannot ride progress.mode event-stream (the incoherent shape is rejected — event streams are not polled)";
  }
  const cooldown = value.cooldownAtDispatch;
  if (!isRecord(cooldown)) {
    return `outcomeLatencyFacts.progress.cooldownAtDispatch must be the cooldown state at dispatch {kind: none} | {kind: active, failureClass, remainingMs}: ${boundedValue(cooldown)}`;
  }
  if (cooldown.kind === "none") {
    if (cooldown.failureClass !== undefined || cooldown.remainingMs !== undefined) {
      return "outcomeLatencyFacts.progress.cooldownAtDispatch: none cannot carry a failureClass or remainingMs (the incoherent shape is rejected)";
    }
    return null;
  }
  if (cooldown.kind === "active") {
    if (
      typeof cooldown.failureClass !== "string" ||
      !(OUTCOME_FAILURE_CLASSES as readonly string[]).includes(cooldown.failureClass)
    ) {
      return closedVocabularyReason(
        "progress.cooldownAtDispatch.failureClass",
        OUTCOME_FAILURE_CLASSES,
        cooldown.failureClass,
      );
    }
    if (
      typeof cooldown.remainingMs !== "number" ||
      !Number.isFinite(cooldown.remainingMs) ||
      cooldown.remainingMs < 0 ||
      cooldown.remainingMs > MAX_LATENCY_MS
    ) {
      return `outcomeLatencyFacts.progress.cooldownAtDispatch.remainingMs must be a finite number in [0, ${MAX_LATENCY_MS}]: ${boundedValue(cooldown.remainingMs)}`;
    }
    return null;
  }
  return closedVocabularyReason(
    "progress.cooldownAtDispatch.kind",
    DISPATCH_COOLDOWN_KINDS,
    cooldown.kind,
  );
}

function validateCost(value: unknown): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.cost must be the cost block {totalIncludingDuplicates, verification}: ${boundedValue(value)}`;
  }
  const totalError = validateCostLine(
    value.totalIncludingDuplicates,
    "cost.totalIncludingDuplicates",
  );
  if (totalError !== null) {
    return totalError;
  }
  return validateCostLine(value.verification, "cost.verification");
}

function validateVerificationProof(value: unknown): string | null {
  if (!isRecord(value)) {
    return `outcomeLatencyFacts.verification must be a verification proof {kind: proved, outcome, resultIds} | {kind: not-run, owner}: ${boundedValue(value)}`;
  }
  if (value.kind === "proved") {
    if (value.owner !== undefined) {
      return "outcomeLatencyFacts.verification: proved cannot carry an owner (the incoherent shape is rejected)";
    }
    if (
      typeof value.outcome !== "string" ||
      !(VERIFICATION_PROOF_OUTCOMES as readonly string[]).includes(value.outcome)
    ) {
      return closedVocabularyReason(
        "verification.outcome",
        VERIFICATION_PROOF_OUTCOMES,
        value.outcome,
      );
    }
    if (!Array.isArray(value.resultIds)) {
      return "outcomeLatencyFacts.verification.resultIds must be an array of bounded verification-result references (referenced, never duplicated)";
    }
    if (value.resultIds.length === 0) {
      return "outcomeLatencyFacts.verification.resultIds must reference at least one verification result when kind is proved (referenced, never duplicated)";
    }
    if (value.resultIds.length > MAX_VERIFICATION_RESULT_REFS) {
      return `outcomeLatencyFacts.verification.resultIds must hold at most ${MAX_VERIFICATION_RESULT_REFS} references (bounded): ${value.resultIds.length}`;
    }
    const seen = new Set<string>();
    for (const resultId of value.resultIds) {
      const idError = validateBoundedIdentity(resultId, "verification.resultIds entry");
      if (idError !== null) {
        return idError;
      }
      if (seen.has(resultId)) {
        return `outcomeLatencyFacts.verification.resultIds must not contain duplicates: ${boundedValue(resultId)}`;
      }
      seen.add(resultId);
    }
    return null;
  }
  if (value.kind === "not-run") {
    if (value.outcome !== undefined || value.resultIds !== undefined) {
      return "outcomeLatencyFacts.verification: not-run cannot carry an outcome or resultIds (the incoherent shape is rejected)";
    }
    return validateBoundedText(value.owner, "verification.owner", "owner", ATTRIBUTION_SOURCE_MAX);
  }
  return closedVocabularyReason("verification.kind", VERIFICATION_PROOF_KINDS, value.kind);
}

function validateBasis(value: unknown): string | null {
  if (!isRecord(value)) {
    return "outcomeLatencyFacts.basis is required on every outcome-latency fact (the explicit-basis CostClaim discipline — an unattributed outcome-latency fact is unrepresentable)";
  }
  const executionIdError = validateBoundedIdentity(value.executionId, "basis.executionId");
  if (executionIdError !== null) {
    return executionIdError;
  }
  const routeError = validateRoute(value.route, "basis.route");
  if (routeError !== null) {
    return routeError;
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    value.revision > MAX_PLAN_REVISION
  ) {
    return `outcomeLatencyFacts.basis.revision must be an integer in [0, ${MAX_PLAN_REVISION}]: ${boundedValue(value.revision)}`;
  }
  if (
    typeof value.clockDiscipline !== "string" ||
    !(CLOCK_DISCIPLINES as readonly string[]).includes(value.clockDiscipline)
  ) {
    return closedVocabularyReason(
      "basis.clockDiscipline",
      CLOCK_DISCIPLINES,
      value.clockDiscipline,
    );
  }
  return null;
}

/**
 * Total, deterministic, fail-closed validation of the closed fact
 * block. Every field's vocabulary is closed; every bound is typed;
 * every rejection's reason names the field and the offending value.
 * The check order is frozen (outcomeClass, legs, attemptCensus, census
 * reconciliation, outcome-class/census agreement, progress, cost,
 * resolved, verification, basis) — the same input always yields the
 * byte-identical first rejection. Absence is NOT handled here (the
 * riding point decides the absence spelling) — this function validates
 * a PRESENT block only.
 */
export function validateOutcomeLatencyFacts(value: unknown): FactValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      reason: "outcomeLatencyFacts must be an object (the closed fact block)",
    };
  }
  if (
    typeof value.outcomeClass !== "string" ||
    !(OUTCOME_CLASSES as readonly string[]).includes(value.outcomeClass)
  ) {
    return {
      valid: false,
      reason: closedVocabularyReason("outcomeClass", OUTCOME_CLASSES, value.outcomeClass),
    };
  }
  const outcomeClass = value.outcomeClass as OutcomeClass;
  if (!Array.isArray(value.legs)) {
    return { valid: false, reason: "outcomeLatencyFacts.legs must be an array of route legs" };
  }
  if (value.legs.length > MAX_LEGS) {
    return {
      valid: false,
      reason: `outcomeLatencyFacts.legs must hold at most ${MAX_LEGS} route legs (bounded): ${value.legs.length}`,
    };
  }
  const seenLegIds = new Set<string>();
  for (const leg of value.legs) {
    const legError = validateLatencyLeg(leg, "legs");
    if (legError !== null) {
      return { valid: false, reason: legError };
    }
    const legId = (leg as Record<string, unknown>).legId as string;
    if (seenLegIds.has(legId)) {
      return {
        valid: false,
        reason: `outcomeLatencyFacts.legs must not contain duplicate legId: ${boundedValue(legId)}`,
      };
    }
    seenLegIds.add(legId);
  }
  const censusError = validateAttemptCensus(value.attemptCensus);
  if (censusError !== null) {
    return { valid: false, reason: censusError };
  }
  const census = value.attemptCensus as AttemptCensus;
  const censusAgreementError = outcomeClassCensusAgreement(outcomeClass, census);
  if (censusAgreementError !== null) {
    return { valid: false, reason: censusAgreementError };
  }
  const progressError = validateProgressDelivery(value.progress);
  if (progressError !== null) {
    return { valid: false, reason: progressError };
  }
  const costError = validateCost(value.cost);
  if (costError !== null) {
    return { valid: false, reason: costError };
  }
  if (typeof value.resolved !== "boolean") {
    return {
      valid: false,
      reason: `outcomeLatencyFacts.resolved must be a boolean (whether the outcome resolved): ${boundedValue(value.resolved)}`,
    };
  }
  // Resolution agreement (ACR-010 §2/§5 — no failure hiding): a
  // succeeded outcome records its resolution; a terminal failure never
  // records one (dropping or reclassifying unresolved executions is the
  // automatic-void shape).
  if (outcomeClass !== "failed-terminal" && value.resolved !== true) {
    return {
      valid: false,
      reason: `outcomeLatencyFacts.resolved is incoherent with outcomeClass ${outcomeClass} (a succeeded outcome records resolved=true): resolved=${value.resolved}`,
    };
  }
  if (outcomeClass === "failed-terminal" && value.resolved !== false) {
    return {
      valid: false,
      reason: `outcomeLatencyFacts.resolved is incoherent with outcomeClass failed-terminal (a terminal failure never records resolved — no failure hiding): resolved=${value.resolved}`,
    };
  }
  const verificationError = validateVerificationProof(value.verification);
  if (verificationError !== null) {
    return { valid: false, reason: verificationError };
  }
  const basisError = validateBasis(value.basis);
  if (basisError !== null) {
    return { valid: false, reason: basisError };
  }
  return { valid: true };
}

/**
 * Validate the OPTIONAL fact block at a riding point: absence (undefined
 * AND null — both the absent spelling) is valid and byte-identical to
 * the pre-change behavior; a present block is validated fail-closed.
 * Pure and total — the riding points PCL-002 wires call this seam.
 */
export function validateOptionalOutcomeLatencyFacts(
  value: OutcomeLatencyFacts | null | undefined,
): FactValidation {
  if (isAbsent(value)) {
    return { valid: true };
  }
  return validateOutcomeLatencyFacts(value);
}

// ---------------------------------------------------------------------------
// Canonical serialization + content-addressable identity (the PCR-001
// RecoveryPlan discipline: the content address is the digest over the
// canonical form; same facts → same address, always)
// ---------------------------------------------------------------------------

/**
 * Recursively canonicalize: sorted keys at every depth; undefined and
 * null values are BOTH the absent spelling and render as key-omission
 * (all absence spellings produce the byte-identical canonical form);
 * arrays keep their element kinds.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .filter((key) => !isAbsent(record[key]))
      .sort()
      .map((key) => [key, canonical(record[key])]);
  }
  return value;
}

/** Code-unit ordering (deterministic across environments — never locale-dependent). */
function byCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalVerificationProof(proof: VerificationProof): unknown {
  // Referenced result ids are sorted — input order is never identity.
  return proof.kind === "proved"
    ? { ...proof, resultIds: [...proof.resultIds].sort(byCodeUnitOrder) }
    : { ...proof };
}

/**
 * Deterministic canonical JSON of the fact block (the module's own
 * content-addressing base, mirroring the PCS-002 canonical-JSON
 * discipline (a tagged tuple; nested objects render as sorted-key pair arrays with
 * absence as key-omission; legs are sorted by legId; verification
 * result references are sorted — input order and absence spelling are
 * never identity). The same facts always produce the byte-identical
 * canonical form.
 */
export function canonicalOutcomeLatencyJson(facts: OutcomeLatencyFacts): string {
  return JSON.stringify([
    "executions.outcome-latency-facts",
    facts.outcomeClass,
    [...facts.legs]
      .sort((left, right) => byCodeUnitOrder(left.legId, right.legId))
      .map((leg) => canonical(leg)),
    canonical(facts.attemptCensus),
    canonical(facts.progress),
    canonical(facts.cost),
    facts.resolved,
    canonical(canonicalVerificationProof(facts.verification)),
    canonical(facts.basis),
  ]);
}

/**
 * The content-addressable identity of one fact block for evidence
 * correlation: the digest (INJECTED — never ambient, never
 * module-owned) over the canonical form. Deterministic — the same
 * facts always produce the byte-identical identity.
 */
export function outcomeLatencyFactsIdentity(
  facts: OutcomeLatencyFacts,
  digest: (canonical: string) => string,
): string {
  return digest(canonicalOutcomeLatencyJson(facts));
}

// ---------------------------------------------------------------------------
// The attachment-boundary check (pure, no wiring — PCL-002 wires the
// riding points; this is the mechanical identity check)
// ---------------------------------------------------------------------------

/**
 * The outcome-record side of the attachment boundary: the identity
 * facts every execution outcome record already carries (its execution
 * identity and the plan revision the outcome was produced at). A
 * minimal typed view — the record itself is never duplicated.
 */
export interface OutcomeRecordIdentity {
  readonly executionId: string;
  readonly planRevision: number;
}

/** Why the boundary check was skipped (absence of either side — exactly today's behavior). */
export type OutcomeLatencyBoundarySkipReason =
  | "facts-absent"
  | "record-absent"
  | "both-sides-absent";

/** The identity fields the boundary compares (the frozen mismatch order). */
export type OutcomeLatencyMismatchField = "execution-id" | "plan-revision";

/**
 * One typed identity mismatch at the attachment boundary: the field
 * that mismatched, the fact block's basis (the side the fact claims),
 * and BOTH sides' values (deterministic renderings — the mismatch
 * names both sides, never just one).
 */
export interface OutcomeLatencyMismatch {
  readonly field: OutcomeLatencyMismatchField;
  /** The fact block's basis — the side the fact claims. */
  readonly factsBasis: OutcomeLatencyBasis;
  readonly factsValue: string;
  readonly recordValue: string;
}

/**
 * The typed boundary verdict. DATA, never an engine: `compatible`
 * (the fact block's basis matches the outcome record's identity),
 * `skipped` (absence of either side — the check does not fire,
 * exactly today), `invalid` (a present-but-malformed side at the
 * boundary — fail closed, never a permissive default) or
 * `incompatible` (every identity mismatch typed, both sides named).
 */
export type OutcomeLatencyBoundaryCheck =
  | { readonly kind: "compatible" }
  | { readonly kind: "skipped"; readonly reason: OutcomeLatencyBoundarySkipReason }
  | { readonly kind: "invalid"; readonly side: "facts" | "record"; readonly reason: string }
  | { readonly kind: "incompatible"; readonly mismatches: readonly OutcomeLatencyMismatch[] };

function validateOutcomeRecordIdentity(value: unknown): string | null {
  if (!isRecord(value)) {
    return `outcomeRecord must be the record identity {executionId, planRevision}: ${boundedValue(value)}`;
  }
  if (
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    value.executionId.length > IDENTITY_MAX
  ) {
    return `outcomeRecord.executionId must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(value.executionId)}`;
  }
  if (
    typeof value.planRevision !== "number" ||
    !Number.isInteger(value.planRevision) ||
    value.planRevision < 0 ||
    value.planRevision > MAX_PLAN_REVISION
  ) {
    return `outcomeRecord.planRevision must be an integer in [0, ${MAX_PLAN_REVISION}]: ${boundedValue(value.planRevision)}`;
  }
  return null;
}

/**
 * Check the fact block's explicit basis against the outcome record's
 * identity at the attachment boundary: the basis's execution identity
 * and plan revision must match the record's. Pure and deterministic —
 * the same inputs always produce the byte-identical verdict
 * (invariant 5).
 *
 * Absence of either side skips the check exactly as today
 * (absence-equivalent); a malformed fact block OR a malformed record
 * identity is a typed `invalid` verdict naming the side — both sides
 * are pre-validated fail-closed BEFORE any comparison (a malformed
 * side is never compared). Mismatches are reported in the frozen
 * field order (execution-id, then plan-revision), each naming both
 * sides' values.
 */
export function checkOutcomeLatencyBoundary(input: {
  readonly facts: OutcomeLatencyFacts | null | undefined;
  readonly record: OutcomeRecordIdentity | null | undefined;
}): OutcomeLatencyBoundaryCheck {
  // undefined and null are BOTH the absent spelling on either side.
  const facts = input.facts;
  const record = input.record;
  if ((facts === undefined || facts === null) && (record === undefined || record === null)) {
    return { kind: "skipped", reason: "both-sides-absent" };
  }
  if (facts === undefined || facts === null) {
    return { kind: "skipped", reason: "facts-absent" };
  }
  if (record === undefined || record === null) {
    return { kind: "skipped", reason: "record-absent" };
  }
  // Both sides PRESENT: validate both fail-closed before any
  // comparison (a malformed side at the boundary is never compared).
  const factsValidation = validateOutcomeLatencyFacts(facts);
  if (!factsValidation.valid) {
    return { kind: "invalid", side: "facts", reason: factsValidation.reason };
  }
  const recordError = validateOutcomeRecordIdentity(record);
  if (recordError !== null) {
    return { kind: "invalid", side: "record", reason: recordError };
  }
  const mismatches: OutcomeLatencyMismatch[] = [];
  // The frozen field order is the canonical mismatch order — input
  // spelling never reorders the verdict.
  if (facts.basis.executionId !== record.executionId) {
    mismatches.push({
      field: "execution-id",
      factsBasis: facts.basis,
      factsValue: facts.basis.executionId,
      recordValue: record.executionId,
    });
  }
  if (facts.basis.revision !== record.planRevision) {
    mismatches.push({
      field: "plan-revision",
      factsBasis: facts.basis,
      factsValue: String(facts.basis.revision),
      recordValue: String(record.planRevision),
    });
  }
  if (mismatches.length > 0) {
    return { kind: "incompatible", mismatches };
  }
  return { kind: "compatible" };
}
