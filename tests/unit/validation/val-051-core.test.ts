/**
 * VAL-051 acceptance criteria 4 and 6 (the mechanical verification
 * core + the discrimination battery): the pilot machinery — the
 * eight mechanical observation oracles over the deterministic
 * sustained-observation window.
 *
 *   * the oracles: window honesty, schedule completeness,
 *     continuation exactly-once, drift-classification honesty,
 *     incident honesty, budget-policy envelope integrity,
 *     end-of-window accounting reconciliation and customer-boundary
 *     integrity — each probed adversarially through the seven
 *     controlled fakes (a cherry-picked window, a dropped shift, a
 *     duplicated resume, a normalized drift, a hidden incident, a
 *     hidden residual, a boundary leak) PLUS the crafted
 *     discriminations beyond the probe vocabulary (an undeclared
 *     resume, an out-of-order schedule, a duplicated shift record, a
 *     misclassified drift, an unattributed drift, an undeclared and a
 *     misattributed incident, an unauthorized spend, a policy latency
 *     breach, a non-append-only ledger, a release mismatch, a
 *     cherry-picked DECLARED window);
 *   * the honest rows: all eight criteria PASS; the incident row
 *     resumes exactly once (two durable executions for the failed
 *     shift — never one, never three); the within-bounds, drifting
 *     and regressing rows classify their drift honestly;
 *   * the honest verdict vocabulary: PILOT-COMPLETED /
 *     PILOT-FAILED (with the failed criteria NAMED) — never a
 *     narrative;
 *   * the digest discipline: every evidence reference is digest-only
 *     (payload-free FNV-1a digests and short NAMED references — never
 *     payload bytes, never prices).
 */

import { describe, expect, test } from "vitest";
import { auditRowById } from "../../../benchmarks/validation/apps/economic-audit/corpus";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import type { PilotProbeKind } from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  CARRIED_AUDIT_ROW_IDS,
  DRIFT_BANDS,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_OBSERVATION_FAMILIES,
  PROBE_FAILED_CRITERIA_OF,
  pilotRowById,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import type { PilotObservation } from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  derivePilotVerdict,
  FOREIGN_APPLICATION_ID,
  honestDriftClassificationOf,
  pilotObservationFor,
  verifyProductionPilotIntegrity,
} from "../../../benchmarks/validation/apps/production-pilot/driver";

const HONEST = "full-window-recorded-basis";
const INCIDENT = "window-incident-resume";
const WITHIN = "window-drift-within-bounds";
const DRIFTING = "window-drift-declared";
const REGRESSING = "window-regression-declared";

const HONEST_ROW_IDS = [HONEST, INCIDENT, WITHIN, DRIFTING, REGRESSING];
const PROBE_ROW_IDS = [
  "probe-window-cherry-picking",
  "probe-dropped-shift",
  "probe-double-driven-resume",
  "probe-drift-normalizing",
  "probe-incident-hiding",
  "probe-residual-hiding",
  "probe-boundary-leak",
];

function rowOf(rowId: string) {
  const row = pilotRowById(rowId);
  if (row === null) {
    throw new Error(`no corpus row ${rowId}`);
  }
  return row;
}

function criteriaOf(rowId: string, probe?: PilotProbeKind) {
  const row = rowOf(rowId);
  const observation = pilotObservationFor(row, probe === undefined ? {} : { probe });
  return verifyProductionPilotIntegrity({ row, observation });
}

function evidenceOf(rowId: string, criterionId: string, probe?: PilotProbeKind): readonly string[] {
  const criterion = criteriaOf(rowId, probe).find(
    (candidate) => candidate.criterionId === criterionId,
  );
  if (criterion === undefined) {
    throw new Error(`no criterion ${criterionId} for ${rowId}`);
  }
  return criterion.evidence;
}

// ---------------------------------------------------------------------------
// The honest rows (all eight criteria PASS)
// ---------------------------------------------------------------------------

describe("VAL-051 the honest pilot rows verify all eight observation families", () => {
  test("the canonical sustained-observation window PASSes every criterion", () => {
    const criteria = criteriaOf(HONEST);
    expect(criteria.map((criterion) => criterion.criterionId)).toEqual([
      "window-honesty",
      "schedule-completeness",
      "continuation-exactly-once",
      "drift-classification-honesty",
      "incident-honesty",
      "budget-policy-envelope",
      "end-of-window-accounting",
      "customer-boundary",
    ]);
    for (const criterion of criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
      expect(criterion.strategy, criterion.criterionId).toBe("deterministic");
    }
    // The end-of-window accounting reconciles against the recorded
    // basis with zero residual, and the headroom reservations settle
    // with the released remainder NAMED.
    const accounting = evidenceOf(HONEST, "end-of-window-accounting");
    expect(accounting).toContain("recorded-basis:13500");
    expect(accounting).toContain("declared-drift-deltas:0");
    expect(accounting).toContain("observed-shift-sum:13500");
    expect(accounting).toContain("reported-window-total:13500");
    expect(accounting).toContain("cost-residual:0");
    expect(accounting).toContain("latency-residual:0");
    expect(accounting).toContain("reserved-total:14850");
    expect(accounting).toContain("released:1350");
    expect(accounting).toContain("release-residual:0");
    const envelope = evidenceOf(HONEST, "budget-policy-envelope");
    expect(envelope).toContain("budget:14850");
    expect(envelope).toContain("observed-total:13500");
    expect(envelope).toContain("ledger-entries:6");
    expect(envelope).toContain("ledger-append-only:true");
  });

  test("the incident row resumes exactly once (two durable executions for the failed shift)", () => {
    const criteria = criteriaOf(INCIDENT);
    for (const criterion of criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    const continuation = criteria.find(
      (criterion) => criterion.criterionId === "continuation-exactly-once",
    );
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("declared-incident:shift-4");
    expect(evidence).toContain("shift-4:executions=2,resumed=true");
    // The failed attempt's cost is never hidden: the recorded shift
    // economics carry the two driven attempts honestly.
    const accounting = criteria.find(
      (criterion) => criterion.criterionId === "end-of-window-accounting",
    );
    expect(accounting?.evidence).toContain("recorded-basis:23100");
    expect(accounting?.evidence).toContain("cost-residual:0");
    // The incident is recorded and attributed.
    const incident = criteria.find((criterion) => criterion.criterionId === "incident-honesty");
    expect(incident?.evidence).toContain("declared-incidents:1");
    expect(incident?.evidence).toContain("recorded-incidents:1");
    expect(incident?.evidence).toContain(
      "shift-4:incident=recorded,mechanism=recorded-failure-machinery",
    );
  });

  test("the drift rows classify honestly (within-bounds / drifting NAMED / regressing NAMED)", () => {
    // The within-bounds deviation stays inside the declared bands.
    const within = criteriaOf(WITHIN).find(
      (criterion) => criterion.criterionId === "drift-classification-honesty",
    );
    expect(within?.status).toBe("PASS");
    expect(within?.evidence.join(" ")).toContain("shift-2:classification=within-bounds");
    const withinAccounting = evidenceOf(WITHIN, "end-of-window-accounting");
    expect(withinAccounting).toContain("declared-drift-deltas:64");
    expect(withinAccounting).toContain("observed-shift-sum:13564");
    expect(withinAccounting).toContain("cost-residual:0");
    // The beyond-band deviation is classified DRIFTING with the
    // mechanism named, and its delta reconciles.
    const drifting = criteriaOf(DRIFTING).find(
      (criterion) => criterion.criterionId === "drift-classification-honesty",
    );
    expect(drifting?.status).toBe("PASS");
    expect(drifting?.evidence.join(" ")).toContain(
      "shift-4:classification=drifting,mechanism=provider-route-inefficiency",
    );
    const driftingAccounting = evidenceOf(DRIFTING, "end-of-window-accounting");
    expect(driftingAccounting).toContain("declared-drift-deltas:1152");
    expect(driftingAccounting).toContain("observed-shift-sum:14652");
    expect(driftingAccounting).toContain("cost-residual:0");
    // The below-floor quality is REPORTED AS REGRESSING with the
    // mechanism named (never silently normalized away).
    const regressing = criteriaOf(REGRESSING).find(
      (criterion) => criterion.criterionId === "drift-classification-honesty",
    );
    expect(regressing?.status).toBe("PASS");
    expect(regressing?.evidence.join(" ")).toContain(
      "shift-5:classification=regressing,mechanism=output-quality-degradation",
    );
    // The honest classification derivation is mechanical over the bands.
    expect(
      honestDriftClassificationOf({
        costDeltaMicroUsd: DRIFT_BANDS.costMicroUsd,
        latencyDeltaMs: 0,
        observedQuality: 0.98,
      }),
    ).toBe("within-bounds");
    expect(
      honestDriftClassificationOf({
        costDeltaMicroUsd: (BigInt(DRIFT_BANDS.costMicroUsd) + 1n).toString(),
        latencyDeltaMs: 0,
        observedQuality: 0.98,
      }),
    ).toBe("drifting");
    expect(
      honestDriftClassificationOf({
        costDeltaMicroUsd: "0",
        latencyDeltaMs: 0,
        observedQuality: DRIFT_BANDS.qualityFloor,
      }),
    ).toBe("within-bounds");
    expect(
      honestDriftClassificationOf({
        costDeltaMicroUsd: "0",
        latencyDeltaMs: 0,
        observedQuality: 0.72,
      }),
    ).toBe("regressing");
  });

  test("the honest observation's shift economics equal the recorded declarations plus the declared drift", () => {
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = pilotObservationFor(row);
      expect(
        observation.shifts.map((record) => [
          record.shiftId,
          record.observedCostMicroUsd,
          record.observedLatencyMs,
        ]),
        rowId,
      ).toEqual(
        row.schedule.map((shift) => {
          const drift = row.declaredDrift.find((entry) => entry.shiftIndex === shift.shiftIndex);
          const cost =
            BigInt(shift.economics.costMicroUsd) + BigInt(drift?.costDeltaMicroUsd ?? "0");
          const latency = shift.economics.latencyMs + (drift?.latencyDeltaMs ?? 0);
          return [shift.shiftId, cost.toString(), latency];
        }),
      );
      // The reported window total is the shift-for-shift sum.
      const costSum = observation.shifts
        .reduce((total, record) => total + BigInt(record.observedCostMicroUsd), 0n)
        .toString();
      expect(observation.reported.totalCostMicroUsd, rowId).toBe(costSum);
      // Every shift executes under the pilot's own customer identity.
      for (const record of observation.shifts) {
        expect(record.applicationId, `${rowId}/${record.shiftId}`).toBe(
          PILOT_CUSTOMER_APPLICATION_ID,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The discrimination battery (the seven controlled fakes — AC6)
// ---------------------------------------------------------------------------

describe("VAL-051 the discrimination battery (the controlled fakes each FAIL named)", () => {
  test("a cherry-picked window FAILs window-honesty with the omitted segment NAMED (and the missing cost NAMED)", () => {
    const criteria = criteriaOf(HONEST, "window-cherry-picking");
    expect(criteria.find((c) => c.criterionId === "window-honesty")?.status).toBe("FAIL");
    expect(evidenceOf(HONEST, "window-honesty", "window-cherry-picking")).toContain(
      "omitted-segment:shift-5",
    );
    expect(evidenceOf(HONEST, "window-honesty", "window-cherry-picking")).toContain(
      "observed-window:1-4",
    );
    // The omitted segment's recorded cost is the window-basis residual.
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(
      accounting?.evidence.some(
        (entry) =>
          entry.startsWith("window-basis-residual:400") && entry.includes("observed 13100"),
      ),
    ).toBe(true);
    // The schedule itself is complete inside the observed window —
    // the window oracle owns the cherry-pick, never double-counted.
    expect(criteria.find((c) => c.criterionId === "schedule-completeness")?.status).toBe("PASS");
  });

  test("a dropped shift FAILs schedule-completeness with the shift NAMED (and the missing cost NAMED)", () => {
    const criteria = criteriaOf(HONEST, "dropped-shift");
    expect(criteria.find((c) => c.criterionId === "schedule-completeness")?.status).toBe("FAIL");
    expect(evidenceOf(HONEST, "schedule-completeness", "dropped-shift")).toContain(
      "missing-shift:shift-4",
    );
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(
      accounting?.evidence.some(
        (entry) =>
          entry.startsWith("window-basis-residual:9600") && entry.includes("observed 3900"),
      ),
    ).toBe(true);
    // The window itself is honestly declared — the schedule oracle
    // owns the dropped shift.
    expect(criteria.find((c) => c.criterionId === "window-honesty")?.status).toBe("PASS");
  });

  test("a duplicated resume FAILs continuation-exactly-once with the shift and counts NAMED (and the unauthorized spend NAMED)", () => {
    const criteria = criteriaOf(INCIDENT, "double-driven-resume");
    const continuation = criteria.find((c) => c.criterionId === "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    expect(
      continuation?.evidence.some(
        (entry) =>
          entry.startsWith("resume-violation:shift-4") &&
          entry.includes("observed executions=3") &&
          entry.includes("exactly 2"),
      ),
    ).toBe(true);
    // The third drive spends beyond the shift's reservation — the
    // envelope oracle names the unauthorized spend.
    const envelope = criteria.find((c) => c.criterionId === "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    expect(envelope?.evidence).toContain(
      "unauthorized-spend:shift-4 (observed 28800 over reservation 19200)",
    );
    expect(envelope?.evidence.some((entry) => entry.startsWith("budget-exceeded"))).toBe(true);
    // The duplicated work's cost is never hidden: the accounting
    // oracle names the residual (three drives against the recorded two).
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("unexplained-residual:shift-4 (9600)");
  });

  test("a normalized drift FAILs drift-classification-honesty with the segment and mechanism NAMED (and the residual NAMED)", () => {
    const criteria = criteriaOf(DRIFTING, "drift-normalizing");
    const drift = criteria.find((c) => c.criterionId === "drift-classification-honesty");
    expect(drift?.status).toBe("FAIL");
    expect(
      drift?.evidence.some(
        (entry) =>
          entry.startsWith("normalized-drift:shift-4") &&
          entry.includes("cost delta 1152") &&
          entry.includes("reported within-bounds"),
      ),
    ).toBe(true);
    // The normalized delta is the unexplained residual the
    // accounting oracle names.
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("unexplained-residual:shift-4 (1152)");
    expect(accounting?.evidence).toContain("declared-drift-deltas:0");
    // The envelope still holds (the reservation covered the drift).
    expect(criteria.find((c) => c.criterionId === "budget-policy-envelope")?.status).toBe("PASS");
  });

  test("a hidden incident FAILs incident-honesty with the incident NAMED (only the incident oracle)", () => {
    const criteria = criteriaOf(INCIDENT, "incident-hiding");
    const incident = criteria.find((c) => c.criterionId === "incident-honesty");
    expect(incident?.status).toBe("FAIL");
    expect(incident?.evidence).toContain(
      "hidden-incident:shift-4 (resumed execution with no incident record)",
    );
    expect(incident?.evidence).toContain(
      "hidden-incident:shift-4 (declared incident never recorded)",
    );
    // The resume itself is exactly-once and the economics reconcile —
    // only the recording of the incident is dishonest.
    for (const criterion of criteria) {
      if (criterion.criterionId !== "incident-honesty") {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
  });

  test("a hidden residual FAILs end-of-window accounting with the exact residual NAMED (only the accounting oracle)", () => {
    const criteria = criteriaOf(HONEST, "residual-hiding");
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    // Half the daily-usage shift's observed cost (4800 of 9600) is
    // hidden from the reported window total — the residual is NAMED.
    expect(accounting?.evidence).toContain("observed-shift-sum:13500");
    expect(accounting?.evidence).toContain("reported-window-total:8700");
    expect(accounting?.evidence).toContain("cost-residual:-4800");
    for (const criterion of criteria) {
      if (criterion.criterionId !== "end-of-window-accounting") {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
  });

  test("a boundary leak FAILs customer-boundary with the shift and foreign identity NAMED (only the boundary oracle)", () => {
    const criteria = criteriaOf(HONEST, "boundary-leak");
    const boundary = criteria.find((c) => c.criterionId === "customer-boundary");
    expect(boundary?.status).toBe("FAIL");
    expect(
      boundary?.evidence.some(
        (entry) =>
          entry.startsWith("boundary-leak:shift-4") &&
          entry.includes(FOREIGN_APPLICATION_ID) &&
          entry.includes(PILOT_CUSTOMER_APPLICATION_ID),
      ),
    ).toBe(true);
    for (const criterion of criteria) {
      if (criterion.criterionId !== "customer-boundary") {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
  });

  test("every probe's derived verdict matches the pinned failed-criteria vocabulary exactly", () => {
    const probes: readonly { readonly probe: PilotProbeKind; readonly rowId: string }[] = [
      { probe: "window-cherry-picking", rowId: HONEST },
      { probe: "dropped-shift", rowId: HONEST },
      { probe: "double-driven-resume", rowId: INCIDENT },
      { probe: "drift-normalizing", rowId: DRIFTING },
      { probe: "incident-hiding", rowId: INCIDENT },
      { probe: "residual-hiding", rowId: HONEST },
      { probe: "boundary-leak", rowId: HONEST },
    ];
    for (const { probe, rowId } of probes) {
      const row = rowOf(rowId);
      const verdict = derivePilotVerdict({ row, observation: pilotObservationFor(row, { probe }) });
      expect(verdict.verdict, probe).toBe("PILOT-FAILED");
      expect([...verdict.failedCriteria].sort(), probe).toEqual(
        [...PROBE_FAILED_CRITERIA_OF[probe]].sort(),
      );
    }
    // The seven probe rows declare the same pinned vocabulary.
    for (const rowId of PROBE_ROW_IDS) {
      const row = rowOf(rowId);
      const probeKind = row.probe?.kind;
      expect(probeKind, rowId).toBeDefined();
      const verdict = derivePilotVerdict({ row, observation: pilotObservationFor(row) });
      expect(verdict.verdict, rowId).toBe("PILOT-FAILED");
      expect([...verdict.failedCriteria].sort(), rowId).toEqual(
        [...row.expected.failedCriteria].sort(),
      );
      expect([...row.expected.failedCriteria].sort(), rowId).toEqual(
        [...PROBE_FAILED_CRITERIA_OF[probeKind as PilotProbeKind]].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The crafted discriminations (beyond the probe vocabulary)
// ---------------------------------------------------------------------------

describe("VAL-051 the crafted discriminations", () => {
  /** Craft one observation over a row with a mutation applied. */
  function craft(
    mutate: (observation: PilotObservation) => PilotObservation,
    rowId: string = HONEST,
  ): PilotObservation {
    return mutate(pilotObservationFor(rowOf(rowId)));
  }

  test("an UNDECLARED resume FAILs continuation-exactly-once NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: base.shifts.map((record) =>
        record.shiftIndex === 5 ? { ...record, executions: 2, resumed: true } : record,
      ),
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const continuation = criteria.find((c) => c.criterionId === "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    expect(
      continuation?.evidence.some((entry) => entry.startsWith("resume-violation:shift-5")),
    ).toBe(true);
  });

  test("an out-of-order schedule FAILs schedule-completeness with the divergence NAMED", () => {
    const observation = craft((base) => {
      const shifts = [...base.shifts];
      const removed = shifts.splice(2, 1); // shift-3 removed
      const third = removed[0];
      if (third === undefined) {
        throw new Error("the honest window holds no shift-3");
      }
      shifts.splice(3, 0, third); // re-inserted AFTER shift-4 (out of order)
      return { ...base, shifts };
    });
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const completeness = criteria.find((c) => c.criterionId === "schedule-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence).toContain("shift-order-divergence");
    expect(completeness?.evidence).not.toContain("missing-shift:shift-4");
  });

  test("a duplicated shift record FAILs schedule-completeness with the duplication NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: [...base.shifts, base.shifts[4] as (typeof base.shifts)[number]],
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const completeness = criteria.find((c) => c.criterionId === "schedule-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence).toContain("duplicated-shift-record");
  });

  test("an over-classified drift FAILs drift-classification-honesty NAMED (crying wolf is dishonest too)", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: base.shifts.map((record) =>
        record.shiftIndex === 2
          ? {
              ...record,
              drift: { ...record.drift, classification: "drifting", mechanism: "invented" },
            }
          : record,
      ),
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const drift = criteria.find((c) => c.criterionId === "drift-classification-honesty");
    expect(drift?.status).toBe("FAIL");
    expect(drift?.evidence).toContain(
      "misclassified-drift:shift-2 (honest within-bounds, reported drifting)",
    );
  });

  test("an unattributed drift FAILs drift-classification-honesty with the mechanism demand NAMED", () => {
    const observation = craft(
      (base) => ({
        ...base,
        shifts: base.shifts.map((record) =>
          record.shiftIndex === 4
            ? { ...record, drift: { ...record.drift, mechanism: null } }
            : record,
        ),
      }),
      DRIFTING,
    );
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(DRIFTING), observation });
    const drift = criteria.find((c) => c.criterionId === "drift-classification-honesty");
    expect(drift?.status).toBe("FAIL");
    expect(drift?.evidence).toContain(
      "unattributed-drift:shift-4 (drifting with no mechanism named)",
    );
  });

  test("an undeclared incident entry FAILs incident-honesty NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      incidentLog: [
        ...base.incidentLog,
        {
          shiftIndex: 3,
          shiftId: "shift-3",
          kind: "shift-failure-resume",
          mechanism: "invented",
          detail: "never-declared",
        },
      ],
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const incident = criteria.find((c) => c.criterionId === "incident-honesty");
    expect(incident?.status).toBe("FAIL");
    expect(incident?.evidence).toContain("undeclared-incident:shift-3");
  });

  test("a misattributed incident FAILs incident-honesty with the declared mechanism NAMED", () => {
    const observation = craft(
      (base) => ({
        ...base,
        incidentLog: base.incidentLog.map((entry) =>
          entry.shiftIndex === 4 ? { ...entry, mechanism: "wrong-machinery" } : entry,
        ),
      }),
      INCIDENT,
    );
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(INCIDENT), observation });
    const incident = criteria.find((c) => c.criterionId === "incident-honesty");
    expect(incident?.status).toBe("FAIL");
    expect(
      incident?.evidence.some((entry) => entry.startsWith("misattributed-incident:shift-4")),
    ).toBe(true);
  });

  test("an unauthorized spend FAILs budget-policy-envelope with the shift and amount NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: base.shifts.map((record) =>
        record.shiftIndex === 2 ? { ...record, observedCostMicroUsd: "881" } : record,
      ),
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const envelope = criteria.find((c) => c.criterionId === "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    expect(envelope?.evidence).toContain(
      "unauthorized-spend:shift-2 (observed 881 over reservation 880)",
    );
    // The accounting oracle names the same dishonesty as a residual.
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("unexplained-residual:shift-2 (81)");
  });

  test("a policy latency breach FAILs budget-policy-envelope with the shift and latency NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: base.shifts.map((record) =>
        record.shiftIndex === 2 ? { ...record, observedLatencyMs: 61 } : record,
      ),
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const envelope = criteria.find((c) => c.criterionId === "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    expect(envelope?.evidence).toContain(
      "policy-latency-breach:shift-2 (observed 61 over policy 60)",
    );
  });

  test("a non-append-only ledger FAILs budget-policy-envelope NAMED", () => {
    const observation = craft((base) => ({
      ...base,
      ledger: base.ledger.map((entry, index) => (index === 2 ? { ...entry, sequence: 1 } : entry)),
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const envelope = criteria.find((c) => c.criterionId === "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    expect(envelope?.evidence.some((entry) => entry.startsWith("ledger-not-append-only"))).toBe(
      true,
    );
  });

  test("a release-entry mismatch FAILs budget-policy-envelope NAMED (reservations must settle)", () => {
    const observation = craft((base) => ({
      ...base,
      ledger: base.ledger.map((entry) =>
        entry.kind === "release" ? { ...entry, amountMicroUsd: "999" } : entry,
      ),
      reported: { ...base.reported, releasedMicroUsd: "999" },
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    const envelope = criteria.find((c) => c.criterionId === "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    expect(envelope?.evidence.some((entry) => entry.startsWith("release-entry-mismatch"))).toBe(
      true,
    );
    // The accounting oracle names the release residual too.
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence).toContain("release-residual:-351");
  });

  test("a cherry-picked DECLARED window FAILs window-honesty NAMED (the declaration itself lies)", () => {
    const row = { ...rowOf(HONEST), window: { startShift: 1, endShift: 4 } };
    const observation = pilotObservationFor(row);
    const criteria = verifyProductionPilotIntegrity({ row, observation });
    const windowHonesty = criteria.find((c) => c.criterionId === "window-honesty");
    expect(windowHonesty?.status).toBe("FAIL");
    expect(windowHonesty?.evidence).toContain("cherry-picked-declared-window");
    // The window-basis residual names the omitted segment's cost.
    const accounting = criteria.find((c) => c.criterionId === "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(
      accounting?.evidence.some((entry) => entry.startsWith("window-basis-residual:400")),
    ).toBe(true);
  });

  test("a missing observation member (no shifts at all) FAILs the families with work to judge", () => {
    const observation = craft((base) => ({
      ...base,
      shifts: [],
      driftReport: [],
      incidentLog: [],
      ledger: [{ sequence: 1, kind: "release" as const, shiftId: null, amountMicroUsd: "0" }],
      reported: {
        totalCostMicroUsd: "0",
        totalLatencyMs: 0,
        reservedTotalMicroUsd: "0",
        releasedMicroUsd: "0",
      },
    }));
    const criteria = verifyProductionPilotIntegrity({ row: rowOf(HONEST), observation });
    // The completeness oracle names EVERY missing shift; the
    // accounting oracle names the full missing-cost residual.
    for (const criterionId of ["schedule-completeness", "end-of-window-accounting"]) {
      expect(criteria.find((c) => c.criterionId === criterionId)?.status, criterionId).toBe("FAIL");
    }
    const completeness = criteria.find((c) => c.criterionId === "schedule-completeness");
    expect(completeness?.evidence.join(" ")).toContain(
      "missing-shift:shift-1,shift-2,shift-3,shift-4,shift-5",
    );
    // The continuation, drift, incident and boundary oracles are
    // vacuously satisfied over an empty observation (the missing
    // shifts are the schedule oracle's catch, never double-counted).
    for (const criterionId of [
      "continuation-exactly-once",
      "drift-classification-honesty",
      "incident-honesty",
      "customer-boundary",
    ]) {
      expect(criteria.find((c) => c.criterionId === criterionId)?.status, criterionId).toBe("PASS");
    }
    const verdict = derivePilotVerdict({ row: rowOf(HONEST), observation });
    expect(verdict.verdict).toBe("PILOT-FAILED");
    expect([...verdict.failedCriteria].sort()).toEqual([
      "end-of-window-accounting",
      "schedule-completeness",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The honest verdict vocabulary + the digest discipline
// ---------------------------------------------------------------------------

describe("VAL-051 the honest verdict vocabulary + the digest discipline", () => {
  test("the verdict vocabulary is the declared vocabulary only (never a narrative)", () => {
    for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
      const row = rowOf(rowId);
      const verdict = derivePilotVerdict({ row, observation: pilotObservationFor(row) });
      expect(["PILOT-COMPLETED", "PILOT-FAILED"], rowId).toContain(verdict.verdict);
      if (verdict.verdict === "PILOT-FAILED") {
        // A FAILED verdict always NAMEs its failed criteria.
        expect(verdict.failedCriteria.length, rowId).toBeGreaterThan(0);
        for (const criterionId of verdict.failedCriteria) {
          expect(PILOT_OBSERVATION_FAMILIES, rowId).toContain(criterionId);
        }
      } else {
        expect(verdict.failedCriteria, rowId).toEqual([]);
      }
    }
  });

  test("the verifier is deterministic (the same observation yields the identical criteria)", () => {
    for (const rowId of [HONEST, "probe-residual-hiding", "probe-double-driven-resume"]) {
      const row = rowOf(rowId);
      const observation = pilotObservationFor(row);
      const first = verifyProductionPilotIntegrity({ row, observation });
      const second = verifyProductionPilotIntegrity({ row, observation });
      expect(JSON.stringify(second), rowId).toBe(JSON.stringify(first));
    }
  });

  test("every evidence reference is digest-only (payload-free, never a price)", () => {
    for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
      const row = rowOf(rowId);
      const observation = pilotObservationFor(row);
      for (const criterion of verifyProductionPilotIntegrity({ row, observation })) {
        expect(criterion.evidence.length, `${rowId}/${criterion.criterionId}`).toBeGreaterThan(0);
        for (const entry of criterion.evidence) {
          // Short NAMED references only — never payload bytes (no
          // embedded JSON, no newlines, bounded length).
          expect(entry.length, `${rowId}/${criterion.criterionId}`).toBeLessThanOrEqual(220);
          expect(entry, `${rowId}/${criterion.criterionId}`).toMatch(/^[\x20-\x7e]*$/);
          expect(entry, `${rowId}/${criterion.criterionId}`).not.toContain("{");
        }
      }
      // The window digest is a payload-free FNV-1a form.
      expect(observation.windowDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("the recorded basis anchors re-derive over VAL-049's audited rows (the chained basis)", () => {
    expect(CARRIED_AUDIT_ROW_IDS.length).toBe(5);
    for (const auditRowId of CARRIED_AUDIT_ROW_IDS) {
      const auditRow = auditRowById(auditRowId);
      expect(auditRow, auditRowId).not.toBeNull();
      const recomputed = economicDigestOf({
        workOrder: "VAL-049",
        auditRowId: auditRow?.rowId,
        recordedDigests: auditRow?.evidence.map((reference) => reference.recordedDigest),
      });
      for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
        for (const shift of rowOf(rowId).schedule) {
          if (shift.economics.basisAuditRowId === auditRowId) {
            expect(shift.economics.basisDigest, `${rowId}/${shift.shiftId}`).toBe(recomputed);
            expect(shift.economics.basisDigest).toMatch(/^[0-9a-f]{8}$/);
          }
        }
      }
    }
    // A drifted (unknown) audit anchor is unrepresentable.
    expect(auditRowById("no-such-audit-row")).toBeNull();
  });
});
