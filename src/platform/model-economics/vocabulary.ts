/**
 * The closed vocabularies and typed candidate shapes of the
 * model-economics plane (platform model-economics plane; WORK-053 /
 * E1.1 charter wave member 3 — ADR-0019 §8, ADR-0020).
 *
 * This plane is the E1.1 stage the WORK-050 compiler explicitly
 * anticipated ("the claims are explicit INPUTS — later E1.1 stages wire
 * observed/estimated derivation from real telemetry; live
 * model/provider/effort selection is a later E1.1 stage"): the
 * OFFLINE, DETERMINISTIC decision machinery that selects, among
 * DECLARED candidates carrying explicit-basis claims, the least
 * expensive SUFFICIENT model route, reasoning-effort level, agent
 * strategy (the 0/1/N gate), substrate service class — and RECORDS
 * when escalation-to-fresh-context is economically justified.
 *
 * Non-negotiable properties (WORK-053 architecture invariants):
 *
 *  - NO ROUTING AUTHORITY (invariant 7): this plane is decision
 *    EVIDENCE. It selects among CALLER-DECLARED candidates by pure
 *    functions of (plan IR facts, candidate facts, quality facts,
 *    constraints) and produces typed decision values + WORK-049
 *    decision records; there is no router, no provider registry of
 *    authority, no ambient model state, and no runtime authorization
 *    path consults anything this plane produces;
 *  - QUALITY FLOORS ARE INVIOLABLE (invariant 8): a candidate below
 *    the required outcome quality is INADMISSIBLE regardless of cost —
 *    never merely more expensive;
 *  - EXPLICIT-BASE CONTRACT (invariant 3): every cost/quality/latency
 *    claim is bounded and attributed (the WORK-049 estimation-basis
 *    contract, enforced by the foundation's `validateCostClaim`);
 *  - DETERMINISM (invariant 5): every value here is a pure function of
 *    its inputs — no clock, no randomness, no ambient state; the
 *    `recordedAt` of any decision record is an explicit INPUT;
 *  - FAIL CLOSED: unmet preconditions are typed, bounded rejections
 *    over the closed invariant vocabulary below — never silent
 *    defaults.
 *
 * Vendor neutrality: every vocabulary here is neutral. Model routes
 * are provider-NEUTRAL opaque strings exactly like the IR's
 * `routeRef`; effort levels, service classes and gate modes are
 * neutral platform vocabulary.
 */

import type { CostClaim } from "../execution-ir/cost-model";
import { validateCostClaim } from "../execution-ir/cost-model";

// ---------------------------------------------------------------------------
// The closed invariant vocabulary (typed, bounded, fail-closed)
// ---------------------------------------------------------------------------

/**
 * The closed model-economics failure vocabulary. Each code is a typed,
 * bounded, fail-closed rejection:
 *
 *  - `candidate-shape` — a candidate failed its total validation
 *    (slug, route shape, class family, effort/service vocabulary);
 *  - `claim-invalid` — a candidate's cost claim failed the WORK-049
 *    estimation-basis contract (wrapped, never bypassed);
 *  - `gate-shape` — the 0/1/N gate input is structurally invalid
 *    (missing one-agent anchor, N-candidate count bounds, economics
 *    shape);
 *  - `economics-invalid` — the agent-gate economics inputs are invalid
 *    (unbounded money, negative value inputs where impossible);
 *  - `step-not-generative` — model/effort selection was requested for
 *    a step that is not a model-selection point (generative step
 *    classes only);
 *  - `step-not-found` — the referenced step does not exist in the IR;
 *  - `escalation-shape` — the fresh-escalation hook input is invalid;
 *  - `decision-invalid` — a WORK-049 decision record failed its own
 *    total validation (fail closed — never emitted unvalidated);
 *  - `claim-overflow` — bounded arithmetic overflow (never a silent
 *    infinity).
 */
export const MODEL_ECONOMICS_INVARIANT_CODES = [
  "candidate-shape",
  "claim-invalid",
  "gate-shape",
  "economics-invalid",
  "step-not-generative",
  "step-not-found",
  "escalation-shape",
  "decision-invalid",
  "claim-overflow",
] as const;
export type ModelEconomicsInvariantCode = (typeof MODEL_ECONOMICS_INVARIANT_CODES)[number];

/** The typed, bounded model-economics error. */
export class ModelEconomicsError extends Error {
  readonly invariant: ModelEconomicsInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: ModelEconomicsInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "ModelEconomicsError";
    this.invariant = invariant;
    const boundedDetails: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
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
  invariant: ModelEconomicsInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new ModelEconomicsError(invariant, message, details);
}

// ---------------------------------------------------------------------------
// Neutral candidate vocabularies (closed)
// ---------------------------------------------------------------------------

/**
 * The closed reasoning-effort vocabulary (neutral — the "higher
 * reasoning effort" ladder rung of the E1.1 charter). Order IS the
 * canonical effort rank: lower effort is the cheaper-path default;
 * ties on cost break toward LOWER effort.
 */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "maximum"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** The canonical effort rank (lower = cheaper-in-effort first). */
export function effortLadderRank(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level);
}

/**
 * The closed substrate service-class vocabulary (neutral — the
 * "alternative inference/service tier" rung of ADR-0020). Order IS the
 * canonical service-class rank: economy first (the cheaper-path
 * default); ties on cost break toward the cheaper class.
 */
export const SERVICE_CLASSES = ["economy", "standard", "priority"] as const;
export type ServiceClass = (typeof SERVICE_CLASSES)[number];

/** The canonical service-class rank (lower = cheaper-in-class first). */
export function serviceClassRank(serviceClass: ServiceClass): number {
  return SERVICE_CLASSES.indexOf(serviceClass);
}

/** The representation classes legal for a model-route candidate. */
export const MODEL_CANDIDATE_CLASSES = ["sufficient-model", "stronger-model"] as const;
export type ModelCandidateClass = (typeof MODEL_CANDIDATE_CLASSES)[number];

/**
 * The 0/1/N agent-gate modes (the gate vocabulary — neutral). The gate
 * selects exactly one mode per decision; "n-agent" is NEVER a default
 * (architecture invariant 2: it requires positive expected
 * quality-gain evidence).
 */
export const AGENT_GATE_MODES = ["zero-agent", "one-agent", "n-agent"] as const;
export type AgentGateMode = (typeof AGENT_GATE_MODES)[number];

/**
 * The closed gate-mode → representation-class families. A zero-agent
 * strategy is a deterministic-family representation (the cheaper
 * rungs); a one-agent strategy is a single model invocation; an
 * n-agent strategy is the canonical `parallel-multi-agent` rung.
 */
export const ZERO_AGENT_CLASSES = [
  "deterministic-computation",
  "cache-reuse",
  "verified-competence",
  "programmatic-execution",
] as const;
export type ZeroAgentClass = (typeof ZERO_AGENT_CLASSES)[number];

export const ONE_AGENT_CLASSES = ["sufficient-model", "stronger-model"] as const;
export type OneAgentClass = (typeof ONE_AGENT_CLASSES)[number];

export const N_AGENT_CLASS = "parallel-multi-agent" as const;

/** The hard upper bound on an n-agent candidate's agent count. */
export const MAX_AGENT_COUNT = 256;

// ---------------------------------------------------------------------------
// Bounded money convention (integer micro-USD — the platform convention)
// ---------------------------------------------------------------------------

/** The bounded money universe for model-economics arithmetic (micro-USD). */
export const MAX_MODEL_ECONOMICS_MICRO_USD = "999999999999999999";
const MAX_MONEY_BIGINT = 999999999999999999n;
const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

/**
 * Parse a bounded integer micro-USD string (the platform money
 * convention — the same universe the WORK-049 cost model pins).
 * Rejects unbounded or malformed values (typed, fail closed).
 */
export function parseBoundedMicroUsd(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !MICRO_USD_PATTERN.test(value)) {
    reject("claim-overflow", `${what} must be an integer micro-USD string in [0, 10^18)`, {
      got: bounded(value),
    });
  }
  const parsed = BigInt(value);
  if (parsed > MAX_MONEY_BIGINT) {
    reject("claim-overflow", `${what} exceeds the bounded money universe`, {
      got: bounded(value),
    });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Quality facts (the requirement side of every selection)
// ---------------------------------------------------------------------------

/**
 * The quality facts of a selection: the REQUIRED outcome quality (the
 * assurance floor from the Work Order's assurance profile — a HARD
 * constraint: candidates below it are inadmissible regardless of
 * cost). Hard quality constraints in the governing set may raise the
 * effective floor; they can never lower it.
 */
export interface QualityFacts {
  /** The required outcome quality — the inviolable assurance floor. */
  readonly requiredQuality: number;
}

/** Total, deterministic validation of the quality facts. */
export function validateQualityFacts(value: unknown): QualityFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "quality facts must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.requiredQuality !== "number" ||
    !Number.isFinite(record.requiredQuality) ||
    record.requiredQuality < 0 ||
    record.requiredQuality > 1
  ) {
    reject("candidate-shape", "requiredQuality must be a probability in [0, 1]", {
      got: bounded(record.requiredQuality),
    });
  }
  return { requiredQuality: record.requiredQuality };
}

// ---------------------------------------------------------------------------
// Shared candidate fields (slug, route, claim discipline)
// ---------------------------------------------------------------------------

const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROUTE_PART_MAX = 200;
const ROUTE_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const DESCRIPTION_MAX = 500;

/**
 * A provider-NEUTRAL route reference (the IR's `routeRef` convention:
 * opaque strings; no vendor semantics may attach here).
 */
export interface NeutralRouteRef {
  readonly provider: string;
  readonly model: string;
}

function validateRoute(route: unknown, what: string): NeutralRouteRef {
  if (typeof route !== "object" || route === null || Array.isArray(route)) {
    reject("candidate-shape", `${what} route must be an object`);
  }
  const record = route as Record<string, unknown>;
  for (const part of ["provider", "model"] as const) {
    if (
      typeof record[part] !== "string" ||
      !ROUTE_PART_PATTERN.test(record[part] as string) ||
      (record[part] as string).length > ROUTE_PART_MAX
    ) {
      reject("candidate-shape", `${what} route ${part} must be a bounded neutral slug`, {
        got: bounded(record[part]),
      });
    }
  }
  return { provider: record.provider as string, model: record.model as string };
}

function validateDescription(description: unknown, what: string): string | undefined {
  if (description === undefined) {
    return undefined;
  }
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > DESCRIPTION_MAX
  ) {
    reject("candidate-shape", `${what} description must be bounded non-empty text when present`);
  }
  return description;
}

/**
 * Validate a candidate's cost claim through the WORK-049
 * estimation-basis contract (bounded + attributed or the claim does
 * not exist — the foundation's typed rejection wrapped into this
 * plane's closed vocabulary).
 */
export function claimOf(value: unknown, what: string): CostClaim {
  try {
    return validateCostClaim(value);
  } catch (error) {
    reject("claim-invalid", `${what} failed the estimation-basis contract (bounded, attributed)`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateCandidateId(candidateId: unknown, what: string): string {
  if (typeof candidateId !== "string" || !CANDIDATE_ID.test(candidateId)) {
    reject("candidate-shape", `${what} candidateId must be a lowercase slug`, {
      got: bounded(candidateId),
    });
  }
  return candidateId;
}

// ---------------------------------------------------------------------------
// Model candidates (quality-aware model selection)
// ---------------------------------------------------------------------------

/**
 * A declared model-route candidate: one point in the model-selection
 * search space. The claim carries the explicit-basis expectations;
 * the route is provider-neutral (opaque strings, exactly like the
 * governed plan's own routeRef).
 */
export interface ModelCandidate {
  readonly candidateId: string;
  readonly route: NeutralRouteRef;
  readonly representationClass: ModelCandidateClass;
  readonly description?: string;
  readonly claim: CostClaim;
}

/** Total, deterministic validation of a model candidate. */
export function validateModelCandidate(value: unknown): ModelCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "model candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "model candidate");
  const route = validateRoute(record.route, `model candidate ${candidateId}`);
  if (
    typeof record.representationClass !== "string" ||
    !(MODEL_CANDIDATE_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject("candidate-shape", "model candidate representationClass is outside the model family", {
      got: bounded(record.representationClass),
    });
  }
  const description = validateDescription(record.description, `model candidate ${candidateId}`);
  const claim = claimOf(record.claim, `model candidate ${candidateId}`);
  return {
    candidateId,
    route,
    representationClass: record.representationClass as ModelCandidateClass,
    ...(description === undefined ? {} : { description }),
    claim,
  };
}

// ---------------------------------------------------------------------------
// Effort candidates (reasoning-effort selection)
// ---------------------------------------------------------------------------

/**
 * A declared reasoning-effort candidate for one generative step: the
 * same explicit-basis economics over the effort dimension (the
 * charter's "higher reasoning effort" rung). No route — effort refines
 * the model invocation the step already carries.
 */
export interface EffortCandidate {
  readonly candidateId: string;
  readonly effort: EffortLevel;
  readonly representationClass: ModelCandidateClass;
  readonly description?: string;
  readonly claim: CostClaim;
}

/** Total, deterministic validation of an effort candidate. */
export function validateEffortCandidate(value: unknown): EffortCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "effort candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "effort candidate");
  if (
    typeof record.effort !== "string" ||
    !(EFFORT_LEVELS as readonly string[]).includes(record.effort)
  ) {
    reject("candidate-shape", "effort candidate effort is outside the closed effort vocabulary", {
      got: bounded(record.effort),
    });
  }
  if (
    typeof record.representationClass !== "string" ||
    !(MODEL_CANDIDATE_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject("candidate-shape", "effort candidate representationClass is outside the model family", {
      got: bounded(record.representationClass),
    });
  }
  const description = validateDescription(record.description, `effort candidate ${candidateId}`);
  const claim = claimOf(record.claim, `effort candidate ${candidateId}`);
  return {
    candidateId,
    effort: record.effort as EffortLevel,
    representationClass: record.representationClass as ModelCandidateClass,
    ...(description === undefined ? {} : { description }),
    claim,
  };
}

// ---------------------------------------------------------------------------
// The agent-gate candidates (the 0/1/N gate)
// ---------------------------------------------------------------------------

/**
 * The explicit-basis expected-gain claim an n-agent strategy MUST
 * carry (architecture invariant 2: N requires positive expected
 * quality-gain evidence — an n-agent candidate without a gain claim
 * is unrepresentable, and one whose net gain is not positive is
 * inadmissible, never enthusiastically applied).
 */
export interface AgentGainClaim {
  /**
   * The expected quality gain attributable to the N-agent strategy —
   * STRICTLY positive, in (0, 1]. Unattributed or zero gains make N
   * impossible (always-on N is impossible by construction).
   */
  readonly expectedQualityGain: number;
  /**
   * The expected verification burden of the parallel strategy (judging
   * / voting / converging N parallel results) — bounded integer
   * micro-USD, ≥ 0, explicit basis.
   */
  readonly expectedVerificationBurdenMicroUsd: string;
  /** The parallelism width — an integer in [2, MAX_AGENT_COUNT]. */
  readonly agentCount: number;
  /** REQUIRED explicit estimation basis (unattributed gains are rejected). */
  readonly basis: {
    readonly basis: "observed" | "estimated" | "defaulted";
    readonly source: string;
    readonly evidenceDigest?: string;
  };
}

/** Total, deterministic validation of an agent gain claim. */
export function validateAgentGainClaim(value: unknown): AgentGainClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("gate-shape", "agent gain claim must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedQualityGain = record.expectedQualityGain;
  if (
    typeof expectedQualityGain !== "number" ||
    !Number.isFinite(expectedQualityGain) ||
    expectedQualityGain <= 0 ||
    expectedQualityGain > 1
  ) {
    reject(
      "gate-shape",
      "agent gain expectedQualityGain must be in (0, 1] — N requires positive evidence",
      {
        got: bounded(expectedQualityGain),
      },
    );
  }
  // Bounded money discipline (≥ 0): parse and re-stringify.
  const burden = parseBoundedMicroUsd(
    record.expectedVerificationBurdenMicroUsd,
    "agent gain expectedVerificationBurdenMicroUsd",
  );
  const agentCount = record.agentCount;
  if (
    typeof agentCount !== "number" ||
    !Number.isInteger(agentCount) ||
    agentCount < 2 ||
    agentCount > MAX_AGENT_COUNT
  ) {
    reject("gate-shape", "agent gain agentCount must be an integer in [2, MAX_AGENT_COUNT]", {
      got: bounded(agentCount),
    });
  }
  const basis = record.basis;
  if (typeof basis !== "object" || basis === null || Array.isArray(basis)) {
    reject("gate-shape", "agent gain claim must carry an estimation basis");
  }
  const basisRecord = basis as Record<string, unknown>;
  if (
    typeof basisRecord.basis !== "string" ||
    !["observed", "estimated", "defaulted"].includes(basisRecord.basis)
  ) {
    reject("gate-shape", "agent gain basis is outside the closed estimation vocabulary", {
      got: bounded(basisRecord.basis),
    });
  }
  if (
    typeof basisRecord.source !== "string" ||
    basisRecord.source.length === 0 ||
    basisRecord.source.length > 200
  ) {
    reject("gate-shape", "agent gain basis source must be a bounded non-empty string", {
      got: bounded(basisRecord.source),
    });
  }
  if (
    basisRecord.evidenceDigest !== undefined &&
    (typeof basisRecord.evidenceDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(basisRecord.evidenceDigest))
  ) {
    reject("gate-shape", "agent gain basis evidenceDigest must be a sha256 hex digest");
  }
  return {
    expectedQualityGain,
    expectedVerificationBurdenMicroUsd: burden.toString(),
    agentCount,
    basis: {
      basis: basisRecord.basis as AgentGainClaim["basis"]["basis"],
      source: basisRecord.source as string,
      ...(basisRecord.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: basisRecord.evidenceDigest as string }),
    },
  };
}

/**
 * A zero-agent candidate: a deterministic-family representation of
 * the step's outcome (the cheapest rungs of the ladder — no live
 * agent). No route, no gain claim — deterministic paths carry their
 * plain explicit-basis claims.
 */
export interface ZeroAgentCandidate {
  readonly candidateId: string;
  readonly representationClass: ZeroAgentClass;
  readonly description?: string;
  readonly claim: CostClaim;
}

/** Total, deterministic validation of a zero-agent candidate. */
export function validateZeroAgentCandidate(value: unknown): ZeroAgentCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "zero-agent candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "zero-agent candidate");
  if (
    typeof record.representationClass !== "string" ||
    !(ZERO_AGENT_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject("candidate-shape", "zero-agent candidate class is outside the deterministic family", {
      got: bounded(record.representationClass),
    });
  }
  const description = validateDescription(
    record.description,
    `zero-agent candidate ${candidateId}`,
  );
  const claim = claimOf(record.claim, `zero-agent candidate ${candidateId}`);
  return {
    candidateId,
    representationClass: record.representationClass as ZeroAgentClass,
    ...(description === undefined ? {} : { description }),
    claim,
  };
}

/**
 * A one-agent candidate: a single model invocation (the default
 * single-agent path). The route is optional — the caller may bind the
 * route through the planner's own authority.
 */
export interface OneAgentCandidate {
  readonly candidateId: string;
  readonly route?: NeutralRouteRef;
  readonly representationClass: OneAgentClass;
  readonly description?: string;
  readonly claim: CostClaim;
}

/** Total, deterministic validation of a one-agent candidate. */
export function validateOneAgentCandidate(value: unknown): OneAgentCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "one-agent candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "one-agent candidate");
  const route =
    record.route === undefined
      ? undefined
      : validateRoute(record.route, `one-agent candidate ${candidateId}`);
  if (
    typeof record.representationClass !== "string" ||
    !(ONE_AGENT_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject("candidate-shape", "one-agent candidate class is outside the single-model family", {
      got: bounded(record.representationClass),
    });
  }
  const description = validateDescription(record.description, `one-agent candidate ${candidateId}`);
  const claim = claimOf(record.claim, `one-agent candidate ${candidateId}`);
  return {
    candidateId,
    ...(route === undefined ? {} : { route }),
    representationClass: record.representationClass as OneAgentClass,
    ...(description === undefined ? {} : { description }),
    claim,
  };
}

/**
 * An n-agent candidate: the deliberate parallelism strategy (the
 * canonical `parallel-multi-agent` rung). MUST carry the gain claim —
 * the evidence that justifies its premium.
 */
export interface NAgentCandidate {
  readonly candidateId: string;
  readonly route?: NeutralRouteRef;
  readonly description?: string;
  readonly claim: CostClaim;
  readonly gain: AgentGainClaim;
}

/** Total, deterministic validation of an n-agent candidate. */
export function validateNAgentCandidate(value: unknown): NAgentCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "n-agent candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "n-agent candidate");
  const route =
    record.route === undefined
      ? undefined
      : validateRoute(record.route, `n-agent candidate ${candidateId}`);
  const description = validateDescription(record.description, `n-agent candidate ${candidateId}`);
  const claim = claimOf(record.claim, `n-agent candidate ${candidateId}`);
  const gain = validateAgentGainClaim(record.gain);
  return {
    candidateId,
    ...(route === undefined ? {} : { route }),
    ...(description === undefined ? {} : { description }),
    claim,
    gain,
  };
}

// ---------------------------------------------------------------------------
// Service-class candidates (hooks only)
// ---------------------------------------------------------------------------

/**
 * A declared substrate service-class candidate (the "alternative
 * inference/service tier" rung — HOOKS ONLY: the selection is a typed
 * decision value for the substrate adapters to consume; no live tier
 * call exists here).
 */
export interface ServiceClassCandidate {
  readonly candidateId: string;
  readonly serviceClass: ServiceClass;
  readonly representationClass: ModelCandidateClass;
  readonly description?: string;
  readonly claim: CostClaim;
}

/** Total, deterministic validation of a service-class candidate. */
export function validateServiceClassCandidate(value: unknown): ServiceClassCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "service-class candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const candidateId = validateCandidateId(record.candidateId, "service-class candidate");
  if (
    typeof record.serviceClass !== "string" ||
    !(SERVICE_CLASSES as readonly string[]).includes(record.serviceClass)
  ) {
    reject("candidate-shape", "service-class candidate class is outside the closed vocabulary", {
      got: bounded(record.serviceClass),
    });
  }
  if (
    typeof record.representationClass !== "string" ||
    !(MODEL_CANDIDATE_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject(
      "candidate-shape",
      "service-class candidate representationClass is outside the model family",
      { got: bounded(record.representationClass) },
    );
  }
  const description = validateDescription(
    record.description,
    `service-class candidate ${candidateId}`,
  );
  const claim = claimOf(record.claim, `service-class candidate ${candidateId}`);
  return {
    candidateId,
    serviceClass: record.serviceClass as ServiceClass,
    representationClass: record.representationClass as ModelCandidateClass,
    ...(description === undefined ? {} : { description }),
    claim,
  };
}

// ---------------------------------------------------------------------------
// The agent-gate economics (the typed exchange-rate inputs)
// ---------------------------------------------------------------------------

/**
 * The bounded, typed economics of the agent gate — the EXPLICIT
 * exchange rates that make quality gain, cost, latency and
 * verification burden commensurable in integer micro-USD arithmetic.
 * These are CALLER-DECLARED facts (the operator's economics), never
 * ambient state.
 */
export interface AgentGateEconomics {
  /**
   * The money value of +1.0 expected quality — bounded integer
   * micro-USD. The value of a claimed gain is
   * `ceil(qualityValueMicroUsd × expectedQualityGain)`.
   */
  readonly qualityValueMicroUsd: string;
  /**
   * The money value of one millisecond of latency — bounded integer
   * micro-USD per ms. Optional; defaults to 0 (latency then matters
   * only through the hard latency ceilings). Signed: a parallel
   * latency BENEFIT offsets cost.
   */
  readonly latencyValueMicroUsdPerMs?: string;
}

/** Total, deterministic validation of the agent-gate economics. */
export function validateAgentGateEconomics(value: unknown): AgentGateEconomics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("economics-invalid", "agent gate economics must be an object");
  }
  const record = value as Record<string, unknown>;
  const qualityValue = parseBoundedMicroUsd(
    record.qualityValueMicroUsd,
    "economics qualityValueMicroUsd",
  );
  if (record.latencyValueMicroUsdPerMs !== undefined) {
    const latencyValue = parseBoundedMicroUsd(
      record.latencyValueMicroUsdPerMs,
      "economics latencyValueMicroUsdPerMs",
    );
    return {
      qualityValueMicroUsd: qualityValue.toString(),
      latencyValueMicroUsdPerMs: latencyValue.toString(),
    };
  }
  return { qualityValueMicroUsd: qualityValue.toString() };
}
