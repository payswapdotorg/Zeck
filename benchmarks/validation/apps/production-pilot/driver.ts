/**
 * The production-pilot engine (VAL-051, the app-local driver — the
 * work order's allowed surface ONLY).
 *
 * THE PILOT MACHINERY: the mechanical engine over the declared pilot
 * shape — the deterministic sustained-observation window (the
 * schedule of shifts replaying RECORDED workloads with their
 * recorded input digests, the drift report, the incident log, the
 * append-only budget ledger and the end-of-window accounting) and
 * the EIGHT mechanical observation oracles (the spec's verification
 * core):
 *
 *   * WINDOW HONESTY — the declared observation window matches the
 *     recorded data: the observed window equals the declared window
 *     AND the declared window covers the full schedule — a
 *     cherry-picked sub-window FAILs with the omitted segments NAMED;
 *   * SCHEDULE COMPLETENESS — every scheduled shift inside the
 *     observed window lands exactly once; a missing, duplicated,
 *     reordered or undeclared shift FAILs NAMED;
 *   * CONTINUATION EXACTLY-ONCE — a declared incident (the recorded
 *     failure/continuation machinery) resumes EXACTLY ONCE (the
 *     failed shift lands exactly two durable executions: the failed
 *     attempt plus one resume); an undeclared resume or a duplicated
 *     resume FAILs NAMED;
 *   * DRIFT-CLASSIFICATION HONESTY — every segment's observed
 *     economics are classified against the declared drift bands:
 *     within-bounds / drifting with the mechanism NAMED / regressing
 *     reported as regressing — a silently normalized drift or a
 *     hidden regression FAILs with the segment and mechanism NAMED;
 *   * INCIDENT HONESTY — every incident in the window is recorded
 *     and attributed (mechanism + detail); a hidden, unattributed,
 *     misattributed or undeclared incident FAILs NAMED;
 *   * BUDGET-POLICY ENVELOPE INTEGRITY — the reservations settle,
 *     no unauthorized spend (never beyond a shift's reservation nor
 *     the window budget), the per-shift latency policy holds and
 *     the ledger is append-only with every spend and the release
 *     entry reconciling;
 *   * END-OF-WINDOW ACCOUNTING RECONCILIATION — the window's
 *     accounting reconciles shift-for-shift against the recorded
 *     basis (every observed deviation explained by the declared
 *     drift deltas; the reported total equals the observed sum; the
 *     release reconciles) — an unexplained residual FAILs with the
 *     amount NAMED;
 *   * CUSTOMER BOUNDARY — every shift executes under the pilot's
 *     own customer identity; a shift under any other identity is a
 *     cross-tenant leak and FAILs NAMED.
 *
 * The shifts REPLAY RECORDED workloads — the observation's economics
 * are pure derivations over the RECORDED basis (never a
 * re-measurement, never a re-pricing; the live row's economics are
 * MEASURED on the live rail, never fabricated here).
 *
 * The digest discipline: the house FNV-1a convention
 * (`economicDigestOf`, imported from the VAL-040 driver — never
 * re-implemented); every evidence reference is digest-only, payload
 * bytes never appear.
 */

import type { LabVerificationCriterion } from "../../platform/derive";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  DRIFT_BANDS,
  type DriftClassificationKind,
  PILOT_CUSTOMER_APPLICATION_ID,
  type PilotProbeKind,
  type PilotVerdictKind,
  type ProductionPilotCorpusRow,
  RECORDED_SEGMENT_QUALITY,
} from "./corpus";

/** The foreign identity the boundary-leak probe executes under (the leak shape). */
export const FOREIGN_APPLICATION_ID = "app-other-customer";

/** The workload the dropped-shift and boundary-leak probes denature (the daily-usage shift). */
const PROBE_WORKLOAD = "daily-usage";

/** One shift's observed record (the sustained-observation member). */
export interface ShiftObservation {
  readonly shiftIndex: number;
  readonly shiftId: string;
  /** The recorded workload the shift replayed (the chained basis). */
  readonly workload: string;
  /** The durable execution the shift landed ("" never happens — a dropped shift is absent). */
  readonly executionId: string;
  /** How many durable executions the shift landed (1; 2 when resumed exactly once). */
  readonly executions: number;
  /** Whether the shift's record includes a resumed attempt (a declared incident resumed). */
  readonly resumed: boolean;
  /** The identity the shift executed under (the customer-boundary basis). */
  readonly applicationId: string;
  /** The observed shift cost (microUsd — the recorded basis plus the declared drift delta). */
  readonly observedCostMicroUsd: string;
  /** The observed shift latency (ms — the recorded basis plus the declared drift delta). */
  readonly observedLatencyMs: number;
  /** The observed shift quality (0..1 — the recorded basis plus the declared drift delta). */
  readonly observedQuality: number;
  /** The shift's budget reservation (the envelope member of record). */
  readonly reservationMicroUsd: string;
  /** The shift's drift-report entry (the honest classification — or the forged one). */
  readonly drift: SegmentDriftEntry;
}

/** One segment's drift-report entry (the classification of record). */
export interface SegmentDriftEntry {
  readonly shiftIndex: number;
  readonly classification: DriftClassificationKind;
  /** The mechanism a drifting/regressing classification names (null within bounds). */
  readonly mechanism: string | null;
  readonly costDeltaMicroUsd: string;
  readonly latencyDeltaMs: number;
  readonly qualityDelta: number;
}

/** One incident-log entry (the recorded, attributed incident). */
export interface IncidentLogEntry {
  readonly shiftIndex: number;
  readonly shiftId: string;
  readonly kind: string;
  readonly mechanism: string;
  readonly detail: string;
}

/** One append-only ledger entry (a shift spend or the end-of-window release). */
export interface LedgerEntry {
  readonly sequence: number;
  readonly kind: "spend" | "release";
  readonly shiftId: string | null;
  readonly amountMicroUsd: string;
}

/** The window's end-of-window accounting (the reported totals). */
export interface PilotAccounting {
  readonly totalCostMicroUsd: string;
  readonly totalLatencyMs: number;
  /** The total the window reserved (the reservations it settled). */
  readonly reservedTotalMicroUsd: string;
  /** The released remainder (reservations settle at end of window). */
  readonly releasedMicroUsd: string;
}

/** The pilot observation (the result read's pilot package). */
export interface PilotObservation {
  readonly rowId: string;
  readonly window: { readonly startShift: number; readonly endShift: number };
  readonly shifts: readonly ShiftObservation[];
  readonly driftReport: readonly SegmentDriftEntry[];
  readonly incidentLog: readonly IncidentLogEntry[];
  readonly ledger: readonly LedgerEntry[];
  readonly reported: PilotAccounting;
  /** The window digest over the shift identities (payload-free). */
  readonly windowDigest: string;
  /** The measured usage (the live rail only; honestly null offline). */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/** The derived pilot verdict (never a narrative). */
export interface PilotVerdict {
  readonly verdict: PilotVerdictKind;
  /** The criteria a PILOT-FAILED verdict NAMED (empty otherwise). */
  readonly failedCriteria: readonly string[];
}

// ---------------------------------------------------------------------------
// The deterministic sustained-observation derivation (PURE)
// ---------------------------------------------------------------------------

/**
 * Derive one row's deterministic pilot observation (PURE — the
 * recorded-basis derivation over the declared shape; the adversarial
 * probe variants denature the honest window exactly as the work
 * order's discrimination battery demands: a cherry-picked window, a
 * dropped shift, a double-driven resume, a normalized drift, a
 * hidden incident, a hidden residual, a boundary leak).
 */
export function pilotObservationFor(
  row: ProductionPilotCorpusRow,
  options?: { readonly probe?: PilotProbeKind },
): PilotObservation {
  const probe = options?.probe ?? row.probe?.kind ?? null;
  const incidentOf = new Map(row.incidents.map((incident) => [incident.shiftIndex, incident]));
  const driftOf = new Map(row.declaredDrift.map((drift) => [drift.shiftIndex, drift]));
  // The cherry-picking probe observes only a sub-window (the last
  // scheduled shift silently omitted).
  const observedEnd =
    probe === "window-cherry-picking" ? row.window.endShift - 1 : row.window.endShift;
  const honestShifts: ShiftObservation[] = [];
  for (const shift of row.schedule) {
    if (shift.shiftIndex > observedEnd) {
      continue;
    }
    // The dropped-shift probe silently drops the daily-usage shift.
    if (probe === "dropped-shift" && shift.workload === PROBE_WORKLOAD) {
      continue;
    }
    const declaredDrives = incidentOf.has(shift.shiftIndex) ? 2 : 1;
    // The double-driven-resume probe drives ONE extra execution of
    // the incident's shift beyond its declared allowance — over a row
    // WITH a declared incident that is a resume driven twice (three
    // executions); over a row WITHOUT one it is an UNDECLARED resume
    // (two executions). Both shapes FAIL the continuation oracle NAMED.
    const extraDrive =
      probe === "double-driven-resume" && shift.workload === PROBE_WORKLOAD ? 1 : 0;
    const drives = declaredDrives + extraDrive;
    const unitCost = BigInt(shift.economics.costMicroUsd) / BigInt(declaredDrives);
    const unitLatency = shift.economics.latencyMs / declaredDrives;
    const declared = driftOf.get(shift.shiftIndex);
    const deltaCost = declared === undefined ? 0n : BigInt(declared.costDeltaMicroUsd);
    const deltaLatency = declared === undefined ? 0 : declared.latencyDeltaMs;
    const deltaQuality = declared === undefined ? 0 : declared.qualityDelta;
    const observedCost = unitCost * BigInt(drives) + deltaCost;
    const observedLatency = unitLatency * drives + deltaLatency;
    const observedQuality = RECORDED_SEGMENT_QUALITY + deltaQuality;
    const entry = driftEntryFor({
      shiftIndex: shift.shiftIndex,
      costDeltaMicroUsd: deltaCost.toString(),
      latencyDeltaMs: deltaLatency,
      observedQuality: observedQuality,
      declaredMechanism: declared?.mechanism ?? null,
      forgeWithinBounds: probe === "drift-normalizing" && declared !== undefined,
    });
    honestShifts.push({
      shiftIndex: shift.shiftIndex,
      shiftId: shift.shiftId,
      workload: shift.workload,
      executionId: `pilot-exec-${row.rowId}-${shift.shiftId}`,
      executions: drives,
      resumed: drives > 1,
      applicationId:
        probe === "boundary-leak" && shift.workload === PROBE_WORKLOAD
          ? FOREIGN_APPLICATION_ID
          : PILOT_CUSTOMER_APPLICATION_ID,
      observedCostMicroUsd: observedCost.toString(),
      observedLatencyMs: observedLatency,
      observedQuality: observedQuality,
      reservationMicroUsd: shift.reservationMicroUsd,
      drift: entry,
    });
  }
  // The drift-normalizing probe forges the drifting segment's
  // drift-report entry (classified within bounds, the delta
  // normalized away — the drift-classification oracle catches the
  // forgery; the accounting oracle names the unexplained residual).
  const shifts = honestShifts;
  const observedCostTotal = shifts.reduce(
    (total, record) => total + BigInt(record.observedCostMicroUsd),
    0n,
  );
  const observedLatencyTotal = shifts.reduce(
    (total, record) => total + record.observedLatencyMs,
    0,
  );
  const reservedTotal = shifts.reduce(
    (total, record) => total + BigInt(record.reservationMicroUsd),
    0n,
  );
  // The incident log: every declared incident recorded and
  // attributed — the incident-hiding probe silently omits the entry.
  const incidentLog: IncidentLogEntry[] =
    probe === "incident-hiding"
      ? []
      : row.incidents.map((incident) => ({
          shiftIndex: incident.shiftIndex,
          shiftId: `shift-${incident.shiftIndex}`,
          kind: "shift-failure-resume",
          mechanism: incident.mechanism,
          detail: incident.detail,
        }));
  // The append-only budget ledger: one spend entry per observed
  // shift (in schedule order) plus the end-of-window release (the
  // reservations settle — the released remainder is NAMED).
  const ledger: LedgerEntry[] = shifts.map((record, index) => ({
    sequence: index + 1,
    kind: "spend",
    shiftId: record.shiftId,
    amountMicroUsd: record.observedCostMicroUsd,
  }));
  ledger.push({
    sequence: shifts.length + 1,
    kind: "release",
    shiftId: null,
    amountMicroUsd: (reservedTotal - observedCostTotal).toString(),
  });
  // The residual-hiding probe reports a total that hides half the
  // daily-usage shift's observed cost (the unexplained residual).
  const hiddenResidual =
    probe === "residual-hiding"
      ? BigInt(
          shifts.find((record) => record.workload === PROBE_WORKLOAD)?.observedCostMicroUsd ?? "0",
        ) / 2n
      : 0n;
  const observation: PilotObservation = {
    rowId: row.rowId,
    window: { startShift: row.window.startShift, endShift: observedEnd },
    shifts,
    driftReport: shifts.map((record) => record.drift),
    incidentLog,
    ledger,
    reported: {
      totalCostMicroUsd: (observedCostTotal - hiddenResidual).toString(),
      totalLatencyMs: observedLatencyTotal,
      reservedTotalMicroUsd: reservedTotal.toString(),
      releasedMicroUsd: (reservedTotal - observedCostTotal).toString(),
    },
    windowDigest: economicDigestOf({
      rowId: row.rowId,
      window: `${row.window.startShift}-${observedEnd}`,
      shifts: shifts.map((record) => `${record.shiftId}:${record.executions}`),
    }),
    usage: null,
  };
  return observation;
}

/**
 * The honest drift classification of one segment (PURE — derived
 * from the observed deltas and the declared drift bands).
 */
export function honestDriftClassificationOf(input: {
  readonly costDeltaMicroUsd: string;
  readonly latencyDeltaMs: number;
  readonly observedQuality: number;
}): DriftClassificationKind {
  const costDelta = BigInt(input.costDeltaMicroUsd);
  const costBand = BigInt(DRIFT_BANDS.costMicroUsd);
  const within =
    costDelta <= costBand &&
    costDelta >= -costBand &&
    Math.abs(input.latencyDeltaMs) <= DRIFT_BANDS.latencyMs &&
    input.observedQuality >= DRIFT_BANDS.qualityFloor;
  if (input.observedQuality < DRIFT_BANDS.qualityFloor) {
    return "regressing";
  }
  return within ? "within-bounds" : "drifting";
}

/** Derive one segment's drift-report entry (the honest classification). */
function driftEntryFor(input: {
  readonly shiftIndex: number;
  readonly costDeltaMicroUsd: string;
  readonly latencyDeltaMs: number;
  readonly observedQuality: number;
  readonly declaredMechanism: string | null;
  readonly forgeWithinBounds: boolean;
}): SegmentDriftEntry {
  const honest = honestDriftClassificationOf({
    costDeltaMicroUsd: input.costDeltaMicroUsd,
    latencyDeltaMs: input.latencyDeltaMs,
    observedQuality: input.observedQuality,
  });
  if (input.forgeWithinBounds) {
    // The drift-normalizing probe: the dishonest report classifies
    // the drifting segment within bounds with its delta normalized
    // away (the drift-classification oracle catches the forgery; the
    // accounting oracle names the unexplained residual).
    return {
      shiftIndex: input.shiftIndex,
      classification: "within-bounds",
      mechanism: null,
      costDeltaMicroUsd: "0",
      latencyDeltaMs: 0,
      qualityDelta: 0,
    };
  }
  return {
    shiftIndex: input.shiftIndex,
    classification: honest,
    mechanism: honest === "within-bounds" ? null : input.declaredMechanism,
    costDeltaMicroUsd: input.costDeltaMicroUsd,
    latencyDeltaMs: input.latencyDeltaMs,
    qualityDelta: input.observedQuality - RECORDED_SEGMENT_QUALITY,
  };
}

// ---------------------------------------------------------------------------
// The eight mechanical observation oracles (PURE — the verification core)
// ---------------------------------------------------------------------------

/**
 * Verify one pilot observation against its declared row (PURE): the
 * eight mechanical observation criteria — window honesty, schedule
 * completeness, continuation exactly-once, drift-classification
 * honesty, incident honesty, budget-policy envelope integrity,
 * end-of-window accounting reconciliation and customer-boundary
 * integrity — each FAILing with the violating shift, segment,
 * residual or identity NAMED.
 */
export function verifyProductionPilotIntegrity(input: {
  readonly row: ProductionPilotCorpusRow;
  readonly observation: PilotObservation;
}): readonly LabVerificationCriterion[] {
  const { row, observation } = input;
  const criteria: LabVerificationCriterion[] = [];
  const declaredByShift = new Map(row.schedule.map((shift) => [shift.shiftIndex, shift]));
  const incidentByShift = new Map(row.incidents.map((incident) => [incident.shiftIndex, incident]));

  // 1. WINDOW HONESTY — the declared observation window matches the
  //    recorded data: the observed window equals the declared window
  //    AND the declared window covers the full schedule (a
  //    cherry-picked sub-window FAILs with the omitted segments NAMED).
  const scheduleStart = row.schedule[0]?.shiftIndex ?? 1;
  const scheduleEnd = row.schedule.length;
  const observedEqDeclared =
    observation.window.startShift === row.window.startShift &&
    observation.window.endShift === row.window.endShift;
  const declaredCoversSchedule =
    row.window.startShift === scheduleStart && row.window.endShift === scheduleEnd;
  const omittedSegments: string[] = [];
  for (let index = observation.window.endShift + 1; index <= row.window.endShift; index += 1) {
    omittedSegments.push(`shift-${index}`);
  }
  const undeclaredSegments: string[] = [];
  for (let index = scheduleEnd + 1; index <= observation.window.endShift; index += 1) {
    undeclaredSegments.push(`shift-${index}`);
  }
  criteria.push({
    criterionId: "window-honesty",
    strategy: "deterministic",
    status:
      observedEqDeclared && declaredCoversSchedule && omittedSegments.length === 0
        ? "PASS"
        : "FAIL",
    evidence: [
      `declared-window:${row.window.startShift}-${row.window.endShift}`,
      `observed-window:${observation.window.startShift}-${observation.window.endShift}`,
      `schedule:${scheduleStart}-${scheduleEnd}`,
      ...(omittedSegments.length === 0 ? [] : [`omitted-segment:${omittedSegments.join(",")}`]),
      ...(undeclaredSegments.length === 0
        ? []
        : [`undeclared-segment:${undeclaredSegments.join(",")}`]),
      ...(declaredCoversSchedule ? [] : ["cherry-picked-declared-window"]),
    ],
  });

  // 2. SCHEDULE COMPLETENESS — every scheduled shift inside the
  //    observed window lands exactly once (a missing, duplicated,
  //    reordered or undeclared shift FAILs NAMED).
  const scheduledInWindow = row.schedule.filter(
    (shift) =>
      shift.shiftIndex >= observation.window.startShift &&
      shift.shiftIndex <= observation.window.endShift,
  );
  const observedIds = observation.shifts.map((record) => record.shiftId);
  const scheduledIds = scheduledInWindow.map((shift) => shift.shiftId);
  const missingShifts = scheduledIds.filter((shiftId) => !observedIds.includes(shiftId));
  const extraShifts = observedIds.filter((shiftId) => !scheduledIds.includes(shiftId));
  const shiftOrder =
    scheduledIds.length === observedIds.length &&
    scheduledIds.every((shiftId, index) => observedIds[index] === shiftId);
  const duplicatedShifts = new Set(observedIds).size !== observedIds.length;
  criteria.push({
    criterionId: "schedule-completeness",
    strategy: "deterministic",
    status:
      missingShifts.length === 0 && extraShifts.length === 0 && shiftOrder && !duplicatedShifts
        ? "PASS"
        : "FAIL",
    evidence: [
      `declared-shifts:${scheduledIds.join(">") || "none"}`,
      `observed-shifts:${observedIds.join(">") || "none"}`,
      ...(missingShifts.length === 0 ? [] : [`missing-shift:${missingShifts.join(",")}`]),
      ...(extraShifts.length === 0 ? [] : [`undeclared-shift:${extraShifts.join(",")}`]),
      ...(shiftOrder || missingShifts.length > 0 || extraShifts.length > 0
        ? []
        : ["shift-order-divergence"]),
      ...(duplicatedShifts ? ["duplicated-shift-record"] : []),
    ],
  });

  // 3. CONTINUATION EXACTLY-ONCE — a declared incident resumes
  //    EXACTLY ONCE (the failed shift lands exactly two durable
  //    executions: the failed attempt plus one resume); an undeclared
  //    resume or a duplicated resume FAILs NAMED.
  const resumeViolations = observation.shifts.filter((record) => {
    const declaredIncident = incidentByShift.has(record.shiftIndex);
    const expectedExecutions = declaredIncident ? 2 : 1;
    return record.executions !== expectedExecutions || record.resumed !== declaredIncident;
  });
  criteria.push({
    criterionId: "continuation-exactly-once",
    strategy: "deterministic",
    status: resumeViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      ...(row.incidents.length === 0
        ? ["declared-incident:none"]
        : row.incidents.map((incident) => `declared-incident:shift-${incident.shiftIndex}`)),
      ...observation.shifts.map(
        (record) =>
          `shift-${record.shiftIndex}:executions=${record.executions},resumed=${record.resumed}`,
      ),
      ...(resumeViolations.length === 0
        ? []
        : resumeViolations.map(
            (record) =>
              `resume-violation:shift-${record.shiftIndex} (observed executions=${record.executions}, resumed=${record.resumed}; expected exactly ${
                incidentByShift.has(record.shiftIndex)
                  ? "2 (one failed attempt plus exactly one resume)"
                  : "1 (no declared incident)"
              })`,
          )),
    ],
  });

  // 4. DRIFT-CLASSIFICATION HONESTY — every segment's observed
  //    economics are classified honestly against the declared drift
  //    bands: within-bounds / drifting with the mechanism NAMED /
  //    regressing reported as regressing. A silently normalized drift
  //    or a hidden regression FAILs with the segment and mechanism NAMED.
  //    (The classification judges the segment's DRIFT — the per-unit
  //    deviation at the observed drive count — so a duplicated resume
  //    is the continuation oracle's catch and an absent shift the
  //    schedule oracle's; never double-counted here.)
  const driftViolations: string[] = [];
  for (const record of observation.shifts) {
    const declared = declaredByShift.get(record.shiftIndex);
    if (declared === undefined) {
      continue;
    }
    const declaredDrives = incidentByShift.has(record.shiftIndex) ? 2 : 1;
    const unitCost = BigInt(declared.economics.costMicroUsd) / BigInt(declaredDrives);
    const fairBasisCost = unitCost * BigInt(record.executions);
    const costDelta = BigInt(record.observedCostMicroUsd) - fairBasisCost;
    const unitLatency = declared.economics.latencyMs / declaredDrives;
    const latencyDelta = record.observedLatencyMs - unitLatency * record.executions;
    const honest = honestDriftClassificationOf({
      costDeltaMicroUsd: costDelta.toString(),
      latencyDeltaMs: latencyDelta,
      observedQuality: record.observedQuality,
    });
    if (record.drift.classification !== honest) {
      if (honest !== "within-bounds" && record.drift.classification === "within-bounds") {
        driftViolations.push(
          `normalized-drift:shift-${record.shiftIndex} (cost delta ${costDelta.toString()} beyond band ${DRIFT_BANDS.costMicroUsd}, reported within-bounds: the drift silently normalized away)`,
        );
      } else {
        driftViolations.push(
          `misclassified-drift:shift-${record.shiftIndex} (honest ${honest}, reported ${record.drift.classification})`,
        );
      }
      continue;
    }
    if (honest !== "within-bounds" && record.drift.mechanism === null) {
      driftViolations.push(
        `unattributed-drift:shift-${record.shiftIndex} (${honest} with no mechanism named)`,
      );
    }
  }
  criteria.push({
    criterionId: "drift-classification-honesty",
    strategy: "deterministic",
    status: driftViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `drift-bands:cost<=${DRIFT_BANDS.costMicroUsd},latency<=${DRIFT_BANDS.latencyMs},quality>=${DRIFT_BANDS.qualityFloor}`,
      ...observation.shifts.map(
        (record) =>
          `shift-${record.shiftIndex}:classification=${record.drift.classification},mechanism=${record.drift.mechanism ?? "none"}`,
      ),
      ...driftViolations,
    ],
  });

  // 5. INCIDENT HONESTY — every incident in the window is recorded
  //    and attributed; a hidden, unattributed, misattributed or
  //    undeclared incident FAILs NAMED.
  const incidentViolations: string[] = [];
  for (const record of observation.shifts) {
    const logged = observation.incidentLog.find((entry) => entry.shiftIndex === record.shiftIndex);
    if (record.executions >= 2 && logged === undefined) {
      incidentViolations.push(
        `hidden-incident:shift-${record.shiftIndex} (resumed execution with no incident record)`,
      );
    }
  }
  for (const incident of row.incidents) {
    const logged = observation.incidentLog.find(
      (entry) => entry.shiftIndex === incident.shiftIndex,
    );
    if (logged === undefined) {
      incidentViolations.push(
        `hidden-incident:shift-${incident.shiftIndex} (declared incident never recorded)`,
      );
    } else if (logged.mechanism !== incident.mechanism || logged.detail !== incident.detail) {
      incidentViolations.push(
        `misattributed-incident:shift-${incident.shiftIndex} (mechanism ${logged.mechanism}, declared ${incident.mechanism})`,
      );
    }
  }
  for (const entry of observation.incidentLog) {
    const declared = incidentByShift.get(entry.shiftIndex);
    if (declared === undefined) {
      incidentViolations.push(`undeclared-incident:${entry.shiftId}`);
    } else if (entry.mechanism.length === 0 || entry.detail.length === 0) {
      incidentViolations.push(
        `unattributed-incident:${entry.shiftId} (no mechanism or detail named)`,
      );
    }
  }
  criteria.push({
    criterionId: "incident-honesty",
    strategy: "deterministic",
    status: incidentViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `declared-incidents:${row.incidents.length}`,
      `recorded-incidents:${observation.incidentLog.length}`,
      ...row.incidents.map(
        (incident) =>
          `shift-${incident.shiftIndex}:incident=recorded,mechanism=${incident.mechanism}`,
      ),
      ...incidentViolations,
    ],
  });

  // 6. BUDGET-POLICY ENVELOPE INTEGRITY — the reservations settle,
  //    no unauthorized spend (never beyond a shift's reservation nor
  //    the window budget), the per-shift latency policy holds and
  //    the ledger is append-only with every spend and the release
  //    entry reconciling.
  const envelopeViolations: string[] = [];
  for (const record of observation.shifts) {
    const declared = declaredByShift.get(record.shiftIndex);
    if (declared === undefined) {
      continue;
    }
    if (BigInt(record.observedCostMicroUsd) > BigInt(declared.reservationMicroUsd)) {
      envelopeViolations.push(
        `unauthorized-spend:shift-${record.shiftIndex} (observed ${record.observedCostMicroUsd} over reservation ${declared.reservationMicroUsd})`,
      );
    }
    if (record.observedLatencyMs > declared.maxLatencyMs) {
      envelopeViolations.push(
        `policy-latency-breach:shift-${record.shiftIndex} (observed ${record.observedLatencyMs} over policy ${declared.maxLatencyMs})`,
      );
    }
  }
  const observedCostTotal = observation.shifts.reduce(
    (total, record) => total + BigInt(record.observedCostMicroUsd),
    0n,
  );
  const reservedTotal = observation.shifts.reduce(
    (total, record) => total + BigInt(record.reservationMicroUsd),
    0n,
  );
  if (observedCostTotal > BigInt(row.budgetMicroUsd)) {
    envelopeViolations.push(
      `budget-exceeded (observed ${observedCostTotal.toString()} over window budget ${row.budgetMicroUsd})`,
    );
  }
  const spendEntries = observation.ledger.filter((entry) => entry.kind === "spend");
  const releaseEntries = observation.ledger.filter((entry) => entry.kind === "release");
  const ledgerSpendSum = spendEntries.reduce(
    (total, entry) => total + BigInt(entry.amountMicroUsd),
    0n,
  );
  const appendOnly =
    observation.ledger.length > 0 &&
    observation.ledger.every((entry, index) => entry.sequence === index + 1);
  if (!appendOnly) {
    envelopeViolations.push("ledger-not-append-only (sequences not 1..N in order)");
  }
  if (
    spendEntries.length !== observation.shifts.length ||
    !spendEntries.every(
      (entry, index) => entry.shiftId === (observation.shifts[index]?.shiftId ?? ""),
    )
  ) {
    envelopeViolations.push(
      `spend-entry-mismatch (expected ${observation.shifts.length} spend entries in schedule order, observed ${spendEntries.length})`,
    );
  }
  if (ledgerSpendSum !== observedCostTotal) {
    envelopeViolations.push(
      `ledger-spend-sum-mismatch (ledger ${ledgerSpendSum.toString()} vs observed ${observedCostTotal.toString()})`,
    );
  }
  const releaseAmount = releaseEntries[0]?.amountMicroUsd ?? null;
  const expectedRelease = reservedTotal - observedCostTotal;
  if (releaseEntries.length !== 1 || releaseAmount === null) {
    envelopeViolations.push("unsettled-reservation (no single release entry at end of window)");
  } else if (BigInt(releaseAmount) !== expectedRelease) {
    envelopeViolations.push(
      `release-entry-mismatch (release ${releaseAmount} vs reserved ${reservedTotal.toString()} minus observed ${observedCostTotal.toString()})`,
    );
  } else if (expectedRelease < 0n) {
    envelopeViolations.push(
      `unsettled-reservation (release ${expectedRelease.toString()}: the reservations never settled, spend ran beyond the envelope)`,
    );
  }
  criteria.push({
    criterionId: "budget-policy-envelope",
    strategy: "deterministic",
    status: envelopeViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `budget:${row.budgetMicroUsd}`,
      `observed-total:${observedCostTotal.toString()}`,
      `reserved-total:${reservedTotal.toString()}`,
      `released:${(reservedTotal - observedCostTotal).toString()}`,
      `ledger-entries:${observation.ledger.length}`,
      `ledger-append-only:${appendOnly}`,
      `policy:per-shift-max-latency`,
      ...envelopeViolations,
    ],
  });

  // 7. END-OF-WINDOW ACCOUNTING RECONCILIATION — the window's
  //    accounting reconciles shift-for-shift against the recorded
  //    basis: each observed shift's economics equal its declared
  //    recorded economics plus its drift-report delta, the observed
  //    sum equals the recorded basis plus the declared drift deltas,
  //    the reported window total equals the observed sum and the
  //    release reconciles (zero residual — an unexplained residual
  //    FAILs with the amount NAMED).
  const accountingViolations: string[] = [];
  for (const record of observation.shifts) {
    const declared = declaredByShift.get(record.shiftIndex);
    if (declared === undefined) {
      continue;
    }
    const residual =
      BigInt(record.observedCostMicroUsd) -
      BigInt(declared.economics.costMicroUsd) -
      BigInt(record.drift.costDeltaMicroUsd);
    if (residual !== 0n) {
      accountingViolations.push(
        `unexplained-residual:shift-${record.shiftIndex} (${residual.toString()})`,
      );
    }
    const latencyResidual =
      record.observedLatencyMs - declared.economics.latencyMs - record.drift.latencyDeltaMs;
    if (latencyResidual !== 0) {
      accountingViolations.push(`latency-residual:shift-${record.shiftIndex} (${latencyResidual})`);
    }
  }
  const recordedBasis = row.schedule.reduce(
    (total, shift) => total + BigInt(shift.economics.costMicroUsd),
    0n,
  );
  const recordedLatencyBasis = row.schedule.reduce(
    (total, shift) => total + shift.economics.latencyMs,
    0,
  );
  const declaredDriftTotal = observation.shifts.reduce(
    (total, record) => total + BigInt(record.drift.costDeltaMicroUsd),
    0n,
  );
  const windowBasisResidual = recordedBasis + declaredDriftTotal - observedCostTotal;
  if (windowBasisResidual !== 0n) {
    accountingViolations.push(
      `window-basis-residual:${windowBasisResidual.toString()} (recorded basis ${recordedBasis.toString()} plus declared drift ${declaredDriftTotal.toString()} vs observed ${observedCostTotal.toString()})`,
    );
  }
  const reportedCostTotal = BigInt(observation.reported.totalCostMicroUsd);
  const costResidual = reportedCostTotal - observedCostTotal;
  if (costResidual !== 0n) {
    accountingViolations.push(`cost-residual:${costResidual.toString()}`);
  }
  const observedLatencyTotal = observation.shifts.reduce(
    (total, record) => total + record.observedLatencyMs,
    0,
  );
  const latencyResidualTotal = observation.reported.totalLatencyMs - observedLatencyTotal;
  if (latencyResidualTotal !== 0) {
    accountingViolations.push(`latency-residual:${latencyResidualTotal}`);
  }
  const releaseResidual =
    BigInt(observation.reported.releasedMicroUsd) - (reservedTotal - observedCostTotal);
  if (releaseResidual !== 0n) {
    accountingViolations.push(`release-residual:${releaseResidual.toString()}`);
  }
  criteria.push({
    criterionId: "end-of-window-accounting",
    strategy: "deterministic",
    status: accountingViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `recorded-basis:${recordedBasis.toString()}`,
      `declared-drift-deltas:${declaredDriftTotal.toString()}`,
      `observed-shift-sum:${observedCostTotal.toString()}`,
      `reported-window-total:${reportedCostTotal.toString()}`,
      `cost-residual:${costResidual.toString()}`,
      `recorded-latency-basis:${recordedLatencyBasis}`,
      `observed-latency-sum:${observedLatencyTotal}`,
      `reported-latency-total:${observation.reported.totalLatencyMs}`,
      `latency-residual:${latencyResidualTotal}`,
      `reserved-total:${reservedTotal.toString()}`,
      `released:${observation.reported.releasedMicroUsd}`,
      `release-residual:${releaseResidual.toString()}`,
      ...accountingViolations,
    ],
  });

  // 8. CUSTOMER BOUNDARY — every shift executes under the pilot's
  //    own customer identity (a foreign identity is a cross-tenant leak).
  const leaked = observation.shifts.filter(
    (record) => record.applicationId !== PILOT_CUSTOMER_APPLICATION_ID,
  );
  criteria.push({
    criterionId: "customer-boundary",
    strategy: "deterministic",
    status: leaked.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `pilot-customer:${PILOT_CUSTOMER_APPLICATION_ID}`,
      `observed-identities:${new Set(observation.shifts.map((record) => record.applicationId)).size}`,
      ...(leaked.length === 0
        ? []
        : leaked.map(
            (record) =>
              `boundary-leak:shift-${record.shiftIndex} (executed under ${record.applicationId}, not ${PILOT_CUSTOMER_APPLICATION_ID})`,
          )),
    ],
  });

  return criteria;
}

/**
 * Derive the pilot verdict over one observation (PURE): all eight
 * observation criteria PASS → PILOT-COMPLETED; any FAIL →
 * PILOT-FAILED with every failed criterion NAMED.
 */
export function derivePilotVerdict(input: {
  readonly row: ProductionPilotCorpusRow;
  readonly observation: PilotObservation;
}): PilotVerdict {
  const criteria = verifyProductionPilotIntegrity(input);
  const failedCriteria = criteria
    .filter((criterion) => criterion.status === "FAIL")
    .map((criterion) => criterion.criterionId);
  return {
    verdict: failedCriteria.length === 0 ? "PILOT-COMPLETED" : "PILOT-FAILED",
    failedCriteria,
  };
}
