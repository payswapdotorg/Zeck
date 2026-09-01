/**
 * Unit tests — the opportunity-analysis domain (WORK-022 / DTR-005).
 *
 * Covers the §19 deterministic-first discipline (the discriminating
 * rules), the §6 execution-graph provenance model (M11/M12/M27/M28),
 * the §15 confidence honesty (M13), the §12/§13 value-of-information
 * gate (M24/M25), the §14 rating shape (M10) and the §9/§18 finding
 * transition legality (M8/M9/M15/M16).
 */

import { describe, expect, test } from "vitest";
import {
  EVALUATION_RATING_ANSWERS,
  validateEvaluationRating,
} from "../../../src/modules/learning/domain/evaluation-rating";
import {
  buildExecutionGraph,
  type ExecutionGraph,
  type SelectedSubgraph,
} from "../../../src/modules/learning/domain/execution-graph";
import {
  FINDING_TRANSITION_TABLE,
  type VerifiedEquivalenceEvidence,
  validateFindingTransition,
} from "../../../src/modules/learning/domain/finding-transitions";
import {
  DEFAULT_FRICTION_CONFIG,
  decideEvaluationPrompts,
  EVALUATION_QUESTIONS,
} from "../../../src/modules/learning/domain/human-evaluation";
import type { OpportunityFinding } from "../../../src/modules/learning/domain/opportunity-analysis";
import {
  buildFindings,
  CONFIDENCE_HIGH_POPULATION,
  classifyFindingConfidence,
  detectOpportunities,
  MINIMUM_DETERMINISTIC_POPULATION,
  OPPORTUNITY_CLASSES,
  validateOpportunityFinding,
} from "../../../src/modules/learning/domain/opportunity-analysis";
import { PlatformError } from "../../../src/shared/errors";

const REPO = "github.com/example/customer-app";
const REV = "commit-abc123";

function subgraphOf(
  nodes: {
    nodeId: string;
    kind: string;
    label?: string;
    observation?: Record<string, unknown>;
    revision?: string;
    provenance?: Record<string, unknown>;
  }[],
  edges: { fromNodeId: string; toNodeId: string; relation?: string }[] = [],
): SelectedSubgraph {
  return {
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      label: node.label ?? node.nodeId,
      provenance: {
        repository: REPO,
        revision: node.revision ?? REV,
        file: `src/${node.nodeId}.ts`,
        symbol: `fn${node.nodeId}`,
        ...(node.provenance ?? {}),
      },
      observation: {
        executionCount: 1,
        evidenceRefs: [`obs:${node.nodeId}`],
        ...(node.observation ?? {}),
      },
    })),
    edges: edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      relation: edge.relation ?? "calls",
    })),
  };
}

/** The §19 GREEN case: structured, low-variability, verified model call. */
function deterministicCandidateObservation(): Record<string, unknown> {
  return {
    executionCount: 40,
    errorRate: 0.02,
    inputVariability: "low",
    semanticComplexity: "low",
    distinctInputCount: 5,
    distinctOutputCount: 5,
    verificationPassCount: 38,
    verificationFailCount: 2,
    observedCostMicroUsd: "12000",
    observedLatencyMs: 900,
  };
}

/** The §19 RED case: genuinely semantic work (AI is necessary). */
function genuinelySemanticObservation(): Record<string, unknown> {
  return {
    executionCount: 40,
    errorRate: 0.05,
    inputVariability: "high",
    semanticComplexity: "high",
    verificationPassCount: 36,
    verificationFailCount: 4,
    observedCostMicroUsd: "90000",
    observedLatencyMs: 4000,
  };
}

function graphOf(
  nodes: Parameters<typeof subgraphOf>[0],
  edges: Parameters<typeof subgraphOf>[1] = [],
): ExecutionGraph {
  return buildExecutionGraph({
    ...subgraphOf(nodes, edges),
    source: { repository: REPO, revision: REV },
  });
}

describe("execution graph (§6/§7)", () => {
  test("builds the normalized graph with full provenance (M11/M12)", () => {
    const graph = graphOf([
      { nodeId: "fn-a", kind: "function", observation: { executionCount: 12 } },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.provenance.repository).toBe(REPO);
    expect(graph.nodes[0]?.provenance.revision).toBe(REV);
    expect(graph.nodes[0]?.provenance.symbol).toBe("fnfn-a");
    expect(graph.nodes[0]?.observation.executionCount).toBe(12);
    expect(graph.schemaVersion).toBe(1);
  });

  test("rejects a node without provenance (M11: provenance never omitted)", () => {
    const selection = subgraphOf([{ nodeId: "fn-a", kind: "function" }]);
    delete (selection.nodes[0] as { provenance?: unknown }).provenance;
    expect(() =>
      buildExecutionGraph({ ...selection, source: { repository: REPO, revision: REV } }),
    ).toThrowError(PlatformError);
  });

  test("rejects mixed/stale revisions (M28)", () => {
    expect(() =>
      graphOf([
        {
          nodeId: "fn-a",
          kind: "function",
          revision: "commit-OTHER",
          observation: { executionCount: 12 },
        },
      ]),
    ).toThrowError(/stale\/mixed revisions/i);
  });

  test("rejects duplicate node ids (M27: identity preserved)", () => {
    expect(() =>
      graphOf([
        { nodeId: "fn-a", kind: "function", observation: { executionCount: 12 } },
        { nodeId: "fn-a", kind: "model-call", observation: { executionCount: 12 } },
      ]),
    ).toThrowError(/duplicate node id/i);
  });

  test("rejects edges outside the selection (§7: exact selection only)", () => {
    expect(() =>
      graphOf(
        [{ nodeId: "fn-a", kind: "function", observation: { executionCount: 12 } }],
        [{ fromNodeId: "fn-a", toNodeId: "fn-outside" }],
      ),
    ).toThrowError(/outside the selection/i);
  });

  test("rejects unknown node kinds (closed vocabulary)", () => {
    expect(() =>
      graphOf([{ nodeId: "fn-a", kind: "magic", observation: { executionCount: 12 } }]),
    ).toThrowError(/closed execution-graph vocabulary/i);
  });

  test("rejects observations without evidence refs (M11)", () => {
    expect(() =>
      graphOf([
        {
          nodeId: "fn-a",
          kind: "function",
          observation: { executionCount: 12, evidenceRefs: [] },
        },
      ]),
    ).toThrowError(/evidenceRefs/i);
  });
});

describe("detection: the deterministic-first discipline (§19)", () => {
  test("GREEN: a structured, verified, low-variability model call gets deterministic-replacement", () => {
    const graph = graphOf([
      {
        nodeId: "llm-1",
        kind: "model-call",
        observation: deterministicCandidateObservation(),
      },
    ]);
    const findings = detectOpportunities(graph);
    const replacement = findings.find((f) => f.class === "deterministic-replacement");
    expect(replacement).toBeDefined();
    expect(replacement?.targetNodeIds).toEqual(["llm-1"]);
    expect(replacement?.equivalence.potential).toBe("candidate-replacement");
    expect(replacement?.reasonCodes).toContain("low-input-variability");
    expect(replacement?.validationSteps.join(" ")).toMatch(/differential-evaluation/);
  });

  test("RED: a genuinely semantic model call gets NO deterministic replacement (even though deterministic is cheaper)", () => {
    const graph = graphOf([
      { nodeId: "llm-2", kind: "model-call", observation: genuinelySemanticObservation() },
    ]);
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "deterministic-replacement")).toBeUndefined();
    expect(findings.find((f) => f.class === "ai-removal")).toBeUndefined();
    // High input variability ALSO blocks the hybrid decomposition (the
    // deterministic envelope of a hybrid assumes bounded input shape).
    expect(findings.find((f) => f.class === "hybrid-decomposition")).toBeUndefined();
  });

  test("hybrid decomposition fires for LOW-variability semantic work (the regular envelope + AI core)", () => {
    const graph = graphOf([
      {
        nodeId: "llm-2b",
        kind: "model-call",
        observation: {
          ...genuinelySemanticObservation(),
          inputVariability: "low",
        },
      },
    ]);
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "hybrid-decomposition")).toBeDefined();
    expect(findings.find((f) => f.class === "deterministic-replacement")).toBeUndefined();
  });

  test("RED: high input variability blocks deterministic replacement regardless of cost", () => {
    const graph = graphOf([
      {
        nodeId: "llm-3",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          inputVariability: "high",
          semanticComplexity: "low",
        },
      },
    ]);
    expect(
      detectOpportunities(graph).find((f) => f.class === "deterministic-replacement"),
    ).toBeUndefined();
  });

  test("RED: sparse population blocks deterministic replacement (population floor)", () => {
    const graph = graphOf([
      {
        nodeId: "llm-4",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          executionCount: MINIMUM_DETERMINISTIC_POPULATION - 1,
        },
      },
    ]);
    expect(
      detectOpportunities(graph).find((f) => f.class === "deterministic-replacement"),
    ).toBeUndefined();
  });

  test("ai-removal ONLY on observed constant output (M29: materially different behavior blocks removal)", () => {
    const graph = graphOf([
      {
        nodeId: "llm-5",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          constantOutput: true,
          distinctOutputCount: 1,
        },
      },
    ]);
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "ai-removal")).toBeDefined();
    const varying = graphOf([
      {
        nodeId: "llm-6",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          constantOutput: false,
          distinctOutputCount: 12,
        },
      },
    ]);
    expect(detectOpportunities(varying).find((f) => f.class === "ai-removal")).toBeUndefined();
  });

  test("cacheable repeated inputs surface the cache reason code", () => {
    const graph = graphOf([
      {
        nodeId: "llm-7",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          distinctInputCount: 2,
        },
      },
    ]);
    const findings = detectOpportunities(graph);
    const replacement = findings.find((f) => f.class === "deterministic-replacement");
    expect(replacement?.reasonCodes).toContain("cacheable-repeated-inputs");
  });

  test("M30: model output feeding external side effects carries the side-effect boundary", () => {
    const graph = graphOf(
      [
        { nodeId: "llm-8", kind: "model-call", observation: deterministicCandidateObservation() },
        { nodeId: "fx-1", kind: "external-side-effect", observation: { executionCount: 40 } },
      ],
      [{ fromNodeId: "llm-8", toNodeId: "fx-1", relation: "feeds" }],
    );
    const findings = detectOpportunities(graph);
    const replacement = findings.find((f) => f.class === "deterministic-replacement");
    expect(replacement?.reasonCodes).toContain("side-effect-boundary");
    expect(replacement?.validationSteps.join(" ")).toMatch(/side-effect equivalence/);
  });

  test("tool-replacement for the LLM-as-parser antipattern (§7 canonical shape)", () => {
    const graph = graphOf(
      [
        {
          nodeId: "llm-9",
          kind: "model-call",
          observation: genuinelySemanticObservation(),
        },
        { nodeId: "parse-1", kind: "deterministic", observation: { executionCount: 40 } },
        { nodeId: "db-1", kind: "data-access", observation: { executionCount: 40 } },
      ],
      [
        { fromNodeId: "llm-9", toNodeId: "parse-1", relation: "feeds" },
        { fromNodeId: "parse-1", toNodeId: "db-1", relation: "feeds" },
      ],
    );
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "tool-replacement")).toBeDefined();
  });

  test("tool-composition for consecutive tool calls", () => {
    const graph = graphOf(
      [
        { nodeId: "tool-1", kind: "tool-call", observation: { executionCount: 20 } },
        { nodeId: "tool-2", kind: "tool-call", observation: { executionCount: 20 } },
      ],
      [{ fromNodeId: "tool-1", toNodeId: "tool-2", relation: "feeds" }],
    );
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "tool-composition")).toBeDefined();
  });

  test("verification-enhancement for unverified model calls", () => {
    const graph = graphOf([
      {
        nodeId: "llm-10",
        kind: "model-call",
        observation: {
          executionCount: 40,
          errorRate: 0.1,
          inputVariability: "high",
          semanticComplexity: "high",
        },
      },
    ]);
    expect(
      detectOpportunities(graph).find((f) => f.class === "verification-enhancement"),
    ).toBeDefined();
  });

  test("context-enhancement for high-error semantic model calls", () => {
    const graph = graphOf([
      {
        nodeId: "llm-11",
        kind: "model-call",
        observation: { ...genuinelySemanticObservation(), errorRate: 0.5 },
      },
    ]);
    expect(detectOpportunities(graph).find((f) => f.class === "context-enhancement")).toBeDefined();
  });

  test("ai-addition for a failing deterministic implementation of semantic work", () => {
    const graph = graphOf([
      {
        nodeId: "rule-1",
        kind: "deterministic",
        observation: {
          executionCount: 30,
          errorRate: 0.6,
          semanticComplexity: "high",
        },
      },
    ]);
    expect(detectOpportunities(graph).find((f) => f.class === "ai-addition")).toBeDefined();
  });

  test("human-evaluation opportunity for a low-confidence removal candidate (sparse population)", () => {
    // The reachable sparse path: an observed-constant model call with a
    // tiny population (the removal fires on observed evidence, the
    // confidence honestly reports the sparse population, and the VOI
    // question becomes the smallest useful next step).
    const graph = graphOf([
      {
        nodeId: "llm-12",
        kind: "model-call",
        observation: {
          executionCount: 4,
          errorRate: 0.02,
          inputVariability: "low",
          semanticComplexity: "low",
          distinctInputCount: 2,
          distinctOutputCount: 1,
          constantOutput: true,
          verificationPassCount: 3,
          verificationFailCount: 1,
        },
      },
    ]);
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "ai-removal")).toBeDefined();
    expect(findings.find((f) => f.class === "human-evaluation")).toBeDefined();
    // The population floor keeps the sparse observation from becoming a
    // deterministic-replacement recommendation (§9: frequency is an
    // evidence axis, not an assumption).
    expect(findings.find((f) => f.class === "deterministic-replacement")).toBeUndefined();
  });

  test("a medium-confidence replacement candidate is NOT a human-evaluation opportunity (M24)", () => {
    const graph = graphOf([
      {
        nodeId: "llm-12b",
        kind: "model-call",
        observation: {
          ...deterministicCandidateObservation(),
          executionCount: 12,
        },
      },
    ]);
    const findings = detectOpportunities(graph);
    expect(findings.find((f) => f.class === "deterministic-replacement")).toBeDefined();
    expect(findings.find((f) => f.class === "human-evaluation")).toBeUndefined();
  });

  test("detection is deterministic (same graph -> same findings)", () => {
    const graph = graphOf([
      { nodeId: "llm-13", kind: "model-call", observation: deterministicCandidateObservation() },
    ]);
    const first = detectOpportunities(graph);
    const second = detectOpportunities(graph);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("confidence honesty (§15/M13)", () => {
  const node = (executionCount: number, extras: Record<string, unknown> = {}) => {
    const nodes = graphOf([
      { nodeId: "n", kind: "model-call", observation: { executionCount, ...extras } },
    ]).nodes;
    const first = nodes[0];
    if (first === undefined) {
      throw new Error("graph must carry the node");
    }
    return first;
  };

  test("tiny populations are inconclusive (M13)", () => {
    expect(classifyFindingConfidence(node(1)).level).toBe("inconclusive");
    expect(classifyFindingConfidence(node(2)).level).toBe("inconclusive");
  });

  test("sparse populations are low, not high (M13)", () => {
    expect(classifyFindingConfidence(node(3)).level).toBe("low");
  });

  test("high requires verification AND error-rate observations", () => {
    expect(classifyFindingConfidence(node(CONFIDENCE_HIGH_POPULATION)).level).toBe("medium");
    expect(
      classifyFindingConfidence(
        node(CONFIDENCE_HIGH_POPULATION, { errorRate: 0.1, verificationPassCount: 30 }),
      ).level,
    ).toBe("high");
  });
});

describe("findings materialization (§8/§11/§15/§16)", () => {
  test("findings are born advisory with provenance, evidence and honest impact (M22/M23)", () => {
    const graph = graphOf([
      { nodeId: "llm-14", kind: "model-call", observation: deterministicCandidateObservation() },
    ]);
    const findings = buildFindings({
      analysisId: "analysis-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      graph,
      generateFindingId: (() => {
        let n = 0;
        return () => `finding-${++n}`;
      })(),
      recordedAt: "2026-09-20T12:00:00Z",
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.state).toBe("advisory");
      expect(finding.provenance.repository).toBe(REPO);
      expect(finding.provenance.revision).toBe(REV);
      expect(finding.provenance.targets.length).toBeGreaterThan(0);
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      // Cost basis: current measured, candidate unknown — never invented.
      expect(finding.costImpact.basis).toBe("measured");
      expect(finding.costImpact.currentMicroUsd).toBe("12000");
      expect(finding.costImpact.candidateMicroUsd).toBeNull();
      expect(finding.costImpact.expectedSavingsMicroUsd).toBeNull();
      expect(finding.latencyImpact.basis).toBe("measured");
      expect(finding.latencyImpact.candidateMs).toBeNull();
      expect(finding.confidence.population).toBe(40);
      expect(finding.deterministicEquivalence.potential).not.toBe("verified-equivalent");
      validateOpportunityFinding(finding);
    }
  });

  test("unknown observations produce unknown-impact findings (M22/M23: never fabricated)", () => {
    const graph = graphOf([
      {
        nodeId: "llm-15",
        kind: "model-call",
        observation: {
          executionCount: 40,
          errorRate: 0.1,
          inputVariability: "high",
          semanticComplexity: "high",
        },
      },
    ]);
    const findings = buildFindings({
      analysisId: "analysis-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      graph,
      generateFindingId: () => "finding-x",
      recordedAt: "2026-09-20T12:00:00Z",
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.costImpact.basis).toBe("unknown");
      expect(finding.costImpact.currentMicroUsd).toBeNull();
    }
  });
});

describe("the value-of-information gate (§12/§13)", () => {
  const findingOf = (level: string, over: Record<string, unknown> = {}): OpportunityFinding =>
    ({
      findingId: "finding-1",
      analysisId: "analysis-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      class: "deterministic-replacement",
      targetNodeIds: ["llm-1"],
      reasonCodes: ["r"],
      evidenceRefs: ["ev"],
      provenance: {
        repository: REPO,
        revision: REV,
        targets: [{ nodeId: "llm-1", file: "src/a.ts", symbol: null }],
      },
      confidence: { level, population: 40, basis: "b" },
      costImpact: {
        currentMicroUsd: "1",
        candidateMicroUsd: null,
        expectedSavingsMicroUsd: null,
        basis: "measured",
        basisRefs: ["ev"],
      },
      latencyImpact: { currentMs: 1, candidateMs: null, basis: "measured", basisRefs: ["ev"] },
      state: "advisory",
      deterministicEquivalence: { potential: "candidate-replacement", basis: ["b"] },
      recommendation: { strategy: "s", validationSteps: ["v"] },
      recordedAt: "2026-09-20T12:00:00Z",
      schemaVersion: 1,
      ...over,
    }) as unknown as OpportunityFinding;

  test("M24: sufficient evidence (medium/high) NEVER prompts", () => {
    for (const level of ["medium", "high"]) {
      const prompts = decideEvaluationPrompts([findingOf(level)], DEFAULT_FRICTION_CONFIG);
      expect(prompts).toHaveLength(0);
    }
  });

  test("M25: material uncertainty ALWAYS prompts at the default threshold", () => {
    for (const level of ["low", "inconclusive"]) {
      const prompts = decideEvaluationPrompts([findingOf(level)], DEFAULT_FRICTION_CONFIG);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.question).toBe(EVALUATION_QUESTIONS["behavior-preservation"]);
      expect(prompts[0]?.expectedInformationGain).toBeGreaterThan(
        prompts[0]?.userFrictionThreshold ?? 0,
      );
    }
  });

  test("a high friction threshold suppresses low-gain prompts (the configured tradeoff)", () => {
    const prompts = decideEvaluationPrompts([findingOf("low")], {
      userFrictionThreshold: 0.7,
      maxPrompts: 4,
    });
    expect(prompts).toHaveLength(0);
  });

  test("prompts are bounded by maxPrompts and deterministically ordered", () => {
    const findings = [findingOf("low"), findingOf("inconclusive")].map((f, i) => ({
      ...f,
      findingId: `finding-${i + 1}`,
    }));
    const prompts = decideEvaluationPrompts(findings, {
      userFrictionThreshold: 0.1,
      maxPrompts: 1,
    });
    expect(prompts).toHaveLength(1);
    // Highest gain first: inconclusive (0.9) beats low (0.6).
    expect(prompts[0]?.expectedInformationGain).toBe(0.9);
  });

  test("immaterial uncertain findings do not prompt", () => {
    const immaterial = {
      ...findingOf("low"),
      class: "verification-enhancement",
      costImpact: {
        currentMicroUsd: null,
        candidateMicroUsd: null,
        expectedSavingsMicroUsd: null,
        basis: "unknown",
        basisRefs: ["ev"],
      },
      latencyImpact: { currentMs: null, candidateMs: null, basis: "unknown", basisRefs: ["ev"] },
    } as OpportunityFinding;
    expect(decideEvaluationPrompts([immaterial], DEFAULT_FRICTION_CONFIG)).toHaveLength(0);
  });
});

describe("evaluation ratings (§14)", () => {
  const ratingBase = {
    ratingId: "rating-1",
    applicationId: "app-1",
    tenantId: "tenant-1",
    analysisId: "analysis-1",
    findingId: "finding-1",
    counterpartFindingId: null,
    executionId: "execution-1",
    promptId: null,
    rater: "rater-1",
    questionKind: "behavior-preservation" as const,
    answer: "prefer-candidate" as const,
    sourceRevision: REV,
    context: {
      repository: REPO,
      targetNodeIds: ["llm-1"],
      findingClass: "deterministic-replacement",
      population: 40,
    },
    evidenceRefs: ["ev-1"],
    provenance: { submittedVia: "api" },
    recordedAt: "2026-09-20T12:00:00Z",
    schemaVersion: 1,
  };

  test("the answer vocabulary is preference-only (M10: no PASS/FAIL)", () => {
    expect([...EVALUATION_RATING_ANSWERS]).toEqual([
      "prefer-candidate",
      "prefer-baseline",
      "no-difference",
      "insufficient-information",
    ]);
    expect(EVALUATION_RATING_ANSWERS.includes("PASS" as never)).toBe(false);
    validateEvaluationRating(ratingBase);
  });

  test("fails closed on missing revision (M12/M28)", () => {
    expect(() => validateEvaluationRating({ ...ratingBase, sourceRevision: "" })).toThrowError(
      /sourceRevision/i,
    );
  });

  test("fails closed on a PASS-shaped answer (M10)", () => {
    expect(() => validateEvaluationRating({ ...ratingBase, answer: "PASS" })).toThrowError(
      /preference-only/i,
    );
  });

  test("fails closed on missing context/exec (§14 set)", () => {
    expect(() => validateEvaluationRating({ ...ratingBase, executionId: "" })).toThrowError();
    const { context, ...withoutContext } = ratingBase;
    void context;
    expect(() => validateEvaluationRating(withoutContext)).toThrowError(/context/i);
  });
});

describe("finding transitions (§9/§18)", () => {
  const findingOf = (state: string, level = "medium"): OpportunityFinding =>
    ({
      findingId: "finding-1",
      analysisId: "analysis-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      class: "deterministic-replacement",
      targetNodeIds: ["llm-1"],
      reasonCodes: ["r"],
      evidenceRefs: ["ev"],
      provenance: {
        repository: REPO,
        revision: REV,
        targets: [{ nodeId: "llm-1", file: "src/a.ts", symbol: null }],
      },
      confidence: { level, population: 40, basis: "b" },
      costImpact: {
        currentMicroUsd: "1",
        candidateMicroUsd: null,
        expectedSavingsMicroUsd: null,
        basis: "measured",
        basisRefs: ["ev"],
      },
      latencyImpact: { currentMs: 1, candidateMs: null, basis: "measured", basisRefs: ["ev"] },
      state,
      deterministicEquivalence: { potential: "candidate-replacement", basis: ["b"] },
      recommendation: { strategy: "s", validationSteps: ["v"] },
      recordedAt: "2026-09-20T12:00:00Z",
      schemaVersion: 1,
    }) as unknown as OpportunityFinding;

  const equivalence = (
    over: Partial<VerifiedEquivalenceEvidence> = {},
  ): VerifiedEquivalenceEvidence => ({
    comparisonId: "comparison-1",
    comparedRevision: REV,
    baselineObservations: 40,
    candidateObservations: 40,
    comparisonStatus: "PASS",
    populationsComparable: true,
    evidenceRefs: ["cmp-1"],
    ...over,
  });

  test("the frozen table is advisory->candidate->verified only (M16/M18)", () => {
    expect(FINDING_TRANSITION_TABLE).toEqual([
      { from: "advisory", to: "candidate", evidenceKind: "rating" },
      { from: "candidate", to: "verified", evidenceKind: "verified-equivalence" },
    ]);
  });

  test("M16: advisory -> verified (state skipping) is rejected", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("advisory"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence(),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/illegal finding transition/i);
  });

  test("M18: 'promoted' is not a reachable state", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("verified"),
        toState: "promoted",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence(),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/promoted/i);
  });

  test("M9: rating evidence can only produce candidate — never verified", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "rating",
        evidenceRefs: ["rating-1"],
        verifiedEquivalence: null,
        requestedBy: "actor-1",
      }),
    ).toThrowError(/requires verified-equivalence evidence/i);
  });

  test("M15: verified without equivalence evidence is rejected", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: undefined,
        requestedBy: "actor-1",
      }),
    ).toThrowError(/verified-equivalence evidence is REQUIRED/i);
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence({ comparisonStatus: "INCONCLUSIVE" }),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/cannot verify/i);
  });

  test("M28: a comparison at a different revision never verifies", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence({ comparedRevision: "commit-OTHER" }),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/stale revisions never verify/i);
  });

  test("M14: incomparable populations never verify", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence({ populationsComparable: false }),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/comparable populations/i);
  });

  test("M8: a low-confidence finding cannot be verified", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate", "low"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence(),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/low-confidence finding cannot be verified/i);
  });

  test("the legal path: advisory -> candidate -> verified with real evidence", () => {
    const candidate = validateFindingTransition({
      finding: findingOf("advisory"),
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: ["rating-1"],
      verifiedEquivalence: null,
      requestedBy: "actor-1",
    });
    expect(candidate.toState).toBe("candidate");
    const verified = validateFindingTransition({
      finding: findingOf("candidate"),
      toState: "verified",
      evidenceKind: "verified-equivalence",
      evidenceRefs: ["cmp-1"],
      verifiedEquivalence: equivalence(),
      requestedBy: "actor-1",
    });
    expect(verified.toState).toBe("verified");
  });

  test("the comparison population must cover the finding population", () => {
    expect(() =>
      validateFindingTransition({
        finding: findingOf("candidate"),
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp-1"],
        verifiedEquivalence: equivalence({ baselineObservations: 10 }),
        requestedBy: "actor-1",
      }),
    ).toThrowError(/smaller than the finding's evidence population/i);
  });
});

describe("opportunity class vocabulary (§8)", () => {
  test("the nine classes are exactly the Work Order list", () => {
    expect([...OPPORTUNITY_CLASSES]).toEqual([
      "ai-addition",
      "ai-removal",
      "deterministic-replacement",
      "tool-replacement",
      "tool-composition",
      "hybrid-decomposition",
      "context-enhancement",
      "verification-enhancement",
      "human-evaluation",
    ]);
  });
});
