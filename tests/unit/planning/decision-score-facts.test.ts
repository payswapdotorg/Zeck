/**
 * Unit: the decision-score typed-facts plane (planning module domain,
 * ACR-011 §2; work order PCD-001 — the PREDICTION plane).
 *
 * Covers EXHAUSTIVELY: every closed-vocabulary member (the acceptance
 * matrices loop over the frozen arrays), every fail-closed boundary
 * (unknown members, out-of-bound values, incoherent shapes — each with
 * the exact reason), the provenance incoherence rejections, the
 * mass-summing honesty for failure-class-distribution (the reconciled
 * honest remainder), the digest determinism (byte-identical re-runs,
 * permuted input order, pinned canonical form, injected digest), and
 * the absence-equivalence discipline (undefined and null are BOTH the
 * absent spelling — a declared zero mass never collapses into an
 * absent class).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  DecisionRecordIdentity,
  DecisionScoreEntry,
  DecisionScoreFacts,
  ScoreProvenance,
} from "../../../src/modules/planning/domain/decision-score-facts";
import {
  CONFIDENCE_DISCIPLINES,
  canonicalDecisionScoreJson,
  checkDecisionScoreBoundary,
  DECISION_SCORE_KINDS,
  decisionScoreFactsIdentity,
  MASS_RECONCILIATION_TOLERANCE,
  MAX_BOUNDARY_CANDIDATES,
  MAX_SCORE_ENTRIES,
  MAX_SCORED_ESTIMATE,
  SCORED_FAILURE_CLASSES,
  SCORER_KINDS,
  validateDecisionScoreFacts,
  validateOptionalDecisionScoreFacts,
} from "../../../src/modules/planning/domain/decision-score-facts";

const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

/** The external-scorer provenance (a Jev-style interchangeable scorer). */
const externalScorerProvenance: ScoreProvenance = {
  scorer: {
    kind: "external-scorer",
    identity: "jev",
    version: "1.4.2",
    configurationDigest: "cafe0123",
  },
  calibrationBasisDigest: "beef0456",
  candidateId: "strategy-a",
  scoringContextDigest: "d00d03aa",
};

/** The candidate-success entry: a probability with declared bounds containing it. */
const successEntry: DecisionScoreEntry = {
  value: { kind: "candidate-success", probability: 0.72 },
  confidence: { kind: "bounded", lowerBound: 0.6, upperBound: 0.8 },
  provenance: externalScorerProvenance,
};

/** The failure-class-distribution entry: a reconciled mass over the closed taxonomy. */
const distributionEntry: DecisionScoreEntry = {
  value: {
    kind: "failure-class-distribution",
    masses: { "provider-5xx": 0.2, "provider-timeout": 0.1 },
    remainder: 0.7,
  },
  confidence: { kind: "bounded", lowerBound: 0.25, upperBound: 0.35 },
  provenance: externalScorerProvenance,
};

/** The verifier-value entry: a declared-scale estimate with the honest unbounded-unknown. */
const verifierValueEntry: DecisionScoreEntry = {
  value: { kind: "verifier-value", estimate: 1250.5, scale: "micro-usd-verification-value" },
  confidence: { kind: "unbounded-unknown" },
  provenance: {
    scorer: {
      kind: "deterministic-baseline",
      identity: "zeck-baseline",
      version: "1.0.0",
      configurationDigest: "1234abcd",
    },
    calibrationBasisDigest: "00000000",
    candidateId: "strategy-b",
    scoringContextDigest: "d00d03aa",
  },
};

/** The route-suitability entry: a declared-scale ranking score with declared bounds. */
const routeSuitabilityEntry: DecisionScoreEntry = {
  value: { kind: "route-suitability", estimate: 3.5, scale: "rank-points-0-10" },
  confidence: { kind: "bounded", lowerBound: 3, upperBound: 4 },
  provenance: {
    scorer: {
      kind: "zeck-trained",
      identity: "zeck-route-model",
      version: "0.3.1",
      configurationDigest: "abcd1234",
    },
    calibrationBasisDigest: "11112222",
    candidateId: "strategy-b",
    scoringContextDigest: "d00d03aa",
  },
};

/** The coherent four-entry fixture: all four score kinds, all three scorer kinds, both confidences. */
const scoreFacts: DecisionScoreFacts = {
  entries: [successEntry, distributionEntry, verifierValueEntry, routeSuitabilityEntry],
};

/** The decision-record side: two admissible candidates (the attachment boundary's other side). */
const record: DecisionRecordIdentity = {
  decisionId: "decision-0001",
  candidates: [
    { candidateId: "strategy-a", admissible: true },
    { candidateId: "strategy-b", admissible: true },
  ],
};

// ---------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------

describe("decision score facts — the closed vocabularies", () => {
  test("the score-kind vocabulary is pinned exactly (widening is a reviewed change)", () => {
    expect([...DECISION_SCORE_KINDS]).toEqual([
      "candidate-success",
      "failure-class-distribution",
      "verifier-value",
      "route-suitability",
    ]);
  });

  test("the scorer-kind vocabulary is pinned exactly (who scored)", () => {
    expect([...SCORER_KINDS]).toEqual([
      "deterministic-baseline",
      "external-scorer",
      "zeck-trained",
    ]);
  });

  test("the confidence-discipline vocabulary is pinned exactly (bounded | the honest unknown)", () => {
    expect([...CONFIDENCE_DISCIPLINES]).toEqual(["bounded", "unbounded-unknown"]);
  });

  test("the per-leg failure taxonomy is pinned exactly (the closed seven, mirrored by value)", () => {
    expect([...SCORED_FAILURE_CLASSES]).toEqual([
      "provider-5xx",
      "provider-timeout",
      "provider-throttle",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
    ]);
  });

  test("the typed bounds are pinned (every field closed or bounded)", () => {
    expect(MAX_SCORE_ENTRIES).toBe(256);
    expect(MAX_BOUNDARY_CANDIDATES).toBe(256);
    expect(MAX_SCORED_ESTIMATE).toBe(1_000_000_000);
    expect(MASS_RECONCILIATION_TOLERANCE).toBe(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed validation of the closed block — every member, every boundary
// ---------------------------------------------------------------------------

describe("decision score facts — fail-closed validation of the closed block", () => {
  test("a non-object is rejected (never a permissive default)", () => {
    expect(validateDecisionScoreFacts(null)).toEqual({
      valid: false,
      reason: "decisionScoreFacts must be an object (the closed fact block)",
    });
    expect(validateDecisionScoreFacts("facts")).toEqual({
      valid: false,
      reason: "decisionScoreFacts must be an object (the closed fact block)",
    });
    expect(validateDecisionScoreFacts(7)).toEqual({
      valid: false,
      reason: "decisionScoreFacts must be an object (the closed fact block)",
    });
  });

  test("entries must be an array", () => {
    expect(validateDecisionScoreFacts({ entries: "strategy-a" })).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries must be an array of score entries (the closed block carries its predictions as entries)",
    });
  });

  test("a present-but-empty block is the zombie shape, rejected typed", () => {
    expect(validateDecisionScoreFacts({ entries: [] })).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries must declare at least one score entry (a present-but-empty block is the zombie shape — the block's absence is the absent spelling, never an empty block)",
    });
  });

  test("the entry census is bounded", () => {
    const entries = Array.from({ length: MAX_SCORE_ENTRIES + 1 }, (_, index) => ({
      ...successEntry,
      provenance: { ...externalScorerProvenance, candidateId: `strategy-${index}` },
    }));
    expect(validateDecisionScoreFacts({ entries })).toEqual({
      valid: false,
      reason: `decisionScoreFacts.entries must hold at most ${MAX_SCORE_ENTRIES} score entries (bounded): ${MAX_SCORE_ENTRIES + 1}`,
    });
    // The bound itself is admissible (distinct identities, exactly at the census bound).
    expect(
      validateDecisionScoreFacts({
        entries: Array.from({ length: MAX_SCORE_ENTRIES }, (_, index) => ({
          ...successEntry,
          provenance: { ...externalScorerProvenance, candidateId: `strategy-${index}` },
        })),
      }),
    ).toEqual({ valid: true });
  });

  test("a non-object entry is rejected with the entry shape named", () => {
    expect(validateDecisionScoreFacts({ entries: ["entry"] })).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0] must be a score entry object {value, confidence, provenance}: entry",
    });
  });

  test("EVERY closed-vocabulary member is accepted (the 4x3x2 acceptance matrix)", () => {
    for (const scoreKind of DECISION_SCORE_KINDS) {
      for (const scorerKind of SCORER_KINDS) {
        for (const confidence of CONFIDENCE_DISCIPLINES) {
          const value =
            scoreKind === "candidate-success"
              ? { kind: scoreKind, probability: 0.5 }
              : scoreKind === "failure-class-distribution"
                ? { kind: scoreKind, masses: { "provider-5xx": 0.2 }, remainder: 0.8 }
                : scoreKind === "verifier-value"
                  ? { kind: scoreKind, estimate: 10, scale: "unit-value" }
                  : { kind: scoreKind, estimate: 5, scale: "rank-points-0-10" };
          const confidenceBlock =
            confidence === "bounded"
              ? scoreKind === "candidate-success"
                ? { kind: confidence, lowerBound: 0.4, upperBound: 0.6 }
                : scoreKind === "failure-class-distribution"
                  ? { kind: confidence, lowerBound: 0.15, upperBound: 0.25 }
                  : { kind: confidence, lowerBound: 0, upperBound: 20 }
              : { kind: confidence };
          const facts: DecisionScoreFacts = {
            entries: [
              {
                value,
                confidence: confidenceBlock,
                provenance: {
                  scorer: {
                    kind: scorerKind,
                    identity: "scorer-a",
                    version: "1.0.0",
                    configurationDigest: "cafe0123",
                  },
                  calibrationBasisDigest: "beef0456",
                  candidateId: "strategy-a",
                  scoringContextDigest: "d00d03aa",
                },
              },
            ],
          };
          expect(
            validateDecisionScoreFacts(facts),
            `${scoreKind}/${scorerKind}/${confidence}`,
          ).toEqual({ valid: true });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The typed bounded values — per-kind fail-closed boundaries
// ---------------------------------------------------------------------------

describe("decision score facts — the candidate-success probability", () => {
  test("the probability is a finite number in [0, 1] (the typed bound, fail-closed)", () => {
    for (const probability of [-0.01, 1.01, NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      const verdict = validateDecisionScoreFacts({
        entries: [{ ...successEntry, value: { kind: "candidate-success", probability } }],
      });
      expect(verdict.valid, `probability ${String(probability)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "decisionScoreFacts.entries[0][candidate=strategy-a].value.probability must be a finite number in [0, 1]",
      );
    }
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            value: { kind: "candidate-success", probability: 0 },
            confidence: { kind: "bounded", lowerBound: 0, upperBound: 0.2 },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            value: { kind: "candidate-success", probability: 1 },
            confidence: { kind: "bounded", lowerBound: 0, upperBound: 1 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("an unknown score kind fails closed with the exact reason (never a default)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [{ ...successEntry, value: { kind: "task-success", probability: 0.5 } }],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].value.kind must be one of candidate-success|failure-class-distribution|verifier-value|route-suitability: task-success",
    });
    expect(
      validateDecisionScoreFacts({ entries: [{ ...successEntry, value: undefined }] }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].value must be the typed score value {kind: candidate-success | failure-class-distribution | verifier-value | route-suitability, …}: undefined",
    });
  });
});

describe("decision score facts — the failure-class-distribution mass honesty", () => {
  test("every taxonomy member is accepted as a mass key (the closed seven, exhaustively)", () => {
    for (const failureClass of SCORED_FAILURE_CLASSES) {
      expect(
        validateDecisionScoreFacts({
          entries: [
            {
              ...distributionEntry,
              value: {
                kind: "failure-class-distribution",
                masses: { [failureClass]: 0.15 },
                remainder: 0.85,
              },
              confidence: { kind: "bounded", lowerBound: 0.1, upperBound: 0.2 },
            },
          ],
        }),
        `${failureClass} partial mass`,
      ).toEqual({ valid: true });
      expect(
        validateDecisionScoreFacts({
          entries: [
            {
              ...distributionEntry,
              value: {
                kind: "failure-class-distribution",
                masses: { [failureClass]: 1 },
                remainder: 0,
              },
              confidence: { kind: "bounded", lowerBound: 0.9, upperBound: 1 },
            },
          ],
        }),
        `${failureClass} full mass`,
      ).toEqual({ valid: true });
    }
  });

  test("an unknown mass key fails closed (the closed taxonomy is never widened)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-503": 0.2 },
              remainder: 0.8,
            },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].value.masses key must be one of provider-5xx|provider-timeout|provider-throttle|connection-error|verification-retry|budget-exhausted|policy-denied: provider-503",
    });
  });

  test("a mass out of [0, 1] fails closed (never a widened value)", () => {
    for (const mass of [-0.1, 1.2, NaN, Number.POSITIVE_INFINITY, "0.2"]) {
      const verdict = validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": mass },
              remainder: 0.8,
            },
          },
        ],
      });
      expect(verdict.valid, `mass ${String(mass)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "decisionScoreFacts.entries[0][candidate=strategy-a].value.masses.provider-5xx must be a finite mass in [0, 1]",
      );
    }
  });

  test("the masses and the honest remainder reconcile the unit mass EXACTLY (the honest full attribution)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.5, "provider-timeout": 0.3 },
              remainder: 0.2,
            },
            confidence: { kind: "bounded", lowerBound: 0.75, upperBound: 0.85 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("an honest decimal distribution summing past the unit mass by float noise is accepted (the tolerance is load-bearing)", () => {
    // 0.2 + 0.4 + 0.3 + 0.1 sums to 1.0000000000000002 in doubles — an
    // honest full attribution, never rejected for float noise.
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: {
                "provider-5xx": 0.2,
                "provider-timeout": 0.4,
                "provider-throttle": 0.3,
                "connection-error": 0.1,
              },
              remainder: 0,
            },
            confidence: { kind: "bounded", lowerBound: 0.9, upperBound: 1 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("an over-attribution is rejected typed (the remainder would need to be negative)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.5, "provider-timeout": 0.3 },
              remainder: 0.5,
            },
            confidence: { kind: "bounded", lowerBound: 0.75, upperBound: 0.85 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].value: the predicted masses and the honest remainder must reconcile the unit mass within 1e-9 (an over-attribution would need a negative remainder and an unattributed gap is never silent): Σmasses=0.8, remainder=0.5, Σmasses+remainder=1.3",
    });
  });

  test("an unattributed gap is rejected typed (the remainder is never silent)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.2 },
              remainder: 0.5,
            },
            confidence: { kind: "bounded", lowerBound: 0.15, upperBound: 0.25 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].value: the predicted masses and the honest remainder must reconcile the unit mass within 1e-9 (an over-attribution would need a negative remainder and an unattributed gap is never silent): Σmasses=0.2, remainder=0.5, Σmasses+remainder=0.7",
    });
  });

  test("the remainder itself is a finite number in [0, 1] (fail-closed)", () => {
    for (const remainder of [-0.1, 1.2, NaN, Number.POSITIVE_INFINITY]) {
      const verdict = validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.2 },
              remainder,
            },
          },
        ],
      });
      expect(verdict.valid, `remainder ${String(remainder)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "decisionScoreFacts.entries[0][candidate=strategy-a].value.remainder must be a finite number in [0, 1]",
      );
    }
  });

  test("masses must be a record over the taxonomy (an array or string is rejected)", () => {
    const cases: readonly [string, unknown, string][] = [
      ["a string", "provider-5xx", "provider-5xx"],
      ["an array", [0.2], "[0.2]"],
      ["a number", 7, "7"],
    ];
    for (const [name, masses, rendered] of cases) {
      expect(
        validateDecisionScoreFacts({
          entries: [
            {
              ...distributionEntry,
              value: { kind: "failure-class-distribution", masses, remainder: 0.8 },
            },
          ],
        }),
        `masses ${name}`,
      ).toEqual({
        valid: false,
        reason: `decisionScoreFacts.entries[0][candidate=strategy-a].value.masses must be the mass record over the closed per-leg failure taxonomy (absent classes carry zero mass): ${rendered}`,
      });
    }
  });
});

describe("decision score facts — the declared-scale estimates", () => {
  test("verifier-value and route-suitability estimates are finite numbers in [0, MAX_SCORED_ESTIMATE]", () => {
    for (const kind of ["verifier-value", "route-suitability"] as const) {
      for (const estimate of [-1, MAX_SCORED_ESTIMATE + 1, NaN, Number.POSITIVE_INFINITY, "5"]) {
        const verdict = validateDecisionScoreFacts({
          entries: [
            {
              ...verifierValueEntry,
              value: { kind, estimate, scale: "unit-value" },
            },
          ],
        });
        expect(verdict.valid, `${kind} estimate ${String(estimate)}`).toBe(false);
        expect(verdict.valid === false && verdict.reason).toContain(
          `decisionScoreFacts.entries[0][candidate=strategy-b].value.estimate must be a finite number in [0, ${MAX_SCORED_ESTIMATE}] (the non-negative bounded ${kind} estimate)`,
        );
      }
      expect(
        validateDecisionScoreFacts({
          entries: [{ ...verifierValueEntry, value: { kind, estimate: 0, scale: "unit-value" } }],
        }),
        `${kind} zero`,
      ).toEqual({ valid: true });
      expect(
        validateDecisionScoreFacts({
          entries: [
            {
              ...verifierValueEntry,
              value: { kind, estimate: MAX_SCORED_ESTIMATE, scale: "unit-value" },
            },
          ],
        }),
        `${kind} bound`,
      ).toEqual({ valid: true });
    }
  });

  test("the declared scale is a bounded non-empty string (two different scales are never comparable)", () => {
    for (const scale of ["", "a".repeat(65), 7]) {
      const verdict = validateDecisionScoreFacts({
        entries: [
          { ...verifierValueEntry, value: { kind: "verifier-value", estimate: 10, scale } },
        ],
      });
      expect(verdict.valid, `scale ${JSON.stringify(scale)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "decisionScoreFacts.entries[0][candidate=strategy-b].value.scale must be a bounded non-empty declared scale (<=64)",
      );
    }
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...verifierValueEntry,
            value: { kind: "verifier-value", estimate: 10, scale: "a".repeat(64) },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// The confidence discipline — declared bounds or the honest unknown
// ---------------------------------------------------------------------------

describe("decision score facts — the confidence discipline", () => {
  test("bounded bounds live in the estimate's own scale (fail-closed per kind)", () => {
    // Probability scale: [0, 1].
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            confidence: { kind: "bounded", lowerBound: -0.1, upperBound: 0.8 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence.lowerBound must be a finite number in [0, 1] (the declared bound lives in the estimate's own scale): -0.1",
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            confidence: { kind: "bounded", lowerBound: 0.6, upperBound: 1.2 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence.upperBound must be a finite number in [0, 1] (the declared bound lives in the estimate's own scale): 1.2",
    });
    // Declared-scale estimates: [0, MAX_SCORED_ESTIMATE].
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...verifierValueEntry,
            confidence: { kind: "bounded", lowerBound: -5, upperBound: 10 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-b].confidence.lowerBound must be a finite number in [0, 1000000000] (the declared bound lives in the estimate's own scale): -5",
    });
  });

  test("an inverted interval is the incoherent shape, rejected typed", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            confidence: { kind: "bounded", lowerBound: 0.8, upperBound: 0.6 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence: bounded requires lowerBound <= upperBound (a declared interval is never inverted): lowerBound=0.8, upperBound=0.6",
    });
  });

  test("a declared interval excluding its own point estimate is the incoherent shape, rejected typed", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            confidence: { kind: "bounded", lowerBound: 0.1, upperBound: 0.2 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence: bounded must contain the estimate (a declared interval excluding its own point estimate is the incoherent shape, rejected): estimate=0.72, lowerBound=0.1, upperBound=0.2",
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...verifierValueEntry,
            confidence: { kind: "bounded", lowerBound: 0, upperBound: 1 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-b].confidence: bounded must contain the estimate (a declared interval excluding its own point estimate is the incoherent shape, rejected): estimate=1250.5, lowerBound=0, upperBound=1",
    });
    // The distribution's interval must contain the frozen-order mass total
    // (tolerantly: 0.2 + 0.1 = 0.30000000000000004 reconciles within the tolerance).
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            confidence: { kind: "bounded", lowerBound: 0.29, upperBound: 0.31 },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            confidence: { kind: "bounded", lowerBound: 0.5, upperBound: 0.6 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence: bounded must contain the estimate (a declared interval excluding its own point estimate is the incoherent shape, rejected): estimate=0.30000000000000004, lowerBound=0.5, upperBound=0.6",
    });
  });

  test("unbounded-unknown cannot carry bounds (an honest unknown is never a fabricated precision)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...verifierValueEntry,
            confidence: { kind: "unbounded-unknown", lowerBound: 0 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-b].confidence: unbounded-unknown cannot carry bounds (the incoherent shape is rejected — an honest unknown is never a fabricated precision)",
    });
    // null bounds are the absent spelling — NOT carried.
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...verifierValueEntry,
            confidence: { kind: "unbounded-unknown", lowerBound: null, upperBound: null },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("an unknown confidence kind fails closed (never a default)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence.kind must be one of bounded|unbounded-unknown: guessed",
    });
    expect(
      validateDecisionScoreFacts({ entries: [{ ...successEntry, confidence: undefined }] }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence must be the confidence {kind: bounded, lowerBound, upperBound} | {kind: unbounded-unknown}: undefined",
    });
  });
});

// ---------------------------------------------------------------------------
// The explicit provenance — the incoherence rejections
// ---------------------------------------------------------------------------

describe("decision score facts — the explicit provenance", () => {
  test("an unattributed prediction is unrepresentable (provenance is required, fail-closed)", () => {
    expect(
      validateDecisionScoreFacts({ entries: [{ ...successEntry, provenance: undefined }] }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance is required on every score entry (the explicit-provenance discipline — an unattributed prediction is unrepresentable): undefined",
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          { ...successEntry, provenance: { ...externalScorerProvenance, scorer: undefined } },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance.scorer is required on every score entry (who scored, at which version, under which configuration digest): undefined",
    });
  });

  test("an unknown scorer kind fails closed with the exact reason", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, kind: "human" },
            },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance.scorer.kind must be one of deterministic-baseline|external-scorer|zeck-trained: human",
    });
  });

  test("scorer identity and version are neutral slugs (fail-closed)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, identity: "Jev" },
            },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance.scorer.identity must be a neutral scorer slug: Jev",
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, version: "1.4.2!" },
            },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance.scorer.version must be a neutral version slug: 1.4.2!",
    });
    // The slug bound itself is admissible.
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, identity: "a".repeat(64) },
            },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, identity: "a".repeat(65) },
            },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason: `decisionScoreFacts.entries[0].provenance.scorer.identity must be a neutral scorer slug: ${"a".repeat(65)}`,
    });
  });

  test("every provenance digest is a lowercase hex digest (8..128 hex characters, fail-closed)", () => {
    for (const [field, digest] of [
      ["configurationDigest", "CAFE0123"],
      ["configurationDigest", "cafe012"],
      ["calibrationBasisDigest", "beef045"],
      ["scoringContextDigest", "d00d03"],
    ] as const) {
      const scorer =
        field === "configurationDigest"
          ? { ...externalScorerProvenance.scorer, configurationDigest: digest }
          : externalScorerProvenance.scorer;
      const provenance =
        field === "calibrationBasisDigest"
          ? { ...externalScorerProvenance, calibrationBasisDigest: digest, scorer }
          : field === "scoringContextDigest"
            ? { ...externalScorerProvenance, scoringContextDigest: digest, scorer }
            : { ...externalScorerProvenance, scorer };
      const verdict = validateDecisionScoreFacts({
        entries: [{ ...successEntry, provenance }],
      });
      expect(verdict.valid, `${field}=${digest}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        `decisionScoreFacts.entries[0].provenance.${field === "configurationDigest" ? "scorer." : ""}${field} must be a lowercase hex digest`,
      );
    }
    // A 128-hex digest is admissible (the digest bound's ceiling).
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              calibrationBasisDigest: "a".repeat(128),
            },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("the candidate identity is bounded and non-empty (fail-closed)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, candidateId: "" },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "decisionScoreFacts.entries[0].provenance.candidateId must be a bounded non-empty identity (<=128): ",
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, candidateId: "c".repeat(129) },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason: `decisionScoreFacts.entries[0].provenance.candidateId must be a bounded non-empty identity (<=128): ${"c".repeat(129)}`,
    });
  });
});

// ---------------------------------------------------------------------------
// The entry census — duplicate-free by the score identity
// ---------------------------------------------------------------------------

describe("decision score facts — the entry census", () => {
  test("a duplicate score identity is rejected typed (candidate + kind + scorer identity + version)", () => {
    expect(validateDecisionScoreFacts({ entries: [successEntry, { ...successEntry }] })).toEqual({
      valid: false,
      reason:
        'decisionScoreFacts.entries must not contain a duplicate score identity (candidate, score kind, scorer identity, scorer version): ["strategy-a","candidate-success","jev","1.4.2"]',
    });
  });

  test("a distinct scorer identity, version, candidate or kind is a distinct entry (representable)", () => {
    expect(
      validateDecisionScoreFacts({
        entries: [
          successEntry,
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, identity: "laya" },
            },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(
      validateDecisionScoreFacts({
        entries: [
          successEntry,
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, version: "1.4.3" },
            },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(
      validateDecisionScoreFacts({
        entries: [
          successEntry,
          {
            ...successEntry,
            value: { kind: "candidate-success", probability: 0.5 },
            confidence: { kind: "bounded", lowerBound: 0.4, upperBound: 0.6 },
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        'decisionScoreFacts.entries must not contain a duplicate score identity (candidate, score kind, scorer identity, scorer version): ["strategy-a","candidate-success","jev","1.4.2"]',
    });
    expect(
      validateDecisionScoreFacts({
        entries: [
          successEntry,
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, candidateId: "strategy-b" },
          },
        ],
      }),
    ).toEqual({ valid: true });
    expect(validateDecisionScoreFacts({ entries: [successEntry, distributionEntry] })).toEqual({
      valid: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Determinism and content-addressable identity
// ---------------------------------------------------------------------------

describe("decision score facts — determinism and content-addressable identity", () => {
  test("the same facts always produce the byte-identical validation verdict", () => {
    const first = validateDecisionScoreFacts(scoreFacts);
    for (let index = 0; index < 5; index += 1) {
      expect(JSON.stringify(validateDecisionScoreFacts(scoreFacts))).toBe(JSON.stringify(first));
    }
    const rejection = validateDecisionScoreFacts({
      entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(
          validateDecisionScoreFacts({
            entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
          }),
        ),
      ).toBe(JSON.stringify(rejection));
    }
  });

  test("input key order never changes the verdict (fields are addressed by name)", () => {
    const permuted = {
      entries: [
        {
          provenance: externalScorerProvenance,
          confidence: { kind: "bounded", lowerBound: 0.6, upperBound: 0.8 },
          value: { kind: "candidate-success", probability: 0.72 },
        },
      ],
    };
    expect(JSON.stringify(validateDecisionScoreFacts(permuted))).toBe(
      JSON.stringify(validateDecisionScoreFacts({ entries: [successEntry] })),
    );
  });

  test("the canonical form is deterministic and pinned (the tagged tuple)", () => {
    expect(canonicalDecisionScoreJson(scoreFacts)).toBe(
      '["planning.decision-score-facts",[[["confidence",[["kind","bounded"],["lowerBound",0.6],["upperBound",0.8]]],["provenance",[["calibrationBasisDigest","beef0456"],["candidateId","strategy-a"],["scorer",[["configurationDigest","cafe0123"],["identity","jev"],["kind","external-scorer"],["version","1.4.2"]]],["scoringContextDigest","d00d03aa"]]],["value",[["kind","candidate-success"],["probability",0.72]]]],[["confidence",[["kind","bounded"],["lowerBound",0.25],["upperBound",0.35]]],["provenance",[["calibrationBasisDigest","beef0456"],["candidateId","strategy-a"],["scorer",[["configurationDigest","cafe0123"],["identity","jev"],["kind","external-scorer"],["version","1.4.2"]]],["scoringContextDigest","d00d03aa"]]],["value",[["kind","failure-class-distribution"],["masses",[["provider-5xx",0.2],["provider-timeout",0.1]]],["remainder",0.7]]]],[["confidence",[["kind","bounded"],["lowerBound",3],["upperBound",4]]],["provenance",[["calibrationBasisDigest","11112222"],["candidateId","strategy-b"],["scorer",[["configurationDigest","abcd1234"],["identity","zeck-route-model"],["kind","zeck-trained"],["version","0.3.1"]]],["scoringContextDigest","d00d03aa"]]],["value",[["estimate",3.5],["kind","route-suitability"],["scale","rank-points-0-10"]]]],[["confidence",[["kind","unbounded-unknown"]]],["provenance",[["calibrationBasisDigest","00000000"],["candidateId","strategy-b"],["scorer",[["configurationDigest","1234abcd"],["identity","zeck-baseline"],["kind","deterministic-baseline"],["version","1.0.0"]]],["scoringContextDigest","d00d03aa"]]],["value",[["estimate",1250.5],["kind","verifier-value"],["scale","micro-usd-verification-value"]]]]]]',
    );
  });

  test("entry order is never identity (the canonical form sorts by the identity tuple)", () => {
    const reordered: DecisionScoreFacts = {
      entries: [...scoreFacts.entries].reverse(),
    };
    expect(canonicalDecisionScoreJson(reordered)).toBe(canonicalDecisionScoreJson(scoreFacts));
    expect(decisionScoreFactsIdentity(reordered, sha256)).toBe(
      decisionScoreFactsIdentity(scoreFacts, sha256),
    );
  });

  test("masses key order is never identity (the canonical form sorts the taxonomy keys)", () => {
    const reorderedMasses: DecisionScoreFacts = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-timeout": 0.1, "provider-5xx": 0.2 },
            remainder: 0.7,
          },
        },
      ],
    };
    expect(canonicalDecisionScoreJson(reorderedMasses)).toBe(
      canonicalDecisionScoreJson({ entries: [distributionEntry] }),
    );
  });

  test("absence equivalence at the canonical level: key-omitted, undefined and null render byte-identically", () => {
    const keyOmitted = { entries: [distributionEntry] };
    const undefinedSpelling = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.2, "provider-timeout": 0.1, "connection-error": undefined },
            remainder: 0.7,
          },
        },
      ],
    };
    const nullSpelling = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.2, "provider-timeout": 0.1, "connection-error": null },
            remainder: 0.7,
          },
        },
      ],
    };
    const canonical = canonicalDecisionScoreJson(keyOmitted as DecisionScoreFacts);
    expect(canonicalDecisionScoreJson(undefinedSpelling as DecisionScoreFacts)).toBe(canonical);
    expect(canonicalDecisionScoreJson(nullSpelling as DecisionScoreFacts)).toBe(canonical);
    expect(
      new Set(
        [keyOmitted, undefinedSpelling, nullSpelling].map((facts) =>
          decisionScoreFactsIdentity(facts as DecisionScoreFacts, sha256),
        ),
      ).size,
    ).toBe(1);
  });

  test("a declared zero mass is NEVER the absent class (no placeholder collapse)", () => {
    const zeroMass: DecisionScoreFacts = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.2, "provider-timeout": 0.1, "connection-error": 0 },
            remainder: 0.7,
          },
        },
      ],
    };
    expect(validateDecisionScoreFacts(zeroMass)).toEqual({ valid: true });
    expect(canonicalDecisionScoreJson(zeroMass)).not.toBe(
      canonicalDecisionScoreJson({ entries: [distributionEntry] }),
    );
    expect(decisionScoreFactsIdentity(zeroMass, sha256)).not.toBe(
      decisionScoreFactsIdentity({ entries: [distributionEntry] }, sha256),
    );
  });

  test("every field participates in the content address (distinct facts → distinct identities)", () => {
    const base = decisionScoreFactsIdentity(scoreFacts, sha256);
    const variants: readonly DecisionScoreFacts[] = [
      {
        entries: [
          successEntry,
          distributionEntry,
          verifierValueEntry,
          {
            ...routeSuitabilityEntry,
            value: { kind: "route-suitability", estimate: 3.6, scale: "rank-points-0-10" },
          },
        ],
      },
      {
        entries: [
          successEntry,
          distributionEntry,
          verifierValueEntry,
          {
            ...routeSuitabilityEntry,
            value: { kind: "route-suitability", estimate: 3.5, scale: "rank-points-0-100" },
          },
        ],
      },
      {
        entries: [
          successEntry,
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.3, "provider-timeout": 0.1 },
              remainder: 0.6,
            },
            confidence: { kind: "bounded", lowerBound: 0.35, upperBound: 0.45 },
          },
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          successEntry,
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.2, "provider-timeout": 0.1 },
              remainder: 0.6,
            },
            confidence: { kind: "bounded", lowerBound: 0.25, upperBound: 0.35 },
          },
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            value: { kind: "candidate-success", probability: 0.73 },
            confidence: { kind: "bounded", lowerBound: 0.6, upperBound: 0.8 },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          { ...successEntry, confidence: { kind: "bounded", lowerBound: 0.61, upperBound: 0.8 } },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          { ...successEntry, confidence: { kind: "unbounded-unknown" } },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          successEntry,
          distributionEntry,
          verifierValueEntry,
          {
            ...routeSuitabilityEntry,
            confidence: { kind: "bounded", lowerBound: 3.1, upperBound: 4 },
          },
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, kind: "zeck-trained" },
            },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, identity: "laya" },
            },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, version: "1.4.3" },
            },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: {
              ...externalScorerProvenance,
              scorer: { ...externalScorerProvenance.scorer, configurationDigest: "cafe0124" },
            },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, calibrationBasisDigest: "beef0457" },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, candidateId: "strategy-c" },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
      {
        entries: [
          {
            ...successEntry,
            provenance: { ...externalScorerProvenance, scoringContextDigest: "d00d03ab" },
          },
          distributionEntry,
          verifierValueEntry,
          routeSuitabilityEntry,
        ],
      },
    ];
    const identities = new Set([base]);
    for (const variant of variants) {
      const identity = decisionScoreFactsIdentity(variant, sha256);
      expect(identity).not.toBe(base);
      identities.add(identity);
    }
    expect(identities.size).toBe(variants.length + 1);
  });

  test("the identity is the sha256 over the canonical form (deterministic, hex)", () => {
    const identity = decisionScoreFactsIdentity(scoreFacts, sha256);
    expect(identity).toBe(sha256(canonicalDecisionScoreJson(scoreFacts)));
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(decisionScoreFactsIdentity(scoreFacts, sha256)).toBe(identity);
  });

  test("the digest is injected, never ambient (any digest function is legal input)", () => {
    expect(decisionScoreFactsIdentity(scoreFacts, () => "digest-of")).toBe("digest-of");
  });
});

// ---------------------------------------------------------------------------
// The attachment-boundary check (pure, no wiring)
// ---------------------------------------------------------------------------

describe("decision score facts — the attachment-boundary check", () => {
  test("absence of either side skips the check (absence-equivalent, both spellings)", () => {
    expect(checkDecisionScoreBoundary({ facts: undefined, record })).toEqual({
      kind: "skipped",
      reason: "facts-absent",
    });
    expect(checkDecisionScoreBoundary({ facts: null, record })).toEqual({
      kind: "skipped",
      reason: "facts-absent",
    });
    expect(checkDecisionScoreBoundary({ facts: scoreFacts, record: undefined })).toEqual({
      kind: "skipped",
      reason: "record-absent",
    });
    expect(checkDecisionScoreBoundary({ facts: scoreFacts, record: null })).toEqual({
      kind: "skipped",
      reason: "record-absent",
    });
    expect(checkDecisionScoreBoundary({ facts: undefined, record: undefined })).toEqual({
      kind: "skipped",
      reason: "both-sides-absent",
    });
    expect(checkDecisionScoreBoundary({ facts: null, record: null })).toEqual({
      kind: "skipped",
      reason: "both-sides-absent",
    });
  });

  test("a coherent block attaches (compatible — every entry scores an admissible candidate)", () => {
    expect(checkDecisionScoreBoundary({ facts: scoreFacts, record })).toEqual({
      kind: "compatible",
    });
  });

  test("both sides are pre-validated fail-closed BEFORE comparison (a malformed side is never compared)", () => {
    const malformedFacts = {
      entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
    } as never;
    // Even though the candidate ALSO mismatches, the invalid verdict
    // wins — the malformed side is never compared.
    expect(
      checkDecisionScoreBoundary({
        facts: malformedFacts,
        record: {
          decisionId: "decision-9999",
          candidates: [{ candidateId: "strategy-z", admissible: true }],
        },
      }),
    ).toEqual({
      kind: "invalid",
      side: "facts",
      reason:
        "decisionScoreFacts.entries[0][candidate=strategy-a].confidence.kind must be one of bounded|unbounded-unknown: guessed",
    });
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: { decisionId: "", candidates: record.candidates },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "decisionRecord.decisionId must be a bounded non-empty identity (<=128): ",
    });
    expect(checkDecisionScoreBoundary({ facts: scoreFacts, record: 7 as never })).toEqual({
      kind: "invalid",
      side: "record",
      reason: "decisionRecord must be the record identity {decisionId, candidates}: 7",
    });
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: { decisionId: "decision-0001", candidates: [] },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason:
        "decisionRecord.candidates must be a non-empty array of candidate identities {candidateId, admissible}: []",
    });
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: {
          decisionId: "decision-0001",
          candidates: [{ candidateId: "strategy-a", admissible: "yes" as never }],
        },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason:
        "decisionRecord.candidates entry admissible must be a boolean (the record's own admissibility verdict — never revisited by a score): yes",
    });
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: {
          decisionId: "decision-0001",
          candidates: [
            { candidateId: "strategy-a", admissible: true },
            { candidateId: "strategy-a", admissible: true },
          ],
        },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "decisionRecord.candidates must not contain duplicate candidateId: strategy-a",
    });
  });

  test("the boundary candidate census is bounded (fail-closed)", () => {
    const candidates = Array.from({ length: MAX_BOUNDARY_CANDIDATES + 1 }, (_, index) => ({
      candidateId: `strategy-${index}`,
      admissible: true,
    }));
    expect(
      checkDecisionScoreBoundary({
        facts: { entries: [successEntry] },
        record: { decisionId: "decision-0001", candidates },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: `decisionRecord.candidates must hold at most ${MAX_BOUNDARY_CANDIDATES} candidates (bounded): ${MAX_BOUNDARY_CANDIDATES + 1}`,
    });
    // The bound itself is admissible.
    expect(
      checkDecisionScoreBoundary({
        facts: { entries: [successEntry] },
        record: {
          decisionId: "decision-0001",
          candidates: [
            { candidateId: "strategy-a", admissible: true },
            ...Array.from({ length: MAX_BOUNDARY_CANDIDATES - 1 }, (_, index) => ({
              candidateId: `strategy-${index}`,
              admissible: true,
            })),
          ],
        },
      }),
    ).toEqual({ kind: "compatible" });
  });

  test("an entry claiming a candidate the record does not carry is the typed mismatch (both sides named)", () => {
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: {
          decisionId: "decision-0001",
          candidates: [{ candidateId: "strategy-a", admissible: true }],
        },
      }),
    ).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          kind: "candidate-not-in-set",
          factsProvenance: routeSuitabilityEntry.provenance,
          claimedCandidateId: "strategy-b",
          recordCandidateIds: ["strategy-a"],
          recordAdmissibleCandidateIds: ["strategy-a"],
        },
        {
          kind: "candidate-not-in-set",
          factsProvenance: verifierValueEntry.provenance,
          claimedCandidateId: "strategy-b",
          recordCandidateIds: ["strategy-a"],
          recordAdmissibleCandidateIds: ["strategy-a"],
        },
      ],
    });
  });

  test("an entry scoring an INADMISSIBLE candidate is the typed authority-encroachment mismatch (the ordering-only law)", () => {
    expect(
      checkDecisionScoreBoundary({
        facts: scoreFacts,
        record: {
          decisionId: "decision-0001",
          candidates: [
            { candidateId: "strategy-a", admissible: true },
            { candidateId: "strategy-b", admissible: false },
          ],
        },
      }),
    ).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          kind: "candidate-not-admissible",
          factsProvenance: routeSuitabilityEntry.provenance,
          claimedCandidateId: "strategy-b",
          recordCandidateIds: ["strategy-a", "strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-a"],
        },
        {
          kind: "candidate-not-admissible",
          factsProvenance: verifierValueEntry.provenance,
          claimedCandidateId: "strategy-b",
          recordCandidateIds: ["strategy-a", "strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-a"],
        },
      ],
    });
  });

  test("mismatches are reported in the canonical entry-identity order (input order never reorders the verdict)", () => {
    const reversedFacts: DecisionScoreFacts = { entries: [...scoreFacts.entries].reverse() };
    expect(
      JSON.stringify(
        checkDecisionScoreBoundary({
          facts: reversedFacts,
          record: {
            decisionId: "decision-0001",
            candidates: [{ candidateId: "strategy-a", admissible: true }],
          },
        }),
      ),
    ).toBe(
      JSON.stringify(
        checkDecisionScoreBoundary({
          facts: scoreFacts,
          record: {
            decisionId: "decision-0001",
            candidates: [{ candidateId: "strategy-a", admissible: true }],
          },
        }),
      ),
    );
  });

  test("the boundary verdict is byte-identical across re-runs (pure and total)", () => {
    const first = checkDecisionScoreBoundary({
      facts: scoreFacts,
      record: {
        decisionId: "decision-0001",
        candidates: [{ candidateId: "strategy-a", admissible: false }],
      },
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(
          checkDecisionScoreBoundary({
            facts: scoreFacts,
            record: {
              decisionId: "decision-0001",
              candidates: [{ candidateId: "strategy-a", admissible: false }],
            },
          }),
        ),
      ).toBe(JSON.stringify(first));
    }
  });
});

// ---------------------------------------------------------------------------
// The optional riding (the seam PCD-002 wires — absence-equivalent)
// ---------------------------------------------------------------------------

describe("decision score facts — the optional riding on the decision record", () => {
  test("undefined and null are BOTH the absent spelling — byte-identical valid verdicts", () => {
    expect(validateOptionalDecisionScoreFacts(undefined)).toEqual({ valid: true });
    expect(validateOptionalDecisionScoreFacts(null)).toEqual({ valid: true });
    expect(JSON.stringify(validateOptionalDecisionScoreFacts(undefined))).toBe(
      JSON.stringify(validateOptionalDecisionScoreFacts(null)),
    );
  });

  test("a present block is validated fail-closed (present-invalid never rides)", () => {
    expect(validateOptionalDecisionScoreFacts(scoreFacts)).toEqual({ valid: true });
    const invalid = {
      entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
    } as never;
    expect(validateOptionalDecisionScoreFacts(invalid)).toEqual(
      validateDecisionScoreFacts(invalid),
    );
  });
});
