/**
 * VAL-051 acceptance criterion 6 — the discrimination battery: the
 * production-pilot window families against the issued probe set and
 * the controlled fakes.
 *
 * Every family the work order names is probed adversarially at the
 * THREE levels the plan's §6.3 pins:
 *
 *   * the DERIVATION-LEVEL CATCH — the PURE oracle over the mutated
 *     window record with the NAMED evidence asserted VERBATIM (the
 *     cherry-picked sub-window with its omitted shifts named, the
 *     double-driven resume with its attempt count, the normalized
 *     drift with its segment AND mechanism, the hidden residual with
 *     its exact amount, the foreign identity with its shift and
 *     identity, the dangling reservation and the off-ledger spend,
 *     the re-priced recorded input with both sides named);
 *   * the ROW-LEVEL CATCH — the probe ROW driven over the LEAKY
 *     STACK (the fixture stack's own window-feed lane,
 *     `pilotWindowFeedFor` / `applyPilotProbeVariant`) settling
 *     PILOT-FAILED with EXACTLY its pinned NAMED criteria;
 *   * the HONEST CONTROL — the contrast pair: the unmutated feed of
 *     the same machinery PASSing the same oracle (the declared
 *     window observed whole, the exactly-once resume, the
 *     drifting-named and regressing-reported rows, the zero-residual
 *     window, the settled append-only envelope).
 *
 * Plus the mechanical-verdict vocabulary (PILOT-COMPLETED /
 * PILOT-FAILED / NOT-RUN each DERIVED, never claimed), the
 * pure-derivation discipline (the re-measurement ban: a re-priced
 * recorded input FAILs NAMED with both sides), the digest discipline
 * (per-field discriminating, order discriminating, payload-bytes
 * boundary), the live-boundary honesty (the offline fake world
 * REFUSES the live rail; the honest NOT RUN shape), and the honest
 * controls over the leaky fixture stack (the full honest corpus
 * PASSES, the full probe corpus FAILs, the fabrication knobs each
 * fire their NAMED criterion, and the REAL accounting rails seal the
 * leaky-stack runs digest-stably).
 */

import { describe, expect, test } from "vitest";
import { FOREIGN_APPLICATION_ID } from "../../benchmarks/validation/apps/customer-journey/driver";
import type { PilotProbeKind } from "../../benchmarks/validation/apps/production-pilot/corpus";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_CORPUS_ROWS,
  type PilotCorpusRow,
  PROBE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  PROBE_MECHANISM_OF,
  pilotRowById,
  pilotRowResultFor,
  pilotWindowRecordFor,
  taskBodyFor,
} from "../../benchmarks/validation/apps/production-pilot/corpus";
import {
  createWindowLedger,
  deriveBudgetPolicyEnvelopeIntegrity,
  deriveContinuationExactlyOnce,
  deriveCustomerBoundaryIntegrity,
  deriveDriftClassificationHonesty,
  deriveEndOfWindowReconciliation,
  deriveIncidentHonesty,
  deriveScheduleCompleteness,
  deriveWindowHonesty,
  drivePilotRow,
  incidentLogDigestOf,
  type LedgerLine,
  ledgerBasisDigestOf,
  ledgerChainHolds,
  livePilotPlanDigestOf,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_VERDICT_KINDS,
  type PilotWindowObservation,
  pilotWindowDigestOf,
  reservationsOf,
  scheduleDigestOf,
  windowRecordDigestOf,
} from "../../benchmarks/validation/apps/production-pilot/driver";
import {
  applyPilotProbeVariant,
  createPilotFakeApiWorld,
  createRealAccountingRails,
  createTickClock,
  doubleDriveResumeInWindowRecord,
  hideIncidentInWindowRecord,
  hideResidualInWindowRecord,
  leakBoundaryInWindowRecord,
  normalizeDriftClaimsInWindowRecord,
  omitShiftsFromWindowRecord,
  PILOT_FAKE_LIVE_RAIL_REFUSAL,
  pilotWindowFeedFor,
  recordedJourneyReplayFor,
} from "../../benchmarks/validation/apps/production-pilot/fixtures";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { AttributionClass } from "../../benchmarks/validation/platform/failure-attribution";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

// ---------------------------------------------------------------------------
// The pinned rows + the numerically pinned arithmetic (the recorded basis)
// ---------------------------------------------------------------------------

const FULL_ROW_ID = "pilot-window-full-recorded-portfolio";
const CONT_ROW_ID = "pilot-shift-resume-exactly-once";
const DRIFT_ROW_ID = "pilot-drift-drifting-named";
const REGR_ROW_ID = "pilot-drift-regressing-reported";
const INCIDENT_ROW_ID = "pilot-incident-recorded-attributed";
const TIGHT_ROW_ID = "pilot-budget-reservations-settled";
const LIVE_ROW_ID = "live-pilot-real-window-slice";

/** The six honest offline rows (always drivable, zero credentials). */
const HONEST_ROW_IDS = [
  FULL_ROW_ID,
  CONT_ROW_ID,
  DRIFT_ROW_ID,
  REGR_ROW_ID,
  INCIDENT_ROW_ID,
  TIGHT_ROW_ID,
];

/**
 * The recorded journey-stage economics (the VAL-050 corpus's own pins —
 * the pilot's carried cost basis, never re-priced): onboarding 1200,
 * intent 800, plan 1500, daily-usage 9600, outcome 400 microUsd.
 */
const PORTFOLIO_SHIFT_COST = "13500"; // the Σ of the five recorded stages
const FULL_WINDOW_COST = "81000"; // 6 × 13500 (the tight row's exact budget)
const CONTINUATION_STAGE_RECORDED_COST = "19200"; // daily-usage's TWO recorded attempts
const DOUBLE_DRIVEN_STAGE_COST = "28800"; // 19200 + the third attempt's 9600
const DOUBLE_DRIVEN_RESIDUAL = "9600";
const DRIFTING_STAGE_OBSERVED_COST = "12000"; // 9600 + the declared 2400 delta
const DECLARED_DRIFT_DELTA = "2400";
const HIDDEN_REGRESSION_STAGE_COST = "12480"; // 9600 × 1.30
const HIDDEN_REGRESSION_RESIDUAL = "2880";
const HIDDEN_RESIDUAL = "1200"; // shift 1's onboarding stage cost
const RESIDUAL_HIDING_REPORTED_TOTAL = "79800"; // 81000 - 1200
const FAILED_ATTEMPT_COST = "9600"; // 19200 / 2 — the failed attempt's per-attempt cost

/** The load-shaping divergence cause (the drifting row's NAMED mechanism). */
const LOAD_SHAPING_COHORT_MIX = "load-shaping cohort mix";

/** The pinned FNV-1a digests (the pins of record, 8 hex each). */
const FULL_WINDOW_DIGEST = "6e84c0f3";
const WIDENED_TOLERANCE_WINDOW_DIGEST = "8f5d26fc"; // driftTolerancePct 11 — never widened post-hoc
const FULL_SCHEDULE_DIGEST = "4c0abe8c";
const FULL_WINDOW_RECORD_DIGEST = "d6dd6827";
const INCIDENT_ROW_LOG_DIGEST = "800266f4";
const REVERSED_LOG_DIGEST = "8489ebdc"; // the log's append order matters
const LIVE_WINDOW_DIGEST = "23d499b7";
const LIVE_SCHEDULE_DIGEST = "1704c257";
const LIVE_PLAN_DIGEST = "7ba51da0";

// ---------------------------------------------------------------------------
// The lookup/drive helpers (throwing lookups — a missing row is a test bug)
// ---------------------------------------------------------------------------

function rowOf(rowId: string): PilotCorpusRow {
  const row = pilotRowById(rowId);
  if (row === null) {
    throw new Error(`the pilot corpus holds no row ${rowId}`);
  }
  return row;
}

/** The row's derivation-level window record (the offline observation lane). */
function observationOf(rowId: string): PilotWindowObservation {
  const observation = pilotWindowRecordFor(rowOf(rowId));
  if (observation === null) {
    throw new Error(`row ${rowId} derives no offline window record`);
  }
  return observation;
}

/**
 * The row's LEAKY-STACK window feed: `pilotWindowFeedFor` — the honest
 * record, the row's own declared probe corruption, or any FORCED probe
 * knob applied onto the honest record (the battery's controlled fake).
 */
function feedOf(rowId: string, probe?: PilotProbeKind): PilotWindowObservation {
  const row = rowOf(rowId);
  const feed = pilotWindowFeedFor(row, probe === undefined ? {} : { probe });
  if (feed === null) {
    throw new Error(`row ${rowId} serves no offline window feed`);
  }
  return feed;
}

/** Drive one row's window record through the row driver (the 8-criteria synthesis). */
function driveOf(
  rowId: string,
  observation: PilotWindowObservation,
): ReturnType<typeof drivePilotRow> {
  const row = rowOf(rowId);
  return drivePilotRow({
    rowId: row.rowId,
    window: row.window,
    schedule: row.schedule,
    policy: row.operatingProfile,
    observation,
  });
}

/** One criterion of a driven result (throwing lookup). */
function criterionOf(
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  criterionId: string,
): LabVerificationCriterion {
  const criterion = result.criteria.find((candidate) => candidate.criterionId === criterionId);
  if (criterion === undefined) {
    throw new Error(`the driven result holds no ${criterionId} criterion`);
  }
  return criterion;
}

/** The evidence lines of one criterion of a driven result. */
function evidenceOf(
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  criterionId: string,
): readonly string[] {
  return criterionOf(result, criterionId).evidence;
}

/** Build a correctly-chained ledger over the observation's shifts, minus named shapes. */
function writerLedgerFor(
  rowId: string,
  observation: PilotWindowObservation,
  options: {
    /** Shifts whose reservations are left HELD (reserved + spent, never settled). */
    readonly danglingShifts?: readonly number[];
    /** Shifts that never enter the ledger at all (off-ledger spends). */
    readonly offLedgerShifts?: readonly number[];
  },
): readonly LedgerLine[] {
  const row = rowOf(rowId);
  const writer = createWindowLedger(row.operatingProfile);
  for (const shift of observation.shifts) {
    if ((options.offLedgerShifts ?? []).includes(shift.shift)) {
      continue;
    }
    const reservationId = `pilot-resv-${row.rowId}-shift${shift.shift}`;
    writer.reserve({
      shift: shift.shift,
      reservationId,
      amountMicroUsd: shift.reportedCostMicroUsd,
    });
    writer.spend({ reservationId, amountMicroUsd: shift.reportedCostMicroUsd });
    if (!(options.danglingShifts ?? []).includes(shift.shift)) {
      writer.settle({ reservationId, settledMicroUsd: shift.reportedCostMicroUsd });
    }
  }
  return writer.lines();
}

// ---------------------------------------------------------------------------
// 1 — cherry-picked-window (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the cherry-picked window (window honesty)", () => {
  test("the cherry-picked sub-window NAMED (the omitted shifts named)", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The derivation-level catch: the window record DROPS the two
    // anomalous shifts — the window-honesty oracle FAILs with the
    // omitted shifts and the cherry-picked sub-window NAMED verbatim.
    const cherryPicked = omitShiftsFromWindowRecord(full, observation, [4, 5]);
    const honesty = deriveWindowHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: cherryPicked,
    });
    expect(honesty.criterionId).toBe("window-honesty");
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain("declared-window:shifts 6 over span 0..5");
    expect(honesty.evidence).toContain("schedule-shifts:0..5");
    expect(honesty.evidence).toContain("observed-shifts:0..3");
    expect(honesty.evidence).toContain("omitted-shift:4..5");
    expect(honesty.evidence).toContain("cherry-picked-sub-window:shifts 0..3 of 0..5");
    // The sibling completeness oracle co-fires with the missed shifts NAMED.
    const completeness = deriveScheduleCompleteness({
      schedule: full.schedule,
      observation: cherryPicked,
    });
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain("missed-shift:4");
    expect(completeness.evidence).toContain("missed-shift:5");
    // The forced-probe lane never invents a new corruption shape: the
    // forced knob and the direct transform produce the SAME record.
    const forced = applyPilotProbeVariant(full, observation, "cherry-picked-window");
    expect(forced.windowDigest).toBe(cherryPicked.windowDigest);
    expect(forced.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 3]);
  });

  test("the post-hoc extension NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // A FABRICATED seventh shift appended to the window record (the
    // post-hoc extension): the window-honesty oracle FAILs with the
    // extension NAMED verbatim — the declared window is the fixity
    // anchor, and nothing observed outside it ever passes.
    const appended = observation.shifts[5];
    if (appended === undefined) {
      throw new Error("the full window record holds no shift 5 to clone");
    }
    const extended: PilotWindowObservation = {
      ...observation,
      shifts: [
        ...observation.shifts,
        {
          shift: 6,
          journeyRowId: appended.journeyRowId,
          segments: appended.segments.map((segment) => ({ ...segment, shift: 6 })),
          reportedCostMicroUsd: appended.reportedCostMicroUsd,
          reportedLatencyMs: appended.reportedLatencyMs,
        },
      ],
      reported: { totalCostMicroUsd: "94500", totalLatencyMs: 2800 },
    };
    const honesty = deriveWindowHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: extended,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain("observed-shifts:0..6");
    expect(honesty.evidence).toContain(
      "post-hoc-extension:shift 6 (observed outside the declared window)",
    );
    // The schedule-completeness oracle names the undeclared shift too.
    const completeness = deriveScheduleCompleteness({
      schedule: full.schedule,
      observation: extended,
    });
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain("undeclared-shift:6 (never scheduled)");
    expect(completeness.evidence).toContain("observed-shift-count:7");
  });

  test("the row-level catch over the leaky stack", () => {
    // The probe ROW (the issued corruption declared 1:1) driven over
    // the leaky stack's own window feed settles PILOT-FAILED with
    // EXACTLY its pinned NAMED criteria — window-honesty first.
    const row = rowOf("probe-pilot-cherry-picked-window");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf(
      "probe-pilot-cherry-picked-window",
      observation as PilotWindowObservation,
    );
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["cherry-picked-window"]);
    expect(result.failedCriteria).toEqual([
      "window-honesty",
      "schedule-completeness",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf(result, "window-honesty")).toContain("omitted-shift:4..5");
    expect(evidenceOf(result, "window-honesty")).toContain(
      "cherry-picked-sub-window:shifts 0..3 of 0..5",
    );
    // The reconciliation co-FAILs with the unexplained pilot-level
    // residual NAMED (both sides, the exact amount).
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      "missing-shift-basis:shift 4 (recorded basis 13500microUsd never observed — the window's accounting is short and the residual is unexplained)",
    );
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      "missing-shift-basis:shift 5 (recorded basis 13500microUsd never observed — the window's accounting is short and the residual is unexplained)",
    );
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      "pilot-level-residual:observed 54000microUsd vs recorded basis 81000microUsd (residual -27000microUsd — UNEXPLAINED, the exact amount named, both sides named)",
    );
    expect(PROBE_MECHANISM_OF["cherry-picked-window"]).toContain(
      "cherry-picked-sub-window + omitted-shift:4..5",
    );
  });

  test("the honest control (the declared window observed whole)", () => {
    // The contrast pair: the SAME machinery's unmutated feed observes
    // the declared window WHOLE — the window-honesty oracle PASSes with
    // every declared shift observed over the declared span.
    const result = driveOf(FULL_ROW_ID, observationOf(FULL_ROW_ID));
    expect(result.terminal).toBe("PILOT-COMPLETED");
    const honesty = criterionOf(result, "window-honesty");
    expect(honesty.status).toBe("PASS");
    expect(honesty.evidence).toContain("declared-window:shifts 6 over span 0..5");
    expect(honesty.evidence).toContain("schedule-shifts:0..5");
    expect(honesty.evidence).toContain("observed-shifts:0..5");
    for (const line of honesty.evidence) {
      expect(line).not.toMatch(/^(omitted-shift|cherry-picked-sub-window|post-hoc-extension)/);
    }
    // Every honest row observes its declared window whole.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      const control = deriveWindowHonesty({
        window: row.window,
        schedule: row.schedule,
        observation,
      });
      expect(control.status, rowId).toBe("PASS");
      expect(
        observation.shifts.map((shift) => shift.shift),
        rowId,
      ).toEqual(row.schedule.shifts.map((shift) => shift.shift));
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — dropped-shift (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the dropped shift (schedule completeness)", () => {
  test("the missed shift NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The derivation-level catch: the window record OMITS the
    // mid-window scheduled shift — the schedule-completeness oracle
    // FAILs with the missed shift NAMED verbatim, and the window
    // honesty oracle names the omitted shift and the sub-window.
    const dropped = omitShiftsFromWindowRecord(full, observation, [3]);
    const completeness = deriveScheduleCompleteness({
      schedule: full.schedule,
      observation: dropped,
    });
    expect(completeness.criterionId).toBe("schedule-completeness");
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain("scheduled-shifts:0..5");
    expect(completeness.evidence).toContain("observed-shifts:0..2,4..5");
    expect(completeness.evidence).toContain("scheduled-shift-count:6");
    expect(completeness.evidence).toContain("observed-shift-count:5");
    expect(completeness.evidence).toContain("missed-shift:3");
    const honesty = deriveWindowHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: dropped,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain("omitted-shift:3");
    expect(honesty.evidence).toContain("cherry-picked-sub-window:shifts 0..2,4..5 of 0..5");
  });

  test("the row-level catch over the leaky stack", () => {
    const row = rowOf("probe-pilot-dropped-shift");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf("probe-pilot-dropped-shift", observation as PilotWindowObservation);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["dropped-shift"]);
    expect(result.failedCriteria).toEqual([
      "window-honesty",
      "schedule-completeness",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf(result, "schedule-completeness")).toContain("missed-shift:3");
    expect(evidenceOf(result, "window-honesty")).toContain("omitted-shift:3");
    // The dropped shift's recorded basis is the unexplained residual.
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      "missing-shift-basis:shift 3 (recorded basis 13500microUsd never observed — the window's accounting is short and the residual is unexplained)",
    );
    expect(PROBE_MECHANISM_OF["dropped-shift"]).toContain("missed-shift:3");
  });

  test("the honest control (every scheduled shift lands exactly once)", () => {
    // The contrast pair: the unmutated feed lands every scheduled
    // shift EXACTLY ONCE — no missed, duplicated, undeclared or
    // substituted shift anywhere in the honest corpus.
    const result = driveOf(FULL_ROW_ID, observationOf(FULL_ROW_ID));
    const completeness = criterionOf(result, "schedule-completeness");
    expect(completeness.status).toBe("PASS");
    expect(completeness.evidence).toContain("scheduled-shift-count:6");
    expect(completeness.evidence).toContain("observed-shift-count:6");
    for (const line of completeness.evidence) {
      expect(line).not.toMatch(
        /^(missed-shift|duplicated-shift|undeclared-shift|workload-substitution)/,
      );
    }
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      const control = deriveScheduleCompleteness({
        schedule: row.schedule,
        observation,
      });
      expect(control.status, rowId).toBe("PASS");
      // Every observed shift replays its OWN declared recorded workload.
      for (const observed of observation.shifts) {
        const scheduled = row.schedule.shifts.find(
          (candidate) => candidate.shift === observed.shift,
        );
        expect(scheduled, `${rowId}/shift${observed.shift}`).toBeDefined();
        expect(observed.journeyRowId, `${rowId}/shift${observed.shift}`).toBe(
          scheduled?.journeyRowId,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — double-driven-resume (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the double-driven resume (continuation exactly-once)", () => {
  test("the duplicated resume NAMED (the attempt count)", () => {
    const cont = rowOf(CONT_ROW_ID);
    const observation = observationOf(CONT_ROW_ID);
    // The derivation-level catch: the declared failure shift's resume
    // is driven TWICE — three attempts for the failed stage where the
    // recorded basis holds exactly two. The continuation-exactly-once
    // oracle FAILs with the duplicated resume NAMED, both by the
    // attempt count and the resume ledger's count.
    const doubleDriven = doubleDriveResumeInWindowRecord(cont, observation);
    const continuation = deriveContinuationExactlyOnce({
      schedule: cont.schedule,
      observation: doubleDriven,
    });
    expect(continuation.criterionId).toBe("continuation-exactly-once");
    expect(continuation.status).toBe("FAIL");
    expect(continuation.evidence).toContain("declared-failure-shifts:shift 3 daily-usage");
    expect(continuation.evidence).toContain("shift 3 daily-usage:attempts=3,declared=2");
    expect(continuation.evidence).toContain(
      "double-driven-resume:shift 3 daily-usage (attempts=3, expected exactly 2 — the resume was driven 2 times)",
    );
    expect(continuation.evidence).toContain(
      "double-driven-resume:shift 3 daily-usage (resumes=2, expected exactly 1)",
    );
    // The third attempt's cost is carried HONESTLY in the record
    // (28800microUsd over the recorded 19200) — never hidden, always
    // named by the reconciliation's unexplained residual.
    const failedStage = doubleDriven.shifts
      .find((shift) => shift.shift === 3)
      ?.segments.find((segment) => segment.stage === "daily-usage");
    expect(failedStage?.attempts).toBe(3);
    expect(failedStage?.costMicroUsd).toBe(DOUBLE_DRIVEN_STAGE_COST);
    const resumeRecord = doubleDriven.continuations.find(
      (record) => record.shift === 3 && record.stage === "daily-usage",
    );
    expect(resumeRecord?.resumes).toBe(2);
    expect(resumeRecord?.failedAttemptCostMicroUsd).toBe(FAILED_ATTEMPT_COST);
  });

  test("the row-level catch over the leaky stack", () => {
    const row = rowOf("probe-pilot-double-driven-resume");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf(
      "probe-pilot-double-driven-resume",
      observation as PilotWindowObservation,
    );
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["double-driven-resume"]);
    expect(result.failedCriteria).toEqual([
      "continuation-exactly-once",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf(result, "continuation-exactly-once")).toContain(
      "double-driven-resume:shift 3 daily-usage (attempts=3, expected exactly 2 — the resume was driven 2 times)",
    );
    expect(evidenceOf(result, "continuation-exactly-once")).toContain(
      "double-driven-resume:shift 3 daily-usage (resumes=2, expected exactly 1)",
    );
    // The third attempt's cost FAILs the reconciliation NAMED with
    // both sides (28800 observed over the 19200 recorded basis).
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      `unexplained-stage-residual:shift 3 daily-usage (observed ${DOUBLE_DRIVEN_STAGE_COST}microUsd, recorded ${CONTINUATION_STAGE_RECORDED_COST}microUsd, residual ${DOUBLE_DRIVEN_RESIDUAL}microUsd beyond the declared tolerance 10% with no declared divergence — both sides named)`,
    );
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      `pilot-level-residual:observed 100200microUsd vs recorded basis 90600microUsd (residual ${DOUBLE_DRIVEN_RESIDUAL}microUsd — UNEXPLAINED, the exact amount named, both sides named)`,
    );
    expect(PROBE_MECHANISM_OF["double-driven-resume"]).toContain("double-driven-resume");
  });

  test("the honest control (the exactly-once resume row)", () => {
    // The contrast pair: the continuation row's unmutated feed resumes
    // EXACTLY ONCE — the failed stage lands exactly its TWO recorded
    // attempts, the continuation ledger records ONE resume with the
    // failed attempt's cost carried honestly, and the row COMPLETES.
    const observation = observationOf(CONT_ROW_ID);
    const result = driveOf(CONT_ROW_ID, observation);
    expect(result.terminal).toBe("PILOT-COMPLETED");
    const continuation = criterionOf(result, "continuation-exactly-once");
    expect(continuation.status).toBe("PASS");
    expect(continuation.evidence).toContain("continuation-records:1");
    expect(continuation.evidence).toContain("shift 3 daily-usage:attempts=2,declared=2");
    for (const line of continuation.evidence) {
      expect(line).not.toMatch(
        /^(double-driven-resume|dropped-resume|undeclared-resume|dropped-attempts|missing-|duplicated-|undeclared-continuation)/,
      );
    }
    const resumeRecord = observation.continuations.find(
      (record) => record.shift === 3 && record.stage === "daily-usage",
    );
    expect(resumeRecord).toBeDefined();
    expect(resumeRecord?.resumes).toBe(1);
    expect(resumeRecord?.failedAttemptCostMicroUsd).toBe(FAILED_ATTEMPT_COST);
    expect(resumeRecord?.resumeExecutionId).toBe(
      "pilot-resume-pilot-shift-resume-exactly-once-shift3-daily-usage",
    );
  });
});

// ---------------------------------------------------------------------------
// 4 — drift-normalizing (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the drift normalization (drift classification honesty)", () => {
  test("the normalized drift NAMED (segment AND mechanism)", () => {
    const drift = rowOf(DRIFT_ROW_ID);
    const observation = observationOf(DRIFT_ROW_ID);
    // The derivation-level catch: the record still carries the real
    // drifted economics while the claim says within-declared-bounds —
    // FAILs NAMED with the segment AND the mechanism (the derived
    // drifting cause) AND the drifted dimensions with their percentages.
    const normalized = normalizeDriftClaimsInWindowRecord(drift, observation);
    const honesty = deriveDriftClassificationHonesty({
      window: drift.window,
      schedule: drift.schedule,
      observation: normalized,
    });
    expect(honesty.criterionId).toBe("drift-classification-honesty");
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      `normalized-drift:shift 4 daily-usage (claimed within-declared-bounds, derived drifting via ${LOAD_SHAPING_COHORT_MIX} — economics 25%, latency 0%, resolved-quality 0% beyond tolerance 10%)`,
    );
    // The mechanism must be NAMED even in the claim: normalizing also
    // strips the declared divergence cause — a second NAMED catch.
    expect(honesty.evidence).toContain(
      `unnamed-drift-mechanism:shift 4 daily-usage (claimed mechanism none, the declared divergence cause is ${LOAD_SHAPING_COHORT_MIX})`,
    );
    // The honest control direction: the UNMUTATED claim of the same
    // row PASSes (claimed == derived, mechanically).
    const control = deriveDriftClassificationHonesty({
      window: drift.window,
      schedule: drift.schedule,
      observation,
    });
    expect(control.status).toBe("PASS");
  });

  test("the hidden regression NAMED (regressing claimed within-bounds)", () => {
    const regr = rowOf(REGR_ROW_ID);
    const observation = observationOf(REGR_ROW_ID);
    // The hidden-regression shape: shift 5's resolved-quality collapse
    // derives REgressing, but the normalized claim says
    // within-declared-bounds — FAILs NAMED with the segment, the
    // drifted dimensions and the absence of a declared divergence.
    const normalized = normalizeDriftClaimsInWindowRecord(regr, observation);
    const honesty = deriveDriftClassificationHonesty({
      window: regr.window,
      schedule: regr.schedule,
      observation: normalized,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      "hidden-regression:shift 5 daily-usage (claimed within-declared-bounds, derived regressing — economics 0%, latency 0%, resolved-quality 100% beyond tolerance 10%, no declared divergence)",
    );
    // The record still carries the real collapsed economics (one
    // attempt, none resolved) — the lie is in the claim, never in the
    // facts, and the oracle re-derives the facts.
    const collapsed = normalized.shifts
      .find((shift) => shift.shift === 5)
      ?.segments.find((segment) => segment.stage === "daily-usage");
    expect(collapsed?.attempts).toBe(1);
    expect(collapsed?.resolved).toBe(0);
  });

  test("the row-level catch over the leaky stack", () => {
    const row = rowOf("probe-pilot-drift-normalizing");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf("probe-pilot-drift-normalizing", observation as PilotWindowObservation);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["drift-normalizing"]);
    expect(result.failedCriteria).toEqual([
      "drift-classification-honesty",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf(result, "drift-classification-honesty")).toContain(
      `hidden-regression:shift 5 daily-usage (claimed within-declared-bounds, derived regressing — economics 30%, latency 0%, resolved-quality 0% beyond tolerance 10%, no declared divergence)`,
    );
    // The real drifted economics are still carried (12480 over the
    // recorded 9600) — the 2880 residual co-FAILs the reconciliation.
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      `unexplained-stage-residual:shift 5 daily-usage (observed ${HIDDEN_REGRESSION_STAGE_COST}microUsd, recorded 9600microUsd, residual ${HIDDEN_REGRESSION_RESIDUAL}microUsd beyond the declared tolerance 10% with no declared divergence — both sides named)`,
    );
    expect(PROBE_MECHANISM_OF["drift-normalizing"]).toContain("hidden-regression");
  });

  test("the honest control (drifting-named + regressing-reported both honest)", () => {
    // The contrast pair: BOTH honest drift rows COMPLETED with their
    // findings NAMED in the criteria's own evidence — the drifting row
    // drifts WITH its mechanism named, the regressing row is reported
    // AS regressing (never normalized, never hidden).
    const driftResult = driveOf(DRIFT_ROW_ID, observationOf(DRIFT_ROW_ID));
    expect(driftResult.terminal).toBe("PILOT-COMPLETED");
    expect(criterionOf(driftResult, "drift-classification-honesty").status).toBe("PASS");
    expect(evidenceOf(driftResult, "drift-classification-honesty")).toContain(
      `derived:shift 4 daily-usage → drifting via ${LOAD_SHAPING_COHORT_MIX} (economics 25%, latency 0%, resolved-quality 0%)`,
    );
    // The declared divergence is carried as the honest delta (the
    // basis reconciles exactly where declared).
    expect(evidenceOf(driftResult, "end-of-window-reconciliation")).toContain(
      `declared-delta:shift 4 daily-usage (observed ${DRIFTING_STAGE_OBSERVED_COST}microUsd, recorded 9600microUsd, delta ${DECLARED_DRIFT_DELTA}microUsd via ${LOAD_SHAPING_COHORT_MIX} — the declared divergence carried as the honest delta)`,
    );
    const regrResult = driveOf(REGR_ROW_ID, observationOf(REGR_ROW_ID));
    expect(regrResult.terminal).toBe("PILOT-COMPLETED");
    expect(criterionOf(regrResult, "drift-classification-honesty").status).toBe("PASS");
    expect(evidenceOf(regrResult, "drift-classification-honesty")).toContain(
      "derived:shift 5 daily-usage → regressing (economics 0%, latency 0%, resolved-quality 100%)",
    );
    // The pinned findings agree with the derived ones (both rows).
    expect(rowOf(DRIFT_ROW_ID).expected.driftFindings).toEqual([
      {
        shift: 4,
        stage: "daily-usage",
        classification: "drifting",
        mechanism: LOAD_SHAPING_COHORT_MIX,
      },
    ]);
    expect(rowOf(REGR_ROW_ID).expected.driftFindings).toEqual([
      { shift: 5, stage: "daily-usage", classification: "regressing", mechanism: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5 — incident-hiding (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the incident hiding (incident capture + attribution)", () => {
  test("the hidden incident NAMED", () => {
    const cont = rowOf(CONT_ROW_ID);
    const observation = observationOf(CONT_ROW_ID);
    // The derivation-level catch: the incident log OMITS the declared
    // failure's incident — the timeline still holds the event (the
    // unresolved attempt and the exactly-once resume) and BOTH
    // hidden-incident catches fire, NAMED verbatim.
    const hidden = hideIncidentInWindowRecord(cont, observation, 3);
    const honesty = deriveIncidentHonesty({ observation: hidden });
    expect(honesty.criterionId).toBe("incident-honesty");
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain("incident-log:0 record(s)");
    expect(honesty.evidence).toContain(
      "hidden-incident:shift 3 daily-usage (attempts=2, resolved=1 — the timeline holds 1 unresolved attempt(s), the log omits the incident)",
    );
    expect(honesty.evidence).toContain(
      "hidden-incident:shift 3 daily-usage (the timeline holds the declared failure and its exactly-once resume, the log omits the incident)",
    );
    // The hiding lane also hides the failed attempt's cost from the
    // shift's reported total — the reconciliation co-FAILs NAMED.
    const reconciliation = deriveEndOfWindowReconciliation({
      window: cont.window,
      schedule: cont.schedule,
      observation: hidden,
    });
    expect(reconciliation.status).toBe("FAIL");
    expect(reconciliation.evidence).toContain(
      "shift-total-residual:shift 3 (stage sum 23100microUsd, recorded shift total 13500microUsd, residual 9600microUsd — both sides named)",
    );
  });

  test("the unattributed-incident shape NAMED", () => {
    const observation = observationOf(CONT_ROW_ID);
    // An UNATTRIBUTED incident (no root-cause class) FAILs NAMED —
    // every incident is attributed through the IMPORTED VAL-020
    // taxonomy, never free-text, never silent.
    const unattributed: PilotWindowObservation = {
      ...observation,
      incidents: observation.incidents.map((record) => ({
        ...record,
        attributionClass: "" as AttributionClass,
      })),
    };
    const unattributedResult = deriveIncidentHonesty({ observation: unattributed });
    expect(unattributedResult.status).toBe("FAIL");
    expect(unattributedResult.evidence).toContain(
      "unattributed-incident:shift 3 daily-usage (no root-cause class — every incident is attributed through the imported VAL-020 taxonomy)",
    );
    // A TAXONOMY-FOREIGN class FAILs NAMED with the foreign class.
    const foreign: PilotWindowObservation = {
      ...observation,
      incidents: observation.incidents.map((record) => ({
        ...record,
        attributionClass: "not-a-real-class" as AttributionClass,
      })),
    };
    const foreignResult = deriveIncidentHonesty({ observation: foreign });
    expect(foreignResult.status).toBe("FAIL");
    expect(foreignResult.evidence).toContain(
      "taxonomy-foreign-attribution:shift 3 daily-usage (class not-a-real-class is foreign to the imported VAL-020 taxonomy)",
    );
  });

  test("the honest control (recorded AND attributed)", () => {
    // The contrast pair: the incident row's unmutated feed records
    // EVERY incident AND attributes each through the imported
    // taxonomy with its disposition honoring the retryability
    // discipline — the log is digest-sealed, the row COMPLETES.
    const observation = observationOf(INCIDENT_ROW_ID);
    const result = driveOf(INCIDENT_ROW_ID, observation);
    expect(result.terminal).toBe("PILOT-COMPLETED");
    const honesty = criterionOf(result, "incident-honesty");
    expect(honesty.status).toBe("PASS");
    expect(honesty.evidence).toContain("incident-log:2 record(s)");
    expect(honesty.evidence).toContain(`incident-log-digest:${INCIDENT_ROW_LOG_DIGEST}`);
    expect(honesty.evidence).toContain(
      "incident:shift 2 daily-usage (provider-unavailable@provider, magnitude 9600microUsd, bounded-retry)",
    );
    expect(honesty.evidence).toContain(
      "incident:shift 4 plan (tool-failure@tool, magnitude 1500microUsd, escalated)",
    );
    for (const line of honesty.evidence) {
      expect(line).not.toMatch(
        /^(hidden-incident|unattributed-incident|taxonomy-foreign|invalid-disposition|malformed-incident)/,
      );
    }
    // Every honest row's incidents are recorded AND attributed.
    for (const rowId of HONEST_ROW_IDS) {
      const control = deriveIncidentHonesty({ observation: observationOf(rowId) });
      expect(control.status, rowId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// 6 — residual-hiding (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the residual hiding (end-of-window reconciliation)", () => {
  test("the hidden residual NAMED (the exact amount)", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The derivation-level catch: every stage record and every
    // per-shift total stays honest, only the window total lies — the
    // reconciliation oracle FAILs with the EXACT unexplained amount
    // NAMED (both sides named: the reported total, the observed Σ).
    const hidden = hideResidualInWindowRecord(full, observation, 1, "onboarding");
    const reconciliation = deriveEndOfWindowReconciliation({
      window: full.window,
      schedule: full.schedule,
      observation: hidden,
    });
    expect(reconciliation.criterionId).toBe("end-of-window-reconciliation");
    expect(reconciliation.status).toBe("FAIL");
    expect(reconciliation.evidence).toContain(
      `window-total-residual:reported ${RESIDUAL_HIDING_REPORTED_TOTAL}microUsd, observed Σ shifts ${FULL_WINDOW_COST}microUsd, residual -${HIDDEN_RESIDUAL}microUsd — both sides named)`,
    );
    // The stage records stay honest — only the reported total lies.
    const shift1 = hidden.shifts.find((shift) => shift.shift === 1);
    const onboarding = shift1?.segments.find((segment) => segment.stage === "onboarding");
    expect(onboarding?.costMicroUsd).toBe(HIDDEN_RESIDUAL);
    expect(shift1?.reportedCostMicroUsd).toBe(PORTFOLIO_SHIFT_COST);
  });

  test("the row-level catch over the leaky stack", () => {
    const row = rowOf("probe-pilot-residual-hiding");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf("probe-pilot-residual-hiding", observation as PilotWindowObservation);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["residual-hiding"]);
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      `window-total-residual:reported ${RESIDUAL_HIDING_REPORTED_TOTAL}microUsd, observed Σ shifts ${FULL_WINDOW_COST}microUsd, residual -${HIDDEN_RESIDUAL}microUsd — both sides named)`,
    );
    // The stage-level accounting stays honest (the pilot-level
    // residual is 0 — the lie is window-level only).
    expect(evidenceOf(result, "end-of-window-reconciliation")).toContain(
      `pilot-level-residual:observed ${FULL_WINDOW_COST}microUsd vs recorded basis ${FULL_WINDOW_COST}microUsd (residual 0microUsd — explained: the within-tolerance residuals and declared deltas carried above)`,
    );
    expect(PROBE_MECHANISM_OF["residual-hiding"]).toContain("window-total-residual");
  });

  test("the honest control (the zero-residual window)", () => {
    // The contrast pair: the unmutated feed's window total equals the
    // Σ of its shifts and the observed stage totals equal the recorded
    // basis — ZERO unexplained residual, the row COMPLETES.
    const observation = observationOf(FULL_ROW_ID);
    const result = driveOf(FULL_ROW_ID, observation);
    expect(result.terminal).toBe("PILOT-COMPLETED");
    const reconciliation = criterionOf(result, "end-of-window-reconciliation");
    expect(reconciliation.status).toBe("PASS");
    expect(reconciliation.evidence).toContain(
      `pilot-level-residual:observed ${FULL_WINDOW_COST}microUsd vs recorded basis ${FULL_WINDOW_COST}microUsd (residual 0microUsd — explained: the within-tolerance residuals and declared deltas carried above)`,
    );
    for (const line of reconciliation.evidence) {
      expect(line).not.toMatch(
        /^(unexplained-|window-total-residual|window-latency-residual|shift-total-residual|shift-latency-residual|missing-shift-basis|off-basis-segment|malformed-)/,
      );
    }
    expect(observation.reported.totalCostMicroUsd).toBe(FULL_WINDOW_COST);
    // Every honest row reconciles with zero unexplained residual.
    for (const rowId of HONEST_ROW_IDS) {
      const control = deriveEndOfWindowReconciliation({
        window: rowOf(rowId).window,
        schedule: rowOf(rowId).schedule,
        observation: observationOf(rowId),
      });
      expect(control.status, rowId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// 7 — boundary-leak (the issued probe 1:1)
// ---------------------------------------------------------------------------

describe("discrimination: the boundary leak (customer boundary integrity)", () => {
  test("the foreign-identity shift NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The derivation-level catch: one shift's every stage executes
    // under the journey corpus's FOREIGN application identity (the
    // imported leak shape — never re-declared free-text) — the
    // customer-boundary oracle FAILs with EVERY leaking stage NAMED
    // with the shift and the foreign identity.
    const leaked = leakBoundaryInWindowRecord(full, observation, 4);
    const boundary = deriveCustomerBoundaryIntegrity({ observation: leaked });
    expect(boundary.criterionId).toBe("customer-boundary-integrity");
    expect(boundary.status).toBe("FAIL");
    expect(boundary.evidence).toContain(`pilot-application:${PILOT_CUSTOMER_APPLICATION_ID}`);
    expect(boundary.evidence).toContain("observed-segments:30");
    for (const stage of ["onboarding", "intent", "plan", "daily-usage", "outcome"]) {
      expect(boundary.evidence).toContain(
        `foreign-application:shift 4 ${stage} (executed under ${FOREIGN_APPLICATION_ID}, not ${PILOT_CUSTOMER_APPLICATION_ID} — a cross-tenant leak across the window)`,
      );
    }
    // Only shift 4 leaks — the other five shifts stay under the
    // pilot's own identity (the catch is surgical, never blanket).
    expect(
      boundary.evidence.filter((line) => line.startsWith("foreign-application:shift ")).length,
    ).toBe(5);
  });

  test("the row-level catch over the leaky stack", () => {
    const row = rowOf("probe-pilot-boundary-leak");
    const observation = pilotWindowFeedFor(row);
    expect(observation).not.toBeNull();
    const result = driveOf("probe-pilot-boundary-leak", observation as PilotWindowObservation);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(PROBE_FAILED_CRITERIA_OF["boundary-leak"]);
    expect(evidenceOf(result, "customer-boundary-integrity")).toContain(
      `foreign-application:shift 4 onboarding (executed under ${FOREIGN_APPLICATION_ID}, not ${PILOT_CUSTOMER_APPLICATION_ID} — a cross-tenant leak across the window)`,
    );
    expect(PROBE_MECHANISM_OF["boundary-leak"]).toContain("foreign-application");
  });

  test("the honest control (every stage under the pilot's own identity)", () => {
    // The contrast pair: the unmutated feed holds the customer
    // boundary at EVERY stage of EVERY shift of EVERY honest window.
    const observation = observationOf(FULL_ROW_ID);
    const result = driveOf(FULL_ROW_ID, observation);
    const boundary = criterionOf(result, "customer-boundary-integrity");
    expect(boundary.status).toBe("PASS");
    expect(boundary.evidence).toContain(
      `boundary-held:every stage of every shift of the window under ${PILOT_CUSTOMER_APPLICATION_ID}`,
    );
    for (const rowId of HONEST_ROW_IDS) {
      for (const shift of observationOf(rowId).shifts) {
        for (const segment of shift.segments) {
          expect(segment.applicationId, `${rowId}/shift${shift.shift}/${segment.stage}`).toBe(
            PILOT_CUSTOMER_APPLICATION_ID,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — budget-envelope dishonesty (the window-wide envelope)
// ---------------------------------------------------------------------------

describe("discrimination: the budget-envelope dishonesty (the window-wide envelope)", () => {
  test("a dangling reservation NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // A reservation left HELD at end-of-window (reserved + spent but
    // never settled) — the chain itself still holds (the lines are
    // writer-built, correctly chained); the catch is the envelope
    // discipline: the dangling reservation FAILs NAMED with the
    // reservation, the shift and the held amount.
    const danglingLedger = writerLedgerFor(FULL_ROW_ID, observation, { danglingShifts: [0] });
    const envelope = deriveBudgetPolicyEnvelopeIntegrity({
      policy: full.operatingProfile,
      observation: { ...observation, ledger: danglingLedger },
    });
    expect(envelope.criterionId).toBe("budget-policy-envelope");
    expect(envelope.status).toBe("FAIL");
    expect(envelope.evidence).toContain(
      "dangling-reservation:pilot-resv-pilot-window-full-recorded-portfolio-shift0 (shift 0, 13500microUsd still held at end-of-window — every reservation settles or releases)",
    );
    // The chain holds — the dangling catch is the ONLY problem.
    expect(
      ledgerChainHolds({
        lines: danglingLedger,
        basis: ledgerBasisDigestOf(full.operatingProfile),
      }),
    ).toEqual({ holds: true, breakOrdinal: null });
    expect(
      envelope.evidence.filter((line) => line.startsWith("dangling-reservation:")).length,
    ).toBe(1);
    expect(envelope.evidence).not.toContain("ledger-chain-broken");
    expect(
      envelope.evidence.some((line) => line.startsWith("off-ledger-spend")),
      "the dangling shape never co-fires the off-ledger catch",
    ).toBe(false);
  });

  test("an off-ledger spend NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // An OFF-LEDGER spend: the observed shift's cost never entered the
    // ledger (no reservation ever opened for the shift) — every other
    // line stays writer-honest, the chain holds, and the envelope
    // catch is NAMED with the shift and the observed amount.
    const offLedgerLedger = writerLedgerFor(FULL_ROW_ID, observation, { offLedgerShifts: [2] });
    const envelope = deriveBudgetPolicyEnvelopeIntegrity({
      policy: full.operatingProfile,
      observation: { ...observation, ledger: offLedgerLedger },
    });
    expect(envelope.status).toBe("FAIL");
    expect(envelope.evidence).toContain(
      "off-ledger-spend:shift 2 (observed cost 13500microUsd with no reservation ever opened for the shift — the window envelope never authorized it)",
    );
    // The chain holds and nothing dangles — the off-ledger catch is
    // the only problem (the spent total is short by the shift's cost).
    expect(
      ledgerChainHolds({
        lines: offLedgerLedger,
        basis: ledgerBasisDigestOf(full.operatingProfile),
      }),
    ).toEqual({ holds: true, breakOrdinal: null });
    expect(envelope.evidence).toContain("total-spent-microUsd:67500");
    expect(envelope.evidence).not.toContain("dangling-reservation:");
    expect(envelope.evidence).not.toContain("ledger-chain-broken");
    // The honest writer never writes either shape: an unauthorized
    // spend THROWS (the writer authorizes nothing that was never
    // reserved).
    const writer = createWindowLedger(full.operatingProfile);
    expect(() => writer.spend({ reservationId: "never-opened", amountMicroUsd: "1" })).toThrow(
      /no reservation never-opened/,
    );
  });

  test("the honest control (settled + append-only, tamper caught at NAMED ordinals)", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The contrast pair: the tight-envelope row settles EVERY
    // reservation exactly on its zero-headroom budget, the chain
    // holds, and the tamper disciplines catch erased/rewritten/
    // reordered lines at their NAMED ordinals.
    const tightResult = driveOf(TIGHT_ROW_ID, observationOf(TIGHT_ROW_ID));
    expect(criterionOf(tightResult, "budget-policy-envelope").status).toBe("PASS");
    expect(evidenceOf(tightResult, "budget-policy-envelope")).toContain(
      "cost-budget-microUsd:81000",
    );
    expect(evidenceOf(tightResult, "budget-policy-envelope")).toContain(
      "admission-policy:admit-within-budget",
    );
    expect(evidenceOf(tightResult, "budget-policy-envelope")).toContain(
      "total-spent-microUsd:81000",
    );
    const tightObservation = observationOf(TIGHT_ROW_ID);
    expect(
      reservationsOf(tightObservation.ledger).filter(
        (reservation) => reservation.state === "settled",
      ),
    ).toHaveLength(6);
    expect(
      ledgerChainHolds({
        lines: tightObservation.ledger,
        basis: ledgerBasisDigestOf(rowOf(TIGHT_ROW_ID).operatingProfile),
      }),
    ).toEqual({ holds: true, breakOrdinal: null });
    // TAMPER 1 — an ERASED line (ordinal 2 removed): the chain breaks
    // at the NAMED ordinal (the first line after the gap).
    const basis = ledgerBasisDigestOf(full.operatingProfile);
    const lines = observation.ledger;
    const erased = lines.filter((line) => line.ordinal !== 2);
    expect(ledgerChainHolds({ lines: erased, basis })).toEqual({ holds: false, breakOrdinal: 3 });
    // TAMPER 2 — a REWRITTEN line (ordinal 3's amount edited without
    // recomputing its digest).
    const rewritten = lines.map((line) =>
      line.ordinal === 3 ? { ...line, amountMicroUsd: "999" } : line,
    );
    expect(ledgerChainHolds({ lines: rewritten, basis })).toEqual({
      holds: false,
      breakOrdinal: 3,
    });
    // TAMPER 3 — REORDERED lines (ordinals 2 and 3 swapped).
    const reordered = [...lines];
    const swap = reordered[1];
    const swapWith = reordered[2];
    if (swap === undefined || swapWith === undefined) {
      throw new Error("the full row's ledger holds no lines 2..3 to swap");
    }
    reordered[1] = swapWith;
    reordered[2] = swap;
    expect(ledgerChainHolds({ lines: reordered, basis })).toEqual({
      holds: false,
      breakOrdinal: 3,
    });
    // Each tamper drives the envelope oracle to FAIL with the break
    // NAMED at its ordinal.
    for (const tampered of [erased, rewritten, reordered]) {
      const tamperedResult = deriveBudgetPolicyEnvelopeIntegrity({
        policy: full.operatingProfile,
        observation: { ...observation, ledger: tampered },
      });
      expect(tamperedResult.status).toBe("FAIL");
      expect(tamperedResult.evidence).toContain(
        "ledger-chain-broken:ordinal 3 (the append-only digest chain breaks here — an erased, rewritten or reordered line)",
      );
    }
    // Every honest row's envelope holds.
    for (const rowId of HONEST_ROW_IDS) {
      const control = criterionOf(driveOf(rowId, observationOf(rowId)), "budget-policy-envelope");
      expect(control.status, rowId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// 9 — the mechanical verdict vocabulary over controlled shapes
// ---------------------------------------------------------------------------

describe("discrimination: the mechanical verdict vocabulary over controlled shapes", () => {
  test("PILOT-COMPLETED derived, never claimed", () => {
    // The vocabulary is the pinned three-word ladder of record.
    expect(PILOT_VERDICT_KINDS).toEqual(["PILOT-COMPLETED", "PILOT-FAILED", "NOT-RUN"]);
    // The honest shape DERIVES PILOT-COMPLETED: all EIGHT criteria
    // PASS, the failed-criteria list is empty, and the digests pin.
    const result = driveOf(FULL_ROW_ID, observationOf(FULL_ROW_ID));
    expect(result.terminal).toBe("PILOT-COMPLETED");
    expect(result.criteria).toHaveLength(8);
    expect(result.failedCriteria).toEqual([]);
    expect(result.notRun).toBe(false);
    expect(result.reason).toBeNull();
    for (const criterion of result.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    expect(result.windowDigest).toBe(FULL_WINDOW_DIGEST);
    expect(result.scheduleDigest).toBe(FULL_SCHEDULE_DIGEST);
    // NEVER CLAIMED: the corpus's own pinned verdict equals the
    // DERIVED one for every honest row (the pin is produced by
    // RUNNING the engine at module load — a wishful pin THROWS).
    for (const rowId of HONEST_ROW_IDS) {
      expect(pilotRowResultFor(rowOf(rowId)).terminal, rowId).toBe("PILOT-COMPLETED");
      expect(pilotRowResultFor(rowOf(rowId)).terminal, rowId).toBe(rowOf(rowId).expected.verdict);
    }
  });

  test("PILOT-FAILED derived, never claimed (the FAILing criteria NAMED)", () => {
    // The probe shape DERIVES PILOT-FAILED with its FAILing criteria
    // NAMED — for ALL seven issued probes, exactly the pinned list.
    for (const row of PROBE_CORPUS_ROWS) {
      const result = pilotRowResultFor(row);
      expect(result.terminal, row.rowId).toBe("PILOT-FAILED");
      expect(result.failedCriteria, row.rowId).toEqual(
        PROBE_FAILED_CRITERIA_OF[row.probe?.kind ?? "cherry-picked-window"],
      );
      expect(result.failedCriteria, row.rowId).toEqual(row.expected.failedCriteria);
      expect(result.notRun, row.rowId).toBe(false);
      // The app-level terminal never claims COMPLETED over a probe.
      expect(row.expected.terminal, row.rowId).toBe("FAILED");
    }
    // The verdict follows the OBSERVATION, never the claim: forcing
    // one probe knob onto the HONEST row flips its derived verdict
    // from PILOT-COMPLETED to PILOT-FAILED over the same declared
    // window (nothing about the row's declaration changed).
    const flipped = driveOf(FULL_ROW_ID, feedOf(FULL_ROW_ID, "boundary-leak"));
    expect(flipped.terminal).toBe("PILOT-FAILED");
    expect(flipped.failedCriteria).toEqual(["customer-boundary-integrity"]);
    expect(flipped.windowDigest).toBe(FULL_WINDOW_DIGEST);
  });

  test("NOT-RUN derived, never claimed (the env var NAMED)", () => {
    // The live row's closed gate DERIVES NOT-RUN — one honest
    // live-gate-honesty criterion, the env var NAMED in the gate and
    // the reason, never a fabricated success.
    const live = rowOf(LIVE_ROW_ID);
    const result = pilotRowResultFor(live);
    expect(result.terminal).toBe("NOT-RUN");
    expect(result.notRun).toBe(true);
    expect(result.failedCriteria).toEqual([]);
    expect(result.reason).toBe(
      "live gate closed (OPENROUTER_API_KEY absent — the live pilot slice honestly NOT RUN, never a fake success)",
    );
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]).toMatchObject({
      criterionId: "live-gate-honesty",
      strategy: "deterministic",
      status: "PASS",
    });
    expect(result.criteria[0]?.evidence).toContain("gate:OPENROUTER_API_KEY");
    // A row with NO observation and NO live gate is honestly not run
    // too — the reason names the absent observation, never invents one.
    const noGate = drivePilotRow({
      rowId: "discrimination-no-observation",
      window: live.window,
      schedule: live.schedule,
      policy: live.operatingProfile,
      observation: null,
    });
    expect(noGate.terminal).toBe("NOT-RUN");
    expect(noGate.reason).toBe(
      "no observation recorded (the row never ran — honestly NOT RUN, never a fake success)",
    );
    expect(noGate.criteria[0]?.evidence).toContain("gate:none");
    // The gate is honest, not decorative: closed without the
    // credential (or with an empty one), open with it.
    expect(liveGateOpen(live, {})).toBe(false);
    expect(liveGateOpen(live, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(live, { OPENROUTER_API_KEY: "test-key" })).toBe(true);
    // Exactly ONE live row in the corpus — the only NOT-RUN shape.
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    expect(PILOT_CORPUS_ROWS.filter((row) => row.liveGate !== undefined)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10 — the pure-derivation discipline (the re-measurement ban)
// ---------------------------------------------------------------------------

describe("discrimination: the pure-derivation discipline (the re-measurement ban)", () => {
  test("a re-measurement trace NAMED (a recorded input re-priced in the observation lane)", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // A re-priced recorded input (shift 2's plan stage re-driven at
    // 3000microUsd over the recorded 1500 — the totals recomputed
    // consistently, exactly what an honest re-measurement lane would
    // report): the ban is enforced MECHANICALLY — the re-priced stage
    // leaves an UNEXPLAINED residual FAILing the reconciliation with
    // BOTH sides named, and the claimed within-bounds classification
    // over the re-priced segment becomes a NAMED hidden regression.
    const rePriced: PilotWindowObservation = {
      ...observation,
      shifts: observation.shifts.map((shift) =>
        shift.shift === 2
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "plan" ? { ...segment, costMicroUsd: "3000" } : segment,
              ),
              reportedCostMicroUsd: "15000",
            }
          : shift,
      ),
      reported: { ...observation.reported, totalCostMicroUsd: "82500" },
    };
    const reconciliation = deriveEndOfWindowReconciliation({
      window: full.window,
      schedule: full.schedule,
      observation: rePriced,
    });
    expect(reconciliation.status).toBe("FAIL");
    expect(reconciliation.evidence).toContain(
      "unexplained-stage-residual:shift 2 plan (observed 3000microUsd, recorded 1500microUsd, residual 1500microUsd beyond the declared tolerance 10% with no declared divergence — both sides named)",
    );
    expect(reconciliation.evidence).toContain(
      "pilot-level-residual:observed 82500microUsd vs recorded basis 81000microUsd (residual 1500microUsd — UNEXPLAINED, the exact amount named, both sides named)",
    );
    const honesty = deriveDriftClassificationHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: rePriced,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      "hidden-regression:shift 2 plan (claimed within-declared-bounds, derived regressing — economics 100%, latency 0%, resolved-quality 0% beyond tolerance 10%, no declared divergence)",
    );
    // Nothing re-prices a recorded input without leaving a NAMED
    // residual: the row driver FAILs the whole window over it.
    expect(driveOf(FULL_ROW_ID, rePriced).terminal).toBe("PILOT-FAILED");
  });

  test("a fabricated drift verdict over an unresolvable basis NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // A claim over a segment the window NEVER observed (an
    // unresolvable basis) FAILs NAMED — and the inverse lie (claiming
    // drifting over a within-bounds segment) FAILs NAMED too.
    const fabricated: PilotWindowObservation = {
      ...observation,
      claimedDrift: [
        ...observation.claimedDrift.map((claim) =>
          claim.shift === 2 && claim.stage === "plan"
            ? { ...claim, claimed: "drifting" as const, mechanism: "made-up" }
            : claim,
        ),
        { shift: 9, stage: "plan", claimed: "within-declared-bounds" as const, mechanism: null },
      ],
    };
    const honesty = deriveDriftClassificationHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: fabricated,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      "fabricated-drift:shift 2 plan (claimed drifting, derived within-declared-bounds — the declared tolerance holds)",
    );
    expect(honesty.evidence).toContain(
      "unobserved-claim:shift 9 plan (a classification claimed over a segment the window never observed)",
    );
  });

  test("the honest control (pure derivation, digest-verified)", () => {
    // The contrast pair: every honest row's offline observation is
    // PURE derivation over the RECORDED basis — honestly labeled,
    // never claimed as a measurement, digest-verified anchor by
    // anchor, and the recorded economics are never re-priced.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      expect(observation.basis, rowId).toBe("derived-from-recorded-basis");
      expect(observation.usage, rowId).toBeNull();
      // The window digest recomputes over the observed identities.
      expect(observation.windowDigest, rowId).toBe(
        windowRecordDigestOf({
          rowId: observation.rowId,
          basis: observation.basis,
          shifts: observation.shifts,
        }),
      );
      // The schedule digest recomputes (the pin of record).
      expect(scheduleDigestOf({ shifts: row.schedule.shifts }), rowId).toBe(
        row.schedule.scheduleDigest,
      );
      // Every observed segment carries the recorded basis anchor
      // (digest-verified — never re-priced, never re-driven).
      for (const shift of observation.shifts) {
        const scheduled = row.schedule.shifts.find((candidate) => candidate.shift === shift.shift);
        expect(scheduled, `${rowId}/shift${shift.shift}`).toBeDefined();
        for (const segment of shift.segments) {
          const basis = scheduled?.segments.find((candidate) => candidate.stage === segment.stage);
          expect(basis, `${rowId}/shift${shift.shift}/${segment.stage}`).toBeDefined();
          expect(segment.basisDigest, `${rowId}/shift${shift.shift}/${segment.stage}`).toBe(
            basis?.economics.basisDigest,
          );
          expect(segment.applicationId).toBe(PILOT_CUSTOMER_APPLICATION_ID);
        }
      }
    }
    // Where a declared drift factor applies, the observed economics
    // are the recorded basis PLUS the declared factor's BigInt
    // arithmetic (a declared derivation, never a re-measurement).
    const driftObservation = observationOf(DRIFT_ROW_ID);
    const drifting = driftObservation.shifts
      .find((shift) => shift.shift === 4)
      ?.segments.find((segment) => segment.stage === "daily-usage");
    expect(drifting?.costMicroUsd).toBe(DRIFTING_STAGE_OBSERVED_COST);
    expect((BigInt(drifting?.costMicroUsd ?? "0") - 9600n).toString()).toBe(DECLARED_DRIFT_DELTA);
    // The recorded replay fixtures re-derive deterministically through
    // the journey corpus's OWN resolver (digest-verified, never copies).
    for (const journeyRowId of ["full-journey-recorded-portfolio", "journey-continuation-resume"]) {
      const first = recordedJourneyReplayFor(journeyRowId);
      const second = recordedJourneyReplayFor(journeyRowId);
      expect(first.replayDigest).toBe(second.replayDigest);
      expect(first.replayDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 11 — the digest discipline
// ---------------------------------------------------------------------------

describe("discrimination: the digest discipline", () => {
  test("per-field discriminating (the window + schedule pins)", () => {
    const full = rowOf(FULL_ROW_ID);
    // The declared window's pin: deterministic, and EVERY field
    // discriminates — a widened tolerance, an edited span, an extra
    // declared shift or an extra declared divergence each change it.
    const digest = pilotWindowDigestOf(full.window);
    expect(digest).toBe(FULL_WINDOW_DIGEST);
    expect(pilotWindowDigestOf(full.window)).toBe(digest);
    expect(pilotWindowDigestOf({ ...full.window, driftTolerancePct: 11 })).toBe(
      WIDENED_TOLERANCE_WINDOW_DIGEST,
    );
    expect(
      pilotWindowDigestOf({
        ...full.window,
        declaredSpan: { firstShift: 0, lastShift: 6 },
      }),
    ).toMatch(/^[0-9a-f]{8}$/);
    expect(
      pilotWindowDigestOf({ ...full.window, declaredSpan: { firstShift: 0, lastShift: 6 } }),
    ).not.toBe(digest);
    expect(pilotWindowDigestOf({ ...full.window, declaredShifts: 7 })).not.toBe(digest);
    expect(
      pilotWindowDigestOf({
        ...full.window,
        declaredDivergences: [
          ...full.window.declaredDivergences,
          { shift: 1, stage: "plan", cause: "fabricated" },
        ],
      }),
    ).not.toBe(digest);
    // The schedule's pin: deterministic over the resolved schedule and
    // discriminating over a single segment's carried economics.
    const scheduleDigest = scheduleDigestOf({ shifts: full.schedule.shifts });
    expect(scheduleDigest).toBe(FULL_SCHEDULE_DIGEST);
    expect(scheduleDigestOf({ shifts: full.schedule.shifts })).toBe(scheduleDigest);
    const economicsEdited = scheduleDigestOf({
      shifts: full.schedule.shifts.map((shift) =>
        shift.shift === 2
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "plan"
                  ? { ...segment, economics: { ...segment.economics, costMicroUsd: "1501" } }
                  : segment,
              ),
            }
          : shift,
      ),
    });
    expect(economicsEdited).not.toBe(scheduleDigest);
  });

  test("order discriminating (the incident log + window record + ledger chain)", () => {
    const incidentObservation = observationOf(INCIDENT_ROW_ID);
    // The incident log's seal discriminates the APPEND ORDER: the same
    // two records in the opposite order seal differently.
    const logDigest = incidentLogDigestOf(incidentObservation.incidents);
    expect(logDigest).toBe(INCIDENT_ROW_LOG_DIGEST);
    expect(incidentLogDigestOf([...incidentObservation.incidents].reverse())).toBe(
      REVERSED_LOG_DIGEST,
    );
    expect(incidentLogDigestOf([...incidentObservation.incidents].reverse())).not.toBe(logDigest);
    // The window record's digest discriminates the SHIFT ORDER: the
    // same six shifts with the first two swapped digest differently
    // (and deterministically — the order is part of the pin).
    const observation = observationOf(FULL_ROW_ID);
    const firstShift = observation.shifts[0];
    const secondShift = observation.shifts[1];
    if (firstShift === undefined || secondShift === undefined) {
      throw new Error("the full window record holds no shifts 0..1 to swap");
    }
    const reordered = [secondShift, firstShift, ...observation.shifts.slice(2)];
    const reorderedShifts = windowRecordDigestOf({
      rowId: FULL_ROW_ID,
      basis: "derived-from-recorded-basis",
      shifts: reordered,
    });
    expect(reorderedShifts).not.toBe(FULL_WINDOW_RECORD_DIGEST);
    expect(reorderedShifts).toMatch(/^[0-9a-f]{8}$/);
    expect(
      windowRecordDigestOf({
        rowId: FULL_ROW_ID,
        basis: "derived-from-recorded-basis",
        shifts: reordered,
      }),
    ).toBe(reorderedShifts);
    // The append-only ledger's digest chain breaks at the NAMED
    // ordinal when two lines are swapped (order is part of the chain).
    const full = rowOf(FULL_ROW_ID);
    const basis = ledgerBasisDigestOf(full.operatingProfile);
    const swapped = [...observation.ledger];
    const first = swapped[1];
    const second = swapped[2];
    if (first === undefined || second === undefined) {
      throw new Error("the full row's ledger holds no lines 2..3 to swap");
    }
    swapped[1] = second;
    swapped[2] = first;
    expect(ledgerChainHolds({ lines: swapped, basis })).toEqual({
      holds: false,
      breakOrdinal: 3,
    });
  });

  test("payload-bytes boundary (digests only, identity-pinned)", () => {
    const observation = observationOf(FULL_ROW_ID);
    // Every digest in the machinery is the house 8-hex FNV-1a form.
    expect(observation.windowDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(rowOf(FULL_ROW_ID).schedule.scheduleDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(pilotWindowDigestOf(rowOf(FULL_ROW_ID).window)).toMatch(/^[0-9a-f]{8}$/);
    expect(livePilotPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
    for (const line of observation.ledger) {
      expect(line.lineDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(line.previousDigest).toMatch(/^[0-9a-f]{8}$/);
    }
    for (const rowId of HONEST_ROW_IDS) {
      for (const record of observationOf(rowId).incidents) {
        expect(record.disposition.detailDigest, rowId).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // The window-record digest is over the observed shift IDENTITIES
    // (payload-free): a cost edit changes NOTHING, an attempt-shape
    // edit changes the digest.
    const costEdited = windowRecordDigestOf({
      rowId: FULL_ROW_ID,
      basis: "derived-from-recorded-basis",
      shifts: observation.shifts.map((shift) =>
        shift.shift === 2
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "plan" ? { ...segment, costMicroUsd: "999999" } : segment,
              ),
            }
          : shift,
      ),
    });
    expect(costEdited).toBe(FULL_WINDOW_RECORD_DIGEST);
    const attemptEdited = windowRecordDigestOf({
      rowId: FULL_ROW_ID,
      basis: "derived-from-recorded-basis",
      shifts: observation.shifts.map((shift) =>
        shift.shift === 3
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "plan" ? { ...segment, attempts: 2 } : segment,
              ),
            }
          : shift,
      ),
    });
    expect(attemptEdited).not.toBe(FULL_WINDOW_RECORD_DIGEST);
    // Every evidence line of every driven row — honest, probe and
    // live, plus every forced-knob run — is single-line text free of
    // control characters and never carries a payload-shaped blob.
    const drivenResults = [
      ...PILOT_CORPUS_ROWS.map((row) => pilotRowResultFor(row)),
      ...PROBE_CORPUS_ROWS.map((row) =>
        drivePilotRow({
          rowId: row.rowId,
          window: row.window,
          schedule: row.schedule,
          policy: row.operatingProfile,
          observation: pilotWindowRecordFor(row),
        }),
      ),
    ];
    for (const result of drivenResults) {
      for (const criterion of result.criteria) {
        for (const line of criterion.evidence) {
          expect(typeof line, `${result.rowId}/${criterion.criterionId}`).toBe("string");
          expect(line, `${result.rowId}/${criterion.criterionId}`).not.toMatch(/\p{Cc}/u);
          expect(line, `${result.rowId}/${criterion.criterionId}`).not.toMatch(
            /[A-Za-z0-9+/=]{41,}/,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 12 — the live-boundary honesty
// ---------------------------------------------------------------------------

describe("discrimination: the live-boundary honesty", () => {
  test("a live slice without its declared boundary NAMED (the offline fake world REFUSES the live rail)", async () => {
    // The leaky stack's own transport-level fake REFUSES the live
    // rail outright: the live row's submission meets the TYPED
    // refusal — never a fabricated live pilot window, even with a
    // spoofed credential riding the request (the refusal is typed on
    // the ROW, never negotiated with the credential).
    const clock = createTickClock();
    const world = createPilotFakeApiWorld({ clock });
    const live = rowOf(LIVE_ROW_ID);
    const refusal = await world.transport("https://fake.example.test/executions", {
      method: "POST",
      headers: {
        "idempotency-key": "val-051-discrimination-live",
        authorization: "Bearer sk-spoofed-credential",
      },
      body: JSON.stringify({
        applicationId: PILOT_CUSTOMER_APPLICATION_ID,
        task: taskBodyFor({ row: live }),
      }),
    });
    expect(refusal.status).toBe(PILOT_FAKE_LIVE_RAIL_REFUSAL.status);
    const refused = (await refusal.json()) as { code: string; message: string };
    expect(refused.code).toBe(PILOT_FAKE_LIVE_RAIL_REFUSAL.code);
    expect(refused.message).toBe(PILOT_FAKE_LIVE_RAIL_REFUSAL.message);
    // The same world SERVES the offline rows (the refusal is the live
    // boundary, never a broken world) — and the live row never lands
    // a durable execution.
    const offline = await world.transport("https://fake.example.test/executions", {
      method: "POST",
      headers: { "idempotency-key": "val-051-discrimination-full" },
      body: JSON.stringify({
        applicationId: PILOT_CUSTOMER_APPLICATION_ID,
        task: taskBodyFor({ row: rowOf(FULL_ROW_ID) }),
      }),
    });
    expect(offline.status).toBe(201);
    expect(world.createdExecutions).toBe(1);
    // The live row's window feed is honestly NULL offline (its window
    // record is MEASURED at run time over the REAL rail — an offline
    // fabrication would be a fake measurement, never).
    expect(pilotWindowFeedFor(live)).toBeNull();
    expect(pilotWindowRecordFor(live)).toBeNull();
  });

  test("a false declared boundary FAILs NAMED (a fabricated live slice over the declared window)", () => {
    const live = rowOf(LIVE_ROW_ID);
    // A FABRICATED live slice — an offline-derived six-shift record
    // relabeled `measured-live` and driven over the live row's
    // declared three-shift window — FAILs NAMED: every shift beyond
    // the declared boundary is a post-hoc extension, every unscheduled
    // shift is undeclared, and the row settles PILOT-FAILED (a live
    // slice never passes over a boundary it did not declare).
    const observation = observationOf(FULL_ROW_ID);
    const fabricatedLive: PilotWindowObservation = {
      ...observation,
      rowId: LIVE_ROW_ID,
      basis: "measured-live",
    };
    const result = drivePilotRow({
      rowId: live.rowId,
      window: live.window,
      schedule: live.schedule,
      policy: live.operatingProfile,
      observation: fabricatedLive,
    });
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toContain("window-honesty");
    expect(result.failedCriteria).toContain("schedule-completeness");
    expect(evidenceOf(result, "window-honesty")).toContain(
      "declared-window:shifts 3 over span 0..2",
    );
    expect(evidenceOf(result, "window-honesty")).toContain("observed-shifts:0..5");
    for (const ordinal of [3, 4, 5]) {
      expect(evidenceOf(result, "window-honesty")).toContain(
        `post-hoc-extension:shift ${ordinal} (observed outside the declared window)`,
      );
      expect(evidenceOf(result, "schedule-completeness")).toContain(
        `undeclared-shift:${ordinal} (never scheduled)`,
      );
    }
    expect(evidenceOf(result, "schedule-completeness")).toContain("observed-shift-count:6");
  });

  test("the honest NOT RUN shape", () => {
    // The honest boundary: the live row derives NOT-RUN with exactly
    // ONE criterion — the live-gate-honesty PASS carrying the gate,
    // the digest pins and the honest not-run line — never a fake
    // success, and the digests are deterministic whether or not the
    // gate ever opens.
    const live = rowOf(LIVE_ROW_ID);
    const result = pilotRowResultFor(live);
    expect(result.terminal).toBe("NOT-RUN");
    const gate = criterionOf(result, "live-gate-honesty");
    expect(gate.status).toBe("PASS");
    expect(gate.evidence).toContain("gate:OPENROUTER_API_KEY");
    expect(gate.evidence).toContain(`window-digest:${LIVE_WINDOW_DIGEST}`);
    expect(gate.evidence).toContain(`schedule-digest:${LIVE_SCHEDULE_DIGEST}`);
    expect(gate.evidence).toContain(`plan-digest:${LIVE_PLAN_DIGEST}`);
    expect(gate.evidence).toContain(
      "NOT RUN (the live pilot slice demands the operator credential — honestly not run, never fabricated)",
    );
    expect(result.windowDigest).toBe(LIVE_WINDOW_DIGEST);
    expect(result.scheduleDigest).toBe(LIVE_SCHEDULE_DIGEST);
    expect(livePilotPlanDigestOf()).toBe(LIVE_PLAN_DIGEST);
    expect(livePilotPlanDigestOf()).toBe(livePilotPlanDigestOf());
    // The offline rows never hold the NOT-RUN shape: every offline
    // row derives a real terminal over its real observation.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(pilotRowResultFor(row).notRun, row.rowId).toBe(false);
      expect(pilotRowResultFor(row).terminal, row.rowId).not.toBe("NOT-RUN");
    }
  });
});

// ---------------------------------------------------------------------------
// 13 — the honest controls over the leaky fixture stack
// ---------------------------------------------------------------------------

describe("discrimination: the honest controls over the leaky fixture stack", () => {
  test("the full honest corpus PASSES over the leaky stack", () => {
    // Every honest row's leaky-stack window feed (the fixture stack's
    // own observation lane) drives to PILOT-COMPLETED with all EIGHT
    // criteria PASSing and the digest pins recomputed — and the feeds
    // are deterministic (two feeds of the same row agree digest-for-
    // digest, the full records deep-equal).
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const feed = feedOf(rowId);
      const result = driveOf(rowId, feed);
      expect(result.terminal, rowId).toBe("PILOT-COMPLETED");
      expect(result.criteria, rowId).toHaveLength(8);
      expect(result.failedCriteria, rowId).toEqual([]);
      for (const criterion of result.criteria) {
        expect(criterion.status, `${rowId}/${criterion.criterionId}`).toBe("PASS");
      }
      expect(result.windowDigest, rowId).toBe(pilotWindowDigestOf(row.window));
      expect(result.scheduleDigest, rowId).toBe(scheduleDigestOf({ shifts: row.schedule.shifts }));
      // The feed is deterministic (the leaky stack never improvises).
      expect(feedOf(rowId).windowDigest, rowId).toBe(feed.windowDigest);
      expect(feedOf(rowId).reported.totalCostMicroUsd, rowId).toBe(feed.reported.totalCostMicroUsd);
      expect(pilotWindowFeedFor(row), rowId).toEqual(pilotWindowFeedFor(row));
    }
  });

  test("the full probe corpus FAILs over the leaky stack", () => {
    // Every probe row's leaky-stack feed drives to PILOT-FAILED with
    // EXACTLY its pinned NAMED criteria — the full seven-probe matrix
    // over the leaky stack, the pinned failure surface never wishful.
    expect(PROBE_CORPUS_ROWS).toHaveLength(7);
    for (const row of PROBE_CORPUS_ROWS) {
      const probe = row.probe?.kind;
      expect(probe, row.rowId).toBeDefined();
      const feed = pilotWindowFeedFor(row);
      expect(feed, row.rowId).not.toBeNull();
      const result = driveOf(row.rowId, feed as PilotWindowObservation);
      expect(result.terminal, row.rowId).toBe("PILOT-FAILED");
      expect(result.failedCriteria, row.rowId).toEqual(
        PROBE_FAILED_CRITERIA_OF[probe as PilotProbeKind],
      );
      expect(result.failedCriteria, row.rowId).toEqual(row.expected.failedCriteria);
      expect(result.notRun, row.rowId).toBe(false);
      // The pinned mechanism vocabulary names each probe's catch.
      expect(PROBE_MECHANISM_OF[probe as PilotProbeKind], row.rowId).toContain(":");
    }
  });

  test("the leaky stack's fabrication knobs each fire their NAMED criterion", () => {
    // The FORCED-probe knob: each of the seven issued mechanisms
    // forced onto an HONEST row's window feed fires its NAMED
    // criterion with its NAMED mechanism token — the knob never
    // invents a new corruption shape (the corpus's own declared
    // corruptions and the forced lane produce the same catches).
    const knobs: readonly {
      readonly probe: PilotProbeKind;
      readonly rowId: string;
      readonly namedCriterion: string;
      readonly mechanismToken: string;
      /** The token the corpus's own pinned mechanism vocabulary names for the family. */
      readonly pinnedMechanismToken: string;
    }[] = [
      {
        probe: "cherry-picked-window",
        rowId: FULL_ROW_ID,
        namedCriterion: "window-honesty",
        mechanismToken: "cherry-picked-sub-window:shifts 0..3 of 0..5",
        pinnedMechanismToken: "cherry-picked-sub-window + omitted-shift:4..5",
      },
      {
        probe: "dropped-shift",
        rowId: FULL_ROW_ID,
        namedCriterion: "window-honesty",
        mechanismToken: "omitted-shift:3",
        pinnedMechanismToken: "missed-shift:3",
      },
      {
        probe: "double-driven-resume",
        rowId: CONT_ROW_ID,
        namedCriterion: "continuation-exactly-once",
        mechanismToken:
          "double-driven-resume:shift 3 daily-usage (attempts=3, expected exactly 2 — the resume was driven 2 times)",
        pinnedMechanismToken: "double-driven-resume",
      },
      {
        probe: "drift-normalizing",
        rowId: REGR_ROW_ID,
        namedCriterion: "drift-classification-honesty",
        mechanismToken: "hidden-regression:shift 5 daily-usage",
        pinnedMechanismToken: "hidden-regression",
      },
      {
        probe: "incident-hiding",
        rowId: CONT_ROW_ID,
        namedCriterion: "incident-honesty",
        mechanismToken: "hidden-incident:shift 3 daily-usage",
        pinnedMechanismToken: "hidden-incident",
      },
      {
        probe: "residual-hiding",
        rowId: FULL_ROW_ID,
        namedCriterion: "end-of-window-reconciliation",
        mechanismToken: "window-total-residual:reported 79800microUsd",
        pinnedMechanismToken: "window-total-residual",
      },
      {
        probe: "boundary-leak",
        rowId: FULL_ROW_ID,
        namedCriterion: "customer-boundary-integrity",
        mechanismToken: `foreign-application:shift 4 onboarding (executed under ${FOREIGN_APPLICATION_ID}, not ${PILOT_CUSTOMER_APPLICATION_ID} — a cross-tenant leak across the window)`,
        pinnedMechanismToken: "foreign-application",
      },
    ];
    expect(knobs).toHaveLength(7);
    for (const knob of knobs) {
      const observation = feedOf(knob.rowId, knob.probe);
      const result = driveOf(knob.rowId, observation);
      expect(result.terminal, knob.probe).toBe("PILOT-FAILED");
      expect(result.failedCriteria, knob.probe).toContain(knob.namedCriterion);
      const evidence = evidenceOf(result, knob.namedCriterion);
      expect(
        evidence.some((line) => line.startsWith(knob.mechanismToken)),
        `${knob.probe}: the NAMED mechanism token must appear in the ${knob.namedCriterion} evidence`,
      ).toBe(true);
      // The pinned mechanism vocabulary names the same family catch.
      expect(PROBE_MECHANISM_OF[knob.probe], knob.probe).toContain(knob.pinnedMechanismToken);
      // The knob is a MUTATION of the honest feed: the unmutated feed
      // of the SAME row PASSes (the contrast pair, knob by knob).
      expect(driveOf(knob.rowId, feedOf(knob.rowId)).terminal, knob.probe).toBe("PILOT-COMPLETED");
    }
  });

  test("the REAL accounting rails seal the leaky-stack runs (digest-stable)", () => {
    // The REAL accounting rails (imported, never re-implemented) seal
    // the leaky-stack runs: the same honest run sealed twice yields
    // the IDENTICAL content digest (deterministic), a mutated run
    // seals differently (discriminating), and the seal carries
    // microUsd amounts and digests only — never payload bytes.
    const rails = createRealAccountingRails();
    const metadata: RunMetadata = {
      program: "zeck-validation",
      workOrder: "VAL-051",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
      applicationRevision: "0123456789abcdef0123456789abcdef01234567",
      corpusRevision: "val-051-production-pilot-v1",
      integrationSurface: "production-pilot:window",
      environment: {
        runtime: "bun test",
        toolchain: "bun",
        database: "none",
        configuration: { suite: "val-051-discrimination" },
      },
      observedAt: "2025-01-01T00:00:00.000Z",
    };
    const sealInputOf = (observation: PilotWindowObservation) => ({
      metadata,
      corpusTaskId: `val-051:${FULL_ROW_ID}`,
      environmentIdentity: "val-051-discrimination",
      events: [
        {
          kind: "run-start" as const,
          data: { rowId: FULL_ROW_ID },
          at: "2025-01-01T00:00:00.000Z",
        },
        {
          kind: "model-choice" as const,
          data: { requestDigest: observation.windowDigest, request: 1 },
          at: "2025-01-01T00:00:00.500Z",
        },
        {
          kind: "run-end" as const,
          data: { terminalStatus: "PILOT-COMPLETED" },
          at: "2025-01-01T00:00:01.000Z",
        },
      ],
      environment: [],
      latency: observation.shifts.map((shift) => ({
        phase: "total" as const,
        source: "platform-ledger" as const,
        milliseconds: shift.reportedLatencyMs,
      })),
      cost: observation.shifts.map((shift) => ({
        kind: "measured" as const,
        amountMicroUsd: shift.reportedCostMicroUsd,
        source: `val-051:${FULL_ROW_ID}:shift${shift.shift}`,
        scope: "direct-execution" as const,
      })),
      sealedAt: "2025-01-01T00:00:02.000Z",
    });
    // The honest leaky-stack run seals digest-stably.
    const honestFeed = feedOf(FULL_ROW_ID);
    const first = rails.sealRound(sealInputOf(honestFeed));
    const second = rails.sealRound(sealInputOf(honestFeed));
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.digest).toBe(second.digest);
    expect(first.runId).toBe(second.runId);
    expect(first.revision).toBe(1);
    // A mutated run (the dropped-shift knob over the same row) seals
    // DIFFERENTLY — the seal discriminates the leaky stack's runs.
    const mutated = rails.sealRound(sealInputOf(feedOf(FULL_ROW_ID, "dropped-shift")));
    expect(mutated.digest).not.toBe(first.digest);
    // The sealed record carries microUsd amounts only (six shift facts
    // for the honest run, five for the mutated one — never payload
    // bytes, never credentials).
    expect(first.cost).toHaveLength(6);
    expect(mutated.cost).toHaveLength(5);
    for (const fact of [...first.cost, ...mutated.cost]) {
      expect(fact.amountMicroUsd).toMatch(/^[0-9]+$/);
    }
  });
});
