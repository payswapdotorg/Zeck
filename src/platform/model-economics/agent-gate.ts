/**
 * The 0/1/N agent gate (platform model-economics plane; WORK-053 /
 * E1.1 — ADR-0019 §8 "Parallelism and multi-agent economics",
 * ADR-0020).
 *
 * The decision machinery that selects, per step/outcome, the least
 * expensive SUFFICIENT agent strategy among:
 *
 *  - ZERO-AGENT candidates — deterministic-family representations
 *    (deterministic computation, cache/reuse, verified competence,
 *    programmatic execution: the cheapest rungs of the ladder);
 *  - ONE-AGENT candidates — a single model invocation (the DEFAULT
 *    single-agent path; the gate input MUST declare at least one —
 *    the anchor of the comparison);
 *  - N-AGENT candidates — deliberate parallelism (the canonical
 *    `parallel-multi-agent` rung), admissible ONLY with POSITIVE
 *    expected quality-gain evidence.
 *
 * The gate rules (WORK-053 architecture invariants 1 and 2):
 *
 *  - the gate DEFAULTS to the cheapest path: selection among
 *    admissible strategies is by expected successful-resolution cost
 *    ascending, ties by the canonical representation ladder
 *    (deterministic rungs first, then the model rungs, then
 *    parallel-multi-agent LAST), ties by candidateId;
 *  - N-agent REQUIRES positive expected quality-gain evidence, not
 *    enthusiasm: every N candidate MUST carry an explicit-basis gain
 *    claim (an N candidate without one is unrepresentable), and its
 *    net expected gain — valueOfGain − incrementalCost −
 *    verificationBurden − latencyTerm, all bounded typed integer
 *    micro-USD (`expected-gain.ts`) — must be STRICTLY positive, or
 *    the candidate is inadmissible (`quality-gain-below-threshold`).
 *    ALWAYS-ON N IS IMPOSSIBLE BY CONSTRUCTION: without positive
 *    evidence no N candidate can ever be admissible, and even an
 *    admissible N is selected only when it is the least expensive
 *    sufficient strategy (a costlier N never displaces a cheaper
 *    sufficient 0/1 path);
 *  - the N premium is measured against the DETERMINISTIC anchor: the
 *    first admissible 0/1 strategy under the gate order (or the empty
 *    path when none exists — N must then carry positive absolute
 *    value);
 *  - quality floors are inviolable for EVERY strategy (invariant 8):
 *    below-floor candidates are inadmissible regardless of cost —
 *    including N candidates whose parallel quality does not reach the
 *    floor;
 *  - hard ceilings (budget, latency) and hard policy route
 *    restrictions are enforced per candidate; every gain analysis is
 *    RECORDED (the expected-gain evidence, acceptance criterion 3);
 *  - pure and deterministic (invariant 5); decision evidence only,
 *    never an authorization (invariant 4).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { ExecutionIr } from "../execution-ir/ir";
import { isGenerativeStepClass } from "../execution-ir/ir";
import type { CandidateAdmissibility, GoverningFacts } from "./admissibility";
import {
  evaluateAdmissibility,
  governingFacts,
  orderVerdicts,
  rejectDuplicateIds,
  routeEligibility,
} from "./admissibility";
import { analyzeExpectedGain, type ExpectedGainAnalysis } from "./expected-gain";
import { requireGenerativeStep } from "./model-selection";
import type {
  AgentGateEconomics,
  AgentGateMode,
  NAgentCandidate,
  OneAgentCandidate,
  QualityFacts,
  ZeroAgentCandidate,
} from "./vocabulary";
import {
  reject,
  validateAgentGateEconomics,
  validateNAgentCandidate,
  validateOneAgentCandidate,
  validateQualityFacts,
  validateZeroAgentCandidate,
} from "./vocabulary";

// ---------------------------------------------------------------------------
// The gate input and result (typed, bounded)
// ---------------------------------------------------------------------------

/** The 0/1/N agent-gate input for ONE step/outcome. */
export interface AgentGateInput {
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The step the agent strategy is gated for (generative classes only). */
  readonly stepId: string;
  /** Zero-agent candidates (deterministic-family representations). */
  readonly zeroAgent: readonly ZeroAgentCandidate[];
  /**
   * One-agent candidates — REQUIRED NON-EMPTY: the single-model path
   * is the comparison anchor the N premium is measured against.
   */
  readonly oneAgent: readonly OneAgentCandidate[];
  /** N-agent candidates (deliberate parallelism; gain claim required). */
  readonly nAgent: readonly NAgentCandidate[];
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The explicit exchange-rate economics of the gain trade-off. */
  readonly economics: AgentGateEconomics;
}

/** The agent strategy verdict common to every gate mode. */
export interface AgentStrategyVerdict extends CandidateAdmissibility {
  /** The gate mode this candidate belongs to. */
  readonly gateMode: AgentGateMode;
  /** The parallelism width (n-agent candidates only). */
  readonly agentCount?: number;
  readonly route?: { readonly provider: string; readonly model: string };
  readonly inadmissibleCode?: CandidateAdmissibility["inadmissibleCode"];
}

/** The 0/1/N agent-gate selection result (typed evidence). */
export interface AgentGateSelection {
  readonly kind: "selected" | "no-admissible-candidate";
  /** The selected strategy's verdict, or null when none is admissible. */
  readonly selected: AgentStrategyVerdict | null;
  /** The gate mode of the selection ("zero-agent" | "one-agent" | "n-agent" | null). */
  readonly gateMode: AgentGateMode | null;
  /** The governing facts the gate ran under. */
  readonly facts: GoverningFacts;
  /** Every candidate's verdict in the deterministic gate order. */
  readonly verdicts: readonly AgentStrategyVerdict[];
  /**
   * The expected-gain analysis of EVERY N candidate (recorded whether
   * N is admissible or not — the expected-gain evidence of AC 3).
   */
  readonly gainAnalyses: readonly ExpectedGainAnalysis[];
  /** The frozen, human-auditable gate basis. */
  readonly selectionBasis: string;
}

/** The frozen selection-basis statement of every agent-gate decision. */
export const AGENT_GATE_SELECTION_BASIS =
  "least-expensive-sufficient-agent-strategy;order:expected-successful-resolution-cost,representation-ladder,candidateId;gate:defaults-to-cheapest-path;n-agent-requires-positive-net-expected-gain-evidence;floors:quality,reliability,budget,latency,policy;below-floor-inadmissible-regardless-of-cost";

// ---------------------------------------------------------------------------
// The gate (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Run the 0/1/N agent gate: evaluate every strategy's admissibility
 * (floors, ceilings, policy routes), analyze every N candidate's
 * expected gain against the deterministic anchor, and select the
 * least expensive SUFFICIENT strategy. Pure and deterministic;
 * decision evidence only — never an authorization (invariant 4).
 */
export function selectAgentStrategy(input: AgentGateInput): AgentGateSelection {
  const step = requireGenerativeStep(input.ir, input.stepId);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const economics = validateAgentGateEconomics(input.economics);
  const zero = input.zeroAgent.map((candidate) => validateZeroAgentCandidate(candidate));
  const one = input.oneAgent.map((candidate) => validateOneAgentCandidate(candidate));
  const many = input.nAgent.map((candidate) => validateNAgentCandidate(candidate));
  if (one.length === 0) {
    // The single-model path is the gate's comparison anchor — a gate
    // without it is unanchored economics (fail closed).
    reject("gate-shape", "the agent gate requires at least one one-agent candidate (the anchor)", {
      stepId: step.id,
    });
  }
  rejectDuplicateIds([
    ...zero.map((candidate) => candidate.candidateId),
    ...one.map((candidate) => candidate.candidateId),
    ...many.map((candidate) => candidate.candidateId),
  ]);

  const facts = governingFacts(qualityFacts, input.constraints);

  // -- Stage 1: the 0/1 strategies' admissibility (the anchor side). --
  const zeroVerdicts: AgentStrategyVerdict[] = zero.map((candidate) => ({
    ...evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: candidate.representationClass,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    ),
    gateMode: "zero-agent" as const,
  }));
  const oneVerdicts: AgentStrategyVerdict[] = one.map((candidate) => {
    const admissibility = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: candidate.representationClass,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    );
    if (candidate.route === undefined) {
      return { ...admissibility, gateMode: "one-agent" as const };
    }
    const eligibility = routeEligibility(candidate.route, facts);
    if (eligibility.eligible) {
      return {
        ...admissibility,
        gateMode: "one-agent" as const,
        ...(candidate.route === undefined ? {} : { route: candidate.route }),
      };
    }
    return {
      candidateId: candidate.candidateId,
      representationClass: candidate.representationClass,
      admissible: false,
      inadmissibleCode: "policy-forbidden-route" as const,
      evaluation: admissibility.evaluation,
      gateMode: "one-agent" as const,
      route: candidate.route,
    };
  });

  // -- Stage 2: the deterministic ANCHOR (the best admissible 0/1). --
  const anchorOrder = orderVerdicts([...zeroVerdicts, ...oneVerdicts]);
  const anchor = anchorOrder.selected;

  // -- Stage 3: every N candidate's admissibility + gain analysis. --
  const gainAnalyses: ExpectedGainAnalysis[] = [];
  const manyVerdicts: AgentStrategyVerdict[] = many.map((candidate) => {
    const base = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: "parallel-multi-agent",
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    );
    const routeInadmissible =
      candidate.route !== undefined && !routeEligibility(candidate.route, facts).eligible;
    const analysis = analyzeExpectedGain({
      candidateId: candidate.candidateId,
      expectedSuccessfulResolutionCostMicroUsd:
        base.evaluation.expectedSuccessfulResolutionCostMicroUsd,
      claim: candidate.claim,
      gain: candidate.gain,
      anchorCostMicroUsd: anchor?.evaluation.expectedSuccessfulResolutionCostMicroUsd ?? "0",
      anchorLatencyMs: anchor?.evaluation.expectedLatencyMs ?? 0,
      economics,
    });
    gainAnalyses.push(analysis);
    // The gate rule: N is admissible ONLY when floor/ceilings/policy
    // pass AND the net expected gain is STRICTLY positive. A
    // non-positive net is the typed below-threshold inadmissibility —
    // recorded, never silently applied.
    const admissible = base.admissible && !routeInadmissible && analysis.positive;
    const inadmissibleCode = routeInadmissible
      ? ("policy-forbidden-route" as const)
      : !base.admissible
        ? base.inadmissibleCode
        : analysis.positive
          ? undefined
          : ("quality-gain-below-threshold" as const);
    return {
      candidateId: candidate.candidateId,
      representationClass: "parallel-multi-agent",
      admissible,
      ...(inadmissibleCode === undefined ? {} : { inadmissibleCode }),
      evaluation: base.evaluation,
      gateMode: "n-agent" as const,
      agentCount: candidate.gain.agentCount,
      ...(candidate.route === undefined ? {} : { route: candidate.route }),
    };
  });

  // -- Stage 4: the gate selection (defaults to the cheapest path). --
  const { ordered, selected } = orderVerdicts([...zeroVerdicts, ...oneVerdicts, ...manyVerdicts]);
  return {
    kind: selected === null ? "no-admissible-candidate" : "selected",
    selected,
    gateMode: selected?.gateMode ?? null,
    facts,
    verdicts: ordered,
    gainAnalyses,
    selectionBasis: AGENT_GATE_SELECTION_BASIS,
  };
}

/**
 * Is this IR step an agent-gate decision point? (Generative steps
 * only — the classes whose routes are legal; the gate never applies
 * to deterministic or human steps.)
 */
export function isAgentGateStep(ir: ExecutionIr, stepId: string): boolean {
  const step = ir.steps.find((candidate) => candidate.id === stepId);
  return step !== undefined && isGenerativeStepClass(step.stepClass);
}
