/**
 * Unit battery: typed competence records (WORK-056 AC 1).
 *
 * Proves: content-addressed construction and round-trips; the
 * self-assertion guard (miner == executor → rejection at BOTH
 * construction and read time); unattributed rejections (no miner,
 * no repetition); applicability-bound validation; determinism
 * (byte-identical records, input-order independence); tamper
 * rejection (identity re-derivation); the tenant-scoped corpus-key
 * derivation through the merged context-economics plane.
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import {
  buildCompetenceRecord,
  competenceCorpusKey,
  validateCompetenceRecord,
} from "../../../../src/platform/competence-economics/record";
import { CostModelError } from "../../../../src/platform/execution-ir/cost-model";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  claim,
  digest,
  driftedEnvironment,
  environment,
  minedRecord,
  miningCorpus,
  OTHER_TENANT_ID,
  scope,
  TENANT_ID,
  trajectory,
} from "./world";

/**
 * ONE call, both assertions: capture the thrown error so the class and
 * the invariant code are asserted on a single execution (no
 * double-calling the builder — every rejection is proven once, exactly
 * as a consumer would observe it).
 */
function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function recordInput() {
  return {
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
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
}

describe("competence records (WORK-056)", () => {
  test("a well-formed record is content-addressed and round-trips", () => {
    const record = buildCompetenceRecord(recordInput());
    expect(record.recordId).toMatch(/^[0-9a-f]{64}$/);
    const validated = validateCompetenceRecord(record, digest);
    expect(validated).toStrictEqual(record);
  });

  test("the same inputs produce the byte-identical record (determinism)", () => {
    const first = buildCompetenceRecord(recordInput());
    const second = buildCompetenceRecord(recordInput());
    expect(first).toStrictEqual(second);
    expect(first.recordId).toBe(second.recordId);
  });

  test("input tag order does not change the identity (canonical form)", () => {
    const input = recordInput();
    const reordered = buildCompetenceRecord({
      ...input,
      tags: [...input.tags].reverse(),
    });
    expect(reordered.recordId).toBe(buildCompetenceRecord(input).recordId);
  });

  test("executor order does not change the identity (canonical form)", () => {
    const input = recordInput();
    const reordered = buildCompetenceRecord({
      ...input,
      trajectoryExecutors: [...input.trajectoryExecutors].reverse(),
    });
    expect(reordered.recordId).toBe(buildCompetenceRecord(input).recordId);
  });

  test("the self-assertion guard: a miner that is an executor is rejected at construction", () => {
    const input = recordInput();
    const caught = capture(() =>
      buildCompetenceRecord({ ...input, minedBy: "agent-worker-01" }),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("record-self-asserted");
  });

  test("the self-assertion guard re-proves at READ time (tampered records rejected)", () => {
    const record = buildCompetenceRecord(recordInput());
    const tampered = { ...record, minedBy: "agent-worker-01" };
    expect(() => validateCompetenceRecord(tampered, digest)).toThrow(CompetenceEconomicsError);
  });

  test("identity tamper is rejected at read time", () => {
    const record = buildCompetenceRecord(recordInput());
    const tampered = { ...record, trajectoryDigest: digest.sha256Hex("forged") };
    expect(() => validateCompetenceRecord(tampered, digest)).toThrow(CompetenceEconomicsError);
  });

  test("an unattributed record (no miner) is rejected", () => {
    const input = recordInput() as Record<string, unknown>;
    delete input.minedBy;
    expect(() => buildCompetenceRecord(input as never)).toThrow(CompetenceEconomicsError);
  });

  test("a below-repetition-minimum record is rejected (single lucky runs never become competence)", () => {
    const input = recordInput();
    const weak = buildInputWithOutcome(input, { observationCount: 1 });
    const caught = capture(() => buildCompetenceRecord(weak));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("record-unattributed");
  });

  test("applicability bounds are validated (bad capability, bad tags, wrong stage)", () => {
    expect(() => buildCompetenceRecord({ ...recordInput(), capabilityId: "NOT-A-SLUG" })).toThrow(
      CompetenceEconomicsError,
    );
    expect(() =>
      buildCompetenceRecord({ ...recordInput(), tags: ["classify", "NOT A TAG!"] }),
    ).toThrow(CompetenceEconomicsError);
    expect(() => buildCompetenceRecord({ ...recordInput(), stage: "gauntlet" as never })).toThrow(
      CompetenceEconomicsError,
    );
    expect(() => buildCompetenceRecord({ ...recordInput(), tags: [] })).toThrow(
      CompetenceEconomicsError,
    );
  });

  test("the environment fingerprint is validated by the failure-recovery plane's OWN error (honest consumption)", () => {
    // A drifted fingerprint is still a VALID fingerprint — but a
    // non-fingerprint is rejected by the MERGED plane's own validator,
    // and the plane NEVER re-brands the foreign rejection: the
    // failure-recovery plane's own typed error propagates as-is.
    const foreign = { fingerprintId: "not-hex", entries: [] };
    const caught = capture(() =>
      buildCompetenceRecord({ ...recordInput(), environment: foreign as never }),
    );
    expect(caught).toBeInstanceOf(FailureRecoveryError);
    expect(caught).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as FailureRecoveryError).invariant).toBe("fingerprint-shape");
  });

  test("the claim is the foundation's own validated explicit-basis claim (honest consumption)", () => {
    // The foundation's OWN validator rejects the claim with its own
    // typed error — consumed, never re-branded (the plane adds no
    // second opinion on top of the foundation's).
    const badClaim = { ...claim("400", 2000, 0.92, 0.5, "src"), expectedReliability: 0 };
    const caught = capture(() => buildCompetenceRecord({ ...recordInput(), claim: badClaim }));
    expect(caught).toBeInstanceOf(CostModelError);
    expect(caught).not.toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CostModelError).invariant).toBe("unreliable-representation");
    const unattributed = {
      expectedCostMicroUsd: "400",
      expectedLatencyMs: 2000,
      expectedQuality: 0.92,
      expectedReliability: 0.5,
    };
    const caughtBasis = capture(() =>
      buildCompetenceRecord({ ...recordInput(), claim: unattributed as never }),
    );
    expect(caughtBasis).toBeInstanceOf(CostModelError);
    expect((caughtBasis as CostModelError).invariant).toBe("unattributed-cost");
  });

  test("the tenant-scoped corpus key derives through the merged context-economics plane", () => {
    const key = competenceCorpusKey(
      scope,
      "text-generation",
      ["classify", "structured-output"],
      digest,
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Same semantics under the same tenant: identical key.
    const same = competenceCorpusKey(
      scope,
      "text-generation",
      ["structured-output", "classify"],
      digest,
    );
    expect(same).toBe(key);
    // Different tenant: DIFFERENT key (structural tenant safety).
    const other = competenceCorpusKey(
      { tenantId: OTHER_TENANT_ID, applicationId: scope.applicationId },
      "text-generation",
      ["classify", "structured-output"],
      digest,
    );
    expect(other).not.toBe(key);
  });

  test("a mined record IS a well-formed record at candidate stage", () => {
    const record = minedRecord();
    expect(record.stage).toBe("candidate");
    expect(record.minedBy).toBe(miningCorpus().miningAuthority);
    expect(record.expectedOutcome.observationCount).toBe(2);
    expect(validateCompetenceRecord(record, digest)).toStrictEqual(record);
  });

  test("the record never carries authority vocabulary (evidence, never permission)", () => {
    const record = buildCompetenceRecord(recordInput());
    const serialized = JSON.stringify(record);
    for (const word of ["authorize", "admission", "approve", "permission", "allow", "grant"]) {
      expect(serialized).not.toContain(word);
    }
    expect(record.scope.tenantId).toBe(TENANT_ID);
  });

  test("the drifted environment is a valid record but a different identity (bounds matter)", () => {
    const input = recordInput();
    const drifted = buildCompetenceRecord({ ...input, environment: driftedEnvironment() });
    expect(drifted.recordId).not.toBe(buildCompetenceRecord(input).recordId);
  });
});

function buildInputWithOutcome(
  input: ReturnType<typeof recordInput>,
  outcome: Record<string, unknown>,
) {
  return { ...input, expectedOutcome: { ...input.expectedOutcome, ...outcome } };
}
