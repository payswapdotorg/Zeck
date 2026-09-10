/**
 * Unit battery: progressive competence retrieval (WORK-056 AC 2 + AC 8).
 *
 * Proves: the pure deterministic ranked retrieval — the total order
 * (cost ascending, ties by observation count descending, ties by
 * recordId ascending); applicability verdicts as RECORDED evidence
 * (scope, capability, tag bounds, environment drift, quality floor,
 * tampered records); the bounded result set; the ZERO-COMPETENCE
 * operation (an empty corpus is representable and yields the empty
 * ranked set — fail-safe, never an error); determinism and
 * idempotence (byte-identical re-runs, corpus input-order
 * independence, no corpus mutation).
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import {
  compareRetrievalEntries,
  retrieveCompetence,
} from "../../../../src/platform/competence-economics/retrieval";
import { RETRIEVAL_BASIS } from "../../../../src/platform/competence-economics/retrieval";
import {
  digest,
  driftedEnvironment,
  environment,
  minedRecord,
  query,
  recordVariant,
  retrievalConfiguration,
  scope,
} from "./world";

describe("competence retrieval (WORK-056)", () => {
  test("an applicable record surfaces as the rank-1 candidate in the foundation's own shape", () => {
    const record = minedRecord();
    const result = retrieveCompetence([record], query(), retrievalConfiguration(), digest);
    expect(result.results).toHaveLength(1);
    const first = result.results[0];
    expect(first?.rank).toBe(1);
    expect(first?.record.recordId).toBe(record.recordId);
    // The candidate is the FOUNDATION's own shape: the ladder class
    // `verified-competence`, the record's explicit-basis claim.
    expect(first?.candidate.representationClass).toBe("verified-competence");
    expect(first?.candidate.candidateId).toBe(record.recordId);
    expect(first?.candidate.claim).toStrictEqual(record.claim);
    expect(first?.evaluation.valid).toBe(true);
    // Expected successful-resolution cost: ceil(400 / 0.5) = 800.
    expect(first?.evaluation.expectedSuccessfulResolutionCostMicroUsd).toBe("800");
    expect(result.corpusSize).toBe(1);
    expect(result.retrievalBasis).toBe(RETRIEVAL_BASIS);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]?.applicable).toBe(true);
  });

  test("the same inputs produce the byte-identical result (determinism, idempotence)", () => {
    const corpus = [minedRecord(), recordVariant({ cost: "500" })];
    const first = retrieveCompetence(corpus, query(), retrievalConfiguration(), digest);
    const second = retrieveCompetence(corpus, query(), retrievalConfiguration(), digest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toStrictEqual(second);
  });

  test("corpus input order never changes the ranked output (total order)", () => {
    const a = recordVariant({ cost: "500", trajectoryDigest: digest.sha256Hex("order-a") });
    const b = recordVariant({ cost: "400", trajectoryDigest: digest.sha256Hex("order-b") });
    const forward = retrieveCompetence([a, b], query(), retrievalConfiguration(), digest);
    const reversed = retrieveCompetence([b, a], query(), retrievalConfiguration(), digest);
    expect(forward.results.map((entry) => entry.record.recordId)).toEqual(
      reversed.results.map((entry) => entry.record.recordId),
    );
    // Cheaper first — regardless of corpus order.
    expect(forward.results[0]?.record.recordId).toBe(b.recordId);
  });

  test("the deterministic total order: cost ascending, then observations descending, then recordId", () => {
    const cheap = recordVariant({ cost: "100", trajectoryDigest: digest.sha256Hex("rank-cheap") });
    const expensive = recordVariant({ cost: "900", trajectoryDigest: digest.sha256Hex("rank-exp") });
    const result = retrieveCompetence(
      [expensive, cheap],
      query(),
      retrievalConfiguration(),
      digest,
    );
    expect(result.results.map((entry) => entry.record.recordId)).toEqual([
      cheap.recordId,
      expensive.recordId,
    ]);

    // Ties on cost resolve on repetition evidence (stronger first).
    const weakEvidence = recordVariant({ observations: 2, trajectoryDigest: digest.sha256Hex("tie-weak") });
    const strongEvidence = recordVariant({ observations: 5, trajectoryDigest: digest.sha256Hex("tie-strong") });
    const tie = retrieveCompetence(
      [weakEvidence, strongEvidence],
      query(),
      retrievalConfiguration(),
      digest,
    );
    expect(tie.results.map((entry) => entry.record.recordId)).toEqual([
      strongEvidence.recordId,
      weakEvidence.recordId,
    ]);

    // Full ties resolve on content identity (recordId ascending).
    const tieA = recordVariant({ trajectoryDigest: digest.sha256Hex("tie-a") });
    const tieB = recordVariant({ trajectoryDigest: digest.sha256Hex("tie-b") });
    const ordered = [tieA.recordId, tieB.recordId].sort();
    const identity = retrieveCompetence(
      [tieB, tieA],
      query(),
      retrievalConfiguration(),
      digest,
    );
    expect(identity.results.map((entry) => entry.record.recordId)).toEqual(ordered);

    // The comparator itself is total and antisymmetric.
    const first = { record: tieA, evaluation: { expectedSuccessfulResolutionCostMicroUsd: "800" } };
    const second = { record: tieB, evaluation: { expectedSuccessfulResolutionCostMicroUsd: "800" } };
    expect(compareRetrievalEntries(first, second)).toBe(-compareRetrievalEntries(second, first));
  });

  test("THE ZERO-COMPETENCE OPERATION: an empty corpus is representable and fail-safe", () => {
    const result = retrieveCompetence([], query(), retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts).toEqual([]);
    expect(result.corpusSize).toBe(0);
    // No error, no phantom candidates — the probabilistic path works.
    expect(result.retrievalBasis).toBe(RETRIEVAL_BASIS);
  });

  test("a cross-tenant record is never surfaced (structural tenant safety)", () => {
    const foreign = recordVariant({ tenantId: "00000000-0000-7000-8000-0000000000dd" });
    const result = retrieveCompetence([foreign], query(), retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts[0]?.inadmissibleCode).toBe("capability-mismatch");
    expect(result.verdicts[0]?.inadmissibleDetail).toContain("different tenant/application scope");
  });

  test("a capability mismatch and tag-bounds mismatch are recorded verdicts, never errors", () => {
    const otherCapability = recordVariant({
      capabilityId: "document-retrieval",
      trajectoryDigest: digest.sha256Hex("cap-mismatch"),
    });
    const capability = retrieveCompetence(
      [otherCapability],
      query(),
      retrievalConfiguration(),
      digest,
    );
    expect(capability.results).toEqual([]);
    expect(capability.verdicts[0]?.inadmissibleCode).toBe("capability-mismatch");

    const tags = recordVariant({
      tags: ["classify"],
      trajectoryDigest: digest.sha256Hex("tag-mismatch"),
    });
    const bounds = retrieveCompetence([tags], query(), retrievalConfiguration(), digest);
    expect(bounds.results).toEqual([]);
    expect(bounds.verdicts[0]?.inadmissibleCode).toBe("tag-bounds-mismatch");
    expect(bounds.verdicts[0]?.inadmissibleDetail).toContain("do not cover the query's tags");
  });

  test("environment drift is a recorded verdict (WORK-055's own comparison, consumed)", () => {
    const drifted = recordVariant({
      environment: driftedEnvironment(),
      trajectoryDigest: digest.sha256Hex("drift"),
    });
    const result = retrieveCompetence([drifted], query(), retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts[0]?.inadmissibleCode).toBe("environment-drift");
    expect(result.verdicts[0]?.inadmissibleDetail).toContain("drifted");
  });

  test("a record below the quality floor is ranked out with its typed evaluation", () => {
    const below = recordVariant({ quality: 0.7, trajectoryDigest: digest.sha256Hex("quality") });
    const result = retrieveCompetence([below], query(), retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts[0]?.inadmissibleCode).toBe("quality-below-floor");
    expect(result.verdicts[0]?.evaluation?.valid).toBe(false);
    expect(result.verdicts[0]?.inadmissibleDetail).toContain("below the floor");
  });

  test("a tampered record never surfaces: its read-time failure is a recorded verdict", () => {
    const record = minedRecord();
    const tampered = { ...record, trajectoryDigest: digest.sha256Hex("forged") };
    const result = retrieveCompetence([tampered], query(), retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts[0]?.inadmissibleCode).toBe("record-shape");
    // The tampered record's identity is still named in the verdict.
    expect(result.verdicts[0]?.recordId).toBe(record.recordId);
  });

  test("the result set honors maxResults (bounded)", () => {
    const a = recordVariant({ trajectoryDigest: digest.sha256Hex("bound-a") });
    const b = recordVariant({ trajectoryDigest: digest.sha256Hex("bound-b") });
    const result = retrieveCompetence([a, b], query(), { maxResults: 1, qualityFloor: 0.85 }, digest);
    expect(result.results).toHaveLength(1);
    // Every corpus record still carries its verdict (audit evidence).
    expect(result.verdicts).toHaveLength(2);
  });

  test("the corpus bound is enforced (fail-closed, typed)", () => {
    const corpus = Array.from({ length: 1025 }, (_, index) =>
      recordVariant({ trajectoryDigest: digest.sha256Hex(`corpus-${index}`) }),
    );
    expect(() =>
      retrieveCompetence(corpus, query(), retrievalConfiguration(), digest),
    ).toThrow(CompetenceEconomicsError);
    // 1024 is the bound: the maximum corpus is admitted.
    const maximal = corpus.slice(0, 1024);
    expect(() =>
      retrieveCompetence(maximal, query(), retrievalConfiguration(), digest),
    ).not.toThrow();
  });

  test("duplicate record identities in the corpus are a typed rejection", () => {
    const record = minedRecord();
    expect(() =>
      retrieveCompetence([record, record], query(), retrievalConfiguration(), digest),
    ).toThrow(CompetenceEconomicsError);
  });

  test("the query and configuration are validated fail-closed", () => {
    expect(() =>
      retrieveCompetence(
        [],
        { ...query(), capabilityId: "NOT-A-SLUG" },
        retrievalConfiguration(),
        digest,
      ),
    ).toThrow(CompetenceEconomicsError);
    expect(() =>
      retrieveCompetence([], { ...query(), tags: ["classify", "classify"] }, retrievalConfiguration(), digest),
    ).toThrow(CompetenceEconomicsError);
    expect(() =>
      retrieveCompetence([], query(), { maxResults: 0, qualityFloor: 0.85 }, digest),
    ).toThrow(CompetenceEconomicsError);
    expect(() =>
      retrieveCompetence([], query(), { maxResults: 17, qualityFloor: 0.85 }, digest),
    ).toThrow(CompetenceEconomicsError);
    expect(() =>
      retrieveCompetence([], query(), { maxResults: 16, qualityFloor: 1.5 }, digest),
    ).toThrow(CompetenceEconomicsError);
    // The environment is validated by the failure-recovery plane's OWN
    // validator — its error propagates as its own type (honest consumption).
    let caught: unknown;
    try {
      retrieveCompetence(
        [],
        { ...query(), environment: { fingerprintId: "not-hex", entries: [] } as never },
        retrievalConfiguration(),
        digest,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as Error).name).toBe("FailureRecoveryError");
  });

  test("the retrieval is pure: the corpus is never mutated", () => {
    const record = minedRecord();
    const corpus = [record];
    const snapshot = JSON.stringify(corpus);
    retrieveCompetence(corpus, query(), retrievalConfiguration(), digest);
    expect(JSON.stringify(corpus)).toBe(snapshot);
    // The query scope is validated but the caller's value is not mutated.
    const before = JSON.stringify(scope);
    retrieveCompetence(corpus, query(), retrievalConfiguration(), digest);
    expect(JSON.stringify(scope)).toBe(before);
  });

  test("the drifted environment never matches even under record-side drift (symmetric)", () => {
    const record = recordVariant({
      environment: environment(),
      trajectoryDigest: digest.sha256Hex("symmetric"),
    });
    const driftedQuery = { ...query(), environment: driftedEnvironment() };
    const result = retrieveCompetence([record], driftedQuery, retrievalConfiguration(), digest);
    expect(result.results).toEqual([]);
    expect(result.verdicts[0]?.inadmissibleCode).toBe("environment-drift");
  });
});
