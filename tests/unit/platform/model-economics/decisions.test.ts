/**
 * Decision-record construction unit tests (WORK-053): the WORK-049
 * evidence contract over every model-economics selection — the
 * evidence-honest corpus (below-assurance recorded with invalid
 * evaluations; hard violators excluded), the derived transformation
 * basis (identity when the incumbent representation is kept), the
 * foundation's total validation round-trip, content-addressed
 * determinism (byte-identical records; recordedAt outside the
 * decisionId coverage), and the fail-closed record rules.
 */

import { describe, expect, test } from "vitest";
import { validateOptimizationDecision } from "../../../../src/platform/execution-ir/decision-record";
import { selectAgentStrategy } from "../../../../src/platform/model-economics/agent-gate";
import {
  buildAgentGateDecisionRecord,
  buildEffortDecisionRecord,
  buildFreshEscalationDecisionRecord,
  buildModelDecisionRecord,
  buildServiceClassDecisionRecord,
  type DecisionRecordScope,
} from "../../../../src/platform/model-economics/decisions";
import { selectReasoningEffort } from "../../../../src/platform/model-economics/effort-selection";
import { decideFreshEscalation } from "../../../../src/platform/model-economics/escalation-hooks";
import { selectModelRepresentation } from "../../../../src/platform/model-economics/model-selection";
import { selectServiceClass } from "../../../../src/platform/model-economics/service-class";
import type {
  EffortCandidate,
  ModelCandidate,
  ModelEconomicsError,
  ServiceClassCandidate,
} from "../../../../src/platform/model-economics/vocabulary";
import {
  APPLICATION_ID,
  claim,
  constraints,
  EXECUTION_ID,
  governedIr,
  nodeDigest,
  RECORDED_AT,
  TENANT_ID,
} from "./world";

const STEP = "generate";

function scope(recordedAt = RECORDED_AT): DecisionRecordScope {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    recordedAt,
  };
}

const MODEL_CANDIDATES: ModelCandidate[] = [
  {
    candidateId: "rail-a-incumbent",
    route: { provider: "rail-a", model: "model-x" },
    representationClass: "sufficient-model",
    claim: claim({ cost: "1000", latency: 2000, quality: 0.95, reliability: 0.9 }),
  },
  {
    candidateId: "rail-b-cheaper",
    route: { provider: "rail-b", model: "model-y" },
    representationClass: "sufficient-model",
    claim: claim({ cost: "200", latency: 1500, quality: 0.92, reliability: 1 }),
  },
  {
    // Below the 0.9 assurance floor, above the 0.85 hard floor — the
    // recorded comparison evidence.
    candidateId: "rail-b-below-assurance",
    route: { provider: "rail-b", model: "model-y" },
    representationClass: "stronger-model",
    claim: claim({ cost: "100", latency: 1200, quality: 0.87, reliability: 1 }),
  },
  {
    // Below the hard floor — excluded from the record corpus.
    candidateId: "rail-b-below-hard-floor",
    route: { provider: "rail-b", model: "model-y" },
    representationClass: "sufficient-model",
    claim: claim({ cost: "50", latency: 1000, quality: 0.8, reliability: 1 }),
  },
];

function modelSelection() {
  return selectModelRepresentation({
    ir: governedIr(),
    stepId: STEP,
    candidates: MODEL_CANDIDATES,
    qualityFacts: { requiredQuality: 0.9 },
    constraints: constraints(),
  });
}

describe("model-selection decision records", () => {
  test("records the least-expensive-sufficient selection with the evidence-honest corpus", () => {
    const record = buildModelDecisionRecord({
      selection: modelSelection(),
      stepId: STEP,
      candidates: MODEL_CANDIDATES,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record).not.toBeNull();
    // The cheaper sufficient route won.
    expect(record?.selectedCandidateId).toBe("rail-b-cheaper");
    expect(record?.selectedExpectation.expectedSuccessfulResolutionCostMicroUsd).toBe("200");
    expect(record?.qualityThreshold).toBe(0.9);
    // The corpus: admissible + below-assurance, hard-floor violator EXCLUDED.
    expect(record?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "rail-b-cheaper",
      "rail-a-incumbent",
      "rail-b-below-assurance",
    ]);
    // The below-assurance candidate carries its INVALID evaluation —
    // the "why the cheaper did not win" evidence.
    const below = record?.candidates.find(
      (candidate) => candidate.candidateId === "rail-b-below-assurance",
    );
    expect(below?.evaluation.valid).toBe(false);
    // The provenance chain: the governed plan → the derived IR.
    expect(record?.irId).toBe(governedIr().irId);
    expect(record?.provenance.planProvenance.planId).toBe(governedIr().planId);
    expect(record?.provenance.recordedVia).toBe("execution-ir-foundation");
    // The derived basis: a DIFFERENT route than the incumbent.
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("feature=model-selection");
    expect(record?.transformationBasis.detail).toContain("step=generate");
    expect(record?.transformationBasis.detail).toContain("selected=rail-b-cheaper");
    // The record passes the foundation's total validation at read time.
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });

  test("the basis is IDENTITY when the selected route IS the incumbent route", () => {
    const incumbentOnly: ModelCandidate[] = [
      {
        candidateId: "rail-a-incumbent",
        route: { provider: "rail-a", model: "model-x" },
        representationClass: "sufficient-model",
        claim: claim({ cost: "1000", latency: 2000, quality: 0.95, reliability: 0.9 }),
      },
    ];
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: incumbentOnly,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    const record = buildModelDecisionRecord({
      selection,
      stepId: STEP,
      candidates: incumbentOnly,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record?.transformationBasis.code).toBe("identity");
  });

  test("no admissible candidate → NO record (the typed outcome is the evidence)", () => {
    const belowFloor: ModelCandidate[] = [
      {
        candidateId: "rail-b-below",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "sufficient-model",
        claim: claim({ cost: "100", latency: 1200, quality: 0.8, reliability: 1 }),
      },
    ];
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: belowFloor,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(
      buildModelDecisionRecord({
        selection,
        stepId: STEP,
        candidates: belowFloor,
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      }),
    ).toBeNull();
  });
});

describe("effort-selection decision records", () => {
  const candidates: EffortCandidate[] = [
    {
      candidateId: "effort-minimal",
      effort: "minimal",
      representationClass: "sufficient-model",
      claim: claim({ cost: "200", latency: 900, quality: 0.91, reliability: 1 }),
    },
    {
      candidateId: "effort-high",
      effort: "high",
      representationClass: "sufficient-model",
      claim: claim({ cost: "1000", latency: 4000, quality: 0.97, reliability: 1 }),
    },
  ];

  test("records the effort selection (always a substitution — the IR carries no effort incumbent)", () => {
    const record = buildEffortDecisionRecord({
      selection: selectReasoningEffort({
        ir: governedIr(),
        stepId: STEP,
        candidates,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      }),
      stepId: STEP,
      candidates,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record).not.toBeNull();
    expect(record?.selectedCandidateId).toBe("effort-minimal");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("feature=effort-selection");
    expect(record?.transformationBasis.detail).toContain("effort=minimal");
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });
});

describe("agent-gate decision records", () => {
  function gateInput(
    zeroAgent: Parameters<typeof selectAgentStrategy>[0]["zeroAgent"],
    nAgent: Parameters<typeof selectAgentStrategy>[0]["nAgent"],
  ) {
    return {
      ir: governedIr(),
      stepId: STEP,
      zeroAgent,
      oneAgent: [
        {
          candidateId: "single-agent",
          representationClass: "sufficient-model" as const,
          claim: claim({ cost: "200", latency: 2000, quality: 0.95, reliability: 0.9 }),
        },
      ],
      nAgent,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: { qualityValueMicroUsd: "1000000" },
    };
  }

  test("a one-agent selection records the IDENTITY basis (the incumbent single-agent form)", () => {
    const input = gateInput([], []);
    const record = buildAgentGateDecisionRecord({
      selection: selectAgentStrategy(input),
      stepId: STEP,
      zeroAgent: input.zeroAgent,
      oneAgent: input.oneAgent,
      nAgent: input.nAgent,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record?.selectedCandidateId).toBe("single-agent");
    expect(record?.transformationBasis.code).toBe("identity");
    expect(record?.transformationBasis.detail).toContain("feature=agent-gate");
    expect(record?.transformationBasis.detail).toContain("mode=one-agent");
  });

  test("a zero-agent selection records the SUBSTITUTION basis; non-positive-net N is corpus-excluded", () => {
    const input = gateInput(
      [
        {
          candidateId: "cached-path",
          representationClass: "cache-reuse" as const,
          claim: claim({ cost: "50", latency: 500, quality: 0.95, reliability: 1 }),
        },
      ],
      [
        {
          // Positive net but COSTLIER than the cached anchor: recorded
          // as a considered candidate.
          candidateId: "parallel-considered",
          claim: claim({ cost: "500", latency: 1500, quality: 0.95, reliability: 0.95 }),
          gain: {
            expectedQualityGain: 0.3,
            expectedVerificationBurdenMicroUsd: "10000",
            agentCount: 3,
            basis: { basis: "estimated", source: "learning.telemetry" },
          },
        },
        {
          // Cheaper than the anchor but a non-positive net: EXCLUDED
          // from the corpus (its gain analysis is the typed evidence).
          candidateId: "parallel-bad",
          claim: claim({ cost: "60", latency: 1500, quality: 0.95, reliability: 0.95 }),
          gain: {
            expectedQualityGain: 0.1,
            expectedVerificationBurdenMicroUsd: "200000",
            agentCount: 3,
            basis: { basis: "estimated", source: "learning.telemetry" },
          },
        },
      ],
    );
    const record = buildAgentGateDecisionRecord({
      selection: selectAgentStrategy(input),
      stepId: STEP,
      zeroAgent: input.zeroAgent,
      oneAgent: input.oneAgent,
      nAgent: input.nAgent,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record?.selectedCandidateId).toBe("cached-path");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("mode=zero-agent");
    expect(record?.transformationBasis.detail).toContain("positive-gain=1");
    // The corpus: the selected zero-agent, the anchor, the POSITIVE-gain
    // N — the non-positive-net N excluded.
    expect(record?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "cached-path",
      "single-agent",
      "parallel-considered",
    ]);
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });
});

describe("service-class decision records (hooks only)", () => {
  const declaredClasses: ServiceClassCandidate[] = [
    {
      candidateId: "tier-economy",
      serviceClass: "economy",
      representationClass: "sufficient-model",
      claim: claim({ cost: "100", latency: 3000, quality: 0.92, reliability: 1 }),
    },
    {
      candidateId: "tier-standard",
      serviceClass: "standard",
      representationClass: "sufficient-model",
      claim: claim({ cost: "400", latency: 2000, quality: 0.95, reliability: 1 }),
    },
  ];

  test("records the declared-class selection with the class provenance", () => {
    const record = buildServiceClassDecisionRecord({
      selection: selectServiceClass({
        declaredClasses,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      }),
      declaredClasses,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope(),
      digest: nodeDigest,
    });
    expect(record?.selectedCandidateId).toBe("tier-economy");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("feature=service-class");
    expect(record?.transformationBasis.detail).toContain("class=economy");
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });

  test("an unsupported substrate records NOTHING (never a defaulted selection)", () => {
    expect(
      buildServiceClassDecisionRecord({
        selection: selectServiceClass({
          declaredClasses: [],
          qualityFacts: { requiredQuality: 0.9 },
          constraints: constraints(),
        }),
        declaredClasses: [],
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      }),
    ).toBeNull();
  });
});

describe("fresh-escalation decision records", () => {
  function escalationRecord(
    continuationQuality: number,
    continuationCost: string,
    freshCost: string,
  ) {
    const decision = decideFreshEscalation({
      continuation: claim({
        cost: continuationCost,
        latency: 2000,
        quality: continuationQuality,
        reliability: 0.9,
      }),
      freshContext: claim({ cost: freshCost, latency: 2000, quality: 0.95, reliability: 0.95 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    return {
      decision,
      record: buildFreshEscalationDecisionRecord({
        decision,
        continuation: claim({
          cost: continuationCost,
          latency: 2000,
          quality: continuationQuality,
          reliability: 0.9,
        }),
        freshContext: claim({
          cost: freshCost,
          latency: 2000,
          quality: 0.95,
          reliability: 0.95,
        }),
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      }),
    };
  }

  test("an escalation records the SUBSTITUTION basis with the fresh path selected", () => {
    const { decision, record } = escalationRecord(0.95, "2000", "1000");
    expect(decision.kind).toBe("escalate-fresh-context");
    expect(record?.selectedCandidateId).toBe("escalate-fresh-context");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("feature=fresh-escalation");
    expect(record?.transformationBasis.detail).toContain("decision=escalate-fresh-context");
    // Both paths recorded (both sufficient).
    expect(record?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "continue-current-context",
      "escalate-fresh-context",
    ]);
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });

  test("a continue decision records the IDENTITY basis with the continuation selected", () => {
    const { decision, record } = escalationRecord(0.95, "1000", "2000");
    expect(decision.kind).toBe("continue-current-context");
    expect(record?.selectedCandidateId).toBe("continue-current-context");
    expect(record?.transformationBasis.code).toBe("identity");
  });

  test("a DEGRADED continuation is recorded with its invalid evaluation (the escalation reason)", () => {
    // 0.87: below the 0.9 assurance floor, above the 0.85 hard floor.
    const { record } = escalationRecord(0.87, "500", "2000");
    expect(record?.candidates).toHaveLength(2);
    const degraded = record?.candidates.find(
      (candidate) => candidate.candidateId === "continue-current-context",
    );
    expect(degraded?.evaluation.valid).toBe(false);
    expect(record?.selectedCandidateId).toBe("escalate-fresh-context");
  });

  test("a HARD-violating continuation is corpus-excluded (only the fresh path records)", () => {
    // 0.8: below the hard 0.85 floor.
    const { record } = escalationRecord(0.8, "500", "2000");
    expect(record?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "escalate-fresh-context",
    ]);
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
  });

  test("no-admissible-candidate → NO record", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ cost: "1000", latency: 2000, quality: 0.8, reliability: 0.9 }),
      freshContext: claim({ cost: "500", latency: 2000, quality: 0.83, reliability: 0.95 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("no-admissible-candidate");
    expect(
      buildFreshEscalationDecisionRecord({
        decision,
        continuation: claim({ cost: "1000", latency: 2000, quality: 0.8, reliability: 0.9 }),
        freshContext: claim({ cost: "500", latency: 2000, quality: 0.83, reliability: 0.95 }),
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      }),
    ).toBeNull();
  });
});

describe("content-addressed determinism and idempotence", () => {
  test("identical inputs produce the BYTE-IDENTICAL record (decisionId and recordDigest)", () => {
    const build = () =>
      buildModelDecisionRecord({
        selection: modelSelection(),
        stepId: STEP,
        candidates: MODEL_CANDIDATES,
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      });
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first?.decisionId).toBe(second?.decisionId);
    expect(first?.recordDigest).toBe(second?.recordDigest);
  });

  test("recordedAt sits OUTSIDE the decisionId coverage (the content identity is stable)", () => {
    const first = buildModelDecisionRecord({
      selection: modelSelection(),
      stepId: STEP,
      candidates: MODEL_CANDIDATES,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope("2026-09-23T09:00:00.000Z"),
      digest: nodeDigest,
    });
    const second = buildModelDecisionRecord({
      selection: modelSelection(),
      stepId: STEP,
      candidates: MODEL_CANDIDATES,
      ir: governedIr(),
      constraints: constraints(),
      scope: scope("2026-09-23T10:00:00.000Z"),
      digest: nodeDigest,
    });
    expect(first?.decisionId).toBe(second?.decisionId);
    expect(first?.recordDigest).not.toBe(second?.recordDigest);
  });
});

describe("the fail-closed record rules", () => {
  test("an empty governing constraint set is unprovenanced optimization — rejected", () => {
    try {
      buildModelDecisionRecord({
        selection: modelSelection(),
        stepId: STEP,
        candidates: MODEL_CANDIDATES,
        ir: governedIr(),
        constraints: [],
        scope: scope(),
        digest: nodeDigest,
      });
      expect.unreachable("the unprovenanced decision must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("decision-invalid");
    }
  });

  test("a verdict/candidate mismatch is rejected (the corpus must be the selection's corpus)", () => {
    try {
      buildModelDecisionRecord({
        selection: modelSelection(),
        stepId: STEP,
        // The selection ran on FOUR candidates; this input carries one
        // of a different corpus shape.
        candidates: [MODEL_CANDIDATES[0] as ModelCandidate],
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      });
      expect.unreachable("the mismatched corpus must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("decision-invalid");
    }
  });

  test("a non-generative step is rejected at the record seam", () => {
    try {
      buildModelDecisionRecord({
        selection: modelSelection(),
        stepId: "verify",
        candidates: MODEL_CANDIDATES,
        ir: governedIr(),
        constraints: constraints(),
        scope: scope(),
        digest: nodeDigest,
      });
      expect.unreachable("the non-generative step must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("step-not-generative");
    }
  });
});
