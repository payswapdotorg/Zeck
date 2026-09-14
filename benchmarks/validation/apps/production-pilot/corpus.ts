/**
 * The production-pilot corpus (VAL-051, mission 1): the declared rows of
 * the PRODUCTION-STYLE PILOT — a DECLARED SCHEDULE OF SHIFTS replaying
 * the recorded VAL-050 journey stages (their audited VAL-049 economics
 * carried as the pilot's cost basis, digest-referenced through the
 * RECORDED corpora's OWN resolvers — a drifted corpus THROWS at module
 * load, before any window can be observed), observed under
 * production-style operating discipline:
 *
 *   * the declared pilot window (the fixity anchor — its shift
 *     cardinality, span, drift tolerance and declared divergences,
 *     digest-pinned through `pilotWindowDigestOf`);
 *   * the declared schedule of shifts (digest-pinned through
 *     `scheduleDigestOf` — every shift's RECORDED workload reference
 *     resolved through `journeyRowById`, every stage economics anchor
 *     re-resolved through the audit corpus's own resolver);
 *   * the operating profile (the window-wide budget/policy envelope —
 *     reservations settle at end-of-window, every spend cites its
 *     authorizing reservation, the append-only ledger's digest chain
 *     holds);
 *   * the expected verdict (PILOT-COMPLETED / PILOT-FAILED with the
 *     FAILing criteria NAMED / NOT-RUN with the env var named) — for
 *     the offline rows pinned by RUNNING the same engine at module
 *     load (the expected outcome IS the mechanically derived one),
 *     with the seven issued adversarial probes declaring their
 *     expected FAILED criteria via `PROBE_FAILED_CRITERIA_OF` and the
 *     derived surface asserted against the pin;
 *   * the recorded-input digest references (per shift: the journey row
 *     id it replays, the recorded input digests its segments compose
 *     and the carried VAL-049 audit anchors — DIGESTS ONLY, never
 *     payload bytes, never a copy of a recorded result).
 *
 * The offline observation lane is PURE derivation over the RECORDED
 * corpora (the re-measurement ban): `pilotWindowRecordFor(row)` derives
 * the row's window record from the declared schedule — the declared
 * drift factors applied over the recorded basis in BigInt micro-USD
 * arithmetic, the declared incidents recorded AND attributed through
 * the IMPORTED VAL-020 taxonomy, the reservations settling through the
 * driver's own append-only ledger writer — honestly labeled
 * `derived-from-recorded-basis`, never claimed as a measurement. The
 * seven probe rows' records carry their ISSUED corruption 1:1 (the
 * cherry-picked window, the dropped shift, the double-driven resume,
 * the drift normalization, the incident hiding, the residual hiding,
 * the boundary leak). The ONE live row is env-gated on
 * `OPENROUTER_API_KEY` and honestly holds NO offline record (never a
 * fabricated measurement).
 */

import type { AttributionClass } from "../../platform/failure-attribution";
import { type JourneyStageKind, journeyRowById } from "../customer-journey/corpus";
import { FOREIGN_APPLICATION_ID } from "../customer-journey/driver";
import { auditRowById } from "../economic-audit/corpus";
import { replayRecordedEvidenceOf } from "../economic-audit/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  type ClaimedDriftClassification,
  type ContinuationRecord,
  carriedBasisDigestOf,
  createWindowLedger,
  type DriftClassification,
  deriveShiftObservation,
  deriveShiftSchedule,
  deriveWindowDrift,
  dispositionIsValidFor,
  drivePilotRow,
  type IncidentDispositionKind,
  type IncidentRecord,
  isKnownAttributionClass,
  type LedgerLine,
  LIVE_PILOT_WORKLOAD_CLASS,
  type ObservedShiftRecord,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_OBSERVATION_FAMILIES,
  type PilotBudgetPolicy,
  type PilotDeclaredDivergence,
  type PilotObservationFamily,
  type PilotRowResult,
  type PilotVerdictKind,
  type PilotWindow,
  type PilotWindowObservation,
  type SegmentDrift,
  type SegmentDriftFactor,
  type ShiftDeclaration,
  type ShiftSchedule,
  shiftCostBasisOf,
  shiftLatencyBasisOf,
  windowRecordDigestOf,
} from "./driver";

/** The task kind every pilot submission carries (the app's task vocabulary). */
export const PILOT_TASK_KIND = "production-pilot.window.v1";

/** The corpus version (the pinned vocabulary of record). */
export const PILOT_CORPUS_VERSION = "val-051-production-pilot-v1";

/**
 * The pilot's customer identity — re-exported from the driver (the
 * customer-boundary criterion's pinned basis; the boundary-leak probe
 * executes under the journey corpus's `FOREIGN_APPLICATION_ID`, never a
 * re-declared free-text identity).
 */
export { PILOT_CUSTOMER_APPLICATION_ID } from "./driver";

// ---------------------------------------------------------------------------
// The workload-class vocabulary (each row's declared workload family)
// ---------------------------------------------------------------------------

/**
 * The workload classes (the row's declared workload family — the shape
 * of the recorded basis the row's shifts replay plus the row's own
 * operating focus; the live class is the driver's own
 * `LIVE_PILOT_WORKLOAD_CLASS`).
 */
export type PilotWorkloadClass =
  | "recorded-portfolio-replay-window"
  | "journey-continuation-replay-window"
  | "declared-drift-window"
  | "incident-injection-window"
  | "tight-budget-envelope-window"
  | "live-pilot-sustained-window";

/** The declared workload-class vocabulary (each class used by ≥1 row). */
export const PILOT_WORKLOAD_CLASSES: readonly PilotWorkloadClass[] = Object.freeze([
  "recorded-portfolio-replay-window",
  "journey-continuation-replay-window",
  "declared-drift-window",
  "incident-injection-window",
  "tight-budget-envelope-window",
  "live-pilot-sustained-window",
]);

// ---------------------------------------------------------------------------
// The adversarial probe vocabulary (the seven issued probes, 1:1)
// ---------------------------------------------------------------------------

/** The adversarial pilot-probe vocabulary (the issued AC6 list, 1:1). */
export type PilotProbeKind =
  | "cherry-picked-window"
  | "dropped-shift"
  | "double-driven-resume"
  | "drift-normalizing"
  | "incident-hiding"
  | "residual-hiding"
  | "boundary-leak";

/** The NAMED mechanism per probe (the exact catch the oracle must cite). */
export const PROBE_MECHANISM_OF: Readonly<Record<PilotProbeKind, string>> = Object.freeze({
  "cherry-picked-window":
    "window-honesty:cherry-picked-sub-window + omitted-shift:4..5 (the anomalous shifts 4-5 dropped from the window record to fake a clean window)",
  "dropped-shift":
    "schedule-completeness:missed-shift:3 (the scheduled shift 3 entirely absent from the window record)",
  "double-driven-resume":
    "continuation-exactly-once:double-driven-resume (the failed stage's resume driven twice — three attempts, never exactly once)",
  "drift-normalizing":
    "drift-classification-honesty:hidden-regression (the regressing segment's drift normalized back within bounds before classification — claimed within-declared-bounds over a beyond-tolerance segment)",
  "incident-hiding":
    "incident-honesty:hidden-incident (the shift-2 incident omitted from the log — its recorded cost left unexplained)",
  "residual-hiding":
    "end-of-window-reconciliation:window-total-residual (the reported window total hides part of a shift's stage cost — the exact unexplained amount named)",
  "boundary-leak":
    "customer-boundary-integrity:foreign-application (one shift's stages executed under another customer's application identity)",
});

/**
 * The named criteria each probe row must FAIL (the expected failure
 * surface, pinned so the corpus, the driver and the tests share ONE
 * vocabulary). The list holds the FULL mechanically derived surface —
 * the issued probe's PRIMARY family first, then the co-FAILing
 * families the driver's own oracles derive: the sibling completeness
 * oracles co-fire on any dropped shift (a cherry-picked window misses
 * its shifts in BOTH the window-honesty and the schedule-completeness
 * sense), and the end-of-window reconciliation co-fails wherever a
 * probe corrupts the accounting. The corpus ASSERTS at module load
 * that driving the probe's declared window record through the engine
 * derives exactly this list — the pin is never wishful.
 */
export const PROBE_FAILED_CRITERIA_OF: Readonly<Record<PilotProbeKind, readonly string[]>> =
  Object.freeze({
    "cherry-picked-window": [
      "window-honesty",
      "schedule-completeness",
      "end-of-window-reconciliation",
    ],
    "dropped-shift": ["window-honesty", "schedule-completeness", "end-of-window-reconciliation"],
    "double-driven-resume": ["continuation-exactly-once", "end-of-window-reconciliation"],
    "drift-normalizing": ["drift-classification-honesty", "end-of-window-reconciliation"],
    "incident-hiding": ["incident-honesty", "end-of-window-reconciliation"],
    "residual-hiding": ["end-of-window-reconciliation"],
    "boundary-leak": ["customer-boundary-integrity"],
  });

// ---------------------------------------------------------------------------
// The row shape (the declared pilot window + schedule + profile + expectation)
// ---------------------------------------------------------------------------

/** One declared per-shift drift factor (the observation lane's declared derivation input). */
export interface PilotDeclaredDriftFactor {
  readonly shift: number;
  readonly factors: readonly SegmentDriftFactor[];
}

/** One declared incident (recorded AND attributed through the imported VAL-020 taxonomy). */
export interface PilotDeclaredIncident {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  /** The root-cause class (the IMPORTED VAL-020 taxonomy — never free-text). */
  readonly attributionClass: AttributionClass;
  /** The cost at stake (microUsd — carried honestly, never hidden). */
  readonly magnitudeMicroUsd: string;
  /** The disposition kind (valid for the class's retryability discipline). */
  readonly dispositionKind: IncidentDispositionKind;
}

/** One shift's recorded-input digest references (digest references only — never payload bytes). */
export interface PilotRecordedInputReference {
  readonly shift: number;
  /** The RECORDED workload reference (the VAL-050 journey row this shift replays). */
  readonly journeyRowId: string;
  /** The recorded input digests the shift's segments compose. */
  readonly recordedInputDigests: readonly string[];
  /** The carried VAL-049 audit anchors (the cost-basis anchor ids, deduplicated per shift). */
  readonly basisAuditRowIds: readonly string[];
}

/** One pinned drift finding (an honest row's beyond-tolerance finding, named). */
export interface PilotDriftFindingPin {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  readonly classification: DriftClassification;
  /** The NAMED mechanism (the declared divergence cause when drifting). */
  readonly mechanism: string | null;
}

/** One declared pilot corpus row. */
export interface PilotCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The workload class (the row's declared workload family). */
  readonly workloadClass: PilotWorkloadClass;
  /** The declared pilot window (the fixity anchor, digest-pinned). */
  readonly window: PilotWindow;
  /** The declared shift declarations (the schedule's input). */
  readonly shiftDeclarations: readonly ShiftDeclaration[];
  /** The resolved schedule (digest-pinned via `scheduleDigestOf` at module load). */
  readonly schedule: ShiftSchedule;
  /** The operating profile (the window-wide budget/policy envelope). */
  readonly operatingProfile: PilotBudgetPolicy;
  /** The declared replay drift factors (PURE derivation inputs over the recorded basis). */
  readonly driftFactors: readonly PilotDeclaredDriftFactor[];
  /** The declared incidents (recorded AND attributed in the window's incident log). */
  readonly declaredIncidents: readonly PilotDeclaredIncident[];
  /** The observation families the row's verification drives (the oracle slice). */
  readonly observationFamilies: readonly PilotObservationFamily[];
  /** The recorded-input digest references (per shift — digests only). */
  readonly recordedInputReferences: readonly PilotRecordedInputReference[];
  readonly expected: {
    readonly verdict: PilotVerdictKind;
    /** The criteria a PILOT-FAILED verdict must NAME (empty otherwise). */
    readonly failedCriteria: readonly string[];
    /** The app-level terminal (COMPLETED for honest rows and the honest NOT-RUN live row). */
    readonly terminal: "COMPLETED" | "FAILED";
    /** The pinned drift findings (the honest rows' beyond-tolerance findings; never pinned live). */
    readonly driftFindings: readonly PilotDriftFindingPin[];
  };
  readonly probe?: { readonly kind: PilotProbeKind };
  readonly liveGate?: { readonly envVars: readonly ["OPENROUTER_API_KEY"] };
  readonly needsDispatch: boolean;
}

// ---------------------------------------------------------------------------
// The derivation-level window record (the offline observation lane — PURE)
// ---------------------------------------------------------------------------

/**
 * The per-shift declared drift factors (PURE — the declared replay
 * derivation's inputs; the factors apply over the RECORDED basis in
 * BigInt micro-USD arithmetic, never a re-measurement).
 */
function driftFactorsForShift(row: PilotCorpusRow, shift: number): readonly SegmentDriftFactor[] {
  return row.driftFactors.find((entry) => entry.shift === shift)?.factors ?? [];
}

/**
 * One declared incident's record (PURE — the disposition's content
 * digest derives over the declared content; the root-cause class comes
 * from the IMPORTED VAL-020 taxonomy, never free-text).
 */
function declaredIncidentRecordOf(rowId: string, declared: PilotDeclaredIncident): IncidentRecord {
  return {
    shift: declared.shift,
    stage: declared.stage,
    attributionClass: declared.attributionClass,
    magnitudeMicroUsd: declared.magnitudeMicroUsd,
    disposition: {
      kind: declared.dispositionKind,
      detailDigest: economicDigestOf({
        rowId,
        shift: declared.shift,
        stage: declared.stage,
        attributionClass: declared.attributionClass,
        disposition: declared.dispositionKind,
        magnitudeMicroUsd: declared.magnitudeMicroUsd,
      }),
    },
  };
}

/**
 * The window-wide budget/policy ledger over the observed shifts (PURE —
 * the honest machinery: per shift ONE reservation at the shift's
 * derived cost (the declared envelope — the recorded basis plus the
 * declared divergence factors), ONE authorized spend citing it and ONE
 * settlement at the derived cost; every reservation settles by
 * end-of-window, nothing dangles, every line chains over the
 * previous). The dishonest probe lanes ride the same writer over their
 * own (corrupted) shift totals — the envelope oracle never trusts the
 * writer's outputs, it re-derives them.
 */
function ledgerLinesOf(input: {
  readonly rowId: string;
  readonly policy: PilotBudgetPolicy;
  readonly shifts: readonly ObservedShiftRecord[];
}): readonly LedgerLine[] {
  const writer = createWindowLedger(input.policy);
  for (const shift of input.shifts) {
    const reservationId = `pilot-resv-${input.rowId}-shift${shift.shift}`;
    const admitted = writer.reserve({
      shift: shift.shift,
      reservationId,
      amountMicroUsd: shift.reportedCostMicroUsd,
    });
    if (!admitted) {
      throw new Error(
        `the declared window budget of row ${input.rowId} refuses shift ${shift.shift} (${shift.reportedCostMicroUsd}microUsd — a declared schedule the envelope cannot admit is a corpus bug, never a runtime surprise)`,
      );
    }
    writer.spend({ reservationId, amountMicroUsd: shift.reportedCostMicroUsd });
    writer.settle({ reservationId, settledMicroUsd: shift.reportedCostMicroUsd });
  }
  return writer.lines();
}

/**
 * The row's derivation-level window record (PURE — the offline
 * observation lane over the row's DECLARED fields: the replay
 * derivation over the recorded basis shift-by-shift, the declared
 * incidents recorded and attributed, the claims set to the DERIVED
 * classifications, the reservations settling through the append-only
 * ledger and the reported totals the Σ of the observed shifts —
 * honestly labeled `derived-from-recorded-basis`, never claimed as a
 * measurement). A probe row's record carries its ISSUED corruption
 * 1:1; the ONE live row honestly holds NO offline record (the live
 * slice's window record is MEASURED at run time over the REAL rail —
 * an offline fabrication would be a fake measurement, never).
 */
export function pilotWindowRecordFor(row: PilotCorpusRow): PilotWindowObservation | null {
  if (row.liveGate !== undefined) {
    return null;
  }
  const probeKind = row.probe?.kind ?? null;

  // (1) the honest replay derivation over the RECORDED basis.
  let shifts: readonly ObservedShiftRecord[] = [];
  const honestContinuations: ContinuationRecord[] = [];
  for (const scheduled of row.schedule.shifts) {
    const derived = deriveShiftObservation({
      rowId: row.rowId,
      scheduled,
      driftFactors: driftFactorsForShift(row, scheduled.shift),
    });
    shifts = [...shifts, derived.shift];
    if (derived.continuation !== null) {
      honestContinuations.push(derived.continuation);
    }
  }
  let continuations: readonly ContinuationRecord[] = [...honestContinuations];
  let incidents: readonly IncidentRecord[] = row.declaredIncidents.map((declared) =>
    declaredIncidentRecordOf(row.rowId, declared),
  );

  // (2) the declared adversarial corruption (the seven issued probes, 1:1).
  if (probeKind === "cherry-picked-window") {
    // The observation lane DROPS the anomalous shifts (the row's own
    // declared drift-factor shifts) from the window record — a clean
    // four-shift sub-window reported over a declared six-shift window.
    const anomalous = row.driftFactors.map((entry) => entry.shift);
    shifts = shifts.filter((shift) => !anomalous.includes(shift.shift));
    continuations = continuations.filter((record) => !anomalous.includes(record.shift));
    incidents = incidents.filter((record) => !anomalous.includes(record.shift));
  }
  if (probeKind === "dropped-shift") {
    // The window record omits the mid-window scheduled shift entirely —
    // its cost vanishes from the accounting.
    const dropped = Math.floor(row.window.declaredShifts / 2);
    shifts = shifts.filter((shift) => shift.shift !== dropped);
    continuations = continuations.filter((record) => record.shift !== dropped);
    incidents = incidents.filter((record) => record.shift !== dropped);
  }
  if (probeKind === "double-driven-resume") {
    // The declared failure shift's resume is driven TWICE — three
    // attempts for the failed stage (the recorded basis holds exactly
    // two), the third attempt's cost and latency carried honestly in
    // the record while the continuation ledger records the two resumes.
    const failureShift = row.schedule.shifts.find((shift) => shift.failureStage !== null);
    if (failureShift === undefined) {
      throw new Error(
        `probe row ${row.rowId} declares a double-driven resume over a window with no failure shift`,
      );
    }
    const failureStage = failureShift.failureStage;
    if (failureStage === null) {
      throw new Error(`probe row ${row.rowId} declares a failure shift with no failure stage`);
    }
    shifts = shifts.map((shift) => {
      if (shift.shift !== failureShift.shift) {
        return shift;
      }
      const segments = shift.segments.map((segment) => {
        if (segment.stage !== failureStage) {
          return segment;
        }
        const perAttempt = BigInt(segment.costMicroUsd) / BigInt(segment.attempts);
        const perAttemptLatency = Math.trunc(segment.latencyMs / segment.attempts);
        return {
          ...segment,
          attempts: segment.attempts + 1,
          costMicroUsd: (BigInt(segment.costMicroUsd) + perAttempt).toString(),
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
    continuations = continuations.map((record) => {
      if (record.shift !== failureShift.shift) {
        return record;
      }
      const driven = shifts.find((shift) => shift.shift === record.shift);
      const drivenSegment = driven?.segments.find((segment) => segment.stage === record.stage);
      if (drivenSegment === undefined) {
        return record;
      }
      return {
        ...record,
        failedAttemptCostMicroUsd: (
          BigInt(drivenSegment.costMicroUsd) / BigInt(drivenSegment.attempts)
        ).toString(),
        resumes: record.resumes + 1,
      };
    });
  }
  if (probeKind === "incident-hiding") {
    // The incident log omits the failure shift's incident — the
    // timeline still holds the declared failure and its exactly-once
    // resume, and the shift's reported total hides the failed
    // attempt's cost (the incident's recorded cost now unexplained).
    const failureShift = row.schedule.shifts.find((shift) => shift.failureStage !== null);
    if (failureShift === undefined) {
      throw new Error(
        `probe row ${row.rowId} declares an incident-hiding shape over a window with no failure shift`,
      );
    }
    const failureStage = failureShift.failureStage;
    incidents = incidents.filter((record) => record.shift !== failureShift.shift);
    shifts = shifts.map((shift) => {
      if (shift.shift !== failureShift.shift) {
        return shift;
      }
      const failureSegment = shift.segments.find(
        (segment) => segment.stage === failureStage && segment.attempts > 1,
      );
      if (failureSegment === undefined) {
        return shift;
      }
      const hiddenAttemptCost =
        BigInt(failureSegment.costMicroUsd) / BigInt(failureSegment.attempts);
      return {
        ...shift,
        reportedCostMicroUsd: (BigInt(shift.reportedCostMicroUsd) - hiddenAttemptCost).toString(),
      };
    });
  }
  if (probeKind === "boundary-leak") {
    // One shift's every stage executes under the journey corpus's
    // FOREIGN application identity (imported — the leak shape).
    const leakShift = row.window.declaredShifts - 2;
    shifts = shifts.map((shift) => {
      if (shift.shift !== leakShift) {
        return shift;
      }
      return {
        ...shift,
        segments: shift.segments.map((segment) => ({
          ...segment,
          applicationId: FOREIGN_APPLICATION_ID,
        })),
      };
    });
  }

  // (3) the claimed drift classifications — the honest lane claims
  // exactly the DERIVED ones (claimed == derived, mechanically); the
  // drift-normalizing probe lane rewrites the beyond-tolerance
  // segment's claim back within bounds (the issued normalization).
  const drifts: readonly SegmentDrift[] = deriveWindowDrift({
    window: row.window,
    schedule: row.schedule,
    observation: {
      rowId: row.rowId,
      basis: "derived-from-recorded-basis",
      shifts,
      incidents,
      claimedDrift: [],
      continuations,
      ledger: [],
      reported: { totalCostMicroUsd: "0", totalLatencyMs: 0 },
      windowDigest: "",
      usage: null,
    },
  });
  let claimedDrift: readonly ClaimedDriftClassification[] = drifts.map((drift) => ({
    shift: drift.shift,
    stage: drift.stage,
    claimed: drift.classification,
    mechanism: drift.mechanism,
  }));
  if (probeKind === "drift-normalizing") {
    claimedDrift = claimedDrift.map((claim) => {
      const declared = row.driftFactors.find((entry) => entry.shift === claim.shift);
      const normalized =
        declared?.factors.some(
          (factor) =>
            factor.stage === claim.stage &&
            (factor.costDriftPct !== 0 || factor.latencyDriftPct !== 0),
        ) ?? false;
      return normalized
        ? { ...claim, claimed: "within-declared-bounds" as const, mechanism: null }
        : claim;
    });
  }

  // (4) the reported totals — the Σ of the observed shifts; the
  // residual-hiding probe lane hides part of a shift's stage cost
  // from the reported window total (the issued hidden residual).
  let totalCost = shifts.reduce((total, shift) => total + BigInt(shift.reportedCostMicroUsd), 0n);
  const totalLatency = shifts.reduce((total, shift) => total + shift.reportedLatencyMs, 0);
  if (probeKind === "residual-hiding") {
    const hidingShift = shifts.find((shift) => shift.shift === 1);
    const hiddenStage = hidingShift?.segments.find((segment) => segment.stage === "onboarding");
    if (hiddenStage === undefined) {
      throw new Error(
        `probe row ${row.rowId} declares a residual-hiding shape with no stage cost to hide`,
      );
    }
    totalCost -= BigInt(hiddenStage.costMicroUsd);
  }

  // (5) the assembly (the ledger rides the (corrupted) shift totals;
  // the window digest pins the observed shift identities).
  const ledger = ledgerLinesOf({ rowId: row.rowId, policy: row.operatingProfile, shifts });
  return {
    rowId: row.rowId,
    basis: "derived-from-recorded-basis",
    shifts,
    incidents,
    claimedDrift,
    continuations,
    ledger,
    reported: { totalCostMicroUsd: totalCost.toString(), totalLatencyMs: totalLatency },
    windowDigest: windowRecordDigestOf({
      rowId: row.rowId,
      basis: "derived-from-recorded-basis",
      shifts,
    }),
    usage: null,
  };
}

// ---------------------------------------------------------------------------
// The row builder (the schedule resolution + the module-load verdict pin)
// ---------------------------------------------------------------------------

/**
 * The standard operating profile (PURE — the window-wide envelope at
 * 2× the recorded cost basis and 2× the maximum recorded per-shift
 * latency, admitting every scheduled shift; the tight row and the live
 * row declare their own).
 */
function standardOperatingProfileOf(schedule: ShiftSchedule): PilotBudgetPolicy {
  const totalBasis = schedule.shifts.reduce(
    (total, shift) => total + BigInt(shiftCostBasisOf(shift)),
    0n,
  );
  const maxLatency = schedule.shifts.reduce(
    (max, shift) => Math.max(max, shiftLatencyBasisOf(shift)),
    0,
  );
  return {
    costBudgetMicroUsd: (totalBasis * 2n).toString(),
    latencyBudgetMsPerShift: maxLatency * 2,
    admissionPolicy: "admit-all-scheduled",
  };
}

/** The per-shift recorded-input digest references (PURE over the resolved schedule). */
function recordedInputReferencesOf(
  schedule: ShiftSchedule,
): readonly PilotRecordedInputReference[] {
  return schedule.shifts.map((shift) => ({
    shift: shift.shift,
    journeyRowId: shift.journeyRowId,
    recordedInputDigests: shift.segments.flatMap((segment) => [...segment.recordedInputDigests]),
    basisAuditRowIds: [
      ...new Set(shift.segments.map((segment) => segment.economics.basisAuditRowId)),
    ],
  }));
}

/** The honest row's pinned drift findings (the beyond-tolerance findings, NAMED). */
function driftFindingsOf(input: {
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): readonly PilotDriftFindingPin[] {
  return deriveWindowDrift({
    window: input.window,
    schedule: input.schedule,
    observation: input.observation,
  })
    .filter((drift) => drift.beyondTolerance)
    .map((drift) => ({
      shift: drift.shift,
      stage: drift.stage,
      classification: drift.classification,
      mechanism: drift.mechanism,
    }));
}

/**
 * Build one pilot row: the declared window over the declared shifts
 * (the schedule resolved and digest-pinned at module load through the
 * RECORDED corpora's OWN resolvers — a stale journey reference or a
 * drifted audit anchor THROWS here), the operating profile, and the
 * expected verdict pinned by RUNNING the engine over the row's own
 * derivation-level window record (the honest rows must COMPLETE with
 * their drift findings named; the probe rows must FAIL exactly their
 * pinned criteria; the live row must hold the honest NOT-RUN boundary
 * with the env var named — a corpus that pins anything the engine
 * does not derive THROWS at module load).
 */
function pilotRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly workloadClass: PilotWorkloadClass;
  readonly shifts: readonly ShiftDeclaration[];
  readonly tolerancePct: number;
  readonly divergences?: readonly PilotDeclaredDivergence[];
  readonly operatingProfile?: PilotBudgetPolicy;
  readonly driftFactors?: readonly PilotDeclaredDriftFactor[];
  readonly incidents?: readonly PilotDeclaredIncident[];
  readonly observationFamilies?: readonly PilotObservationFamily[];
  readonly probe?: { readonly kind: PilotProbeKind };
  readonly live?: boolean;
}): PilotCorpusRow {
  if (input.live === true && input.probe !== undefined) {
    throw new Error("a live row never carries an adversarial probe");
  }
  // the schedule — resolved through the recorded corpora's OWN resolvers.
  for (const declaration of input.shifts) {
    if (journeyRowById(declaration.journeyRowId) === null) {
      throw new Error(
        `row ${input.rowId} shifts over journey row ${declaration.journeyRowId} which the VAL-050 journey corpus does not hold (a stale pilot corpus cannot silently exist)`,
      );
    }
  }
  const schedule = deriveShiftSchedule({ shifts: input.shifts });
  const window: PilotWindow = {
    declaredShifts: input.shifts.length,
    declaredSpan: { firstShift: 0, lastShift: input.shifts.length - 1 },
    driftTolerancePct: input.tolerancePct,
    declaredDivergences: [...(input.divergences ?? [])],
  };
  const operatingProfile = input.operatingProfile ?? standardOperatingProfileOf(schedule);
  const row: PilotCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    workloadClass: input.workloadClass,
    window,
    shiftDeclarations: [...input.shifts],
    schedule,
    operatingProfile,
    driftFactors: [...(input.driftFactors ?? [])],
    declaredIncidents: [...(input.incidents ?? [])],
    observationFamilies:
      input.observationFamilies === undefined
        ? [...PILOT_OBSERVATION_FAMILIES]
        : [...input.observationFamilies],
    recordedInputReferences: recordedInputReferencesOf(schedule),
    expected: { verdict: "NOT-RUN", failedCriteria: [], terminal: "COMPLETED", driftFindings: [] },
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    ...(input.live === true ? { liveGate: { envVars: ["OPENROUTER_API_KEY"] as const } } : {}),
    needsDispatch: input.live === true,
  };

  // the pinned expectation — RUNNING the engine at module load over the
  // row's own derivation-level window record.
  const observation = pilotWindowRecordFor(row);
  const result = drivePilotRow({
    rowId: row.rowId,
    window,
    schedule,
    policy: operatingProfile,
    observation,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate }),
  });
  if (input.live === true) {
    if (
      result.terminal !== "NOT-RUN" ||
      !result.notRun ||
      !(result.reason ?? "").includes("OPENROUTER_API_KEY")
    ) {
      throw new Error(
        `live row ${input.rowId} must hold the honest NOT-RUN boundary (derived ${result.terminal}, notRun=${result.notRun}, reason ${result.reason ?? "none"})`,
      );
    }
    return row;
  }
  if (input.probe !== undefined) {
    const pinned = PROBE_FAILED_CRITERIA_OF[input.probe.kind];
    const derived = result.failedCriteria;
    if (
      result.terminal !== "PILOT-FAILED" ||
      derived.length !== pinned.length ||
      derived.some((criterion, index) => criterion !== pinned[index])
    ) {
      throw new Error(
        `probe row ${input.rowId} (${input.probe.kind}) must FAIL exactly [${pinned.join(
          ", ",
        )}] (derived ${result.terminal} [${derived.join(", ")}] — the pinned surface is the mechanically derived one, never wishful)`,
      );
    }
    return {
      ...row,
      expected: {
        verdict: "PILOT-FAILED",
        failedCriteria: [...pinned],
        terminal: "FAILED",
        driftFindings: [],
      },
    };
  }
  if (result.terminal !== "PILOT-COMPLETED" || result.failedCriteria.length !== 0) {
    throw new Error(
      `honest row ${input.rowId} must COMPLETE (derived ${result.terminal}${
        result.failedCriteria.length === 0 ? "" : ` failing [${result.failedCriteria.join(", ")}]`
      })`,
    );
  }
  if (observation === null) {
    throw new Error(
      `honest row ${input.rowId} derives an offline window record (a null record is the live boundary only)`,
    );
  }
  const findings = driftFindingsOf({
    window,
    schedule,
    observation,
  });
  return {
    ...row,
    expected: {
      verdict: "PILOT-COMPLETED",
      failedCriteria: [],
      terminal: "COMPLETED",
      driftFindings: findings,
    },
  };
}

// ---------------------------------------------------------------------------
// The offline honest rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The mid-window failure declaration (the journey continuation row's own recorded shape). */
const CONTINUATION_SHIFT: ShiftDeclaration = {
  journeyRowId: "journey-continuation-resume",
  failureStage: "daily-usage",
};

/** The recorded full-journey portfolio shift (the canonical recorded workload). */
const PORTFOLIO_SHIFT: ShiftDeclaration = { journeyRowId: "full-journey-recorded-portfolio" };

/** The load-shaping divergence cause (the drifting row's NAMED mechanism). */
const LOAD_SHAPING_COHORT_MIX = "load-shaping cohort mix";

/**
 * The six-shift declared schedule (every shift replaying the recorded
 * full-journey portfolio, the continuation shift swapped in where the
 * row declares its mid-window failure).
 */
function sixShifts(continuationAt?: number): readonly ShiftDeclaration[] {
  return Array.from({ length: 6 }, (_, index) =>
    index === continuationAt ? CONTINUATION_SHIFT : PORTFOLIO_SHIFT,
  );
}

/** The offline honest rows (deterministic — always drivable, zero credentials). */
const HONEST_PILOT_ROWS: readonly PilotCorpusRow[] = [
  pilotRow({
    rowId: "pilot-window-full-recorded-portfolio",
    description:
      "The canonical full-window row: six shifts over the declared window 0..5, every shift replaying the recorded full-journey portfolio row (onboarding, intent, plan, daily usage over the recorded application portfolio, outcome — each stage's audited VAL-049 economics carried as the shift's cost basis, digest-anchored through the audit corpus's own resolver). Every segment sits within the declared tolerance against the recorded basis, every reservation settles at end-of-window, the append-only ledger's digest chain holds, and the end-of-window accounting reconciles stage-for-stage and shift-for-shift with zero unexplained residual. All eight observation families verified.",
    workloadClass: "recorded-portfolio-replay-window",
    shifts: sixShifts(),
    tolerancePct: 10,
  }),
  pilotRow({
    rowId: "pilot-shift-resume-exactly-once",
    description:
      "The continuation row: six shifts, shift 3 declaring the mid-shift failure at the daily-usage stage — the journey continuation row's OWN two-attempt recorded economics (the failed attempt's cost carried honestly, never hidden). The failed shift resumes EXACTLY ONCE: the continuation ledger records one resume with the failed attempt's per-attempt cost, the incident log records AND attributes the failure (a retryable provider-class incident under its bounded-retry disposition, the 9600microUsd cost at stake in the magnitude), and the drift classification stays within the declared bounds because the two-attempt basis IS the recorded basis.",
    workloadClass: "journey-continuation-replay-window",
    shifts: sixShifts(3),
    tolerancePct: 10,
    observationFamilies: ["continuation-exactly-once", "incident-honesty"],
    incidents: [
      {
        shift: 3,
        stage: "daily-usage",
        attributionClass: "provider-unavailable",
        magnitudeMicroUsd: "9600",
        dispositionKind: "bounded-retry",
      },
    ],
  }),
  pilotRow({
    rowId: "pilot-drift-drifting-named",
    description:
      "The drifting row: six shifts, shift 4's daily-usage segment drifting beyond the declared tolerance WITH the cause declared — the load-shaping cohort mix — as the window's one declared divergence. The observation lane derives the drift honestly over the recorded basis (BigInt micro-USD arithmetic, the declared factor applied), claims exactly the derived `drifting` classification with the mechanism NAMED, and the end-of-window reconciliation carries the drift as the declared, named delta. An honest drifting finding COMPLETES — a normalized one would FAIL (see the drift-normalizing probe row).",
    workloadClass: "declared-drift-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    divergences: [{ shift: 4, stage: "daily-usage", cause: LOAD_SHAPING_COHORT_MIX }],
    driftFactors: [
      {
        shift: 4,
        factors: [{ stage: "daily-usage", costDriftPct: 25, latencyDriftPct: 0, resolvedDrift: 0 }],
      },
    ],
    observationFamilies: ["drift-classification-honesty"],
  }),
  pilotRow({
    rowId: "pilot-drift-regressing-reported",
    description:
      "The regressing row: six shifts, shift 5's daily-usage segment regressing beyond the declared tolerance UNdeclared — the segment's resolved quality collapses (one attempt, none resolved). The derived classification is `regressing`; the observation lane claims exactly that (never a normalization, never a hidden regression), and the unresolved attempt is recorded AND attributed in the incident log (the provider's empty completion — an honest non-error accepted as risk, its 9600microUsd cost at stake in the magnitude). The honest regressing finding COMPLETES with the finding named in the criteria's own evidence; a hidden regression would FAIL (see the drift-normalizing probe row).",
    workloadClass: "declared-drift-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    driftFactors: [
      {
        shift: 5,
        factors: [{ stage: "daily-usage", costDriftPct: 0, latencyDriftPct: 0, resolvedDrift: 1 }],
      },
    ],
    observationFamilies: ["drift-classification-honesty", "incident-honesty"],
    incidents: [
      {
        shift: 5,
        stage: "daily-usage",
        attributionClass: "empty-completion",
        magnitudeMicroUsd: "9600",
        dispositionKind: "accepted-risk",
      },
    ],
  }),
  pilotRow({
    rowId: "pilot-incident-recorded-attributed",
    description:
      "The incident row: six shifts, shift 2 declaring the mid-shift failure (its retryable provider-class incident recorded AND attributed under the bounded-retry disposition — the failed attempt's 9600microUsd cost at stake carried in the magnitude), plus one injected non-retryable tool-class incident at shift 4's plan stage under its escalation record (1500microUsd at stake). Every incident recorded, every incident attributed through the IMPORTED VAL-020 taxonomy with its disposition honoring the class's retryability discipline, and the window-wide budget envelope holding (reservations settle exactly; the ledger chain holds).",
    workloadClass: "incident-injection-window",
    shifts: sixShifts(2),
    tolerancePct: 10,
    observationFamilies: ["incident-honesty", "budget-policy-envelope"],
    incidents: [
      {
        shift: 2,
        stage: "daily-usage",
        attributionClass: "provider-unavailable",
        magnitudeMicroUsd: "9600",
        dispositionKind: "bounded-retry",
      },
      {
        shift: 4,
        stage: "plan",
        attributionClass: "tool-failure",
        magnitudeMicroUsd: "1500",
        dispositionKind: "escalated",
      },
    ],
  }),
  pilotRow({
    rowId: "pilot-budget-reservations-settled",
    description:
      "The tight-envelope row: six shifts under a window budget of EXACTLY the recorded cost basis (81000microUsd — zero headroom) with the within-budget admission policy and a per-shift latency bound of exactly the recorded shift latency (400ms). Every shift's reservation admits sequentially (each settles before the next reserves), every spend cites its authorizing reservation and lands exactly on the budget (never over), every reservation settles at end-of-window with zero remainder released, and the append-only ledger's digest chain holds across the whole window.",
    workloadClass: "tight-budget-envelope-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    operatingProfile: {
      costBudgetMicroUsd: "81000",
      latencyBudgetMsPerShift: 400,
      admissionPolicy: "admit-within-budget",
    },
    observationFamilies: ["budget-policy-envelope"],
  }),
];

// ---------------------------------------------------------------------------
// The adversarial probe rows (the seven issued probes, 1:1)
// ---------------------------------------------------------------------------

/** The adversarial probe rows (each FAILs its pinned NAMED criteria). */
export const PROBE_CORPUS_ROWS: readonly PilotCorpusRow[] = [
  pilotRow({
    rowId: "probe-pilot-cherry-picked-window",
    description:
      "The cherry-picked-window probe row (the issued adversarial probe 1:1): the window declares the anomalous shape — shift 4 drifting beyond tolerance WITH its cause declared, shift 5's resolved-quality regression UNdeclared — and the observation lane DROPS the two anomalous shifts from the window record, reporting a clean four-shift sub-window over the declared six-shift window. The window-honesty oracle FAILs with the omitted shifts and the cherry-picked sub-window NAMED, the schedule-completeness oracle FAILs with the missed shifts NAMED, and the end-of-window reconciliation FAILs with the unexplained pilot-level residual NAMED. A cherry-picked window never passes.",
    workloadClass: "declared-drift-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    divergences: [{ shift: 4, stage: "daily-usage", cause: LOAD_SHAPING_COHORT_MIX }],
    driftFactors: [
      {
        shift: 4,
        factors: [{ stage: "daily-usage", costDriftPct: 25, latencyDriftPct: 0, resolvedDrift: 0 }],
      },
      {
        shift: 5,
        factors: [{ stage: "daily-usage", costDriftPct: 0, latencyDriftPct: 0, resolvedDrift: 1 }],
      },
    ],
    observationFamilies: ["window-honesty", "end-of-window-reconciliation"],
    probe: { kind: "cherry-picked-window" },
  }),
  pilotRow({
    rowId: "probe-pilot-dropped-shift",
    description:
      "The dropped-shift probe row (the issued adversarial probe 1:1): the window record omits scheduled shift 3 entirely — the shift never lands in the observation lane and its recorded cost vanishes from the accounting. The schedule-completeness oracle FAILs with the missed shift NAMED (missed-shift:3), the window-honesty oracle FAILs with the omitted shift and the cherry-picked sub-window NAMED, and the end-of-window reconciliation FAILs with the missing shift's recorded basis NAMED as the unexplained pilot-level residual. A window that silently drops a scheduled shift never passes.",
    workloadClass: "recorded-portfolio-replay-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    observationFamilies: ["schedule-completeness", "end-of-window-reconciliation"],
    probe: { kind: "dropped-shift" },
  }),
  pilotRow({
    rowId: "probe-pilot-double-driven-resume",
    description:
      "The double-driven-resume probe row (the issued adversarial probe 1:1): the declared failure shift's resume is driven TWICE — three attempts land for the failed daily-usage stage (the recorded basis holds exactly two). The record carries the third attempt's cost and latency honestly (the stage cost 28800microUsd over the recorded 19200) and claims the resulting drift as the regressing it derives to, but the continuation-exactly-once oracle FAILs with the duplicated resume NAMED (attempts=3, resumes=2), and the end-of-window reconciliation FAILs with the third attempt's 9600microUsd NAMED as the unexplained residual. A resumed shift that double-drives never passes.",
    workloadClass: "journey-continuation-replay-window",
    shifts: sixShifts(3),
    tolerancePct: 10,
    observationFamilies: ["continuation-exactly-once", "end-of-window-reconciliation"],
    incidents: [
      {
        shift: 3,
        stage: "daily-usage",
        attributionClass: "provider-unavailable",
        magnitudeMicroUsd: "9600",
        dispositionKind: "bounded-retry",
      },
    ],
    probe: { kind: "double-driven-resume" },
  }),
  pilotRow({
    rowId: "probe-pilot-drift-normalizing",
    description:
      "The drift-normalizing probe row (the issued adversarial probe 1:1): shift 5's daily-usage segment regresses beyond the tolerance on economics (+30% over the recorded basis, UNdeclared) and the observation lane NORMALIZES the classification back within bounds — the record carries the real drifted economics (12480microUsd observed over the recorded 9600) while the claim says within-declared-bounds. The drift-classification-honesty oracle FAILs with the hidden regression NAMED (the segment AND the mechanism — the drifted dimensions with their percentages), and the end-of-window reconciliation FAILs with the 2880microUsd unexplained stage residual NAMED. A normalized drift never passes.",
    workloadClass: "declared-drift-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    driftFactors: [
      {
        shift: 5,
        factors: [{ stage: "daily-usage", costDriftPct: 30, latencyDriftPct: 0, resolvedDrift: 0 }],
      },
    ],
    observationFamilies: ["drift-classification-honesty", "end-of-window-reconciliation"],
    probe: { kind: "drift-normalizing" },
  }),
  pilotRow({
    rowId: "probe-pilot-incident-hiding",
    description:
      "The incident-hiding probe row (the issued adversarial probe 1:1): the incident log omits the shift-2 failure incident — the timeline still holds the declared failure and its exactly-once resume, and the shift's stage record still carries the two-attempt recorded economics, but the log holds no attributed record and the shift's reported total hides the failed attempt's 9600microUsd cost. The incident-honesty oracle FAILs with the hidden incident NAMED (the timeline holds the event, the log omits it), and the end-of-window reconciliation FAILs with the hidden 9600microUsd NAMED as the shift-level residual (both sides named). A hidden incident never passes.",
    workloadClass: "incident-injection-window",
    shifts: sixShifts(2),
    tolerancePct: 10,
    observationFamilies: ["incident-honesty", "end-of-window-reconciliation"],
    incidents: [
      {
        shift: 2,
        stage: "daily-usage",
        attributionClass: "provider-unavailable",
        magnitudeMicroUsd: "9600",
        dispositionKind: "bounded-retry",
      },
      {
        shift: 4,
        stage: "plan",
        attributionClass: "tool-failure",
        magnitudeMicroUsd: "1500",
        dispositionKind: "escalated",
      },
    ],
    probe: { kind: "incident-hiding" },
  }),
  pilotRow({
    rowId: "probe-pilot-residual-hiding",
    description:
      "The residual-hiding probe row (the issued adversarial probe 1:1): the end-of-window reported total hides part of a shift's stage cost — the window's reported totalCostMicroUsd omits shift 1's onboarding stage cost (1200microUsd) while every stage record and every per-shift total stays honest. The end-of-window reconciliation oracle FAILs with the exact unexplained amount NAMED (the reported total, the observed Σ shifts and the residual — both sides named); an unexplained pilot-level residual never passes.",
    workloadClass: "recorded-portfolio-replay-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    observationFamilies: ["end-of-window-reconciliation"],
    probe: { kind: "residual-hiding" },
  }),
  pilotRow({
    rowId: "probe-pilot-boundary-leak",
    description:
      "The boundary-leak probe row (the issued adversarial probe 1:1): shift 4's every stage executes under the journey corpus's FOREIGN application identity (imported — the leak shape, never re-declared free-text) instead of the pilot's own customer identity. The customer-boundary-integrity oracle FAILs with the leaking shift, its stages and the foreign identity NAMED; the customer boundary holds at every stage of every shift of every honest window.",
    workloadClass: "recorded-portfolio-replay-window",
    shifts: sixShifts(),
    tolerancePct: 10,
    observationFamilies: ["customer-boundary-integrity"],
    probe: { kind: "boundary-leak" },
  }),
];

/** The offline rows (the honest rows + the adversarial probes — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly PilotCorpusRow[] = [
  ...HONEST_PILOT_ROWS,
  ...PROBE_CORPUS_ROWS,
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL live dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL live dispatch). */
export const LIVE_CORPUS_ROWS: readonly PilotCorpusRow[] = [
  pilotRow({
    rowId: "live-pilot-real-window-slice",
    description:
      "A REAL live pilot slice (env-gated on OPENROUTER_API_KEY): the pinned live plan's declared window — 3 shifts × 2 REAL dispatches, six live dispatches SUSTAINED across the window at 1500ms on / 500ms off pacing over the ONE pinned OpenRouter rail — driven through the REAL platform path, recorded through the REAL recorder with honest MEASURED economics, classified honestly against the recorded basis (a measured gap beyond the declared tolerance named drifting or regressing with its mechanism — noise is never signal, never normalized, never fabricated), and reconciled stage-for-stage and shift-for-shift with the live measured deltas declared. Without the credential the row is honestly NOT RUN (the env var named, never a fake success); the verdict is DERIVED from the measured facts, never pinned.",
    workloadClass: LIVE_PILOT_WORKLOAD_CLASS,
    shifts: [PORTFOLIO_SHIFT, PORTFOLIO_SHIFT, PORTFOLIO_SHIFT],
    tolerancePct: 50,
    operatingProfile: {
      costBudgetMicroUsd: "81000",
      latencyBudgetMsPerShift: 30000,
      admissionPolicy: "admit-all-scheduled",
    },
    live: true,
  }),
];

// ---------------------------------------------------------------------------
// The pinned corpus (offline rows first, live rows last)
// ---------------------------------------------------------------------------

/** The full pinned corpus (offline honest rows, probe rows, then the ONE live row). */
export const PILOT_CORPUS_ROWS: readonly PilotCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The plan's corpus name (the VAL-049/050 export surface). */
export const PILOT_CORPUS: readonly PilotCorpusRow[] = PILOT_CORPUS_ROWS;

/** The row ids in corpus order (config.json mirrors this slice). */
export const PILOT_ROW_IDS: readonly string[] = PILOT_CORPUS_ROWS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function pilotRowById(rowId: string): PilotCorpusRow | null {
  return PILOT_CORPUS_ROWS.find((row) => row.rowId === rowId) ?? null;
}

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: PilotCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

/**
 * Drive one corpus row through the row driver (PURE — the 8-criteria
 * synthesis over the row's own derivation-level window record; the
 * live row's closed gate yields the honest NOT-RUN with the env var
 * named).
 */
export function pilotRowResultFor(row: PilotCorpusRow): PilotRowResult {
  return drivePilotRow({
    rowId: row.rowId,
    window: row.window,
    schedule: row.schedule,
    policy: row.operatingProfile,
    observation: pilotWindowRecordFor(row),
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate }),
  });
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one pilot submission: each row's
 * window lands its OWN durable execution (one submission per row —
 * never a re-issue of another row's key).
 */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-051-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one pilot submission: the task kind, the
 * pinned row, its workload class, the declared window and schedule and
 * the observation families under test — REFERENCES ONLY (never a
 * price, never a recorded-result copy; the platform resolves the
 * recorded corpora through their registries).
 */
export function taskBodyFor(options: { readonly row: PilotCorpusRow }): Record<string, unknown> {
  const failureShifts = options.row.schedule.shifts
    .filter((shift) => shift.failureStage !== null)
    .map((shift) => ({ shift: shift.shift, stage: shift.failureStage }));
  return {
    kind: PILOT_TASK_KIND,
    rowId: options.row.rowId,
    pilot: {
      workloadClass: options.row.workloadClass,
      declaredShifts: options.row.window.declaredShifts,
      driftTolerancePct: options.row.window.driftTolerancePct,
      shifts: options.row.schedule.shifts.map((shift) => shift.journeyRowId),
      ...(failureShifts.length === 0 ? {} : { failureShifts }),
      observationFamilies: [...options.row.observationFamilies],
      recordedInputDigests: options.row.recordedInputReferences.map(
        (reference) => reference.recordedInputDigests.length,
      ),
    },
  };
}

/**
 * The corpus input digest (the stable FNV-1a over the pinned corpus
 * vocabulary — the reproducibility pin; config.json mirrors it).
 */
export function pinnedPilotInputDigest(): string {
  return economicDigestOf({
    version: PILOT_CORPUS_VERSION,
    rows: [...PILOT_ROW_IDS],
    customer: PILOT_CUSTOMER_APPLICATION_ID,
  });
}

/**
 * The VAL-049 audit rows this corpus carries economics from (the
 * cost-basis anchors, deduplicated in first-reference order — the
 * pilot's own `CARRIED_AUDIT_ROW_IDS` discipline).
 */
export const PILOT_CARRIED_AUDIT_ROW_IDS: readonly string[] = [
  ...new Set(
    PILOT_CORPUS_ROWS.flatMap((row) =>
      row.recordedInputReferences.flatMap((reference) => reference.basisAuditRowIds),
    ),
  ),
];

// ---------------------------------------------------------------------------
// The module-load invariants (a drifted corpus THROWS before any window is observed)
// ---------------------------------------------------------------------------

/** Assert the corpus shape (the row counts + uniqueness + the live boundary). */
function assertCorpusShape(): void {
  if (PILOT_CORPUS_ROWS.length !== 14) {
    throw new Error(
      `the pilot corpus holds exactly 14 rows (6 honest + 7 probes + 1 live — found ${PILOT_CORPUS_ROWS.length})`,
    );
  }
  if (new Set(PILOT_ROW_IDS).size !== 14) {
    throw new Error("the pilot corpus row ids are unique");
  }
  if (OFFLINE_CORPUS_ROWS.length !== 13 || PROBE_CORPUS_ROWS.length !== 7) {
    throw new Error(
      `the offline corpus holds 13 rows (6 honest + 7 probes — found ${OFFLINE_CORPUS_ROWS.length}) and the probe corpus holds 7 (found ${PROBE_CORPUS_ROWS.length})`,
    );
  }
  if (OFFLINE_CORPUS_ROWS.filter((row) => row.probe === undefined).length !== 6) {
    throw new Error("the offline corpus holds exactly 6 honest rows");
  }
  const liveRows = PILOT_CORPUS_ROWS.filter((row) => row.liveGate !== undefined);
  if (liveRows.length !== 1 || liveRows[0]?.rowId !== "live-pilot-real-window-slice") {
    throw new Error("the pilot corpus holds exactly ONE live row (live-pilot-real-window-slice)");
  }
  if (PILOT_CORPUS_ROWS.filter((row) => row.needsDispatch).length !== 1) {
    throw new Error("exactly the live row needs dispatch (the offline rows need zero credentials)");
  }
  for (const row of OFFLINE_CORPUS_ROWS) {
    if (row.liveGate !== undefined || row.needsDispatch) {
      throw new Error(`offline row ${row.rowId} never carries a live gate or a dispatch need`);
    }
  }
}

/** Assert every observation family is exercised by ≥1 honest row. */
function assertFamilyCoverage(): void {
  for (const family of PILOT_OBSERVATION_FAMILIES) {
    const covered = OFFLINE_CORPUS_ROWS.some(
      (row) => row.probe === undefined && row.observationFamilies.includes(family),
    );
    if (!covered) {
      throw new Error(
        `the observation family ${family} is exercised by at least one honest row (the issued AC4 vocabulary is never declared hollow)`,
      );
    }
  }
}

/** Assert every workload class is used by ≥1 row. */
function assertWorkloadClassCoverage(): void {
  for (const workloadClass of PILOT_WORKLOAD_CLASSES) {
    if (!PILOT_CORPUS_ROWS.some((row) => row.workloadClass === workloadClass)) {
      throw new Error(`the workload class ${workloadClass} is used by at least one row`);
    }
  }
}

/** Assert the schedule digests re-derive (PURE determinism at module load). */
function assertScheduleDeterminism(): void {
  for (const row of PILOT_CORPUS_ROWS) {
    const rederived = deriveShiftSchedule({ shifts: row.shiftDeclarations });
    if (rederived.scheduleDigest !== row.schedule.scheduleDigest) {
      throw new Error(
        `the schedule digest of row ${row.rowId} re-derives (declared ${row.schedule.scheduleDigest}, recomputed ${rederived.scheduleDigest})`,
      );
    }
  }
}

/**
 * Assert every carried VAL-049 audit anchor re-resolves through the
 * audit corpus's OWN resolver AND its recorded evidence replays
 * through the EXPORTED replay machinery (the `recordedRefOf` pin
 * pattern re-implemented app-locally — the full chain pilot → journey
 * → audit → the VAL-041..048 recorded evidence re-derived at pin
 * time; a drifted recorded corpus THROWS before any window can be
 * observed).
 */
function assertCarriedBasisReplaysResolve(): void {
  for (const auditRowId of PILOT_CARRIED_AUDIT_ROW_IDS) {
    const auditRow = auditRowById(auditRowId);
    if (auditRow === null) {
      throw new Error(
        `the VAL-049 audit corpus holds no row ${auditRowId} (a carried pilot anchor must resolve)`,
      );
    }
    // the anchor itself re-derives through the audit corpus's OWN
    // resolver (an unresolvable anchor THROWS here).
    carriedBasisDigestOf(auditRowId);
    for (const reference of auditRow.evidence) {
      const replay = replayRecordedEvidenceOf({
        workOrder: reference.workOrder,
        corpusRowId: reference.corpusRowId,
      });
      if (!replay.resolvable || replay.recomputedDigest !== reference.recordedDigest) {
        throw new Error(
          `the carried anchor ${auditRowId}'s recorded evidence ${reference.workOrder}:${reference.corpusRowId} failed to replay (resolvable ${replay.resolvable}, digest ${replay.recomputedDigest} over the recorded ${reference.recordedDigest} — a drifted recorded corpus breaks the pilot's cost basis mechanically)`,
        );
      }
    }
  }
}

/** Assert the declared incident vocabulary (imported classes + valid dispositions). */
function assertIncidentVocabulary(): void {
  for (const row of PILOT_CORPUS_ROWS) {
    for (const declared of row.declaredIncidents) {
      if (!isKnownAttributionClass(declared.attributionClass)) {
        throw new Error(
          `row ${row.rowId} declares incident ${declared.shift}:${declared.stage} with a class foreign to the imported VAL-020 taxonomy (${declared.attributionClass})`,
        );
      }
      if (!dispositionIsValidFor(declared.attributionClass, declared.dispositionKind)) {
        throw new Error(
          `row ${row.rowId} declares incident ${declared.shift}:${declared.stage} with a disposition invalid for ${declared.attributionClass} (${declared.dispositionKind})`,
        );
      }
    }
  }
}

assertCorpusShape();
assertFamilyCoverage();
assertWorkloadClassCoverage();
assertScheduleDeterminism();
assertCarriedBasisReplaysResolve();
assertIncidentVocabulary();
