/**
 * VAL-050 acceptance criteria 4 and 6 (the mechanical verification
 * core + the discrimination battery): the journey machinery — the
 * five mechanical integrity oracles over the deterministic journey
 * observation.
 *
 *   * the oracles: stage completeness, cross-stage idempotency,
 *     continuation exactly-once, customer boundary and accounting
 *     reconciliation — each probed adversarially through the five
 *     controlled fakes (a dropped stage, an orphaned state, a
 *     duplicated resume, a boundary leak, a hidden residual) PLUS the
 *     crafted discriminations beyond the probe vocabulary (an
 *     undeclared resume, an out-of-order stage list, an undeclared
 *     extra stage);
 *   * the honest rows: all five criteria PASS; the continuation row
 *     resumes exactly once (two durable executions for the failed
 *     stage — never one, never three);
 *   * the honest verdict vocabulary: JOURNEY-COMPLETED /
 *     JOURNEY-FAILED (with the failed criteria NAMED) — never a
 *     narrative;
 *   * the digest discipline: every evidence reference is digest-only
 *     (payload-free FNV-1a digests and short NAMED references — never
 *     payload bytes, never prices).
 */

import { describe, expect, test } from "vitest";
import type { JourneyProbeKind } from "../../../benchmarks/validation/apps/customer-journey/corpus";
import {
  JOURNEY_CUSTOMER_APPLICATION_ID,
  journeyRowById,
  PROBE_FAILED_CRITERIA_OF,
} from "../../../benchmarks/validation/apps/customer-journey/corpus";
import type { JourneyObservation } from "../../../benchmarks/validation/apps/customer-journey/driver";
import {
  deriveJourneyVerdict,
  FOREIGN_APPLICATION_ID,
  journeyIntentIdOf,
  journeyObservationFor,
  verifyCustomerJourneyIntegrity,
} from "../../../benchmarks/validation/apps/customer-journey/driver";

const HONEST = "full-journey-recorded-portfolio";
const CONTINUATION = "journey-continuation-resume";

function rowOf(rowId: string) {
  const row = journeyRowById(rowId);
  if (row === null) {
    throw new Error(`no corpus row ${rowId}`);
  }
  return row;
}

function criteriaOf(rowId: string, probe?: JourneyProbeKind) {
  const row = rowOf(rowId);
  const observation = journeyObservationFor(row, probe === undefined ? {} : { probe });
  return verifyCustomerJourneyIntegrity({ row, observation });
}

function evidenceOf(
  rowId: string,
  criterionId: string,
  probe?: JourneyProbeKind,
): readonly string[] {
  const criterion = criteriaOf(rowId, probe).find(
    (candidate) => candidate.criterionId === criterionId,
  );
  if (criterion === undefined) {
    throw new Error(`no criterion ${criterionId} for ${rowId}`);
  }
  return criterion.evidence;
}

// ---------------------------------------------------------------------------
// The honest rows (all five criteria PASS)
// ---------------------------------------------------------------------------

describe("VAL-050 the honest journey rows verify all five integrity families", () => {
  test("the canonical full journey PASSes every criterion", () => {
    const criteria = criteriaOf(HONEST);
    expect(criteria.map((criterion) => criterion.criterionId)).toEqual([
      "stage-completeness",
      "cross-stage-idempotency",
      "continuation-exactly-once",
      "customer-boundary",
      "accounting-reconciliation",
    ]);
    for (const criterion of criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
      expect(criterion.strategy).toBe("deterministic");
    }
  });

  test("the continuation row resumes exactly once (two durable executions for the failed stage)", () => {
    const criteria = criteriaOf(CONTINUATION);
    for (const criterion of criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    const continuation = criteria.find(
      (criterion) => criterion.criterionId === "continuation-exactly-once",
    );
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("declared-failure-stage:daily-usage");
    expect(evidence).toContain("daily-usage:executions=2,resumed=true");
    // The failed attempt's cost is never hidden: the recorded stage
    // economics carry the two driven attempts honestly.
    const accounting = criteria.find(
      (criterion) => criterion.criterionId === "accounting-reconciliation",
    );
    const recorded = accounting?.evidence.find((entry) => entry.startsWith("recorded-cost-basis:"));
    expect(recorded).toBe("recorded-cost-basis:23100");
    expect(accounting?.evidence).toContain("cost-residual:0");
    expect(accounting?.evidence).toContain("latency-residual:0");
  });

  test("the honest observation's stage economics equal the recorded declarations", () => {
    for (const rowId of [HONEST, CONTINUATION, "journey-idempotent-reissue"]) {
      const row = rowOf(rowId);
      const observation = journeyObservationFor(row);
      expect(
        observation.stages.map((record) => [record.stage, record.costMicroUsd, record.latencyMs]),
        rowId,
      ).toEqual(
        row.stages.map((stage) => [
          stage.stage,
          stage.economics.costMicroUsd,
          stage.economics.latencyMs,
        ]),
      );
      // The reported journey total is the stage-for-stage sum.
      const costSum = observation.stages
        .reduce((total, record) => total + BigInt(record.costMicroUsd), 0n)
        .toString();
      expect(observation.reported.totalCostMicroUsd, rowId).toBe(costSum);
      const latencySum = observation.stages.reduce((total, record) => total + record.latencyMs, 0);
      expect(observation.reported.totalLatencyMs, rowId).toBe(latencySum);
      // Every stage executes under the journey's own customer identity.
      for (const record of observation.stages) {
        expect(record.applicationId, `${rowId}/${record.stage}`).toBe(
          JOURNEY_CUSTOMER_APPLICATION_ID,
        );
        expect(record.basisDigest).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The discrimination battery (the five controlled fakes — AC6)
// ---------------------------------------------------------------------------

describe("VAL-050 the discrimination battery (the controlled fakes each FAIL named)", () => {
  test("a dropped stage FAILs stage-completeness with the stage NAMED (and the missing cost NAMED)", () => {
    const stage = criteriaOf(HONEST, "dropped-stage");
    expect(stage.find((c) => c.criterionId === "stage-completeness")?.status).toBe("FAIL");
    expect(evidenceOf(HONEST, "stage-completeness", "dropped-stage")).toContain(
      "missing-stage:daily-usage",
    );
    // The dropped stage's recorded cost is the journey-level residual.
    const accounting = stage.find((c) => c.criterionId === "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("recorded-cost-basis:13500");
    expect(accounting?.evidence).toContain("observed-stage-sum:3900");
  });

  test("an orphaned state FAILs cross-stage-idempotency with the intent NAMED (never the continuation oracle)", () => {
    const criteria = criteriaOf(HONEST, "orphaned-state");
    const idempotency = criteria.find((c) => c.criterionId === "cross-stage-idempotency");
    expect(idempotency?.status).toBe("FAIL");
    expect(
      idempotency?.evidence.some((entry) => entry.startsWith("orphaned-intent:daily-usage")),
    ).toBe(true);
    // The orphaned stage is the idempotency oracle's catch — the
    // continuation oracle never double-counts an unlanded intent.
    expect(criteria.find((c) => c.criterionId === "continuation-exactly-once")?.status).toBe(
      "PASS",
    );
    // The missing work's residual is NAMED.
    const accounting = criteria.find((c) => c.criterionId === "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("observed-stage-sum:3900");
  });

  test("a duplicated resume FAILs continuation-exactly-once with the stage and counts NAMED", () => {
    const criteria = criteriaOf(CONTINUATION, "double-driven-resume");
    const continuation = criteria.find((c) => c.criterionId === "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    expect(
      continuation?.evidence.some(
        (entry) =>
          entry.startsWith("resume-violation:daily-usage") &&
          entry.includes("observed executions=3") &&
          entry.includes("exactly 2"),
      ),
    ).toBe(true);
    // The duplicated work's cost is never hidden: the accounting
    // oracle names the drifted basis (three drives against the
    // recorded two).
    const accounting = criteria.find((c) => c.criterionId === "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("observed-stage-sum:32700");
    expect(accounting?.evidence).toContain("recorded-cost-basis:23100");
    expect(
      accounting?.evidence.some((entry) => entry.startsWith("re-priced-stage:daily-usage")),
    ).toBe(true);
  });

  test("a boundary leak FAILs customer-boundary with the stage and foreign identity NAMED", () => {
    const criteria = criteriaOf(HONEST, "boundary-leak");
    const boundary = criteria.find((c) => c.criterionId === "customer-boundary");
    expect(boundary?.status).toBe("FAIL");
    expect(
      boundary?.evidence.some(
        (entry) =>
          entry.startsWith("boundary-leak:daily-usage") &&
          entry.includes(FOREIGN_APPLICATION_ID) &&
          entry.includes(JOURNEY_CUSTOMER_APPLICATION_ID),
      ),
    ).toBe(true);
    // Only the boundary oracle FAILs — the leak is otherwise honest.
    for (const criterion of criteria) {
      if (criterion.criterionId !== "customer-boundary") {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
  });

  test("a hidden residual FAILs accounting-reconciliation with the exact residual NAMED", () => {
    const criteria = criteriaOf(HONEST, "residual-hiding");
    const accounting = criteria.find((c) => c.criterionId === "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    // Half the daily-usage stage's observed cost (4800 of 9600) is
    // hidden from the reported journey total — the residual is NAMED.
    expect(accounting?.evidence).toContain("observed-stage-sum:13500");
    expect(accounting?.evidence).toContain("reported-journey-total:8700");
    expect(accounting?.evidence).toContain("cost-residual:-4800");
    // Only the accounting oracle FAILs.
    for (const criterion of criteria) {
      if (criterion.criterionId !== "accounting-reconciliation") {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
  });

  test("every probe's derived verdict matches the pinned failed-criteria vocabulary exactly", () => {
    const probes: readonly JourneyProbeKind[] = [
      "dropped-stage",
      "orphaned-state",
      "double-driven-resume",
      "boundary-leak",
      "residual-hiding",
    ];
    for (const probe of probes) {
      const row = probe === "double-driven-resume" ? rowOf(CONTINUATION) : rowOf(HONEST);
      const verdict = deriveJourneyVerdict({
        row,
        observation: journeyObservationFor(row, { probe }),
      });
      expect(verdict.verdict, probe).toBe("JOURNEY-FAILED");
      expect([...verdict.failedCriteria].sort(), probe).toEqual(
        [...PROBE_FAILED_CRITERIA_OF[probe]].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The crafted discriminations (beyond the probe vocabulary)
// ---------------------------------------------------------------------------

describe("VAL-050 the crafted discriminations", () => {
  /** Craft one observation over the honest row with a mutation applied. */
  function craft(
    mutate: (observation: JourneyObservation) => JourneyObservation,
    rowId: string = HONEST,
  ): JourneyObservation {
    return mutate(journeyObservationFor(rowOf(rowId)));
  }

  test("an UNDECLARED resume FAILs continuation-exactly-once NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      stages: base.stages.map((record) =>
        record.stage === "outcome" ? { ...record, executions: 2, resumed: true } : record,
      ),
    }));
    const criteria = verifyCustomerJourneyIntegrity({ row: rowOf(HONEST), observation });
    const continuation = criteria.find((c) => c.criterionId === "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    expect(
      continuation?.evidence.some((entry) => entry.startsWith("resume-violation:outcome")),
    ).toBe(true);
  });

  test("an out-of-order stage list FAILs stage-completeness with the divergence NAMED", () => {
    const observation = craft((base) => {
      const stages = [...base.stages];
      const removed = stages.splice(2, 1); // "plan" removed
      const plan = removed[0];
      if (plan === undefined) {
        throw new Error("the honest journey holds no plan stage");
      }
      stages.splice(3, 0, plan); // re-inserted AFTER daily-usage (out of order)
      return { ...base, stages };
    });
    const criteria = verifyCustomerJourneyIntegrity({ row: rowOf(HONEST), observation });
    const completeness = criteria.find((c) => c.criterionId === "stage-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence).toContain("stage-order-divergence");
    // The reordered journey is complete in membership — only the order diverges.
    expect(completeness?.evidence).not.toContain("missing-stage:daily-usage");
  });

  test("an undeclared extra stage FAILs stage-completeness with the stage NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      stages: [
        ...base.stages,
        {
          ...base.stages[4],
          stage: "outcome",
          intentId: "undeclared:intent",
        } as (typeof base.stages)[number],
      ],
    }));
    const criteria = verifyCustomerJourneyIntegrity({ row: rowOf(HONEST), observation });
    const completeness = criteria.find((c) => c.criterionId === "stage-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence).toContain("duplicated-stage-record");
    const idempotency = criteria.find((c) => c.criterionId === "cross-stage-idempotency");
    expect(idempotency?.status).toBe("FAIL");
    expect(idempotency?.evidence.some((entry) => entry.includes("undeclared-intent"))).toBe(true);
  });

  test("a re-priced stage FAILs accounting-reconciliation with the stage NAMED (re-pricing recorded inputs FAILs)", () => {
    const observation = craft((base) => ({
      ...base,
      stages: base.stages.map((record) =>
        record.stage === "plan" ? { ...record, costMicroUsd: "1501" } : record,
      ),
      reported: { ...base.reported, totalCostMicroUsd: "13501" },
    }));
    const criteria = verifyCustomerJourneyIntegrity({ row: rowOf(HONEST), observation });
    const accounting = criteria.find((c) => c.criterionId === "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.some((entry) => entry.startsWith("re-priced-stage:plan"))).toBe(
      true,
    );
  });

  test("a missing observation member (no stages at all) FAILs the families with work to judge", () => {
    const observation = craft((base) => ({
      ...base,
      stages: [],
      reported: { totalCostMicroUsd: "0", totalLatencyMs: 0 },
    }));
    const criteria = verifyCustomerJourneyIntegrity({ row: rowOf(HONEST), observation });
    // The completeness oracle names EVERY missing stage; the
    // idempotency oracle names every unclaimed intent; the accounting
    // oracle names the full missing-cost residual.
    for (const criterionId of [
      "stage-completeness",
      "cross-stage-idempotency",
      "accounting-reconciliation",
    ]) {
      expect(criteria.find((c) => c.criterionId === criterionId)?.status, criterionId).toBe("FAIL");
    }
    const completeness = criteria.find((c) => c.criterionId === "stage-completeness");
    expect(completeness?.evidence.join(" ")).toContain(
      "missing-stage:onboarding,intent,plan,daily-usage,outcome",
    );
    // The continuation and boundary oracles are vacuously satisfied
    // over an empty observation (no resume and no identity to judge —
    // the missing stages are the completeness oracle's catch, never
    // double-counted).
    expect(criteria.find((c) => c.criterionId === "continuation-exactly-once")?.status).toBe(
      "PASS",
    );
    expect(criteria.find((c) => c.criterionId === "customer-boundary")?.status).toBe("PASS");
    const verdict = deriveJourneyVerdict({ row: rowOf(HONEST), observation });
    expect(verdict.verdict).toBe("JOURNEY-FAILED");
    expect(verdict.failedCriteria).toEqual([
      "stage-completeness",
      "cross-stage-idempotency",
      "accounting-reconciliation",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The honest verdict vocabulary + the digest discipline
// ---------------------------------------------------------------------------

describe("VAL-050 the honest verdict vocabulary + the digest discipline", () => {
  test("the verdict vocabulary is the declared vocabulary only (never a narrative)", () => {
    for (const rowId of [
      "full-journey-recorded-portfolio",
      "journey-continuation-resume",
      "journey-idempotent-reissue",
      "probe-dropped-stage",
      "probe-orphaned-state",
      "probe-double-driven-resume",
      "probe-boundary-leak",
      "probe-residual-hiding",
    ]) {
      const row = rowOf(rowId);
      const verdict = deriveJourneyVerdict({ row, observation: journeyObservationFor(row) });
      expect(["JOURNEY-COMPLETED", "JOURNEY-FAILED"], rowId).toContain(verdict.verdict);
      if (verdict.verdict === "JOURNEY-FAILED") {
        // A FAILED verdict always NAMEs its failed criteria.
        expect(verdict.failedCriteria.length, rowId).toBeGreaterThan(0);
      } else {
        expect(verdict.failedCriteria, rowId).toEqual([]);
      }
    }
  });

  test("the verifier is deterministic (the same observation yields the identical criteria)", () => {
    for (const rowId of ["full-journey-recorded-portfolio", "probe-residual-hiding"]) {
      const row = rowOf(rowId);
      const observation = journeyObservationFor(row);
      const first = verifyCustomerJourneyIntegrity({ row, observation });
      const second = verifyCustomerJourneyIntegrity({ row, observation });
      expect(JSON.stringify(second), rowId).toBe(JSON.stringify(first));
    }
  });

  test("every evidence reference is digest-only (payload-free, never a price)", () => {
    for (const rowId of [
      "full-journey-recorded-portfolio",
      "journey-continuation-resume",
      "probe-dropped-stage",
      "probe-orphaned-state",
      "probe-double-driven-resume",
      "probe-boundary-leak",
      "probe-residual-hiding",
    ]) {
      const row = rowOf(rowId);
      const observation = journeyObservationFor(row);
      for (const criterion of verifyCustomerJourneyIntegrity({ row, observation })) {
        expect(criterion.evidence.length, `${rowId}/${criterion.criterionId}`).toBeGreaterThan(0);
        for (const entry of criterion.evidence) {
          // Short NAMED references only — never payload bytes (no
          // embedded JSON, no newlines, bounded length).
          expect(entry.length, `${rowId}/${criterion.criterionId}`).toBeLessThanOrEqual(200);
          expect(entry, `${rowId}/${criterion.criterionId}`).toMatch(/^[\x20-\x7e]*$/);
          expect(entry, `${rowId}/${criterion.criterionId}`).not.toContain("{");
        }
      }
      // The journey digest and the intent ids are payload-free forms.
      expect(observation.journeyDigest).toMatch(/^[0-9a-f]{8}$/);
      for (const intentId of observation.submittedIntents) {
        expect(intentId).toMatch(/^[a-z0-9:-]+#[a-z]+$/);
      }
    }
  });

  test("the intent id convention pins one intent per declared stage", () => {
    const row = rowOf(HONEST);
    expect(journeyIntentIdOf(row.rowId, "daily-usage")).toBe(`${row.rowId}:daily-usage#intent`);
    const observation = journeyObservationFor(row);
    expect(observation.submittedIntents).toEqual(
      row.stages.map((stage) => journeyIntentIdOf(row.rowId, stage.stage)),
    );
    expect(new Set(observation.submittedIntents).size).toBe(observation.submittedIntents.length);
  });
});
