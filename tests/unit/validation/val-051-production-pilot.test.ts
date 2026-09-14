/**
 * VAL-051 acceptance criteria (the production-pilot ENGINE — the driver
 * oracle matrix over the RECORDED corpora): the core unit suite for
 * `benchmarks/validation/apps/production-pilot/driver.ts`.
 *
 *   * the pilot vocabulary: the pinned verdict / drift-classification /
 *     observation-family / admission-policy ladders of record, the
 *     budget/policy envelope + incident root-cause class pins (the
 *     IMPORTED VAL-020 taxonomy, never re-implemented), and the
 *     window/shift-schedule declaration pins (digest-pinned at row
 *     declaration);
 *   * the shift scheduler (deterministic, PURE derivation over the
 *     RECORDED journey corpus): schedule determinism + digest, every
 *     declared shift landing exactly once, the declared mid-window
 *     failure resuming exactly once over its TWO recorded attempts, and
 *     the schedule digest pinned at row declaration (post-hoc changes
 *     NAMED);
 *   * continuation exactly-once: a declared resume continues exactly
 *     once; a dropped shift and a double-driven resume each FAIL NAMED
 *     with the shift and the attempt count;
 *   * the window-wide budget/policy envelope: reservations settle at
 *     end-of-window, an unauthorized/off-ledger spend FAILs NAMED, the
 *     append-only ledger's digest chain holds (erased/rewritten/reordered
 *     lines break it at the NAMED ordinal), and a window-wide budget
 *     breach FAILs NAMED with the exact amount;
 *   * incident capture + attribution: every incident recorded AND
 *     attributed (root-cause class NAMED through the imported taxonomy);
 *     a hidden incident and an unattributed incident each FAIL NAMED;
 *   * drift classification vs the VAL-049 recorded basis: the three-way
 *     ladder (within-declared-bounds / drifting-with-mechanism-NAMED /
 *     regressing-reported-as-regressing — never normalized), and the
 *     normalized-drift / hidden-regression catches (segment AND
 *     mechanism NAMED);
 *   * end-of-window reconciliation: the stage-for-stage digest-anchored
 *     equality, the shift-for-shift sums, the window total = Σ shifts
 *     with reported = observed (zero unexplained residual), and the
 *     hidden residual NAMED (the exact amount);
 *   * window honesty: the declared window matches the recorded data; a
 *     cherry-picked sub-window FAILs NAMED (the omitted shifts named)
 *     and a post-hoc extension FAILs NAMED;
 *   * the driver over every offline row: the honest outcome contract —
 *     every honest row COMPLETES with its pinned verdict + drift
 *     classification, every probe row FAILs its NAMED criteria;
 *   * the live lane declaration: the plan digest deterministic + exactly
 *     one live row, and the honest NOT-RUN shape;
 *   * the digest discipline: the house FNV-1a convention imported
 *     (never re-implemented), every recorded reference recomputed at pin
 *     time (a drifted corpus THROWS), and payload bytes never in
 *     evidence.
 */

import { describe, expect, test } from "vitest";
import {
  CARRIED_AUDIT_ROW_IDS,
  JOURNEY_STAGES,
  journeyRowById,
} from "../../../benchmarks/validation/apps/customer-journey/corpus";
import { FOREIGN_APPLICATION_ID } from "../../../benchmarks/validation/apps/customer-journey/driver";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_CORPUS_ROWS,
  type PilotCorpusRow,
  PROBE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  pilotRowById,
  pilotRowResultFor,
  pilotWindowRecordFor,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  carriedAuditBasisDigests,
  carriedBasisDigestOf,
  createWindowLedger,
  DRIFT_CLASSIFICATIONS,
  deriveBudgetPolicyEnvelopeIntegrity,
  deriveContinuationExactlyOnce,
  deriveDriftClassificationHonesty,
  deriveEndOfWindowReconciliation,
  deriveIncidentHonesty,
  deriveScheduleCompleteness,
  deriveSegmentDrift,
  deriveShiftObservation,
  deriveShiftSchedule,
  deriveWindowDrift,
  deriveWindowHonesty,
  dispositionIsValidFor,
  drivePilotRow,
  type IncidentDispositionKind,
  type IncidentRecord,
  incidentEvidenceOf,
  incidentLogDigestOf,
  isKnownAttributionClass,
  type LedgerLine,
  type LedgerLineKind,
  LIVE_PILOT_PLAN,
  LIVE_PILOT_WORKLOAD_CLASS,
  ledgerBasisDigestOf,
  ledgerChainHolds,
  livePilotPlanDigestOf,
  type ObservedShiftRecord,
  type ObservedShiftSegment,
  PILOT_ADMISSION_POLICIES,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_OBSERVATION_FAMILIES,
  PILOT_VERDICT_KINDS,
  type PilotWindowObservation,
  pilotWindowDigestOf,
  reservationsOf,
  type ScheduledShift,
  type ShiftSegment,
  scheduleDigestOf,
  shiftCostBasisOf,
  shiftLatencyBasisOf,
  windowRecordDigestOf,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  doubleDriveResumeInWindowRecord,
  normalizeDriftClaimsInWindowRecord,
  omitShiftsFromWindowRecord,
  pilotWindowFeedFor,
  recordedJourneyReplayFor,
} from "../../../benchmarks/validation/apps/production-pilot/fixtures";
import {
  ATTRIBUTION_CLASSES,
  type AttributionClass,
} from "../../../benchmarks/validation/platform/failure-attribution";

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

/** The seven adversarial probe rows (the issued probes, 1:1). */
const PROBE_ROW_IDS = [
  "probe-pilot-cherry-picked-window",
  "probe-pilot-dropped-shift",
  "probe-pilot-double-driven-resume",
  "probe-pilot-drift-normalizing",
  "probe-pilot-incident-hiding",
  "probe-pilot-residual-hiding",
  "probe-pilot-boundary-leak",
];

/** The one live row (env-gated on OPENROUTER_API_KEY). */
const LIVE_ROW: readonly string[] = [LIVE_ROW_ID];

/**
 * The recorded journey-stage economics (the VAL-050 corpus's own pins —
 * the pilot's carried cost basis, never re-priced): onboarding 1200,
 * intent 800, plan 1500, daily-usage 9600, outcome 400 microUsd.
 */
const RECORDED_STAGE_COST_MICRO_USD: Readonly<Record<string, string>> = Object.freeze({
  onboarding: "1200",
  intent: "800",
  plan: "1500",
  "daily-usage": "9600",
  outcome: "400",
});

/** The recorded per-shift bases (the Σ of the journey row's stage economics). */
const PORTFOLIO_SHIFT_COST = "13500"; // 1200 + 800 + 1500 + 9600 + 400
const PORTFOLIO_SHIFT_LATENCY_MS = 400; // 45 + 30 + 60 + 240 + 25
const CONTINUATION_SHIFT_COST = "23100"; // daily-usage's TWO recorded attempts (19200)
const CONTINUATION_SHIFT_LATENCY_MS = 640; // 45 + 30 + 60 + 480 + 25

/** The recorded window totals (the numerically pinned arithmetic). */
const FULL_WINDOW_COST = "81000"; // 6 × 13500 (the tight row's exact budget)
const FULL_WINDOW_LATENCY_MS = 2400; // 6 × 400
const CONTINUATION_WINDOW_COST = "90600"; // 5 × 13500 + 23100
const CONTINUATION_WINDOW_LATENCY_MS = 2640;
const DRIFTING_WINDOW_COST = "83400"; // 81000 + the declared 2400 delta
const DECLARED_DRIFT_DELTA = "2400"; // 9600 × 25% — the load-shaping cohort mix
const DRIFTING_STAGE_OBSERVED_COST = "12000"; // 9600 + 2400

/** The continuation arithmetic (exactly-once, both attempts cost-carried). */
const FAILED_ATTEMPT_COST = "9600"; // 19200 / 2 — the failed attempt's per-attempt cost
const DOUBLE_DRIVEN_STAGE_COST = "28800"; // 19200 + the third attempt's 9600
const DOUBLE_DRIVEN_RESIDUAL = "9600";
const HIDDEN_REGRESSION_STAGE_COST = "12480"; // 9600 × 1.30 (the normalized drift's real economics)
const HIDDEN_REGRESSION_RESIDUAL = "2880";

/** The residual-hiding arithmetic (the exact hidden amount). */
const HIDDEN_RESIDUAL = "1200"; // shift 1's onboarding stage cost
const RESIDUAL_HIDING_REPORTED_TOTAL = "79800"; // 81000 - 1200

/** The pinned digest values (the FNV-1a pins of record). */
const FULL_WINDOW_DIGEST = "6e84c0f3";
const FULL_SCHEDULE_DIGEST = "4c0abe8c";
const WIDENED_TOLERANCE_WINDOW_DIGEST = "8f5d26fc"; // driftTolerancePct 11 — never widened post-hoc
const LIVE_WINDOW_DIGEST = "23d499b7";
const LIVE_SCHEDULE_DIGEST = "1704c257";
const LIVE_PLAN_DIGEST = "7ba51da0";
const FULL_LEDGER_BASIS = "7b1217bf";
const TIGHT_LEDGER_BASIS = "3187834f";
const FULL_WINDOW_RECORD_DIGEST = "d6dd6827";
const CONTINUATION_INCIDENT_LOG_DIGEST = "b2513366";
const INCIDENT_ROW_INCIDENT_LOG_DIGEST = "800266f4";

/** The pinned stage basis anchors (the carried VAL-049 audit digests). */
const STAGE_BASIS_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  onboarding: "8100a41d",
  intent: "a39b86c0",
  plan: "c0fbc74a",
  "daily-usage": "ca2a00a4",
  outcome: "30218f83",
});

/** The load-shaping divergence cause (the drifting row's NAMED mechanism). */
const LOAD_SHAPING_COHORT_MIX = "load-shaping cohort mix";

// ---------------------------------------------------------------------------
// The lookup helpers (throwing lookups — a missing row is a test bug)
// ---------------------------------------------------------------------------

function rowOf(rowId: string): PilotCorpusRow {
  const row = pilotRowById(rowId);
  if (row === null) {
    throw new Error(`the pilot corpus holds no row ${rowId}`);
  }
  return row;
}

function observationOf(rowId: string): PilotWindowObservation {
  const observation = pilotWindowRecordFor(rowOf(rowId));
  if (observation === null) {
    throw new Error(`row ${rowId} derives no offline window record`);
  }
  return observation;
}

/** The evidence lines of one criterion of a corpus row's driven result. */
function evidenceOf(rowId: string, criterionId: string): readonly string[] {
  const criterion = pilotRowResultFor(rowOf(rowId)).criteria.find(
    (candidate) => candidate.criterionId === criterionId,
  );
  if (criterion === undefined) {
    throw new Error(`row ${rowId} derives no ${criterionId} criterion`);
  }
  return criterion.evidence;
}

function observedShiftOf(
  observation: PilotWindowObservation,
  ordinal: number,
): ObservedShiftRecord {
  const shift = observation.shifts.find((candidate) => candidate.shift === ordinal);
  if (shift === undefined) {
    throw new Error(`the window record of ${observation.rowId} holds no shift ${ordinal}`);
  }
  return shift;
}

function observedSegmentOf(
  observation: PilotWindowObservation,
  ordinal: number,
  stage: string,
): ObservedShiftSegment {
  const segment = observedShiftOf(observation, ordinal).segments.find(
    (candidate) => candidate.stage === stage,
  );
  if (segment === undefined) {
    throw new Error(`the window record of ${observation.rowId} holds no ${stage} segment`);
  }
  return segment;
}

function scheduledShiftOf(row: PilotCorpusRow, ordinal: number): ScheduledShift {
  const shift = row.schedule.shifts.find((candidate) => candidate.shift === ordinal);
  if (shift === undefined) {
    throw new Error(`the schedule of ${row.rowId} holds no shift ${ordinal}`);
  }
  return shift;
}

function scheduledSegmentOf(row: PilotCorpusRow, ordinal: number, stage: string): ShiftSegment {
  const segment = scheduledShiftOf(row, ordinal).segments.find(
    (candidate) => candidate.stage === stage,
  );
  if (segment === undefined) {
    throw new Error(`the schedule of ${row.rowId} holds no ${stage} segment`);
  }
  return segment;
}

function incidentOf(
  observation: PilotWindowObservation,
  shift: number,
  stage: string,
): IncidentRecord {
  const record = observation.incidents.find(
    (candidate) => candidate.shift === shift && candidate.stage === stage,
  );
  if (record === undefined) {
    throw new Error(`the incident log of ${observation.rowId} holds no ${shift}:${stage} record`);
  }
  return record;
}

/** Sum a list of microUsd amounts (BigInt — the driver's own arithmetic). */
function sumMicroUsd(amounts: readonly string[]): bigint {
  return amounts.reduce((total, amount) => total + BigInt(amount), 0n);
}

/**
 * Append one CORRECTLY-chained ledger line by hand (the FNV-1a over the
 * line's own content chained over the previous line — the honest
 * writer's own construction; the dishonest lanes ride it).
 */
function appendLedgerLine(
  lines: readonly LedgerLine[],
  basis: string,
  kind: LedgerLineKind,
  shift: number,
  amountMicroUsd: string,
  reservationId: string | null,
): LedgerLine[] {
  const previous = lines.at(-1);
  const previousDigest = previous === undefined ? basis : previous.lineDigest;
  const ordinal = lines.length + 1;
  return [
    ...lines,
    {
      ordinal,
      kind,
      shift,
      amountMicroUsd,
      reservationId,
      previousDigest,
      lineDigest: economicDigestOf({
        ordinal,
        kind,
        shift,
        amountMicroUsd,
        reservationId,
        previousDigest,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// The pilot vocabulary (the pinned policies)
// ---------------------------------------------------------------------------

describe("VAL-051 pilot vocabulary (the pinned policies)", () => {
  test("the verdict vocabulary", () => {
    // The mechanical terminal ladder (never a narrative rescue) — pinned
    // in the issued order, frozen.
    expect([...PILOT_VERDICT_KINDS]).toEqual(["PILOT-COMPLETED", "PILOT-FAILED", "NOT-RUN"]);
    expect(Object.isFrozen(PILOT_VERDICT_KINDS)).toBe(true);
    // The issued AC4 observation-family vocabulary — one oracle per
    // family, in the issued order, frozen.
    expect([...PILOT_OBSERVATION_FAMILIES]).toEqual([
      "window-honesty",
      "schedule-completeness",
      "continuation-exactly-once",
      "drift-classification-honesty",
      "incident-honesty",
      "budget-policy-envelope",
      "end-of-window-reconciliation",
      "customer-boundary-integrity",
    ]);
    expect(PILOT_OBSERVATION_FAMILIES).toHaveLength(8);
    expect(Object.isFrozen(PILOT_OBSERVATION_FAMILIES)).toBe(true);
    // The admission-policy vocabulary (the envelope's two disciplines).
    expect([...PILOT_ADMISSION_POLICIES]).toEqual(["admit-all-scheduled", "admit-within-budget"]);
    expect(Object.isFrozen(PILOT_ADMISSION_POLICIES)).toBe(true);
    // The pilot's customer identity (the boundary criterion's pinned basis).
    expect(PILOT_CUSTOMER_APPLICATION_ID).toBe("app-pilot-customer");
    // Every corpus row's pinned verdict sits in the declared vocabulary.
    for (const row of PILOT_CORPUS_ROWS) {
      expect(PILOT_VERDICT_KINDS, row.rowId).toContain(row.expected.verdict);
    }
    expect(
      PILOT_CORPUS_ROWS.filter((row) => row.expected.verdict === "PILOT-COMPLETED"),
    ).toHaveLength(6);
    expect(PILOT_CORPUS_ROWS.filter((row) => row.expected.verdict === "PILOT-FAILED")).toHaveLength(
      7,
    );
    expect(PILOT_CORPUS_ROWS.filter((row) => row.expected.verdict === "NOT-RUN")).toHaveLength(1);
  });

  test("the drift-classification vocabulary", () => {
    // The three-way ladder (never two-way): within the declared
    // tolerance; beyond WITH a declared divergence cause; beyond
    // UNdeclared — reported AS regressing.
    expect([...DRIFT_CLASSIFICATIONS]).toEqual([
      "within-declared-bounds",
      "drifting",
      "regressing",
    ]);
    expect(Object.isFrozen(DRIFT_CLASSIFICATIONS)).toBe(true);
    // Every claimed classification in every offline window record sits
    // in the declared vocabulary (claimed == derived, mechanically).
    for (const row of OFFLINE_CORPUS_ROWS) {
      const observation = observationOf(row.rowId);
      for (const claim of observation.claimedDrift) {
        expect(DRIFT_CLASSIFICATIONS, `${row.rowId}/${claim.shift}/${claim.stage}`).toContain(
          claim.claimed,
        );
      }
    }
    // The ladder's honest shape over the pinned corpus rows: a drifting
    // finding carries its mechanism NAMED; a regressing one carries none
    // (there is no declared divergence to name).
    const driftRow = rowOf(DRIFT_ROW_ID);
    expect(driftRow.expected.driftFindings).toEqual([
      {
        shift: 4,
        stage: "daily-usage",
        classification: "drifting",
        mechanism: LOAD_SHAPING_COHORT_MIX,
      },
    ]);
    const regrRow = rowOf(REGR_ROW_ID);
    expect(regrRow.expected.driftFindings).toEqual([
      { shift: 5, stage: "daily-usage", classification: "regressing", mechanism: null },
    ]);
    for (const row of [
      rowOf(FULL_ROW_ID),
      rowOf(CONT_ROW_ID),
      rowOf(INCIDENT_ROW_ID),
      rowOf(TIGHT_ROW_ID),
    ]) {
      expect(row.expected.driftFindings, row.rowId).toEqual([]);
    }
  });

  test("the budget/policy envelope + incident root-cause class pins", () => {
    const full = rowOf(FULL_ROW_ID);
    const tight = rowOf(TIGHT_ROW_ID);
    const live = rowOf(LIVE_ROW_ID);
    // The pinned operating profiles: the standard envelope at 2× the
    // recorded cost basis (162000 = 2 × 81000) and 2× the maximum
    // recorded per-shift latency (800 = 2 × 400), admitting every
    // scheduled shift; the tight row at EXACTLY the recorded basis with
    // the within-budget admission policy; the live row's own envelope.
    expect(full.operatingProfile).toEqual({
      costBudgetMicroUsd: "162000",
      latencyBudgetMsPerShift: 800,
      admissionPolicy: "admit-all-scheduled",
    });
    expect(tight.operatingProfile).toEqual({
      costBudgetMicroUsd: FULL_WINDOW_COST,
      latencyBudgetMsPerShift: PORTFOLIO_SHIFT_LATENCY_MS,
      admissionPolicy: "admit-within-budget",
    });
    expect(live.operatingProfile).toEqual({
      costBudgetMicroUsd: FULL_WINDOW_COST,
      latencyBudgetMsPerShift: 30000,
      admissionPolicy: "admit-all-scheduled",
    });
    // The ledger basis digest is deterministic and discriminates the
    // policy (a rewritten envelope breaks the chain mechanically).
    expect(ledgerBasisDigestOf(full.operatingProfile)).toBe(
      ledgerBasisDigestOf(full.operatingProfile),
    );
    expect(ledgerBasisDigestOf(full.operatingProfile)).toBe(FULL_LEDGER_BASIS);
    expect(ledgerBasisDigestOf(tight.operatingProfile)).toBe(TIGHT_LEDGER_BASIS);
    expect(
      ledgerBasisDigestOf({ ...full.operatingProfile, costBudgetMicroUsd: "162001" }),
    ).not.toBe(FULL_LEDGER_BASIS);
    // The incident root-cause classes come from the IMPORTED VAL-020
    // taxonomy (never free-text, never re-implemented).
    for (const attributionClass of ATTRIBUTION_CLASSES) {
      expect(isKnownAttributionClass(attributionClass), attributionClass).toBe(true);
    }
    expect(ATTRIBUTION_CLASSES).toHaveLength(12);
    expect(isKnownAttributionClass("")).toBe(false);
    expect(isKnownAttributionClass("not-a-real-class")).toBe(false);
    // The disposition discipline: a retryable class carries its bounded
    // disposition; a non-retryable class its escalation or accepted-risk
    // record — never the other way around.
    expect(dispositionIsValidFor("provider-unavailable", "bounded-retry")).toBe(true);
    expect(dispositionIsValidFor("provider-unavailable", "escalated")).toBe(false);
    expect(dispositionIsValidFor("provider-unavailable", "accepted-risk")).toBe(false);
    expect(dispositionIsValidFor("tool-failure", "bounded-retry")).toBe(false);
    expect(dispositionIsValidFor("tool-failure", "escalated")).toBe(true);
    expect(dispositionIsValidFor("tool-failure", "accepted-risk")).toBe(true);
    expect(dispositionIsValidFor("empty-completion", "bounded-retry")).toBe(false);
    expect(dispositionIsValidFor("empty-completion", "accepted-risk")).toBe(true);
    // The incident evidence line names the class AND its layer through
    // the imported taxonomy's own table (payload-free).
    const contObservation = observationOf(CONT_ROW_ID);
    const failureIncident = incidentOf(contObservation, 3, "daily-usage");
    expect(incidentEvidenceOf(failureIncident)).toBe(
      "incident:shift 3 daily-usage (provider-unavailable@provider, magnitude 9600microUsd, bounded-retry)",
    );
  });

  test("the window/shift-schedule declaration pins", () => {
    const full = rowOf(FULL_ROW_ID);
    const cont = rowOf(CONT_ROW_ID);
    // Every corpus row's declared window: the shift cardinality equals
    // the declared schedule's, the span covers exactly it, and the
    // tolerance is declared (10 offline, 50 live — never widened).
    for (const row of PILOT_CORPUS_ROWS) {
      expect(row.window.declaredShifts, row.rowId).toBe(row.shiftDeclarations.length);
      expect(row.window.declaredShifts, row.rowId).toBe(row.schedule.shifts.length);
      expect(row.window.declaredSpan, row.rowId).toEqual({
        firstShift: 0,
        lastShift: row.window.declaredShifts - 1,
      });
      expect(row.window.driftTolerancePct, row.rowId).toBe(row.rowId === LIVE_ROW_ID ? 50 : 10);
    }
    // The declared divergences are the ONLY permitted drift: the
    // drifting row declares exactly one (the load-shaping cohort mix at
    // shift 4's daily-usage); the cherry-picked probe mirrors it; every
    // other row declares none.
    expect(rowOf(DRIFT_ROW_ID).window.declaredDivergences).toEqual([
      { shift: 4, stage: "daily-usage", cause: LOAD_SHAPING_COHORT_MIX },
    ]);
    expect(rowOf("probe-pilot-cherry-picked-window").window.declaredDivergences).toEqual([
      { shift: 4, stage: "daily-usage", cause: LOAD_SHAPING_COHORT_MIX },
    ]);
    for (const row of PILOT_CORPUS_ROWS) {
      if (row.rowId !== DRIFT_ROW_ID && row.rowId !== "probe-pilot-cherry-picked-window") {
        expect(row.window.declaredDivergences, row.rowId).toEqual([]);
      }
    }
    // The window digest is deterministic and pins the whole declaration:
    // a post-hoc widened tolerance (10 → 11) changes it mechanically.
    expect(pilotWindowDigestOf(full.window)).toBe(FULL_WINDOW_DIGEST);
    expect(pilotWindowDigestOf(full.window)).toBe(
      pilotWindowDigestOf({
        ...full.window,
        declaredDivergences: [...full.window.declaredDivergences],
      }),
    );
    expect(pilotWindowDigestOf({ ...full.window, driftTolerancePct: 11 })).toBe(
      WIDENED_TOLERANCE_WINDOW_DIGEST,
    );
    expect(
      pilotWindowDigestOf({
        ...full.window,
        declaredSpan: { firstShift: 0, lastShift: 4 },
      }),
    ).not.toBe(FULL_WINDOW_DIGEST);
    // The per-shift recorded bases: the Σ of the journey row's stage
    // economics (the reservation amount the envelope draws against).
    expect(shiftCostBasisOf(scheduledShiftOf(full, 0))).toBe(PORTFOLIO_SHIFT_COST);
    expect(shiftLatencyBasisOf(scheduledShiftOf(full, 0))).toBe(PORTFOLIO_SHIFT_LATENCY_MS);
    expect(shiftCostBasisOf(scheduledShiftOf(cont, 3))).toBe(CONTINUATION_SHIFT_COST);
    expect(shiftLatencyBasisOf(scheduledShiftOf(cont, 3))).toBe(CONTINUATION_SHIFT_LATENCY_MS);
    expect(sumMicroUsd(full.schedule.shifts.map((shift) => shiftCostBasisOf(shift)))).toBe(
      BigInt(FULL_WINDOW_COST),
    );
  });
});

// ---------------------------------------------------------------------------
// The shift scheduler (deterministic, pure derivation)
// ---------------------------------------------------------------------------

describe("VAL-051 the shift scheduler (deterministic, pure derivation)", () => {
  test("schedule determinism + digest", () => {
    const full = rowOf(FULL_ROW_ID);
    // PURE derivation: the same declarations derive the same schedule
    // (deep equality) and the same FNV-1a digest — twice.
    const first = deriveShiftSchedule({ shifts: full.shiftDeclarations });
    const second = deriveShiftSchedule({ shifts: full.shiftDeclarations });
    expect(first).toEqual(second);
    expect(first.scheduleDigest).toBe(second.scheduleDigest);
    expect(first.scheduleDigest).toBe(FULL_SCHEDULE_DIGEST);
    expect(first.scheduleDigest).toMatch(/^[0-9a-f]{8}$/);
    // Every corpus row's pinned schedule digest re-derives from its own
    // declared shift declarations (the pin is never wishful).
    for (const row of PILOT_CORPUS_ROWS) {
      const rederived = deriveShiftSchedule({ shifts: row.shiftDeclarations });
      expect(rederived.scheduleDigest, row.rowId).toBe(row.schedule.scheduleDigest);
    }
    // Different declarations pin different schedules (the continuation
    // row's sixShifts(3) vs the full row's sixShifts()).
    const cont = deriveShiftSchedule({ shifts: rowOf(CONT_ROW_ID).shiftDeclarations });
    expect(cont.scheduleDigest).not.toBe(first.scheduleDigest);
    // The degenerate declaration THROWS (a window declares ≥ 1 shift).
    expect(() => deriveShiftSchedule({ shifts: [] })).toThrow(/declares at least one shift/);
  });

  test("every declared shift lands exactly once", () => {
    const full = rowOf(FULL_ROW_ID);
    const schedule = full.schedule;
    // Six shifts, ordinals 0..5 in schedule order, each replaying the
    // RECORDED full-journey portfolio row, none declaring a failure.
    expect(schedule.shifts).toHaveLength(6);
    expect(schedule.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const shift of schedule.shifts) {
      expect(shift.journeyRowId).toBe("full-journey-recorded-portfolio");
      expect(shift.failureStage).toBeNull();
      // Five segments in the journey's own stage order, one declared
      // attempt each, exactly one resolved attempt each.
      expect(shift.segments.map((segment) => segment.stage)).toEqual([...JOURNEY_STAGES]);
      for (const segment of shift.segments) {
        expect(segment.declaredAttempts).toBe(1);
        expect(segment.recordedResolvedAttempts).toBe(1);
      }
    }
    // The segments carry the journey corpus's OWN stage declarations
    // (the recorded input digests and the audited economics — resolved
    // through `journeyRowById`, never copied).
    const journeyRow = journeyRowById("full-journey-recorded-portfolio");
    expect(journeyRow).not.toBeNull();
    const declared = journeyRow?.stages ?? [];
    const firstShift = schedule.shifts[0];
    expect(firstShift).toBeDefined();
    for (const [index, segment] of (firstShift?.segments ?? []).entries()) {
      const stage = declared[index];
      expect(stage, index).toBeDefined();
      expect(segment.stage, index).toBe(stage?.stage);
      expect(segment.recordedInputDigests, index).toEqual([...(stage?.recordedInputDigests ?? [])]);
      expect(segment.economics, index).toEqual(stage?.economics);
      expect(segment.economics.costMicroUsd, index).toBe(
        RECORDED_STAGE_COST_MICRO_USD[segment.stage],
      );
    }
    // Every declared shift lands exactly once in the honest window
    // record (the completeness oracle PASSES); a DUPLICATED record is
    // NAMED with the ordinal and the record count.
    const observation = observationOf(FULL_ROW_ID);
    const completeness = deriveScheduleCompleteness({ schedule, observation });
    expect(completeness.status).toBe("PASS");
    const duplicated: PilotWindowObservation = {
      ...observation,
      shifts: [...observation.shifts, observedShiftOf(observation, 4)],
    };
    const duplicatedResult = deriveScheduleCompleteness({ schedule, observation: duplicated });
    expect(duplicatedResult.status).toBe("FAIL");
    expect(duplicatedResult.evidence).toContain("duplicated-shift:4 (2 records)");
  });

  test("the declared mid-window failure resumes exactly once (the two recorded attempts)", () => {
    const cont = rowOf(CONT_ROW_ID);
    const schedule = cont.schedule;
    // Shift 3 declares the mid-shift failure at the journey continuation
    // row's OWN recorded failure stage — the two-attempt shape taken
    // from the recorded economics, never synthesized.
    const failureShift = scheduledShiftOf(cont, 3);
    expect(failureShift.journeyRowId).toBe("journey-continuation-resume");
    expect(failureShift.failureStage).toBe("daily-usage");
    for (const segment of failureShift.segments) {
      expect(segment.declaredAttempts, segment.stage).toBe(segment.stage === "daily-usage" ? 2 : 1);
      // Each recorded stage resolves exactly its FINAL attempt — the
      // failed attempt is carried as cost, unresolved.
      expect(segment.recordedResolvedAttempts).toBe(1);
    }
    // The failure stage's recorded economics carry BOTH attempts
    // honestly: 19200microUsd = 2 × 9600, 480ms = 2 × 240.
    const failureSegment = scheduledSegmentOf(cont, 3, "daily-usage");
    expect(failureSegment.economics.costMicroUsd).toBe("19200");
    expect(failureSegment.economics.latencyMs).toBe(480);
    // The honest replay derivation lands exactly the two recorded
    // attempts with the continuation record carrying the failed
    // attempt's per-attempt cost and EXACTLY ONE resume.
    const derived = deriveShiftObservation({
      rowId: cont.rowId,
      scheduled: failureShift,
    });
    const observedFailure = derived.shift.segments.find(
      (segment) => segment.stage === "daily-usage",
    );
    expect(observedFailure).toMatchObject({
      attempts: 2,
      resolved: 1,
      costMicroUsd: "19200",
      latencyMs: 480,
    });
    expect(derived.shift.reportedCostMicroUsd).toBe(CONTINUATION_SHIFT_COST);
    expect(derived.shift.reportedLatencyMs).toBe(CONTINUATION_SHIFT_LATENCY_MS);
    expect(derived.continuation).toEqual({
      shift: 3,
      stage: "daily-usage",
      failedAttemptCostMicroUsd: FAILED_ATTEMPT_COST,
      resumeExecutionId: "pilot-resume-pilot-shift-resume-exactly-once-shift3-daily-usage",
      resumes: 1,
    });
    // The continuation oracle PASSES over the row's own window record,
    // naming the attempt shape verbatim.
    const observation = observationOf(CONT_ROW_ID);
    const continuation = deriveContinuationExactlyOnce({ schedule, observation });
    expect(continuation.status).toBe("PASS");
    expect(continuation.evidence).toContain("declared-failure-shifts:shift 3 daily-usage");
    expect(continuation.evidence).toContain("continuation-records:1");
    expect(continuation.evidence).toContain("shift 3 daily-usage:attempts=2,declared=2");
  });

  test("the schedule digest is pinned at row declaration (post-hoc changes NAMED)", () => {
    const full = rowOf(FULL_ROW_ID);
    const pinned = full.schedule.scheduleDigest;
    expect(pinned).toBe(FULL_SCHEDULE_DIGEST);
    // Every post-hoc edit of a pinned schedule member changes the
    // recomputed digest mechanically — the pin catches each one.
    const swappedWorkload = full.schedule.shifts.map((shift) =>
      shift.shift === 2 ? { ...shift, journeyRowId: "journey-continuation-resume" } : shift,
    );
    expect(scheduleDigestOf({ shifts: swappedWorkload })).not.toBe(pinned);
    const injectedFailure = full.schedule.shifts.map((shift) =>
      shift.shift === 3 ? { ...shift, failureStage: "daily-usage" } : shift,
    );
    expect(scheduleDigestOf({ shifts: injectedFailure })).not.toBe(pinned);
    const rewrittenCost = full.schedule.shifts.map((shift) =>
      shift.shift === 0
        ? {
            ...shift,
            segments: shift.segments.map((segment) =>
              segment.stage === "onboarding"
                ? {
                    ...segment,
                    economics: { ...segment.economics, costMicroUsd: "1201" },
                  }
                : segment,
            ),
          }
        : shift,
    );
    expect(scheduleDigestOf({ shifts: rewrittenCost })).not.toBe(pinned);
    const rewrittenAttempts = full.schedule.shifts.map((shift) =>
      shift.shift === 5
        ? {
            ...shift,
            segments: shift.segments.map((segment) =>
              segment.stage === "plan" ? { ...segment, declaredAttempts: 2 } : segment,
            ),
          }
        : shift,
    );
    expect(scheduleDigestOf({ shifts: rewrittenAttempts })).not.toBe(pinned);
    // The row driver RECOMPUTES the schedule digest from the schedule it
    // is handed — a drifted schedule is visible at the result level.
    const result = drivePilotRow({
      rowId: full.rowId,
      window: full.window,
      schedule: full.schedule,
      policy: full.operatingProfile,
      observation: observationOf(FULL_ROW_ID),
    });
    expect(result.scheduleDigest).toBe(scheduleDigestOf({ shifts: full.schedule.shifts }));
    expect(result.scheduleDigest).toBe(pinned);
    // A post-hoc rewrite of the OBSERVED record's workload reference is
    // NAMED by the completeness oracle (workload substitution).
    const observation = observationOf(FULL_ROW_ID);
    const substituted: PilotWindowObservation = {
      ...observation,
      shifts: observation.shifts.map((shift) =>
        shift.shift === 2 ? { ...shift, journeyRowId: "journey-continuation-resume" } : shift,
      ),
    };
    const completeness = deriveScheduleCompleteness({
      schedule: full.schedule,
      observation: substituted,
    });
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain(
      "workload-substitution:shift 2 (journey journey-continuation-resume, declared full-journey-recorded-portfolio)",
    );
  });
});

// ---------------------------------------------------------------------------
// Continuation exactly-once
// ---------------------------------------------------------------------------

describe("VAL-051 continuation exactly-once", () => {
  test("a declared resume continues exactly once", () => {
    const cont = rowOf(CONT_ROW_ID);
    const observation = observationOf(CONT_ROW_ID);
    // Exactly ONE continuation record, exactly ONE resume, with a unique
    // durable execution id for the resume.
    expect(observation.continuations).toHaveLength(1);
    const continuation = observation.continuations[0];
    expect(continuation).toMatchObject({
      shift: 3,
      stage: "daily-usage",
      failedAttemptCostMicroUsd: FAILED_ATTEMPT_COST,
      resumes: 1,
    });
    // The failed attempt's cost is carried honestly, never hidden: the
    // failure shift's reported total (23100) holds the portfolio shift's
    // 13500 PLUS the failed attempt's 9600.
    expect(observedShiftOf(observation, 3).reportedCostMicroUsd).toBe(CONTINUATION_SHIFT_COST);
    expect(BigInt(CONTINUATION_SHIFT_COST) - BigInt(PORTFOLIO_SHIFT_COST)).toBe(
      BigInt(FAILED_ATTEMPT_COST),
    );
    expect(BigInt(continuation?.failedAttemptCostMicroUsd ?? "0")).toBeGreaterThan(0n);
    // The failure is recorded AND attributed in the incident log.
    expect(observation.incidents).toHaveLength(1);
    expect(incidentOf(observation, 3, "daily-usage").attributionClass).toBe("provider-unavailable");
    // The row COMPLETES: continuation exactly-once is the recorded basis
    // itself, so the honest two-attempt window PASSES the oracle.
    const result = pilotRowResultFor(cont);
    expect(result.terminal).toBe("PILOT-COMPLETED");
    expect(result.failedCriteria).toEqual([]);
    const continuationCriterion = result.criteria.find(
      (criterion) => criterion.criterionId === "continuation-exactly-once",
    );
    expect(continuationCriterion?.status).toBe("PASS");
  });

  test("a dropped shift NAMED", () => {
    const cont = rowOf(CONT_ROW_ID);
    const schedule = cont.schedule;
    const observation = observationOf(CONT_ROW_ID);
    // The declared failure shift never landing: its resume never
    // continued — NAMED with the shift and the missing continuation.
    const dropped = omitShiftsFromWindowRecord(cont, observation, [3]);
    const droppedResult = deriveContinuationExactlyOnce({ schedule, observation: dropped });
    expect(droppedResult.status).toBe("FAIL");
    expect(droppedResult.evidence).toContain(
      "dropped-resume-shift:shift 3 (the declared failure shift never landed — its resume never continued)",
    );
    expect(droppedResult.evidence).toContain(
      "missing-continuation-record:shift 3 daily-usage (the resume never recorded its continuation)",
    );
    // The attempts shape: the failed stage observed with only ONE
    // attempt — the failed attempt never resumed — NAMED verbatim.
    const attemptDropped: PilotWindowObservation = {
      ...observation,
      shifts: observation.shifts.map((shift) =>
        shift.shift === 3
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "daily-usage" ? { ...segment, attempts: 1 } : segment,
              ),
            }
          : shift,
      ),
    };
    const attemptDroppedResult = deriveContinuationExactlyOnce({
      schedule,
      observation: attemptDropped,
    });
    expect(attemptDroppedResult.status).toBe("FAIL");
    expect(attemptDroppedResult.evidence).toContain(
      "dropped-resume:shift 3 daily-usage (attempts=1, expected exactly 2 — the failed attempt never resumed)",
    );
    // The row driver FAILs the dropped-shift window with the criterion NAMED.
    const driven = drivePilotRow({
      rowId: cont.rowId,
      window: cont.window,
      schedule,
      policy: cont.operatingProfile,
      observation: dropped,
    });
    expect(driven.terminal).toBe("PILOT-FAILED");
    expect(driven.failedCriteria).toContain("continuation-exactly-once");
  });

  test("a double-driven resume NAMED", () => {
    const cont = rowOf(CONT_ROW_ID);
    const schedule = cont.schedule;
    const observation = observationOf(CONT_ROW_ID);
    // The resume driven TWICE: three attempts land for the failed stage
    // (the recorded basis holds exactly two) and the continuation ledger
    // records the two resumes — both NAMED verbatim with the counts.
    const doubleDriven = doubleDriveResumeInWindowRecord(cont, observation);
    const doubleDrivenResult = deriveContinuationExactlyOnce({
      schedule,
      observation: doubleDriven,
    });
    expect(doubleDrivenResult.status).toBe("FAIL");
    expect(doubleDrivenResult.evidence).toContain(
      "double-driven-resume:shift 3 daily-usage (attempts=3, expected exactly 2 — the resume was driven 2 times)",
    );
    expect(doubleDrivenResult.evidence).toContain(
      "double-driven-resume:shift 3 daily-usage (resumes=2, expected exactly 1)",
    );
    expect(doubleDrivenResult.evidence).toContain("shift 3 daily-usage:attempts=3,declared=2");
    // The third attempt's cost is carried honestly (28800 over the
    // recorded 19200) — never hidden, and it FAILs the reconciliation.
    const driven = drivePilotRow({
      rowId: cont.rowId,
      window: cont.window,
      schedule,
      policy: cont.operatingProfile,
      observation: doubleDriven,
    });
    expect(driven.terminal).toBe("PILOT-FAILED");
    expect(driven.failedCriteria).toEqual([
      "continuation-exactly-once",
      "end-of-window-reconciliation",
    ]);
    // The corpus's own probe row derives the SAME named catch (the
    // issued probe 1:1 — the forced lane never invents a new shape).
    const probe = pilotRowResultFor(rowOf("probe-pilot-double-driven-resume"));
    expect(probe.terminal).toBe("PILOT-FAILED");
    expect(probe.failedCriteria).toEqual([
      "continuation-exactly-once",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf("probe-pilot-double-driven-resume", "continuation-exactly-once")).toContain(
      "double-driven-resume:shift 3 daily-usage (attempts=3, expected exactly 2 — the resume was driven 2 times)",
    );
  });
});

// ---------------------------------------------------------------------------
// The window-wide budget/policy envelope
// ---------------------------------------------------------------------------

describe("VAL-051 the window-wide budget/policy envelope", () => {
  test("reservations settle at end-of-window", () => {
    const full = rowOf(FULL_ROW_ID);
    // Every honest row: one reservation per shift at the shift's
    // reported cost, ONE authorized spend citing it and ONE settlement —
    // three append-only lines per shift, every reservation SETTLED (no
    // dangling held reservation at end-of-window).
    for (const rowId of HONEST_ROW_IDS) {
      const observation = observationOf(rowId);
      const reservations = reservationsOf(observation.ledger);
      expect(reservations, rowId).toHaveLength(observation.shifts.length);
      expect(
        reservations.filter((reservation) => reservation.state === "held"),
        rowId,
      ).toEqual([]);
      for (const reservation of reservations) {
        expect(reservation.state, `${rowId}/${reservation.reservationId}`).toBe("settled");
        const shift = observedShiftOf(observation, reservation.shift);
        expect(reservation.settledMicroUsd, `${rowId}/${reservation.reservationId}`).toBe(
          shift.reportedCostMicroUsd,
        );
      }
      expect(observation.ledger.length, rowId).toBe(3 * observation.shifts.length);
    }
    // The full row's envelope evidence, numerically pinned: the six
    // settled reservations and the 81000 total spent.
    const evidence = evidenceOf(FULL_ROW_ID, "budget-policy-envelope");
    expect(evidence).toContain("cost-budget-microUsd:162000");
    expect(evidence).toContain("admission-policy:admit-all-scheduled");
    expect(evidence).toContain(
      "reservation:pilot-resv-pilot-window-full-recorded-portfolio-shift0 shift 0 13500microUsd settled",
    );
    expect(evidence).toContain("total-spent-microUsd:81000");
    // A DANGLING reservation (held at end-of-window) FAILs NAMED with
    // the reservation, the shift and the held amount.
    const observation = observationOf(FULL_ROW_ID);
    const danglingLedger = observation.ledger.filter(
      (line) => line.kind === "reservation" && line.shift === 0,
    );
    const dangling = deriveBudgetPolicyEnvelopeIntegrity({
      policy: full.operatingProfile,
      observation: { ...observation, ledger: danglingLedger },
    });
    expect(dangling.status).toBe("FAIL");
    expect(dangling.evidence).toContain(
      "dangling-reservation:pilot-resv-pilot-window-full-recorded-portfolio-shift0 (shift 0, 13500microUsd still held at end-of-window — every reservation settles or releases)",
    );
  });

  test("an unauthorized/off-ledger spend NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // An UNAUTHORIZED spend: a correctly-chained spend line citing a
    // reservation that was never opened before it FAILs NAMED (the
    // chain itself holds — the catch is the envelope discipline).
    const basis = ledgerBasisDigestOf(full.operatingProfile);
    const unauthorizedLedger = appendLedgerLine(
      [],
      basis,
      "spend",
      0,
      PORTFOLIO_SHIFT_COST,
      `pilot-resv-${FULL_ROW_ID}-shift0`,
    );
    const unauthorized = deriveBudgetPolicyEnvelopeIntegrity({
      policy: full.operatingProfile,
      observation: { ...observation, ledger: unauthorizedLedger },
    });
    expect(unauthorized.status).toBe("FAIL");
    expect(unauthorized.evidence).toContain(
      "unauthorized-spend:ordinal 1 (amount 13500microUsd cites reservation pilot-resv-pilot-window-full-recorded-portfolio-shift0 never opened before it)",
    );
    // An OFF-LEDGER spend: the observed shift's cost never entered the
    // ledger (no reservation ever opened for the shift) — the chain
    // still holds, the envelope catch is NAMED with the amount.
    const offLedger = deriveBudgetPolicyEnvelopeIntegrity({
      policy: full.operatingProfile,
      observation: {
        ...observation,
        ledger: observation.ledger.filter((line) => line.shift !== 5),
      },
    });
    expect(offLedger.status).toBe("FAIL");
    expect(offLedger.evidence).toContain(
      "off-ledger-spend:shift 5 (observed cost 13500microUsd with no reservation ever opened for the shift — the window envelope never authorized it)",
    );
    // The honest writer never writes either shape: a spend citing an
    // unknown reservation THROWS; a refused id authorizes nothing.
    const writer = createWindowLedger(full.operatingProfile);
    expect(() => writer.spend({ reservationId: "never-opened", amountMicroUsd: "1" })).toThrow(
      /no reservation never-opened/,
    );
    const tightWriter = createWindowLedger({
      costBudgetMicroUsd: PORTFOLIO_SHIFT_COST,
      latencyBudgetMsPerShift: PORTFOLIO_SHIFT_LATENCY_MS,
      admissionPolicy: "admit-within-budget",
    });
    expect(
      tightWriter.reserve({ shift: 0, reservationId: "r0", amountMicroUsd: PORTFOLIO_SHIFT_COST }),
    ).toEqual({ admitted: true });
    expect(
      tightWriter.reserve({ shift: 1, reservationId: "r1", amountMicroUsd: PORTFOLIO_SHIFT_COST }),
    ).toEqual({ admitted: false });
    expect(tightWriter.lines().map((line) => `${line.ordinal}:${line.kind}`)).toEqual([
      "1:reservation",
      "2:refusal",
    ]);
    // A spend citing the REFUSED id FAILs NAMED with the refusal named.
    const refusedSpend = appendLedgerLine(
      tightWriter.lines(),
      ledgerBasisDigestOf({
        costBudgetMicroUsd: PORTFOLIO_SHIFT_COST,
        latencyBudgetMsPerShift: PORTFOLIO_SHIFT_LATENCY_MS,
        admissionPolicy: "admit-within-budget",
      }),
      "spend",
      1,
      PORTFOLIO_SHIFT_COST,
      "r1",
    );
    const refused = deriveBudgetPolicyEnvelopeIntegrity({
      policy: {
        costBudgetMicroUsd: PORTFOLIO_SHIFT_COST,
        latencyBudgetMsPerShift: PORTFOLIO_SHIFT_LATENCY_MS,
        admissionPolicy: "admit-within-budget",
      },
      observation: { ...observation, ledger: refusedSpend },
    });
    expect(refused.status).toBe("FAIL");
    expect(refused.evidence).toContain(
      "unauthorized-spend:ordinal 3 (amount 13500microUsd cites reservation r1 never opened before it — the reservation was REFUSED)",
    );
  });

  test("the append-only ledger digest chain holds", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    const basis = ledgerBasisDigestOf(full.operatingProfile);
    // Every honest row's ledger chain holds over its own basis: every
    // ordinal strictly follows, every line's digest recomputes over its
    // own content, every chain link equals the previous line's digest.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const rowObservation = observationOf(rowId);
      const chain = ledgerChainHolds({
        lines: rowObservation.ledger,
        basis: ledgerBasisDigestOf(row.operatingProfile),
      });
      expect(chain, rowId).toEqual({ holds: true, breakOrdinal: null });
      for (const [index, line] of rowObservation.ledger.entries()) {
        expect(line.ordinal, `${rowId}/line${index}`).toBe(index + 1);
        expect(line.previousDigest, `${rowId}/line${index}`).toBe(
          index === 0
            ? ledgerBasisDigestOf(row.operatingProfile)
            : rowObservation.ledger[index - 1]?.lineDigest,
        );
      }
    }
    const lines = observation.ledger;
    // TAMPER 1 — an ERASED line (ordinal 2 removed): the chain breaks
    // at the NAMED ordinal (the first line after the gap).
    const erased = lines.filter((line) => line.ordinal !== 2);
    expect(ledgerChainHolds({ lines: erased, basis })).toEqual({ holds: false, breakOrdinal: 3 });
    // TAMPER 2 — a REWRITTEN line (ordinal 3's amount edited without
    // recomputing its digest): the chain breaks at the NAMED ordinal.
    const rewritten = lines.map((line) =>
      line.ordinal === 3 ? { ...line, amountMicroUsd: "999" } : line,
    );
    expect(ledgerChainHolds({ lines: rewritten, basis })).toEqual({
      holds: false,
      breakOrdinal: 3,
    });
    // TAMPER 3 — REORDERED lines (ordinals 2 and 3 swapped): the chain
    // breaks at the NAMED ordinal.
    const reordered = [...lines];
    const swap = reordered[1];
    reordered[1] = reordered[2];
    reordered[2] = swap;
    expect(ledgerChainHolds({ lines: reordered, basis })).toEqual({
      holds: false,
      breakOrdinal: 3,
    });
    // Each tamper drives the envelope oracle to FAIL with the break
    // NAMED at its ordinal.
    for (const tampered of [erased, rewritten, reordered]) {
      const result = deriveBudgetPolicyEnvelopeIntegrity({
        policy: full.operatingProfile,
        observation: { ...observation, ledger: tampered },
      });
      expect(result.status).toBe("FAIL");
      expect(result.evidence).toContain(
        "ledger-chain-broken:ordinal 3 (the append-only digest chain breaks here — an erased, rewritten or reordered line)",
      );
    }
    // The writer's own append-only discipline: a reservation id is
    // admitted at most once (re-admission THROWS).
    const writer = createWindowLedger(full.operatingProfile);
    writer.reserve({ shift: 0, reservationId: "resv-a", amountMicroUsd: "1000" });
    expect(() =>
      writer.reserve({ shift: 0, reservationId: "resv-a", amountMicroUsd: "1000" }),
    ).toThrow(/was already admitted/);
  });

  test("a window-wide budget breach NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // An over-budget window: the spends total 81000 against a 1000
    // budget — FAILs NAMED with BOTH amounts (over by 80000).
    const overBudget = deriveBudgetPolicyEnvelopeIntegrity({
      policy: { ...full.operatingProfile, costBudgetMicroUsd: "1000" },
      observation,
    });
    expect(overBudget.status).toBe("FAIL");
    expect(overBudget.evidence).toContain(
      "over-budget-spend:81000microUsd spent over the window budget 1000microUsd (over by 80000microUsd)",
    );
    // The policy's per-shift latency bound holds across the ENTIRE
    // window — a breach is NAMED per shift with both numbers.
    const latencyBreach = deriveBudgetPolicyEnvelopeIntegrity({
      policy: { ...full.operatingProfile, latencyBudgetMsPerShift: 100 },
      observation,
    });
    expect(latencyBreach.status).toBe("FAIL");
    for (const shift of [0, 1, 2, 3, 4, 5]) {
      expect(latencyBreach.evidence).toContain(
        `latency-budget-breach:shift ${shift} (reported 400ms over the policy bound 100ms)`,
      );
    }
    // The tight row never breaches: 81000 spent EXACTLY on the 81000
    // budget (zero headroom) with the 400ms latency on the 400ms bound.
    const tight = rowOf(TIGHT_ROW_ID);
    const tightResult = deriveBudgetPolicyEnvelopeIntegrity({
      policy: tight.operatingProfile,
      observation: observationOf(TIGHT_ROW_ID),
    });
    expect(tightResult.status).toBe("PASS");
    expect(tightResult.evidence).toContain("cost-budget-microUsd:81000");
    expect(tightResult.evidence).toContain("total-spent-microUsd:81000");
    // The honest writer enforces the window-wide budget itself: a spend
    // escaping the budget THROWS (never a silent over-spend).
    const writer = createWindowLedger({ ...full.operatingProfile, costBudgetMicroUsd: "1000" });
    writer.reserve({ shift: 0, reservationId: "resv-b", amountMicroUsd: "1000" });
    expect(() => writer.spend({ reservationId: "resv-b", amountMicroUsd: "1001" })).toThrow(
      /escapes reservation/,
    );
    expect(() => writer.spend({ reservationId: "resv-b", amountMicroUsd: "1" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Incident capture + attribution
// ---------------------------------------------------------------------------

describe("VAL-051 incident capture + attribution", () => {
  test("every incident recorded", () => {
    const contObservation = observationOf(CONT_ROW_ID);
    const incidentObservation = observationOf(INCIDENT_ROW_ID);
    const regrObservation = observationOf(REGR_ROW_ID);
    // The incident log holds the declared incidents: one for the
    // continuation row's failure, two for the incident row (the failure
    // + the injected tool-class incident), one for the regressing row's
    // unresolved attempt.
    expect(contObservation.incidents).toHaveLength(1);
    expect(incidentObservation.incidents).toHaveLength(2);
    expect(regrObservation.incidents).toHaveLength(1);
    expect(incidentOf(incidentObservation, 2, "daily-usage")).toMatchObject({
      attributionClass: "provider-unavailable",
      magnitudeMicroUsd: FAILED_ATTEMPT_COST,
    });
    expect(incidentOf(incidentObservation, 4, "plan")).toMatchObject({
      attributionClass: "tool-failure",
      magnitudeMicroUsd: "1500",
    });
    // The unresolved attempt IS the recorded incident: shift 5's
    // daily-usage lands one attempt, none resolved, and the log holds
    // its attributed record (the provider's empty completion).
    const unresolved = observedSegmentOf(regrObservation, 5, "daily-usage");
    expect(unresolved.attempts).toBe(1);
    expect(unresolved.resolved).toBe(0);
    expect(incidentOf(regrObservation, 5, "daily-usage").attributionClass).toBe("empty-completion");
    // The oracle PASSES over each honest row, with the log count and
    // its digest seal in the evidence.
    for (const [rowId, count] of [
      [CONT_ROW_ID, 1],
      [INCIDENT_ROW_ID, 2],
      [REGR_ROW_ID, 1],
    ] as const) {
      const honesty = deriveIncidentHonesty({ observation: observationOf(rowId) });
      expect(honesty.status, rowId).toBe("PASS");
      expect(honesty.evidence, rowId).toContain(`incident-log:${count} record(s)`);
    }
    // The log's digest seal is deterministic (append-only, pinned).
    expect(incidentLogDigestOf(contObservation.incidents)).toBe(
      incidentLogDigestOf([...contObservation.incidents]),
    );
    expect(incidentLogDigestOf(contObservation.incidents)).toBe(CONTINUATION_INCIDENT_LOG_DIGEST);
    expect(incidentLogDigestOf(incidentObservation.incidents)).toBe(
      INCIDENT_ROW_INCIDENT_LOG_DIGEST,
    );
    expect(incidentLogDigestOf(contObservation.incidents)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("every incident attributed (root-cause class NAMED)", () => {
    // Every incident in every offline observation carries a class from
    // the IMPORTED VAL-020 taxonomy with a disposition honoring the
    // class's retryability discipline, and a numeric magnitude.
    for (const row of OFFLINE_CORPUS_ROWS) {
      const observation = observationOf(row.rowId);
      for (const record of observation.incidents) {
        expect(isKnownAttributionClass(record.attributionClass), `${row.rowId}`).toBe(true);
        expect(
          dispositionIsValidFor(record.attributionClass, record.disposition.kind),
          `${row.rowId}/${record.shift}/${record.stage}`,
        ).toBe(true);
        expect(record.magnitudeMicroUsd, `${row.rowId}/${record.shift}/${record.stage}`).toMatch(
          /^[0-9]+$/,
        );
        expect(record.disposition.detailDigest).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // The evidence names the class AND its layer through the imported
    // taxonomy's own table — payload-free, magnitude carried.
    const contEvidence = evidenceOf(CONT_ROW_ID, "incident-honesty");
    expect(contEvidence).toContain(
      "incident:shift 3 daily-usage (provider-unavailable@provider, magnitude 9600microUsd, bounded-retry)",
    );
    const incidentEvidence = evidenceOf(INCIDENT_ROW_ID, "incident-honesty");
    expect(incidentEvidence).toContain(
      "incident:shift 2 daily-usage (provider-unavailable@provider, magnitude 9600microUsd, bounded-retry)",
    );
    expect(incidentEvidence).toContain(
      "incident:shift 4 plan (tool-failure@tool, magnitude 1500microUsd, escalated)",
    );
    // The regressing row's accepted-risk record (the empty completion is
    // an honest non-error, named with its layer).
    expect(evidenceOf(REGR_ROW_ID, "incident-honesty")).toContain(
      "incident:shift 5 daily-usage (empty-completion@provider, magnitude 9600microUsd, accepted-risk)",
    );
    // The evidence line builder itself is payload-free and NAMED.
    const contObservation = observationOf(CONT_ROW_ID);
    expect(incidentEvidenceOf(incidentOf(contObservation, 3, "daily-usage"))).toBe(
      "incident:shift 3 daily-usage (provider-unavailable@provider, magnitude 9600microUsd, bounded-retry)",
    );
  });

  test("a hidden incident NAMED", () => {
    const probeRowId = "probe-pilot-incident-hiding";
    const probe = rowOf(probeRowId);
    const observation = observationOf(probeRowId);
    // The timeline still holds the declared failure (two attempts, one
    // resolved) and its exactly-once resume, but the log omits the
    // incident — BOTH hidden-incident catches fire, NAMED verbatim.
    const honesty = deriveIncidentHonesty({ observation });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      "hidden-incident:shift 2 daily-usage (attempts=2, resolved=1 — the timeline holds 1 unresolved attempt(s), the log omits the incident)",
    );
    expect(honesty.evidence).toContain(
      "hidden-incident:shift 2 daily-usage (the timeline holds the declared failure and its exactly-once resume, the log omits the incident)",
    );
    // The log still holds the OTHER incident (shift 4's escalated
    // tool-class record) — hiding one incident never hides them all.
    expect(incidentOf(observation, 4, "plan").attributionClass).toBe("tool-failure");
    // The row driver FAILs the probe with incident-honesty NAMED (the
    // hidden cost co-FAILs the reconciliation).
    const result = pilotRowResultFor(probe);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(["incident-honesty", "end-of-window-reconciliation"]);
  });

  test("an unattributed incident NAMED", () => {
    const contObservation = observationOf(CONT_ROW_ID);
    // An UNATTRIBUTED incident (no root-cause class) FAILs NAMED.
    const unattributed: PilotWindowObservation = {
      ...contObservation,
      incidents: contObservation.incidents.map((record) => ({
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
      ...contObservation,
      incidents: contObservation.incidents.map((record) => ({
        ...record,
        attributionClass: "not-a-real-class" as AttributionClass,
      })),
    };
    const foreignResult = deriveIncidentHonesty({ observation: foreign });
    expect(foreignResult.status).toBe("FAIL");
    expect(foreignResult.evidence).toContain(
      "taxonomy-foreign-attribution:shift 3 daily-usage (class not-a-real-class is foreign to the imported VAL-020 taxonomy)",
    );
    // An INVALID disposition (a non-retryable class carrying the bounded
    // retry) FAILs NAMED with the class, its layer and the discipline.
    const invalidDisposition: PilotWindowObservation = {
      ...contObservation,
      incidents: contObservation.incidents.map((record) => ({
        ...record,
        attributionClass: "tool-failure",
        disposition: {
          ...record.disposition,
          kind: "bounded-retry" as IncidentDispositionKind,
        },
      })),
    };
    const invalidDispositionResult = deriveIncidentHonesty({ observation: invalidDisposition });
    expect(invalidDispositionResult.status).toBe("FAIL");
    expect(invalidDispositionResult.evidence).toContain(
      "invalid-disposition:shift 3 daily-usage (tool-failure@tool carries bounded-retry — a retryable class carries its bounded disposition, a non-retryable class its escalation or accepted-risk record)",
    );
  });
});

// ---------------------------------------------------------------------------
// Drift classification vs the VAL-049 recorded basis
// ---------------------------------------------------------------------------

describe("VAL-051 drift classification vs the VAL-049 recorded basis", () => {
  /** One handcrafted observed segment at a declared cost/latency drift. */
  function observedDailyUsageAt(
    costDriftPct: number,
    latencyDriftPct: number,
  ): ObservedShiftSegment {
    const basis = scheduledSegmentOf(rowOf(FULL_ROW_ID), 0, "daily-usage");
    const basisCost = BigInt(basis.economics.costMicroUsd);
    return {
      shift: 0,
      stage: "daily-usage",
      attempts: basis.declaredAttempts,
      resolved: basis.recordedResolvedAttempts,
      costMicroUsd: (basisCost + (basisCost * BigInt(costDriftPct)) / 100n).toString(),
      latencyMs:
        basis.economics.latencyMs + Math.trunc((basis.economics.latencyMs * latencyDriftPct) / 100),
      basisDigest: basis.economics.basisDigest,
      applicationId: PILOT_CUSTOMER_APPLICATION_ID,
    };
  }

  test("within-declared-bounds", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // The full window sits EXACTLY on the recorded basis: every derived
    // drift is within-declared-bounds on every dimension, and every
    // observed segment carries its claimed classification (30 of them).
    const drifts = deriveWindowDrift({ window: full.window, schedule: full.schedule, observation });
    expect(drifts).toHaveLength(30);
    for (const drift of drifts) {
      expect(drift.classification, `${drift.shift}/${drift.stage}`).toBe("within-declared-bounds");
      expect(drift.beyondTolerance, `${drift.shift}/${drift.stage}`).toBe(false);
      expect(drift.mechanism).toBeNull();
    }
    expect(observation.claimedDrift).toHaveLength(30);
    for (const claim of observation.claimedDrift) {
      expect(claim.claimed).toBe("within-declared-bounds");
      expect(claim.mechanism).toBeNull();
    }
    // The tolerance is INCLUSIVE: a segment drifting exactly 10% on both
    // dimensions (economics AND latency) still sits within bounds.
    const atTolerance = deriveSegmentDrift({
      window: full.window,
      shift: 0,
      segment: scheduledSegmentOf(full, 0, "daily-usage"),
      observed: observedDailyUsageAt(10, 10),
    });
    expect(atTolerance.classification).toBe("within-declared-bounds");
    expect(atTolerance.economicsDriftPct).toBe(10);
    expect(atTolerance.latencyDriftPct).toBe(10);
    expect(atTolerance.beyondDimensions).toEqual([]);
    // A BELOW-basis drift (-5%) is measured by its magnitude, within bounds.
    const belowBasis = deriveSegmentDrift({
      window: full.window,
      shift: 0,
      segment: scheduledSegmentOf(full, 0, "daily-usage"),
      observed: observedDailyUsageAt(-5, 0),
    });
    expect(belowBasis.classification).toBe("within-declared-bounds");
    expect(belowBasis.economicsDriftPct).toBe(5);
    // The honesty oracle PASSES with the tolerance and claim count pinned.
    const honesty = deriveDriftClassificationHonesty({
      window: full.window,
      schedule: full.schedule,
      observation,
    });
    expect(honesty.status).toBe("PASS");
    expect(honesty.evidence).toContain("drift-tolerance-pct:10");
    expect(honesty.evidence).toContain("claimed-classifications:30");
    // The claim coverage discipline: a segment observed without its
    // claim FAILs NAMED; a claim over an unobserved segment FAILs NAMED.
    const unclaimed: PilotWindowObservation = {
      ...observation,
      claimedDrift: observation.claimedDrift.slice(0, -1),
    };
    const unclaimedResult = deriveDriftClassificationHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: unclaimed,
    });
    expect(unclaimedResult.status).toBe("FAIL");
    expect(unclaimedResult.evidence).toContain(
      "unclaimed-segment:shift 5 outcome (every observed segment carries its claimed classification)",
    );
    const unobservedClaim: PilotWindowObservation = {
      ...observation,
      claimedDrift: [
        ...observation.claimedDrift,
        { shift: 9, stage: "plan", claimed: "within-declared-bounds", mechanism: null },
      ],
    };
    const unobservedResult = deriveDriftClassificationHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: unobservedClaim,
    });
    expect(unobservedResult.status).toBe("FAIL");
    expect(unobservedResult.evidence).toContain(
      "unobserved-claim:shift 9 plan (a classification claimed over a segment the window never observed)",
    );
  });

  test("drifting-with-mechanism NAMED", () => {
    const drift = rowOf(DRIFT_ROW_ID);
    const observation = observationOf(DRIFT_ROW_ID);
    // Shift 4's daily-usage drifts beyond the tolerance WITH the cause
    // declared: the derived classification is `drifting`, the mechanism
    // NAMED, the beyond dimension NAMED (economics 25%).
    const finding = deriveWindowDrift({
      window: drift.window,
      schedule: drift.schedule,
      observation,
    }).find((candidate) => candidate.beyondTolerance);
    expect(finding).toEqual({
      shift: 4,
      stage: "daily-usage",
      classification: "drifting",
      mechanism: LOAD_SHAPING_COHORT_MIX,
      economicsDriftPct: 25,
      latencyDriftPct: 0,
      resolvedQualityDriftPct: 0,
      beyondTolerance: true,
      beyondDimensions: ["economics"],
    });
    // The claim equals the derived classification with the SAME
    // mechanism (claimed == derived, mechanically) — and the row
    // COMPLETES (an honest drifting finding never FAILs a window).
    const claim = observation.claimedDrift.find(
      (candidate) => candidate.claimed !== "within-declared-bounds",
    );
    expect(claim).toEqual({
      shift: 4,
      stage: "daily-usage",
      claimed: "drifting",
      mechanism: LOAD_SHAPING_COHORT_MIX,
    });
    const honesty = deriveDriftClassificationHonesty({
      window: drift.window,
      schedule: drift.schedule,
      observation,
    });
    expect(honesty.status).toBe("PASS");
    expect(honesty.evidence).toContain(
      "derived:shift 4 daily-usage → drifting via load-shaping cohort mix (economics 25%, latency 0%, resolved-quality 0%)",
    );
    // The reconciliation carries the drift as the DECLARED, named delta
    // (never an unexplained residual): observed 12000 over the recorded
    // 9600, delta 2400 via the load-shaping cohort mix.
    const reconciliation = deriveEndOfWindowReconciliation({
      window: drift.window,
      schedule: drift.schedule,
      observation,
    });
    expect(reconciliation.status).toBe("PASS");
    expect(reconciliation.evidence).toContain(
      `declared-delta:shift 4 daily-usage (observed ${DRIFTING_STAGE_OBSERVED_COST}microUsd, recorded 9600microUsd, delta ${DECLARED_DRIFT_DELTA}microUsd via ${LOAD_SHAPING_COHORT_MIX} — the declared divergence carried as the honest delta)`,
    );
    expect(observedSegmentOf(observation, 4, "daily-usage").costMicroUsd).toBe(
      DRIFTING_STAGE_OBSERVED_COST,
    );
    expect(observation.reported.totalCostMicroUsd).toBe(DRIFTING_WINDOW_COST);
    expect(pilotRowResultFor(drift).terminal).toBe("PILOT-COMPLETED");
  });

  test("regressing reported as regressing (never normalized)", () => {
    const regr = rowOf(REGR_ROW_ID);
    const observation = observationOf(REGR_ROW_ID);
    // Shift 5's daily-usage regresses beyond the tolerance UNdeclared
    // (the resolved quality collapses: one attempt, none resolved): the
    // derived classification is `regressing` with NO mechanism.
    const finding = deriveWindowDrift({
      window: regr.window,
      schedule: regr.schedule,
      observation,
    }).find((candidate) => candidate.beyondTolerance);
    expect(finding).toEqual({
      shift: 5,
      stage: "daily-usage",
      classification: "regressing",
      mechanism: null,
      economicsDriftPct: 0,
      latencyDriftPct: 0,
      resolvedQualityDriftPct: 100,
      beyondTolerance: true,
      beyondDimensions: ["resolved-quality"],
    });
    // The observation lane claims EXACTLY the derived regression —
    // never a normalization, never a hidden regression — and the row
    // COMPLETES with the finding named in the criteria's own evidence.
    const claim = observation.claimedDrift.find(
      (candidate) => candidate.claimed !== "within-declared-bounds",
    );
    expect(claim).toEqual({
      shift: 5,
      stage: "daily-usage",
      claimed: "regressing",
      mechanism: null,
    });
    const honesty = deriveDriftClassificationHonesty({
      window: regr.window,
      schedule: regr.schedule,
      observation,
    });
    expect(honesty.status).toBe("PASS");
    expect(honesty.evidence).toContain(
      "derived:shift 5 daily-usage → regressing (economics 0%, latency 0%, resolved-quality 100%)",
    );
    expect(pilotRowResultFor(regr).terminal).toBe("PILOT-COMPLETED");
    // An UNDECLARED economics drift beyond the tolerance derives
    // `regressing` (11% over the 10% tolerance, no declared divergence).
    const beyond = deriveSegmentDrift({
      window: regr.window,
      shift: 0,
      segment: scheduledSegmentOf(rowOf(FULL_ROW_ID), 0, "daily-usage"),
      observed: {
        shift: 0,
        stage: "daily-usage",
        attempts: 1,
        resolved: 1,
        costMicroUsd: "10656", // 9600 + 11% (truncated BigInt arithmetic)
        latencyMs: 240,
        basisDigest: STAGE_BASIS_DIGESTS["daily-usage"],
        applicationId: PILOT_CUSTOMER_APPLICATION_ID,
      },
    });
    expect(beyond.classification).toBe("regressing");
    expect(beyond.mechanism).toBeNull();
    expect(beyond.beyondDimensions).toEqual(["economics"]);
    expect(beyond.economicsDriftPct).toBe(11);
  });

  test("a normalized drift / hidden regression FAILs NAMED with segment AND mechanism", () => {
    const drift = rowOf(DRIFT_ROW_ID);
    const driftObservation = observationOf(DRIFT_ROW_ID);
    // The NORMALIZED DRIFT shape: the record carries the real drifted
    // economics while the claim says within-declared-bounds — FAILs
    // NAMED with the segment AND the mechanism (the derived drifting
    // cause) AND the drifted dimensions with their percentages.
    const normalized = normalizeDriftClaimsInWindowRecord(drift, driftObservation);
    const normalizedResult = deriveDriftClassificationHonesty({
      window: drift.window,
      schedule: drift.schedule,
      observation: normalized,
    });
    expect(normalizedResult.status).toBe("FAIL");
    expect(normalizedResult.evidence).toContain(
      `normalized-drift:shift 4 daily-usage (claimed within-declared-bounds, derived drifting via ${LOAD_SHAPING_COHORT_MIX} — economics 25%, latency 0%, resolved-quality 0% beyond tolerance 10%)`,
    );
    // The HIDDEN REGRESSION shape (the issued drift-normalizing probe):
    // shift 5's daily-usage regresses +30% UNdeclared while the claim
    // says within-declared-bounds — FAILs NAMED with the segment, the
    // drifted dimensions and the absence of a declared divergence.
    const probeResult = pilotRowResultFor(rowOf("probe-pilot-drift-normalizing"));
    expect(probeResult.terminal).toBe("PILOT-FAILED");
    expect(probeResult.failedCriteria).toEqual([
      "drift-classification-honesty",
      "end-of-window-reconciliation",
    ]);
    expect(evidenceOf("probe-pilot-drift-normalizing", "drift-classification-honesty")).toContain(
      "hidden-regression:shift 5 daily-usage (claimed within-declared-bounds, derived regressing — economics 30%, latency 0%, resolved-quality 0% beyond tolerance 10%, no declared divergence)",
    );
    // The real drifted economics are still carried (12480 over the
    // recorded 9600 — the 2880 residual co-FAILs the reconciliation).
    const probeObservation = observationOf("probe-pilot-drift-normalizing");
    expect(observedSegmentOf(probeObservation, 5, "daily-usage").costMicroUsd).toBe(
      HIDDEN_REGRESSION_STAGE_COST,
    );
    expect(evidenceOf("probe-pilot-drift-normalizing", "end-of-window-reconciliation")).toContain(
      `unexplained-stage-residual:shift 5 daily-usage (observed ${HIDDEN_REGRESSION_STAGE_COST}microUsd, recorded 9600microUsd, residual ${HIDDEN_REGRESSION_RESIDUAL}microUsd beyond the declared tolerance 10% with no declared divergence — both sides named)`,
    );
    // The FABRICATED drift shape (the inverse lie: claiming drifting
    // over a within-bounds segment) FAILs NAMED too.
    const fabricated: PilotWindowObservation = {
      ...driftObservation,
      claimedDrift: driftObservation.claimedDrift.map((claim) =>
        claim.shift === 2 && claim.stage === "plan"
          ? { ...claim, claimed: "drifting", mechanism: "made-up" }
          : claim,
      ),
    };
    const fabricatedResult = deriveDriftClassificationHonesty({
      window: drift.window,
      schedule: drift.schedule,
      observation: fabricated,
    });
    expect(fabricatedResult.status).toBe("FAIL");
    expect(fabricatedResult.evidence).toContain(
      "fabricated-drift:shift 2 plan (claimed drifting, derived within-declared-bounds — the declared tolerance holds)",
    );
  });
});

// ---------------------------------------------------------------------------
// End-of-window reconciliation (stage-for-stage, shift-for-shift)
// ---------------------------------------------------------------------------

describe("VAL-051 end-of-window reconciliation (stage-for-stage, shift-for-shift)", () => {
  test("the stage-for-stage digest-anchored equality", () => {
    const full = rowOf(FULL_ROW_ID);
    // Every observed stage's economics anchor equals its declared
    // recorded economics anchor (the digest-anchored equality), and the
    // anchors are the pinned VAL-049 carried digests.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      for (const scheduled of row.schedule.shifts) {
        const observed = observedShiftOf(observation, scheduled.shift);
        for (const segment of scheduled.segments) {
          const observedSegment = observed.segments.find(
            (candidate) => candidate.stage === segment.stage,
          );
          expect(observedSegment, `${rowId}/${scheduled.shift}/${segment.stage}`).toBeDefined();
          expect(observedSegment?.basisDigest, `${rowId}/${scheduled.shift}/${segment.stage}`).toBe(
            segment.economics.basisDigest,
          );
        }
      }
    }
    const observation = observationOf(FULL_ROW_ID);
    for (const [stage, digest] of Object.entries(STAGE_BASIS_DIGESTS)) {
      expect(observedSegmentOf(observation, 0, stage).basisDigest, stage).toBe(digest);
      expect(
        carriedBasisDigestOf(scheduledSegmentOf(full, 0, stage).economics.basisAuditRowId),
        stage,
      ).toBe(digest);
    }
    // The full window's stages sit EXACTLY on the recorded basis (zero
    // stage residual); the drifting row's delta is the DECLARED one.
    expect(observedSegmentOf(observation, 3, "daily-usage").costMicroUsd).toBe("9600");
    const driftObservation = observationOf(DRIFT_ROW_ID);
    expect(observedSegmentOf(driftObservation, 4, "daily-usage").costMicroUsd).toBe(
      DRIFTING_STAGE_OBSERVED_COST,
    );
    // A mutated anchor (the observation not over the declared recorded
    // basis) FAILs NAMED with BOTH anchors.
    const anchorBad: PilotWindowObservation = {
      ...observation,
      shifts: observation.shifts.map((shift) =>
        shift.shift === 2
          ? {
              ...shift,
              segments: shift.segments.map((segment) =>
                segment.stage === "plan" ? { ...segment, basisDigest: "deadbeef" } : segment,
              ),
            }
          : shift,
      ),
    };
    const anchorResult = deriveEndOfWindowReconciliation({
      window: full.window,
      schedule: full.schedule,
      observation: anchorBad,
    });
    expect(anchorResult.status).toBe("FAIL");
    expect(anchorResult.evidence).toContain(
      "basis-anchor-divergence:shift 2 plan (observed anchor deadbeef, recorded anchor c0fbc74a — the observation is not over the declared recorded basis)",
    );
  });

  test("the shift-for-shift sums", () => {
    // Every honest shift's stage cost sum equals its reported shift
    // total, and its stage latency sum equals its reported latency.
    for (const rowId of HONEST_ROW_IDS) {
      const observation = observationOf(rowId);
      for (const shift of observation.shifts) {
        const stageCost = sumMicroUsd(shift.segments.map((segment) => segment.costMicroUsd));
        expect(stageCost.toString(), `${rowId}/shift${shift.shift}`).toBe(
          shift.reportedCostMicroUsd,
        );
        const stageLatency = shift.segments.reduce(
          (total, segment) => total + segment.latencyMs,
          0,
        );
        expect(stageLatency, `${rowId}/shift${shift.shift}`).toBe(shift.reportedLatencyMs);
      }
    }
    // The numerically pinned per-shift sums: the portfolio shift (1200 +
    // 800 + 1500 + 9600 + 400) and the continuation shift (the
    // daily-usage stage's TWO recorded attempts: 19200).
    const fullObservation = observationOf(FULL_ROW_ID);
    expect(observedShiftOf(fullObservation, 2).reportedCostMicroUsd).toBe(PORTFOLIO_SHIFT_COST);
    expect(observedShiftOf(fullObservation, 2).reportedLatencyMs).toBe(PORTFOLIO_SHIFT_LATENCY_MS);
    expect(
      observedShiftOf(fullObservation, 2).segments.map((segment) => segment.costMicroUsd),
    ).toEqual(["1200", "800", "1500", "9600", "400"]);
    const contObservation = observationOf(CONT_ROW_ID);
    expect(observedShiftOf(contObservation, 3).reportedCostMicroUsd).toBe(CONTINUATION_SHIFT_COST);
    expect(observedShiftOf(contObservation, 3).reportedLatencyMs).toBe(
      CONTINUATION_SHIFT_LATENCY_MS,
    );
    // A shift total that hides part of its stage cost FAILs NAMED with
    // BOTH sides (the incident-hiding probe's hidden failed-attempt
    // cost: stage sum 23100 vs the reported 13500, residual 9600).
    const probeEvidence = evidenceOf("probe-pilot-incident-hiding", "end-of-window-reconciliation");
    expect(probeEvidence).toContain(
      "shift-total-residual:shift 2 (stage sum 23100microUsd, recorded shift total 13500microUsd, residual 9600microUsd — both sides named)",
    );
  });

  test("the window total = Σ shifts and reported = observed (zero residual)", () => {
    // Every honest row: the reported window total equals Σ the reported
    // shift totals, the reported latency equals Σ the shift latencies,
    // and the observed stage total equals the same Σ (reported =
    // observed — ZERO unexplained residual).
    for (const rowId of HONEST_ROW_IDS) {
      const observation = observationOf(rowId);
      const shiftTotals = sumMicroUsd(
        observation.shifts.map((shift) => shift.reportedCostMicroUsd),
      );
      expect(observation.reported.totalCostMicroUsd, rowId).toBe(shiftTotals.toString());
      const shiftLatencies = observation.shifts.reduce(
        (total, shift) => total + shift.reportedLatencyMs,
        0,
      );
      expect(observation.reported.totalLatencyMs, rowId).toBe(shiftLatencies);
      const stageTotal = sumMicroUsd(
        observation.shifts.flatMap((shift) =>
          shift.segments.map((segment) => segment.costMicroUsd),
        ),
      );
      expect(stageTotal.toString(), rowId).toBe(observation.reported.totalCostMicroUsd);
      // The reconciliation PASSES with ZERO unexplained residual — the
      // within-tolerance residuals and declared deltas carried as
      // evidence, never an UNEXPLAINED token.
      const reconciliation = deriveEndOfWindowReconciliation({
        window: rowOf(rowId).window,
        schedule: rowOf(rowId).schedule,
        observation,
      });
      expect(reconciliation.status, rowId).toBe("PASS");
      for (const line of reconciliation.evidence) {
        expect(line, rowId).not.toContain("UNEXPLAINED");
      }
    }
    // The numerically pinned window totals.
    expect(observationOf(FULL_ROW_ID).reported).toEqual({
      totalCostMicroUsd: FULL_WINDOW_COST,
      totalLatencyMs: FULL_WINDOW_LATENCY_MS,
    });
    expect(observationOf(CONT_ROW_ID).reported).toEqual({
      totalCostMicroUsd: CONTINUATION_WINDOW_COST,
      totalLatencyMs: CONTINUATION_WINDOW_LATENCY_MS,
    });
    expect(observationOf(INCIDENT_ROW_ID).reported).toEqual({
      totalCostMicroUsd: CONTINUATION_WINDOW_COST,
      totalLatencyMs: CONTINUATION_WINDOW_LATENCY_MS,
    });
    expect(observationOf(DRIFT_ROW_ID).reported.totalCostMicroUsd).toBe(DRIFTING_WINDOW_COST);
    expect(observationOf(REGR_ROW_ID).reported).toEqual({
      totalCostMicroUsd: FULL_WINDOW_COST,
      totalLatencyMs: FULL_WINDOW_LATENCY_MS,
    });
    expect(observationOf(TIGHT_ROW_ID).reported).toEqual({
      totalCostMicroUsd: FULL_WINDOW_COST,
      totalLatencyMs: FULL_WINDOW_LATENCY_MS,
    });
    // The drifting row's pilot-level residual is EXPLAINED (the declared
    // 2400 delta), both sides named.
    expect(evidenceOf(DRIFT_ROW_ID, "end-of-window-reconciliation")).toContain(
      "pilot-level-residual:observed 83400microUsd vs recorded basis 81000microUsd (residual 2400microUsd — explained: the within-tolerance residuals and declared deltas carried above)",
    );
  });

  test("a hidden residual NAMED (the exact amount)", () => {
    // The residual-hiding probe: the reported window total hides shift
    // 1's onboarding stage cost (1200) while every stage record and
    // every per-shift total stays honest — the oracle FAILs NAMED with
    // BOTH sides and the EXACT residual.
    const probe = rowOf("probe-pilot-residual-hiding");
    const observation = observationOf("probe-pilot-residual-hiding");
    expect(observedSegmentOf(observation, 1, "onboarding").costMicroUsd).toBe(HIDDEN_RESIDUAL);
    expect(observation.reported.totalCostMicroUsd).toBe(RESIDUAL_HIDING_REPORTED_TOTAL);
    const result = pilotRowResultFor(probe);
    expect(result.terminal).toBe("PILOT-FAILED");
    expect(result.failedCriteria).toEqual(["end-of-window-reconciliation"]);
    expect(evidenceOf("probe-pilot-residual-hiding", "end-of-window-reconciliation")).toContain(
      `window-total-residual:reported ${RESIDUAL_HIDING_REPORTED_TOTAL}microUsd, observed Σ shifts ${FULL_WINDOW_COST}microUsd, residual -${HIDDEN_RESIDUAL}microUsd — both sides named)`,
    );
    // The cherry-picked window's unexplained pilot-level residual: the
    // observed 54000 against the recorded 81000 basis — the exact
    // -27000 amount NAMED, both sides named.
    expect(
      evidenceOf("probe-pilot-cherry-picked-window", "end-of-window-reconciliation"),
    ).toContain(
      "pilot-level-residual:observed 54000microUsd vs recorded basis 81000microUsd (residual -27000microUsd — UNEXPLAINED, the exact amount named, both sides named)",
    );
    expect(
      evidenceOf("probe-pilot-cherry-picked-window", "end-of-window-reconciliation"),
    ).toContain(
      "missing-shift-basis:shift 4 (recorded basis 13500microUsd never observed — the window's accounting is short and the residual is unexplained)",
    );
    // The dropped shift's missing recorded basis: -13500 NAMED exactly.
    expect(evidenceOf("probe-pilot-dropped-shift", "end-of-window-reconciliation")).toContain(
      "pilot-level-residual:observed 67500microUsd vs recorded basis 81000microUsd (residual -13500microUsd — UNEXPLAINED, the exact amount named, both sides named)",
    );
    // The double-driven resume's third attempt: +9600 NAMED exactly
    // (stage-level AND pilot-level, both sides).
    expect(
      evidenceOf("probe-pilot-double-driven-resume", "end-of-window-reconciliation"),
    ).toContain(
      `unexplained-stage-residual:shift 3 daily-usage (observed ${DOUBLE_DRIVEN_STAGE_COST}microUsd, recorded 19200microUsd, residual ${DOUBLE_DRIVEN_RESIDUAL}microUsd beyond the declared tolerance 10% with no declared divergence — both sides named)`,
    );
    expect(
      evidenceOf("probe-pilot-double-driven-resume", "end-of-window-reconciliation"),
    ).toContain(
      "pilot-level-residual:observed 100200microUsd vs recorded basis 90600microUsd (residual 9600microUsd — UNEXPLAINED, the exact amount named, both sides named)",
    );
  });
});

// ---------------------------------------------------------------------------
// Window honesty
// ---------------------------------------------------------------------------

describe("VAL-051 window honesty", () => {
  test("the declared window matches the recorded data", () => {
    // The window-honesty oracle PASSES over every honest row: the
    // observed shifts equal the DECLARED shifts over the DECLARED span,
    // and every declared segment is observed.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      const honesty = deriveWindowHonesty({
        window: row.window,
        schedule: row.schedule,
        observation,
      });
      expect(honesty.status, rowId).toBe("PASS");
      expect(observation.shifts, rowId).toHaveLength(row.window.declaredShifts);
      expect(
        observation.shifts.map((shift) => shift.shift),
        rowId,
      ).toEqual(row.schedule.shifts.map((shift) => shift.shift));
    }
    // The full row's evidence, pinned verbatim: the declared window, the
    // schedule's shifts and the observed shifts agree exactly.
    const evidence = evidenceOf(FULL_ROW_ID, "window-honesty");
    expect(evidence).toContain("declared-window:shifts 6 over span 0..5");
    expect(evidence).toContain("schedule-shifts:0..5");
    expect(evidence).toContain("observed-shifts:0..5");
    // The window/schedule agreement is enforced: a window declaring a
    // shift cardinality the schedule does not hold FAILs NAMED.
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    const divergent = deriveWindowHonesty({
      window: { ...full.window, declaredShifts: 5 },
      schedule: full.schedule,
      observation,
    });
    expect(divergent.status).toBe("FAIL");
    expect(divergent.evidence).toContain(
      "window-schedule-divergence:the window declares 5 shifts, the schedule holds 6",
    );
    const spanDivergent = deriveWindowHonesty({
      window: {
        ...full.window,
        declaredSpan: { firstShift: 0, lastShift: 4 },
      },
      schedule: full.schedule,
      observation,
    });
    expect(spanDivergent.status).toBe("FAIL");
    expect(spanDivergent.evidence).toContain(
      "declared-span-divergence:span 0..4 does not cover exactly the 6 declared shifts",
    );
  });

  test("a cherry-picked sub-window NAMED (the omitted shifts named)", () => {
    // The cherry-picked probe: the anomalous shifts 4..5 dropped from
    // the window record to fake a clean window — FAILs NAMED with the
    // omitted shifts AND the cherry-picked sub-window (observed 0..3 of
    // the declared 0..5).
    const probe = rowOf("probe-pilot-cherry-picked-window");
    const observation = observationOf("probe-pilot-cherry-picked-window");
    expect(observation.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 3]);
    const honesty = deriveWindowHonesty({
      window: probe.window,
      schedule: probe.schedule,
      observation,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain("omitted-shift:4..5");
    expect(honesty.evidence).toContain("cherry-picked-sub-window:shifts 0..3 of 0..5");
    // The completeness oracle co-fails with the missed shifts NAMED.
    const completeness = deriveScheduleCompleteness({
      schedule: probe.schedule,
      observation,
    });
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain("missed-shift:4");
    expect(completeness.evidence).toContain("missed-shift:5");
    // The dropped-shift probe: the mid-window shift 3 entirely absent —
    // the omitted shift named, the observed sub-window 0..2,4..5.
    const dropped = rowOf("probe-pilot-dropped-shift");
    const droppedObservation = observationOf("probe-pilot-dropped-shift");
    expect(droppedObservation.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 4, 5]);
    const droppedHonesty = deriveWindowHonesty({
      window: dropped.window,
      schedule: dropped.schedule,
      observation: droppedObservation,
    });
    expect(droppedHonesty.status).toBe("FAIL");
    expect(droppedHonesty.evidence).toContain("omitted-shift:3");
    expect(droppedHonesty.evidence).toContain("cherry-picked-sub-window:shifts 0..2,4..5 of 0..5");
    // Both probe rows FAIL the driver with window-honesty (and the
    // sibling completeness + reconciliation families) NAMED.
    for (const rowId of ["probe-pilot-cherry-picked-window", "probe-pilot-dropped-shift"]) {
      const result = pilotRowResultFor(rowOf(rowId));
      expect(result.terminal, rowId).toBe("PILOT-FAILED");
      expect(result.failedCriteria, rowId).toEqual([
        "window-honesty",
        "schedule-completeness",
        "end-of-window-reconciliation",
      ]);
    }
  });

  test("a post-hoc extension NAMED", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // A shift observed OUTSIDE the declared window (a cloned shift at
    // ordinal 6 over the declared 0..5 span) — FAILs NAMED with the
    // offending ordinal.
    const extended: PilotWindowObservation = {
      ...observation,
      shifts: [
        ...observation.shifts,
        {
          ...observedShiftOf(observation, 0),
          shift: 6,
          segments: observedShiftOf(observation, 0).segments.map((segment) => ({
            ...segment,
            shift: 6,
          })),
        },
      ],
    };
    const honesty = deriveWindowHonesty({
      window: full.window,
      schedule: full.schedule,
      observation: extended,
    });
    expect(honesty.status).toBe("FAIL");
    expect(honesty.evidence).toContain(
      "post-hoc-extension:shift 6 (observed outside the declared window)",
    );
    // The completeness oracle names the UNDECLARED shift.
    const completeness = deriveScheduleCompleteness({
      schedule: full.schedule,
      observation: extended,
    });
    expect(completeness.status).toBe("FAIL");
    expect(completeness.evidence).toContain("undeclared-shift:6 (never scheduled)");
    // The row driver FAILs the extended window with both NAMED.
    const driven = drivePilotRow({
      rowId: full.rowId,
      window: full.window,
      schedule: full.schedule,
      policy: full.operatingProfile,
      observation: extended,
    });
    expect(driven.terminal).toBe("PILOT-FAILED");
    expect(driven.failedCriteria).toContain("window-honesty");
    expect(driven.failedCriteria).toContain("schedule-completeness");
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest outcome contract)
// ---------------------------------------------------------------------------

describe("VAL-051 the driver over every offline row (the honest outcome contract)", () => {
  /** The verbatim NAMED-evidence tokens each probe row must cite. */
  const PROBE_NAMED_EVIDENCE_OF: Readonly<Record<string, readonly (readonly string[])[]>> =
    Object.freeze({
      "probe-pilot-cherry-picked-window": [
        ["window-honesty", "omitted-shift:4..5"],
        ["window-honesty", "cherry-picked-sub-window:shifts 0..3 of 0..5"],
        ["schedule-completeness", "missed-shift:4"],
        ["end-of-window-reconciliation", "residual -27000microUsd — UNEXPLAINED"],
      ],
      "probe-pilot-dropped-shift": [
        ["schedule-completeness", "missed-shift:3"],
        ["window-honesty", "omitted-shift:3"],
        ["end-of-window-reconciliation", "residual -13500microUsd — UNEXPLAINED"],
      ],
      "probe-pilot-double-driven-resume": [
        ["continuation-exactly-once", "shift 3 daily-usage:attempts=3,declared=2"],
        [
          "continuation-exactly-once",
          "double-driven-resume:shift 3 daily-usage (resumes=2, expected exactly 1)",
        ],
        ["end-of-window-reconciliation", "residual 9600microUsd — UNEXPLAINED"],
      ],
      "probe-pilot-drift-normalizing": [
        ["drift-classification-honesty", "hidden-regression:shift 5 daily-usage"],
        ["drift-classification-honesty", "claimed within-declared-bounds, derived regressing"],
        ["end-of-window-reconciliation", "residual 2880microUsd beyond the declared tolerance"],
      ],
      "probe-pilot-incident-hiding": [
        ["incident-honesty", "hidden-incident:shift 2 daily-usage"],
        ["end-of-window-reconciliation", "shift-total-residual:shift 2 (stage sum 23100microUsd"],
      ],
      "probe-pilot-residual-hiding": [
        ["end-of-window-reconciliation", "window-total-residual:reported 79800microUsd"],
        ["end-of-window-reconciliation", "residual -1200microUsd — both sides named"],
      ],
      "probe-pilot-boundary-leak": [
        [
          "customer-boundary-integrity",
          `foreign-application:shift 4 onboarding (executed under ${FOREIGN_APPLICATION_ID}`,
        ],
      ],
    });

  test("every honest row COMPLETES with its pinned verdict + drift classification, every probe row FAILs its NAMED criteria (the full matrix)", () => {
    // The 14/14 pinned verdict matrix: every corpus row's derived
    // terminal equals its pinned expected verdict, with the FAILing
    // criteria exactly the pinned list.
    expect(PILOT_CORPUS_ROWS).toHaveLength(14);
    for (const row of PILOT_CORPUS_ROWS) {
      const result = pilotRowResultFor(row);
      expect(result.terminal, row.rowId).toBe(row.expected.verdict);
      expect(result.failedCriteria, row.rowId).toEqual([...row.expected.failedCriteria]);
      expect(result.rowId).toBe(row.rowId);
      expect(result.notRun, row.rowId).toBe(row.expected.verdict === "NOT-RUN");
      // The row's own digest pins recompute (never trusted).
      expect(result.windowDigest, row.rowId).toBe(pilotWindowDigestOf(row.window));
      expect(result.scheduleDigest, row.rowId).toBe(
        scheduleDigestOf({ shifts: row.schedule.shifts }),
      );
    }
    // THE SIX HONEST ROWS: PILOT-COMPLETED with all EIGHT criteria PASS
    // in the issued AC4 order, no reason, no not-run.
    for (const rowId of HONEST_ROW_IDS) {
      const result = pilotRowResultFor(rowOf(rowId));
      expect(result.terminal, rowId).toBe("PILOT-COMPLETED");
      expect(result.criteria, rowId).toHaveLength(8);
      expect(
        result.criteria.map((criterion) => criterion.criterionId),
        rowId,
      ).toEqual([...PILOT_OBSERVATION_FAMILIES]);
      for (const criterion of result.criteria) {
        expect(criterion.status, `${rowId}/${criterion.criterionId}`).toBe("PASS");
        expect(criterion.strategy, `${rowId}/${criterion.criterionId}`).toBe("deterministic");
      }
      expect(result.notRun, rowId).toBe(false);
      expect(result.reason, rowId).toBeNull();
    }
    // The honest drift classifications are carried in the pinned
    // verdicts: the derived beyond-tolerance findings equal the pins.
    for (const rowId of HONEST_ROW_IDS) {
      const row = rowOf(rowId);
      const observation = observationOf(rowId);
      const findings = deriveWindowDrift({
        window: row.window,
        schedule: row.schedule,
        observation,
      })
        .filter((drift) => drift.beyondTolerance)
        .map((drift) => ({
          shift: drift.shift,
          stage: drift.stage,
          classification: drift.classification,
          mechanism: drift.mechanism,
        }));
      expect(findings, rowId).toEqual([...row.expected.driftFindings]);
    }
    // THE SEVEN PROBE ROWS: PILOT-FAILED with exactly the pinned NAMED
    // criteria (the corpus's pin, the driver's derivation and the issued
    // vocabulary share ONE list), and the verbatim NAMED evidence cited.
    for (const row of PROBE_CORPUS_ROWS) {
      const probeKind = row.probe?.kind;
      expect(probeKind, row.rowId).toBeDefined();
      const result = pilotRowResultFor(row);
      expect(result.terminal, row.rowId).toBe("PILOT-FAILED");
      expect(result.failedCriteria, row.rowId).toEqual([
        ...PROBE_FAILED_CRITERIA_OF[probeKind ?? ""],
      ]);
      expect(result.criteria, row.rowId).toHaveLength(8);
      for (const [criterionId, token] of PROBE_NAMED_EVIDENCE_OF[row.rowId] ?? []) {
        const criterion = result.criteria.find(
          (candidate) => candidate.criterionId === criterionId,
        );
        expect(criterion, `${row.rowId}/${criterionId}`).toBeDefined();
        expect(criterion?.status, `${row.rowId}/${criterionId}`).toBe("FAIL");
        expect(
          criterion?.evidence.some((line) => line.includes(token)),
          `${row.rowId}/${criterionId}:${token}`,
        ).toBe(true);
      }
    }
    // The boundary-leak probe FAILs ONLY the customer-boundary oracle
    // (its other seven criteria PASS — the leak is caught exactly where
    // it lives, under the imported foreign identity).
    const boundary = pilotRowResultFor(rowOf("probe-pilot-boundary-leak"));
    expect(boundary.failedCriteria).toEqual(["customer-boundary-integrity"]);
    expect(
      boundary.criteria
        .filter((criterion) => criterion.status === "PASS")
        .map((criterion) => criterion.criterionId),
    ).toHaveLength(7);
    // THE ONE LIVE ROW: honestly NOT-RUN with the env var NAMED.
    const live = pilotRowResultFor(rowOf(LIVE_ROW_ID));
    expect(live.terminal).toBe("NOT-RUN");
    expect(live.notRun).toBe(true);
    expect(live.reason).toContain("OPENROUTER_API_KEY");
    expect(live.failedCriteria).toEqual([]);
    // The offline corpus is complete: 13 offline rows (6 honest + 7
    // probes, in the issued order) + the ONE live row.
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(13);
    expect(PROBE_CORPUS_ROWS.map((row) => row.rowId)).toEqual([...PROBE_ROW_IDS]);
    expect(HONEST_ROW_IDS).toHaveLength(6);
    expect(LIVE_ROW).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The live lane declaration
// ---------------------------------------------------------------------------

describe("VAL-051 the live lane declaration", () => {
  test("the plan digest deterministic + exactly one live row", () => {
    // The pinned live plan: 3 shifts × 2 REAL dispatches — six live
    // dispatches SUSTAINED across the window (never a burst) at
    // 1500ms on / 500ms off pacing, over the ONE pinned OpenRouter
    // rail with max_tokens 32 pinned and temperature unset.
    expect(LIVE_PILOT_WORKLOAD_CLASS).toBe("live-pilot-sustained-window");
    expect(LIVE_PILOT_PLAN.workloadClass).toBe(LIVE_PILOT_WORKLOAD_CLASS);
    expect(LIVE_PILOT_PLAN.shifts).toBe(3);
    expect(LIVE_PILOT_PLAN.dispatchesPerShift).toBe(2);
    expect(LIVE_PILOT_PLAN.liveDispatches).toBe(6);
    expect(LIVE_PILOT_PLAN.pacing).toEqual({ onMs: 1500, offMs: 500 });
    expect(LIVE_PILOT_PLAN.rail).toEqual({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      priceRevision: "rev-001",
      maxTokens: 32,
      temperature: "unset (the provider's documented default — nothing rides the request)",
    });
    expect(LIVE_PILOT_PLAN.envVar).toBe("OPENROUTER_API_KEY");
    expect(LIVE_PILOT_PLAN.recorder).toBe(
      "createRealAccountingRails (the REAL recorder — never a fake ledger)",
    );
    // The plan digest is deterministic whether or not the gate ever
    // opens (the gate-closed invariant's own pin).
    expect(livePilotPlanDigestOf()).toBe(livePilotPlanDigestOf());
    expect(livePilotPlanDigestOf()).toBe(LIVE_PLAN_DIGEST);
    expect(livePilotPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
    // Exactly ONE live row, gated on exactly the one env var, and it is
    // the only row that needs dispatch.
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    const live = rowOf(LIVE_ROW_ID);
    expect(live.liveGate).toEqual({ envVars: ["OPENROUTER_API_KEY"] });
    expect(live.needsDispatch).toBe(true);
    expect(live.probe).toBeUndefined();
    expect(PILOT_CORPUS_ROWS.filter((row) => row.liveGate !== undefined)).toHaveLength(1);
    expect(PILOT_CORPUS_ROWS.filter((row) => row.needsDispatch)).toHaveLength(1);
    // The gate is honest: closed without the credential, open with it.
    expect(liveGateOpen(live, {})).toBe(false);
    expect(liveGateOpen(live, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(live, { OPENROUTER_API_KEY: "test-key" })).toBe(true);
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(liveGateOpen(row, {}), row.rowId).toBe(true);
      expect(row.liveGate, row.rowId).toBeUndefined();
      expect(row.needsDispatch, row.rowId).toBe(false);
    }
  });

  test("the honest NOT RUN shape", () => {
    const live = rowOf(LIVE_ROW_ID);
    // The live row's window feed is honestly NULL offline (its window
    // record is MEASURED at run time over the REAL rail — an offline
    // fabrication would be a fake measurement, never).
    expect(pilotWindowFeedFor(live)).toBeNull();
    expect(pilotWindowRecordFor(live)).toBeNull();
    // The driven shape: NOT-RUN with exactly ONE criterion — the honest
    // live-gate-honesty PASS — never a fabricated success, the env var
    // NAMED in the gate and the reason.
    const result = drivePilotRow({
      rowId: live.rowId,
      window: live.window,
      schedule: live.schedule,
      policy: live.operatingProfile,
      observation: null,
      liveGate: live.liveGate,
    });
    expect(result.terminal).toBe("NOT-RUN");
    expect(result.notRun).toBe(true);
    expect(result.reason).toBe(
      "live gate closed (OPENROUTER_API_KEY absent — the live pilot slice honestly NOT RUN, never a fake success)",
    );
    expect(result.criteria).toHaveLength(1);
    const gate = result.criteria[0];
    expect(gate).toMatchObject({
      criterionId: "live-gate-honesty",
      strategy: "deterministic",
      status: "PASS",
    });
    expect(gate?.evidence).toContain("gate:OPENROUTER_API_KEY");
    expect(gate?.evidence).toContain(`window-digest:${LIVE_WINDOW_DIGEST}`);
    expect(gate?.evidence).toContain(`schedule-digest:${LIVE_SCHEDULE_DIGEST}`);
    expect(gate?.evidence).toContain(`plan-digest:${LIVE_PLAN_DIGEST}`);
    expect(gate?.evidence).toContain(
      "NOT RUN (the live pilot slice demands the operator credential — honestly not run, never fabricated)",
    );
    expect(result.failedCriteria).toEqual([]);
    expect(result.windowDigest).toBe(LIVE_WINDOW_DIGEST);
    expect(result.scheduleDigest).toBe(LIVE_SCHEDULE_DIGEST);
    // A row with NO observation and NO live gate is honestly not run
    // too — the reason names the absent observation, never invents one.
    const noGate = drivePilotRow({
      rowId: "unit-no-observation",
      window: live.window,
      schedule: live.schedule,
      policy: live.operatingProfile,
      observation: null,
    });
    expect(noGate.terminal).toBe("NOT-RUN");
    expect(noGate.notRun).toBe(true);
    expect(noGate.reason).toBe(
      "no observation recorded (the row never ran — honestly NOT RUN, never a fake success)",
    );
    expect(noGate.criteria[0]?.evidence).toContain("gate:none");
    expect(noGate.failedCriteria).toEqual([]);
    // The corpus's own live-row pin agrees (the derived NOT-RUN).
    expect(pilotRowResultFor(live).terminal).toBe("NOT-RUN");
  });
});

// ---------------------------------------------------------------------------
// The digest discipline
// ---------------------------------------------------------------------------

describe("VAL-051 the digest discipline", () => {
  test("the FNV-1a convention imported (never re-implemented)", () => {
    const full = rowOf(FULL_ROW_ID);
    const contObservation = observationOf(CONT_ROW_ID);
    // Every digest the driver derives IS the house FNV-1a
    // (`economicDigestOf`, imported from the economic-baseline driver)
    // over the documented payload — composed, never re-implemented.
    expect(pilotWindowDigestOf(full.window)).toBe(
      economicDigestOf({
        kind: "pilot-window",
        declaredShifts: 6,
        declaredSpan: { firstShift: 0, lastShift: 5 },
        driftTolerancePct: 10,
        declaredDivergences: [],
      }),
    );
    expect(pilotWindowDigestOf(full.window)).toBe(FULL_WINDOW_DIGEST);
    expect(scheduleDigestOf({ shifts: full.schedule.shifts })).toBe(
      economicDigestOf({
        kind: "pilot-shift-schedule",
        shifts: full.schedule.shifts.map((shift) => ({
          shift: shift.shift,
          journeyRowId: shift.journeyRowId,
          failureStage: shift.failureStage,
          segments: shift.segments.map((segment) => ({
            stage: segment.stage,
            recordedInputDigests: [...segment.recordedInputDigests],
            economics: {
              costMicroUsd: segment.economics.costMicroUsd,
              latencyMs: segment.economics.latencyMs,
              basisAuditRowId: segment.economics.basisAuditRowId,
              basisDigest: segment.economics.basisDigest,
            },
            declaredAttempts: segment.declaredAttempts,
            recordedResolvedAttempts: segment.recordedResolvedAttempts,
          })),
        })),
      }),
    );
    expect(scheduleDigestOf({ shifts: full.schedule.shifts })).toBe(FULL_SCHEDULE_DIGEST);
    expect(ledgerBasisDigestOf(full.operatingProfile)).toBe(
      economicDigestOf({
        ledger: "pilot-budget-ledger",
        costBudgetMicroUsd: "162000",
        latencyBudgetMsPerShift: 800,
        admissionPolicy: "admit-all-scheduled",
      }),
    );
    expect(
      windowRecordDigestOf({
        rowId: full.rowId,
        basis: "derived-from-recorded-basis",
        shifts: observationOf(FULL_ROW_ID).shifts,
      }),
    ).toBe(
      economicDigestOf({
        rowId: full.rowId,
        basis: "derived-from-recorded-basis",
        shifts: observationOf(FULL_ROW_ID).shifts.map((shift) => ({
          shift: shift.shift,
          journeyRowId: shift.journeyRowId,
          segments: shift.segments.map(
            (segment) => `${segment.stage}:${segment.attempts}:${segment.resolved}`,
          ),
        })),
      }),
    );
    expect(
      windowRecordDigestOf({
        rowId: full.rowId,
        basis: "derived-from-recorded-basis",
        shifts: observationOf(FULL_ROW_ID).shifts,
      }),
    ).toBe(FULL_WINDOW_RECORD_DIGEST);
    expect(incidentLogDigestOf(contObservation.incidents)).toBe(
      economicDigestOf({
        kind: "pilot-incident-log",
        incidents: contObservation.incidents.map((record) => ({
          shift: record.shift,
          stage: record.stage,
          attributionClass: record.attributionClass,
          magnitudeMicroUsd: record.magnitudeMicroUsd,
          disposition: record.disposition.kind,
          detailDigest: record.disposition.detailDigest,
        })),
      }),
    );
    expect(incidentLogDigestOf(contObservation.incidents)).toBe(CONTINUATION_INCIDENT_LOG_DIGEST);
    expect(livePilotPlanDigestOf()).toBe(
      economicDigestOf({
        liveWorkloadClass: LIVE_PILOT_WORKLOAD_CLASS,
        shifts: LIVE_PILOT_PLAN.shifts,
        dispatchesPerShift: LIVE_PILOT_PLAN.dispatchesPerShift,
        liveDispatches: LIVE_PILOT_PLAN.liveDispatches,
        pacing: LIVE_PILOT_PLAN.pacing,
        rail: LIVE_PILOT_PLAN.rail,
        envVar: LIVE_PILOT_PLAN.envVar,
        recorder: LIVE_PILOT_PLAN.recorder,
        recordedBasis: LIVE_PILOT_PLAN.recordedBasis,
      }),
    );
    expect(livePilotPlanDigestOf()).toBe(LIVE_PLAN_DIGEST);
    // Every digest output is the house shape: 8 lowercase hex digits.
    for (const digest of [
      pilotWindowDigestOf(full.window),
      scheduleDigestOf({ shifts: full.schedule.shifts }),
      ledgerBasisDigestOf(full.operatingProfile),
      windowRecordDigestOf({
        rowId: full.rowId,
        basis: "derived-from-recorded-basis",
        shifts: observationOf(FULL_ROW_ID).shifts,
      }),
      incidentLogDigestOf(contObservation.incidents),
      livePilotPlanDigestOf(),
      carriedBasisDigestOf("replay-cross-workload-verdicts"),
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("every recorded reference recomputed at pin time (a drifted corpus THROWS)", () => {
    const full = rowOf(FULL_ROW_ID);
    // Every carried VAL-049 audit anchor the journey corpus pins
    // re-resolves through the audit corpus's OWN resolver (five
    // anchors, each recomputing to the house digest shape).
    expect(CARRIED_AUDIT_ROW_IDS).toHaveLength(5);
    const carried = carriedAuditBasisDigests();
    expect(carried.size).toBe(5);
    for (const auditRowId of CARRIED_AUDIT_ROW_IDS) {
      expect(carried.get(auditRowId), auditRowId).toBe(carriedBasisDigestOf(auditRowId));
      expect(carried.get(auditRowId), auditRowId).toMatch(/^[0-9a-f]{8}$/);
    }
    // Every corpus row's every segment anchor recomputes at pin time
    // (the test-time recompute IS the pin-time discipline: a drifted
    // anchor cannot silently exist).
    for (const row of PILOT_CORPUS_ROWS) {
      for (const shift of row.schedule.shifts) {
        for (const segment of shift.segments) {
          expect(
            carriedBasisDigestOf(segment.economics.basisAuditRowId),
            `${row.rowId}/shift${shift.shift}/${segment.stage}`,
          ).toBe(segment.economics.basisDigest);
        }
      }
    }
    // The pinned per-stage anchors (the carried audit row ids of the
    // journey corpus's own stage economics table).
    expect(scheduledSegmentOf(full, 0, "onboarding").economics.basisAuditRowId).toBe(
      "replay-controls-recorded-arms",
    );
    expect(scheduledSegmentOf(full, 0, "intent").economics.basisAuditRowId).toBe(
      "replay-adjusted-cost-verdicts",
    );
    expect(scheduledSegmentOf(full, 0, "plan").economics.basisAuditRowId).toBe(
      "replay-savings-attribution-splits",
    );
    expect(scheduledSegmentOf(full, 0, "daily-usage").economics.basisAuditRowId).toBe(
      "replay-cross-workload-verdicts",
    );
    expect(scheduledSegmentOf(full, 0, "outcome").economics.basisAuditRowId).toBe(
      "replay-longitudinal-curve-points",
    );
    // A DRIFTED corpus THROWS before any window can be observed: an
    // unresolvable audit anchor, a stale journey reference, a
    // synthesized failure shape, a stale replay fixture.
    expect(() => carriedBasisDigestOf("no-such-audit-row")).toThrow(
      /the VAL-049 audit corpus holds no row no-such-audit-row/,
    );
    expect(() =>
      deriveShiftSchedule({ shifts: [{ journeyRowId: "no-such-journey-row" }] }),
    ).toThrow(/the VAL-050 journey corpus holds no row no-such-journey-row/);
    expect(() =>
      deriveShiftSchedule({
        shifts: [{ journeyRowId: "full-journey-recorded-portfolio", failureStage: "onboarding" }],
      }),
    ).toThrow(/failure shape that is not the recorded one/);
    expect(() => recordedJourneyReplayFor("no-such-journey-row")).toThrow(
      /the VAL-050 journey corpus holds no row no-such-journey-row/,
    );
    // The honest references resolve through the corpora's OWN resolvers
    // (the recorded replay fixtures carry the two-attempt shape at the
    // continuation row's own recorded failure stage).
    const portfolioReplay = recordedJourneyReplayFor("full-journey-recorded-portfolio");
    expect(portfolioReplay.stages).toHaveLength(5);
    expect(portfolioReplay.replayDigest).toMatch(/^[0-9a-f]{8}$/);
    const continuationReplay = recordedJourneyReplayFor("journey-continuation-resume");
    const failureStageReplay = continuationReplay.stages.find(
      (fact) => fact.stage === "daily-usage",
    );
    expect(failureStageReplay?.recordedAttempts).toBe(2);
    expect(failureStageReplay?.recordedResolved).toBe(1);
    for (const fact of continuationReplay.stages) {
      expect(fact.recordedAttempts, fact.stage).toBe(fact.stage === "daily-usage" ? 2 : 1);
    }
  });

  test("payload bytes never in evidence", () => {
    const full = rowOf(FULL_ROW_ID);
    const observation = observationOf(FULL_ROW_ID);
    // Every evidence line of every driven row (all 14, honest + probe +
    // live) is single-line text free of control characters and never
    // carries a payload-shaped blob — digests (8 hex) and microUsd
    // amounts only.
    for (const row of PILOT_CORPUS_ROWS) {
      const result = pilotRowResultFor(row);
      for (const criterion of result.criteria) {
        for (const line of criterion.evidence) {
          expect(typeof line, `${row.rowId}/${criterion.criterionId}`).toBe("string");
          expect(line, `${row.rowId}/${criterion.criterionId}`).not.toMatch(/\p{Cc}/u);
          expect(line, `${row.rowId}/${criterion.criterionId}`).not.toMatch(/[A-Za-z0-9+/=]{41,}/);
        }
      }
    }
    // The window-record digest is over the observed shift IDENTITIES
    // (the ordinals, the workload references and the stage:attempts:
    // resolved shapes) — payload-free: a cost edit changes NOTHING,
    // an attempt-shape edit changes the digest.
    const costEdited = windowRecordDigestOf({
      rowId: full.rowId,
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
      rowId: full.rowId,
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
    // Every observation's own window digest recomputes over the same
    // identity basis (digest-only, never payload bytes).
    for (const rowId of HONEST_ROW_IDS) {
      const rowObservation = observationOf(rowId);
      expect(rowObservation.windowDigest, rowId).toBe(
        windowRecordDigestOf({
          rowId: rowObservation.rowId,
          basis: rowObservation.basis,
          shifts: rowObservation.shifts,
        }),
      );
    }
    // The ledger lines carry amounts, ids and DIGESTS only (the line
    // digest is the FNV-1a over the line's own content — payload-free).
    for (const line of observation.ledger) {
      expect(line.amountMicroUsd).toMatch(/^[0-9]+$/);
      expect(line.lineDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(line.previousDigest).toMatch(/^[0-9a-f]{8}$/);
    }
    // The incident dispositions carry content DIGESTS, never content.
    for (const row of OFFLINE_CORPUS_ROWS) {
      for (const record of observationOf(row.rowId).incidents) {
        expect(record.disposition.detailDigest, row.rowId).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });
});
