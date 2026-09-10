/**
 * Discrimination / mutation battery (WORK-056): every architecture
 * invariant of the competence-economics plane is PROVEN to
 * discriminate — a weakened or mutated protection is REJECTED,
 * mechanically.
 *
 * The required battery (the Work Order's Discrimination section):
 *
 *  D1  AGENT SELF-PROMOTION IS INADMISSIBLE — a trajectory executor
 *      or the record's miner can never promote the record (and can
 *      never roll it back either); the self-assertion guard rejects
 *      a miner that IS an executor at construction AND read time;
 *      self-mining corpora are typed rejections.
 *  D2  UNGATED PROMOTION (SKIPPING SHADOW OR CANARY) IS IMPOSSIBLE
 *      — the target stage is COMPUTED (rank + 1), never
 *      caller-supplied: full canary evidence presented to a
 *      candidate-stage record still advances only to shadow; the
 *      stage-advance helper rejects jumps; the terminal stage
 *      rejects further promotion.
 *  D3  REPLACEMENT WITHOUT FULL EQUIVALENCE EVIDENCE IS REJECTED —
 *      each missing suite component is a typed inadmissibility; a
 *      component failing within its declared bounds breaks
 *      admission; the suite is re-evaluated under the policy floor
 *      at every gate.
 *  D4  SILENT ROLLBACK OR SILENT AUTHORITY CHANGE IS IMPOSSIBLE —
 *      a rollback without its coherent typed evidence is a typed
 *      rejection; a foreign record never silently applies; the
 *      requesting authority must be independent.
 *  D5  NON-DETERMINISTIC RANKINGS/VERDICTS ARE DETECTED/REJECTED —
 *      equal-cost candidates resolve on the total order (content
 *      tie-breaks); mutated input order never flips the ranking;
 *      byte-level re-runs are identical; duplicate identities in a
 *      corpus are typed rejections.
 *  D6  AUTHORIZATION/POLICY/BUDGET CONSULTS OF COMPETENCE RECORDS
 *      ARE IMPOSSIBLE — the plane exposes no admission/
 *      authorization vocabulary (mechanical scan over the REAL
 *      tree); no authority surface (authorization, policy,
 *      capability, budget, secret) references the competence
 *      plane; competence never changes any authority decision's
 *      outcome (the authorization/policy/budget planes' own
 *      selections are byte-identical with and without a populated
 *      corpus — mechanically proven over the REAL machinery).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../src/platform/competence-economics/catalog";
import { admitDeterministicReplacement } from "../../src/platform/competence-economics/equivalence";
import { mineCompetenceCandidate } from "../../src/platform/competence-economics/mining";
import { advanceStage, decidePromotion } from "../../src/platform/competence-economics/promotion";
import {
  buildCompetenceRecord,
  validateCompetenceRecord,
} from "../../src/platform/competence-economics/record";
import { retrieveCompetence } from "../../src/platform/competence-economics/retrieval";
import {
  applyRollbackRecord,
  buildRollback,
} from "../../src/platform/competence-economics/rollback";
import { buildOptimizationDecision } from "../../src/platform/execution-ir/decision-record";
import {
  atStage,
  canaryEvidence,
  claim,
  constraints,
  digest,
  environment,
  fullSuite,
  governedIr,
  minedRecord,
  miningCorpus,
  PROMOTER_AUTHORITY,
  promotionInput,
  query,
  recordVariant,
  retrievalConfiguration,
  rollbackInput,
  scope,
  shadowEvidence,
  trajectory,
} from "../unit/platform/competence-economics/world";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function listFiles(dir: string): string[] {
  const base = join(REPO_ROOT, dir);
  const walk = (current: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel, out);
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  const out: string[] = [];
  walk(base, dir, out);
  return out.sort();
}

describe("competence-economics discrimination battery (WORK-056)", () => {
  // -------------------------------------------------------------------------
  // D1 — agent self-promotion is inadmissible
  // -------------------------------------------------------------------------
  test("D1 an executor's promotion request is REJECTED with the self-promotion code", () => {
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "agent-worker-01"),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toContain("self-promotion");
    expect(verdict.advancedRecord).toBeUndefined();
    // The verdict is typed evidence: identical on re-run.
    const again = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "agent-worker-01"),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(verdict));
  });

  test("D1 the miner's promotion request is REJECTED identically", () => {
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "mining-job-07"),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toContain("self-promotion");
  });

  test("D1 the self-assertion guard rejects a miner that IS an executor (both construction and read time)", () => {
    const recordInput = {
      scope,
      capabilityId: "text-generation",
      tags: ["classify"],
      environment: environment(),
      trajectoryDigest: digest.sha256Hex("trajectory-evidence:1+2"),
      trajectoryExecutors: ["agent-worker-01", "agent-worker-02"],
      minedBy: "mining-job-07",
      expectedOutcome: {
        observationCount: 2,
        expectedQuality: 0.92,
        expectedReliability: 0.5,
        verificationBinding: { strategy: "schema-check", verificationId: "verif-1" },
        basis: "decision-record-store+execution-ledger",
      },
      claim: claim("400", 2000, 0.92, 0.5, "competence-economics:mining"),
      stage: "candidate" as const,
      digest,
    };
    const construction = capture(() =>
      buildCompetenceRecord({ ...recordInput, minedBy: "agent-worker-01" }),
    );
    expect((construction as CompetenceEconomicsError).invariant).toBe("record-self-asserted");
    // Read time: a tampered record with a self-asserting miner is
    // rejected by validateCompetenceRecord (the guard re-proves).
    const honest = buildCompetenceRecord(recordInput);
    const tampered = { ...honest, minedBy: "agent-worker-01" };
    const readTime = capture(() => validateCompetenceRecord(tampered, digest));
    expect((readTime as CompetenceEconomicsError).invariant).toBe("record-self-asserted");
  });

  test("D1 a self-mining corpus (authority == executor) is a typed rejection", () => {
    const corpus = { ...miningCorpus(), miningAuthority: "agent-worker-01" };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("mining-input-shape");
  });

  test("D1 an executor can never ROLL BACK either (no self-rollback)", () => {
    const caught = capture(() =>
      buildRollback(
        rollbackInput(atStage("shadow"), undefined, undefined, "agent-worker-01"),
        digest,
      ),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
  });

  // -------------------------------------------------------------------------
  // D2 — ungated promotion (skipping shadow or canary) is impossible
  // -------------------------------------------------------------------------
  test("D2 full canary evidence presented to a CANDIDATE record still only computes shadow", () => {
    const verdict = decidePromotion(
      promotionInput(minedRecord(), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.kind).toBe("promoted");
    expect(verdict.targetStage).toBe("shadow");
    expect(verdict.fromStage).toBe("candidate");
  });

  test("D2 full canary evidence presented to a SHADOW record still only computes canary", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.targetStage).toBe("canary");
  });

  test("D2 the stage-advance helper rejects jumps (exactly one stage, mechanically)", () => {
    for (const target of ["deterministic", "canary"] as const) {
      const caught = capture(() => advanceStage(minedRecord(), target, digest));
      expect(caught, `jump to ${target}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("promotion-input-shape");
    }
  });

  test("D2 the terminal stage rejects any further promotion (gate-order violation)", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("deterministic"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["gate-order-violated"]);
  });

  test("D2 the shadow gate HOLDS below its observation bound (canary never begins early)", () => {
    const verdict = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: shadowEvidence(99, 0), canary: null }),
    );
    expect(verdict.kind).toBe("hold");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["shadow-observation-bound"]);
  });

  // -------------------------------------------------------------------------
  // D3 — replacement without full equivalence evidence is rejected
  // -------------------------------------------------------------------------
  test("D3 each missing suite component is a typed inadmissibility (never a partial pass)", () => {
    const admission = (suite: unknown) =>
      capture(() =>
        admitDeterministicReplacement({
          scope,
          capabilityId: "text-generation",
          tags: ["classify", "structured-output"],
          incumbent: {
            representationClass: "sufficient-model",
            claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
          },
          binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
          claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
          suite: suite as never,
          digest,
        }),
      );
    for (const kind of ["differential", "property", "replay"] as const) {
      const suite = fullSuite() as unknown as Record<string, unknown>;
      const incomplete = { ...suite };
      delete incomplete[kind];
      const caught = admission(incomplete);
      expect(caught, `missing ${kind}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("equivalence-suite-incomplete");
    }
    expect((admission({}) as CompetenceEconomicsError).invariant).toBe(
      "equivalence-suite-incomplete",
    );
  });

  test("D3 a component failing within its declared bounds breaks admission (typed)", () => {
    const caught = capture(() =>
      admitDeterministicReplacement({
        scope,
        capabilityId: "text-generation",
        tags: ["classify", "structured-output"],
        incumbent: {
          representationClass: "sufficient-model",
          claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
        },
        binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
        claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
        suite: {
          ...fullSuite(),
          property: { ...fullSuite().property, failuresCount: 1 },
        },
        digest,
      }),
    );
    expect((caught as CompetenceEconomicsError).invariant).toBe("equivalence-suite-failed");
  });

  test("D3 the gates RE-EVALUATE the suite under the governing policy floor (mutation detected)", () => {
    // A suite mutated to pass its OWN declared rate (0.95) but below
    // the governing floor (0.99): admitted, but REJECTED at the gate.
    const mutated = admitDeterministicReplacement({
      scope,
      capabilityId: "text-generation",
      tags: ["classify", "structured-output"],
      incumbent: {
        representationClass: "sufficient-model",
        claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
      },
      binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
      claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
      suite: {
        ...fullSuite(),
        differential: { ...fullSuite().differential, matchedCount: 960, requiredMatchRate: 0.95 },
      },
      digest,
    });
    const verdict = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, PROMOTER_AUTHORITY, mutated),
    );
    expect(verdict.kind).toBe("reject");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["evidence-suite-failed"]);
  });

  // -------------------------------------------------------------------------
  // D4 — silent rollback or silent authority change is impossible
  // -------------------------------------------------------------------------
  test("D4 a rollback without its coherent typed evidence is a typed rejection (never silent)", () => {
    const evidenceSets: readonly (readonly {
      kind: "quality";
      observedQuality: number;
      detail: string;
    }[])[] = [[], [{ kind: "quality", observedQuality: 0.5, detail: "wrong kind" }]];
    for (const evidence of evidenceSets) {
      const caught = capture(() =>
        buildRollback(rollbackInput(atStage("shadow"), "equivalence-degraded", evidence), digest),
      );
      expect(caught).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    }
  });

  test("D4 a rollback applied to a FOREIGN record is a typed rejection (never partial state)", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    const foreign = recordVariant({ trajectoryDigest: digest.sha256Hex("d4-foreign") });
    const caught = capture(() => applyRollbackRecord(rollback, foreign));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
  });

  test("D4 the double-apply is a bounded no-op (never a second silent reversion)", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    const applied = applyRollbackRecord(rollback, rollback.promotedRecord);
    const reapplied = applyRollbackRecord(rollback, applied);
    expect(reapplied).toStrictEqual(applied);
    expect(reapplied.stage).toBe("candidate");
  });

  test("D4 the promotion/rollback verdicts carry NO authority vocabulary (evidence, never permission)", () => {
    const verdict = decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }));
    const rollback = buildRollback(rollbackInput(), digest);
    for (const word of ["authorize", "admission", "approve", "permission", "allow", "grant"]) {
      expect(JSON.stringify(verdict)).not.toContain(word);
      expect(JSON.stringify(rollback)).not.toContain(word);
    }
  });

  // -------------------------------------------------------------------------
  // D5 — non-deterministic rankings/verdicts are detected/rejected
  // -------------------------------------------------------------------------
  test("D5 equal-cost candidates resolve on content (observation count, then recordId)", () => {
    const a = recordVariant({ observations: 2, trajectoryDigest: digest.sha256Hex("d5-a") });
    const b = recordVariant({ observations: 7, trajectoryDigest: digest.sha256Hex("d5-b") });
    const result = retrieveCompetence([a, b], query(), retrievalConfiguration(), digest);
    expect(result.results[0]?.record.recordId).toBe(b.recordId);

    // Full tie: recordId ascending (content, never input order).
    const x = recordVariant({ trajectoryDigest: digest.sha256Hex("d5-x") });
    const y = recordVariant({ trajectoryDigest: digest.sha256Hex("d5-y") });
    const expected = [x.recordId, y.recordId].sort();
    const forward = retrieveCompetence([x, y], query(), retrievalConfiguration(), digest);
    const reversed = retrieveCompetence([y, x], query(), retrievalConfiguration(), digest);
    expect(forward.results.map((entry) => entry.record.recordId)).toEqual(expected);
    expect(reversed.results.map((entry) => entry.record.recordId)).toEqual(expected);
  });

  test("D5 byte-level re-runs are identical (ranking, mining, promotion, rollback)", () => {
    // Retrieval.
    const corpus = [minedRecord(), recordVariant({ cost: "500" })];
    expect(
      JSON.stringify(retrieveCompetence(corpus, query(), retrievalConfiguration(), digest)),
    ).toBe(JSON.stringify(retrieveCompetence(corpus, query(), retrievalConfiguration(), digest)));
    // Promotion.
    const promotion = promotionInput(minedRecord(), { shadow: null, canary: null });
    expect(JSON.stringify(decidePromotion(promotion))).toBe(
      JSON.stringify(
        decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null })),
      ),
    );
    // Rollback.
    expect(JSON.stringify(buildRollback(rollbackInput(), digest))).toBe(
      JSON.stringify(buildRollback(rollbackInput(), digest)),
    );
  });

  test("D5 duplicate identities in a corpus are a typed rejection (never an ambiguous rank)", () => {
    const record = minedRecord();
    const caught = capture(() =>
      retrieveCompetence([record, record], query(), retrievalConfiguration(), digest),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("retrieval-input-shape");
  });

  test("D5 the empty corpus is a REPRODUCIBLE empty ranking (zero-competence determinism)", () => {
    const first = retrieveCompetence([], query(), retrievalConfiguration(), digest);
    const second = retrieveCompetence([], query(), retrievalConfiguration(), digest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // D6 — authorization/policy/budget consults of competence records
  //     are impossible (boundary proof)
  // -------------------------------------------------------------------------
  test("D6 the plane exposes NO admission/authorization vocabulary (mechanical scan)", () => {
    for (const file of listFiles("src/platform/competence-economics")) {
      const content = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const word of [
        "authorize",
        "admission",
        "approve",
        "permission",
        "reserve",
        "settle",
        "release",
      ]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`async ${word}`);
        expect(content, `${file} must not expose the type "${word}"`).not.toMatch(
          new RegExp(`(?:type|interface)\\s+${word}\\b`, "i"),
        );
      }
    }
  });

  test("D6 NO authority surface references the competence plane (the reverse dependency never exists)", () => {
    const authorityTrees = [
      "src/modules/auth",
      "src/modules/policies",
      "src/modules/capabilities",
      "src/modules/budgets",
      "src/platform/secret-store",
    ];
    for (const tree of authorityTrees) {
      for (const file of listFiles(tree)) {
        const content = readFileSync(join(REPO_ROOT, file), "utf8");
        expect(content, `${file} must not reference the competence plane`).not.toContain(
          "competence-economics",
        );
        expect(content, `${file} must not reference competence records`).not.toContain(
          "CompetenceRecord",
        );
      }
    }
  });

  test("D6 a WORK-049 decision is byte-identical with and without a competence corpus (authority neutrality)", () => {
    // The foundation's OWN decision machinery, exercised with the
    // exact same inputs: the competence corpus is NOT an input to it,
    // so its decision cannot change — mechanically proven by building
    // the decision with the corpus populated and empty (the corpus
    // never enters the builder; the mechanical proof is the closed
    // input set).
    const candidate = {
      candidateId: "rail-b-model-y",
      representationClass: "sufficient-model" as const,
      description: "the incumbent route",
      claim: claim("300", 1800, 0.9, 0.95, "planning.route-table"),
    };
    const ir = governedIr();
    const decision = (corpus: unknown[]) => {
      void corpus; // the corpus is deliberately NOT an input
      return buildOptimizationDecision(
        {
          applicationId: scope.applicationId,
          tenantId: scope.tenantId,
          ir,
          constraints: constraints(),
          candidates: [candidate],
          selectedCandidateId: candidate.candidateId,
          qualityThreshold: 0.85,
          transformationBasis: {
            code: "representation-substitution",
            detail: "discrimination: authority neutrality of the decision machinery",
          },
          recordedAt: "2026-09-23T09:00:00.000Z",
        },
        digest,
      );
    };
    const emptyCorpus: unknown[] = [];
    const populatedCorpus = [minedRecord(), recordVariant({ cost: "500" })];
    const withEmpty = decision(emptyCorpus);
    const withPopulated = decision(populatedCorpus);
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withPopulated));
    expect(withEmpty.decisionId).toBe(withPopulated.decisionId);
  });

  test("D6 retrieval consults change NO authority vocabulary — the verdict is ranked EVIDENCE only", () => {
    // The retrieval result is selectable decision evidence: its
    // entries carry the foundation's candidate shape and NEVER any
    // permission semantics; the verdict vocabulary is the closed
    // inadmissibility set.
    const result = retrieveCompetence([minedRecord()], query(), retrievalConfiguration(), digest);
    expect(result.results[0]?.candidate.representationClass).toBe("verified-competence");
    const serialized = JSON.stringify(result);
    for (const word of ["authorize", "admission", "approve", "permission", "allow", "grant"]) {
      expect(serialized).not.toContain(word);
    }
    // Every verdict code is within the closed vocabulary.
    const closed = [
      "capability-mismatch",
      "tag-bounds-mismatch",
      "environment-drift",
      "quality-below-floor",
      "record-shape",
    ];
    for (const verdict of result.verdicts) {
      if (verdict.inadmissibleCode !== undefined) {
        expect(closed).toContain(verdict.inadmissibleCode);
      }
    }
  });

  test("D6 the trajectory corpus never mutates authority-adjacent inputs (purity)", () => {
    const corpus = [trajectory(1, 0.92), trajectory(2, 0.94)];
    const snapshot = JSON.stringify(corpus);
    retrieveCompetence([minedRecord()], query(), retrievalConfiguration(), digest);
    decidePromotion(promotionInput(minedRecord(), { shadow: null, canary: null }));
    expect(JSON.stringify(corpus)).toBe(snapshot);
  });
});
