/**
 * Unit battery: bounded typed rollback (WORK-056 AC 7).
 *
 * Proves: ROLLBACK IS BOUNDED AND TYPED — a degraded promotion
 * reverts to the PRIOR representation (exactly one stage back,
 * derived never supplied) with RECORDED degradation evidence and
 * reason↔evidence coherence; the requesting authority must be
 * independent (no self-rollback); the rollback record is
 * content-addressed, deterministic and read-time validated; the
 * application is PURE and IDEMPOTENT (promoted → reverted, reverted
 * → bounded no-op, foreign → typed rejection); a candidate-stage
 * record has nothing to roll back.
 */

import { describe, expect, test } from "vitest";
import { CompetenceEconomicsError } from "../../../../src/platform/competence-economics/catalog";
import {
  applyRollbackRecord,
  buildRollback,
  ROLLBACK_BASIS,
  validateRollbackRecord,
} from "../../../../src/platform/competence-economics/rollback";
import {
  atStage,
  digest,
  equivalenceDegradation,
  minedRecord,
  recordVariant,
  RECORDED_AT,
  rollbackInput,
  ROLLBACK_AUTHORITY,
} from "./world";

function capture<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("bounded typed rollback (WORK-056)", () => {
  test("a well-formed rollback reverts EXACTLY one stage back with recorded evidence", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    expect(rollback.rollbackId).toMatch(/^[0-9a-f]{64}$/);
    expect(rollback.fromStage).toBe("shadow");
    expect(rollback.toStage).toBe("candidate");
    expect(rollback.reason).toBe("equivalence-degraded");
    expect(rollback.degradedEvidence).toStrictEqual(equivalenceDegradation());
    expect(rollback.requestedBy).toBe(ROLLBACK_AUTHORITY);
    expect(rollback.recordedAt).toBe(RECORDED_AT);
    expect(rollback.rollbackBasis).toBe(ROLLBACK_BASIS);
    // The reverted record is the prior representation (DATA).
    expect(rollback.revertedRecord.stage).toBe("candidate");
    expect(rollback.revertedRecord.recordId).toBe(minedRecord().recordId);
    expect(rollback.promotedRecord.recordId).toBe(atStage("shadow").recordId);
  });

  test("every promoted stage rolls back exactly one stage (shadow→candidate, canary→shadow, deterministic→canary)", () => {
    for (const [from, to] of [
      ["shadow", "candidate"],
      ["canary", "shadow"],
      ["deterministic", "canary"],
    ] as const) {
      const rollback = buildRollback(rollbackInput(atStage(from)), digest);
      expect(rollback.fromStage).toBe(from);
      expect(rollback.toStage).toBe(to);
      expect(rollback.revertedRecord.stage).toBe(to);
    }
  });

  test("the same input produces the byte-identical rollback (determinism)", () => {
    const first = buildRollback(rollbackInput(), digest);
    const second = buildRollback(rollbackInput(), digest);
    expect(first).toStrictEqual(second);
    expect(first.rollbackId).toBe(second.rollbackId);
    // Read-time validation round-trips.
    expect(validateRollbackRecord(first, digest)).toStrictEqual(first);
  });

  test("the reason↔evidence COHERENCE is enforced (typed rejection)", () => {
    // An equivalence-degraded rollback without equivalence evidence.
    const qualityOnly = capture(() =>
      buildRollback(
        rollbackInput(atStage("shadow"), "equivalence-degraded", [
          { kind: "quality", observedQuality: 0.5, detail: "quality fell" },
        ]),
        digest,
      ),
    );
    expect(qualityOnly).toBeInstanceOf(CompetenceEconomicsError);
    expect((qualityOnly as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    // Each reason requires its own coherent evidence kind.
    for (const [reason, incoherent] of [
      ["quality-degraded", equivalenceDegradation()],
      ["economics-degraded", equivalenceDegradation()],
      ["policy-revoked", equivalenceDegradation()],
    ] as const) {
      const caught = capture(() =>
        buildRollback(rollbackInput(atStage("shadow"), reason, [...incoherent]), digest),
      );
      expect(caught, `reason ${reason}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    }
    // The coherent pairs all succeed.
    for (const [reason, evidence] of [
      ["quality-degraded", [{ kind: "quality", observedQuality: 0.5, detail: "fell below floor" }]],
      [
        "economics-degraded",
        [{ kind: "economics", observedCostMicroUsd: "5000", detail: "cost regressed" }],
      ],
      ["policy-revoked", [{ kind: "policy", detail: "the policy authority revoked the basis" }]],
    ] as const) {
      const rollback = buildRollback(rollbackInput(atStage("shadow"), reason, [...evidence]), digest);
      expect(rollback.reason).toBe(reason);
    }
  });

  test("a rollback without evidence is a typed rejection (never silent)", () => {
    const caught = capture(() =>
      buildRollback(rollbackInput(atStage("shadow"), "equivalence-degraded", []), digest),
    );
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    // The evidence bound is enforced.
    const excessive = Array.from({ length: 65 }, () => equivalenceDegradation()[0]);
    const bounded = capture(() =>
      buildRollback(rollbackInput(atStage("shadow"), "equivalence-degraded", excessive), digest),
    );
    expect(bounded).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("a candidate-stage record has no promotion to roll back (typed rejection)", () => {
    const caught = capture(() => buildRollback(rollbackInput(minedRecord()), digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    expect((caught as CompetenceEconomicsError).details.stage).toBe("candidate");
  });

  test("NO SELF-ROLLBACK: a trajectory executor or the miner can never roll back", () => {
    for (const authority of ["agent-worker-01", "mining-job-07"]) {
      const caught = capture(() =>
        buildRollback(rollbackInput(atStage("shadow"), undefined, undefined, authority), digest),
      );
      expect(caught, `authority ${authority}`).toBeInstanceOf(CompetenceEconomicsError);
      expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    }
  });

  test("the degradation evidence kinds are closed and validated", () => {
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), "equivalence-degraded", [
            { kind: "NOT-A-KIND", detail: "x" },
          ]),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), "equivalence-degraded", [
            { kind: "equivalence", component: "NOT-A-COMPONENT", detail: "x" },
          ]),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), "equivalence-degraded", [
            { kind: "quality", observedQuality: 1.5, detail: "x" },
          ]),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), "economics-degraded", [
            { kind: "economics", observedCostMicroUsd: "-5", detail: "x" },
          ]),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), "equivalence-degraded", [
            { kind: "equivalence", component: "replay", detail: "" },
          ]),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    // The reason vocabulary is closed.
    expect(
      capture(() =>
        buildRollback(rollbackInput(atStage("shadow"), "NOT-A-REASON" as never), digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("the promoted record is re-validated (tampered values never roll back)", () => {
    const promoted = atStage("shadow");
    const tampered = { ...promoted, trajectoryDigest: digest.sha256Hex("forged") };
    const caught = capture(() => buildRollback(rollbackInput(tampered as never), digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("a tampered rollback is rejected at read time (identity re-derivation)", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    const tampered = { ...rollback, reason: "policy-revoked" };
    const caught = capture(() => validateRollbackRecord(tampered, digest));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    const foreignBasis = { ...rollback, rollbackBasis: "some-other-basis" };
    const basis = capture(() => validateRollbackRecord(foreignBasis, digest));
    expect((basis as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    expect(
      capture(() => validateRollbackRecord("not-an-object", digest)),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });

  test("apply is PURE and IDEMPOTENT: promoted → reverted, reverted → no-op", () => {
    const rollback = buildRollback(rollbackInput(), digest);
    const promoted = rollback.promotedRecord;
    const reverted = rollback.revertedRecord;

    // First application: the prior representation restored.
    const applied = applyRollbackRecord(rollback, promoted);
    expect(applied.recordId).toBe(reverted.recordId);
    expect(applied.stage).toBe("candidate");

    // Second application (on the already-reverted record): a bounded
    // NO-OP returning the same value — never a second reversion.
    const reapplied = applyRollbackRecord(rollback, applied);
    expect(reapplied).toStrictEqual(applied);

    // A foreign record never silently applies.
    const foreign = recordVariant({ trajectoryDigest: digest.sha256Hex("foreign-to-rollback") });
    const caught = capture(() => applyRollbackRecord(rollback, foreign));
    expect(caught).toBeInstanceOf(CompetenceEconomicsError);
    expect((caught as CompetenceEconomicsError).invariant).toBe("rollback-shape");
    expect((caught as CompetenceEconomicsError).details.recordId).toBe(foreign.recordId);
  });

  test("the requesting authority and recorded-at are validated (typed)", () => {
    expect(
      capture(() =>
        buildRollback(
          rollbackInput(atStage("shadow"), undefined, undefined, "NOT VALID!"),
          digest,
        ),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
    expect(
      capture(() =>
        buildRollback({ ...rollbackInput(atStage("shadow")), recordedAt: "" }, digest),
      ),
    ).toBeInstanceOf(CompetenceEconomicsError);
  });
});
