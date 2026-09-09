/**
 * Discrimination tests — the model-economics plane protections
 * (WORK-053, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-053 is
 * mutation-proven — the WEAKENED form is rejected by the gate that
 * owns it (the real-PostgreSQL suites prove the durable side over
 * the real store; these proofs pin the protections at the unit seam):
 *
 *  - below-floor selections are inadmissible REGARDLESS of cost: every
 *    floor dimension (assurance threshold, hard quality floor,
 *    reliability floor, budget ceiling, latency ceiling, policy route)
 *    is mutation-proven with a cheaper-but-violating candidate that
 *    must lose to a sufficient one (and an all-violating corpus must
 *    produce the typed no-admissible outcome, never a selection);
 *  - ALWAYS-ON N-AGENT IS IMPOSSIBLE by construction, three ways: an
 *    N candidate without a positive gain claim is unrepresentable; a
 *    non-positive NET is the typed below-threshold inadmissibility
 *    even when N is strictly cheaper; a positive-net but costlier N
 *    never displaces the cheaper sufficient 0/1 path;
 *  - unattributed and unbounded claims are rejected through the closed
 *    vocabulary (claims AND gain claims — the estimation-basis
 *    contract is the seam);
 *  - no authorization surface exists anywhere on the plane (the
 *    evidence-only boundary is mechanically proven over the sources);
 *  - non-deterministic tie-breaks are impossible: the selection is
 *    permutation-invariant and the comparator is total (identity,
 *    antisymmetry); a mutated ordering key cannot flip a selection
 *    without changing the recorded basis;
 *  - deterministic re-selection mismatches are DETECTED: re-selection
 *    is byte-identical, and a tampered decision record fails the
 *    foundation's identity/selection validation at read time;
 *  - the evidence-honest record corpus is load-bearing: a naive
 *    corpus including a hard-constraint violator is rejected by the
 *    foundation's total validation, while the plane's corpus (the
 *    violator excluded, the below-assurance candidate recorded with
 *    its invalid evaluation) validates — the exclusion is what makes
 *    the record constructible at all;
 *  - the escalation hook is never a weaker gate: the hard reliability
 *    floor flips a continue into an escalate exactly when the
 *    weakened continuation violates it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildOptimizationDecision,
  type DecisionValidationError,
  validateOptimizationDecision,
} from "../../src/platform/execution-ir/decision-record";
import { compareAdmissible } from "../../src/platform/model-economics/admissibility";
import { selectAgentStrategy } from "../../src/platform/model-economics/agent-gate";
import { buildModelDecisionRecord } from "../../src/platform/model-economics/decisions";
import { decideFreshEscalation } from "../../src/platform/model-economics/escalation-hooks";
import { selectModelRepresentation } from "../../src/platform/model-economics/model-selection";
import type { ModelCandidate } from "../../src/platform/model-economics/vocabulary";
import {
  type ModelEconomicsError,
  validateModelCandidate,
  validateNAgentCandidate,
} from "../../src/platform/model-economics/vocabulary";
import {
  APPLICATION_ID,
  claim,
  constraints,
  EXECUTION_ID,
  governedIr,
  nodeDigest,
  RECORDED_AT,
  reliabilityFloorConstraint,
  TENANT_ID,
} from "../unit/platform/model-economics/world";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STEP = "generate";

function model(
  candidateId: string,
  input: {
    readonly cost: string;
    readonly latency: number;
    readonly quality: number;
    readonly reliability: number;
  },
  route: { provider: string; model: string } = { provider: "rail-b", model: "model-y" },
): ModelCandidate {
  return {
    candidateId,
    route,
    representationClass: "sufficient-model",
    claim: claim(input),
  };
}

describe("model-economics discrimination (WORK-053)", () => {
  test("D1 below-floor selections are inadmissible regardless of cost (every floor dimension)", () => {
    // A DEARER sufficient candidate beats a CHEAPER violating one on
    // every dimension — the floor is inviolable, price never overrides.
    const sufficient = model("sufficient", {
      cost: "100000",
      latency: 900,
      quality: 0.95,
      reliability: 1,
    });
    const cases: {
      readonly what: string;
      readonly violating: ModelCandidate;
      readonly constraint: Parameters<typeof selectModelRepresentation>[0]["constraints"];
      readonly code: string;
    }[] = [
      {
        what: "the assurance threshold",
        violating: model("cheap", { cost: "10", latency: 900, quality: 0.87, reliability: 1 }),
        constraint: constraints(),
        code: "quality-below-assurance",
      },
      {
        what: "the hard quality floor",
        violating: model("cheap", { cost: "10", latency: 900, quality: 0.8, reliability: 1 }),
        constraint: constraints(),
        code: "quality-below-hard-floor",
      },
      {
        what: "the hard reliability floor",
        violating: model("shaky", { cost: "10", latency: 900, quality: 0.95, reliability: 0.5 }),
        constraint: [...constraints(), reliabilityFloorConstraint(0.9)],
        code: "reliability-below-floor",
      },
      {
        what: "the hard budget ceiling",
        violating: model("dear", { cost: "900000", latency: 900, quality: 0.95, reliability: 1 }),
        constraint: [
          ...constraints(),
          {
            constraintId: "budget-1",
            kind: "budget" as const,
            enforcement: "hard" as const,
            source: {
              authority: "budget" as const,
              budgetId: "b-1",
              scopeKind: "monthly" as const,
            },
            payload: { maxCostMicroUsd: "500000" },
          },
        ],
        code: "budget-ceiling",
      },
      {
        what: "the hard latency ceiling",
        violating: model("slow", { cost: "10", latency: 90000, quality: 0.95, reliability: 1 }),
        constraint: [
          ...constraints(),
          {
            constraintId: "latency-1",
            kind: "latency" as const,
            enforcement: "hard" as const,
            source: { authority: "policy" as const, policySetId: "ps-1" },
            payload: { maxLatencyMs: 4000 },
          },
        ],
        code: "latency-ceiling",
      },
      {
        what: "the hard policy route restriction",
        violating: model(
          "forbidden",
          { cost: "10", latency: 900, quality: 0.95, reliability: 1 },
          { provider: "rail-c", model: "model-z" },
        ),
        constraint: [
          ...constraints(),
          {
            constraintId: "policy-denied-rail-c",
            kind: "policy" as const,
            enforcement: "hard" as const,
            source: { authority: "policy" as const, policySetId: "ps-1" },
            payload: { providerModel: { deniedProviders: ["rail-c"] } },
          },
        ],
        code: "policy-forbidden-route",
      },
    ];
    for (const { what, violating, constraint, code } of cases) {
      const selection = selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates: [violating, sufficient],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraint,
      });
      expect(selection.selected?.candidateId, `${what}: the sufficient candidate must win`).toBe(
        "sufficient",
      );
      expect(selection.verdicts[1]?.inadmissibleCode, `${what}: the typed code`).toBe(code);
    }
    // And an ALL-violating corpus selects NOTHING (typed outcome).
    const allViolating = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [model("cheap-bad", { cost: "10", latency: 900, quality: 0.8, reliability: 1 })],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(allViolating.kind).toBe("no-admissible-candidate");
    expect(
      buildModelDecisionRecord({
        selection: allViolating,
        stepId: STEP,
        candidates: [
          model("cheap-bad", { cost: "10", latency: 900, quality: 0.8, reliability: 1 }),
        ],
        ir: governedIr(),
        constraints: constraints(),
        scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID, recordedAt: RECORDED_AT },
        digest: nodeDigest,
      }),
    ).toBeNull();
  });

  test("D2 ALWAYS-ON N-AGENT IS IMPOSSIBLE — three independent construction proofs", () => {
    const economics = { qualityValueMicroUsd: "1000000" };
    const anchor = {
      candidateId: "single-agent",
      representationClass: "sufficient-model" as const,
      claim: claim({ cost: "200", latency: 2000, quality: 0.95, reliability: 0.9 }),
    };

    // Proof 1: an N candidate without a POSITIVE gain claim is
    // UNREPRESENTABLE (zero, negative and non-finite gains all
    // reject through the gate's closed vocabulary).
    for (const gain of [
      { expectedQualityGain: 0 },
      { expectedQualityGain: -0.5 },
      { expectedQualityGain: Number.NaN },
    ]) {
      try {
        validateNAgentCandidate({
          candidateId: "n-bad",
          claim: claim({ cost: "100", latency: 1500, quality: 0.95, reliability: 0.95 }),
          gain: {
            expectedQualityGain: gain.expectedQualityGain,
            expectedVerificationBurdenMicroUsd: "10000",
            agentCount: 2,
            basis: { basis: "estimated", source: "learning.telemetry" },
          },
        });
        expect.unreachable(`the gain ${JSON.stringify(gain)} must be rejected`);
      } catch (error) {
        expect((error as ModelEconomicsError).invariant).toBe("gate-shape");
      }
    }
    // A NEGATIVE verification burden is rejected through the bounded
    // money discipline (the burden is ≥ 0 by the money universe).
    try {
      validateNAgentCandidate({
        candidateId: "n-negative-burden",
        claim: claim({ cost: "100", latency: 1500, quality: 0.95, reliability: 0.95 }),
        gain: {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "-1",
          agentCount: 2,
          basis: { basis: "estimated", source: "learning.telemetry" },
        },
      });
      expect.unreachable("the negative burden must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-overflow");
    }
    // An UNATTRIBUTED gain claim is rejected through the closed
    // vocabulary as well.
    try {
      validateNAgentCandidate({
        candidateId: "n-unattributed",
        claim: claim({ cost: "100", latency: 1500, quality: 0.95, reliability: 0.95 }),
        gain: {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
          agentCount: 2,
        } as never,
      });
      expect.unreachable("the unattributed gain must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("gate-shape");
    }

    // Proof 2: a NON-POSITIVE NET is the typed below-threshold
    // inadmissibility even when N is STRICTLY CHEAPER than the anchor.
    const netBad = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [anchor],
      nAgent: [
        {
          candidateId: "n-cheaper-bad-net",
          claim: claim({ cost: "100", latency: 1500, quality: 0.95, reliability: 0.95 }),
          gain: {
            expectedQualityGain: 0.3,
            expectedVerificationBurdenMicroUsd: "350000",
            agentCount: 2,
            basis: { basis: "estimated", source: "learning.telemetry" },
          },
        },
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics,
    });
    expect(netBad.gateMode).toBe("one-agent");
    expect(
      netBad.verdicts.find((verdict) => verdict.candidateId === "n-cheaper-bad-net")
        ?.inadmissibleCode,
    ).toBe("quality-gain-below-threshold");

    // Proof 3: a POSITIVE-NET but COSTLIER N never displaces the
    // cheaper sufficient 0/1 path (the gate defaults to cheapest).
    const netGoodButDear = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [anchor],
      nAgent: [
        {
          candidateId: "n-dear-good-net",
          claim: claim({ cost: "500", latency: 1500, quality: 0.95, reliability: 0.95 }),
          gain: {
            expectedQualityGain: 0.3,
            expectedVerificationBurdenMicroUsd: "10000",
            agentCount: 2,
            basis: { basis: "estimated", source: "learning.telemetry" },
          },
        },
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics,
    });
    expect(netGoodButDear.gateMode).toBe("one-agent");
    expect(netGoodButDear.gainAnalyses[0]?.positive).toBe(true);
  });

  test("D3 unattributed and unbounded claims are rejected through the closed vocabulary", () => {
    // Unattributed (no basis).
    try {
      validateModelCandidate({
        candidateId: "unattributed",
        route: { provider: "rail-a", model: "model-x" },
        representationClass: "sufficient-model",
        claim: {
          expectedCostMicroUsd: "100",
          expectedLatencyMs: 100,
          expectedQuality: 0.95,
          expectedReliability: 1,
        },
      } as never);
      expect.unreachable("the unattributed claim must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-invalid");
    }
    // Unbounded (past the 10^18 money universe).
    for (const bad of ["1000000000000000000", "-5", "1.5", ""]) {
      try {
        validateModelCandidate({
          candidateId: "unbounded",
          route: { provider: "rail-a", model: "model-x" },
          representationClass: "sufficient-model",
          claim: claim({
            cost: bad,
            latency: 100,
            quality: 0.95,
            reliability: 1,
          }),
        });
        expect.unreachable(`the cost ${bad} must be rejected`);
      } catch (error) {
        expect((error as ModelEconomicsError).invariant).toBe("claim-invalid");
      }
    }
    // Out-of-universe quality/reliability.
    try {
      validateModelCandidate({
        candidateId: "impossible-quality",
        route: { provider: "rail-a", model: "model-x" },
        representationClass: "sufficient-model",
        claim: claim({ cost: "100", latency: 100, quality: 1.5, reliability: 1 }),
      });
      expect.unreachable("the quality 1.5 must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-invalid");
    }
    try {
      validateModelCandidate({
        candidateId: "zero-reliability",
        route: { provider: "rail-a", model: "model-x" },
        representationClass: "sufficient-model",
        claim: claim({ cost: "100", latency: 100, quality: 0.95, reliability: 0 }),
      });
      expect.unreachable("the zero reliability must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-invalid");
    }
  });

  test("D4 no authorization surface exists anywhere on the plane (evidence-only boundary)", () => {
    // The mechanical source proof over the whole plane: no exported
    // admission/authorization vocabulary may exist (a runtime
    // authorization path that consults model-economics selections
    // would need exactly this vocabulary).
    const planeDir = join(REPO_ROOT, "src/platform/model-economics");
    const files = readdirSync(planeDir).filter((name) => name.endsWith(".ts"));
    expect(files).toHaveLength(9);
    for (const name of files) {
      const content = readFileSync(join(planeDir, name), "utf8");
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${name} must not export "${word}"`).not.toMatch(
          new RegExp(`export\\s+(async\\s+)?function\\s+${word}\\b`),
        );
        expect(content, `${name} must not export a "${word}" member`).not.toMatch(
          new RegExp(`export\\s+(type|interface|class|const)\\s+\\w*${word}\\w*`, "i"),
        );
      }
    }
  });

  test("D5 non-deterministic tie-breaks are impossible (permutation invariance, comparator totality)", () => {
    // A tie-heavy corpus: three candidates with IDENTICAL economics,
    // differing only in candidateId. Every input permutation must
    // produce the identical selection AND the identical verdict order
    // (a content-ordered tie-break cannot depend on input order; a
    // randomized or insertion-ordered break would flip).
    const tie = (candidateId: string) =>
      model(candidateId, { cost: "200", latency: 1500, quality: 0.92, reliability: 1 });
    const corpus = [tie("c-model"), tie("a-model"), tie("b-model")];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => corpus[index] as ModelCandidate));
    const outcomes = permutations.map((candidates) =>
      selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      }),
    );
    for (const outcome of outcomes) {
      expect(outcome.selected?.candidateId).toBe("a-model");
      expect(outcome.verdicts.map((verdict) => verdict.candidateId)).toEqual([
        "a-model",
        "b-model",
        "c-model",
      ]);
    }

    // The comparator is total: identity and antisymmetry hold for
    // every pair of the corpus (a partial comparator would admit
    // non-deterministic sort orders).
    const facts = outcomes[0]?.facts;
    expect(facts).toBeDefined();
    const verdicts = outcomes[0]?.verdicts ?? [];
    for (const a of verdicts) {
      for (const b of verdicts) {
        const forward = compareAdmissible(a, b);
        const backward = compareAdmissible(b, a);
        expect(compareAdmissible(a, a)).toBe(0);
        // Antisymmetry (0 and −0 sum to 0 — Object.is would split them).
        expect(forward + backward).toBe(0);
      }
    }
  });

  test("D6 deterministic re-selection mismatches are DETECTED (tampered records fail validation)", () => {
    const candidates = [
      model("rail-b-cheaper", { cost: "200", latency: 1500, quality: 0.92, reliability: 1 }),
      model("rail-a-incumbent", { cost: "1000", latency: 2000, quality: 0.95, reliability: 0.9 }),
    ];
    const input = {
      ir: governedIr(),
      stepId: STEP,
      candidates,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    const scope = {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      executionId: EXECUTION_ID,
      recordedAt: RECORDED_AT,
    };
    // Re-selection is byte-identical (the deterministic record).
    const first = buildModelDecisionRecord({
      selection: selectModelRepresentation(input),
      ...input,
      scope,
      digest: nodeDigest,
    });
    const second = buildModelDecisionRecord({
      selection: selectModelRepresentation(input),
      ...input,
      scope,
      digest: nodeDigest,
    });
    expect(first?.decisionId).toBe(second?.decisionId);
    expect(first?.recordDigest).toBe(second?.recordDigest);

    // A TAMPERED record fails the foundation's total validation at
    // read time — the identity verification detects content drift.
    const tampered = { ...(first as object) } as Record<string, unknown>;
    tampered.selectedCandidateId = "rail-a-incumbent";
    try {
      validateOptimizationDecision(tampered, nodeDigest);
      expect.unreachable("the tampered record must be rejected");
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-identity-mismatch");
    }
    // A tampered quality threshold (a weakened floor) is likewise
    // detected through the identity coverage.
    const weakened = { ...(first as object) } as Record<string, unknown>;
    weakened.qualityThreshold = 0.5;
    try {
      validateOptimizationDecision(weakened, nodeDigest);
      expect.unreachable("the weakened threshold must be rejected");
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-identity-mismatch");
    }
    // The pristine record validates.
    expect(() => validateOptimizationDecision(first, nodeDigest)).not.toThrow();
  });

  test("D7 the evidence-honest corpus is LOAD-BEARING (a naive corpus is rejected by the foundation)", () => {
    const candidates = [
      model("rail-b-cheaper", { cost: "200", latency: 1500, quality: 0.92, reliability: 1 }),
      // Below the hard 0.85 floor: the plane EXCLUDES it from the
      // record corpus — a naive corpus including it cannot exist.
      model("below-hard-floor", { cost: "100", latency: 900, quality: 0.8, reliability: 1 }),
    ];
    const input = {
      ir: governedIr(),
      stepId: STEP,
      candidates,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    const scope = {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      recordedAt: RECORDED_AT,
    };
    const record = buildModelDecisionRecord({
      selection: selectModelRepresentation(input),
      ...input,
      scope,
      digest: nodeDigest,
    });
    // The plane's corpus excludes the hard-floor violator.
    expect(record?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "rail-b-cheaper",
    ]);

    // The NAIVE corpus (the violator included) is rejected by the
    // foundation's total validation — the exclusion is not cosmetic;
    // it is what makes the record constructible at all.
    try {
      buildOptimizationDecision(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          ir: input.ir,
          constraints: constraints(),
          candidates: [
            {
              candidateId: "rail-b-cheaper",
              representationClass: "sufficient-model",
              claim: candidates[0]?.claim as never,
            },
            {
              candidateId: "below-hard-floor",
              representationClass: "sufficient-model",
              claim: candidates[1]?.claim as never,
            },
          ],
          qualityThreshold: 0.9,
          selectedCandidateId: "rail-b-cheaper",
          transformationBasis: {
            code: "representation-substitution",
            detail: "the naive corpus the plane must exclude",
          },
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      );
      expect.unreachable("the naive corpus must be rejected by the foundation");
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe(
        "decision-hard-constraint-violation",
      );
    }
  });

  test("D8 the escalation hook is never a weaker gate (the hard reliability floor flips the outcome)", () => {
    const continuation = claim({ cost: "100", latency: 2000, quality: 0.95, reliability: 0.8 });
    const fresh = claim({ cost: "5000", latency: 2000, quality: 0.95, reliability: 0.99 });
    // WITHOUT the hard reliability floor: the cheaper continuation
    // continues (its quality meets the floor).
    const permissive = decideFreshEscalation({
      continuation,
      freshContext: fresh,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(permissive.kind).toBe("continue-current-context");
    // WITH the hard reliability floor (the weakened continuation
    // violates it): the hook escalates — a weakened protection cannot
    // slip past the same gate every other selection runs through.
    const enforced = decideFreshEscalation({
      continuation,
      freshContext: fresh,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [...constraints(), reliabilityFloorConstraint(0.9)],
    });
    expect(enforced.kind).toBe("escalate-fresh-context");
    expect(enforced.comparison.continuation.inadmissibleCode).toBe("reliability-below-floor");
  });
});
