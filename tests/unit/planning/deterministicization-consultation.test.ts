/**
 * Unit: the deterministicization consultation domain (planning module;
 * WORK-021 / DTR-001..004) — the planning-side read seam of the
 * deterministicization lifecycle.
 *
 * Negative guarantees proven here (the DTR boundary at the consumer
 * seam):
 *  - an unprovenanced/malformed consulted candidate fails closed
 *    (wrong signal class, empty source-execution provenance, closed
 *    class/status vocabularies, population, malformed rollout deltas)
 *    and never enters a decision record;
 *  - only a PROMOTED candidate carries the deterministic direction
 *    (shadow/canary/deferred/rolled-back candidates are divergence
 *    evidence — their implied preference is null);
 *  - the implied preference is the ADMISSIBLE candidate with the
 *    FEWEST generative steps (inadmissible candidates never qualify);
 *  - the consultation capture never rebinds the governed selection
 *    (agreesWithSelection is RECORDED, never applied);
 *  - the full consultation round-trip validates every record again.
 */

import { describe, expect, test } from "vitest";
import {
  buildDeterministicizationConsultation,
  CONSULTED_DETERMINISTICIZATION_CLASS,
  type ConsultedDeterministicizationSignal,
  deterministicizationPreferredCandidateId,
  validateConsultedDeterministicizationSignal,
  validateDeterministicizationConsultation,
} from "../../../src/modules/planning/domain";
import type { CandidateStrategy } from "../../../src/modules/planning/public";
import { buildPlan, createNodeDigest } from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = createNodeDigest();

type TestStepClass = Parameters<typeof buildPlan>[0]["steps"][number]["stepClass"];

function planOf(steps: readonly { id: string; stepClass: TestStepClass }[]) {
  return buildPlan(
    {
      revision: 1,
      strategyClass: "generative",
      steps: steps.map((step) => ({
        ...step,
        // Generative steps must bind a capability AND a provider/model
        // route (the plan-domain fabrication boundary); deterministic
        // steps carry neither.
        ...(/^(generate|call-model|call-agent)$/.test(step.stepClass)
          ? {
              capabilityId: "text-generation",
              routeRef: { provider: "rail-a", model: "model-x" },
            }
          : {}),
      })),
      edges: steps.slice(1).map((step, index) => ({
        from: steps[index]?.id ?? "s0",
        to: step.id,
      })),
    },
    (value) => digest.sha256Hex(JSON.stringify(value)),
  );
}

function candidate(
  strategyId: string,
  generativeSteps: number,
  options: { readonly admissible?: boolean; readonly cost?: string } = {},
): CandidateStrategy {
  const all: readonly { id: string; stepClass: TestStepClass }[] = [
    { id: "gen-1", stepClass: "generate" },
    { id: "gen-2", stepClass: "call-model" },
    { id: "agent-1", stepClass: "call-agent" },
  ];
  const steps = all.slice(0, generativeSteps);
  return {
    strategyId,
    plan: planOf([...steps, { id: "verify", stepClass: "verify" }]),
    expectedCostMicroUsd: options.cost ?? "1000",
    expectedQuality: 0.9,
    expectedLatencyMs: 1500,
    verificationStrategy: "exact-recomputation",
    routeRationale: { code: "cheap-first-cascade", detail: "test" },
    modelCalls: generativeSteps,
    admissible: options.admissible ?? true,
  };
}

function signal(
  overrides: Partial<ConsultedDeterministicizationSignal> = {},
): ConsultedDeterministicizationSignal {
  return {
    signalClass: CONSULTED_DETERMINISTICIZATION_CLASS,
    candidateId: "a".repeat(64),
    candidateClass: "deterministic-replacement",
    status: "promoted",
    taskClass: "summarize",
    subgraphId: "sg-normalize-entity",
    computationType: "generative",
    population: 24,
    corpusDigest: "b".repeat(64),
    sourceExecutionIds: ["exec-1", "exec-2"],
    contractDigest: "c".repeat(64),
    incumbentStrategyClass: "generative-route",
    incumbentDescriptionDigest: "d".repeat(64),
    rollbackTarget: "incumbent:generative-route@v1",
    shadow: null,
    canary: {
      population: 12,
      matchedCount: 12,
      costDeltaMicroUsd: "2100",
      qualityDelta: 1,
      latencyDeltaMs: -130,
    },
    promotionDecisionId: "e".repeat(64),
    promotedBy: "architect-1",
    promotedAt: "2026-09-20T12:00:00Z",
    rollbackDecisionId: null,
    restoredIncumbent: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fail-closed validation at the consumer seam
// ---------------------------------------------------------------------------

describe("planning domain: validateConsultedDeterministicizationSignal", () => {
  test("a well-formed consulted candidate validates (the baseline)", () => {
    expect(() => validateConsultedDeterministicizationSignal(signal())).not.toThrow();
  });

  test("a wrong signal class fails closed (a candidate is never an authorization)", () => {
    const wrong = signal({ signalClass: "authoritative-execution-command" as never });
    expect(() => validateConsultedDeterministicizationSignal(wrong)).toThrow(PlatformError);
  });

  test("EMPTY source-execution provenance fails closed (provenance is identity)", () => {
    const unprovenanced = signal({ sourceExecutionIds: [] });
    expect(() => validateConsultedDeterministicizationSignal(unprovenanced)).toThrow(
      /sourceExecutionIds must be non-empty/,
    );
  });

  test("a zero population fails closed", () => {
    const hollow = signal({ population: 0 });
    expect(() => validateConsultedDeterministicizationSignal(hollow)).toThrow(
      /population must be a positive integer/,
    );
  });

  test("an out-of-vocabulary candidate class fails closed", () => {
    const unknown = signal({ candidateClass: "magic-replacement" as never });
    expect(() => validateConsultedDeterministicizationSignal(unknown)).toThrow(
      /five-class vocabulary/,
    );
  });

  test("a non-rollout-relevant status fails closed (proposed/rejected carry no planning state)", () => {
    const early = signal({ status: "proposed" as never });
    expect(() => validateConsultedDeterministicizationSignal(early)).toThrow(
      /rollout-relevant lifecycle vocabulary/,
    );
  });

  test("a malformed canary delta fails closed (matchedCount above population)", () => {
    const malformed = signal({
      canary: {
        population: 10,
        matchedCount: 11,
        costDeltaMicroUsd: "1",
        qualityDelta: 1,
        latencyDeltaMs: 0,
      },
    });
    expect(() => validateConsultedDeterministicizationSignal(malformed)).toThrow(
      /matchedCount must be in \[0, population\]/,
    );
  });

  test("a negative-quality canary delta fails closed", () => {
    const malformed = signal({
      canary: {
        population: 10,
        matchedCount: 10,
        costDeltaMicroUsd: "1",
        qualityDelta: -0.5,
        latencyDeltaMs: 0,
      },
    });
    expect(() => validateConsultedDeterministicizationSignal(malformed)).toThrow(
      /qualityDelta must be in \[0,1\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// The implied preference (promoted-only, admissible, fewest generative steps)
// ---------------------------------------------------------------------------

describe("planning domain: deterministicizationPreferredCandidateId", () => {
  const mixed = [
    candidate("strategy-three-generative", 3),
    candidate("strategy-one-generative", 1),
    candidate("strategy-two-generative", 2),
  ];

  test("with NO promoted candidate the implied preference is null (divergence evidence only)", () => {
    for (const status of [
      "validating",
      "validated",
      "shadow",
      "canary",
      "deferred",
      "rolled-back",
    ] as const) {
      expect(deterministicizationPreferredCandidateId(mixed, [signal({ status })])).toBeNull();
    }
  });

  test("with a promoted candidate the preference is the admissible candidate with the FEWEST generative steps", () => {
    expect(deterministicizationPreferredCandidateId(mixed, [signal()])).toBe(
      "strategy-one-generative",
    );
  });

  test("INADMISSIBLE candidates never qualify (a consulted candidate cannot authorize a forbidden route)", () => {
    const inadmissible = [
      candidate("strategy-one-generative", 1, { admissible: false }),
      candidate("strategy-two-generative", 2),
    ];
    expect(deterministicizationPreferredCandidateId(inadmissible, [signal()])).toBe(
      "strategy-two-generative",
    );
  });

  test("no admissible candidate at all → null", () => {
    const allForbidden = [
      candidate("strategy-one-generative", 1, { admissible: false }),
      candidate("strategy-two-generative", 2, { admissible: false }),
    ];
    expect(deterministicizationPreferredCandidateId(allForbidden, [signal()])).toBeNull();
  });

  test("ties break on the input order (deterministic)", () => {
    const tied = [candidate("strategy-a", 2), candidate("strategy-b", 2)];
    expect(deterministicizationPreferredCandidateId(tied, [signal()])).toBe("strategy-a");
  });
});

// ---------------------------------------------------------------------------
// The consultation capture (the decision-record evidence)
// ---------------------------------------------------------------------------

describe("planning domain: buildDeterministicizationConsultation", () => {
  test("the capture records the implied preference and its (dis)agreement — never rebinds the selection", () => {
    const candidates = [
      candidate("strategy-one-generative", 1),
      candidate("strategy-two-generative", 2),
    ];
    const consultation = buildDeterministicizationConsultation({
      candidates,
      signals: [signal()],
      selectedStrategyId: "strategy-two-generative",
      consultedAt: "2026-09-20T12:30:00Z",
    });
    expect(consultation.preferredStrategyId).toBe("strategy-one-generative");
    expect(consultation.agreesWithSelection).toBe(false);
    expect(consultation.consulted.length).toBe(1);
    expect(consultation.consultedAt).toBe("2026-09-20T12:30:00Z");
  });

  test("a malformed signal makes the WHOLE capture fail closed (never enters a decision record)", () => {
    expect(() =>
      buildDeterministicizationConsultation({
        candidates: [candidate("strategy-one-generative", 1)],
        signals: [signal({ sourceExecutionIds: [] })],
        selectedStrategyId: "strategy-one-generative",
        consultedAt: "2026-09-20T12:30:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("the round-trip validation accepts the built capture", () => {
    const consultation = buildDeterministicizationConsultation({
      candidates: [candidate("strategy-one-generative", 1)],
      signals: [signal()],
      selectedStrategyId: "strategy-one-generative",
      consultedAt: "2026-09-20T12:30:00Z",
    });
    expect(() => validateDeterministicizationConsultation(consultation)).not.toThrow();
    expect(consultation.agreesWithSelection).toBe(true);
  });
});
