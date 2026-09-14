/**
 * The production-pilot application's deterministic fixtures (VAL-051,
 * AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled fake world the pilot engine and the app execute against:
 *
 *   * the RECORDED JOURNEY-STAGE REPLAY FIXTURES — per journey row the
 *     deterministic stage facts the pilot's shifts replay (the
 *     per-stage economics, latency and resolved quality, the recorded
 *     input digests and the VAL-049 basis anchors), DIGEST-VERIFIED
 *     against the pilot corpus's own pins at module load: every
 *     scheduled segment's recorded digests, economics and anchors
 *     re-resolve through the journey corpus's and the audit corpus's
 *     OWN resolvers (`journeyRowById`, `carriedBasisDigestOf`) — a
 *     drifted corpus THROWS before any window can be observed;
 *   * the WINDOW-FEED BUILDER (`pilotWindowFeedFor`) — the per-row
 *     deterministic window record over the RECORDED basis (the
 *     corpus's own derivation, honestly labeled
 *     `derived-from-recorded-basis`, never claimed as a measurement),
 *     with the FORCED-PROBE knob that applies any of the seven issued
 *     adversarial mechanisms onto an HONEST row's record (the
 *     discrimination battery's leaky stack);
 *   * the SEVEN PROBE TRANSFORMS — each issued probe mechanism as a
 *     PURE fixture transform over an honest window record (the
 *     cherry-picked window, the dropped shift, the double-driven
 *     resume, the drift normalization, the incident hiding, the
 *     residual hiding, the boundary leak), each reproducing the
 *     corpus's own declared corruption exactly (the forced lane never
 *     invents a new corruption shape);
 *   * the FAKE PUBLIC API WORLD — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     pilot window package at the result boundary, the fabrication
 *     knobs) — the "leaky stack" of the discrimination battery;
 *   * the LIVE-GATE-CLOSED fake — the honest NOT RUN lane: the offline
 *     world REFUSES the live rail outright (a live-gated row never
 *     lands a fake execution — the live pilot slice demands the
 *     operator-authorized REAL rail; even a spoofed credential meets
 *     the typed refusal, never a fabricated live slice) and the
 *     application's closed gate yields the honest NOT-RUN path;
 *   * the fake ledger/lifecycle/submission-seam/tick-clock re-exports
 *     IMPORTED from the VAL-040 fixtures (never copied, never
 *     modified) and the REAL accounting rails re-export.
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type { JourneyStageKind, RecordedStageEconomics } from "../customer-journey/corpus";
import { journeyRowById } from "../customer-journey/corpus";
import { FOREIGN_APPLICATION_ID } from "../customer-journey/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import {
  PILOT_CORPUS_ROWS,
  PILOT_TASK_KIND,
  type PilotCorpusRow,
  type PilotProbeKind,
  pilotWindowRecordFor,
} from "./corpus";
import {
  type ContinuationRecord,
  carriedBasisDigestOf,
  createWindowLedger,
  deriveWindowDrift,
  type IncidentRecord,
  type LedgerLine,
  type ObservedShiftRecord,
  type PilotWindowObservation,
  windowRecordDigestOf,
} from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The recorded journey-stage replay fixtures (digest-verified against the corpus pins)
// ---------------------------------------------------------------------------

/** One journey stage's recorded replay fact (the shift replay's deterministic basis). */
export interface RecordedStageReplayFact {
  readonly stage: JourneyStageKind;
  /** The recorded input digests the stage composes (digest references only). */
  readonly recordedInputDigests: readonly string[];
  /** The stage's recorded economics (the carried VAL-049 cost basis, never re-priced). */
  readonly economics: RecordedStageEconomics;
  /**
   * The recorded attempts the stage's recorded basis holds (exactly 2
   * at the journey row's OWN recorded failure stage — the failed
   * attempt plus exactly one resume; 1 otherwise).
   */
  readonly recordedAttempts: number;
  /** The recorded resolved attempts (each recorded stage resolves exactly its final attempt). */
  readonly recordedResolved: number;
}

/**
 * One journey row's recorded replay fixture (the deterministic stage
 * facts every scheduled shift replaying that row derives over — PURE
 * derivation over the RECORDED corpus, never a re-measurement).
 */
export interface RecordedJourneyReplay {
  readonly journeyRowId: string;
  readonly stages: readonly RecordedStageReplayFact[];
  /** The replay fixture's FNV-1a pin (payload-free). */
  readonly replayDigest: string;
}

/**
 * Resolve one journey row's recorded replay fixture (PURE — resolved
 * through the journey corpus's OWN resolver; a stale reference THROWS,
 * never a silent copy).
 */
export function recordedJourneyReplayFor(journeyRowId: string): RecordedJourneyReplay {
  const journeyRow = journeyRowById(journeyRowId);
  if (journeyRow === null) {
    throw new Error(
      `the VAL-050 journey corpus holds no row ${journeyRowId} (a stale pilot fixture cannot silently exist)`,
    );
  }
  const stages: RecordedStageReplayFact[] = journeyRow.stages.map((declaration) => ({
    stage: declaration.stage,
    recordedInputDigests: [...declaration.recordedInputDigests],
    economics: declaration.economics,
    recordedAttempts:
      journeyRow.midJourneyFailureStage !== undefined &&
      journeyRow.midJourneyFailureStage === declaration.stage
        ? 2
        : 1,
    recordedResolved: 1,
  }));
  return {
    journeyRowId: journeyRow.rowId,
    stages,
    replayDigest: economicDigestOf({
      kind: "pilot-recorded-journey-replay",
      journeyRowId: journeyRow.rowId,
      stages: stages.map((fact) => ({
        stage: fact.stage,
        recordedInputDigests: [...fact.recordedInputDigests],
        economics: {
          costMicroUsd: fact.economics.costMicroUsd,
          latencyMs: fact.economics.latencyMs,
          basisAuditRowId: fact.economics.basisAuditRowId,
          basisDigest: fact.economics.basisDigest,
        },
        recordedAttempts: fact.recordedAttempts,
        recordedResolved: fact.recordedResolved,
      })),
    }),
  };
}

/**
 * The recorded journey-stage replay fixtures for EVERY journey row the
 * pilot corpus references (resolved through the journey corpus's OWN
 * resolver at module load — the shifts' replay basis of record).
 */
export const PILOT_RECORDED_JOURNEY_REPLAYS: ReadonlyMap<string, RecordedJourneyReplay> = new Map(
  [
    ...new Set(
      PILOT_CORPUS_ROWS.flatMap((row) => row.schedule.shifts.map((shift) => shift.journeyRowId)),
    ),
  ].map((journeyRowId) => [journeyRowId, recordedJourneyReplayFor(journeyRowId)]),
);

/**
 * Verify the replay fixtures against the pilot corpus's OWN pins
 * (module load — a drifted corpus THROWS before any window can be
 * observed): every scheduled segment's recorded input digests,
 * economics and attempt shape equal the journey corpus's OWN stage
 * declarations, every basis anchor recomputes through the audit
 * corpus's own resolver, and the corpus's recorded-input references
 * mirror the resolved schedule exactly.
 */
function verifyRecordedReplayPins(): void {
  for (const row of PILOT_CORPUS_ROWS) {
    for (const scheduled of row.schedule.shifts) {
      const replay = PILOT_RECORDED_JOURNEY_REPLAYS.get(scheduled.journeyRowId);
      if (replay === undefined) {
        throw new Error(
          `row ${row.rowId} shift ${scheduled.shift} replays journey row ${scheduled.journeyRowId} with no recorded replay fixture`,
        );
      }
      for (const segment of scheduled.segments) {
        const fact = replay.stages.find((candidate) => candidate.stage === segment.stage);
        if (fact === undefined) {
          throw new Error(
            `the recorded replay fixture of ${scheduled.journeyRowId} holds no ${segment.stage} stage (row ${row.rowId} shift ${scheduled.shift})`,
          );
        }
        const inputsMatch =
          fact.recordedInputDigests.length === segment.recordedInputDigests.length &&
          fact.recordedInputDigests.every(
            (digest, index) => digest === segment.recordedInputDigests[index],
          );
        if (!inputsMatch) {
          throw new Error(
            `the recorded input digests of row ${row.rowId} shift ${scheduled.shift} ${segment.stage} drifted from the journey corpus's own declarations`,
          );
        }
        const economicsMatch =
          fact.economics.costMicroUsd === segment.economics.costMicroUsd &&
          fact.economics.latencyMs === segment.economics.latencyMs &&
          fact.economics.basisAuditRowId === segment.economics.basisAuditRowId &&
          fact.economics.basisDigest === segment.economics.basisDigest;
        if (!economicsMatch) {
          throw new Error(
            `the recorded economics of row ${row.rowId} shift ${scheduled.shift} ${segment.stage} drifted from the journey corpus's own declarations`,
          );
        }
        if (fact.recordedAttempts !== segment.declaredAttempts) {
          throw new Error(
            `the recorded attempt shape of row ${row.rowId} shift ${scheduled.shift} ${segment.stage} drifted (fixture ${fact.recordedAttempts}, schedule ${segment.declaredAttempts})`,
          );
        }
        const recomputedAnchor = carriedBasisDigestOf(segment.economics.basisAuditRowId);
        if (recomputedAnchor !== segment.economics.basisDigest) {
          throw new Error(
            `the carried basis anchor of row ${row.rowId} shift ${scheduled.shift} ${segment.stage} drifted (declared ${segment.economics.basisDigest}, recomputed ${recomputedAnchor})`,
          );
        }
      }
    }
    for (const reference of row.recordedInputReferences) {
      const scheduled = row.schedule.shifts.find((shift) => shift.shift === reference.shift);
      if (scheduled === undefined) {
        throw new Error(
          `row ${row.rowId} references the recorded inputs of shift ${reference.shift} which the resolved schedule does not hold`,
        );
      }
      const inputsMatch =
        reference.journeyRowId === scheduled.journeyRowId &&
        reference.recordedInputDigests.length ===
          scheduled.segments.flatMap((segment) => [...segment.recordedInputDigests]).length;
      if (!inputsMatch) {
        throw new Error(
          `the recorded-input references of row ${row.rowId} shift ${reference.shift} drifted from the resolved schedule`,
        );
      }
    }
  }
}

verifyRecordedReplayPins();

// ---------------------------------------------------------------------------
// The window-record rebuild (the transforms' shared honest assembly)
// ---------------------------------------------------------------------------

/** The window-record parts a transform assembles (the rebuild's inputs). */
interface WindowRecordParts {
  readonly shifts: readonly ObservedShiftRecord[];
  readonly incidents: readonly IncidentRecord[];
  readonly continuations: readonly ContinuationRecord[];
  /** The reported window total override (the residual-hiding shape); the honest Σ otherwise. */
  readonly totalCostOverride?: string | undefined;
}

/**
 * The window-wide budget/policy ledger over the assembled shifts (PURE
 * — the honest writer: per shift ONE reservation at the shift's
 * reported cost, ONE authorized spend citing it and ONE settlement;
 * every line chains over the previous). The corrupted lanes ride the
 * same writer over their own (corrupted) shift totals — the envelope
 * oracle never trusts the writer's outputs, it re-derives them.
 */
function ledgerLinesFor(
  row: PilotCorpusRow,
  shifts: readonly ObservedShiftRecord[],
): readonly LedgerLine[] {
  const writer = createWindowLedger(row.operatingProfile);
  for (const shift of shifts) {
    const reservationId = `pilot-resv-${row.rowId}-shift${shift.shift}`;
    const admitted = writer.reserve({
      shift: shift.shift,
      reservationId,
      amountMicroUsd: shift.reportedCostMicroUsd,
    });
    if (!admitted) {
      throw new Error(
        `the declared window budget of row ${row.rowId} refuses shift ${shift.shift} (${shift.reportedCostMicroUsd}microUsd — the assembled lane exceeded the declared envelope)`,
      );
    }
    writer.spend({ reservationId, amountMicroUsd: shift.reportedCostMicroUsd });
    writer.settle({ reservationId, settledMicroUsd: shift.reportedCostMicroUsd });
  }
  return writer.lines();
}

/**
 * Rebuild one window record over the assembled parts (PURE — the same
 * honest assembly the corpus's own derivation lane performs: the
 * claimed drift classifications set to exactly the DERIVED ones over
 * the assembled shifts, the ledger over the assembled shift totals,
 * the reported totals the Σ of the assembled shifts — or the declared
 * override — and the window digest recomputed over the observed shift
 * identities).
 */
function rebuildWindowRecord(
  row: PilotCorpusRow,
  parts: WindowRecordParts,
): PilotWindowObservation {
  const skeleton: PilotWindowObservation = {
    rowId: row.rowId,
    basis: "derived-from-recorded-basis",
    shifts: parts.shifts,
    incidents: parts.incidents,
    claimedDrift: [],
    continuations: parts.continuations,
    ledger: [],
    reported: {
      totalCostMicroUsd: "0",
      totalLatencyMs: parts.shifts.reduce((total, shift) => total + shift.reportedLatencyMs, 0),
    },
    windowDigest: "",
    usage: null,
  };
  const drifts = deriveWindowDrift({
    window: row.window,
    schedule: row.schedule,
    observation: skeleton,
  });
  const totalCostMicroUsd =
    parts.totalCostOverride ??
    parts.shifts
      .reduce((total, shift) => total + BigInt(shift.reportedCostMicroUsd), 0n)
      .toString();
  return {
    ...skeleton,
    claimedDrift: drifts.map((drift) => ({
      shift: drift.shift,
      stage: drift.stage,
      claimed: drift.classification,
      mechanism: drift.mechanism,
    })),
    ledger: ledgerLinesFor(row, parts.shifts),
    reported: {
      totalCostMicroUsd,
      totalLatencyMs: skeleton.reported.totalLatencyMs,
    },
    windowDigest: windowRecordDigestOf({
      rowId: row.rowId,
      basis: "derived-from-recorded-basis",
      shifts: parts.shifts,
    }),
  };
}

// ---------------------------------------------------------------------------
// The seven probe transforms (each issued mechanism as a fixture transform)
// ---------------------------------------------------------------------------

/**
 * The cherry-picked-window / dropped-shift mechanism (PURE): the
 * window record OMITS the named shifts entirely — their costs vanish
 * from the accounting, their claims, incidents and continuations
 * vanish with them. The window-honesty and schedule-completeness
 * oracles FAIL with the omitted/missed shifts NAMED, and the
 * end-of-window reconciliation FAILs with the unexplained residual.
 */
export function omitShiftsFromWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
  shiftsToOmit: readonly number[],
): PilotWindowObservation {
  const omitted = new Set(shiftsToOmit);
  return rebuildWindowRecord(row, {
    shifts: observation.shifts.filter((shift) => !omitted.has(shift.shift)),
    incidents: observation.incidents.filter((record) => !omitted.has(record.shift)),
    continuations: observation.continuations.filter((record) => !omitted.has(record.shift)),
  });
}

/**
 * The double-driven-resume mechanism (PURE): the declared failure
 * shift's resume is driven TWICE — three attempts land for the failed
 * stage (the recorded basis holds exactly two), the third attempt's
 * cost and latency carried honestly while the continuation ledger
 * records the two resumes. The continuation-exactly-once oracle FAILs
 * with the duplicated resume NAMED (attempts=3, resumes=2), and the
 * end-of-window reconciliation FAILs with the third attempt's cost as
 * the unexplained residual.
 */
export function doubleDriveResumeInWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
): PilotWindowObservation {
  const failureShift = row.schedule.shifts.find((shift) => shift.failureStage !== null);
  const failureStage = failureShift?.failureStage ?? null;
  if (failureShift === undefined || failureStage === null) {
    throw new Error(
      `row ${row.rowId} declares a double-driven resume over a window with no failure shift (the two-attempt continuation basis is the recorded one)`,
    );
  }
  const shifts = observation.shifts.map((shift) => {
    if (shift.shift !== failureShift.shift) {
      return shift;
    }
    const segments = shift.segments.map((segment) => {
      if (segment.stage !== failureStage) {
        return segment;
      }
      const perAttemptCost = BigInt(segment.costMicroUsd) / BigInt(segment.attempts);
      const perAttemptLatency = Math.trunc(segment.latencyMs / segment.attempts);
      return {
        ...segment,
        attempts: segment.attempts + 1,
        costMicroUsd: (BigInt(segment.costMicroUsd) + perAttemptCost).toString(),
        latencyMs: segment.latencyMs + perAttemptLatency,
      };
    });
    return {
      ...shift,
      segments,
      reportedCostMicroUsd: segments
        .reduce((total, segment) => total + BigInt(segment.costMicroUsd), 0n)
        .toString(),
      reportedLatencyMs: segments.reduce((total, segment) => total + segment.latencyMs, 0),
    };
  });
  const continuations = observation.continuations.map((record) => {
    if (record.shift !== failureShift.shift) {
      return record;
    }
    const driven = shifts
      .find((shift) => shift.shift === record.shift)
      ?.segments.find((segment) => segment.stage === record.stage);
    if (driven === undefined) {
      return record;
    }
    return {
      ...record,
      failedAttemptCostMicroUsd: (BigInt(driven.costMicroUsd) / BigInt(driven.attempts)).toString(),
      resumes: record.resumes + 1,
    };
  });
  return rebuildWindowRecord(row, {
    shifts,
    incidents: observation.incidents,
    continuations,
  });
}

/**
 * The drift-normalizing mechanism (PURE): every beyond-tolerance
 * segment's CLAIMED classification is normalized back
 * within-declared-bounds — the record still carries the real drifted
 * economics while the claim says within-bounds. The
 * drift-classification-honesty oracle FAILs with the normalized drift
 * or hidden regression NAMED (the segment AND the mechanism).
 */
export function normalizeDriftClaimsInWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
): PilotWindowObservation {
  const drifts = deriveWindowDrift({
    window: row.window,
    schedule: row.schedule,
    observation,
  });
  return {
    ...observation,
    claimedDrift: observation.claimedDrift.map((claim) => {
      const drift =
        drifts.find(
          (candidate) => candidate.shift === claim.shift && candidate.stage === claim.stage,
        ) ?? null;
      if (drift === null || !drift.beyondTolerance) {
        return claim;
      }
      return { ...claim, claimed: "within-declared-bounds", mechanism: null };
    }),
  };
}

/**
 * The incident-hiding mechanism (PURE): the incident log omits the
 * named failure shift's incident — the timeline still holds the
 * declared failure and its exactly-once resume, but the log holds no
 * attributed record and the shift's reported total hides the failed
 * attempt's cost. The incident-honesty oracle FAILs with the hidden
 * incident NAMED, and the end-of-window reconciliation FAILs with the
 * hidden cost NAMED as the shift-level residual.
 */
export function hideIncidentInWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
  shift: number,
): PilotWindowObservation {
  const failureStage =
    row.schedule.shifts.find((candidate) => candidate.shift === shift)?.failureStage ?? null;
  if (failureStage === null) {
    throw new Error(
      `row ${row.rowId} declares an incident-hiding shape over shift ${shift} with no declared failure stage`,
    );
  }
  const shifts = observation.shifts.map((candidate) => {
    if (candidate.shift !== shift) {
      return candidate;
    }
    const failureSegment = candidate.segments.find(
      (segment) => segment.stage === failureStage && segment.attempts > 1,
    );
    if (failureSegment === undefined) {
      return candidate;
    }
    const hiddenAttemptCost = BigInt(failureSegment.costMicroUsd) / BigInt(failureSegment.attempts);
    return {
      ...candidate,
      reportedCostMicroUsd: (BigInt(candidate.reportedCostMicroUsd) - hiddenAttemptCost).toString(),
    };
  });
  return rebuildWindowRecord(row, {
    shifts,
    incidents: observation.incidents.filter((record) => record.shift !== shift),
    continuations: observation.continuations,
  });
}

/**
 * The residual-hiding mechanism (PURE): the end-of-window reported
 * total hides the named shift's named stage cost — every stage record
 * and every per-shift total stays honest, only the window total lies.
 * The end-of-window reconciliation oracle FAILs with the exact
 * unexplained amount NAMED (both sides named).
 */
export function hideResidualInWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
  shift: number,
  stage: JourneyStageKind,
): PilotWindowObservation {
  const hiddenStage = observation.shifts
    .find((candidate) => candidate.shift === shift)
    ?.segments.find((segment) => segment.stage === stage);
  if (hiddenStage === undefined) {
    throw new Error(
      `row ${row.rowId} declares a residual-hiding shape with no ${stage} stage cost to hide at shift ${shift}`,
    );
  }
  return {
    ...observation,
    reported: {
      ...observation.reported,
      totalCostMicroUsd: (
        BigInt(observation.reported.totalCostMicroUsd) - BigInt(hiddenStage.costMicroUsd)
      ).toString(),
    },
  };
}

/**
 * The boundary-leak mechanism (PURE): the named shift's every stage
 * executes under the journey corpus's FOREIGN application identity
 * (imported — the leak shape, never re-declared free-text). The
 * customer-boundary-integrity oracle FAILs with the leaking shift and
 * the foreign identity NAMED.
 */
export function leakBoundaryInWindowRecord(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
  shift: number,
): PilotWindowObservation {
  return rebuildWindowRecord(row, {
    shifts: observation.shifts.map((candidate) =>
      candidate.shift !== shift
        ? candidate
        : {
            ...candidate,
            segments: candidate.segments.map((segment) => ({
              ...segment,
              applicationId: FOREIGN_APPLICATION_ID,
            })),
          },
    ),
    incidents: observation.incidents,
    continuations: observation.continuations,
  });
}

/**
 * Apply ONE issued probe mechanism onto an honest window record (PURE
 * — the forced-probe lane of the discrimination battery): the target
 * selection mirrors the corpus's own declared corruption exactly (the
 * cherry-picked window drops the row's anomalous shifts — or the
 * trailing two when none are declared; the dropped shift omits the
 * mid-window shift; the double-driven resume drives the declared
 * failure shift's stage a third time; the drift normalization
 * normalizes every beyond-tolerance claim; the incident hiding omits
 * the first failure shift's incident; the residual hiding hides shift
 * 1's onboarding cost; the boundary leak flips the second-to-last
 * shift's identity).
 */
export function applyPilotProbeVariant(
  row: PilotCorpusRow,
  observation: PilotWindowObservation,
  probe: PilotProbeKind,
): PilotWindowObservation {
  switch (probe) {
    case "cherry-picked-window": {
      const anomalous = row.driftFactors.map((entry) => entry.shift);
      const targets =
        anomalous.length > 0
          ? anomalous
          : [row.window.declaredShifts - 2, row.window.declaredShifts - 1];
      return omitShiftsFromWindowRecord(row, observation, targets);
    }
    case "dropped-shift":
      return omitShiftsFromWindowRecord(row, observation, [
        Math.floor(row.window.declaredShifts / 2),
      ]);
    case "double-driven-resume":
      return doubleDriveResumeInWindowRecord(row, observation);
    case "drift-normalizing":
      return normalizeDriftClaimsInWindowRecord(row, observation);
    case "incident-hiding": {
      const failureShift = row.schedule.shifts.find((shift) => shift.failureStage !== null);
      if (failureShift === undefined) {
        throw new Error(
          `row ${row.rowId} declares an incident-hiding probe over a window with no failure shift`,
        );
      }
      return hideIncidentInWindowRecord(row, observation, failureShift.shift);
    }
    case "residual-hiding":
      return hideResidualInWindowRecord(row, observation, 1, "onboarding");
    case "boundary-leak":
      return leakBoundaryInWindowRecord(row, observation, row.window.declaredShifts - 2);
  }
}

// ---------------------------------------------------------------------------
// The window-feed builder (the per-row deterministic window record)
// ---------------------------------------------------------------------------

/**
 * The row's deterministic window feed (PURE — the observation lane's
 * record): the corpus's own derivation-level window record, honestly
 * labeled `derived-from-recorded-basis` (the row's own declared probe
 * corruption carried 1:1); with the FORCED probe knob the issued
 * mechanism is applied onto the row's HONEST record (the leaky
 * stack's controlled fake). The ONE live row honestly holds NO offline
 * record (its window record is MEASURED at run time over the REAL
 * rail — an offline fabrication would be a fake measurement, never).
 */
export function pilotWindowFeedFor(
  row: PilotCorpusRow,
  options?: { readonly probe?: PilotProbeKind },
): PilotWindowObservation | null {
  if (row.liveGate !== undefined) {
    return null;
  }
  const probe = options?.probe ?? row.probe?.kind ?? null;
  if (probe === null || probe === row.probe?.kind) {
    return pilotWindowRecordFor(row);
  }
  const honest = pilotWindowRecordFor({ ...row, probe: undefined });
  if (honest === null) {
    return null;
  }
  return applyPilotProbeVariant(row, honest, probe);
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake — the leaky stack)
// ---------------------------------------------------------------------------

/**
 * The typed live-rail refusal the offline fake world serves a
 * live-gated row (the live-gate-closed fake: the live pilot slice
 * demands the operator-authorized REAL platform path — a fake serving
 * it would fabricate a live pilot window).
 */
export const PILOT_FAKE_LIVE_RAIL_REFUSAL = Object.freeze({
  status: 503,
  code: "CAPABILITY_UNAVAILABLE",
  message:
    "the offline fake world never serves the live rail: the live pilot slice demands the operator-authorized REAL platform path",
});

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-049/050 fake
 * worlds over THIS slice's corpus): POST /executions (the
 * create/replay semantics — and the live-rail refusal), GET
 * /executions/:id (the row settles to its honest outcome on the read
 * path) and GET /executions/:id/results (the honest result package
 * carrying the pilot window record).
 *
 * Discrimination knobs: `probe` forces an adversarial pilot mechanism
 * onto an HONEST row's window record (the controlled fake of the
 * battery); `terminal`/`verificationStatuses` override the honest
 * outcome; `fabricatePassWithFail` settles a FAILED-expected row into
 * a COMPLETED terminal WITH a FAIL verification status.
 */
export function createPilotFakeApiWorld(options: {
  readonly clock: TickClock;
  /**
   * Force an adversarial pilot probe onto the row's window record (the
   * discrimination knob — the controlled fake of the battery).
   */
  readonly probe?: PilotProbeKind;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** Override the honest verification statuses (the discrimination knob). */
  readonly verificationStatuses?: readonly string[];
  /** The adversarial knob: COMPLETED terminal WITH a FAIL status. */
  readonly fabricatePassWithFail?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  /** The row of one submitted task body (the corpus slice of record). */
  const rowOf = (rowId: string): PilotCorpusRow | null =>
    PILOT_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The row's honest outcome shape (derived from the corpus itself). */
  const honestOutcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const row = rowOf(rowId);
    if (row === null) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
      return { terminal: "COMPLETED", statuses: ["FAIL", "PASS"] };
    }
    return {
      terminal: options.terminal ?? honest.terminal,
      statuses:
        options.verificationStatuses === undefined
          ? honest.statuses
          : [...options.verificationStatuses],
    };
  };

  const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    await clock.tick();

    if (url.endsWith("/executions") && method === "POST") {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "";
      if (key.length === 0) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "POST routes require an Idempotency-Key header",
          retryable: false,
        });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "null")) as Record<
        string,
        unknown
      >;
      const rowId = String((body.task as { rowId?: unknown } | null)?.rowId ?? "");
      const row = rowOf(rowId);
      if (row === null) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: `no pilot corpus row ${rowId}`,
          retryable: false,
        });
      }
      // THE LIVE RAIL HONESTY: the offline fake world never serves a
      // live-gated row — the live pilot slice demands the
      // operator-authorized REAL rail (a fake serving it would
      // fabricate a live pilot window; even a spoofed credential meets
      // the typed refusal, never a fabricated live slice).
      if (row.liveGate !== undefined) {
        return jsonResponse(PILOT_FAKE_LIVE_RAIL_REFUSAL.status, {
          code: PILOT_FAKE_LIVE_RAIL_REFUSAL.code,
          message: PILOT_FAKE_LIVE_RAIL_REFUSAL.message,
          retryable: false,
        });
      }
      const fingerprint = fingerprintOf(body);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row2 = rows.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: row2?.status ?? "CREATED",
          createdAt: new Date(row2?.createdAt ?? 0).toISOString(),
          replayed: true,
          lastEventSequence: 1,
        });
      }
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          retryable: false,
        });
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        taskRowId: rowId,
        status: "CREATED",
        createdAt: clock.now().getTime(),
      });
      records.set(key, { fingerprint, executionId: id });
      return jsonResponse(201, {
        executionId: id,
        applicationId: body.applicationId ?? "app-1",
        status: "CREATED",
        createdAt: new Date(clock.now().getTime()).toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const row = rows.get(execMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: PILOT_TASK_KIND, input: "pilot" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null && method === "GET") {
      const row = rows.get(resultMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const corpusRow = rowOf(row.taskRowId);
      // The pilot window package: the honest window record over the
      // corpus row, denatured only by the effective probe (the row's
      // own declared probe, or the forced discrimination knob).
      const observation =
        corpusRow === null
          ? null
          : pilotWindowFeedFor(
              corpusRow,
              options.probe === undefined ? {} : { probe: options.probe },
            );
      const outcome = outcomeFor(row.taskRowId);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "pilot-ledger",
          model: "recorded-window-replay",
          strategyClass: "production-pilot",
          modelCalls: 1,
        },
        cost: pass
          ? { totalMicroUsd: observation?.reported.totalCostMicroUsd ?? "0", currency: "usd" }
          : null,
        usage: null,
        outputArtifacts: [],
        verification: outcome.statuses.map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        warnings: [],
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
        pilot: observation,
      });
    }

    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };

  return {
    transport,
    get createdExecutions() {
      return createdExecutions;
    },
    rows,
    records,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
