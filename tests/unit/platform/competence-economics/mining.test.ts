/**
 * Unit battery: successful-trajectory mining (WORK-056 AC 3).
 *
 * Proves: MINING OBSERVES, NEVER DECIDES — the mined record is a
 * CANDIDATE-stage value with CONSERVATIVE evidence (minimum quality,
 * maximum cost/latency, observed reliability); the repetition
 * minimum; the success-only discipline (non-successful trajectories
 * are typed rejections); the self-mining guard; environment
 * coherence; determinism/idempotence; trajectory identity
 * re-derivation (tamper rejection); honest consumption of the
 * failure-recovery plane's OWN validators (foreign errors propagate
 * as their own types, never re-branded).
 */

import { describe, expect, test } from "vitest";
import {
  CompetenceEconomicsError,
  MIN_SUCCESSFUL_TRAJECTORIES,
} from "../../../../src/platform/competence-economics/catalog";
import {
  mineCompetenceCandidate,
  validateSuccessfulTrajectory,
} from "../../../../src/platform/competence-economics/mining";
import { validateCompetenceRecord } from "../../../../src/platform/competence-economics/record";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  digest,
  driftedTrajectory,
  environment,
  minedRecord,
  miningCorpus,
  scope,
  secondExecutorTrajectory,
  trajectory,
} from "./world";

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("trajectory mining (WORK-056)", () => {
  test("the mined record is a CANDIDATE with conservative evidence (min quality, max cost)", () => {
    const record = minedRecord();
    expect(record.stage).toBe("candidate");
    // The world's corpus: quality 0.92/0.94 → conservative 0.92; cost
    // 400 (both) → 400; latency 2000 (both) → 2000; reliability 2/4.
    expect(record.expectedOutcome.expectedQuality).toBe(0.92);
    expect(record.expectedOutcome.observationCount).toBe(2);
    expect(record.expectedOutcome.expectedReliability).toBe(0.5);
    expect(record.claim.expectedCostMicroUsd).toBe("400");
    expect(record.claim.expectedLatencyMs).toBe(2000);
    // The claim rides the foundation's OWN observed basis with the
    // trajectory-digest evidence pin.
    expect(record.claim.basis.basis).toBe("observed");
    expect(record.claim.basis.evidenceDigest).toBe(record.trajectoryDigest);
    // The verification binding is the OBSERVED one (recorded, never re-judged).
    expect(record.expectedOutcome.verificationBinding.strategy).toBe("schema-check");
  });

  test("the same corpus mines the byte-identical record (determinism, idempotence)", () => {
    const first = mineCompetenceCandidate(miningCorpus(), digest);
    const second = mineCompetenceCandidate(miningCorpus(), digest);
    expect(first).toStrictEqual(second);
    expect(first.recordId).toBe(second.recordId);
    // The mined record round-trips read-time validation.
    expect(validateCompetenceRecord(first, digest)).toStrictEqual(first);
  });

  test("the mining basis is the frozen statement and the executors ride the record", () => {
    const record = minedRecord();
    expect(record.minedBy).toBe(miningCorpus().miningAuthority);
    expect(record.trajectoryExecutors).toEqual(["agent-worker-01"]);
    // The trajectory digest pins the canonical evidence forms.
    expect(record.trajectoryDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a corpus below the repetition minimum is a typed rejection (no lucky runs)", () => {
    const corpus = { ...miningCorpus(), trajectories: [trajectory(1, 0.92)] };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("mining-input-shape");
    expect((caught as CompetenceEconomicsError).details.minimum).toBe(MIN_SUCCESSFUL_TRAJECTORIES);
  });

  test("mining observes SUCCESSES ONLY: a non-successful trajectory is a typed rejection", () => {
    const failed = { ...trajectory(3, 0.9), outcome: "failure" } as never;
    const corpus = { ...miningCorpus(), trajectories: [trajectory(1, 0.92), failed] };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("trajectory-shape");
    // The validator itself rejects it directly too.
    const direct = capture(() => validateSuccessfulTrajectory(failed, digest));
    expect((direct as CompetenceEconomicsError).invariant).toBe("trajectory-shape");
  });

  test("the SELF-MINING guard: a mining authority that executed a trajectory is rejected", () => {
    const corpus = { ...miningCorpus(), miningAuthority: "agent-worker-01" };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("mining-input-shape");
    expect((caught as CompetenceEconomicsError).details.miningAuthority).toBe("agent-worker-01");
  });

  test("a mixed-environment corpus is an incoherent mining input (typed rejection)", () => {
    // A VALID trajectory in the drifted environment (its own identity
    // holds): the CORPUS-level coherence guard trips, not the
    // trajectory-shape validator.
    const corpus = {
      ...miningCorpus(),
      trajectories: [trajectory(1, 0.92), driftedTrajectory(2)],
    };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("mining-input-shape");
  });

  test("an dishonest denominator (totalExecutions < successes) is a typed rejection", () => {
    const corpus = { ...miningCorpus(), totalExecutions: 1 };
    const caught = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("mining-input-shape");
  });

  test("a tampered trajectory identity is rejected at read time (provenance)", () => {
    const tampered = { ...trajectory(1, 0.92), trajectoryId: digest.sha256Hex("forged") };
    const caught = capture(() => validateSuccessfulTrajectory(tampered, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("trajectory-shape");
  });

  test("trajectory shape discipline: every field is bounded and validated", () => {
    expect(
      capture(() =>
        validateSuccessfulTrajectory({ ...trajectory(1, 0.92), executionId: "not-a-uuid" }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateSuccessfulTrajectory({ ...trajectory(1, 0.92), observedQuality: 1.5 }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateSuccessfulTrajectory(
          { ...trajectory(1, 0.92), observedCostMicroUsd: "-1" },
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateSuccessfulTrajectory({ ...trajectory(1, 0.92), executorIdentity: "" }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        validateSuccessfulTrajectory(
          { ...trajectory(1, 0.92), trajectoryDigest: "not-a-digest" },
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("HONEST CONSUMPTION: the fingerprint validator's own error propagates (never re-branded)", () => {
    // A trajectory with a non-fingerprint environment is rejected by
    // the MERGED failure-recovery plane's own validator — and that
    // error is NOT re-branded as a competence-economics error.
    const foreignEnvironment = { fingerprintId: "not-hex", entries: [] };
    const corrupted = { ...trajectory(1, 0.92), environment: foreignEnvironment as never };
    const caught = capture(() => validateSuccessfulTrajectory(corrupted, digest));
    expect(caught).toBeInstanceOf(FailureRecoveryError);
    expect(caught).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as FailureRecoveryError).invariant).toBe("fingerprint-shape");
    // And through the mining seam, identically.
    const corpus = {
      ...miningCorpus(),
      trajectories: [corrupted, trajectory(2, 0.94)],
    };
    const mining = capture(() => mineCompetenceCandidate(corpus, digest));
    expect(mining).toBeInstanceOf(FailureRecoveryError);
    expect(mining).not.toBeInstanceOf(CompetenceEconomicsError);
  });

  test("HONEST CONSUMPTION: the attribution validator's own error propagates", () => {
    // A trajectory carrying an invalid recovery attribution is
    // rejected by the failure-recovery plane's OWN attribution
    // validator — imported read-only, error as-is.
    const corrupted = { ...trajectory(1, 0.92), recoveryAttribution: "not-an-attribution" };
    const caught = capture(() => validateSuccessfulTrajectory(corrupted, digest));
    expect(caught).toBeInstanceOf(FailureRecoveryError);
    expect(caught).not.toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the corpus scope and vocabulary are validated fail-closed", () => {
    expect(
      capture(() =>
        mineCompetenceCandidate(
          { ...miningCorpus(), scope: { ...scope, tenantId: "not-a-uuid" } },
          digest,
        ),
      ),
    ).toBeInstanceOf(Error); // the context-economics plane's own error
    expect(
      capture(() =>
        mineCompetenceCandidate({ ...miningCorpus(), capabilityId: "NOT A SLUG" }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() => mineCompetenceCandidate({ ...miningCorpus(), tags: ["NOT A TAG!"] }, digest)),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() => mineCompetenceCandidate({ ...miningCorpus(), basis: "" }, digest)),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        mineCompetenceCandidate({ ...miningCorpus(), miningAuthority: "NOT VALID!" }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the environment of the mined record IS the corpus's environment", () => {
    const record = minedRecord();
    expect(record.environment.fingerprintId).toBe(environment().fingerprintId);
    // The applicability shape is the corpus's own.
    expect(record.capabilityId).toBe(miningCorpus().capabilityId);
    expect(record.tags).toEqual([...miningCorpus().tags].sort());
    expect(record.scope).toStrictEqual(scope);
  });

  test("a second executor's trajectory joins the executor set honestly", () => {
    const corpus = {
      ...miningCorpus(),
      trajectories: [trajectory(1, 0.92), trajectory(2, 0.94), secondExecutorTrajectory(3)],
      totalExecutions: 5,
    };
    const record = mineCompetenceCandidate(corpus, digest);
    expect(record.trajectoryExecutors).toEqual(["agent-worker-01", "agent-worker-02"]);
    expect(record.expectedOutcome.observationCount).toBe(3);
    expect(record.expectedOutcome.expectedReliability).toBe(0.6);
    // The conservative minimum over the three observations (0.92, 0.94, 0.92).
    expect(record.expectedOutcome.expectedQuality).toBe(0.92);
  });
});
