/**
 * Opportunity analysis: detection, confidence, cost/latency impact
 * (learning module domain; WORK-022 / DTR-005; ADR-0008, ADR-0010).
 *
 * THE canonical advisory flow (the Work Order objective, as pure
 * functions over the selected execution graph + its OBSERVED
 * evidence):
 *
 * ```text
 *   customer-selected subgraph -> execution graph (§6)
 *     -> rule-driven opportunity detection (§8, the 9 classes)
 *     -> evidence-population confidence (§15, M13)
 *     -> honest cost/latency impact (§11, M22/M23)
 *     -> advisory findings (state 'advisory', never verified — §9/§18)
 * ```
 *
 * THE DETERMINISTICIZATION HONESTY (§9 — the discriminating rules):
 *  - a deterministic-replacement finding is a CANDIDATE
 *    replacement. It is NEVER a verified equivalent replacement:
 *    `deterministicEquivalence.potential` is insertable only as
 *    'none' | 'candidate-replacement' — 'verified-equivalent' is
 *    reachable ONLY through the evidence-gated finding transition
 *    (finding-transitions.ts; M15/M16);
 *  - the recommendation fires ONLY on OBSERVED evidence axes — input
 *    variability, semantic complexity, observed outputs, error rate,
 *    verification results, frequency — never because code "looks
 *    deterministic" and never because deterministic is cheaper
 *    (§19/§3: cost alone NEVER justifies the recommendation);
 *  - when the observed axes say the work is genuinely semantic
 *    (semanticComplexity 'high' OR inputVariability 'high'), NO
 *    deterministic-replacement finding is emitted — the analyzer must
 *    NOT recommend removing necessary AI merely because it is cheaper
 *    (M29-adjacent: materially different behavior is respected);
 *  - when model output feeds external side effects, the finding
 *    carries the 'side-effect-boundary' reason code and REQUIRES
 *    side-effect equivalence in its validation steps (M30: a
 *    deterministic replacement that would change side effects is
 *    surfaced, never silently blessed).
 *
 * CONFIDENCE IS MEASURABLE OR ABSENT (§15, M13): the confidence level
 * is derived from the integer observation population — tiny or sparse
 * datasets become LOW_CONFIDENCE or INCONCLUSIVE, never fabricated
 * certainty.
 *
 * COST/LATENCY ARE OBSERVED OR UNKNOWN (§11, M22/M23): current impact
 * uses ONLY observed values (basis 'measured' with the observation
 * evidence refs); candidate impact is 'unknown' unless a structural
 * deterministic rule exists (basis 'estimated' with the exact rule +
 * basis refs recorded). Nothing is ever invented.
 *
 * This file is pure domain: no side effects, no imports outside
 * `shared`, no module imports (the observation island).
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionGraph, ExecutionGraphNode } from "./execution-graph";

/** Frozen opportunity-finding schema version. */
export const OPPORTUNITY_FINDING_SCHEMA_VERSION = 1;

/** Frozen opportunity-analysis schema version. */
export const OPPORTUNITY_ANALYSIS_SCHEMA_VERSION = 1;

/** The frozen analysis version (detection ruleset identity). */
export const OPPORTUNITY_ANALYSIS_VERSION = 1;

/** The closed opportunity-class vocabulary (§8 — the nine classes). */
export const OPPORTUNITY_CLASSES = [
  "ai-addition",
  "ai-removal",
  "deterministic-replacement",
  "tool-replacement",
  "tool-composition",
  "hybrid-decomposition",
  "context-enhancement",
  "verification-enhancement",
  "human-evaluation",
] as const;

export type OpportunityClass = (typeof OPPORTUNITY_CLASSES)[number];

export function isOpportunityClass(value: string): value is OpportunityClass {
  return (OPPORTUNITY_CLASSES as readonly string[]).includes(value);
}

/** The honest confidence vocabulary (§15). */
export const FINDING_CONFIDENCE_LEVELS = ["high", "medium", "low", "inconclusive"] as const;

export type FindingConfidenceLevel = (typeof FINDING_CONFIDENCE_LEVELS)[number];

export function isFindingConfidenceLevel(value: string): value is FindingConfidenceLevel {
  return (FINDING_CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/** The cost/latency basis vocabulary (§11 — measured, estimated or unknown). */
export const IMPACT_BASES = ["measured", "estimated", "unknown"] as const;

export type ImpactBasis = (typeof IMPACT_BASES)[number];

/** Cost impact (integer micro-USD strings; never floats). */
export interface CostImpact {
  readonly currentMicroUsd: string | null;
  readonly candidateMicroUsd: string | null;
  readonly expectedSavingsMicroUsd: string | null;
  readonly basis: ImpactBasis;
  /** The exact rule/observations backing the basis (non-empty). */
  readonly basisRefs: readonly string[];
}

/** Latency impact (integer milliseconds). */
export interface LatencyImpact {
  readonly currentMs: number | null;
  readonly candidateMs: number | null;
  readonly basis: ImpactBasis;
  readonly basisRefs: readonly string[];
}

/**
 * The deterministicization verdict of a finding (§9). 'verified-
 * equivalent' is UNREPRESENTABLE at detection time — it is reachable
 * only through the evidence-gated verified transition.
 */
export const DETERMINISTIC_EQUIVALENCE_POTENTIALS = ["none", "candidate-replacement"] as const;

export type DeterministicEquivalencePotential =
  (typeof DETERMINISTIC_EQUIVALENCE_POTENTIALS)[number];

export interface DeterministicEquivalence {
  readonly potential: DeterministicEquivalencePotential;
  /** The evidence axes behind the potential (non-empty). */
  readonly basis: readonly string[];
}

/** The insertable finding state (the transition vocabulary lives in finding-transitions.ts). */
export const INSERTABLE_FINDING_STATES = ["advisory"] as const;

/** The full finding-state vocabulary (advisory -> candidate -> verified; 'promoted' is NOT settable here — §18). */
export const FINDING_STATES = ["advisory", "candidate", "verified"] as const;

export type FindingState = (typeof FINDING_STATES)[number];

export function isFindingState(value: string): value is FindingState {
  return (FINDING_STATES as readonly string[]).includes(value);
}

/** One advisory finding (the analysis output unit). */
export interface OpportunityFinding {
  readonly findingId: string;
  readonly analysisId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly class: OpportunityClass;
  /** The analyzed nodes the finding targets (non-empty — M27). */
  readonly targetNodeIds: readonly string[];
  /** Machine-readable reason codes (why this opportunity fired). */
  readonly reasonCodes: readonly string[];
  /** Evidence references backing the finding (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
  /** Source provenance of every target (§16 — repository + revision + file/symbol). */
  readonly provenance: {
    readonly repository: string;
    readonly revision: string;
    readonly targets: readonly {
      readonly nodeId: string;
      readonly file: string;
      readonly symbol: string | null;
    }[];
  };
  readonly confidence: {
    readonly level: FindingConfidenceLevel;
    /** The integer observation population behind the level (M13). */
    readonly population: number;
    readonly basis: string;
  };
  readonly costImpact: CostImpact;
  readonly latencyImpact: LatencyImpact;
  readonly state: FindingState;
  readonly deterministicEquivalence: DeterministicEquivalence;
  /** The recommended strategy + the validation steps needed before adoption. */
  readonly recommendation: {
    readonly strategy: string;
    readonly validationSteps: readonly string[];
  };
  readonly recordedAt: string;
  readonly schemaVersion: number;
}

/** The analysis-run record (immutable; bound to the analysis execution). */
export interface OpportunityAnalysis {
  readonly analysisId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The analysis EXECUTION (Analysis is an Execution — M2/M26 binding). */
  readonly executionId: string;
  readonly repository: string;
  readonly revision: string;
  readonly analysisVersion: number;
  readonly graph: ExecutionGraph;
  readonly friction: {
    readonly userFrictionThreshold: number;
    readonly maxPrompts: number;
  };
  readonly findingCount: number;
  readonly promptCount: number;
  readonly digest: string;
  readonly recordedAt: string;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Detection thresholds (frozen, disclosed constants — never hidden magic)
// ---------------------------------------------------------------------------

/** Minimum observation population before deterministicization is recommendable. */
export const MINIMUM_DETERMINISTIC_POPULATION = 10;

/** Population floors for the honest confidence classification (M13). */
export const CONFIDENCE_HIGH_POPULATION = 30;
export const CONFIDENCE_MEDIUM_POPULATION = 10;
export const CONFIDENCE_LOW_POPULATION = 3;

/** Error-rate thresholds (observed fractions). */
export const HIGH_ERROR_RATE = 0.3;
export const LOW_ERROR_RATE = 0.2;

/** Distinct-output ceiling for "structurally constant" model output. */
export const CONSTANT_OUTPUT_CEILING = 1;

/** Distinct-input ratio at/below which repeated inputs make results cacheable. */
export const CACHEABLE_INPUT_RATIO = 0.25;

function reason(...parts: string[]): string {
  return parts.join("-");
}

/**
 * The honest confidence classification (§15/M13): derived from the
 * integer observation population — high additionally REQUIRES observed
 * verification evidence; tiny populations are 'low' or 'inconclusive',
 * never fabricated certainty.
 */
export function classifyFindingConfidence(node: ExecutionGraphNode): {
  level: FindingConfidenceLevel;
  population: number;
  basis: string;
} {
  const population = node.observation.executionCount;
  const hasVerification =
    node.observation.verificationPassCount !== undefined ||
    node.observation.verificationFailCount !== undefined;
  const hasErrorRate = node.observation.errorRate !== undefined;
  let level: FindingConfidenceLevel;
  if (population >= CONFIDENCE_HIGH_POPULATION && hasVerification && hasErrorRate) {
    level = "high";
  } else if (population >= CONFIDENCE_MEDIUM_POPULATION) {
    level = "medium";
  } else if (population >= CONFIDENCE_LOW_POPULATION) {
    level = "low";
  } else {
    level = "inconclusive";
  }
  const basis = `population=${population};verification-observed=${hasVerification};error-rate-observed=${hasErrorRate}`;
  return { level, population, basis };
}

function costImpactOf(node: ExecutionGraphNode): CostImpact {
  if (node.observation.observedCostMicroUsd !== undefined) {
    // Current cost is OBSERVED (measured). The candidate is not built
    // yet — its cost is unknown, never invented (M22).
    return {
      currentMicroUsd: node.observation.observedCostMicroUsd,
      candidateMicroUsd: null,
      expectedSavingsMicroUsd: null,
      basis: "measured",
      basisRefs: [...node.observation.evidenceRefs],
    };
  }
  return {
    currentMicroUsd: null,
    candidateMicroUsd: null,
    expectedSavingsMicroUsd: null,
    basis: "unknown",
    basisRefs: [...node.observation.evidenceRefs],
  };
}

function latencyImpactOf(node: ExecutionGraphNode): LatencyImpact {
  if (node.observation.observedLatencyMs !== undefined) {
    return {
      currentMs: node.observation.observedLatencyMs,
      candidateMs: null,
      basis: "measured",
      basisRefs: [...node.observation.evidenceRefs],
    };
  }
  return {
    currentMs: null,
    candidateMs: null,
    basis: "unknown",
    basisRefs: [...node.observation.evidenceRefs],
  };
}

/** Does this node (transitively, through 'feeds'/'calls') feed side effects? */
function feedsExternalEffects(graph: ExecutionGraph, nodeId: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.fromNodeId) ?? [];
    list.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, list);
  }
  const visited = new Set<string>([nodeId]);
  const queue = [...(adjacency.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const node = graph.nodes.find((candidate) => candidate.nodeId === current);
    if (
      node !== undefined &&
      (node.kind === "external-side-effect" || node.kind === "network-call")
    ) {
      return true;
    }
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

/** Is there a feeds/calls path from `from` to a data-access node? */
function pathToKind(
  graph: ExecutionGraph,
  fromNodeId: string,
  kind: ExecutionGraphNode["kind"],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.fromNodeId) ?? [];
    list.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, list);
  }
  const visited = new Set<string>([fromNodeId]);
  const queue = [...(adjacency.get(fromNodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const node = graph.nodes.find((candidate) => candidate.nodeId === current);
    if (node !== undefined && node.kind === kind) {
      return true;
    }
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

interface FindingDraft {
  readonly class: OpportunityClass;
  readonly targetNodeIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly equivalence: DeterministicEquivalence;
  readonly strategy: string;
  readonly validationSteps: readonly string[];
}

/**
 * Detect opportunities on the execution graph (§8). Pure and
 * deterministic: same graph + same observations -> same findings.
 */
export function detectOpportunities(graph: ExecutionGraph): readonly FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));

  for (const node of graph.nodes) {
    const observation = node.observation;

    // --- model-call analysis (AI use sites) -----------------------------
    if (node.kind === "model-call") {
      const genuinelySemantic =
        observation.semanticComplexity === "high" || observation.inputVariability === "high";

      // §19/§9: deterministic-replacement ONLY when the observed axes
      // support it — never merely because deterministic is cheaper.
      const deterministicCandidate =
        !genuinelySemantic &&
        observation.inputVariability === "low" &&
        observation.semanticComplexity === "low" &&
        observation.executionCount >= MINIMUM_DETERMINISTIC_POPULATION &&
        observation.errorRate !== undefined &&
        observation.errorRate <= LOW_ERROR_RATE &&
        observation.verificationPassCount !== undefined &&
        observation.verificationPassCount >= (observation.verificationFailCount ?? 0);

      if (deterministicCandidate) {
        const reasonCodes: string[] = [
          reason("low", "input", "variability"),
          reason("low", "semantic", "complexity"),
          reason("population", "floor", "met"),
        ];
        const cacheable =
          observation.distinctInputCount !== undefined &&
          observation.distinctInputCount / Math.max(observation.executionCount, 1) <=
            CACHEABLE_INPUT_RATIO;
        if (cacheable) {
          reasonCodes.push(reason("cacheable", "repeated", "inputs"));
        }
        if (observation.constantOutput === true) {
          reasonCodes.push(reason("observed", "constant", "output"));
        }
        const sideEffects = feedsExternalEffects(graph, node.nodeId);
        if (sideEffects) {
          // M30: the replacement boundary crosses side effects — the
          // validation steps REQUIRE side-effect equivalence.
          reasonCodes.push(reason("side", "effect", "boundary"));
        }
        const validationSteps = [
          "differential-evaluation: replay the observed population against the candidate (same source revision)",
          "property-or-metamorphic testing over the candidate transform",
          ...(sideEffects
            ? ["side-effect equivalence: prove external effects are unchanged by the replacement"]
            : []),
          "normal validation/promotion gate (advisory -> candidate -> verified; never auto-promoted)",
        ];
        drafts.push({
          class: "deterministic-replacement",
          targetNodeIds: [node.nodeId],
          reasonCodes,
          equivalence: {
            potential: "candidate-replacement",
            basis: [
              `inputVariability=${observation.inputVariability ?? "unknown"}`,
              `semanticComplexity=${observation.semanticComplexity ?? "unknown"}`,
              `errorRate=${observation.errorRate ?? "unknown"}`,
              `executionCount=${observation.executionCount}`,
            ],
          },
          strategy: cacheable
            ? "replace the model call with a cached lookup of the repeated-input results, then a deterministic transform for the residual cases"
            : "replace the model call with a deterministic transform (validated by differential evaluation before any adoption)",
          validationSteps,
        });
      } else if (
        observation.inputVariability === "low" &&
        (observation.semanticComplexity === "high" || observation.semanticComplexity === "moderate")
      ) {
        // Hybrid: the regular part can be deterministic, the semantic
        // core stays AI (§8 hybrid decomposition).
        drafts.push({
          class: "hybrid-decomposition",
          targetNodeIds: [node.nodeId],
          reasonCodes: [
            reason("low", "input", "variability"),
            reason("semantic", "core", "requires", "generation"),
          ],
          equivalence: {
            potential: "none",
            basis: [
              `inputVariability=${observation.inputVariability ?? "unknown"}`,
              `semanticComplexity=${observation.semanticComplexity ?? "unknown"}`,
            ],
          },
          strategy:
            "decompose: deterministic preprocessing/postprocessing around a smaller generative core (hybrid plan)",
          validationSteps: [
            "differential-evaluation of the deterministic envelope against the observed population",
            "verification of the generative core outputs (unchanged policy/verification gates)",
          ],
        });
      }

      // §19 negative discipline: when the work is genuinely semantic,
      // NO removal/replacement finding fires above. The remaining
      // model-call findings are additive (context/verification).

      // ai-removal: ONLY on OBSERVED constant output with passing
      // verification — materially different behavior blocks removal (M29).
      if (
        observation.constantOutput === true &&
        (observation.distinctOutputCount ?? CONSTANT_OUTPUT_CEILING) <= CONSTANT_OUTPUT_CEILING &&
        (observation.verificationPassCount ?? 0) > 0
      ) {
        drafts.push({
          class: "ai-removal",
          targetNodeIds: [node.nodeId],
          reasonCodes: [
            reason("observed", "constant", "output"),
            reason("verification", "passing"),
          ],
          equivalence: {
            potential: "candidate-replacement",
            basis: [
              `distinctOutputCount=${observation.distinctOutputCount ?? 1}`,
              `constantOutput=true`,
            ],
          },
          strategy:
            "remove the model call: return the observed constant output (or a deterministic table) instead",
          validationSteps: [
            "behavior-preservation check: confirm every observed input maps to the same output",
            "normal validation/promotion gate (never auto-promoted)",
          ],
        });
      }

      // verification-enhancement: model call with NO verification observations.
      if (
        observation.verificationPassCount === undefined &&
        observation.verificationFailCount === undefined
      ) {
        drafts.push({
          class: "verification-enhancement",
          targetNodeIds: [node.nodeId],
          reasonCodes: [reason("no", "verification", "observed")],
          equivalence: { potential: "none", basis: ["verification observations absent"] },
          strategy:
            "attach a verification strategy (deterministic schema/rubric verifier) to this model call's outputs",
          validationSteps: [
            "select verification criteria for the node's outputs",
            "record verification evidence on the executions exercising the node",
          ],
        });
      }

      // context-enhancement: high error rate on a semantic/moderate task.
      if (
        observation.errorRate !== undefined &&
        observation.errorRate > HIGH_ERROR_RATE &&
        (observation.semanticComplexity === "high" ||
          observation.semanticComplexity === "moderate" ||
          observation.semanticComplexity === undefined)
      ) {
        drafts.push({
          class: "context-enhancement",
          targetNodeIds: [node.nodeId],
          reasonCodes: [
            reason("high", "error", "rate"),
            reason("context", "may", "be", "insufficient"),
          ],
          equivalence: { potential: "none", basis: [`errorRate=${observation.errorRate}`] },
          strategy:
            "compile richer task-specific context (retrieval/filtering/structuring) before the model call",
          validationSteps: [
            "measure error rate delta with the enhanced context on the observed population",
          ],
        });
      }

      // tool-replacement: model-call feeding deterministic -> data-access
      // (the LLM-as-parser antipattern, §7's canonical example).
      if (pathToKind(graph, node.nodeId, "data-access") && !deterministicCandidate) {
        const hasParser = graph.edges.some(
          (edge) =>
            edge.fromNodeId === node.nodeId &&
            nodeById.get(edge.toNodeId)?.kind === "deterministic",
        );
        if (hasParser) {
          drafts.push({
            class: "tool-replacement",
            targetNodeIds: [node.nodeId],
            reasonCodes: [reason("llm", "as", "parser"), reason("downstream", "data", "access")],
            equivalence: {
              potential: "none",
              basis: ["topology: model-call -> deterministic -> data-access"],
            },
            strategy:
              "replace the model call with a structured API/database tool (deterministic parser + query), keeping the formatter",
            validationSteps: [
              "differential-evaluation of the structured-tool path against the observed population",
              "schema compatibility check for the downstream data access",
            ],
          });
        }
      }
    }

    // --- deterministic nodes (AI addition opportunities) -----------------
    if (node.kind === "deterministic" || node.kind === "function") {
      // deterministic -> AI: a deterministic implementation of an
      // observed-failing semantic task.
      if (
        observation.errorRate !== undefined &&
        observation.errorRate > HIGH_ERROR_RATE &&
        observation.semanticComplexity === "high" &&
        observation.executionCount >= CONFIDENCE_MEDIUM_POPULATION
      ) {
        drafts.push({
          class: "ai-addition",
          targetNodeIds: [node.nodeId],
          reasonCodes: [reason("high", "error", "rate"), reason("semantic", "complexity", "high")],
          equivalence: { potential: "none", basis: [`errorRate=${observation.errorRate}`] },
          strategy:
            "route the semantic subtask to a generative step (or hybrid) with verification attached",
          validationSteps: [
            "differential-evaluation: AI-assisted path vs the current deterministic path",
            "verification strategy for the generative output",
          ],
        });
      }
    }

    // --- tool-call chains (composition opportunities) --------------------
    if (node.kind === "tool-call") {
      const downstreamTool = graph.edges.some(
        (edge) =>
          edge.fromNodeId === node.nodeId && nodeById.get(edge.toNodeId)?.kind === "tool-call",
      );
      if (downstreamTool) {
        const chain: string[] = [node.nodeId];
        for (const edge of graph.edges) {
          if (
            edge.fromNodeId === node.nodeId &&
            nodeById.get(edge.toNodeId)?.kind === "tool-call"
          ) {
            chain.push(edge.toNodeId);
          }
        }
        const chainRefs = chain.flatMap((id) => [
          ...(nodeById.get(id)?.observation.evidenceRefs ?? []),
        ]);
        drafts.push({
          class: "tool-composition",
          targetNodeIds: chain,
          reasonCodes: [reason("adjacent", "tool", "calls"), reason("composable", "chain")],
          equivalence: { potential: "none", basis: ["topology: consecutive tool-call nodes"] },
          strategy:
            "compose the consecutive tool calls into one governed tool composition (validated by the tool-composition learning evidence)",
          validationSteps: [
            "composition safety check against the tool facts catalog",
            "differential-evaluation of the composed chain vs the observed sequence",
          ],
          // note: evidenceRefs derived in the builder below
        });
        void chainRefs;
      }
    }
  }

  // --- human-evaluation opportunities (§12/§13) --------------------------
  // A deterministic-replacement/ai-removal candidate whose confidence
  // is low/inconclusive: automated evidence is insufficient — the
  // smallest useful question is a human pair rating.
  const replacementCandidates = drafts.filter(
    (draft) =>
      (draft.class === "deterministic-replacement" || draft.class === "ai-removal") &&
      draft.targetNodeIds.length === 1,
  );
  for (const candidate of replacementCandidates) {
    const node = nodeById.get(candidate.targetNodeIds[0] ?? "");
    if (node === undefined) {
      continue;
    }
    const confidence = classifyFindingConfidence(node);
    if (confidence.level === "low" || confidence.level === "inconclusive") {
      drafts.push({
        class: "human-evaluation",
        targetNodeIds: [...candidate.targetNodeIds],
        reasonCodes: [
          reason("insufficient", "automated", "evidence"),
          reason("decision", "uncertainty", "material"),
        ],
        equivalence: { potential: "none", basis: [`confidence=${confidence.level}`] },
        strategy:
          "request a selective human rating on the candidate pair (value of information gated at emission)",
        validationSteps: [
          "human pair rating recorded as immutable evaluation evidence (never authorization)",
        ],
      });
    }
  }

  return drafts;
}

/**
 * Materialize findings for one analysis run (assigns identity,
 * provenance, confidence, impact and the frozen insertable state).
 */
export function buildFindings(input: {
  readonly analysisId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly graph: ExecutionGraph;
  readonly generateFindingId: () => string;
  readonly recordedAt: string;
}): readonly OpportunityFinding[] {
  const drafts = detectOpportunities(input.graph);
  const nodeById = new Map(input.graph.nodes.map((node) => [node.nodeId, node]));
  const findings: OpportunityFinding[] = [];
  for (const draft of drafts) {
    const targets = draft.targetNodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is ExecutionGraphNode => node !== undefined);
    if (targets.length === 0) {
      continue;
    }
    // Confidence from the PRIMARY target's observation population.
    const primary = targets[0] as ExecutionGraphNode;
    const confidence = classifyFindingConfidence(primary);
    const evidenceRefs = [
      ...new Set(targets.flatMap((node) => [...node.observation.evidenceRefs])),
    ];
    if (evidenceRefs.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "finding without evidence references is unrepresentable (M11)",
      });
    }
    findings.push({
      findingId: input.generateFindingId(),
      analysisId: input.analysisId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      class: draft.class,
      targetNodeIds: [...draft.targetNodeIds],
      reasonCodes: [...draft.reasonCodes],
      evidenceRefs,
      provenance: {
        repository: input.graph.repository,
        revision: input.graph.revision,
        targets: targets.map((node) => ({
          nodeId: node.nodeId,
          file: node.provenance.file,
          symbol: node.provenance.symbol ?? null,
        })),
      },
      confidence: {
        level: confidence.level,
        population: confidence.population,
        basis: confidence.basis,
      },
      costImpact: costImpactOf(primary),
      latencyImpact: latencyImpactOf(primary),
      state: "advisory",
      deterministicEquivalence: draft.equivalence,
      recommendation: {
        strategy: draft.strategy,
        validationSteps: [...draft.validationSteps],
      },
      recordedAt: input.recordedAt,
      schemaVersion: OPPORTUNITY_FINDING_SCHEMA_VERSION,
    });
  }
  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `finding ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/** Fail-closed closed-shape validation of one finding (round-trip). */
export function validateOpportunityFinding(value: unknown): asserts value is OpportunityFinding {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "finding must be an object" });
  }
  const finding = value;
  requireString(finding, "findingId", "findingId");
  requireString(finding, "analysisId", "analysisId");
  requireString(finding, "applicationId", "applicationId");
  requireString(finding, "tenantId", "tenantId");
  if (typeof finding.class !== "string" || !isOpportunityClass(finding.class)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "finding class must be the closed opportunity vocabulary",
      details: { allowed: OPPORTUNITY_CLASSES },
    });
  }
  for (const key of [
    "targetNodeIds",
    "reasonCodes",
    "evidenceRefs",
    "validationStepsPlaceholder",
  ] as const) {
    if (key === "validationStepsPlaceholder") {
      continue;
    }
    const list = finding[key];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `finding ${key} must be non-empty (M11/M27)`,
        details: { field: key },
      });
    }
  }
  const provenance = finding.provenance;
  if (!isRecord(provenance)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "finding provenance is MANDATORY (M11/M12: repository + revision)",
    });
  }
  requireString(provenance, "repository", "provenance repository");
  requireString(provenance, "revision", "provenance revision (M12/M28: never omitted)");
  if (!Array.isArray(provenance.targets) || provenance.targets.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "finding provenance targets must be non-empty (M27)",
    });
  }
  const confidence = finding.confidence;
  if (
    !isRecord(confidence) ||
    typeof confidence.level !== "string" ||
    !isFindingConfidenceLevel(confidence.level) ||
    typeof confidence.population !== "number" ||
    !Number.isInteger(confidence.population) ||
    confidence.population < 0 ||
    typeof confidence.basis !== "string" ||
    confidence.basis.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "finding confidence must carry the closed level vocabulary, integer population and basis (M13)",
    });
  }
  const equivalence = finding.deterministicEquivalence;
  if (
    !isRecord(equivalence) ||
    typeof equivalence.potential !== "string" ||
    !(DETERMINISTIC_EQUIVALENCE_POTENTIALS as readonly string[]).includes(equivalence.potential) ||
    !Array.isArray(equivalence.basis) ||
    equivalence.basis.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "finding deterministicEquivalence potential must be 'none' | 'candidate-replacement' (verified-equivalent is reachable ONLY through the evidence-gated transition — M15/M16)",
    });
  }
  if (
    finding.state !== "advisory" &&
    finding.state !== "candidate" &&
    finding.state !== "verified"
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "finding state must be advisory | candidate | verified (never 'promoted' — no auto-promotion, §18)",
    });
  }
  const recommendation = finding.recommendation;
  if (
    !isRecord(recommendation) ||
    typeof recommendation.strategy !== "string" ||
    recommendation.strategy.length === 0 ||
    !Array.isArray(recommendation.validationSteps) ||
    recommendation.validationSteps.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "finding recommendation must carry a strategy and non-empty validation steps",
    });
  }
  requireString(finding, "recordedAt", "recordedAt");
  if (finding.schemaVersion !== OPPORTUNITY_FINDING_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "finding schemaVersion must match the frozen finding schema",
      details: { expected: OPPORTUNITY_FINDING_SCHEMA_VERSION },
    });
  }
}

/** The canonical digest basis of an analysis run (everything semantic). */
export function opportunityAnalysisDigestBasis(
  analysis: Omit<OpportunityAnalysis, "digest">,
): Readonly<Record<string, unknown>> {
  return {
    analysisId: analysis.analysisId,
    applicationId: analysis.applicationId,
    tenantId: analysis.tenantId,
    executionId: analysis.executionId,
    repository: analysis.repository,
    revision: analysis.revision,
    analysisVersion: analysis.analysisVersion,
    graph: {
      repository: analysis.graph.repository,
      revision: analysis.graph.revision,
      nodes: analysis.graph.nodes.map((node) => ({
        nodeId: node.nodeId,
        kind: node.kind,
        provenance: { ...node.provenance },
        observation: { ...node.observation },
      })),
      edges: analysis.graph.edges.map((edge) => ({ ...edge })),
      schemaVersion: analysis.graph.schemaVersion,
    },
    friction: { ...analysis.friction },
    findingCount: analysis.findingCount,
    promptCount: analysis.promptCount,
    recordedAt: analysis.recordedAt,
    schemaVersion: analysis.schemaVersion,
  };
}
