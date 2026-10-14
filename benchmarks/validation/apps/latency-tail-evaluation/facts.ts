/**
 * The outcome-latency typed facts — the evaluation's app-local mirror of
 * the PCL-001 plane (ACR-010 §2; work order PCL-003).
 *
 * THE BOUNDARY DISCIPLINE (VAL-002 AC7 — never `src/**` from the
 * application tree): the PCL-001 fact plane lives at
 * `src/modules/executions/domain/outcome-latency-facts.ts` (a domain
 * file with NO public-barrel re-export — the executions module's own
 * convention, pinned by the PCL-001 architecture tests), so it is NOT
 * importable from the application tree. This module mirrors it the
 * established way — the PCS-004 evaluation-app precedent (the
 * workload-class mirror: closed vocabularies mirrored BY VALUE and
 * pinned against the authority BY TEST) plus the PCR-003 canonical-
 * serializer precedent (implemented locally, pinned byte-for-byte
 * in-suite). The `tests/unit/validation/pcl-003-mirror-pins.test.ts`
 * suite pins: every vocabulary below is EXACTLY the PCL-001 authority's
 * frozen vocabulary, every bound is exactly the authority's bound, and
 * every fact this evaluation emits VALIDATES on the REAL
 * `validateOutcomeLatencyFacts` (the PCL-001 plane's own fail-closed
 * validator) — drift is a typed failure, never silent. The real plane
 * is consumed READ-ONLY; a defect is REPORTED to the Lead with an
 * owner, never patched here.
 *
 * THE CLOSED FACT BLOCK (ACR-010 §2 — every field closed and typed; the
 * same field semantics the authority defines):
 *
 *   outcome class       → succeeded-first-attempt | succeeded-after-retry
 *                         | succeeded-on-fallback | failed-terminal;
 *   failure classes     → the closed 7-member per-leg taxonomy
 *                         (provider-5xx, provider-timeout,
 *                         provider-throttle, connection-error,
 *                         verification-retry, budget-exhausted,
 *                         policy-denied) — a leg that met no failure
 *                         carries the ABSENT spelling;
 *   progress delivery   → event-stream | polled, the polling interval
 *                         required exactly when polled, the cooldown
 *                         state at dispatch (none | active + class +
 *                         bounded remaining ms);
 *   per-leg latency     → first byte + completion, each measured (ms,
 *                         non-negative, bounded) or the honest NOT RUN
 *                         with an owner;
 *   attempt census      → original + retry + fallback + verification
 *                         + attempts, reconciling EXACTLY;
 *   cost                → total INCLUDING duplicates + verification as
 *                         its own line, each measured (integer micro-USD
 *                         in [0, 10^18), explicit attribution source) or
 *                         the honest NOT RUN with an owner;
 *   resolution          → boolean, agreeing with the outcome class;
 *   verification        → proved (pass | fail | inconclusive, >= 1
 *                         result-id references) or not-run with an
 *                         owner;
 *   basis               → the EXPLICIT provenance (execution id, route,
 *                         plan revision, clock discipline) — required.
 *
 * CONSTRUCTION LAWS (fail-closed at this module's constructor — the
 * same laws the authority's validator enforces; the suites test every
 * rejection): closed vocabularies (unknown values rejected typed),
 * bounded values, duplicate-free legs, the census reconciliation
 * (attempts = original + retry + fallback + verification — no failure
 * hiding), the outcome-class/census agreement, the resolution/outcome-
 * class agreement, and the absence spellings (undefined and null are
 * BOTH the absent spelling; the canonical form renders every absence
 * as key-omission).
 *
 * CANONICAL FORM + CONTENT ADDRESSING (the PCR-001 RecoveryPlan
 * discipline, mirrored byte-for-byte from the authority): the canonical
 * serialization is a tagged tuple — legs sorted by legId, verification
 * result references sorted, nested objects rendered as sorted-key pair
 * arrays with absence as key-omission — and the content address is the
 * digest (INJECTED, never ambient) over the canonical form. The local
 * canonical serializer is pinned byte-for-byte in-suite against the
 * REAL `canonicalOutcomeLatencyJson` over every emitted fact and the
 * edge fixtures.
 *
 * Pure and total: no environment reads, no clock, no randomness, no
 * I/O — the same facts always produce the byte-identical construction
 * verdict, canonical form and content address.
 */

// ---------------------------------------------------------------------------
// The frozen vocabularies (the mirror of the PCL-001 authority — pinned
// by test; widening is a reviewed change the pin catches)
// ---------------------------------------------------------------------------

/** The closed outcome classification ACR-010 §2 measures tails over. */
export const OUTCOME_CLASSES = [
  "succeeded-first-attempt",
  "succeeded-after-retry",
  "succeeded-on-fallback",
  "failed-terminal",
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** The closed per-leg failure taxonomy (ACR-010 §2's own closed list). */
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

/** The progress-delivery mode actually used (ACR-010 §2). */
export const PROGRESS_DELIVERY_MODES = ["event-stream", "polled"] as const;
export type ProgressDeliveryMode = (typeof PROGRESS_DELIVERY_MODES)[number];

/** The clock discipline that produced the measurements, recorded as a fact. */
export const CLOCK_DISCIPLINES = ["wall-clock", "monotonic"] as const;
export type ClockDiscipline = (typeof CLOCK_DISCIPLINES)[number];

/** The closed two-kind measurement vocabulary (measured | not-run). */
export const MEASUREMENT_KINDS = ["measured", "not-run"] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

/** The closed verification-proof vocabulary (proved | not-run). */
export const VERIFICATION_PROOF_KINDS = ["proved", "not-run"] as const;
export type VerificationProofKind = (typeof VERIFICATION_PROOF_KINDS)[number];

/** The closed verification-outcome vocabulary (the verification module's own, mirrored). */
export const VERIFICATION_PROOF_OUTCOMES = ["pass", "fail", "inconclusive"] as const;
export type VerificationProofOutcome = (typeof VERIFICATION_PROOF_OUTCOMES)[number];

/** The closed cooldown-state-at-dispatch vocabulary (none | active). */
export const DISPATCH_COOLDOWN_KINDS = ["none", "active"] as const;
export type DispatchCooldownKind = (typeof DISPATCH_COOLDOWN_KINDS)[number];

// ---------------------------------------------------------------------------
// The mirrored typed bounds (the authority's own numbers — pinned by test)
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
/** Neutral route slugs (provider/model). */
const ROUTE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Integer micro-USD in [0, 10^18) — the CostClaim money bound, as a pattern. */

// ---------------------------------------------------------------------------
// The typed fact block (structurally the authority's shapes — every fact
// emitted here validates on the REAL PCL-001 validator, pinned in-suite)
// ---------------------------------------------------------------------------

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

/** The EXPLICIT basis of the whole fact block (the CostClaim discipline). */
export interface OutcomeLatencyBasis {
  readonly executionId: string;
  readonly route: {
    readonly provider: string;
    readonly model: string;
  };
  readonly revision: number;
  readonly clockDiscipline: ClockDiscipline;
}

/** One route leg of the execution. */
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

/** The attempt census — the duplicate-attempt truth. */
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
   * The polling interval actually applied — required when the mode is
   * `polled`; explicitly absent for `event-stream`.
   */
  readonly pollingInterval?: LatencyMeasurement | null;
  readonly cooldownAtDispatch: DispatchCooldownState;
}

/** The cost truth: total INCLUDING duplicates, verification its own line. */
export interface OutcomeLatencyCost {
  readonly totalIncludingDuplicates: CostLine;
  readonly verification: CostLine;
}

/** The closed outcome-latency fact block (ACR-010 §2). */
export interface OutcomeLatencyFacts {
  readonly outcomeClass: OutcomeClass;
  readonly legs: readonly OutcomeLatencyLeg[];
  readonly attemptCensus: AttemptCensus;
  readonly progress: ProgressDeliveryFacts;
  readonly cost: OutcomeLatencyCost;
  readonly resolved: boolean;
  readonly verification: VerificationProof;
  readonly basis: OutcomeLatencyBasis;
}

// ---------------------------------------------------------------------------
// The fail-closed construction (the construction laws — every rejection
// typed and tested; the REAL validator runs over every emitted fact
// in-suite)
// ---------------------------------------------------------------------------

/** The typed construction rejection (fail-closed, never a default). */
export class OutcomeLatencyConstructionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OutcomeLatencyConstructionError";
  }
}

function require_(condition: boolean, reason: string): void {
  if (!condition) {
    throw new OutcomeLatencyConstructionError(reason);
  }
}

function requireClosedVocabulary<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  field: string,
): T {
  require_(
    typeof value === "string" && (vocabulary as readonly string[]).includes(value),
    `outcomeLatencyFacts.${field} must be one of ${vocabulary.join("|")}: ${String(value)}`,
  );
  return value as T;
}

function requireBoundedIdentity(value: unknown, field: string): string {
  require_(
    typeof value === "string" && value.length > 0 && value.length <= IDENTITY_MAX,
    `outcomeLatencyFacts.${field} must be a bounded non-empty identity (<=${IDENTITY_MAX})`,
  );
  return value as string;
}

function requireRouteSlug(value: unknown, field: string): string {
  require_(
    typeof value === "string" && ROUTE_SLUG_PATTERN.test(value),
    `outcomeLatencyFacts.${field} must be a neutral route slug`,
  );
  return value as string;
}

function requireBoundedText(value: unknown, field: string, bound: number): string {
  require_(
    typeof value === "string" && value.length > 0 && value.length <= bound,
    `outcomeLatencyFacts.${field} must be a bounded non-empty text (<=${bound})`,
  );
  return value as string;
}

/** Construct one measured latency point (fail-closed on the bounds). */
export function measuredLatency(milliseconds: number, field = "latency"): LatencyMeasurement {
  require_(
    typeof milliseconds === "number" &&
      Number.isFinite(milliseconds) &&
      milliseconds >= 0 &&
      milliseconds <= MAX_LATENCY_MS,
    `outcomeLatencyFacts.${field}.milliseconds must be a finite number in [0, ${MAX_LATENCY_MS}]: ${String(milliseconds)}`,
  );
  return { kind: "measured", milliseconds };
}

/** Construct one honest NOT-RUN latency point with its owner. */
export function notRunLatency(owner: string, field = "latency"): LatencyMeasurement {
  requireBoundedText(owner, `${field}.owner`, ATTRIBUTION_SOURCE_MAX);
  return { kind: "not-run", owner };
}

/** Construct one measured cost line (integer micro-USD + explicit source). */
export function measuredCost(microUsd: number, source: string, field = "cost"): CostLine {
  require_(
    Number.isInteger(microUsd) && microUsd >= 0 && String(microUsd).length <= 18,
    `outcomeLatencyfacts.${field}.microUsd must be an integer micro-USD in [0, 10^18): ${String(microUsd)}`,
  );
  requireBoundedText(source, `${field}.source`, ATTRIBUTION_SOURCE_MAX);
  return { kind: "measured", microUsd: String(microUsd), source };
}

/** Construct one honest NOT-RUN cost line with its owner. */
export function notRunCost(owner: string, field = "cost"): CostLine {
  requireBoundedText(owner, `${field}.owner`, ATTRIBUTION_SOURCE_MAX);
  return { kind: "not-run", owner };
}

/** Construct a route ({provider, model} neutral slugs). */
export function routeOf(
  provider: string,
  model: string,
): {
  readonly provider: string;
  readonly model: string;
} {
  requireRouteSlug(provider, "route.provider");
  requireRouteSlug(model, "route.model");
  return { provider, model };
}

/**
 * Construct one route leg (fail-closed): bounded legId, neutral route,
 * the failure class present exactly when the leg met a failure, the
 * two latency points each measured or honestly not-run.
 */
export function outcomeLatencyLeg(input: {
  readonly legId: string;
  readonly route: { readonly provider: string; readonly model: string };
  readonly failureClass?: OutcomeFailureClass | null;
  readonly firstByte: LatencyMeasurement;
  readonly completion: LatencyMeasurement;
}): OutcomeLatencyLeg {
  requireBoundedIdentity(input.legId, "legs.legId");
  const legId = input.legId;
  require_(
    input.route.provider.length > 0 && ROUTE_SLUG_PATTERN.test(input.route.provider),
    `outcomeLatencyFacts.legs[legId=${legId}].route.provider must be a neutral route slug`,
  );
  require_(
    input.route.model.length > 0 && ROUTE_SLUG_PATTERN.test(input.route.model),
    `outcomeLatencyFacts.legs[legId=${legId}].route.model must be a neutral route slug`,
  );
  if (input.failureClass !== undefined && input.failureClass !== null) {
    requireClosedVocabulary(input.failureClass, OUTCOME_FAILURE_CLASSES, "legs.failureClass");
  }
  return {
    legId,
    route: { provider: input.route.provider, model: input.route.model },
    ...(input.failureClass === undefined || input.failureClass === null
      ? {}
      : { failureClass: input.failureClass }),
    firstByte: input.firstByte,
    completion: input.completion,
  };
}

/**
 * Construct the attempt census (fail-closed): every counter an integer
 * in [0, 1000]; the census reconciles EXACTLY (attempts = original +
 * retry + fallback + verification — no failure hiding).
 */
export function attemptCensusOf(input: {
  readonly original: number;
  readonly retry: number;
  readonly fallback: number;
  readonly verification: number;
}): AttemptCensus {
  for (const [label, counter] of Object.entries(input)) {
    require_(
      Number.isInteger(counter) && counter >= 0 && counter <= MAX_ATTEMPT_COUNT,
      `outcomeLatencyFacts.attemptCensus.${label} must be an integer in [0, ${MAX_ATTEMPT_COUNT}]: ${String(counter)}`,
    );
  }
  const attempts = input.original + input.retry + input.fallback + input.verification;
  return { ...input, attempts };
}

/**
 * Construct the progress-delivery mechanics record (fail-closed): the
 * polling interval required exactly when the mode is `polled`, absent
 * for `event-stream`; the cooldown state closed and bounded.
 */
export function progressDeliveryFacts(input: {
  readonly mode: ProgressDeliveryMode;
  readonly pollingInterval?: LatencyMeasurement | null;
  readonly cooldownAtDispatch: DispatchCooldownState;
}): ProgressDeliveryFacts {
  requireClosedVocabulary(input.mode, PROGRESS_DELIVERY_MODES, "progress.mode");
  if (input.mode === "polled") {
    require_(
      input.pollingInterval !== undefined && input.pollingInterval !== null,
      "outcomeLatencyFacts.progress.pollingInterval is required when progress.mode is polled",
    );
  } else {
    require_(
      input.pollingInterval === undefined || input.pollingInterval === null,
      "outcomeLatencyFacts.progress.pollingInterval cannot ride progress.mode event-stream (the incoherent shape)",
    );
  }
  const cooldown = input.cooldownAtDispatch;
  requireClosedVocabulary(
    cooldown.kind,
    DISPATCH_COOLDOWN_KINDS,
    "progress.cooldownAtDispatch.kind",
  );
  if (cooldown.kind === "active") {
    requireClosedVocabulary(
      cooldown.failureClass,
      OUTCOME_FAILURE_CLASSES,
      "progress.cooldownAtDispatch.failureClass",
    );
    require_(
      Number.isFinite(cooldown.remainingMs) &&
        cooldown.remainingMs >= 0 &&
        cooldown.remainingMs <= MAX_LATENCY_MS,
      "outcomeLatencyFacts.progress.cooldownAtDispatch.remainingMs must be a finite number in bounds",
    );
  }
  return {
    mode: input.mode,
    ...(input.pollingInterval === undefined || input.pollingInterval === null
      ? {}
      : { pollingInterval: input.pollingInterval }),
    cooldownAtDispatch: cooldown,
  };
}

/** Construct the verification proof (fail-closed; references >= 1, duplicate-free). */
export function verificationProofOf(
  proof:
    | {
        readonly kind: "proved";
        readonly outcome: VerificationProofOutcome;
        readonly resultIds: readonly string[];
      }
    | {
        readonly kind: "not-run";
        readonly owner: string;
      },
): VerificationProof {
  if (proof.kind === "proved") {
    requireClosedVocabulary(proof.outcome, VERIFICATION_PROOF_OUTCOMES, "verification.outcome");
    require_(
      proof.resultIds.length > 0,
      "verification.resultIds must reference at least one result",
    );
    require_(
      proof.resultIds.length <= MAX_VERIFICATION_RESULT_REFS,
      "verification.resultIds must hold at most 100 references (bounded)",
    );
    require_(
      new Set(proof.resultIds).size === proof.resultIds.length,
      "verification.resultIds must not contain duplicates",
    );
    for (const resultId of proof.resultIds) {
      requireBoundedIdentity(resultId, "verification.resultIds entry");
    }
    return { kind: "proved", outcome: proof.outcome, resultIds: [...proof.resultIds] };
  }
  requireBoundedText(proof.owner, "verification.owner", ATTRIBUTION_SOURCE_MAX);
  return { kind: "not-run", owner: proof.owner };
}

/**
 * Construct the closed outcome-latency fact block (fail-closed on every
 * law): closed vocabularies, bounded legs (duplicate-free), the census
 * reconciliation, the outcome-class/census agreement (the plain
 * meanings of the closed classes), the resolution/outcome-class
 * agreement (no failure hiding), the explicit basis (required).
 */
export function outcomeLatencyFactsOf(input: {
  readonly outcomeClass: OutcomeClass;
  readonly legs: readonly OutcomeLatencyLeg[];
  readonly attemptCensus: AttemptCensus;
  readonly progress: ProgressDeliveryFacts;
  readonly cost: {
    readonly totalIncludingDuplicates: CostLine;
    readonly verification: CostLine;
  };
  readonly resolved: boolean;
  readonly verification: VerificationProof;
  readonly basis: OutcomeLatencyBasis;
}): OutcomeLatencyFacts {
  requireClosedVocabulary(input.outcomeClass, OUTCOME_CLASSES, "outcomeClass");
  require_(
    input.legs.length <= MAX_LEGS,
    `outcomeLatencyFacts.legs must hold at most ${MAX_LEGS} legs`,
  );
  const seen = new Set<string>();
  for (const leg of input.legs) {
    require_(
      !seen.has(leg.legId),
      `outcomeLatencyFacts.legs must not contain duplicate legId: ${leg.legId}`,
    );
    seen.add(leg.legId);
  }
  const census = input.attemptCensus;
  require_(
    census.attempts === census.original + census.retry + census.fallback + census.verification,
    "outcomeLatencyFacts.attemptCensus.attempts must equal original + retry + fallback + verification (the exact outcome-census reconciliation — no failure hiding)",
  );
  if (input.outcomeClass === "succeeded-first-attempt") {
    require_(
      census.retry === 0 && census.fallback === 0,
      "outcomeLatencyFacts.outcomeClass succeeded-first-attempt is incoherent with the attempt census (retry and fallback must be 0)",
    );
  } else if (input.outcomeClass === "succeeded-after-retry") {
    require_(
      census.retry >= 1 && census.fallback === 0,
      "outcomeLatencyFacts.outcomeClass succeeded-after-retry is incoherent with the attempt census (retry must be >= 1 and fallback must be 0)",
    );
  } else if (input.outcomeClass === "succeeded-on-fallback") {
    require_(
      census.fallback >= 1,
      "outcomeLatencyFacts.outcomeClass succeeded-on-fallback is incoherent with the attempt census (fallback must be >= 1)",
    );
  }
  if (input.outcomeClass !== "failed-terminal") {
    require_(
      input.resolved === true,
      `outcomeLatencyFacts.resolved is incoherent with outcomeClass ${input.outcomeClass} (a succeeded outcome records resolved=true)`,
    );
  } else {
    require_(
      input.resolved === false,
      "outcomeLatencyFacts.resolved is incoherent with outcomeClass failed-terminal (a terminal failure never records resolved — no failure hiding)",
    );
  }
  requireBoundedIdentity(input.basis.executionId, "basis.executionId");
  requireRouteSlug(input.basis.route.provider, "basis.route.provider");
  requireRouteSlug(input.basis.route.model, "basis.route.model");
  require_(
    Number.isInteger(input.basis.revision) &&
      input.basis.revision >= 0 &&
      input.basis.revision <= MAX_PLAN_REVISION,
    "outcomeLatencyFacts.basis.revision must be an integer in [0, 2^31 - 1]",
  );
  requireClosedVocabulary(input.basis.clockDiscipline, CLOCK_DISCIPLINES, "basis.clockDiscipline");
  return {
    outcomeClass: input.outcomeClass,
    legs: [...input.legs],
    attemptCensus: census,
    progress: input.progress,
    cost: {
      totalIncludingDuplicates: input.cost.totalIncludingDuplicates,
      verification: input.cost.verification,
    },
    resolved: input.resolved,
    verification: input.verification,
    basis: input.basis,
  };
}

// ---------------------------------------------------------------------------
// The canonical serialization + content addressing (mirrored byte-for-
// byte from the authority's own canonical form — pinned in-suite)
// ---------------------------------------------------------------------------

/** Code-unit ordering (deterministic across environments — never locale-dependent). */
function byCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Recursively canonicalize: sorted keys at every depth; undefined and
 * null values are BOTH the absent spelling and render as key-omission;
 * arrays keep their element kinds.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .filter((key) => record[key] !== undefined && record[key] !== null)
      .sort()
      .map((key) => [key, canonical(record[key])]);
  }
  return value;
}

function canonicalVerificationProof(proof: VerificationProof): unknown {
  return proof.kind === "proved"
    ? { ...proof, resultIds: [...proof.resultIds].sort(byCodeUnitOrder) }
    : { ...proof };
}

/**
 * Deterministic canonical JSON of the fact block — the authority's own
 * tagged-tuple form (legs sorted by legId; verification references
 * sorted; nested objects as sorted-key pair arrays with absence as
 * key-omission). Pinned byte-for-byte in-suite against the REAL
 * `canonicalOutcomeLatencyJson`.
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
 * correlation: the INJECTED digest over the canonical form (never
 * ambient, never module-owned).
 */
export function outcomeLatencyFactsIdentity(
  facts: OutcomeLatencyFacts,
  digest: (canonical: string) => string,
): string {
  return digest(canonicalOutcomeLatencyJson(facts));
}
