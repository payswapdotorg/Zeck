/**
 * Unit battery: the differential/property/replay equivalence suite
 * and deterministic replacement admission (WORK-056 AC 4).
 *
 * Proves: EQUIVALENCE IS PROVEN, NOT ASSUMED — a replacement
 * candidate is admitted ONLY with the COMPLETE three-component
 * suite, every component holding WITHIN ITS OWN DECLARED BOUNDS; the
 * binding rides the merged tool-surface plane's OWN closed
 * vocabulary; content-addressed identity, determinism and
 * read-time tamper rejection; the pure suite evaluation under the
 * governing policy floor; honest consumption of the foundation's
 * own claim validator (foreign errors propagate as their own
 * types).
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import {
  admitDeterministicReplacement,
  EQUIVALENCE_EMITTED_CODES,
  equivalenceFailureCode,
  evaluateEquivalenceSuite,
  type ReplacementAdmissionInput,
  validateDeterministicReplacement,
} from "../../../../src/platform/competence-economics/equivalence";
import { CostModelError } from "../../../../src/platform/execution-ir/cost-model";
import { claim, digest, fullSuite, replacementCandidate, scope, weakSuite } from "./world";

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function admissionInput(overrides: Record<string, unknown> = {}): ReplacementAdmissionInput {
  const base: ReplacementAdmissionInput = {
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    incumbent: {
      representationClass: "sufficient-model",
      claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
    },
    binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
    claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
    suite: fullSuite(),
    digest,
  };
  return { ...base, ...overrides } as ReplacementAdmissionInput;
}

describe("equivalence evidence and replacement admission (WORK-056)", () => {
  test("a full-suite candidate is content-addressed and round-trips", () => {
    const candidate = replacementCandidate();
    expect(candidate.replacementId).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.candidateBasis).toContain("full-differential-property-replay-suite-required");
    const validated = validateDeterministicReplacement(candidate, digest);
    expect(validated).toStrictEqual(candidate);
    // The suite is carried WHOLESALE.
    expect(validated.suite).toStrictEqual(fullSuite());
  });

  test("the same inputs produce the byte-identical candidate (determinism)", () => {
    const first = admitDeterministicReplacement(admissionInput());
    const second = admitDeterministicReplacement(admissionInput());
    expect(first).toStrictEqual(second);
    expect(first.replacementId).toBe(second.replacementId);
  });

  test("input tag order does not change the identity (canonical form)", () => {
    const reordered = admitDeterministicReplacement(
      admissionInput({ tags: ["structured-output", "classify"] }),
    );
    expect(reordered.replacementId).toBe(replacementCandidate().replacementId);
  });

  test("a candidate WITHOUT any of the three components is INADMISSIBLE (typed)", () => {
    for (const kind of ["differential", "property", "replay"] as const) {
      const suite = fullSuite() as unknown as Record<string, unknown>;
      const incomplete = { ...suite };
      delete incomplete[kind];
      const caught = capture(() =>
        admitDeterministicReplacement(admissionInput({ suite: incomplete })),
      );
      expect(caught, `missing ${kind}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("equivalence-suite-incomplete");
    }
    // A wholly absent suite is the same typed rejection.
    const absent = capture(() => admitDeterministicReplacement(admissionInput({ suite: {} })));
    expect((absent as CompetenceEconomicsError).invariant).toBe("equivalence-suite-incomplete");
  });

  test("a component failing WITHIN its declared bounds breaks admission (typed)", () => {
    // Differential: observed 999/1000 below the declared rate 1.
    const differential = capture(() =>
      admitDeterministicReplacement(
        admissionInput({
          suite: {
            ...fullSuite(),
            differential: { ...fullSuite().differential, matchedCount: 999 },
          },
        }),
      ),
    );
    expect((differential as CompetenceEconomicsError).invariant).toBe("equivalence-suite-failed");

    // Property: one failure.
    const property = capture(() =>
      admitDeterministicReplacement(
        admissionInput({
          suite: { ...fullSuite(), property: { ...fullSuite().property, failuresCount: 1 } },
        }),
      ),
    );
    expect((property as CompetenceEconomicsError).invariant).toBe("equivalence-suite-failed");

    // Replay: one deviation.
    const replay = capture(() =>
      admitDeterministicReplacement(
        admissionInput({
          suite: { ...fullSuite(), replay: { ...fullSuite().replay, deviationsCount: 1 } },
        }),
      ),
    );
    expect((replay as CompetenceEconomicsError).invariant).toBe("equivalence-suite-failed");
  });

  test("the binding must ride the merged tool-surface plane's OWN vocabulary", () => {
    for (const toolRepresentation of ["model-route", "agent", "NOT-A-REPRESENTATION"]) {
      const caught = capture(() =>
        admitDeterministicReplacement(
          admissionInput({
            binding: { toolRepresentation, ref: "competence-binding-classify-01" },
          }),
        ),
      );
      expect(caught, `binding ${toolRepresentation}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("replacement-shape");
    }
    // The `code` binding representation is also a member of the
    // tool-surface plane's closed vocabulary.
    const code = admitDeterministicReplacement(
      admissionInput({
        binding: { toolRepresentation: "code", ref: "code-api-binding-classify-01" },
      }),
    );
    expect(code.binding.toolRepresentation).toBe("code");
    // A malformed binding reference is a typed rejection.
    const malformed = capture(() =>
      admitDeterministicReplacement(
        admissionInput({ binding: { toolRepresentation: "competence", ref: "NOT VALID" } }),
      ),
    );
    expect((malformed as CompetenceEconomicsError).invariant).toBe("replacement-shape");
  });

  test("the incumbent class must be a member of the foundation ladder", () => {
    const caught = capture(() =>
      admitDeterministicReplacement(
        admissionInput({
          incumbent: {
            representationClass: "NOT-A-CLASS",
            claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
          },
        }),
      ),
    );
    expect((caught as CompetenceEconomicsError).invariant).toBe("replacement-shape");
  });

  test("HONEST CONSUMPTION: the foundation's claim validator rejects with its OWN error", () => {
    const unattributed = capture(() =>
      admitDeterministicReplacement(
        admissionInput({
          claim: {
            expectedCostMicroUsd: "40",
            expectedLatencyMs: 300,
            expectedQuality: 0.93,
            expectedReliability: 0.99,
          },
        }),
      ),
    );
    expect(unattributed).toBeInstanceOf(CostModelError);
    expect(unattributed).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((unattributed as CostModelError).invariant).toBe("unattributed-cost");

    const unreliable = capture(() =>
      admitDeterministicReplacement(admissionInput({ claim: claim("40", 300, 0.93, 0, "src") })),
    );
    expect((unreliable as CostModelError).invariant).toBe("unreliable-representation");
  });

  test("the shape discipline: capability, tags, bounds (typed rejections)", () => {
    expect(
      (
        capture(() =>
          admitDeterministicReplacement(admissionInput({ capabilityId: "NOT A SLUG" })),
        ) as CompetenceEconomicsError
      )?.invariant,
    ).toBe("replacement-shape");
    expect(
      (
        capture(() =>
          admitDeterministicReplacement(admissionInput({ tags: [] })),
        ) as CompetenceEconomicsError
      )?.invariant,
    ).toBe("replacement-shape");
    expect(
      (
        capture(() =>
          admitDeterministicReplacement(admissionInput({ tags: ["classify", "NOT A TAG!"] })),
        ) as CompetenceEconomicsError
      )?.invariant,
    ).toBe("replacement-shape");
    // Suite component shape violations.
    expect(
      (
        capture(() =>
          admitDeterministicReplacement(
            admissionInput({
              suite: {
                ...fullSuite(),
                differential: { ...fullSuite().differential, casesCount: 0 },
              },
            }),
          ),
        ) as CompetenceEconomicsError
      )?.invariant,
    ).toBe("equivalence-shape");
    expect(
      (
        capture(() =>
          admitDeterministicReplacement(
            admissionInput({
              suite: {
                ...fullSuite(),
                replay: { ...fullSuite().replay, kind: "differential" },
              },
            }),
          ),
        ) as CompetenceEconomicsError
      )?.invariant,
    ).toBe("equivalence-shape");
  });

  test("a tampered candidate is rejected at read time (identity re-derivation)", () => {
    const candidate = replacementCandidate();
    const tampered = { ...candidate, claim: { ...candidate.claim, expectedCostMicroUsd: "1" } };
    const caught = capture(() => validateDeterministicReplacement(tampered, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("replacement-shape");
    const foreignBasis = { ...candidate, candidateBasis: "some-other-basis" };
    const basis = capture(() => validateDeterministicReplacement(foreignBasis, digest));
    expect((basis as CompetenceEconomicsError).invariant).toBe("replacement-shape");
  });

  test("the pure suite evaluation: admissible, thresholds, and failure kinds", () => {
    // The full suite holds under a floor below its declared rate.
    const verdict = evaluateEquivalenceSuite(fullSuite(), { minimumMatchRate: 0.9 });
    expect(verdict.admissible).toBe(true);
    expect(verdict.failingKinds).toEqual([]);
    expect(verdict.effectiveMatchRateThreshold).toBe(1);
    expect(verdict.observedMatchRate).toBe(1);

    // The effective threshold is the MAXIMUM of declared and policy floor.
    const maxed = evaluateEquivalenceSuite(fullSuite(), { minimumMatchRate: 1 });
    expect(maxed.effectiveMatchRateThreshold).toBe(1);

    // A policy floor ABOVE the observed rate fails the differential.
    const strict = evaluateEquivalenceSuite(weakSuite(), { minimumMatchRate: 0.99 });
    expect(strict.admissible).toBe(false);
    expect(strict.failingKinds).toEqual(["differential"]);
    expect(strict.observedMatchRate).toBe(0.96);
    expect(strict.effectiveMatchRateThreshold).toBe(0.99);

    // Property failures and replay deviations name their kinds.
    const property = evaluateEquivalenceSuite(
      { ...fullSuite(), property: { ...fullSuite().property, failuresCount: 2 } },
      { minimumMatchRate: 0.9 },
    );
    expect(property.failingKinds).toEqual(["property"]);
    const replay = evaluateEquivalenceSuite(
      { ...fullSuite(), replay: { ...fullSuite().replay, deviationsCount: 2 } },
      { minimumMatchRate: 0.9 },
    );
    expect(replay.failingKinds).toEqual(["replay"]);
    const all = evaluateEquivalenceSuite(
      {
        differential: weakSuite().differential,
        property: { ...fullSuite().property, failuresCount: 2 },
        replay: { ...fullSuite().replay, deviationsCount: 2 },
      },
      { minimumMatchRate: 0.99 },
    );
    expect(all.failingKinds).toEqual(["differential", "property", "replay"]);

    // The evaluation is deterministic and idempotent.
    const first = evaluateEquivalenceSuite(weakSuite(), { minimumMatchRate: 0.99 });
    const second = evaluateEquivalenceSuite(weakSuite(), { minimumMatchRate: 0.99 });
    expect(first).toStrictEqual(second);
  });

  test("the policy floor itself is validated fail-closed", () => {
    expect(
      capture(() => evaluateEquivalenceSuite(fullSuite(), { minimumMatchRate: 0 })),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() => evaluateEquivalenceSuite(fullSuite(), { minimumMatchRate: 1.5 })),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the failure-kind mapping is closed (the promotion vocabulary bridge)", () => {
    for (const kind of ["differential", "property", "replay"] as const) {
      expect(equivalenceFailureCode(kind)).toBe("evidence-suite-failed");
    }
    // An unmappable kind fails closed.
    expect(capture(() => equivalenceFailureCode("NOT-A-KIND" as never))).toBeInstanceOf(
      CompetenceEconomicsError,
    );
    // The emitted-codes proof set is the closed pair.
    expect(EQUIVALENCE_EMITTED_CODES).toEqual([
      "evidence-suite-incomplete",
      "evidence-suite-failed",
    ]);
  });
});
