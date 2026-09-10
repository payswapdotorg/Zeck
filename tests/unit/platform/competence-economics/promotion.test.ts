/**
 * Unit battery: shadow/canary promotion gates (WORK-056 AC 5).
 *
 * Proves: PROMOTION IS GATED, NEVER SKIPPED — the ONLY route is
 * candidate → shadow → canary → deterministic, ONE stage at a time;
 * the target stage is COMPUTED from the current stage (rank + 1 —
 * never caller-supplied, so gate-skipping is structurally
 * unrepresentable); every gate re-proves the full equivalence suite
 * under the governing policy floor; the shared economics
 * admissibility (the model-economics plane's OWN machinery) governs;
 * NO SELF-PROMOTION (agents never promote their own output);
 * terminal-stage requests are typed gate-order violations; the
 * verdict is typed evidence (promoted/hold/reject with reasons);
 * determinism/idempotence.
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import { admitDeterministicReplacement } from "../../../../src/platform/competence-economics/equivalence";
import {
  advanceStage,
  decidePromotion,
  validateCanaryEvidence,
  validatePromotionConfiguration,
  validateShadowEvidence,
} from "../../../../src/platform/competence-economics/promotion";
import { validateCompetenceRecord } from "../../../../src/platform/competence-economics/record";
import {
  atStage,
  belowFloorReplacement,
  canaryEvidence,
  claim,
  digest,
  fullSuite,
  minedRecord,
  PROMOTER_AUTHORITY,
  promotionConfiguration,
  promotionInput,
  qualityFacts,
  replacementCandidate,
  scope,
  shadowEvidence,
  weakSuite,
} from "./world";

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the gated promotion path (WORK-056)", () => {
  test("GATE candidate → shadow: the full input yields a promoted verdict", () => {
    const verdict = decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }));
    expect(verdict.kind).toBe("promoted");
    // THE target is COMPUTED (rank + 1), never supplied.
    expect(verdict.targetStage).toBe("shadow");
    expect(verdict.fromStage).toBe("candidate");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.equivalence.admissible).toBe(true);
    expect(verdict.advancedRecord?.stage).toBe("shadow");
    expect(verdict.advancedRecord?.recordId).not.toBe(minedRecord().recordId);
    // The advanced record is a NEW content-addressed value with the
    // SAME evidence (scope, trajectory digest, executors, miner).
    expect(verdict.advancedRecord?.trajectoryDigest).toBe(minedRecord().trajectoryDigest);
    expect(verdict.advancedRecord?.minedBy).toBe(minedRecord().minedBy);
    expect(validateCompetenceRecord(verdict.advancedRecord as never, digest)).toStrictEqual(
      verdict.advancedRecord,
    );
  });

  test("GATE shadow → canary: the completed shadow evidence yields promotion", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: shadowEvidence(100, 0), canary: null }),
    );
    expect(verdict.kind).toBe("promoted");
    expect(verdict.targetStage).toBe("canary");
    expect(verdict.fromStage).toBe("shadow");
  });

  test("GATE canary → deterministic: the completed bounded exposure yields promotion", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.kind).toBe("promoted");
    expect(verdict.targetStage).toBe("deterministic");
    expect(verdict.fromStage).toBe("canary");
    expect(verdict.advancedRecord?.stage).toBe("deterministic");
  });

  test("the TERMINAL stage: a promotion request past deterministic is a gate-order violation", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("deterministic"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.targetStage).toBeUndefined();
    expect(verdict.advancedRecord).toBeUndefined();
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["gate-order-violated"]);
    expect(verdict.reasons[0]?.detail).toContain("terminal");
  });

  test("gate-skipping is STRUCTURALLY unrepresentable: the target is always exactly +1", () => {
    // A candidate-stage record presented with FULL canary evidence
    // STILL only advances to shadow (never to canary/deterministic).
    const verdict = decidePromotion(
      promotionInput(minedRecord(), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.targetStage).toBe("shadow");
    // A shadow-stage record presented with full canary evidence only
    // advances to canary (never to deterministic).
    const shadow = decidePromotion(
      promotionInput(atStage("shadow"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(shadow.targetStage).toBe("canary");
    // The stage-advance helper itself rejects jumps.
    const jump = capture(() => advanceStage(minedRecord(), "deterministic", digest));
    expect(jump).toBeInstanceOf(CompetenceEconomicsError);
    expect((jump as CompetenceEconomicsError).invariant).toBe("promotion-input-shape");
    const sameStage = capture(() => advanceStage(minedRecord(), "candidate", digest));
    expect((sameStage as CompetenceEconomicsError).invariant).toBe("promotion-input-shape");
  });

  test("NO SELF-PROMOTION: a trajectory executor can never promote the record", () => {
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "agent-worker-01"),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toContain("self-promotion");
    expect(verdict.advancedRecord).toBeUndefined();
    expect(verdict.targetStage).toBeUndefined();
  });

  test("NO SELF-PROMOTION: the record's own miner can never promote it either", () => {
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "mining-job-07"),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toContain("self-promotion");
  });

  test("an unknown requesting authority is a typed input rejection", () => {
    const caught = capture(() =>
      decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }, "NOT VALID!")),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("promotion-input-shape");
  });

  test("the shadow gate HOLDS until the observation bound is met (never rejects early)", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: shadowEvidence(42, 0), canary: null }),
    );
    expect(verdict.kind).toBe("hold");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["shadow-observation-bound"]);
    expect(verdict.reasons[0]?.detail).toContain("42 of the required 100");
  });

  test("shadow deviations are PERMANENT inadmissibility (reject)", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: shadowEvidence(100, 1), canary: null }),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["shadow-observation-bound"]);
    expect(verdict.reasons[0]?.detail).toContain("deviations");
  });

  test("missing shadow evidence is a typed hold with its reason", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: null, canary: null }),
    );
    expect(verdict.kind).toBe("hold");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["shadow-observation-bound"]);
  });

  test("the canary gate: not-yet-begun exposure HOLDS; exceeded exposure REJECTS", () => {
    const unbegun = decidePromotion(
      promotionInput(atStage("canary"), { shadow: shadowEvidence(100, 0), canary: null }),
    );
    expect(unbegun.kind).toBe("hold");
    expect(unbegun.reasons.map((reason) => reason.code)).toEqual(["canary-exposure-bound"]);

    const zero = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(0, 0, 0),
      }),
    );
    expect(zero.kind).toBe("hold");

    const exceeded = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(51, 51, 0),
      }),
    );
    expect(exceeded.kind).toBe("reject");
    expect(exceeded.reasons.map((reason) => reason.code)).toEqual(["canary-exposure-bound"]);
    expect(exceeded.reasons[0]?.detail).toContain("exceeds the policy bound");
  });

  test("the canary success-rate and deviation bounds are enforced (reject)", () => {
    const lowRate = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 48, 0),
      }),
    );
    expect(lowRate.kind).toBe("reject");
    expect(lowRate.reasons.map((reason) => reason.code)).toEqual(["canary-exposure-bound"]);
    expect(lowRate.reasons[0]?.detail).toContain("below the required");

    const deviations = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 2),
      }),
    );
    expect(deviations.kind).toBe("reject");
    expect(deviations.reasons[0]?.detail).toContain("deviations");
  });

  test("the equivalence suite is RE-EVALUATED under the governing policy floor at every gate", () => {
    // A replacement whose suite passes its OWN declared rate (0.95)
    // but fails the configuration's policy floor (0.99): the gate
    // rejects with the typed evidence-suite-failed reason.
    const weak = admitDeterministicReplacement({
      scope,
      capabilityId: "text-generation",
      tags: ["classify", "structured-output"],
      incumbent: {
        representationClass: "sufficient-model",
        claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
      },
      binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
      claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
      suite: weakSuite(),
      digest,
    });
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, PROMOTER_AUTHORITY, weak),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["evidence-suite-failed"]);
    expect(verdict.reasons[0]?.detail).toContain("differential");
    expect(verdict.equivalence.admissible).toBe(false);
    expect(verdict.equivalence.observedMatchRate).toBe(0.96);
  });

  test("the shared economics admissibility governs (the model-economics machinery)", () => {
    // A replacement whose claim quality (0.75) is below the hard
    // quality floor (0.8): the promotion is rejected with the
    // model-economics plane's OWN reason code.
    const verdict = decidePromotion(
      promotionInput(
        minedRecord(),
        { shadow: null, canary: null },
        PROMOTER_AUTHORITY,
        belowFloorReplacement(),
      ),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["quality-below-hard-floor"]);
    expect(verdict.facts.qualityFloor).toBe(0.85);
    expect(verdict.facts.hardQualityFloor).toBe(0.8);
  });

  test("record/replacement coherence is validated fail-closed (typed)", () => {
    const foreign = admitDeterministicReplacement({
      scope,
      capabilityId: "document-retrieval",
      tags: ["classify", "structured-output"],
      incumbent: {
        representationClass: "sufficient-model",
        claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
      },
      binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
      claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
      suite: fullSuite(),
      digest,
    });
    const caught = capture(() =>
      decidePromotion(
        promotionInput(minedRecord(), { shadow: null, canary: null }, PROMOTER_AUTHORITY, foreign),
      ),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("promotion-input-shape");

    // Cross-tenant replacement: coherence rejection.
    const crossTenant = { ...replacementCandidate() };
    const tampered = capture(() =>
      decidePromotion(
        promotionInput(minedRecord(), { shadow: null, canary: null }, PROMOTER_AUTHORITY, {
          ...crossTenant,
          scope: {
            tenantId: "00000000-0000-7000-8000-0000000000dd",
            applicationId: scope.applicationId,
          },
        } as never),
      ),
    );
    expect(tampered).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the tampered record/replacement never reach a verdict (read-time validation)", () => {
    const record = minedRecord();
    const tamperedRecord = { ...record, trajectoryDigest: digest.sha256Hex("forged") };
    const caught = capture(() =>
      decidePromotion(promotionInput(tamperedRecord as never, { shadow: null, canary: null })),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);

    const replacement = replacementCandidate();
    const tamperedReplacement = {
      ...replacement,
      claim: { ...replacement.claim, expectedCostMicroUsd: "1" },
    };
    const caughtReplacement = capture(() =>
      decidePromotion(
        promotionInput(
          minedRecord(),
          { shadow: null, canary: null },
          PROMOTER_AUTHORITY,
          tamperedReplacement as never,
        ),
      ),
    );
    expect(caughtReplacement).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the decision is deterministic and idempotent (byte-identical verdicts)", () => {
    const input = promotionInput(minedRecord(), { shadow: null, canary: null });
    const first = decidePromotion(input);
    const second = decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Every verdict carries the frozen decision basis.
    expect(first.decisionBasis).toContain("gated-path-only-one-stage-at-a-time");
    expect(first.decisionBasis).toContain("target-computed-never-supplied");
  });

  test("the configuration and gate evidence are validated fail-closed", () => {
    expect(
      capture(() =>
        decidePromotion({
          ...promotionInput(minedRecord(), { shadow: null, canary: null }),
          configuration: { ...promotionConfiguration(), shadowObservationBound: 0 },
        }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        decidePromotion({
          ...promotionInput(minedRecord(), { shadow: null, canary: null }),
          configuration: { ...promotionConfiguration(), canaryRequiredSuccessRate: 0 },
        }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    // HONEST CONSUMPTION: the quality facts are validated by the
    // model-economics plane's OWN validator — its error propagates
    // as its own type, never re-branded.
    const foreignQuality = capture(() =>
      decidePromotion({
        ...promotionInput(minedRecord(), { shadow: null, canary: null }),
        qualityFacts: { requiredQuality: 1.5 },
      }),
    );
    expect(foreignQuality).toBeInstanceOf(Error);
    expect(foreignQuality).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((foreignQuality as Error).name).toBe("ModelEconomicsError");
    expect(
      capture(() =>
        decidePromotion(
          promotionInput(minedRecord(), {
            shadow: { observationsCount: -1, deviationCount: 0, basis: "x" },
            canary: null,
          }),
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        decidePromotion(
          promotionInput(minedRecord(), {
            shadow: null,
            canary: { exposureCount: 5, successCount: 6, deviationCount: 0, basis: "x" },
          }),
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    // The validators are directly total too.
    expect(
      capture(() =>
        validatePromotionConfiguration({ ...promotionConfiguration(), canaryExposureBound: 10001 }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateShadowEvidence({ observationsCount: 0, deviationCount: 1, basis: "x" }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateCanaryEvidence({
          exposureCount: -1,
          successCount: 0,
          deviationCount: 0,
          basis: "x",
        }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the verdict's governing facts are the shared machinery's own derivation", () => {
    const verdict = decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }));
    // qualityFloor = max(requiredQuality 0.85, hard quality 0.8) = 0.85;
    // the budget ceiling rides the governing constraint set.
    expect(verdict.facts.qualityFloor).toBe(qualityFacts().requiredQuality);
    expect(verdict.facts.hardQualityFloor).toBe(0.8);
    expect(verdict.facts.budgetCeilingsMicroUsd).toEqual(["1000000"]);
  });
});
