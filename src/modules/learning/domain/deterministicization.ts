/**
 * The deterministicization lifecycle domain (learning module domain;
 * WORK-021 / DTR-001..DTR-004, ADR-0008,
 * `spec/deterministicization-contract.md`).
 *
 * THE OBSERVED → VALIDATED → GOVERNED LIFECYCLE RECORD MODEL:
 *
 * ```text
 *   observed execution telemetry (WORK-014, immutable)
 *     → discovery: recurring AI subgraphs (DTR-001 — pure mining)
 *     → candidate: a proposed deterministic/hybrid replacement with an
 *       EXPLICIT contract and FULL provenance to the source executions
 *       and the evaluation corpus (identity = content digest)
 *     → validation evidence: offline replay / differential evaluation /
 *       property+metamorphic tests / mutation evidence (DTR-002) —
 *       immutable, one settled record per stage per candidate
 *     → rollout: shadow, then canary, with MEASURABLE cost/quality
 *       deltas (DTR-003)
 *     → decision: promoted | rejected | deferred | rolled-back — every
 *       one recorded WITH rationale (DTR-004)
 *     → rollback: an append-only decision that restores the incumbent
 *       implementation; execution identity is NEVER touched
 * ```
 *
 * PROVENANCE IS IDENTITY (the contract's implementation requirement):
 * a candidate without provenance to its source executions and
 * evaluation corpus is UNREPRESENTABLE — `provenance.sourceExecutionIds`
 * and `provenance.corpusDigest` are MANDATORY and fail-closed here
 * (D-probe: the candidate registration rejects a provenance-less draft).
 *
 * LEARNING-NONAUTHORITY (the frozen §10 invariant, preserved): this
 * file records LIFECYCLE EVIDENCE AND DECISIONS ONLY. The candidate's
 * replacement program is executed by the composition through the tools
 * module's sandbox-executor seam (WORK-018 pattern; the sandbox
 * admission chain — policy/capability/budget — stays THE authority);
 * learning itself never dispatches anything, never mutates planner or
 * execution state, and every record here is advisory evidence plus a
 * governed rollout journal. "Without changing execution identity"
 * (DTR-003) is structural: no field of any record below can carry an
 * execution-state mutation — the incumbent binding is a DESCRIPTION,
 * never a state write.
 *
 * This file is pure domain: no side effects, imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";

/** Frozen deterministicization record schema version. */
export const DETERMINISTICIZATION_SCHEMA_VERSION = 1;

/**
 * The five candidate classes of the deterministicization contract
 * (`spec/deterministicization-contract.md` "Candidate classes").
 */
export const DETERMINISTICIZATION_CANDIDATE_CLASSES = [
  /** A complete AI call that can be removed. */
  "removal",
  /** An AI call replaced by a deterministic function or algorithm. */
  "deterministic-replacement",
  /** Deterministic preprocessing plus residual AI reasoning. */
  "hybrid-split",
  /** An AI subgraph replaced by a retrieval/database/program pipeline. */
  "pipeline-replacement",
  /** A repeated normalization/classification/transformation step for a
   * reusable tool. */
  "tool-extraction",
] as const;

export type DeterministicizationCandidateClass =
  (typeof DETERMINISTICIZATION_CANDIDATE_CLASSES)[number];

export function isDeterministicizationCandidateClass(
  value: string,
): value is DeterministicizationCandidateClass {
  return (DETERMINISTICIZATION_CANDIDATE_CLASSES as readonly string[]).includes(value);
}

/**
 * The candidate lifecycle states. The offline validation stages move
 * `proposed → validating → validated`; the rollout stages move
 * `validated → shadow → canary`; the governed decisions move
 * `canary → promoted` and `promoted → rolled-back`; `rejected` is
 * terminal, `deferred` waits for more evidence (re-enterable).
 */
export const DETERMINISTICIZATION_CANDIDATE_STATUSES = [
  "proposed",
  "validating",
  "validated",
  "shadow",
  "canary",
  "promoted",
  "rejected",
  "deferred",
  "rolled-back",
] as const;

export type DeterministicizationCandidateStatus =
  (typeof DETERMINISTICIZATION_CANDIDATE_STATUSES)[number];

export function isDeterministicizationCandidateStatus(
  value: string,
): value is DeterministicizationCandidateStatus {
  return (DETERMINISTICIZATION_CANDIDATE_STATUSES as readonly string[]).includes(value);
}

/** The guarded candidate status machine (single-step forward only). */
export const CANDIDATE_STATUS_TRANSITIONS: Readonly<
  Record<DeterministicizationCandidateStatus, readonly DeterministicizationCandidateStatus[]>
> = {
  proposed: ["validating", "rejected", "deferred"],
  validating: ["validating", "validated", "rejected", "deferred"],
  validated: ["shadow", "rejected", "deferred"],
  shadow: ["canary", "rejected", "deferred"],
  canary: ["promoted", "rejected", "deferred"],
  promoted: ["rolled-back"],
  rejected: [],
  deferred: ["validating", "rejected"],
  "rolled-back": ["shadow", "rejected", "deferred"],
};

/** The closed field-type vocabulary of a replacement contract. */
export const REPLACEMENT_FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;

export type ReplacementFieldType = (typeof REPLACEMENT_FIELD_TYPES)[number];

/** One declared field of the replacement contract (closed schema). */
export interface ReplacementFieldSchema {
  readonly name: string;
  readonly type: ReplacementFieldType;
  readonly required: boolean;
}

/**
 * The EXPLICIT differential acceptance criterion (the contract's
 * "Differential requirement": equality is not required, but the
 * criterion must be explicit and verified).
 */
export interface ReplacementAcceptanceCriterion {
  readonly kind: "exact-output" | "tolerated-field-delta";
  /** The explicit human statement of what "accepted" means. */
  readonly description: string;
  /** For `tolerated-field-delta`: the fields allowed to differ. */
  readonly toleratedFields?: readonly string[];
}

/**
 * The explicit replacement contract every candidate MUST carry
 * (acceptance criterion 2: "explicit contracts").
 */
export interface ReplacementContract {
  readonly inputFields: readonly ReplacementFieldSchema[];
  readonly outputFields: readonly ReplacementFieldSchema[];
  readonly acceptanceCriterion: ReplacementAcceptanceCriterion;
  /**
   * The declared compute confinement basis (the substrate half of the
   * contract — the executor refuses before dispatch when the declared
   * egress exceeds the environment's grants).
   */
  readonly compute: {
    readonly pureComputeOnly: true;
    readonly networkEgress: "none" | "allowlist";
    readonly allowedHosts: readonly string[];
    readonly timeoutMs: number;
  };
}

/** The incumbent AI implementation being replaced (differential baseline). */
export interface IncumbentBinding {
  /** Strategy class of the incumbent plan implementation. */
  readonly strategyClass: string;
  /** The incumbent's neutral route subjects (opaque strings). */
  readonly routes: readonly { readonly provider: string; readonly model: string }[];
  /** sha256 digest of the incumbent implementation description. */
  readonly descriptionDigest: string;
  /**
   * The deterministic rollback target: the incumbent stays the
   * canonical implementation until promotion, and rollback restores it
   * (recorded here — a DESCRIPTION, never an execution-state write).
   */
  readonly rollbackTarget: string;
}

/** The subgraph anchor: WHO the candidate replaces, provenance-bound. */
export interface CandidateSubgraphAnchor {
  readonly subgraphId: string;
  readonly stepPath: readonly string[];
  /** The observed computation type (generative for AI work — DTR-001). */
  readonly computationType: string;
  readonly taskClass: string;
  /** The neutral route subjects observed on the subgraph (opaque). */
  readonly routes: readonly { readonly provider: string; readonly model: string }[];
  /** The tool identities observed on the subgraph (opaque). */
  readonly tools: readonly string[];
}

/**
 * Provenance to the source executions and evaluation corpus —
 * MANDATORY (the work order's implementation requirement: "candidate
 * identity must include provenance to source executions and evaluation
 * corpus").
 */
export interface CandidateProvenance {
  /** The executions whose telemetry exhibited the recurring subgraph. */
  readonly sourceExecutionIds: readonly string[];
  /** Durable evidence references backing the observations. */
  readonly evidenceRefs: readonly string[];
  /** Content-addressed digest of the evaluation corpus. */
  readonly corpusDigest: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  /** The observation population (≥ 1 — evidence over claims). */
  readonly population: number;
}

/** The recurrence characterization (DTR-001 "characterize"). */
export interface CandidateRecurrence {
  readonly occurrenceCount: number;
  /** Aggregated observed AI cost, integer micro-USD string. */
  readonly totalCostMicroUsd: string;
  /** Observed failure fraction in [0,1]. */
  readonly errorRate: number;
}

/** The proposed replacement program (absent for the removal class). */
export interface ReplacementProgram {
  readonly language: "javascript-v1";
  readonly source: string;
  readonly sourceDigest: string;
}

/**
 * A deterministicization candidate: the immutable proposal record
 * (identity = content-derived digest over the FULL basis: anchor +
 * provenance + class + contract + program + incumbent).
 */
export interface DeterministicizationCandidate {
  readonly candidateId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateClass: DeterministicizationCandidateClass;
  readonly status: DeterministicizationCandidateStatus;
  readonly subgraph: CandidateSubgraphAnchor;
  readonly provenance: CandidateProvenance;
  readonly recurrence: CandidateRecurrence;
  readonly incumbent: IncumbentBinding;
  readonly contract: ReplacementContract;
  readonly program: ReplacementProgram | null;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Validation-stage evidence (DTR-002).
// ---------------------------------------------------------------------------

/** The offline validation stages of the contract's evidence pipeline. */
export const VALIDATION_STAGE_KINDS = [
  "offline-replay",
  "differential-evaluation",
  "property-tests",
  "mutation-tests",
] as const;

export type ValidationStageKind = (typeof VALIDATION_STAGE_KINDS)[number];

export function isValidationStageKind(value: string): value is ValidationStageKind {
  return (VALIDATION_STAGE_KINDS as readonly string[]).includes(value);
}

/** The honest status vocabulary of a stage evidence record. */
export const STAGE_EVIDENCE_STATUSES = ["passed", "failed", "insufficient"] as const;

export type StageEvidenceStatus = (typeof STAGE_EVIDENCE_STATUSES)[number];

/**
 * ONE observed run of the replacement program — the observation of a
 * REAL sandbox execution supplied by the composition (learning never
 * dispatches; it records what the governed executor observed). The
 * sandbox execution identity is MANDATORY provenance.
 */
export interface ValidationRunObservation {
  /** The stable run key the composition dispatched under. */
  readonly runKey: string;
  /** The durable sandbox execution identity (provenance, non-empty). */
  readonly sandboxExecutionId: string;
  readonly inputDigest: string;
  readonly outputDigest: string | null;
  readonly outcome: "success" | "failure";
  readonly failureClass: string | null;
  /** Observed run cost, integer micro-USD string (null = unobserved). */
  readonly costMicroUsd: string | null;
  readonly latencyMs: number | null;
}

/** One differential pair: incumbent vs replacement on the same input. */
export interface DifferentialPair {
  readonly inputDigest: string;
  readonly incumbentOutputDigest: string;
  readonly replacementOutputDigest: string;
  /** Whether the EXPLICIT acceptance criterion accepted this pair. */
  readonly accepted: boolean;
}

/** The closed stage-metrics shape (honest: absent = unknown). */
export interface StageEvidenceMetrics {
  readonly population: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  /** accepted / population in [0,1] (0 when population is 0). */
  readonly acceptanceRate: number;
  /** Incumbent-side aggregate cost, micro-USD string (differential only). */
  readonly incumbentCostMicroUsd: string | null;
  /** Replacement-side aggregate cost, micro-USD string. */
  readonly replacementCostMicroUsd: string | null;
  /** incumbent - replacement (positive = savings; differential only). */
  readonly costDeltaMicroUsd: string | null;
  readonly replacementLatencyMeanMs: number | null;
  /** Property/metamorphic pass counts (property-tests only). */
  readonly propertyPassCount: number | null;
  readonly propertyFailCount: number | null;
  /** Mutation discrimination counts (mutation-tests only). */
  readonly mutationCaughtCount: number | null;
  readonly mutationMissedCount: number | null;
}

/**
 * The immutable validation-stage evidence record. One settled record
 * per (candidate, stage): retries converge on the content-derived
 * identity; a different basis for the same stage is a DIFFERENT
 * candidate, never a rewrite.
 */
export interface StageEvidenceRecord {
  readonly evidenceId: string;
  readonly candidateId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly stageKind: ValidationStageKind;
  readonly status: StageEvidenceStatus;
  /** The evaluation-corpus binding (must equal the candidate's corpus). */
  readonly basis: {
    readonly corpusDigest: string;
    readonly sourceExecutionIds: readonly string[];
    readonly population: number;
  };
  readonly runs: readonly ValidationRunObservation[];
  /** Differential pairs (required non-empty for differential-evaluation). */
  readonly pairs: readonly DifferentialPair[];
  readonly metrics: StageEvidenceMetrics;
  /** Digest of the acceptance criterion this stage was judged under. */
  readonly criterionDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Shadow/canary rollout (DTR-003) with measurable deltas.
// ---------------------------------------------------------------------------

export const ROLLOUT_MODES = ["shadow", "canary"] as const;

export type RolloutMode = (typeof ROLLOUT_MODES)[number];

export const ROLLOUT_STATUSES = ["observing", "concluded"] as const;

export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

/**
 * One governed rollout phase of a candidate replacement. The phase
 * records MEASURABLE deltas (cost / quality / latency) against the
 * incumbent; the incumbent execution lineage stays canonical
 * throughout ("without changing execution identity").
 */
export interface RolloutRecord {
  readonly rolloutId: string;
  readonly candidateId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly mode: RolloutMode;
  readonly status: RolloutStatus;
  /** The observed population of the phase (≥ 1 once concluded). */
  readonly population: number;
  /** How many observations the replacement agreed with the incumbent. */
  readonly matchedCount: number;
  /** incumbent − replacement aggregate cost (positive = savings). */
  readonly costDeltaMicroUsd: string;
  /** matched / population in [0,1] (the honest quality delta). */
  readonly qualityDelta: number;
  /** incumbent − replacement mean latency (positive = faster). */
  readonly latencyDeltaMs: number;
  readonly evidenceRefs: readonly string[];
  readonly beganAt: string;
  readonly concludedAt: string | null;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Decisions with rationale (DTR-004).
// ---------------------------------------------------------------------------

export const DECISION_KINDS = ["promoted", "rejected", "deferred", "rolled-back"] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export function isDecisionKind(value: string): value is DecisionKind {
  return (DECISION_KINDS as readonly string[]).includes(value);
}

/** The recorded gate evaluation (fail-closed reasons listed). */
export interface GateEvaluation {
  /** sha256 digest of the exact gate config consulted. */
  readonly gateConfigDigest: string;
  readonly verdict: "promote" | "not-promoted";
  /** Every reason the gate consulted (empty only when promoting). */
  readonly reasons: readonly string[];
  /** The stage evidence records the gate loaded (revision-bound). */
  readonly stageEvidenceIds: readonly string[];
  /** The rollout records the gate loaded (revision-bound). */
  readonly rolloutIds: readonly string[];
  readonly evaluatedAt: string;
}

/**
 * A deterministicization decision record: promoted / rejected /
 * deferred / rolled-back — EVERY one carries a non-empty rationale
 * (DTR-004: "record why").
 */
export interface PromotionDecisionRecord {
  readonly decisionId: string;
  readonly candidateId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly kind: DecisionKind;
  readonly rationale: string;
  readonly gate: GateEvaluation;
  /** For rolled-back: the incumbent restoration target (description). */
  readonly incumbentRestoredTo: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Closed-shape validation (fail closed everywhere).
// ---------------------------------------------------------------------------

const MICRO_USD = /^\d{1,19}$/;
const HEX_DIGEST = /^[0-9a-f]{16,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  container: Record<string, unknown>,
  key: string,
  what: string,
  max = 512,
): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `deterministicization ${what} must be a non-empty string (1..${max})`,
      details: { field: key },
    });
  }
  return value;
}

function requireDigest(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `deterministicization ${what} must be a content digest (hex, 16..128)`,
      details: { field: key },
    });
  }
  return value;
}

function requireNonEmptyStringList(
  container: Record<string, unknown>,
  key: string,
  what: string,
): readonly string[] {
  const list = container[key];
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `deterministicization ${what} must be a non-empty array of strings (provenance is never omitted)`,
      details: { field: key },
    });
  }
  return [...list];
}

function validateRouteList(value: readonly unknown[], what: string): void {
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deterministicization ${what} routes must be objects`,
      });
    }
    requireString(entry, "provider", `${what} route provider`);
    requireString(entry, "model", `${what} route model`);
  }
}

function requirePositiveInteger(
  container: Record<string, unknown>,
  key: string,
  what: string,
): number {
  const value = container[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `deterministicization ${what} must be a positive integer`,
      details: { field: key },
    });
  }
  return value;
}

/** Validate a replacement contract (fail closed, closed shape). */
export function validateReplacementContract(value: unknown): asserts value is ReplacementContract {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization replacement contract must be an object",
    });
  }
  const contract = value;
  for (const key of ["inputFields", "outputFields"] as const) {
    const fields = contract[key];
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deterministicization contract ${key} must be a non-empty array (an explicit schema)`,
        details: { field: key },
      });
    }
    for (const field of fields) {
      if (!isRecord(field)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deterministicization contract ${key} entries must be objects`,
        });
      }
      requireString(field, "name", `contract ${key} name`, 128);
      if (
        typeof field.type !== "string" ||
        !(REPLACEMENT_FIELD_TYPES as readonly string[]).includes(field.type)
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deterministicization contract field type must be the closed vocabulary`,
          details: { allowed: REPLACEMENT_FIELD_TYPES },
        });
      }
      if (typeof field.required !== "boolean") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deterministicization contract field required must be boolean`,
        });
      }
    }
  }
  const criterion = contract.acceptanceCriterion;
  if (!isRecord(criterion)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization contract acceptanceCriterion is MANDATORY (the differential requirement is explicit, never implicit)",
      details: { field: "acceptanceCriterion" },
    });
  }
  if (criterion.kind !== "exact-output" && criterion.kind !== "tolerated-field-delta") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization acceptanceCriterion kind must be the closed vocabulary",
      details: { allowed: ["exact-output", "tolerated-field-delta"] },
    });
  }
  requireString(criterion, "description", "acceptanceCriterion description", 2048);
  if (criterion.toleratedFields !== undefined) {
    if (
      !Array.isArray(criterion.toleratedFields) ||
      criterion.toleratedFields.some((field) => typeof field !== "string" || field.length === 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "deterministicization acceptanceCriterion toleratedFields must be string array when present",
      });
    }
  }
  const compute = contract.compute;
  if (!isRecord(compute)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization contract compute is MANDATORY (the confinement basis)",
      details: { field: "compute" },
    });
  }
  if (compute.pureComputeOnly !== true) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization replacement programs must declare pureComputeOnly (a deterministic replacement is pure compute by definition)",
    });
  }
  if (compute.networkEgress !== "none" && compute.networkEgress !== "allowlist") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization contract networkEgress must be 'none' | 'allowlist'",
    });
  }
  const hosts = compute.allowedHosts;
  if (
    !Array.isArray(hosts) ||
    (compute.networkEgress === "none" && hosts.length > 0) ||
    hosts.some((host) => typeof host !== "string" || host.length === 0 || host.length > 253)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization contract allowedHosts must match the declared egress mode (no hosts when egress is none)",
    });
  }
  requirePositiveInteger(compute, "timeoutMs", "contract timeoutMs");
}

/** Validate a candidate record (fail closed, closed shape). */
export function validateDeterministicizationCandidate(
  value: unknown,
): asserts value is DeterministicizationCandidate {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate must be an object",
    });
  }
  const candidate = value;
  requireDigest(candidate, "candidateId", "candidateId (content-derived identity)");
  requireString(candidate, "applicationId", "candidate applicationId");
  requireString(candidate, "tenantId", "candidate tenantId");
  if (
    typeof candidate.candidateClass !== "string" ||
    !isDeterministicizationCandidateClass(candidate.candidateClass)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate class must be the closed five-class vocabulary",
      details: { allowed: DETERMINISTICIZATION_CANDIDATE_CLASSES },
    });
  }
  if (
    typeof candidate.status !== "string" ||
    !isDeterministicizationCandidateStatus(candidate.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate status must be the lifecycle vocabulary",
      details: { allowed: DETERMINISTICIZATION_CANDIDATE_STATUSES },
    });
  }
  const subgraph = candidate.subgraph;
  if (!isRecord(subgraph)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate subgraph anchor is MANDATORY",
    });
  }
  requireString(subgraph, "subgraphId", "subgraph subgraphId");
  requireString(subgraph, "computationType", "subgraph computationType");
  requireString(subgraph, "taskClass", "subgraph taskClass");
  if (!Array.isArray(subgraph.stepPath)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization subgraph stepPath must be an array",
    });
  }
  for (const key of ["routes", "tools"] as const) {
    const list = subgraph[key];
    if (!Array.isArray(list)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deterministicization subgraph ${key} must be an array (may be empty)`,
      });
    }
    if (key === "routes") {
      validateRouteList(list, "subgraph");
    } else {
      for (const tool of list) {
        if (typeof tool !== "string" || tool.length === 0) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "deterministicization subgraph tools entries must be non-empty strings",
          });
        }
      }
    }
  }
  const provenance = candidate.provenance;
  if (!isRecord(provenance)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization candidate provenance is MANDATORY (provenance to source executions and evaluation corpus is identity)",
      details: { field: "provenance" },
    });
  }
  // THE provenance-presence enforcement: without source-execution and
  // corpus provenance a candidate is UNREPRESENTABLE (fail closed).
  requireNonEmptyStringList(provenance, "sourceExecutionIds", "provenance sourceExecutionIds");
  requireNonEmptyStringList(provenance, "evidenceRefs", "provenance evidenceRefs");
  requireDigest(provenance, "corpusDigest", "provenance corpusDigest");
  requireString(provenance, "windowFrom", "provenance windowFrom");
  requireString(provenance, "windowTo", "provenance windowTo");
  requirePositiveInteger(provenance, "population", "provenance population");
  const recurrence = candidate.recurrence;
  if (!isRecord(recurrence)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate recurrence characterization is MANDATORY",
    });
  }
  requirePositiveInteger(recurrence, "occurrenceCount", "recurrence occurrenceCount");
  const totalCost = recurrence.totalCostMicroUsd;
  if (typeof totalCost !== "string" || !MICRO_USD.test(totalCost)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization recurrence totalCostMicroUsd must be an integer micro-USD string",
    });
  }
  const errorRate = recurrence.errorRate;
  if (typeof errorRate !== "number" || errorRate < 0 || errorRate > 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization recurrence errorRate must be in [0,1]",
    });
  }
  const incumbent = candidate.incumbent;
  if (!isRecord(incumbent)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization candidate incumbent binding is MANDATORY (the differential baseline)",
    });
  }
  requireString(incumbent, "strategyClass", "incumbent strategyClass");
  if (!Array.isArray(incumbent.routes)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization incumbent routes must be an array",
    });
  }
  validateRouteList(incumbent.routes, "incumbent");
  requireDigest(incumbent, "descriptionDigest", "incumbent descriptionDigest");
  requireString(incumbent, "rollbackTarget", "incumbent rollbackTarget", 2048);
  validateReplacementContract(candidate.contract);
  const program = candidate.program;
  if (program !== null) {
    if (!isRecord(program)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization candidate program must be an object or null",
      });
    }
    if (program.language !== "javascript-v1") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization program language must be 'javascript-v1'",
      });
    }
    requireString(program, "source", "program source", 65536);
    requireDigest(program, "sourceDigest", "program sourceDigest");
  }
  if (program === null && candidate.candidateClass !== "removal") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization candidates of every class except 'removal' MUST carry a replacement program (the deterministic computation being validated)",
      details: { candidateClass: candidate.candidateClass },
    });
  }
  requireString(candidate, "proposedBy", "candidate proposedBy");
  requireString(candidate, "proposedAt", "candidate proposedAt");
  if (candidate.schemaVersion !== DETERMINISTICIZATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization candidate schemaVersion must match the frozen schema",
      details: { expected: DETERMINISTICIZATION_SCHEMA_VERSION },
    });
  }
}

/** Validate a stage evidence record (fail closed, closed shape). */
export function validateStageEvidenceRecord(value: unknown): asserts value is StageEvidenceRecord {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence must be an object",
    });
  }
  const evidence = value;
  requireDigest(evidence, "evidenceId", "stage evidence evidenceId");
  requireString(evidence, "candidateId", "stage evidence candidateId");
  requireString(evidence, "applicationId", "stage evidence applicationId");
  requireString(evidence, "tenantId", "stage evidence tenantId");
  if (typeof evidence.stageKind !== "string" || !isValidationStageKind(evidence.stageKind)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage kind must be the closed validation-stage vocabulary",
      details: { allowed: VALIDATION_STAGE_KINDS },
    });
  }
  if (
    typeof evidence.status !== "string" ||
    !(STAGE_EVIDENCE_STATUSES as readonly string[]).includes(evidence.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence status must be the honest vocabulary",
      details: { allowed: STAGE_EVIDENCE_STATUSES },
    });
  }
  const basis = evidence.basis;
  if (!isRecord(basis)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence basis is MANDATORY (revision-bound corpus)",
    });
  }
  requireDigest(basis, "corpusDigest", "evidence basis corpusDigest");
  requireNonEmptyStringList(basis, "sourceExecutionIds", "evidence basis sourceExecutionIds");
  requirePositiveInteger(basis, "population", "evidence basis population");
  const runs = evidence.runs;
  if (!Array.isArray(runs)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence runs must be an array",
    });
  }
  if (evidence.status !== "insufficient" && runs.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization stage evidence runs must be non-empty unless the honest status is 'insufficient' (no evidence is recorded as no evidence)",
    });
  }
  for (const run of runs) {
    if (!isRecord(run)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization validation run must be an object",
      });
    }
    requireString(run, "runKey", "run runKey");
    // The sandbox execution identity is MANDATORY provenance: a run
    // observation without it never existed.
    requireString(run, "sandboxExecutionId", "run sandboxExecutionId");
    requireDigest(run, "inputDigest", "run inputDigest");
    if (run.outputDigest !== null && run.outputDigest !== undefined) {
      if (typeof run.outputDigest !== "string" || !HEX_DIGEST.test(run.outputDigest)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "deterministicization run outputDigest must be a digest or null",
        });
      }
    }
    if (run.outcome !== "success" && run.outcome !== "failure") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization run outcome must be 'success' | 'failure'",
      });
    }
    if (run.failureClass !== null && run.failureClass !== undefined) {
      if (typeof run.failureClass !== "string" || run.failureClass.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "deterministicization run failureClass must be a non-empty string or null",
        });
      }
    }
    if (run.costMicroUsd !== null && run.costMicroUsd !== undefined) {
      if (typeof run.costMicroUsd !== "string" || !MICRO_USD.test(run.costMicroUsd)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "deterministicization run costMicroUsd must be an integer micro-USD string or null",
        });
      }
    }
    if (run.latencyMs !== null && run.latencyMs !== undefined) {
      if (
        typeof run.latencyMs !== "number" ||
        !Number.isInteger(run.latencyMs) ||
        run.latencyMs < 0
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "deterministicization run latencyMs must be a non-negative integer or null",
        });
      }
    }
  }
  const pairs = evidence.pairs;
  if (!Array.isArray(pairs)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence pairs must be an array",
    });
  }
  if (evidence.stageKind === "differential-evaluation") {
    if (evidence.status !== "insufficient" && pairs.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "differential evaluation evidence must carry non-empty pairs (the incumbent comparison IS the evidence)",
      });
    }
  } else if (pairs.length > 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization pairs are only representable on differential evaluation evidence",
    });
  }
  for (const pair of pairs) {
    if (!isRecord(pair)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization differential pair must be an object",
      });
    }
    requireDigest(pair, "inputDigest", "pair inputDigest");
    requireDigest(pair, "incumbentOutputDigest", "pair incumbentOutputDigest");
    requireDigest(pair, "replacementOutputDigest", "pair replacementOutputDigest");
    if (typeof pair.accepted !== "boolean") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "deterministicization pair accepted must be a boolean (the explicit criterion verdict)",
      });
    }
  }
  const metrics = evidence.metrics;
  if (!isRecord(metrics)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence metrics are MANDATORY",
    });
  }
  requirePositiveInteger(metrics, "population", "metrics population");
  if (
    typeof metrics.acceptedCount !== "number" ||
    !Number.isInteger(metrics.acceptedCount) ||
    metrics.acceptedCount < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization metrics acceptedCount must be a non-negative integer",
    });
  }
  if (
    typeof metrics.rejectedCount !== "number" ||
    !Number.isInteger(metrics.rejectedCount) ||
    metrics.rejectedCount < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization metrics rejectedCount must be a non-negative integer",
    });
  }
  if (
    typeof metrics.acceptanceRate !== "number" ||
    metrics.acceptanceRate < 0 ||
    metrics.acceptanceRate > 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization metrics acceptanceRate must be in [0,1]",
    });
  }
  for (const key of [
    "incumbentCostMicroUsd",
    "replacementCostMicroUsd",
    "costDeltaMicroUsd",
  ] as const) {
    const cost = metrics[key];
    if (cost !== null && cost !== undefined) {
      if (typeof cost !== "string" || !MICRO_USD.test(cost)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deterministicization metrics ${key} must be an integer micro-USD string or null`,
        });
      }
    }
  }
  for (const key of [
    "propertyPassCount",
    "propertyFailCount",
    "mutationCaughtCount",
    "mutationMissedCount",
  ] as const) {
    const count = metrics[key];
    if (count !== null && count !== undefined) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deterministicization metrics ${key} must be a non-negative integer or null`,
        });
      }
    }
  }
  requireDigest(evidence, "criterionDigest", "evidence criterionDigest");
  requireNonEmptyStringList(evidence, "evidenceRefs", "evidence evidenceRefs");
  requireString(evidence, "recordedAt", "evidence recordedAt");
  requireString(evidence, "recordedBy", "evidence recordedBy");
  if (evidence.schemaVersion !== DETERMINISTICIZATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization stage evidence schemaVersion must match the frozen schema",
    });
  }
}

/** Validate a rollout record (fail closed, closed shape). */
export function validateRolloutRecord(value: unknown): asserts value is RolloutRecord {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout must be an object",
    });
  }
  const rollout = value;
  requireDigest(rollout, "rolloutId", "rollout rolloutId");
  requireString(rollout, "candidateId", "rollout candidateId");
  requireString(rollout, "applicationId", "rollout applicationId");
  requireString(rollout, "tenantId", "rollout tenantId");
  if (rollout.mode !== "shadow" && rollout.mode !== "canary") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout mode must be 'shadow' | 'canary'",
    });
  }
  if (rollout.status !== "observing" && rollout.status !== "concluded") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout status must be 'observing' | 'concluded'",
    });
  }
  const population = rollout.population;
  if (typeof population !== "number" || !Number.isInteger(population) || population < 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout population must be a non-negative integer",
    });
  }
  const matched = rollout.matchedCount;
  if (
    typeof matched !== "number" ||
    !Number.isInteger(matched) ||
    matched < 0 ||
    matched > population
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout matchedCount must be in [0, population]",
    });
  }
  const costDelta = rollout.costDeltaMicroUsd;
  if (typeof costDelta !== "string" || !MICRO_USD.test(costDelta)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization rollout costDeltaMicroUsd must be an integer micro-USD string (measurable deltas are mandatory)",
    });
  }
  const quality = rollout.qualityDelta;
  if (typeof quality !== "number" || quality < 0 || quality > 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout qualityDelta must be the matched fraction in [0,1]",
    });
  }
  if (typeof rollout.latencyDeltaMs !== "number" || !Number.isInteger(rollout.latencyDeltaMs)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout latencyDeltaMs must be an integer (may be negative)",
    });
  }
  if (rollout.status === "concluded") {
    if (population < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "a concluded rollout must carry a positive population (evidence over claims)",
      });
    }
    if (typeof rollout.concludedAt !== "string" || rollout.concludedAt.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "a concluded rollout must carry concludedAt",
      });
    }
  } else if (rollout.concludedAt !== null) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "an observing rollout must not carry concludedAt",
    });
  }
  requireString(rollout, "beganAt", "rollout beganAt");
  if (rollout.schemaVersion !== DETERMINISTICIZATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization rollout schemaVersion must match the frozen schema",
    });
  }
}

/** Validate a decision record (fail closed, closed shape). */
export function validatePromotionDecisionRecord(
  value: unknown,
): asserts value is PromotionDecisionRecord {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization decision must be an object",
    });
  }
  const decision = value;
  requireDigest(decision, "decisionId", "decision decisionId");
  requireString(decision, "candidateId", "decision candidateId");
  requireString(decision, "applicationId", "decision applicationId");
  requireString(decision, "tenantId", "decision tenantId");
  if (typeof decision.kind !== "string" || !isDecisionKind(decision.kind)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization decision kind must be the closed vocabulary",
      details: { allowed: DECISION_KINDS },
    });
  }
  // DTR-004: EVERY decision carries its rationale (1..4096 chars).
  requireString(decision, "rationale", "decision rationale", 4096);
  const gate = decision.gate;
  if (!isRecord(gate)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization decision gate evaluation is MANDATORY",
    });
  }
  requireDigest(gate, "gateConfigDigest", "gate gateConfigDigest");
  if (gate.verdict !== "promote" && gate.verdict !== "not-promoted") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization gate verdict must be 'promote' | 'not-promoted'",
    });
  }
  if (!Array.isArray(gate.reasons)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization gate reasons must be an array",
    });
  }
  if (gate.verdict === "promote" && gate.reasons.length > 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "a promoting gate carries no failure reasons",
    });
  }
  if (gate.verdict === "not-promoted" && gate.reasons.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "a not-promoted gate lists its reasons (fail closed is explained, never silent)",
    });
  }
  if (!Array.isArray(gate.stageEvidenceIds) || !Array.isArray(gate.rolloutIds)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization gate must carry its evidence bindings",
    });
  }
  requireString(gate, "evaluatedAt", "gate evaluatedAt");
  if (decision.incumbentRestoredTo !== null && decision.incumbentRestoredTo !== undefined) {
    requireString(decision, "incumbentRestoredTo", "decision incumbentRestoredTo", 2048);
  }
  if (decision.kind === "rolled-back" && typeof decision.incumbentRestoredTo !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "a rollback decision must record the incumbent restoration target",
    });
  }
  if (decision.kind !== "rolled-back" && decision.incumbentRestoredTo != null) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "only rollback decisions record an incumbent restoration target",
    });
  }
  if (
    (decision.kind === "promoted" && gate.verdict !== "promote") ||
    (decision.kind === "rejected" && gate.verdict !== "not-promoted")
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "decision kind must agree with the gate verdict (promotion requires a promoting gate; rejection records a fail-closed gate)",
    });
  }
  requireString(decision, "decidedBy", "decision decidedBy");
  requireString(decision, "decidedAt", "decision decidedAt");
  if (decision.schemaVersion !== DETERMINISTICIZATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization decision schemaVersion must match the frozen schema",
    });
  }
}

/** The canonical basis of a candidate's content-derived identity. */
export function candidateIdentityBasis(input: {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateClass: DeterministicizationCandidateClass;
  readonly subgraph: CandidateSubgraphAnchor;
  readonly provenance: CandidateProvenance;
  readonly recurrence: CandidateRecurrence;
  readonly incumbent: IncumbentBinding;
  readonly contract: ReplacementContract;
  readonly program: ReplacementProgram | null;
}): Record<string, unknown> {
  return {
    identitySchema: 1,
    applicationId: input.applicationId,
    candidateClass: input.candidateClass,
    subgraph: {
      subgraphId: input.subgraph.subgraphId,
      stepPath: [...input.subgraph.stepPath],
      computationType: input.subgraph.computationType,
      taskClass: input.subgraph.taskClass,
      routes: input.subgraph.routes.map((route) => `${route.provider}/${route.model}`),
      tools: [...input.subgraph.tools],
    },
    provenance: {
      sourceExecutionIds: [...input.provenance.sourceExecutionIds],
      corpusDigest: input.provenance.corpusDigest,
      population: input.provenance.population,
    },
    recurrence: {
      occurrenceCount: input.recurrence.occurrenceCount,
      totalCostMicroUsd: input.recurrence.totalCostMicroUsd,
      errorRate: input.recurrence.errorRate,
    },
    incumbent: {
      strategyClass: input.incumbent.strategyClass,
      routes: input.incumbent.routes.map((route) => `${route.provider}/${route.model}`),
      descriptionDigest: input.incumbent.descriptionDigest,
    },
    contract: input.contract,
    program:
      input.program === null
        ? null
        : {
            language: input.program.language,
            sourceDigest: input.program.sourceDigest,
          },
  };
}

/** The canonical basis of a stage evidence record's identity. */
export function stageEvidenceIdentityBasis(input: {
  readonly candidateId: string;
  readonly stageKind: ValidationStageKind;
  readonly corpusDigest: string;
  readonly runs: readonly ValidationRunObservation[];
  readonly pairs: readonly DifferentialPair[];
}): Record<string, unknown> {
  return {
    evidenceSchema: 1,
    candidateId: input.candidateId,
    stageKind: input.stageKind,
    corpusDigest: input.corpusDigest,
    runs: input.runs.map((run) => ({
      runKey: run.runKey,
      sandboxExecutionId: run.sandboxExecutionId,
      inputDigest: run.inputDigest,
      outputDigest: run.outputDigest,
      outcome: run.outcome,
    })),
    pairs: input.pairs.map((pair) => ({
      inputDigest: pair.inputDigest,
      incumbentOutputDigest: pair.incumbentOutputDigest,
      replacementOutputDigest: pair.replacementOutputDigest,
      accepted: pair.accepted,
    })),
  };
}
