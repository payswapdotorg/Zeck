/**
 * Discrimination: the decision-score typed-facts plane (planning module
 * domain, ACR-011 §2; work order PCD-001 — the PREDICTION plane).
 *
 * Proves the weakened protections FAIL (the discrimination discipline —
 * tests/unit proves the happy paths; this suite proves each protection
 * is load-bearing):
 *
 *  - S1 ABSENCE EQUIVALENCE DISCRIMINATED: the absence spellings
 *    (undefined, null) select byte-identical verdicts at the optional
 *    seam and byte-identical skip verdicts at the boundary — a
 *    spelling difference can never change behavior; plus the
 *    fixed-corpus replay pin (deterministic verdicts, sha256-pinned —
 *    the plane is NEW, so the pinned digest is the capture of THIS
 *    module's own verdict stream; the pre-change behavior it must
 *    preserve is the ABSENCE, pinned by the absence lines and the
 *    architecture confinement law).
 *  - S2 THE MUTATION RECORD: every field mutation that would weaken
 *    the plane (unknown vocabulary members, out-of-bounds values, the
 *    non-reconciled mass distribution, the unattributed prediction,
 *    the incoherent confidences, the duplicate score identity) is
 *    rejected by pure validation, by the optional seam, and at the
 *    boundary — and each rejection is LOAD-BEARING (the unmutated
 *    fixture passes, the single mutation flips the verdict, naming
 *    the field).
 *  - S3 THE BOUNDARY DISCRIMINATION: a malformed side is never
 *    compared (invalid beats mismatched — a hand-rolled weak check
 *    that skips pre-validation admits a malformed block where the pure
 *    check fails closed); identity mismatches name both sides; the
 *    ordering-only law is load-bearing (an entry scoring an
 *    inadmissible candidate is the typed authority-encroachment
 *    mismatch, never a silent ride); re-runs are byte-identical.
 *  - S4 NO SILENT DEFAULTING: unknown enum members never default to a
 *    member; the honest unbounded-unknown never collapses into a
 *    fabricated bounded interval; a declared zero mass never collapses
 *    into an absent class; an over-attributed distribution is never
 *    silently truncated to the unit mass.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  DecisionRecordIdentity,
  DecisionScoreEntry,
  DecisionScoreFacts,
} from "../../src/modules/planning/domain/decision-score-facts";
import {
  canonicalDecisionScoreJson,
  checkDecisionScoreBoundary,
  decisionScoreFactsIdentity,
  validateDecisionScoreFacts,
  validateOptionalDecisionScoreFacts,
} from "../../src/modules/planning/domain/decision-score-facts";

const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

const successEntry: DecisionScoreEntry = {
  value: { kind: "candidate-success", probability: 0.72 },
  confidence: { kind: "bounded", lowerBound: 0.6, upperBound: 0.8 },
  provenance: {
    scorer: {
      kind: "external-scorer",
      identity: "jev",
      version: "1.4.2",
      configurationDigest: "cafe0123",
    },
    calibrationBasisDigest: "beef0456",
    candidateId: "strategy-a",
    scoringContextDigest: "d00d03aa",
  },
};

const distributionEntry: DecisionScoreEntry = {
  value: {
    kind: "failure-class-distribution",
    masses: { "provider-5xx": 0.2, "provider-timeout": 0.1 },
    remainder: 0.7,
  },
  confidence: { kind: "bounded", lowerBound: 0.25, upperBound: 0.35 },
  provenance: { ...successEntry.provenance },
};

/** The coherent two-entry fixture (two distinct score kinds, one scorer, one candidate). */
const validFacts: DecisionScoreFacts = {
  entries: [successEntry, distributionEntry],
};

const record: DecisionRecordIdentity = {
  decisionId: "decision-0001",
  candidates: [
    { candidateId: "strategy-a", admissible: true },
    { candidateId: "strategy-b", admissible: true },
  ],
};

describe("discrimination: decision-score typed facts (PCD-001 — the prediction plane)", () => {
  // -------------------------------------------------------------------------
  // S1 — absence equivalence discriminated
  // -------------------------------------------------------------------------

  test("S1a the absence spellings select byte-identical optional-seam verdicts", () => {
    const noKey = validFacts;
    const undefinedSpelling = { ...validFacts, decisionScoreFacts: undefined };
    const nullSpelling = { ...validFacts, decisionScoreFacts: null };
    const verdicts = [
      validateOptionalDecisionScoreFacts(undefined),
      validateOptionalDecisionScoreFacts(null),
    ];
    expect(new Set(verdicts.map((verdict) => JSON.stringify(verdict))).size).toBe(1);
    expect(JSON.stringify(verdicts[0])).toBe(JSON.stringify({ valid: true }));
    // The spellings are indistinguishable to every consumer of the
    // seam — and the surrounding record shape is irrelevant to it.
    expect(noKey).toBeDefined();
    expect(undefinedSpelling.decisionScoreFacts).toBeUndefined();
    expect(nullSpelling.decisionScoreFacts).toBeNull();
  });

  test("S1b the absence spellings select byte-identical boundary skip verdicts", () => {
    const verdicts = [
      checkDecisionScoreBoundary({ facts: undefined, record }),
      checkDecisionScoreBoundary({ facts: null, record }),
      checkDecisionScoreBoundary({ facts: undefined, record: undefined }),
      checkDecisionScoreBoundary({ facts: null, record: null }),
    ];
    expect(JSON.stringify(verdicts[0])).toBe(JSON.stringify(verdicts[1]));
    expect(JSON.stringify(verdicts[2])).toBe(JSON.stringify(verdicts[3]));
    expect(verdicts[0]).toEqual({ kind: "skipped", reason: "facts-absent" });
    expect(verdicts[2]).toEqual({ kind: "skipped", reason: "both-sides-absent" });
  });

  test("S1c the fixed-corpus replay is deterministic and sha256-pinned (the verdict stream)", () => {
    // The corpus: the valid blocks and every weakening mutation of S2,
    // replayed through the optional seam AND the boundary. The pinned
    // digest captures THIS module's verdict stream (the plane is new —
    // there is no pre-change module to replay; the pre-change behavior
    // preserved is the ABSENCE, pinned by S1a/S1b and the architecture
    // confinement law). Any future drift in any verdict changes the
    // stream and fails this pin.
    const corpus: readonly (DecisionScoreFacts | null | undefined)[] = [
      validFacts,
      { entries: [distributionEntry] },
      undefined,
      null,
      {
        entries: [{ ...successEntry, value: { kind: "task-success", probability: 0.5 } }],
      } as never,
      { entries: [{ ...successEntry, confidence: { kind: "guessed" } }] } as never,
      { entries: [{ ...successEntry, provenance: undefined }] } as never,
      {
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
      } as never,
      {
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.5, "provider-timeout": 0.3 },
              remainder: 0.5,
            },
          },
        ],
      } as never,
      {
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.2 },
              remainder: 0.5,
            },
          },
        ],
      } as never,
      {
        entries: [{ ...successEntry, confidence: { kind: "unbounded-unknown", lowerBound: 0 } }],
      } as never,
      { entries: [] },
      { entries: [successEntry, { ...successEntry }] },
    ];
    const lines = corpus.map(
      (facts, index) =>
        `${index}\t${JSON.stringify(validateOptionalDecisionScoreFacts(facts))}\t${JSON.stringify(
          checkDecisionScoreBoundary({ facts, record }),
        )}`,
    );
    expect(lines).toHaveLength(13);
    const replay = () => sha256(`${lines.join("\n")}\n`);
    // Byte-identical across re-computations (pure and total).
    expect(replay()).toBe(replay());
    expect(sha256(`${lines.join("\n")}\n`)).toBe(
      "a1921c8ecb7bd14e12a9ea2a7ceddc0a25827c80ee956c0f3352b365b775d223",
    );
  });

  // -------------------------------------------------------------------------
  // S2 — the mutation record (every weakening is rejected, load-bearing)
  // -------------------------------------------------------------------------

  test("S2a the mutation record: each single-field weakening flips the verdict, naming the field", () => {
    // [name, mutated facts, reason-substring] — the unmutated fixture
    // passes (load-bearing), each mutation is rejected by the pure
    // validator AND the optional seam AND the boundary (invalid side
    // facts).
    const mutations: readonly [string, DecisionScoreFacts, string][] = [
      [
        "unknown score kind",
        {
          entries: [{ ...successEntry, value: { kind: "task-success", probability: 0.5 } }],
        } as never,
        "value.kind must be one of",
      ],
      [
        "unknown scorer kind",
        {
          entries: [
            {
              ...successEntry,
              provenance: {
                ...successEntry.provenance,
                scorer: { ...successEntry.provenance.scorer, kind: "human" },
              },
            },
          ],
        } as never,
        "provenance.scorer.kind must be one of",
      ],
      [
        "unknown confidence kind",
        { entries: [{ ...successEntry, confidence: { kind: "guessed" } }] } as never,
        "confidence.kind must be one of",
      ],
      [
        "unknown failure class key",
        {
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
        } as never,
        "masses key must be one of",
      ],
      [
        "out-of-bound probability",
        {
          entries: [{ ...successEntry, value: { kind: "candidate-success", probability: 1.5 } }],
        } as never,
        "probability must be a finite number in [0, 1]",
      ],
      [
        "the non-reconciled distribution (over-attribution)",
        {
          entries: [
            {
              ...distributionEntry,
              value: {
                kind: "failure-class-distribution",
                masses: { "provider-5xx": 0.5, "provider-timeout": 0.3 },
                remainder: 0.5,
              },
            },
          ],
        } as never,
        "must reconcile the unit mass",
      ],
      [
        "the unattributed gap",
        {
          entries: [
            {
              ...distributionEntry,
              value: {
                kind: "failure-class-distribution",
                masses: { "provider-5xx": 0.2 },
                remainder: 0.5,
              },
            },
          ],
        } as never,
        "must reconcile the unit mass",
      ],
      [
        "the inverted interval",
        {
          entries: [
            { ...successEntry, confidence: { kind: "bounded", lowerBound: 0.8, upperBound: 0.6 } },
          ],
        } as never,
        "bounded requires lowerBound <= upperBound",
      ],
      [
        "the interval excluding its estimate",
        {
          entries: [
            { ...successEntry, confidence: { kind: "bounded", lowerBound: 0.1, upperBound: 0.2 } },
          ],
        } as never,
        "bounded must contain the estimate",
      ],
      [
        "the fabricated precision (unbounded-unknown carrying bounds)",
        {
          entries: [{ ...successEntry, confidence: { kind: "unbounded-unknown", lowerBound: 0 } }],
        } as never,
        "unbounded-unknown cannot carry bounds",
      ],
      [
        "the unattributed prediction",
        { entries: [{ ...successEntry, provenance: undefined }] } as never,
        "provenance is required on every score entry",
      ],
      ["the zombie empty block", { entries: [] }, "must declare at least one score entry"],
      [
        "the duplicate score identity",
        { entries: [successEntry, { ...successEntry }] },
        "duplicate score identity",
      ],
      [
        "the non-hex digest",
        {
          entries: [
            {
              ...successEntry,
              provenance: {
                ...successEntry.provenance,
                calibrationBasisDigest: "NOT-HEX",
              },
            },
          ],
        } as never,
        "must be a lowercase hex digest",
      ],
      [
        "the non-neutral scorer slug",
        {
          entries: [
            {
              ...successEntry,
              provenance: {
                ...successEntry.provenance,
                scorer: { ...successEntry.provenance.scorer, identity: "Jev" },
              },
            },
          ],
        } as never,
        "must be a neutral scorer slug",
      ],
    ];
    // The unmutated fixture passes — every rejection below is load-bearing.
    expect(validateDecisionScoreFacts(validFacts)).toEqual({ valid: true });
    for (const [name, mutated, reasonSubstring] of mutations) {
      const verdict = validateDecisionScoreFacts(mutated);
      expect(verdict.valid, `${name}: pure validation rejects`).toBe(false);
      expect(
        verdict.valid === false && verdict.reason,
        `${name}: reason names the field`,
      ).toContain(reasonSubstring);
      const seamVerdict = validateOptionalDecisionScoreFacts(mutated);
      expect(seamVerdict.valid, `${name}: the optional seam rejects`).toBe(false);
      expect(JSON.stringify(seamVerdict)).toBe(JSON.stringify(verdict));
      const boundaryVerdict = checkDecisionScoreBoundary({ facts: mutated, record });
      expect(boundaryVerdict.kind, `${name}: the boundary fails closed`).toBe("invalid");
      expect(boundaryVerdict.kind === "invalid" && boundaryVerdict.side).toBe("facts");
    }
  });

  test("S2b a mutated field is the CAUSE (the mutation flips the verdict, the unmutated passes)", () => {
    const overAttribution = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.5, "provider-timeout": 0.3 },
            remainder: 0.5,
          },
        },
      ],
    } as never;
    expect(validateDecisionScoreFacts(overAttribution).valid).toBe(false);
    // Fixing ONLY the remainder (the honest 0.2) flips the verdict.
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
    // The unattributed-gap mutation is exactly the silent-gap shape:
    // 30% of the unit mass vanishes from the attribution.
    const gap = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.2 },
            remainder: 0.5,
          },
        },
      ],
    } as never;
    expect(validateDecisionScoreFacts(gap).valid).toBe(false);
    expect(
      validateDecisionScoreFacts({
        entries: [
          {
            ...distributionEntry,
            value: {
              kind: "failure-class-distribution",
              masses: { "provider-5xx": 0.2 },
              remainder: 0.8,
            },
            confidence: { kind: "bounded", lowerBound: 0.15, upperBound: 0.25 },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // S3 — the boundary discrimination
  // -------------------------------------------------------------------------

  test("S3a a malformed side is never compared — invalid beats mismatched (a weak check misleads)", () => {
    const malformed = {
      entries: [{ ...successEntry, confidence: { kind: "guessed" } }],
    } as never;
    // The real check fails closed on the facts side BEFORE comparing
    // candidates (the record deliberately carries none of them).
    expect(
      checkDecisionScoreBoundary({
        facts: malformed,
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
    // A hand-rolled WEAK check that skips pre-validation compares the
    // malformed block's candidates and ADMITS it when the ids match —
    // exactly the weakened protection this plane must never exhibit.
    const weakCheck = (
      facts: { entries?: readonly { provenance?: { candidateId?: string } }[] },
      rec: { candidates: readonly { candidateId: string }[] },
    ) =>
      (facts?.entries ?? []).every((entry) =>
        rec.candidates.some((candidate) => candidate.candidateId === entry.provenance?.candidateId),
      )
        ? "compatible"
        : "incompatible";
    expect(weakCheck(malformed as never, { candidates: record.candidates })).toBe("compatible");
    expect(
      weakCheck(malformed as never, {
        candidates: [{ candidateId: "strategy-z" }],
      }),
    ).toBe("incompatible");
  });

  test("S3b a malformed record side fails closed, never compared", () => {
    expect(
      checkDecisionScoreBoundary({
        facts: validFacts,
        record: { decisionId: "", candidates: record.candidates },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "decisionRecord.decisionId must be a bounded non-empty identity (<=128): ",
    });
    expect(checkDecisionScoreBoundary({ facts: validFacts, record: 7 as never })).toEqual({
      kind: "invalid",
      side: "record",
      reason: "decisionRecord must be the record identity {decisionId, candidates}: 7",
    });
  });

  test("S3c identity mismatches name BOTH sides in the canonical entry order, byte-identically", () => {
    const first = checkDecisionScoreBoundary({
      facts: validFacts,
      record: {
        decisionId: "decision-0001",
        candidates: [{ candidateId: "strategy-b", admissible: true }],
      },
    });
    expect(first).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          kind: "candidate-not-in-set",
          factsProvenance: successEntry.provenance,
          claimedCandidateId: "strategy-a",
          recordCandidateIds: ["strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-b"],
        },
        {
          kind: "candidate-not-in-set",
          factsProvenance: distributionEntry.provenance,
          claimedCandidateId: "strategy-a",
          recordCandidateIds: ["strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-b"],
        },
      ],
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(
          checkDecisionScoreBoundary({
            facts: validFacts,
            record: {
              decisionId: "decision-0001",
              candidates: [{ candidateId: "strategy-b", admissible: true }],
            },
          }),
        ),
      ).toBe(JSON.stringify(first));
    }
  });

  test("S3d the ordering-only law is load-bearing: an entry scoring an INADMISSIBLE candidate is the typed mismatch, never a silent ride", () => {
    // The record itself marks strategy-a inadmissible (the policy's own
    // verdict — never revisited by a score). A block scoring it is the
    // authority-encroachment shape: typed, named, both sides rendered.
    const verdict = checkDecisionScoreBoundary({
      facts: validFacts,
      record: {
        decisionId: "decision-0001",
        candidates: [
          { candidateId: "strategy-a", admissible: false },
          { candidateId: "strategy-b", admissible: true },
        ],
      },
    });
    expect(verdict).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          kind: "candidate-not-admissible",
          factsProvenance: successEntry.provenance,
          claimedCandidateId: "strategy-a",
          recordCandidateIds: ["strategy-a", "strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-b"],
        },
        {
          kind: "candidate-not-admissible",
          factsProvenance: distributionEntry.provenance,
          claimedCandidateId: "strategy-a",
          recordCandidateIds: ["strategy-a", "strategy-b"],
          recordAdmissibleCandidateIds: ["strategy-b"],
        },
      ],
    });
    // The same block over a record where strategy-a IS admissible is
    // compatible — the admissibility verdict is the CAUSE, exactly the
    // ordering-only law's mechanical spelling.
    expect(checkDecisionScoreBoundary({ facts: validFacts, record })).toEqual({
      kind: "compatible",
    });
  });

  // -------------------------------------------------------------------------
  // S4 — no silent defaulting
  // -------------------------------------------------------------------------

  test("S4a unknown enum members are rejected, never coerced to a member", () => {
    for (const [name, mutated, expected] of [
      ["score kind", { kind: "task-success", probability: 0.5 }, "candidate-success"],
      ["scorer kind", { kind: "human" }, "external-scorer"],
      ["confidence kind", { kind: "guessed" }, "bounded"],
      ["failure class", { "provider-503": 0.2 }, "provider-5xx"],
    ] as const) {
      let facts: unknown;
      if (name === "score kind") {
        facts = { entries: [{ ...successEntry, value: mutated }] };
      } else if (name === "scorer kind") {
        facts = {
          entries: [
            {
              ...successEntry,
              provenance: {
                ...successEntry.provenance,
                scorer: {
                  ...successEntry.provenance.scorer,
                  kind: (mutated as { kind: string }).kind,
                },
              },
            },
          ],
        };
      } else if (name === "confidence kind") {
        facts = { entries: [{ ...successEntry, confidence: mutated }] };
      } else {
        facts = {
          entries: [
            {
              ...distributionEntry,
              value: {
                kind: "failure-class-distribution",
                masses: mutated as Record<string, number>,
                remainder: 0.8,
              },
            },
          ],
        };
      }
      const verdict = validateDecisionScoreFacts(facts);
      expect(verdict.valid, `${name}: rejected, never defaulted`).toBe(false);
      // The offending value is named — the nearest tempting member
      // never silently substitutes.
      if (name === "failure class") {
        expect(verdict.valid === false && verdict.reason).toContain("provider-503");
      } else if (name === "scorer kind") {
        expect(verdict.valid === false && verdict.reason).toContain("human");
      } else {
        expect(verdict.valid === false && verdict.reason).toContain(
          name === "score kind" ? "task-success" : "guessed",
        );
      }
      expect(expected).toBeTruthy();
    }
  });

  test("S4b the honest unbounded-unknown never collapses into a fabricated bounded interval", () => {
    const honestUnknown: DecisionScoreFacts = {
      entries: [
        {
          ...successEntry,
          confidence: { kind: "unbounded-unknown" },
        },
      ],
    };
    const fabricatedBounds: DecisionScoreFacts = {
      entries: [
        {
          ...successEntry,
          confidence: { kind: "bounded", lowerBound: 0.71, upperBound: 0.73 },
        },
      ],
    };
    expect(validateDecisionScoreFacts(honestUnknown)).toEqual({ valid: true });
    expect(validateDecisionScoreFacts(fabricatedBounds)).toEqual({ valid: true });
    expect(canonicalDecisionScoreJson(honestUnknown)).not.toBe(
      canonicalDecisionScoreJson(fabricatedBounds),
    );
    expect(decisionScoreFactsIdentity(honestUnknown, sha256)).not.toBe(
      decisionScoreFactsIdentity(fabricatedBounds, sha256),
    );
  });

  test("S4c a declared zero mass never collapses into an absent class (the placeholder trap)", () => {
    const declaredZero: DecisionScoreFacts = {
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
    const absentClass: DecisionScoreFacts = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.2, "provider-timeout": 0.1 },
            remainder: 0.7,
          },
        },
      ],
    };
    expect(validateDecisionScoreFacts(declaredZero)).toEqual({ valid: true });
    expect(validateDecisionScoreFacts(absentClass)).toEqual({ valid: true });
    expect(canonicalDecisionScoreJson(declaredZero)).not.toBe(
      canonicalDecisionScoreJson(absentClass),
    );
    expect(decisionScoreFactsIdentity(declaredZero, sha256)).not.toBe(
      decisionScoreFactsIdentity(absentClass, sha256),
    );
  });

  test("S4d an over-attributed distribution is rejected, never silently truncated to the unit mass", () => {
    const overAttributed = {
      entries: [
        {
          ...distributionEntry,
          value: {
            kind: "failure-class-distribution",
            masses: { "provider-5xx": 0.6, "provider-timeout": 0.6 },
            remainder: 0,
          },
        },
      ],
    } as never;
    expect(validateDecisionScoreFacts(overAttributed).valid).toBe(false);
    // The silent truncation a weak implementation would perform —
    // dropping 20% of the predicted mass to force the unit total — is
    // exactly the fact-hiding shape this plane rejects: the canonical
    // form of the honest distribution keeps every declared mass.
    expect(canonicalDecisionScoreJson(validFacts)).toContain('"provider-5xx"');
    expect(canonicalDecisionScoreJson(validFacts)).toContain('["remainder",0.7]');
  });
});
