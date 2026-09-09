/**
 * Fresh-escalation decision-hook unit tests (WORK-053): the typed
 * escalate/continue/no-admissible decision with its recorded
 * comparison evidence — strict-cheaper escalation, the equal-cost
 * continue default, quality-preserving escalation off a degraded
 * continuation, hard floors/ceilings on BOTH paths (including the
 * reliability floor), and determinism. Record-only: no recovery
 * behavior exists here (WORK-055's surface).
 */

import { describe, expect, test } from "vitest";
import {
  CONTINUATION_PATH_CANDIDATE_ID,
  decideFreshEscalation,
  ESCALATION_PATH_CANDIDATE_ID,
  FRESH_ESCALATION_DECISION_BASIS,
} from "../../../../src/platform/model-economics/escalation-hooks";
import { claim, constraints, reliabilityFloorConstraint } from "./world";

const GOOD = { cost: "1000", latency: 2000, quality: 0.95, reliability: 0.9 };

describe("the fresh-escalation decision hook (records decisions only)", () => {
  test("escalates when the fresh path is sufficient and STRICTLY cheaper", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ ...GOOD, cost: "2000" }),
      freshContext: claim({ ...GOOD, cost: "1000" }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("escalate-fresh-context");
    // The premium is in expected SUCCESSFUL-RESOLUTION costs:
    // ceil(2000/0.9) = 2223 − ceil(1000/0.9) = 1112 → 1111.
    expect(decision.comparison.continuationPremiumMicroUsd).toBe("1111");
    expect(decision.comparison.freshContext.admissible).toBe(true);
    expect(decision.comparison.continuation.admissible).toBe(true);
    expect(decision.selectionBasis).toBe(FRESH_ESCALATION_DECISION_BASIS);
  });

  test("EQUAL expected costs CONTINUE (no churn without strict economic justification)", () => {
    const decision = decideFreshEscalation({
      continuation: claim(GOOD),
      freshContext: claim(GOOD),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("continue-current-context");
    expect(decision.comparison.continuationPremiumMicroUsd).toBe("0");
  });

  test("a COSTLIER fresh path continues (even when sufficient)", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ ...GOOD, cost: "1000" }),
      freshContext: claim({ ...GOOD, cost: "2000" }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("continue-current-context");
    // ceil(1000/0.9) = 1112 − ceil(2000/0.9) = 2223 → −1111.
    expect(decision.comparison.continuationPremiumMicroUsd).toBe("-1111");
  });

  test("a DEGRADED continuation escalates (quality-preserving economics)", () => {
    const decision = decideFreshEscalation({
      // Below the 0.9 assurance floor, above the 0.85 hard floor —
      // recorded with the comparison-evidence code.
      continuation: claim({ ...GOOD, cost: "500", quality: 0.87 }),
      freshContext: claim({ ...GOOD, cost: "2000" }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("escalate-fresh-context");
    expect(decision.comparison.continuation.admissible).toBe(false);
    expect(decision.comparison.continuation.inadmissibleCode).toBe("quality-below-assurance");
    expect(CONTINUATION_PATH_CANDIDATE_ID).toBe("continue-current-context");
    expect(ESCALATION_PATH_CANDIDATE_ID).toBe("escalate-fresh-context");
  });

  test("an insufficient fresh path CONTINUES (only the continuation is sufficient)", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ ...GOOD, cost: "1000" }),
      freshContext: claim({ ...GOOD, cost: "500", quality: 0.87 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("continue-current-context");
    expect(decision.comparison.freshContext.inadmissibleCode).toBe("quality-below-assurance");
  });

  test("BOTH paths below the floor: the honest typed no-admissible outcome", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ ...GOOD, quality: 0.8 }),
      freshContext: claim({ ...GOOD, quality: 0.83 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("no-admissible-candidate");
    expect(decision.comparison.continuation.inadmissibleCode).toBe("quality-below-hard-floor");
    expect(decision.comparison.freshContext.inadmissibleCode).toBe("quality-below-hard-floor");
  });

  test("hard ceilings on BOTH paths: an over-ceiling fresh path continues", () => {
    const decision = decideFreshEscalation({
      continuation: claim({ ...GOOD, cost: "1000", latency: 2000 }),
      freshContext: claim({ ...GOOD, cost: "500", latency: 9000 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [
        ...constraints().filter((constraint) => constraint.kind !== "policy"),
        {
          constraintId: "latency-1",
          kind: "latency" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { maxLatencyMs: 4000 },
        },
      ],
    });
    expect(decision.kind).toBe("continue-current-context");
    expect(decision.comparison.freshContext.inadmissibleCode).toBe("latency-ceiling");
  });

  test("the hard RELIABILITY floor applies to both paths (never a weaker gate)", () => {
    const decision = decideFreshEscalation({
      // Continuation below the 0.95 hard reliability floor: even a
      // costlier fresh path escalates (the floor is inviolable).
      continuation: claim({ ...GOOD, cost: "100", reliability: 0.8 }),
      freshContext: claim({ ...GOOD, cost: "5000", reliability: 0.99 }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [...constraints(), reliabilityFloorConstraint(0.95)],
    });
    expect(decision.kind).toBe("escalate-fresh-context");
    expect(decision.comparison.continuation.inadmissibleCode).toBe("reliability-below-floor");
  });

  test("determinism: identical inputs produce the identical decision", () => {
    const input = {
      continuation: claim({ ...GOOD, cost: "2000" }),
      freshContext: claim({ ...GOOD, cost: "1000" }),
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    expect(decideFreshEscalation(input)).toEqual(decideFreshEscalation(input));
  });
});
