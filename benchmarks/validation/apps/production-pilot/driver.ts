/**
 * The production-pilot engine (VAL-051, the app-local driver — the work
 * order's allowed surface ONLY).
 *
 * THE PILOT MACHINERY: the mechanical engine over the DECLARED pilot
 * window — a production-style pilot over the RECORDED application
 * portfolio and the end-to-end customer journey (VAL-050), driven under
 * production-style operating discipline:
 *
 *   * the DECLARED SCHEDULE OF SHIFTS — each shift REPLAYING the
 *     recorded journey stages (their audited VAL-049 economics carried
 *     as the pilot's cost basis, digest-referenced), pinned by
 *     `scheduleDigestOf` at row-declaration time and re-resolved
 *     through the RECORDED corpora's OWN resolvers (a drifted corpus
 *     THROWS before any window can be observed);
 *   * PURE DERIVATION over the RECORDED corpora — the pilot's
 *     per-segment economics, latency and resolved-quality derive over
 *     the recorded stage records (the re-measurement ban: nothing
 *     re-drives a recorded workload, nothing re-prices a recorded
 *     input; the one live row is the only fresh-measurement lane, and
 *     every offline observation is honestly labeled
 *     `derived-from-recorded-basis`, never claimed as a measurement);
 *   * CONTINUATION EXACTLY-ONCE — a declared mid-window failure
 *     resumes EXACTLY ONCE (the failed shift lands exactly its two
 *     recorded attempts, the failed attempt's cost carried honestly,
 *     never hidden); a dropped or double-driven resume FAILs NAMED
 *     with the shift and the attempt count;
 *   * the WINDOW-WIDE BUDGET/POLICY ENVELOPE — reservations settle or
 *     release by end-of-window, every spend cites its authorizing
 *     reservation and sits within the window budget, and the
 *     append-only ledger's digest chain is monotonic (an erased or
 *     rewritten line breaks it mechanically);
 *   * DRIFT HONESTLY CLASSIFIED per segment against the VAL-049
 *     recorded basis — within-declared-bounds / drifting with the
 *     mechanism NAMED / regressing reported AS regressing — the
 *     three-way vocabulary where the CLAIMED classification must equal
 *     the DERIVED one (a silently normalized drift or a hidden
 *     regression FAILs with the segment AND the mechanism NAMED);
 *   * the CUSTOMER BOUNDARY across the ENTIRE window — every stage of
 *     every shift under the pilot's own customer identity.
 *
 * The mechanical verdict vocabulary (never a narrative):
 * PILOT-COMPLETED / PILOT-FAILED / NOT-RUN — the honest drifting and
 * regressing classifications COMPLETED with their finding named.
 *
 * The digest discipline: the house FNV-1a convention
 * (`economicDigestOf`, imported from the economic-baseline driver —
 * never re-implemented); every recorded reference is recomputed at pin
 * time through the recorded corpora's OWN exported resolvers
 * (`journeyRowById`, `auditRowById` — never copies, never private
 * reach-throughs); payload DIGESTS only in evidence, never payload
 * bytes; the accounting arithmetic rides the REAL accounting rails —
 * the reservation/settlement ledger is the pilot's own append-only
 * envelope, and it never re-implements the platform's recorder.
 */

import type { LabVerificationCriterion } from "../../platform/derive";
import {
  ATTRIBUTION_CLASSES,
  type AttributionClass,
  isRetryableAttributionClass,
  layerOfAttributionClass,
} from "../../platform/failure-attribution";
import {
  CARRIED_AUDIT_ROW_IDS,
  type JourneyStageDeclaration,
  type JourneyStageKind,
  journeyRowById,
  type RecordedStageEconomics,
} from "../customer-journey/corpus";
import { auditRowById } from "../economic-audit/corpus";
import { economicDigestOf } from "../economic-baseline/driver";

// ---------------------------------------------------------------------------
// The vocabulary (the verdicts + the observation families + the drift + the policies)
// ---------------------------------------------------------------------------

/**
 * The pilot's customer identity — the application identity every stage
 * of every shift of every honest window executes under (the
 * customer-boundary criterion's pinned basis; a stage executing under
 * any other identity is a cross-tenant leak and FAILs NAMED).
 */
export const PILOT_CUSTOMER_APPLICATION_ID = "app-pilot-customer";

/** The pilot verdict vocabulary (never a narrative rescue). */
export type PilotVerdictKind = "PILOT-COMPLETED" | "PILOT-FAILED" | "NOT-RUN";

/** The declared verdict vocabulary (the pinned ladder of record). */
export const PILOT_VERDICT_KINDS: readonly PilotVerdictKind[] = Object.freeze([
  "PILOT-COMPLETED",
  "PILOT-FAILED",
  "NOT-RUN",
]);

/**
 * The observation families (the issued AC4 verification vocabulary, in
 * the issued order — one oracle per family, each naming the criterion
 * it FAILs).
 */
export type PilotObservationFamily =
  | "window-honesty"
  | "schedule-completeness"
  | "continuation-exactly-once"
  | "drift-classification-honesty"
  | "incident-honesty"
  | "budget-policy-envelope"
  | "end-of-window-reconciliation"
  | "customer-boundary-integrity";

/** The declared observation-family vocabulary (the pinned order of record). */
export const PILOT_OBSERVATION_FAMILIES: readonly PilotObservationFamily[] = Object.freeze([
  "window-honesty",
  "schedule-completeness",
  "continuation-exactly-once",
  "drift-classification-honesty",
  "incident-honesty",
  "budget-policy-envelope",
  "end-of-window-reconciliation",
  "customer-boundary-integrity",
]);

/**
 * The three-way drift-classification vocabulary (never two-way):
 * within the declared tolerance; beyond WITH a declared divergence
 * cause (the mechanism NAMED); beyond UNdeclared (reported AS
 * regressing — never hidden, never normalized away).
 */
export type DriftClassification = "within-declared-bounds" | "drifting" | "regressing";

/** The declared drift-classification vocabulary (the pinned three-way ladder). */
export const DRIFT_CLASSIFICATIONS: readonly DriftClassification[] = Object.freeze([
  "within-declared-bounds",
  "drifting",
  "regressing",
]);

/**
 * The admission-policy vocabulary (the window-wide envelope's shift
 * admission discipline): `admit-all-scheduled` admits every scheduled
 * shift and holds the budget as a named envelope; `admit-within-budget`
 * holds admission on the remaining window budget (an over-budget
 * reservation is REFUSED and recorded in the ledger — the shift it
 * would have authorized never lands, and the schedule-completeness
 * criterion names it).
 */
export type PilotAdmissionPolicy = "admit-all-scheduled" | "admit-within-budget";

/** The declared admission-policy vocabulary. */
export const PILOT_ADMISSION_POLICIES: readonly PilotAdmissionPolicy[] = Object.freeze([
  "admit-all-scheduled",
  "admit-within-budget",
]);

/**
 * The honest observation-lane label (the re-measurement ban's own
 * vocabulary): offline observations are derived from the recorded
 * basis; only the live row's observation is a measurement.
 */
export type PilotObservationBasis = "derived-from-recorded-basis" | "measured-live";

// ---------------------------------------------------------------------------
// The declared pilot window (the fixity anchor, digest-pinned at row declaration)
// ---------------------------------------------------------------------------

/**
 * One declared divergence (the VAL-049 `declaredDivergence` pattern:
 * a beyond-tolerance drift is permitted WITH CAUSE, NAMED — never a
 * silent normalization; the cause vocabulary is the ONLY permitted
 * drift, and a bound is never widened post-hoc).
 */
export interface PilotDeclaredDivergence {
  /** The diverging segment's shift ordinal. */
  readonly shift: number;
  /** The diverging segment's journey stage. */
  readonly stage: JourneyStageKind;
  /** The NAMED cause (the declared divergence mechanism). */
  readonly cause: string;
}

/** The declared pilot window (the fixity anchor, digest-pinned at row declaration). */
export interface PilotWindow {
  /** The number of declared shifts (the schedule's cardinality). */
  readonly declaredShifts: number;
  /** The declared observation span: the inclusive shift ordinals the window covers. */
  readonly declaredSpan: { readonly firstShift: number; readonly lastShift: number };
  /** The declared drift tolerance (percent vs the recorded basis, window-wide). */
  readonly driftTolerancePct: number;
  /** The declared divergences (permitted WITH cause, NAMED). */
  readonly declaredDivergences: readonly PilotDeclaredDivergence[];
}

/**
 * The declared window's FNV-1a pin (PURE — the fixity anchor's digest;
 * a post-hoc widened tolerance or an edited span changes it
 * mechanically).
 */
export function pilotWindowDigestOf(window: PilotWindow): string {
  return economicDigestOf({
    kind: "pilot-window",
    declaredShifts: window.declaredShifts,
    declaredSpan: {
      firstShift: window.declaredSpan.firstShift,
      lastShift: window.declaredSpan.lastShift,
    },
    driftTolerancePct: window.driftTolerancePct,
    declaredDivergences: window.declaredDivergences.map((divergence) => ({
      shift: divergence.shift,
      stage: divergence.stage,
      cause: divergence.cause,
    })),
  });
}

// ---------------------------------------------------------------------------
// The declared schedule of shifts (digest-pinned, resolved through the RECORDED corpora)
// ---------------------------------------------------------------------------

/** One shift's declaration (the schedule's per-shift input). */
export interface ShiftDeclaration {
  /** The RECORDED workload reference: the VAL-050 journey row this shift replays. */
  readonly journeyRowId: string;
  /**
   * The declared mid-shift failure stage (the two-attempt continuation
   * shape), when declared — it must be the journey row's OWN recorded
   * failure stage (the continuation basis is never synthesized).
   */
  readonly failureStage?: JourneyStageKind;
}

/** One segment of one scheduled shift (the recorded basis the shift replays). */
export interface ShiftSegment {
  readonly stage: JourneyStageKind;
  /** The recorded input digests the segment composes (digest references only). */
  readonly recordedInputDigests: readonly string[];
  /** The segment's recorded economics (the carried VAL-049 cost basis, never re-priced). */
  readonly economics: RecordedStageEconomics;
  /**
   * The declared attempt count (exactly 2 for the failure stage — the
   * failed attempt plus exactly one resume; 1 otherwise).
   */
  readonly declaredAttempts: number;
  /**
   * The recorded basis's resolved attempts (each recorded stage
   * resolves exactly its final attempt — the failed attempt of a
   * two-attempt stage is carried as cost, unresolved).
   */
  readonly recordedResolvedAttempts: number;
}

/** One scheduled shift (the deterministic shift plan's member). */
export interface ScheduledShift {
  /** The shift ordinal (0-based, in schedule order). */
  readonly shift: number;
  /** The RECORDED workload reference (the VAL-050 journey row this shift replays). */
  readonly journeyRowId: string;
  /** The declared mid-shift failure stage (null when the shift declares none). */
  readonly failureStage: JourneyStageKind | null;
  /** The per-stage recorded basis the shift replays (digest-pinned). */
  readonly segments: readonly ShiftSegment[];
}

/** The declared schedule of shifts (the digest-pinned shift plan). */
export interface ShiftSchedule {
  readonly shifts: readonly ScheduledShift[];
  /** The FNV-1a pin over the whole schedule (recomputed via `scheduleDigestOf`). */
  readonly scheduleDigest: string;
}

/**
 * The carried basis digest of one VAL-049 audit anchor, recomputed
 * through the audit corpus's OWN resolver (PURE — the pin pattern
 * re-implemented app-locally over the EXPORTED resolver, never
 * imported privately: a drifted or unresolvable audit corpus THROWS
 * before any window can be observed).
 */
export function carriedBasisDigestOf(auditRowId: string): string {
  const auditRow = auditRowById(auditRowId);
  if (auditRow === null) {
    throw new Error(`the VAL-049 audit corpus holds no row ${auditRowId}`);
  }
  return economicDigestOf({
    workOrder: "VAL-049",
    auditRowId: auditRow.rowId,
    recordedDigests: auditRow.evidence.map((reference) => reference.recordedDigest),
  });
}

/**
 * Re-resolve EVERY carried VAL-049 audit anchor the journey corpus
 * pins (PURE — the `CARRIED_AUDIT_ROW_IDS` discipline: an unresolvable
 * anchor THROWS at module load, so a drifted audit corpus cannot
 * silently exist under the pilot).
 */
export function carriedAuditBasisDigests(): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const auditRowId of CARRIED_AUDIT_ROW_IDS) {
    digests.set(auditRowId, carriedBasisDigestOf(auditRowId));
  }
  return digests;
}

/**
 * Derive the deterministic shift schedule (PURE — the digest-pinned
 * declared schedule machinery): shifts `0..n-1`, each carrying its
 * RECORDED workload reference resolved through `journeyRowById` (a
 * stale reference THROWS), its per-stage recorded input digests and
 * recorded economics (the carried cost basis), and — for the declared
 * failure shift — the two-attempt continuation shape taken from the
 * journey continuation row's OWN recorded economics (never
 * synthesized). Every stage's basis anchor is recomputed through
 * `auditRowById` and must equal the journey row's declared anchor
 * digest (a drifted corpus THROWS).
 */
export function deriveShiftSchedule(input: {
  readonly shifts: readonly ShiftDeclaration[];
}): ShiftSchedule {
  if (input.shifts.length === 0) {
    throw new Error("a pilot window declares at least one shift");
  }
  const shifts: ScheduledShift[] = input.shifts.map((declaration, index) => {
    const journeyRow = journeyRowById(declaration.journeyRowId);
    if (journeyRow === null) {
      throw new Error(
        `the VAL-050 journey corpus holds no row ${declaration.journeyRowId} (a stale pilot corpus cannot silently exist)`,
      );
    }
    const declaredFailure = declaration.failureStage ?? null;
    const recordedFailure = journeyRow.midJourneyFailureStage ?? null;
    if (declaredFailure !== recordedFailure) {
      throw new Error(
        `shift ${index} replays journey row ${journeyRow.rowId} with a failure shape that is not the recorded one (declared ${
          declaredFailure ?? "none"
        }, recorded ${
          recordedFailure ?? "none"
        } — the two-attempt continuation basis is the recorded one, never synthesized)`,
      );
    }
    const segments: ShiftSegment[] = journeyRow.stages.map(
      (stage: JourneyStageDeclaration): ShiftSegment => {
        const recomputedBasis = carriedBasisDigestOf(stage.economics.basisAuditRowId);
        if (recomputedBasis !== stage.economics.basisDigest) {
          throw new Error(
            `the carried basis anchor of journey row ${journeyRow.rowId} stage ${stage.stage} drifted (declared ${stage.economics.basisDigest}, recomputed ${recomputedBasis} — a drifted VAL-049 audit corpus breaks the anchor mechanically)`,
          );
        }
        return {
          stage: stage.stage,
          recordedInputDigests: [...stage.recordedInputDigests],
          economics: stage.economics,
          declaredAttempts: declaredFailure === stage.stage ? 2 : 1,
          recordedResolvedAttempts: 1,
        };
      },
    );
    return {
      shift: index,
      journeyRowId: journeyRow.rowId,
      failureStage: declaredFailure,
      segments,
    };
  });
  return {
    shifts,
    scheduleDigest: scheduleDigestOf({ shifts }),
  };
}

/**
 * The schedule's FNV-1a pin (PURE — pins the whole schedule: the
 * shifts' recorded workload references, their per-segment recorded
 * input digests, their carried economics and their attempt shapes; a
 * post-hoc edit of any member changes it mechanically).
 */
export function scheduleDigestOf(plan: { readonly shifts: readonly ScheduledShift[] }): string {
  return economicDigestOf({
    kind: "pilot-shift-schedule",
    shifts: plan.shifts.map((shift) => ({
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
  });
}

/**
 * One scheduled shift's recorded cost basis (PURE — the Σ of its
 * segments' recorded economics in microUsd; the reservation amount
 * the window-wide envelope draws against for the shift).
 */
export function shiftCostBasisOf(scheduled: ScheduledShift): string {
  return scheduled.segments
    .reduce((total, segment) => total + BigInt(segment.economics.costMicroUsd), 0n)
    .toString();
}

/**
 * One scheduled shift's recorded latency basis (PURE — the Σ of its
 * segments' recorded latencies in ms; the per-shift latency budget's
 * comparison basis).
 */
export function shiftLatencyBasisOf(scheduled: ScheduledShift): number {
  return scheduled.segments.reduce((total, segment) => total + segment.economics.latencyMs, 0);
}

// ---------------------------------------------------------------------------
// The observed window record (the vocabulary the oracles verify — never trusted)
// ---------------------------------------------------------------------------

/** One observed segment of one observed shift (the window record's member). */
export interface ObservedShiftSegment {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  /** The attempts the segment landed (the continuation basis). */
  readonly attempts: number;
  /** The resolved attempts (the resolved-quality basis). */
  readonly resolved: number;
  /** The observed per-segment cost (microUsd — derived offline, MEASURED live). */
  readonly costMicroUsd: string;
  /** The observed per-segment latency (ms). */
  readonly latencyMs: number;
  /** The carried VAL-049 basis anchor (digest-only, never payload bytes). */
  readonly basisDigest: string;
  /** The identity the segment executed under (the customer-boundary basis). */
  readonly applicationId: string;
}

/** One observed shift (the window record's per-shift member). */
export interface ObservedShiftRecord {
  readonly shift: number;
  /** The recorded workload reference the shift claims to have replayed. */
  readonly journeyRowId: string;
  readonly segments: readonly ObservedShiftSegment[];
  /** The shift's reported cost total (the shift-for-shift reconciliation basis). */
  readonly reportedCostMicroUsd: string;
  /** The shift's reported latency total. */
  readonly reportedLatencyMs: number;
}

/**
 * One continuation record (the resume ledger's member): the declared
 * failure segment's resume, recorded EXACTLY ONCE with the failed
 * attempt's cost carried honestly (never hidden).
 */
export interface ContinuationRecord {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  /** The failed attempt's cost (microUsd — carried honestly, never hidden). */
  readonly failedAttemptCostMicroUsd: string;
  /** The resume's durable execution id (the resume ledger's exactly-once member). */
  readonly resumeExecutionId: string;
  /** The resumes the failed stage landed (exactly 1 honest — a double-driven resume FAILs NAMED). */
  readonly resumes: number;
}

/** One CLAIMED per-segment drift classification (never trusted — the honesty oracle re-derives it). */
export interface ClaimedDriftClassification {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  /** The CLAIMED classification (must equal the DERIVED one — mechanically). */
  readonly claimed: DriftClassification;
  /** The claimed mechanism (the declared divergence cause when claimed drifting). */
  readonly mechanism: string | null;
}

/** The incident disposition vocabulary (never free-text, never silent). */
export type IncidentDispositionKind = "bounded-retry" | "escalated" | "accepted-risk";

/** One incident's disposition (the bounded disposition / the escalation or accepted-risk record). */
export interface IncidentDisposition {
  readonly kind: IncidentDispositionKind;
  /** The disposition record's content digest (the bounded disposition / escalation / accepted-risk record). */
  readonly detailDigest: string;
}

/**
 * One incident in the window (the incident log's member): recorded AND
 * attributed — the root-cause class comes from the IMPORTED VAL-020
 * taxonomy (`ATTRIBUTION_CLASSES` — never free-text, never
 * re-implemented); a hidden incident (the timeline holds the event,
 * the log omits it) or an unattributed incident FAILs NAMED.
 */
export interface IncidentRecord {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  /** The root-cause class (the imported VAL-020 taxonomy). */
  readonly attributionClass: AttributionClass;
  /** The incident's magnitude (the cost at stake, microUsd — carried honestly). */
  readonly magnitudeMicroUsd: string;
  readonly disposition: IncidentDisposition;
}

/**
 * Whether a value is a known attribution class (the imported
 * taxonomy's own membership test — the incident-honesty basis over
 * untrusted records).
 */
export function isKnownAttributionClass(value: string): value is AttributionClass {
  return (ATTRIBUTION_CLASSES as readonly string[]).includes(value);
}

/**
 * Whether a disposition kind is valid for an attribution class (the
 * incident vocabulary's discipline: a retryable class carries its
 * bounded disposition; a non-retryable class carries its escalation or
 * accepted-risk record — never the other way around).
 */
export function dispositionIsValidFor(
  attributionClass: AttributionClass,
  kind: IncidentDispositionKind,
): boolean {
  if (isRetryableAttributionClass(attributionClass)) {
    return kind === "bounded-retry";
  }
  return kind === "escalated" || kind === "accepted-risk";
}

/**
 * One incident record's evidence line (the layer NAMED through the
 * imported taxonomy's own table — payload-free).
 */
export function incidentEvidenceOf(record: IncidentRecord): string {
  return `incident:shift ${record.shift} ${record.stage} (${record.attributionClass}@${layerOfAttributionClass(
    record.attributionClass,
  )}, magnitude ${record.magnitudeMicroUsd}microUsd, ${record.disposition.kind})`;
}

/**
 * The incident log's seal (PURE — the FNV-1a digest over the incident
 * records in log order; the log is append-only and digest-sealed).
 */
export function incidentLogDigestOf(incidents: readonly IncidentRecord[]): string {
  return economicDigestOf({
    kind: "pilot-incident-log",
    incidents: incidents.map((record) => ({
      shift: record.shift,
      stage: record.stage,
      attributionClass: record.attributionClass,
      magnitudeMicroUsd: record.magnitudeMicroUsd,
      disposition: record.disposition.kind,
      detailDigest: record.disposition.detailDigest,
    })),
  });
}

/** The observed pilot window (the window record the observation lane produced — never trusted). */
export interface PilotWindowObservation {
  readonly rowId: string;
  /** The observation lane's honest label (derived offline; MEASURED live). */
  readonly basis: PilotObservationBasis;
  /** The observed shift records (the window's own record of what landed). */
  readonly shifts: readonly ObservedShiftRecord[];
  /** The incident log (append-only, digest-sealed). */
  readonly incidents: readonly IncidentRecord[];
  /** The claimed per-segment drift classifications (compared against the derived ones). */
  readonly claimedDrift: readonly ClaimedDriftClassification[];
  /** The continuation records (one per resumed segment — the resume ledger). */
  readonly continuations: readonly ContinuationRecord[];
  /** The budget/policy ledger (append-only, digest-chained). */
  readonly ledger: readonly LedgerLine[];
  /** The window's reported totals (the end-of-window reconciliation basis). */
  readonly reported: { readonly totalCostMicroUsd: string; readonly totalLatencyMs: number };
  /** The window record's digest over the observed shift identities (payload-free). */
  readonly windowDigest: string;
  /** The measured usage (the live rail only; honestly null offline). */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/**
 * The window record's digest (PURE — FNV-1a over the observed shift
 * identities: the ordinals, the workload references and the
 * stage:attempts:resolved shapes; payload-free).
 */
export function windowRecordDigestOf(input: {
  readonly rowId: string;
  readonly basis: PilotObservationBasis;
  readonly shifts: readonly ObservedShiftRecord[];
}): string {
  return economicDigestOf({
    rowId: input.rowId,
    basis: input.basis,
    shifts: input.shifts.map((shift) => ({
      shift: shift.shift,
      journeyRowId: shift.journeyRowId,
      segments: shift.segments.map(
        (segment) => `${segment.stage}:${segment.attempts}:${segment.resolved}`,
      ),
    })),
  });
}

// ---------------------------------------------------------------------------
// The replay derivation (PURE — the re-measurement ban honored)
// ---------------------------------------------------------------------------

/**
 * One segment's declared drift factor (the drift rows' honest derived
 * drift: the observation lane applies the factor over the recorded
 * basis — BigInt micro-USD arithmetic, deterministic — and the drift
 * oracle classifies the RESULT honestly; never a silent normalization).
 */
export interface SegmentDriftFactor {
  readonly stage: JourneyStageKind;
  /** The cost drift factor (percent over the recorded basis; negative = below). */
  readonly costDriftPct: number;
  /** The latency drift factor (percent over the recorded basis; negative = below). */
  readonly latencyDriftPct: number;
  /** The resolved attempts LOST vs the recorded basis (the resolved-quality drift). */
  readonly resolvedDrift: number;
}

/**
 * Derive one scheduled shift's HONEST observed record (PURE — the
 * recorded-basis replay derivation: every observed fact derives over
 * the RECORDED journey stage economics — nothing re-drives a recorded
 * workload, nothing re-prices a recorded input; the declared drift
 * factors apply where declared, and the observation is honestly
 * labeled `derived-from-recorded-basis`, never claimed as a
 * measurement). The declared failure shift lands exactly its two
 * recorded attempts with the continuation record carrying the failed
 * attempt's per-attempt cost and exactly one resume.
 */
export function deriveShiftObservation(input: {
  readonly rowId: string;
  readonly scheduled: ScheduledShift;
  /** The declared drift factors applied over the recorded basis (the drift rows' shape). */
  readonly driftFactors?: readonly SegmentDriftFactor[];
}): { readonly shift: ObservedShiftRecord; readonly continuation: ContinuationRecord | null } {
  const driftFactors = input.driftFactors ?? [];
  const segments: ObservedShiftSegment[] = input.scheduled.segments.map((segment) => {
    const driftFactor = driftFactors.find((factor) => factor.stage === segment.stage) ?? null;
    const basisCost = BigInt(segment.economics.costMicroUsd);
    const costMicroUsd =
      driftFactor === null
        ? basisCost
        : basisCost + (basisCost * BigInt(driftFactor.costDriftPct)) / 100n;
    const basisLatency = segment.economics.latencyMs;
    const latencyMs =
      driftFactor === null
        ? basisLatency
        : Math.max(
            0,
            basisLatency + Math.trunc((basisLatency * driftFactor.latencyDriftPct) / 100),
          );
    const resolved =
      driftFactor === null
        ? segment.recordedResolvedAttempts
        : Math.max(0, segment.recordedResolvedAttempts - driftFactor.resolvedDrift);
    return {
      shift: input.scheduled.shift,
      stage: segment.stage,
      attempts: segment.declaredAttempts,
      resolved,
      costMicroUsd: costMicroUsd.toString(),
      latencyMs,
      basisDigest: segment.economics.basisDigest,
      applicationId: PILOT_CUSTOMER_APPLICATION_ID,
    } satisfies ObservedShiftSegment;
  });
  const reportedCost = segments.reduce(
    (total, segment) => total + BigInt(segment.costMicroUsd),
    0n,
  );
  const reportedLatency = segments.reduce((total, segment) => total + segment.latencyMs, 0);
  const failureStage = input.scheduled.failureStage;
  let continuation: ContinuationRecord | null = null;
  if (failureStage !== null) {
    const observedFailure = segments.find((segment) => segment.stage === failureStage);
    if (observedFailure === undefined) {
      throw new Error(
        `shift ${input.scheduled.shift} declares its failure at ${failureStage} but the recorded journey basis holds no such stage`,
      );
    }
    const attemptDivisor = observedFailure.attempts > 0 ? observedFailure.attempts : 1;
    continuation = {
      shift: input.scheduled.shift,
      stage: failureStage,
      failedAttemptCostMicroUsd: (
        BigInt(observedFailure.costMicroUsd) / BigInt(attemptDivisor)
      ).toString(),
      resumeExecutionId: `pilot-resume-${input.rowId}-shift${input.scheduled.shift}-${failureStage}`,
      resumes: 1,
    };
  }
  return {
    shift: {
      shift: input.scheduled.shift,
      journeyRowId: input.scheduled.journeyRowId,
      segments,
      reportedCostMicroUsd: reportedCost.toString(),
      reportedLatencyMs: reportedLatency,
    },
    continuation,
  };
}

// ---------------------------------------------------------------------------
// The window-wide budget/policy ledger (append-only, digest-chained)
// ---------------------------------------------------------------------------

/** The declared budget/policy envelope (enforced across the WHOLE window, never per-shift in isolation). */
export interface PilotBudgetPolicy {
  /** The window's total cost budget (microUsd — every reservation and spend draws against it). */
  readonly costBudgetMicroUsd: string;
  /** The per-shift latency budget (ms — the policy bound each observed shift's latency). */
  readonly latencyBudgetMsPerShift: number;
  /** The admission policy (the shift admission discipline). */
  readonly admissionPolicy: PilotAdmissionPolicy;
}

/** The append-only ledger's line kinds. */
export type LedgerLineKind = "reservation" | "settlement" | "spend" | "release" | "refusal";

/**
 * One append-only ledger line: every line carries the FNV-1a digest
 * over its OWN content chained over the PREVIOUS line's digest — the
 * chain is monotonic, and an erased or rewritten line breaks it
 * mechanically.
 */
export interface LedgerLine {
  /** 1-based ordinal (the append order). */
  readonly ordinal: number;
  readonly kind: LedgerLineKind;
  readonly shift: number;
  /** The line's amount (microUsd — the reserved/settled/spent/released/refused amount). */
  readonly amountMicroUsd: string;
  /** The authorizing reservation (spend/settlement/release lines cite it; reservation lines carry their own id). */
  readonly reservationId: string | null;
  /** The line's content digest (FNV-1a over its content, chained over the previous line). */
  readonly lineDigest: string;
  /** The previous line's digest (the chain link; the first line chains over the ledger basis). */
  readonly previousDigest: string;
}

/** One budget reservation's derived state (the envelope's authorizing member). */
export interface BudgetReservation {
  readonly reservationId: string;
  readonly shift: number;
  /** The reserved amount (microUsd — held against the window budget at dispatch). */
  readonly amountMicroUsd: string;
  /** The reservation's terminal-or-held state (held → settled or released; a dangling held reservation FAILs NAMED). */
  readonly state: "held" | "settled" | "released";
  /** The settled amount (when settled — the shift's derived cost). */
  readonly settledMicroUsd: string | null;
}

/**
 * The ledger's basis digest (PURE — FNV-1a over the declared envelope;
 * the first line's chain link, so a rewritten policy breaks the chain
 * mechanically).
 */
export function ledgerBasisDigestOf(policy: PilotBudgetPolicy): string {
  return economicDigestOf({
    ledger: "pilot-budget-ledger",
    costBudgetMicroUsd: policy.costBudgetMicroUsd,
    latencyBudgetMsPerShift: policy.latencyBudgetMsPerShift,
    admissionPolicy: policy.admissionPolicy,
  });
}

/**
 * Derive the reservations from the ledger lines (PURE — the
 * append-only state machine over the lines: a reservation line opens a
 * held reservation; a settlement settles it; a release releases it;
 * later lines win. A refusal line never opens a reservation — a spend
 * citing a refused id authorizes nothing).
 */
export function reservationsOf(lines: readonly LedgerLine[]): readonly BudgetReservation[] {
  const byId = new Map<string, BudgetReservation>();
  for (const line of lines) {
    const reservationId = line.reservationId;
    if (reservationId === null) {
      continue;
    }
    if (line.kind === "reservation") {
      byId.set(reservationId, {
        reservationId,
        shift: line.shift,
        amountMicroUsd: line.amountMicroUsd,
        state: "held",
        settledMicroUsd: null,
      });
      continue;
    }
    const held = byId.get(reservationId);
    if (held === undefined) {
      continue;
    }
    if (line.kind === "settlement") {
      byId.set(reservationId, { ...held, state: "settled", settledMicroUsd: line.amountMicroUsd });
    } else if (line.kind === "release") {
      byId.set(reservationId, { ...held, state: "released" });
    }
  }
  return [...byId.values()];
}

/**
 * Verify the ledger's digest chain (PURE — the append-only discipline's
 * mechanical check: every ordinal strictly follows, every line's digest
 * recomputes over its OWN content, and every chain link equals the
 * previous line's digest; an erased, rewritten or reordered line breaks
 * it at the first divergence, NAMED by its ordinal).
 */
export function ledgerChainHolds(input: {
  readonly lines: readonly LedgerLine[];
  readonly basis: string;
}): { readonly holds: boolean; readonly breakOrdinal: number | null } {
  let previous = input.basis;
  for (const [index, line] of input.lines.entries()) {
    const expectedOrdinal = index + 1;
    const expectedDigest = economicDigestOf({
      ordinal: line.ordinal,
      kind: line.kind,
      shift: line.shift,
      amountMicroUsd: line.amountMicroUsd,
      reservationId: line.reservationId,
      previousDigest: line.previousDigest,
    });
    if (
      line.ordinal !== expectedOrdinal ||
      line.previousDigest !== previous ||
      line.lineDigest !== expectedDigest
    ) {
      return { holds: false, breakOrdinal: line.ordinal };
    }
    previous = line.lineDigest;
  }
  return { holds: true, breakOrdinal: null };
}

/** The append-only budget/policy ledger writer (the honest machinery — the oracles never trust its output). */
export interface WindowLedgerWriter {
  /**
   * Reserve budget for one shift at dispatch (the authorizing line).
   * Under `admit-within-budget` an over-budget reservation is REFUSED
   * (the refusal line appended; the shift it would have authorized is
   * never admitted).
   */
  reserve(input: {
    readonly shift: number;
    readonly reservationId: string;
    readonly amountMicroUsd: string;
  }): { readonly admitted: boolean };
  /** Settle one held reservation against the shift's derived cost at completion (the difference is released by the settlement). */
  settle(input: { readonly reservationId: string; readonly settledMicroUsd: string }): void;
  /** Release one held reservation's remainder (a reservation that never settles). */
  release(input: { readonly reservationId: string; readonly amountMicroUsd: string }): void;
  /** Record one authorized spend line (citing its reservation; within the reservation and the window budget). */
  spend(input: { readonly reservationId: string; readonly amountMicroUsd: string }): void;
  /** The ledger's lines in append order (a frozen copy). */
  lines(): readonly LedgerLine[];
  /** The chain head (the ledger basis before the first line; the last line's digest after). */
  head(): string;
  /** The reservations derived from the lines (PURE re-derivation — the never-trust basis). */
  reservations(): readonly BudgetReservation[];
}

/**
 * Create the append-only budget/policy ledger (the honest machinery:
 * every line's digest chains over the previous line's; a reservation id
 * is admitted at most once; a settlement or spend never escapes its
 * reservation; the spend total never escapes the window budget. The
 * dishonest lanes hand-build their own lines — the envelope oracle
 * catches them mechanically).
 */
export function createWindowLedger(policy: PilotBudgetPolicy): WindowLedgerWriter {
  const basis = ledgerBasisDigestOf(policy);
  const lines: LedgerLine[] = [];
  const append = (
    kind: LedgerLineKind,
    shift: number,
    amountMicroUsd: string,
    reservationId: string | null,
  ): void => {
    const headLine = lines.at(-1);
    const previousDigest = headLine === undefined ? basis : headLine.lineDigest;
    const ordinal = lines.length + 1;
    lines.push({
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
    });
  };
  const parseAmount = (amountMicroUsd: string): bigint => {
    if (!/^[0-9]+$/.test(amountMicroUsd)) {
      throw new Error(`a ledger amount is microUsd, non-negative integer (${amountMicroUsd})`);
    }
    return BigInt(amountMicroUsd);
  };
  const reservationById = (reservationId: string): BudgetReservation | null => {
    const reservation = reservationsOf(lines).find(
      (candidate) => candidate.reservationId === reservationId,
    );
    return reservation ?? null;
  };
  return {
    reserve(input) {
      const amount = parseAmount(input.amountMicroUsd);
      const alreadyAdmitted = lines.some(
        (line) =>
          (line.kind === "reservation" || line.kind === "refusal") &&
          line.reservationId === input.reservationId,
      );
      if (alreadyAdmitted) {
        throw new Error(
          `reservation ${input.reservationId} was already admitted (the ledger is append-only — a reservation id is unique)`,
        );
      }
      if (policy.admissionPolicy === "admit-within-budget") {
        const outstanding = reservationsOf(lines)
          .filter((reservation) => reservation.state === "held")
          .reduce((total, reservation) => total + BigInt(reservation.amountMicroUsd), 0n);
        if (outstanding + amount > BigInt(policy.costBudgetMicroUsd)) {
          append("refusal", input.shift, input.amountMicroUsd, input.reservationId);
          return { admitted: false };
        }
      }
      append("reservation", input.shift, input.amountMicroUsd, input.reservationId);
      return { admitted: true };
    },
    settle(input) {
      const reservation = reservationById(input.reservationId);
      if (reservation === null) {
        throw new Error(
          `no reservation ${input.reservationId} (the ledger authorizes nothing that was never reserved)`,
        );
      }
      if (reservation.state !== "held") {
        throw new Error(
          `reservation ${input.reservationId} is ${reservation.state} (the ledger is append-only — never re-settled, never re-released)`,
        );
      }
      const settled = parseAmount(input.settledMicroUsd);
      if (settled > BigInt(reservation.amountMicroUsd)) {
        throw new Error(
          `settlement ${input.settledMicroUsd} escapes reservation ${input.reservationId} (${reservation.amountMicroUsd})`,
        );
      }
      append("settlement", reservation.shift, input.settledMicroUsd, input.reservationId);
    },
    release(input) {
      const reservation = reservationById(input.reservationId);
      if (reservation === null) {
        throw new Error(
          `no reservation ${input.reservationId} (the ledger authorizes nothing that was never reserved)`,
        );
      }
      if (reservation.state !== "held") {
        throw new Error(
          `reservation ${input.reservationId} is ${reservation.state} (the ledger is append-only — never re-settled, never re-released)`,
        );
      }
      const released = parseAmount(input.amountMicroUsd);
      if (released > BigInt(reservation.amountMicroUsd)) {
        throw new Error(
          `release ${input.amountMicroUsd} escapes reservation ${input.reservationId} (${reservation.amountMicroUsd})`,
        );
      }
      append("release", reservation.shift, input.amountMicroUsd, input.reservationId);
    },
    spend(input) {
      const reservation = reservationById(input.reservationId);
      if (reservation === null) {
        throw new Error(
          `no reservation ${input.reservationId} (an unauthorized spend is never written by the honest machinery)`,
        );
      }
      if (reservation.state !== "held") {
        throw new Error(
          `reservation ${input.reservationId} is ${reservation.state} (a spend cites a held reservation)`,
        );
      }
      const amount = parseAmount(input.amountMicroUsd);
      const spentOnReservation = lines
        .filter((line) => line.kind === "spend" && line.reservationId === input.reservationId)
        .reduce((total, line) => total + BigInt(line.amountMicroUsd), 0n);
      if (spentOnReservation + amount > BigInt(reservation.amountMicroUsd)) {
        throw new Error(
          `spend ${input.amountMicroUsd} escapes reservation ${input.reservationId} (${reservation.amountMicroUsd} reserved, ${spentOnReservation.toString()} already spent)`,
        );
      }
      const totalSpent = lines
        .filter((line) => line.kind === "spend")
        .reduce((total, line) => total + BigInt(line.amountMicroUsd), 0n);
      if (totalSpent + amount > BigInt(policy.costBudgetMicroUsd)) {
        throw new Error(
          `spend ${input.amountMicroUsd} breaches the window budget ${policy.costBudgetMicroUsd} (the window-wide envelope is never escaped)`,
        );
      }
      append("spend", reservation.shift, input.amountMicroUsd, input.reservationId);
    },
    lines() {
      return [...lines];
    },
    head() {
      const headLine = lines.at(-1);
      return headLine === undefined ? basis : headLine.lineDigest;
    },
    reservations() {
      return reservationsOf(lines);
    },
  };
}

// ---------------------------------------------------------------------------
// The drift derivation (per segment, vs the VAL-049 recorded basis)
// ---------------------------------------------------------------------------

/** One segment's derived drift (the three-way classification + the drift dimensions). */
export interface SegmentDrift {
  readonly shift: number;
  readonly stage: JourneyStageKind;
  readonly classification: DriftClassification;
  /** The mechanism (the declared divergence cause when drifting; null otherwise). */
  readonly mechanism: string | null;
  readonly economicsDriftPct: number;
  readonly latencyDriftPct: number;
  readonly resolvedQualityDriftPct: number;
  /** Whether any dimension sits beyond the declared tolerance. */
  readonly beyondTolerance: boolean;
  /** The dimensions beyond the declared tolerance (the NAMED mechanism of the catch). */
  readonly beyondDimensions: readonly string[];
}

/** Parse a microUsd amount without ever throwing over untrusted records (null when malformed). */
function parseMicroUsd(value: string): bigint | null {
  return /^-?[0-9]+$/.test(value) ? BigInt(value) : null;
}

/** The cost drift percentage (|observed - basis| / basis; unbounded over a malformed or degenerate basis). */
function costDriftPctOf(observedCostMicroUsd: string, basisCostMicroUsd: string): number {
  const observed = parseMicroUsd(observedCostMicroUsd);
  const basis = parseMicroUsd(basisCostMicroUsd);
  if (observed === null || basis === null || basis <= 0n) {
    return observed !== null && observed === basis ? 0 : Infinity;
  }
  const delta = observed > basis ? observed - basis : basis - observed;
  return Number((delta * 100n) / basis);
}

/** The latency drift percentage (|observed - basis| / basis; unbounded over a non-finite or degenerate basis). */
function latencyDriftPctOf(observedLatencyMs: number, basisLatencyMs: number): number {
  if (!Number.isFinite(observedLatencyMs) || !Number.isFinite(basisLatencyMs)) {
    return Infinity;
  }
  if (basisLatencyMs <= 0) {
    return observedLatencyMs === basisLatencyMs ? 0 : Infinity;
  }
  const delta = Math.abs(observedLatencyMs - basisLatencyMs);
  return Math.trunc((delta * 100) / basisLatencyMs);
}

/**
 * The resolved-quality drift percentage (the observed resolved ratio
 * vs the recorded basis's, in integer rational arithmetic; unbounded
 * over a non-finite or empty observation).
 */
function resolvedQualityDriftPctOf(
  observed: { readonly attempts: number; readonly resolved: number },
  basis: { readonly attempts: number; readonly resolved: number },
): number {
  const finite =
    Number.isFinite(observed.attempts) &&
    Number.isFinite(observed.resolved) &&
    Number.isFinite(basis.attempts) &&
    Number.isFinite(basis.resolved);
  if (!finite || observed.attempts <= 0) {
    return basis.resolved > 0 ? Infinity : 0;
  }
  if (basis.attempts <= 0 || basis.resolved <= 0) {
    return observed.resolved > 0 ? Infinity : 0;
  }
  // |resolved_o / attempts_o - resolved_b / attempts_b| / (resolved_b / attempts_b) * 100
  const numerator =
    Math.abs(observed.resolved * basis.attempts - basis.resolved * observed.attempts) * 100;
  return Math.trunc(numerator / (observed.attempts * basis.resolved));
}

/** Format one drift percentage for evidence (never a bare Infinity). */
function formatDriftPct(pct: number): string {
  return Number.isFinite(pct) ? `${pct}` : "unbounded";
}

/** One derived drift's dimension evidence (economics / latency / resolved-quality, with percentages). */
function driftDimensionsEvidenceOf(drift: SegmentDrift): string {
  return [
    `economics ${formatDriftPct(drift.economicsDriftPct)}%`,
    `latency ${formatDriftPct(drift.latencyDriftPct)}%`,
    `resolved-quality ${formatDriftPct(drift.resolvedQualityDriftPct)}%`,
  ].join(", ");
}

/**
 * Derive one segment's drift classification (PURE — the three-way
 * vocabulary over the observed facts vs the RECORDED basis, against
 * the window's declared tolerance and declared divergences): within
 * `driftTolerancePct` on every dimension → `within-declared-bounds`;
 * beyond WITH a declared divergence cause → `drifting` (the mechanism
 * NAMED); beyond UNdeclared → `regressing` (reported as regressing).
 */
export function deriveSegmentDrift(input: {
  readonly window: PilotWindow;
  readonly shift: number;
  readonly segment: ShiftSegment;
  readonly observed: ObservedShiftSegment;
}): SegmentDrift {
  const economicsDriftPct = costDriftPctOf(
    input.observed.costMicroUsd,
    input.segment.economics.costMicroUsd,
  );
  const latencyDriftPct = latencyDriftPctOf(
    input.observed.latencyMs,
    input.segment.economics.latencyMs,
  );
  const resolvedQualityDriftPct = resolvedQualityDriftPctOf(
    { attempts: input.observed.attempts, resolved: input.observed.resolved },
    { attempts: input.segment.declaredAttempts, resolved: input.segment.recordedResolvedAttempts },
  );
  const tolerance = input.window.driftTolerancePct;
  const beyondDimensions: string[] = [];
  if (economicsDriftPct > tolerance) {
    beyondDimensions.push("economics");
  }
  if (latencyDriftPct > tolerance) {
    beyondDimensions.push("latency");
  }
  if (resolvedQualityDriftPct > tolerance) {
    beyondDimensions.push("resolved-quality");
  }
  const beyondTolerance = beyondDimensions.length > 0;
  const declared =
    input.window.declaredDivergences.find(
      (divergence) => divergence.shift === input.shift && divergence.stage === input.segment.stage,
    ) ?? null;
  const classification: DriftClassification = !beyondTolerance
    ? "within-declared-bounds"
    : declared !== null
      ? "drifting"
      : "regressing";
  return {
    shift: input.shift,
    stage: input.segment.stage,
    classification,
    mechanism: classification === "drifting" ? (declared === null ? null : declared.cause) : null,
    economicsDriftPct,
    latencyDriftPct,
    resolvedQualityDriftPct,
    beyondTolerance,
    beyondDimensions: [...beyondDimensions],
  };
}

/**
 * Derive the window's per-segment drift classifications (PURE — every
 * scheduled segment that the window record observed; a missing shift
 * or segment is the window-honesty and schedule-completeness
 * criteria's catch, never silently skipped past).
 */
export function deriveWindowDrift(input: {
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): readonly SegmentDrift[] {
  const drifts: SegmentDrift[] = [];
  for (const scheduledShift of input.schedule.shifts) {
    const observedShift = input.observation.shifts.find(
      (candidate) => candidate.shift === scheduledShift.shift,
    );
    if (observedShift === undefined) {
      continue;
    }
    for (const segment of scheduledShift.segments) {
      const observedSegment = observedShift.segments.find(
        (candidate) => candidate.stage === segment.stage,
      );
      if (observedSegment === undefined) {
        continue;
      }
      drifts.push(
        deriveSegmentDrift({
          window: input.window,
          shift: scheduledShift.shift,
          segment,
          observed: observedSegment,
        }),
      );
    }
  }
  return drifts;
}

// ---------------------------------------------------------------------------
// The PURE oracles (each names the criterion it FAILs)
// ---------------------------------------------------------------------------

/** Format shift ordinals as named ranges (4..5; 0..3,7; none). */
function formatShiftRange(ordinals: readonly number[]): string {
  if (ordinals.length === 0) {
    return "none";
  }
  const sorted = [...new Set(ordinals)].sort((left, right) => left - right);
  const first = sorted[0];
  if (first === undefined) {
    return "none";
  }
  const parts: string[] = [];
  let start = first;
  let previous = first;
  for (const current of sorted.slice(1)) {
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}..${previous}`);
    start = current;
    previous = current;
  }
  parts.push(start === previous ? `${start}` : `${start}..${previous}`);
  return parts.join(",");
}

/**
 * ORACLE 1 — FAILs `window-honesty`: the declared observation window
 * matches the recorded data — the observed shifts equal the DECLARED
 * shifts over the DECLARED span (the window and its schedule agree;
 * the fixity anchor holds); a cherry-picked sub-window, an omitted
 * shift or an omitted segment is NAMED with the offending shifts.
 */
export function deriveWindowHonesty(input: {
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { window, schedule, observation } = input;
  const scheduledOrdinals = schedule.shifts.map((shift) => shift.shift);
  const declaredSet = new Set(scheduledOrdinals);
  const observedOrdinals = observation.shifts.map((shift) => shift.shift);
  const distinctObserved = new Set(observedOrdinals);
  const evidence: string[] = [
    `declared-window:shifts ${window.declaredShifts} over span ${window.declaredSpan.firstShift}..${window.declaredSpan.lastShift}`,
    `schedule-shifts:${formatShiftRange(scheduledOrdinals)}`,
    `observed-shifts:${formatShiftRange(observedOrdinals)}`,
  ];
  const problems: string[] = [];
  if (window.declaredShifts !== schedule.shifts.length) {
    problems.push(
      `window-schedule-divergence:the window declares ${window.declaredShifts} shifts, the schedule holds ${schedule.shifts.length}`,
    );
  }
  const spanCoversSchedule = scheduledOrdinals.every(
    (ordinal) =>
      ordinal >= window.declaredSpan.firstShift && ordinal <= window.declaredSpan.lastShift,
  );
  const spanCount = window.declaredSpan.lastShift - window.declaredSpan.firstShift + 1;
  if (!spanCoversSchedule || spanCount !== window.declaredShifts) {
    problems.push(
      `declared-span-divergence:span ${window.declaredSpan.firstShift}..${window.declaredSpan.lastShift} does not cover exactly the ${window.declaredShifts} declared shifts`,
    );
  }
  const omitted = scheduledOrdinals.filter((ordinal) => !distinctObserved.has(ordinal));
  if (omitted.length > 0) {
    problems.push(`omitted-shift:${formatShiftRange(omitted)}`);
  }
  const extended = observedOrdinals.filter((ordinal) => !declaredSet.has(ordinal));
  for (const ordinal of extended) {
    problems.push(`post-hoc-extension:shift ${ordinal} (observed outside the declared window)`);
  }
  if (
    observedOrdinals.length > 0 &&
    extended.length === 0 &&
    distinctObserved.size < declaredSet.size
  ) {
    problems.push(
      `cherry-picked-sub-window:shifts ${formatShiftRange(observedOrdinals)} of ${formatShiftRange(scheduledOrdinals)}`,
    );
  }
  for (const scheduledShift of schedule.shifts) {
    const observedShift = observation.shifts.find(
      (candidate) => candidate.shift === scheduledShift.shift,
    );
    if (observedShift === undefined) {
      continue;
    }
    const observedStages = new Set(observedShift.segments.map((segment) => segment.stage));
    for (const segment of scheduledShift.segments) {
      if (!observedStages.has(segment.stage)) {
        problems.push(
          `omitted-segment:shift ${scheduledShift.shift} ${segment.stage} (declared in the recorded basis, absent from the window record)`,
        );
      }
    }
  }
  return {
    criterionId: "window-honesty",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 2 — FAILs `schedule-completeness`: every scheduled shift
 * lands exactly once in the window record — a MISSED shift, a
 * DUPLICATED shift, an UNDECLARED shift and a workload SUBSTITUTION
 * (an observed shift replaying a journey row that is not its declared
 * one) are each NAMED.
 */
export function deriveScheduleCompleteness(input: {
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { schedule, observation } = input;
  const scheduledOrdinals = schedule.shifts.map((shift) => shift.shift);
  const observedOrdinals = observation.shifts.map((shift) => shift.shift);
  const scheduledSet = new Set(scheduledOrdinals);
  const evidence: string[] = [
    `scheduled-shifts:${formatShiftRange(scheduledOrdinals)}`,
    `observed-shifts:${formatShiftRange(observedOrdinals)}`,
    `scheduled-shift-count:${scheduledOrdinals.length}`,
    `observed-shift-count:${observedOrdinals.length}`,
  ];
  const problems: string[] = [];
  for (const ordinal of scheduledOrdinals) {
    if (!observedOrdinals.includes(ordinal)) {
      problems.push(`missed-shift:${ordinal}`);
    }
  }
  const counts = new Map<number, number>();
  for (const ordinal of observedOrdinals) {
    counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1);
  }
  for (const [ordinal, count] of counts) {
    if (count > 1) {
      problems.push(`duplicated-shift:${ordinal} (${count} records)`);
    }
    if (!scheduledSet.has(ordinal)) {
      problems.push(`undeclared-shift:${ordinal} (never scheduled)`);
    }
  }
  for (const observedShift of observation.shifts) {
    const scheduledShift = schedule.shifts.find(
      (candidate) => candidate.shift === observedShift.shift,
    );
    if (scheduledShift === undefined) {
      continue;
    }
    if (observedShift.journeyRowId !== scheduledShift.journeyRowId) {
      problems.push(
        `workload-substitution:shift ${observedShift.shift} (journey ${observedShift.journeyRowId}, declared ${scheduledShift.journeyRowId})`,
      );
    }
  }
  return {
    criterionId: "schedule-completeness",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 3 — FAILs `continuation-exactly-once`: a declared mid-window
 * failure resumes EXACTLY ONCE — every scheduled segment lands exactly
 * its declared attempts (two for the failure stage: the failed attempt
 * plus exactly one resume, the failed attempt's cost carried honestly,
 * never hidden); a dropped resume, a double-driven resume, an
 * undeclared resume, a missing/duplicated/undeclared continuation
 * record or a hidden failed-attempt cost is NAMED with the shift and
 * the attempt count.
 */
export function deriveContinuationExactlyOnce(input: {
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { schedule, observation } = input;
  const failureShifts = schedule.shifts.filter((shift) => shift.failureStage !== null);
  const evidence: string[] = [
    `declared-failure-shifts:${
      failureShifts.map((shift) => `shift ${shift.shift} ${shift.failureStage}`).join(";") || "none"
    }`,
    `continuation-records:${observation.continuations.length}`,
  ];
  const problems: string[] = [];
  for (const scheduledShift of schedule.shifts) {
    const observedShift = observation.shifts.find(
      (candidate) => candidate.shift === scheduledShift.shift,
    );
    if (observedShift === undefined) {
      if (scheduledShift.failureStage !== null) {
        problems.push(
          `dropped-resume-shift:shift ${scheduledShift.shift} (the declared failure shift never landed — its resume never continued)`,
        );
      }
      continue;
    }
    for (const segment of scheduledShift.segments) {
      const observedSegment = observedShift.segments.find(
        (candidate) => candidate.stage === segment.stage,
      );
      if (observedSegment === undefined) {
        if (segment.stage === scheduledShift.failureStage) {
          problems.push(
            `missing-failure-segment:shift ${scheduledShift.shift} ${segment.stage} (the declared failure stage is absent from the window record)`,
          );
        }
        continue;
      }
      evidence.push(
        `shift ${scheduledShift.shift} ${segment.stage}:attempts=${observedSegment.attempts},declared=${segment.declaredAttempts}`,
      );
      if (observedSegment.attempts === segment.declaredAttempts) {
        continue;
      }
      const isFailureSegment = segment.stage === scheduledShift.failureStage;
      if (isFailureSegment && observedSegment.attempts > segment.declaredAttempts) {
        problems.push(
          `double-driven-resume:shift ${scheduledShift.shift} ${segment.stage} (attempts=${observedSegment.attempts}, expected exactly ${segment.declaredAttempts} — the resume was driven ${
            observedSegment.attempts - segment.declaredAttempts + 1
          } times)`,
        );
      } else if (isFailureSegment) {
        problems.push(
          `dropped-resume:shift ${scheduledShift.shift} ${segment.stage} (attempts=${observedSegment.attempts}, expected exactly ${segment.declaredAttempts} — the failed attempt never resumed)`,
        );
      } else if (observedSegment.attempts > segment.declaredAttempts) {
        problems.push(
          `undeclared-resume:shift ${scheduledShift.shift} ${segment.stage} (attempts=${observedSegment.attempts}, expected ${segment.declaredAttempts} — no declared failure there)`,
        );
      } else {
        problems.push(
          `dropped-attempts:shift ${scheduledShift.shift} ${segment.stage} (attempts=${observedSegment.attempts}, expected ${segment.declaredAttempts})`,
        );
      }
    }
  }
  for (const scheduledShift of failureShifts) {
    const failureStage = scheduledShift.failureStage;
    if (failureStage === null) {
      continue;
    }
    const records = observation.continuations.filter(
      (record) => record.shift === scheduledShift.shift && record.stage === failureStage,
    );
    if (records.length === 0) {
      problems.push(
        `missing-continuation-record:shift ${scheduledShift.shift} ${failureStage} (the resume never recorded its continuation)`,
      );
      continue;
    }
    if (records.length > 1) {
      problems.push(
        `duplicated-continuation-record:shift ${scheduledShift.shift} ${failureStage} (${records.length} records — the resume ledger holds exactly one)`,
      );
    }
    for (const record of records) {
      if (record.resumes !== 1) {
        problems.push(
          `double-driven-resume:shift ${record.shift} ${record.stage} (resumes=${record.resumes}, expected exactly 1)`,
        );
      }
      if (!/^[0-9]+$/.test(record.failedAttemptCostMicroUsd)) {
        problems.push(
          `hidden-failed-attempt-cost:shift ${record.shift} ${record.stage} (failedAttemptCostMicroUsd=${record.failedAttemptCostMicroUsd} — not a carried cost)`,
        );
      } else if (BigInt(record.failedAttemptCostMicroUsd) <= 0n) {
        problems.push(
          `hidden-failed-attempt-cost:shift ${record.shift} ${record.stage} (failedAttemptCostMicroUsd=${record.failedAttemptCostMicroUsd} — the failed attempt's cost is carried honestly, never hidden)`,
        );
      }
    }
  }
  for (const record of observation.continuations) {
    const scheduledShift = schedule.shifts.find((candidate) => candidate.shift === record.shift);
    if (scheduledShift === undefined || scheduledShift.failureStage !== record.stage) {
      problems.push(
        `undeclared-continuation-record:shift ${record.shift} ${record.stage} (no declared mid-window failure there)`,
      );
    }
  }
  return {
    criterionId: "continuation-exactly-once",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 4 — FAILs `drift-classification-honesty`: per-segment
 * observation (economics, latency, resolved-quality) vs the VAL-049
 * RECORDED basis (the stage economics' `basisDigest` anchors): within
 * `driftTolerancePct` → `within-declared-bounds`; beyond WITH a
 * declared divergence cause → `drifting` (the mechanism NAMED); beyond
 * UNdeclared → `regressing` (reported as regressing). The CLAIMED
 * classification must equal the DERIVED one — a silently normalized
 * drift or a hidden regression FAILs with the segment AND the
 * mechanism NAMED; a claim over a segment the window never observed
 * FAILs NAMED.
 */
export function deriveDriftClassificationHonesty(input: {
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { window, schedule, observation } = input;
  const drifts = deriveWindowDrift({ window, schedule, observation });
  const evidence: string[] = [
    `drift-tolerance-pct:${window.driftTolerancePct}`,
    `declared-divergences:${
      window.declaredDivergences
        .map((divergence) => `shift ${divergence.shift} ${divergence.stage}(${divergence.cause})`)
        .join(";") || "none"
    }`,
    `claimed-classifications:${observation.claimedDrift.length}`,
  ];
  const problems: string[] = [];
  for (const drift of drifts) {
    evidence.push(
      `derived:shift ${drift.shift} ${drift.stage} → ${drift.classification}${
        drift.mechanism === null ? "" : ` via ${drift.mechanism}`
      } (${driftDimensionsEvidenceOf(drift)})`,
    );
    const claim =
      observation.claimedDrift.find(
        (candidate) => candidate.shift === drift.shift && candidate.stage === drift.stage,
      ) ?? null;
    if (claim === null) {
      problems.push(
        `unclaimed-segment:shift ${drift.shift} ${drift.stage} (every observed segment carries its claimed classification)`,
      );
      continue;
    }
    if (claim.claimed !== drift.classification) {
      if (claim.claimed === "within-declared-bounds" && drift.classification === "drifting") {
        problems.push(
          `normalized-drift:shift ${drift.shift} ${drift.stage} (claimed within-declared-bounds, derived drifting via ${drift.mechanism} — ${driftDimensionsEvidenceOf(drift)} beyond tolerance ${window.driftTolerancePct}%)`,
        );
      } else if (
        claim.claimed === "within-declared-bounds" &&
        drift.classification === "regressing"
      ) {
        problems.push(
          `hidden-regression:shift ${drift.shift} ${drift.stage} (claimed within-declared-bounds, derived regressing — ${driftDimensionsEvidenceOf(drift)} beyond tolerance ${window.driftTolerancePct}%, no declared divergence)`,
        );
      } else if (
        claim.claimed === "drifting" &&
        drift.classification === "within-declared-bounds"
      ) {
        problems.push(
          `fabricated-drift:shift ${drift.shift} ${drift.stage} (claimed drifting, derived within-declared-bounds — the declared tolerance holds)`,
        );
      } else {
        problems.push(
          `misclassified-drift:shift ${drift.shift} ${drift.stage} (claimed ${claim.claimed}, derived ${drift.classification})`,
        );
      }
    }
    if (drift.classification === "drifting" && claim.mechanism !== drift.mechanism) {
      problems.push(
        `unnamed-drift-mechanism:shift ${drift.shift} ${drift.stage} (claimed mechanism ${
          claim.mechanism ?? "none"
        }, the declared divergence cause is ${drift.mechanism ?? "none"})`,
      );
    }
  }
  for (const claim of observation.claimedDrift) {
    if (!drifts.some((drift) => drift.shift === claim.shift && drift.stage === claim.stage)) {
      problems.push(
        `unobserved-claim:shift ${claim.shift} ${claim.stage} (a classification claimed over a segment the window never observed)`,
      );
    }
  }
  return {
    criterionId: "drift-classification-honesty",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 5 — FAILs `incident-honesty`: every incident in the window is
 * recorded AND attributed — the root-cause class comes from the IMPORTED
 * VAL-020 taxonomy (checked through its own membership predicate —
 * never free-text, never re-implemented) and the disposition honors the
 * class's retryability discipline. A HIDDEN incident (the timeline
 * holds the event — an unresolved attempt or a declared failure's
 * continuation — the log omits it) or an UNATTRIBUTED incident (no
 * class) FAILs NAMED; a taxonomy-foreign class FAILs NAMED.
 */
export function deriveIncidentHonesty(input: {
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { observation } = input;
  const evidence: string[] = [
    `incident-log:${observation.incidents.length} record(s)`,
    `incident-log-digest:${incidentLogDigestOf(observation.incidents)}`,
  ];
  const problems: string[] = [];
  const loggedAt = new Set(
    observation.incidents.map((record) => `${record.shift}:${record.stage}`),
  );
  for (const shift of observation.shifts) {
    for (const segment of shift.segments) {
      const unresolved = segment.attempts - segment.resolved;
      if (unresolved > 0 && !loggedAt.has(`${segment.shift}:${segment.stage}`)) {
        problems.push(
          `hidden-incident:shift ${segment.shift} ${segment.stage} (attempts=${segment.attempts}, resolved=${segment.resolved} — the timeline holds ${unresolved} unresolved attempt(s), the log omits the incident)`,
        );
      }
    }
  }
  for (const continuation of observation.continuations) {
    if (!loggedAt.has(`${continuation.shift}:${continuation.stage}`)) {
      problems.push(
        `hidden-incident:shift ${continuation.shift} ${continuation.stage} (the timeline holds the declared failure and its exactly-once resume, the log omits the incident)`,
      );
    }
  }
  for (const record of observation.incidents) {
    const attributionClass: string = record.attributionClass;
    if (!isKnownAttributionClass(attributionClass)) {
      evidence.push(
        `incident:shift ${record.shift} ${record.stage} (attribution ${
          attributionClass.length === 0 ? "none" : `${attributionClass}@taxonomy-foreign`
        }, magnitude ${record.magnitudeMicroUsd}microUsd, ${record.disposition.kind})`,
      );
      if (attributionClass.length === 0) {
        problems.push(
          `unattributed-incident:shift ${record.shift} ${record.stage} (no root-cause class — every incident is attributed through the imported VAL-020 taxonomy)`,
        );
      } else {
        problems.push(
          `taxonomy-foreign-attribution:shift ${record.shift} ${record.stage} (class ${attributionClass} is foreign to the imported VAL-020 taxonomy)`,
        );
      }
      continue;
    }
    evidence.push(incidentEvidenceOf(record));
    if (!dispositionIsValidFor(record.attributionClass, record.disposition.kind)) {
      problems.push(
        `invalid-disposition:shift ${record.shift} ${record.stage} (${attributionClass}@${layerOfAttributionClass(record.attributionClass)} carries ${record.disposition.kind} — a retryable class carries its bounded disposition, a non-retryable class its escalation or accepted-risk record)`,
      );
    }
    if (parseMicroUsd(record.magnitudeMicroUsd) === null) {
      problems.push(
        `malformed-incident-magnitude:shift ${record.shift} ${record.stage} (magnitude ${record.magnitudeMicroUsd} is not a carried microUsd cost)`,
      );
    }
  }
  return {
    criterionId: "incident-honesty",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 6 — FAILs `budget-policy-envelope` (window-wide): (a) every
 * declared reservation settles or releases by end-of-window (a dangling
 * reservation NAMED); (b) no unauthorized spend — every spend,
 * settlement and release line cites its authorizing reservation (one
 * opened BEFORE it — a refused id authorizes nothing), every spend sits
 * within its reservation and within the window budget, and every
 * observed shift's cost entered the ledger (an off-ledger or
 * over-budget spend NAMED with amount); the policy's per-shift latency
 * bound holds across the ENTIRE window; (c) the append-only ledger
 * holds — re-derived through `ledgerChainHolds` and `reservationsOf`
 * (never trusting the writer): an erased, rewritten or reordered line
 * breaks the digest chain at the NAMED ordinal.
 */
export function deriveBudgetPolicyEnvelopeIntegrity(input: {
  readonly policy: PilotBudgetPolicy;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { policy, observation } = input;
  const lines = observation.ledger;
  const basis = ledgerBasisDigestOf(policy);
  const evidence: string[] = [
    `cost-budget-microUsd:${policy.costBudgetMicroUsd}`,
    `latency-budget-ms-per-shift:${policy.latencyBudgetMsPerShift}`,
    `admission-policy:${policy.admissionPolicy}`,
    `ledger-lines:${lines.length}`,
    `ledger-basis:${basis}`,
  ];
  const problems: string[] = [];

  // (c) the append-only digest chain — re-derived, never trusted.
  const chain = ledgerChainHolds({ lines, basis });
  if (!chain.holds) {
    problems.push(
      `ledger-chain-broken:ordinal ${chain.breakOrdinal ?? lines.length + 1} (the append-only digest chain breaks here — an erased, rewritten or reordered line)`,
    );
  }

  // (a) every declared reservation settles or releases by end-of-window.
  const reservations = reservationsOf(lines);
  for (const reservation of reservations) {
    if (reservation.state === "held") {
      problems.push(
        `dangling-reservation:${reservation.reservationId} (shift ${reservation.shift}, ${reservation.amountMicroUsd}microUsd still held at end-of-window — every reservation settles or releases)`,
      );
    } else {
      evidence.push(
        `reservation:${reservation.reservationId} shift ${reservation.shift} ${reservation.amountMicroUsd}microUsd ${reservation.state}`,
      );
    }
  }

  // (b) every spend/settlement/release line cites its authorizing reservation.
  const opened = new Set<string>();
  const refused = new Set<string>();
  for (const line of lines) {
    if (line.kind === "reservation") {
      if (line.reservationId === null) {
        problems.push(
          `anonymous-reservation:ordinal ${line.ordinal} (a reservation line carries its own id — it authorizes nothing anonymous)`,
        );
      } else {
        opened.add(line.reservationId);
      }
    }
    if (line.kind === "refusal" && line.reservationId !== null) {
      refused.add(line.reservationId);
    }
    if (line.kind === "spend" || line.kind === "settlement" || line.kind === "release") {
      if (line.reservationId === null) {
        problems.push(
          `uncited-${line.kind}:ordinal ${line.ordinal} (amount ${line.amountMicroUsd}microUsd cites no authorizing reservation)`,
        );
      } else if (!opened.has(line.reservationId)) {
        problems.push(
          `unauthorized-${line.kind}:ordinal ${line.ordinal} (amount ${line.amountMicroUsd}microUsd cites reservation ${line.reservationId} never opened before it${
            refused.has(line.reservationId) ? " — the reservation was REFUSED" : ""
          })`,
        );
      }
    }
  }

  // (b) every spend sits within its reservation and within the window budget.
  const spentByReservation = new Map<string, bigint>();
  let totalSpent = 0n;
  for (const line of lines) {
    if (line.kind !== "spend" || line.reservationId === null) {
      continue;
    }
    const amount = parseMicroUsd(line.amountMicroUsd);
    if (amount === null) {
      problems.push(
        `malformed-ledger-amount:ordinal ${line.ordinal} (${line.amountMicroUsd} is not a microUsd amount)`,
      );
      continue;
    }
    spentByReservation.set(
      line.reservationId,
      (spentByReservation.get(line.reservationId) ?? 0n) + amount,
    );
    totalSpent += amount;
  }
  for (const [reservationId, spent] of spentByReservation) {
    const reservation =
      reservations.find((candidate) => candidate.reservationId === reservationId) ?? null;
    const reservedAmount = reservation === null ? null : parseMicroUsd(reservation.amountMicroUsd);
    if (reservation !== null && reservedAmount !== null && spent > reservedAmount) {
      problems.push(
        `reservation-escaping-spend:${reservationId} (spent ${spent.toString()}microUsd over the reserved ${reservation.amountMicroUsd}microUsd)`,
      );
    }
  }
  const budget = parseMicroUsd(policy.costBudgetMicroUsd);
  if (budget !== null && totalSpent > budget) {
    problems.push(
      `over-budget-spend:${totalSpent.toString()}microUsd spent over the window budget ${policy.costBudgetMicroUsd}microUsd (over by ${(totalSpent - budget).toString()}microUsd)`,
    );
  }
  evidence.push(`total-spent-microUsd:${totalSpent.toString()}`);

  // (b) no off-ledger spend: every observed shift's cost entered the ledger.
  for (const shift of observation.shifts) {
    const reservedForShift = lines.some(
      (line) => line.kind === "reservation" && line.shift === shift.shift,
    );
    if (!reservedForShift) {
      problems.push(
        `off-ledger-spend:shift ${shift.shift} (observed cost ${shift.reportedCostMicroUsd}microUsd with no reservation ever opened for the shift — the window envelope never authorized it)`,
      );
    }
  }

  // the policy's per-shift latency bound holds across the entire window.
  for (const shift of observation.shifts) {
    if (shift.reportedLatencyMs > policy.latencyBudgetMsPerShift) {
      problems.push(
        `latency-budget-breach:shift ${shift.shift} (reported ${shift.reportedLatencyMs}ms over the policy bound ${policy.latencyBudgetMsPerShift}ms)`,
      );
    }
  }
  return {
    criterionId: "budget-policy-envelope",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 7 — FAILs `end-of-window-reconciliation`: the window's
 * accounting reconciles STAGE-FOR-STAGE (each observed stage's economics
 * equal its declared recorded economics — digest-anchored through the
 * stage economics' `basisDigest` — the within-tolerance residuals
 * explained by the window's own declared tolerance, the declared
 * divergences carried as the honest deltas, both sides NAMED) and
 * SHIFT-FOR-SHIFT (each shift's stage sum equals its recorded shift
 * total; the window total equals Σ shifts; the reported total equals the
 * observed total). An unexplained pilot-level residual FAILs with the
 * exact amount NAMED — both sides named; wherever a probe corrupts the
 * accounting, this criterion co-FAILs.
 */
export function deriveEndOfWindowReconciliation(input: {
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { window, schedule, observation } = input;
  const evidence: string[] = [
    `drift-tolerance-pct:${window.driftTolerancePct}`,
    `scheduled-shifts:${schedule.shifts.length}`,
    `observed-shifts:${observation.shifts.length}`,
  ];
  const problems: string[] = [];
  let unexplainedResidual = false;
  const observedShiftByOrdinal = new Map<number, ObservedShiftRecord>();
  for (const observed of observation.shifts) {
    observedShiftByOrdinal.set(observed.shift, observed);
  }

  // STAGE-FOR-STAGE: the observed stage economics vs the declared
  // recorded economics (digest-anchored), the declared divergences
  // carried as the honest deltas.
  for (const scheduledShift of schedule.shifts) {
    const observedShift = observedShiftByOrdinal.get(scheduledShift.shift);
    if (observedShift === undefined) {
      unexplainedResidual = true;
      problems.push(
        `missing-shift-basis:shift ${scheduledShift.shift} (recorded basis ${shiftCostBasisOf(scheduledShift)}microUsd never observed — the window's accounting is short and the residual is unexplained)`,
      );
      continue;
    }
    for (const segment of scheduledShift.segments) {
      const observedSegment = observedShift.segments.find(
        (candidate) => candidate.stage === segment.stage,
      );
      if (observedSegment === undefined) {
        continue;
      }
      const declared =
        window.declaredDivergences.find(
          (divergence) =>
            divergence.shift === scheduledShift.shift && divergence.stage === segment.stage,
        ) ?? null;
      if (observedSegment.basisDigest !== segment.economics.basisDigest) {
        unexplainedResidual = true;
        problems.push(
          `basis-anchor-divergence:shift ${scheduledShift.shift} ${segment.stage} (observed anchor ${observedSegment.basisDigest}, recorded anchor ${segment.economics.basisDigest} — the observation is not over the declared recorded basis)`,
        );
      }
      const observedCost = parseMicroUsd(observedSegment.costMicroUsd);
      const recordedCost = parseMicroUsd(segment.economics.costMicroUsd);
      if (observedCost === null) {
        unexplainedResidual = true;
        problems.push(
          `malformed-observed-cost:shift ${scheduledShift.shift} ${segment.stage} (${observedSegment.costMicroUsd} is not a microUsd amount)`,
        );
      } else if (recordedCost !== null && observedCost !== recordedCost) {
        const residual = observedCost - recordedCost;
        const driftPct = costDriftPctOf(
          observedSegment.costMicroUsd,
          segment.economics.costMicroUsd,
        );
        if (driftPct <= window.driftTolerancePct) {
          evidence.push(
            `stage-residual:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.costMicroUsd}microUsd, recorded ${segment.economics.costMicroUsd}microUsd, residual ${residual.toString()}microUsd — within the declared tolerance ${window.driftTolerancePct}%)`,
          );
        } else if (declared !== null) {
          evidence.push(
            `declared-delta:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.costMicroUsd}microUsd, recorded ${segment.economics.costMicroUsd}microUsd, delta ${residual.toString()}microUsd via ${declared.cause} — the declared divergence carried as the honest delta)`,
          );
        } else {
          unexplainedResidual = true;
          problems.push(
            `unexplained-stage-residual:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.costMicroUsd}microUsd, recorded ${segment.economics.costMicroUsd}microUsd, residual ${residual.toString()}microUsd beyond the declared tolerance ${window.driftTolerancePct}% with no declared divergence — both sides named)`,
          );
        }
      }
      const latencyResidual = observedSegment.latencyMs - segment.economics.latencyMs;
      if (latencyResidual !== 0) {
        const latencyDriftPct = latencyDriftPctOf(
          observedSegment.latencyMs,
          segment.economics.latencyMs,
        );
        if (latencyDriftPct <= window.driftTolerancePct) {
          evidence.push(
            `stage-latency-residual:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.latencyMs}ms, recorded ${segment.economics.latencyMs}ms, residual ${latencyResidual}ms — within the declared tolerance ${window.driftTolerancePct}%)`,
          );
        } else if (declared !== null) {
          evidence.push(
            `declared-latency-delta:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.latencyMs}ms, recorded ${segment.economics.latencyMs}ms, delta ${latencyResidual}ms via ${declared.cause} — the declared divergence carried as the honest delta)`,
          );
        } else {
          unexplainedResidual = true;
          problems.push(
            `unexplained-stage-latency-residual:shift ${scheduledShift.shift} ${segment.stage} (observed ${observedSegment.latencyMs}ms, recorded ${segment.economics.latencyMs}ms, residual ${latencyResidual}ms beyond the declared tolerance ${window.driftTolerancePct}% with no declared divergence — both sides named)`,
          );
        }
      }
    }
  }

  // off-basis observed segments: an observed cost with no recorded side.
  for (const observedShift of observation.shifts) {
    const scheduledShift =
      schedule.shifts.find((candidate) => candidate.shift === observedShift.shift) ?? null;
    for (const observedSegment of observedShift.segments) {
      const hasBasis =
        scheduledShift?.segments.some((segment) => segment.stage === observedSegment.stage) ??
        false;
      if (!hasBasis) {
        unexplainedResidual = true;
        problems.push(
          `off-basis-segment:shift ${observedShift.shift} ${observedSegment.stage} (observed ${observedSegment.costMicroUsd}microUsd with no recorded basis — an unexplained residual)`,
        );
      }
    }
  }

  // SHIFT-FOR-SHIFT: each shift's stage sum equals its recorded shift total.
  let observedStageTotal = 0n;
  for (const observedShift of observation.shifts) {
    const stageCost = observedShift.segments.reduce(
      (total, segment) => total + (parseMicroUsd(segment.costMicroUsd) ?? 0n),
      0n,
    );
    observedStageTotal += stageCost;
    const reportedCost = parseMicroUsd(observedShift.reportedCostMicroUsd);
    if (reportedCost === null) {
      unexplainedResidual = true;
      problems.push(
        `malformed-shift-total:shift ${observedShift.shift} (${observedShift.reportedCostMicroUsd} is not a microUsd amount)`,
      );
    } else if (stageCost !== reportedCost) {
      problems.push(
        `shift-total-residual:shift ${observedShift.shift} (stage sum ${stageCost.toString()}microUsd, recorded shift total ${observedShift.reportedCostMicroUsd}microUsd, residual ${(stageCost - reportedCost).toString()}microUsd — both sides named)`,
      );
    }
    const stageLatency = observedShift.segments.reduce(
      (total, segment) => total + segment.latencyMs,
      0,
    );
    if (stageLatency !== observedShift.reportedLatencyMs) {
      problems.push(
        `shift-latency-residual:shift ${observedShift.shift} (stage sum ${stageLatency}ms, recorded shift total ${observedShift.reportedLatencyMs}ms, residual ${stageLatency - observedShift.reportedLatencyMs}ms — both sides named)`,
      );
    }
  }

  // the window total equals Σ shifts; the reported total equals the observed total.
  const shiftTotals = observation.shifts.reduce(
    (total, shift) => total + (parseMicroUsd(shift.reportedCostMicroUsd) ?? 0n),
    0n,
  );
  const reportedWindowCost = parseMicroUsd(observation.reported.totalCostMicroUsd);
  if (reportedWindowCost === null) {
    unexplainedResidual = true;
    problems.push(
      `malformed-window-total:${observation.reported.totalCostMicroUsd} (not a microUsd amount)`,
    );
  } else if (reportedWindowCost !== shiftTotals) {
    problems.push(
      `window-total-residual:reported ${observation.reported.totalCostMicroUsd}microUsd, observed Σ shifts ${shiftTotals.toString()}microUsd, residual ${(reportedWindowCost - shiftTotals).toString()}microUsd — both sides named)`,
    );
  }
  const shiftLatencies = observation.shifts.reduce(
    (total, shift) => total + shift.reportedLatencyMs,
    0,
  );
  if (shiftLatencies !== observation.reported.totalLatencyMs) {
    problems.push(
      `window-latency-residual:reported ${observation.reported.totalLatencyMs}ms, observed Σ shifts ${shiftLatencies}ms, residual ${observation.reported.totalLatencyMs - shiftLatencies}ms — both sides named)`,
    );
  }

  // the pilot-level residual: the observed window cost vs Σ recorded shift bases.
  const recordedBasisTotal = schedule.shifts.reduce(
    (total, shift) => total + (parseMicroUsd(shiftCostBasisOf(shift)) ?? 0n),
    0n,
  );
  const pilotResidual = observedStageTotal - recordedBasisTotal;
  if (unexplainedResidual) {
    problems.push(
      `pilot-level-residual:observed ${observedStageTotal.toString()}microUsd vs recorded basis ${recordedBasisTotal.toString()}microUsd (residual ${pilotResidual.toString()}microUsd — UNEXPLAINED, the exact amount named, both sides named)`,
    );
  } else {
    evidence.push(
      `pilot-level-residual:observed ${observedStageTotal.toString()}microUsd vs recorded basis ${recordedBasisTotal.toString()}microUsd (residual ${pilotResidual.toString()}microUsd — explained: the within-tolerance residuals and declared deltas carried above)`,
    );
  }
  return {
    criterionId: "end-of-window-reconciliation",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

/**
 * ORACLE 8 — FAILs `customer-boundary-integrity`: every stage of every
 * shift executes under `PILOT_CUSTOMER_APPLICATION_ID` across the ENTIRE
 * window — a foreign identity is NAMED with the leaking shift, stage
 * and identity (a cross-tenant leak, never silently normalized).
 */
export function deriveCustomerBoundaryIntegrity(input: {
  readonly observation: PilotWindowObservation;
}): LabVerificationCriterion {
  const { observation } = input;
  const segmentCount = observation.shifts.reduce(
    (total, shift) => total + shift.segments.length,
    0,
  );
  const evidence: string[] = [
    `pilot-application:${PILOT_CUSTOMER_APPLICATION_ID}`,
    `observed-segments:${segmentCount}`,
  ];
  const problems: string[] = [];
  for (const shift of observation.shifts) {
    for (const segment of shift.segments) {
      if (segment.applicationId !== PILOT_CUSTOMER_APPLICATION_ID) {
        problems.push(
          `foreign-application:shift ${segment.shift} ${segment.stage} (executed under ${segment.applicationId}, not ${PILOT_CUSTOMER_APPLICATION_ID} — a cross-tenant leak across the window)`,
        );
      }
    }
  }
  if (problems.length === 0 && segmentCount > 0) {
    evidence.push(
      `boundary-held:every stage of every shift of the window under ${PILOT_CUSTOMER_APPLICATION_ID}`,
    );
  }
  return {
    criterionId: "customer-boundary-integrity",
    strategy: "deterministic",
    status: problems.length === 0 ? "PASS" : "FAIL",
    evidence: [...evidence, ...problems],
  };
}

// ---------------------------------------------------------------------------
// The row driver (the 8-criteria synthesis — the 049/050 shape)
// ---------------------------------------------------------------------------

/**
 * One driven pilot row's mechanical result: the terminal verdict over
 * the EIGHT settled criteria (the issued AC4 order), the FAILing
 * criteria NAMED, and the row's own digest pins (recomputed, never
 * trusted). A row that honestly never ran carries `notRun` with the
 * reason NAMED (the env var) — never a fake success.
 */
export interface PilotRowResult {
  readonly rowId: string;
  /** The mechanical terminal (never a narrative rescue). */
  readonly terminal: PilotVerdictKind;
  /** The eight settled criteria (one honest live-gate criterion when NOT-RUN). */
  readonly criteria: readonly LabVerificationCriterion[];
  /** The FAILing criteria's ids (empty when PILOT-COMPLETED or NOT-RUN). */
  readonly failedCriteria: readonly string[];
  /** Whether the row honestly never ran (the live gate closed). */
  readonly notRun: boolean;
  /** The NOT-RUN reason (the env var NAMED; null when the row ran). */
  readonly reason: string | null;
  /** The declared window's FNV-1a pin (recomputed via `pilotWindowDigestOf`). */
  readonly windowDigest: string;
  /** The schedule's FNV-1a pin (recomputed via `scheduleDigestOf`). */
  readonly scheduleDigest: string;
}

/**
 * Drive one pilot row to its mechanical terminal (PURE — the 8-criteria
 * synthesis over the observation lane's record, the issued AC4 order):
 * all eight criteria PASS → PILOT-COMPLETED (the honest drifting
 * classifications complete with their finding NAMED in the criteria's
 * own evidence); any criterion FAIL → PILOT-FAILED with the FAILing
 * criteria NAMED; no observation at all → NOT-RUN (the honest boundary —
 * the env var named, never a fake success).
 */
export function drivePilotRow(input: {
  readonly rowId: string;
  readonly window: PilotWindow;
  readonly schedule: ShiftSchedule;
  readonly policy: PilotBudgetPolicy;
  /**
   * The observation lane's record (null when the row honestly never ran
   * — the live gate closed without its credential).
   */
  readonly observation: PilotWindowObservation | null;
  /** The row's live gate (the env vars named when the row never ran). */
  readonly liveGate?: { readonly envVars: readonly string[] };
}): PilotRowResult {
  const windowDigest = pilotWindowDigestOf(input.window);
  const scheduleDigest = scheduleDigestOf({ shifts: input.schedule.shifts });
  if (input.observation === null) {
    const envVars = input.liveGate?.envVars ?? [];
    const gate = envVars.length > 0 ? envVars.join(",") : "none";
    return {
      rowId: input.rowId,
      terminal: "NOT-RUN",
      criteria: [
        {
          criterionId: "live-gate-honesty",
          strategy: "deterministic",
          status: "PASS",
          evidence: [
            `gate:${gate}`,
            `window-digest:${windowDigest}`,
            `schedule-digest:${scheduleDigest}`,
            `plan-digest:${livePilotPlanDigestOf()}`,
            "NOT RUN (the live pilot slice demands the operator credential — honestly not run, never fabricated)",
          ],
        },
      ],
      failedCriteria: [],
      notRun: true,
      reason:
        envVars.length > 0
          ? `live gate closed (${gate} absent — the live pilot slice honestly NOT RUN, never a fake success)`
          : "no observation recorded (the row never ran — honestly NOT RUN, never a fake success)",
      windowDigest,
      scheduleDigest,
    };
  }
  const observation = input.observation;
  const criteria: readonly LabVerificationCriterion[] = [
    deriveWindowHonesty({ window: input.window, schedule: input.schedule, observation }),
    deriveScheduleCompleteness({ schedule: input.schedule, observation }),
    deriveContinuationExactlyOnce({ schedule: input.schedule, observation }),
    deriveDriftClassificationHonesty({
      window: input.window,
      schedule: input.schedule,
      observation,
    }),
    deriveIncidentHonesty({ observation }),
    deriveBudgetPolicyEnvelopeIntegrity({ policy: input.policy, observation }),
    deriveEndOfWindowReconciliation({
      window: input.window,
      schedule: input.schedule,
      observation,
    }),
    deriveCustomerBoundaryIntegrity({ observation }),
  ];
  const failedCriteria = criteria
    .filter((criterion) => criterion.status === "FAIL")
    .map((criterion) => criterion.criterionId);
  return {
    rowId: input.rowId,
    terminal: failedCriteria.length === 0 ? "PILOT-COMPLETED" : "PILOT-FAILED",
    criteria,
    failedCriteria,
    notRun: false,
    reason: null,
    windowDigest,
    scheduleDigest,
  };
}

// ---------------------------------------------------------------------------
// The live pilot plan (env-gated, OPENROUTER_API_KEY — the sustained live window)
// ---------------------------------------------------------------------------

/** The live pilot slice's workload class (the measured lane's declaration reference). */
export const LIVE_PILOT_WORKLOAD_CLASS = "live-pilot-sustained-window";

/**
 * The pinned live pilot plan (frozen, `livePilotPlanDigestOf`-pinned):
 * the declared live window = 3 shifts × 2 REAL dispatches — 6 live
 * dispatches SUSTAINED across the window (never a burst) at 1500ms on /
 * 500ms off pacing between dispatches; the ONE pinned rail (the house
 * live posture of VAL-025/048/049/050); every dispatch recorded through
 * the REAL recorder (`createRealAccountingRails`) with honest measured
 * economics; the recorded basis = the journey row's stage economics,
 * digest-verified at run time. Without `OPENROUTER_API_KEY` the live
 * row is honestly NOT RUN — never a fake success.
 */
export const LIVE_PILOT_PLAN = Object.freeze({
  /** The workload class the live pilot slice drives. */
  workloadClass: LIVE_PILOT_WORKLOAD_CLASS,
  /** The declared live window's shifts. */
  shifts: 3,
  /** The REAL dispatches per shift (sustained load across the window — never a burst). */
  dispatchesPerShift: 2,
  /** The total REAL dispatches sustained across the declared live window (3 × 2). */
  liveDispatches: 6,
  /** The pacing between dispatches (ms on / ms off). */
  pacing: Object.freeze({ onMs: 1500, offMs: 500 }),
  /** The ONE pinned rail the live dispatches ride. */
  rail: Object.freeze({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    priceRevision: "rev-001",
    maxTokens: 32,
    temperature: "unset (the provider's documented default — nothing rides the request)",
  }),
  /** The credential gate (the honest NOT RUN boundary without it). */
  envVar: "OPENROUTER_API_KEY",
  /** The recorder every live dispatch is recorded through (the REAL recorder). */
  recorder: "createRealAccountingRails (the REAL recorder — never a fake ledger)",
  /** The recorded basis the measured economics are honestly classified against. */
  recordedBasis: "the journey row's stage economics (digest-verified at run time)",
});

/**
 * The live pilot plan's declaration digest (PURE — FNV-1a over the
 * frozen plan; deterministic whether or not the gate ever opens — the
 * gate-closed invariant's own pin).
 */
export function livePilotPlanDigestOf(): string {
  return economicDigestOf({
    liveWorkloadClass: LIVE_PILOT_WORKLOAD_CLASS,
    shifts: LIVE_PILOT_PLAN.shifts,
    dispatchesPerShift: LIVE_PILOT_PLAN.dispatchesPerShift,
    liveDispatches: LIVE_PILOT_PLAN.liveDispatches,
    pacing: LIVE_PILOT_PLAN.pacing,
    rail: LIVE_PILOT_PLAN.rail,
    envVar: LIVE_PILOT_PLAN.envVar,
    recorder: LIVE_PILOT_PLAN.recorder,
    recordedBasis: LIVE_PILOT_PLAN.recordedBasis,
  });
}
