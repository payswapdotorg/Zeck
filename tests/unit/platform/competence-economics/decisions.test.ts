/**
 * Unit battery: competence decision records (WORK-056 AC 5 + AC 6 —
 * the record-construction seam).
 *
 * Proves: every material promotion decision and every bounded
 * rollback is recorded through the WORK-049 evidence contract
 * (`buildOptimizationDecision`) — APPEND-ONLY EVIDENCE built as
 * VALUES for the CALLER to append through the EXISTING store; the
 * corpus is the evidence-honest pair (incumbent + replacement for
 * promotions; promoted + reverted for rollbacks); hold/reject
 * verdicts record NOTHING (the typed outcome IS the evidence); the
 * foundation's total validation applies wholesale (decision-invalid
 * fail-closed); determinism (byte-identical decisionId on re-build);
 * the recorded provenance is replayable by deterministic audit.
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import {
  buildPromotionDecisionRecord,
  buildRollbackDecisionRecord,
} from "../../../../src/platform/competence-economics/decisions";
import { validateOptimizationDecision } from "../../../../src/platform/execution-ir/decision-record";
import {
  atStage,
  constraints,
  decisionScope,
  digest,
  governedIr,
  minedRecord,
  promotedVerdict,
  replacementCandidate,
  rollbackInput,
  ROLLBACK_AUTHORITY,
  PROMOTER_AUTHORITY,
} from "./world";
import { buildRollback } from "../../../../src/platform/competence-economics/rollback";
import { decidePromotion } from "../../../../src/platform/competence-economics/promotion";
import { promotionInput, canaryEvidence, shadowEvidence } from "./world";

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("competence decision records (WORK-056)", () => {
  test("a promoted verdict records through the WORK-049 contract with honest provenance", () => {
    const verdict = promotedVerdict();
    expect(verdict.kind).toBe("promoted");
    const record = buildPromotionDecisionRecord({
      record: minedRecord(),
      verdict,
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    expect(record).not.toBeNull();
    // The WORK-049 shape: content-addressed decisionId, the record
    // digest, the frozen evidence contract.
    expect(record?.decisionId).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateOptimizationDecision(record, digest)).not.toThrow();
    // The corpus is the evidence-honest pair.
    expect(record?.candidates).toHaveLength(2);
    expect(record?.candidates.map((candidate) => candidate.representationClass)).toEqual([
      "sufficient-model",
      "deterministic-computation",
    ]);
    // The SELECTED candidate is the deterministic replacement.
    expect(record?.selectedCandidateId).toBe(record?.candidates[1]?.candidateId);
    expect(record?.selectedExpectation.representationClass).toBe("deterministic-computation");
    // The transformation basis is the substitution with the
    // promotion provenance in the bounded detail.
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain(`record=${minedRecord().recordId}`);
    expect(record?.transformationBasis.detail).toContain("from=candidate");
    expect(record?.transformationBasis.detail).toContain("to=shadow");
    expect(record?.transformationBasis.detail).toContain(
      `replacement=${replacementCandidate().replacementId}`,
    );
    expect(record?.transformationBasis.detail).toContain("equivalence=admissible");
    // The decision rides the real IR identity and the scope.
    expect(record?.irId).toBe(governedIr().irId);
    expect(record?.tenantId).toBe(decisionScope().tenantId);
    expect(record?.applicationId).toBe(decisionScope().applicationId);
  });

  test("the same inputs produce the byte-identical decision record (determinism)", () => {
    const build = () =>
      buildPromotionDecisionRecord({
        record: minedRecord(),
        verdict: promotedVerdict(),
        replacement: replacementCandidate(),
        ir: governedIr(),
        constraints: constraints(),
        scope: decisionScope(),
        digest,
      });
    const first = build();
    const second = build();
    expect(first?.decisionId).toBe(second?.decisionId);
    expect(first?.recordDigest).toBe(second?.recordDigest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("hold and reject verdicts record NOTHING (the typed outcome IS the evidence)", () => {
    // A hold verdict (shadow observations below the bound).
    const hold = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: { observationsCount: 42, deviationCount: 0, basis: "x" }, canary: null }),
    );
    expect(hold.kind).toBe("hold");
    const holdRecord = buildPromotionDecisionRecord({
      record: atStage("shadow"),
      verdict: hold,
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    expect(holdRecord).toBeNull();

    // A reject verdict (self-promotion).
    const reject = decidePromotion(
      promotionInput(minedRecord(), { shadow: null, canary: null }, "agent-worker-01"),
    );
    expect(reject.kind).toBe("reject");
    const rejectRecord = buildPromotionDecisionRecord({
      record: minedRecord(),
      verdict: reject,
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    expect(rejectRecord).toBeNull();
  });

  test("a verdict whose advanced record contradicts the target is decision-invalid (fail closed)", () => {
    const verdict = promotedVerdict();
    const forged = { ...verdict, targetStage: "canary" as const };
    const caught = capture(() =>
      buildPromotionDecisionRecord({
        record: minedRecord(),
        verdict: forged,
        replacement: replacementCandidate(),
        ir: governedIr(),
        constraints: constraints(),
        scope: decisionScope(),
        digest,
      }),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("decision-invalid");
  });

  test("a decision without governing constraints is decision-invalid", () => {
    const caught = capture(() =>
      buildPromotionDecisionRecord({
        record: minedRecord(),
        verdict: promotedVerdict(),
        replacement: replacementCandidate(),
        ir: governedIr(),
        constraints: [],
        scope: decisionScope(),
        digest,
      }),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("decision-invalid");
  });

  test("the later gates record identically (canary and deterministic promotions)", () => {
    // shadow → canary.
    const canary = decidePromotion(
      promotionInput(atStage("shadow"), { shadow: shadowEvidence(100, 0), canary: null }),
    );
    expect(canary.kind).toBe("promoted");
    const canaryRecord = buildPromotionDecisionRecord({
      record: atStage("shadow"),
      verdict: canary,
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    expect(canaryRecord?.transformationBasis.detail).toContain("from=shadow");
    expect(canaryRecord?.transformationBasis.detail).toContain("to=canary");

    // canary → deterministic.
    const deterministic = decidePromotion(
      promotionInput(atStage("canary"), {
        shadow: shadowEvidence(100, 0),
        canary: canaryEvidence(50, 50, 0),
      }),
    );
    expect(deterministic.kind).toBe("promoted");
    const deterministicRecord = buildPromotionDecisionRecord({
      record: atStage("canary"),
      verdict: deterministic,
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    expect(deterministicRecord?.transformationBasis.detail).toContain("to=deterministic");
    expect(() => validateOptimizationDecision(deterministicRecord, digest)).not.toThrow();
  });

  test("a bounded rollback records through the WORK-049 contract", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    const record = buildRollbackDecisionRecord({
      rollback,
      ir: governedIr(),
      constraints: constraints(),
      qualityThreshold: 0.85,
      scope: decisionScope(),
      digest,
    });
    expect(record.decisionId).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateOptimizationDecision(record, digest)).not.toThrow();
    // The corpus is the promoted + reverted pair; the REVERTED one is
    // selected (the prior representation restored).
    expect(record.candidates).toHaveLength(2);
    expect(record.selectedCandidateId).toBe(rollback.revertedRecord.recordId);
    expect(record.selectedExpectation.candidateId).toBe(rollback.revertedRecord.recordId);
    // The rollback provenance rides the bounded detail.
    expect(record.transformationBasis.detail).toContain(`rollback=${rollback.rollbackId}`);
    expect(record.transformationBasis.detail).toContain("from=shadow");
    expect(record.transformationBasis.detail).toContain("to=candidate");
    expect(record.transformationBasis.detail).toContain("reason=equivalence-degraded");
    expect(record.transformationBasis.detail).toContain(`requestedBy=${ROLLBACK_AUTHORITY}`);
  });

  test("the rollback decision is deterministic (byte-identical re-build)", () => {
    const build = () =>
      buildRollbackDecisionRecord({
        rollback: buildRollback(rollbackInput(), digest),
        ir: governedIr(),
        constraints: constraints(),
        qualityThreshold: 0.85,
        scope: decisionScope(),
        digest,
      });
    const first = build();
    const second = build();
    expect(first.decisionId).toBe(second.decisionId);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("the rollback decision validates its inputs fail-closed (decision-invalid)", () => {
    expect(
      capture(() =>
        buildRollbackDecisionRecord({
          rollback: buildRollback(rollbackInput(), digest),
          ir: governedIr(),
          constraints: [],
          qualityThreshold: 0.85,
          scope: decisionScope(),
          digest,
        }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollbackDecisionRecord({
          rollback: buildRollback(rollbackInput(), digest),
          ir: governedIr(),
          constraints: constraints(),
          qualityThreshold: 1.5,
          scope: decisionScope(),
          digest,
        }),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the promotion decision records the governing quality threshold honestly", () => {
    const record = buildPromotionDecisionRecord({
      record: minedRecord(),
      verdict: promotedVerdict(),
      replacement: replacementCandidate(),
      ir: governedIr(),
      constraints: constraints(),
      scope: decisionScope(),
      digest,
    });
    // The governing floor: max(requiredQuality 0.85, hard 0.8) = 0.85.
    expect(record?.qualityThreshold).toBe(0.85);
    // The promotion-executing authority never rides the record (the
    // decision evidence carries the PROVENANCE, not permission).
    expect(record?.transformationBasis.detail).not.toContain(PROMOTER_AUTHORITY);
  });
});
