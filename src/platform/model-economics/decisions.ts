/**
 * Model-economics decision records (platform model-economics plane;
 * WORK-053 / E1.1 — ADR-0020 "Required decision evidence").
 *
 * The record-construction seam: every material model-economics
 * selection (model route, reasoning effort, agent strategy, substrate
 * service class, fresh escalation) is recorded through the WORK-049
 * evidence contract (`buildOptimizationDecision`) — APPEND-ONLY
 * EVIDENCE, built here as VALUES:
 *
 *  - the plane NEVER holds a store client: the durable append happens
 *    through the EXISTING WORK-049 store at the CALLER's seam
 *    (architecture invariant 4: selection is decision evidence; no
 *    runtime authorization path consults it);
 *  - the record's candidate corpus is the EVIDENCE-HONEST subset:
 *    every candidate constraint-admissible under the governing facts,
 *    plus below-ASSURANCE-threshold candidates (recorded with their
 *    invalid evaluations — the auditable "why the cheaper did not
 *    win" evidence, exactly the foundation's own precedent).
 *    Candidates violating HARD constraints (hard quality floors,
 *    reliability floors, budget/latency ceilings), policy-forbidden
 *    routes and non-positive-net N strategies are EXCLUDED — the
 *    foundation's decision builder fails closed on hard-constraint
 *    violations by ANY recorded candidate, and their full typed
 *    verdicts (plus every N candidate's expected-gain analysis) live
 *    in the typed selection results this seam records FROM;
 *  - the transformation basis comes from the CLOSED WORK-049
 *    vocabulary, derived from the selection itself:
 *    `representation-substitution` when the selection changes the
 *    incumbent representation (a different route than the IR step's
 *    bound route, a non-one-agent gate mode, a fresh-context
 *    escalation, or a dimension the IR does not carry an incumbent
 *    for — effort, service tier), `identity` when it demonstrably
 *    keeps it (the incumbent route, the one-agent gate mode, the
 *    continued context) — with a bounded detail carrying the
 *    model-economics provenance (feature, step, corpus shape,
 *    selected candidate, effective floor, frozen selection basis);
 *  - `recordedAt` is an explicit INPUT (determinism — the same inputs
 *    always produce the byte-identical record, so the content-addressed
 *    `decisionId` is stable and re-recording is a bounded no-op at the
 *    store's unique index);
 *  - foundation rejections are wrapped into this plane's closed
 *    `decision-invalid` error (fail closed — a record that fails its
 *    own total validation is never emitted).
 *
 * When the typed selection is `no-admissible-candidate` (or the
 * service-class substrate is `unsupported`), NO record exists: the
 * typed outcome IS the evidence — a below-floor selection is never
 * recorded as a decision.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation, CostClaim } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import type { AgentGateSelection } from "./agent-gate";
import type { EffortSelection } from "./effort-selection";
import type { FreshEscalationDecision } from "./escalation-hooks";
import { CONTINUATION_PATH_CANDIDATE_ID, ESCALATION_PATH_CANDIDATE_ID } from "./escalation-hooks";
import type { ModelSelection } from "./model-selection";
import { requireGenerativeStep } from "./model-selection";
import type { ServiceClassSelection } from "./service-class";
import type {
  EffortCandidate,
  ModelCandidate,
  NAgentCandidate,
  OneAgentCandidate,
  ServiceClassCandidate,
  ZeroAgentCandidate,
} from "./vocabulary";
import { reject } from "./vocabulary";

// ---------------------------------------------------------------------------
// The shared scope and provenance discipline
// ---------------------------------------------------------------------------

/** The decision-record scope + the explicit recorded-at instant. */
export interface DecisionRecordScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The explicit recorded-at instant — an INPUT, never ambient time. */
  readonly recordedAt: string;
}

/** The bounded provenance-detail ceiling (the foundation's own rule). */
const DETAIL_MAX = 500;

function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/**
 * Is this verdict recordable in the decision corpus? Constraint-
 * admissible verdicts and below-ASSURANCE verdicts are (their invalid
 * evaluations ARE the comparison evidence); HARD-constraint
 * violations, policy-forbidden routes and non-positive-net N
 * strategies are not.
 */
function recordable(inadmissibleCode: string | undefined): boolean {
  return inadmissibleCode === undefined || inadmissibleCode === "quality-below-assurance";
}

// ---------------------------------------------------------------------------
// The shared record core (fail closed through the foundation)
// ---------------------------------------------------------------------------

interface RecordCoreInput {
  readonly ir: ExecutionIr;
  readonly constraints: readonly OptimizationConstraint[];
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
  /** The evidence-honest candidate corpus (foundation-validated). */
  readonly candidates: readonly CandidateRepresentation[];
  readonly selectedCandidateId: string;
  /** The effective quality floor the selection ran under. */
  readonly qualityThreshold: number;
  readonly transformationBasisCode: "identity" | "representation-substitution";
  readonly transformationBasisDetail: string;
}

function buildRecordCore(input: RecordCoreInput): OptimizationDecisionRecord {
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    // The WORK-049 rule: a decision without governing inputs is
    // unprovenanced optimization — fail closed.
    reject("decision-invalid", "a decision must record at least its governing constraints");
  }
  if (input.candidates.length === 0) {
    reject("decision-invalid", "a decision must record at least one candidate representation");
  }
  try {
    return buildOptimizationDecision(
      {
        applicationId: input.scope.applicationId,
        tenantId: input.scope.tenantId,
        ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
        ir: input.ir,
        constraints,
        candidates: input.candidates,
        qualityThreshold: input.qualityThreshold,
        selectedCandidateId: input.selectedCandidateId,
        transformationBasis: {
          code: input.transformationBasisCode,
          detail: boundedDetail(input.transformationBasisDetail),
        },
        recordedAt: input.scope.recordedAt,
      },
      input.digest,
    );
  } catch (error) {
    // The foundation's total validation (hard constraints, selection
    // coherence, digests) rejected the record: the plane's closed
    // fail-closed error — never an unvalidated emission.
    reject("decision-invalid", "the model-economics decision record failed its total validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// The shared corpus construction (verdict ↔ candidate correspondence)
// ---------------------------------------------------------------------------

/**
 * The claim/description source of one corpus candidate (the caller's
 * ORIGINAL declared candidates — the exact explicit-basis values the
 * selection ran on).
 */
interface CorpusSource {
  readonly candidateId: string;
  readonly description?: string;
  readonly claim: CostClaim;
}

/**
 * Assemble the evidence-honest corpus from the selection's verdicts
 * (in their deterministic order) and the original declared
 * candidates: every verdict must correspond to exactly one declared
 * candidate and vice versa (the record corpus IS the selection's
 * corpus — anything else is unprovenanced and fails closed). The
 * representation class comes from the VERDICT (the evaluated class —
 * the gate forces the canonical `parallel-multi-agent` rung for N
 * strategies); the claim and description come from the declared
 * candidate (the exact caller values).
 */
function buildCorpus(
  verdicts: readonly {
    candidateId: string;
    representationClass: string;
    inadmissibleCode?: string;
  }[],
  sources: readonly CorpusSource[],
  what: string,
): CandidateRepresentation[] {
  const byId = new Map(sources.map((source) => [source.candidateId, source]));
  const corpus: CandidateRepresentation[] = [];
  const evaluated = new Set<string>();
  for (const verdict of verdicts) {
    const source = byId.get(verdict.candidateId);
    if (source === undefined) {
      reject(
        "decision-invalid",
        "a verdict references a candidate the record input does not carry",
        {
          feature: what,
          candidateId: verdict.candidateId,
        },
      );
    }
    if (evaluated.has(verdict.candidateId)) {
      reject("decision-invalid", "duplicate candidate verdicts are unrepresentable", {
        feature: what,
        candidateId: verdict.candidateId,
      });
    }
    evaluated.add(verdict.candidateId);
    if (!recordable(verdict.inadmissibleCode)) {
      // Hard-constraint violations, policy-forbidden routes and
      // non-positive-net N strategies: their typed verdicts (and gain
      // analyses) live in the selection result — the corpus records
      // what the foundation's evidence contract can express honestly.
      continue;
    }
    corpus.push({
      candidateId: verdict.candidateId,
      representationClass:
        verdict.representationClass as CandidateRepresentation["representationClass"],
      ...(source.description === undefined ? {} : { description: source.description }),
      claim: source.claim,
    });
  }
  if (evaluated.size !== sources.length) {
    reject(
      "decision-invalid",
      "the record input carries candidates the selection did not evaluate",
      {
        feature: what,
        declared: sources.length,
        evaluated: evaluated.size,
      },
    );
  }
  return corpus;
}

// ---------------------------------------------------------------------------
// Model-selection records
// ---------------------------------------------------------------------------

/** The model-selection decision-record input. */
export interface ModelDecisionRecordInput {
  /** The typed selection to record (from `selectModelRepresentation`). */
  readonly selection: ModelSelection;
  /** The generative step the selection ran for (fail-closed checked). */
  readonly stepId: string;
  /** The ORIGINAL declared candidates the selection ran on. */
  readonly candidates: readonly ModelCandidate[];
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the selection ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a quality-aware model selection. The
 * basis is `identity` when the selected route IS the IR step's bound
 * incumbent route (the plan keeps its representation), else
 * `representation-substitution`. No admissible candidate → NO record
 * (the typed outcome is the evidence — never a below-floor
 * selection).
 */
export function buildModelDecisionRecord(
  input: ModelDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.selection.selected === null) {
    return null;
  }
  requireGenerativeStep(input.ir, input.stepId);
  const step = input.ir.steps.find((candidate) => candidate.id === input.stepId);
  const corpus = buildCorpus(input.selection.verdicts, input.candidates, "model-selection");
  const selected = input.selection.selected;
  const incumbent = step?.routeRef;
  const keepsIncumbent =
    incumbent !== undefined &&
    selected.route.provider === incumbent.provider &&
    selected.route.model === incumbent.model;
  return buildRecordCore({
    ir: input.ir,
    constraints: input.constraints,
    scope: input.scope,
    digest: input.digest,
    candidates: corpus,
    selectedCandidateId: selected.candidateId,
    qualityThreshold: input.selection.facts.qualityFloor,
    transformationBasisCode: keepsIncumbent ? "identity" : "representation-substitution",
    transformationBasisDetail:
      `model-economics;feature=model-selection;step=${input.stepId};` +
      `corpus=${input.selection.verdicts.length};recorded=${corpus.length};` +
      `selected=${selected.candidateId};route=${selected.route.provider}/${selected.route.model};` +
      `floor=${input.selection.facts.qualityFloor};order=${input.selection.selectionBasis}`,
  });
}

// ---------------------------------------------------------------------------
// Effort-selection records
// ---------------------------------------------------------------------------

/** The effort-selection decision-record input. */
export interface EffortDecisionRecordInput {
  /** The typed selection to record (from `selectReasoningEffort`). */
  readonly selection: EffortSelection;
  /** The generative step the selection ran for (fail-closed checked). */
  readonly stepId: string;
  /** The ORIGINAL declared effort candidates the selection ran on. */
  readonly candidates: readonly EffortCandidate[];
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the selection ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a reasoning-effort selection. The IR
 * carries no effort incumbent (the effort dimension refines the
 * invocation, not the plan representation), so every effort
 * selection is a `representation-substitution` among the declared
 * effort candidates. No admissible candidate → NO record.
 */
export function buildEffortDecisionRecord(
  input: EffortDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.selection.selected === null) {
    return null;
  }
  requireGenerativeStep(input.ir, input.stepId);
  const corpus = buildCorpus(input.selection.verdicts, input.candidates, "effort-selection");
  const selected = input.selection.selected;
  return buildRecordCore({
    ir: input.ir,
    constraints: input.constraints,
    scope: input.scope,
    digest: input.digest,
    candidates: corpus,
    selectedCandidateId: selected.candidateId,
    qualityThreshold: input.selection.facts.qualityFloor,
    transformationBasisCode: "representation-substitution",
    transformationBasisDetail:
      `model-economics;feature=effort-selection;step=${input.stepId};` +
      `corpus=${input.selection.verdicts.length};recorded=${corpus.length};` +
      `selected=${selected.candidateId};effort=${selected.effort};` +
      `floor=${input.selection.facts.qualityFloor};order=${input.selection.selectionBasis}`,
  });
}

// ---------------------------------------------------------------------------
// Agent-gate records
// ---------------------------------------------------------------------------

/** The agent-gate decision-record input. */
export interface AgentGateDecisionRecordInput {
  /** The typed gate selection to record (from `selectAgentStrategy`). */
  readonly selection: AgentGateSelection;
  /** The generative step the gate ran for (fail-closed checked). */
  readonly stepId: string;
  /** The ORIGINAL declared zero-agent candidates the gate ran on. */
  readonly zeroAgent: readonly ZeroAgentCandidate[];
  /** The ORIGINAL declared one-agent candidates the gate ran on. */
  readonly oneAgent: readonly OneAgentCandidate[];
  /** The ORIGINAL declared n-agent candidates the gate ran on. */
  readonly nAgent: readonly NAgentCandidate[];
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the gate ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a 0/1/N agent-gate decision. The
 * basis is `identity` when the selected mode is the generative step's
 * incumbent single-agent form (`one-agent`); zero-agent and n-agent
 * are `representation-substitution`. Non-positive-net N strategies
 * are excluded from the corpus (their expected-gain analyses — the
 * gate's own typed evidence — live in the selection result). No
 * admissible strategy → NO record.
 */
export function buildAgentGateDecisionRecord(
  input: AgentGateDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.selection.selected === null) {
    return null;
  }
  requireGenerativeStep(input.ir, input.stepId);
  const sources: CorpusSource[] = [...input.zeroAgent, ...input.oneAgent, ...input.nAgent];
  const corpus = buildCorpus(input.selection.verdicts, sources, "agent-gate");
  const selected = input.selection.selected;
  const positiveGain = input.selection.gainAnalyses.filter((analysis) => analysis.positive).length;
  return buildRecordCore({
    ir: input.ir,
    constraints: input.constraints,
    scope: input.scope,
    digest: input.digest,
    candidates: corpus,
    selectedCandidateId: selected.candidateId,
    qualityThreshold: input.selection.facts.qualityFloor,
    transformationBasisCode:
      selected.gateMode === "one-agent" ? "identity" : "representation-substitution",
    transformationBasisDetail:
      `model-economics;feature=agent-gate;step=${input.stepId};` +
      `corpus=${input.selection.verdicts.length};recorded=${corpus.length};` +
      `zero=${input.zeroAgent.length};one=${input.oneAgent.length};many=${input.nAgent.length};` +
      `positive-gain=${positiveGain};selected=${selected.candidateId};mode=${selected.gateMode};` +
      `floor=${input.selection.facts.qualityFloor};order=${input.selection.selectionBasis}`,
  });
}

// ---------------------------------------------------------------------------
// Service-class records (hooks only)
// ---------------------------------------------------------------------------

/** The service-class decision-record input. */
export interface ServiceClassDecisionRecordInput {
  /** The typed hook selection to record (from `selectServiceClass`). */
  readonly selection: ServiceClassSelection;
  /** The ORIGINAL declared substrate classes the hook ran on. */
  readonly declaredClasses: readonly ServiceClassCandidate[];
  /** The governed Execution IR the invocation belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the hook ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a substrate service-class selection
 * (a HOOK decision the substrate adapters consume). The IR carries no
 * service-tier incumbent, so every class selection is a
 * `representation-substitution`. `unsupported` (no declared classes)
 * and no-admissible-candidate → NO record.
 */
export function buildServiceClassDecisionRecord(
  input: ServiceClassDecisionRecordInput,
): OptimizationDecisionRecord | null {
  const facts = input.selection.facts;
  if (input.selection.selected === null || facts === null) {
    // `unsupported` (no declared classes) and no-admissible-candidate:
    // no selection happened — no record.
    return null;
  }
  const corpus = buildCorpus(input.selection.verdicts, input.declaredClasses, "service-class");
  const selected = input.selection.selected;
  return buildRecordCore({
    ir: input.ir,
    constraints: input.constraints,
    scope: input.scope,
    digest: input.digest,
    candidates: corpus,
    selectedCandidateId: selected.candidateId,
    qualityThreshold: facts.qualityFloor,
    transformationBasisCode: "representation-substitution",
    transformationBasisDetail:
      `model-economics;feature=service-class;` +
      `corpus=${input.selection.verdicts.length};recorded=${corpus.length};` +
      `selected=${selected.candidateId};class=${selected.serviceClass};` +
      `floor=${facts.qualityFloor};order=${input.selection.selectionBasis}`,
  });
}

// ---------------------------------------------------------------------------
// Fresh-escalation records (record-only hooks)
// ---------------------------------------------------------------------------

/** The fresh-escalation decision-record input. */
export interface FreshEscalationDecisionRecordInput {
  /** The typed decision to record (from `decideFreshEscalation`). */
  readonly decision: FreshEscalationDecision;
  /** The ORIGINAL continuation-path claim the decision ran on. */
  readonly continuation: CostClaim;
  /** The ORIGINAL fresh-context-path claim the decision ran on. */
  readonly freshContext: CostClaim;
  /** The governed Execution IR the decision belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the decision ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: DecisionRecordScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a fresh-escalation decision (the
 * decision hook WORK-055 consumes; the recovery behavior is out of
 * scope here). The basis is `identity` when the decision CONTINUES
 * the current context, `representation-substitution` when it
 * escalates to a fresh one. The corpus carries both paths in the
 * evidence-honest subset — a degraded (below-ASSURANCE) continuation
 * is recorded with its invalid evaluation exactly when it is the
 * reason the escalation is justified; hard-violating paths are
 * excluded (their verdicts live in the typed decision).
 * `no-admissible-candidate` → NO record (neither path is sufficient;
 * the recovery authority decides).
 */
export function buildFreshEscalationDecisionRecord(
  input: FreshEscalationDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.decision.kind === "no-admissible-candidate") {
    return null;
  }
  const continuationCandidate: CandidateRepresentation = {
    candidateId: CONTINUATION_PATH_CANDIDATE_ID,
    representationClass: "sufficient-model",
    description: "the continuation path (continuing in the current context)",
    claim: input.continuation,
  };
  const freshCandidate: CandidateRepresentation = {
    candidateId: ESCALATION_PATH_CANDIDATE_ID,
    representationClass: "sufficient-model",
    description: "the fresh-context escalation path (restart with a fresh context)",
    claim: input.freshContext,
  };
  const corpus = [continuationCandidate, freshCandidate].filter((candidate) => {
    const verdict =
      input.decision.comparison[
        candidate.candidateId === CONTINUATION_PATH_CANDIDATE_ID ? "continuation" : "freshContext"
      ];
    return recordable(verdict.inadmissibleCode);
  });
  const selectedCandidateId =
    input.decision.kind === "escalate-fresh-context"
      ? ESCALATION_PATH_CANDIDATE_ID
      : CONTINUATION_PATH_CANDIDATE_ID;
  return buildRecordCore({
    ir: input.ir,
    constraints: input.constraints,
    scope: input.scope,
    digest: input.digest,
    candidates: corpus,
    selectedCandidateId,
    qualityThreshold: input.decision.facts.qualityFloor,
    transformationBasisCode:
      input.decision.kind === "escalate-fresh-context" ? "representation-substitution" : "identity",
    transformationBasisDetail:
      `model-economics;feature=fresh-escalation;decision=${input.decision.kind};` +
      `recorded=${corpus.length};selected=${selectedCandidateId};` +
      `continuation-premium=${input.decision.comparison.continuationPremiumMicroUsd};` +
      `floor=${input.decision.facts.qualityFloor};order=${input.decision.selectionBasis}`,
  });
}
