/**
 * The production-pilot corpus (VAL-051, AC1): the declared rows of the
 * PRODUCTION-STYLE PILOT WITH SUSTAINED OBSERVATION — a declared
 * observation window over the RECORDED application portfolio and the
 * end-to-end customer journey (VAL-050), driven through the REAL
 * platform path under production-style operating discipline: a
 * declared schedule of shifts, budgets and policies enforced for the
 * whole window, incidents handled through the recorded
 * failure/continuation machinery (a resumed shift continues exactly
 * once — never dropped, never double-driven) and the customer
 * boundary respected across the entire window.
 *
 * Per row (the work order's AC1) the corpus declares:
 *
 *   * the PILOT SHAPE — the observation window (its first and last
 *     scheduled shift), the SCHEDULE OF SHIFTS and, per shift, the
 *     RECORDED INPUT DIGESTS the shift's workload composes (content
 *     digests into the VAL-050 digest-chained journey — whose own
 *     stages carry the VAL-049 audited economics — digests only,
 *     never payload bytes, never a copy of a recorded result; the
 *     shifts REPLAY recorded workloads, so the pilot's observations
 *     are pure derivations over the RECORDED basis, never a
 *     re-measurement and never a re-pricing);
 *   * the OPERATING DISCIPLINE — the window's budget and policy
 *     envelope (per-shift reservations and latency policy, the
 *     window's drift bands and quality floor), the declared
 *     incidents (the recorded failure/continuation machinery) and
 *     the declared observed drift (the deterministic deviation the
 *     fixture world observes — honestly classified, never silently
 *     normalized);
 *   * the OBSERVATION FAMILY under test (the mechanical
 *     verification core: window honesty / schedule completeness /
 *     continuation exactly-once / drift-classification honesty /
 *     incident honesty / budget-policy envelope integrity /
 *     end-of-window accounting reconciliation / customer-boundary
 *     integrity) and the EXPECTED VERDICT (PILOT-COMPLETED /
 *     PILOT-FAILED with the failed criteria NAMED / NOT-RUN with the
 *     env var named).
 *
 * The seven adversarial probe rows (a cherry-picked window, a dropped
 * shift, a double-driven resume, a normalized drift, a hidden
 * incident, a hidden residual, a boundary leak) each FAIL their named
 * criteria; the ONE live row is env-gated on the operator-authorized
 * rail and is honestly NOT RUN without the credential.
 */

import { journeyRowById } from "../customer-journey/corpus";
import { auditRowById } from "../economic-audit/corpus";
import { economicDigestOf } from "../economic-baseline/driver";

/** The task kind every pilot submission carries (the app's task vocabulary). */
export const PRODUCTION_PILOT_TASK_KIND = "production-pilot.observation.v1";

/** The corpus version (the pinned vocabulary of record). */
export const PRODUCTION_PILOT_CORPUS_VERSION = "val-051-production-pilot-v1";

/**
 * The pilot's customer identity — the application identity every
 * shift of every honest pilot window executes under (the
 * customer-boundary oracle's pinned basis; a shift executing under
 * any other identity is a cross-tenant leak and FAILs named).
 */
export const PILOT_CUSTOMER_APPLICATION_ID = "app-pilot-customer";

// ---------------------------------------------------------------------------
// The vocabulary (the shift workloads + the observation families + the probes)
// ---------------------------------------------------------------------------

/**
 * The recorded workload one shift replays — the VAL-050 journey
 * stage whose recorded input digests and audited economics the
 * shift composes (the digest-chained basis of record).
 */
export type PilotWorkloadKind = "onboarding" | "intent" | "plan" | "daily-usage" | "outcome";

/** The shift workloads in canonical schedule order. */
export const PILOT_WORKLOADS: readonly PilotWorkloadKind[] = Object.freeze([
  "onboarding",
  "intent",
  "plan",
  "daily-usage",
  "outcome",
]);

/** The mechanical observation families (the verification core — all eight). */
export type PilotObservationFamily =
  | "window-honesty"
  | "schedule-completeness"
  | "continuation-exactly-once"
  | "drift-classification-honesty"
  | "incident-honesty"
  | "budget-policy-envelope"
  | "end-of-window-accounting"
  | "customer-boundary";

/** The declared observation-family vocabulary. */
export const PILOT_OBSERVATION_FAMILIES: readonly PilotObservationFamily[] = Object.freeze([
  "window-honesty",
  "schedule-completeness",
  "continuation-exactly-once",
  "drift-classification-honesty",
  "incident-honesty",
  "budget-policy-envelope",
  "end-of-window-accounting",
  "customer-boundary",
]);

/** The adversarial pilot-probe vocabulary (each FAILs its named criteria). */
export type PilotProbeKind =
  | "window-cherry-picking"
  | "dropped-shift"
  | "double-driven-resume"
  | "drift-normalizing"
  | "incident-hiding"
  | "residual-hiding"
  | "boundary-leak";

/** The NAMED mechanism per probe (the exact catch the oracle must cite). */
export const PROBE_MECHANISM_OF: Readonly<Record<PilotProbeKind, string>> = Object.freeze({
  "window-cherry-picking":
    "window-honesty:omitted-segment (the observation window cherry-picks a sub-window — the last scheduled shift is silently omitted)",
  "dropped-shift":
    "schedule-completeness:missing-shift (a scheduled shift silently dropped from the window)",
  "double-driven-resume":
    "continuation-exactly-once:duplicated-resume (the declared incident's shift resumed twice — never exactly once)",
  "drift-normalizing":
    "drift-classification-honesty:normalized-drift (a beyond-band drift silently classified within-bounds with its delta normalized away)",
  "incident-hiding":
    "incident-honesty:hidden-incident (the resumed shift's incident never recorded in the window's incident log)",
  "residual-hiding":
    "end-of-window-accounting:hidden-residual (the reported window total hides part of the observed spend)",
  "boundary-leak":
    "customer-boundary:foreign-application (a shift executed under another customer's application identity)",
});

/**
 * The named criteria each probe row must FAIL (the expected failure
 * surface, pinned so the corpus, the driver and the tests share ONE
 * vocabulary).
 */
export const PROBE_FAILED_CRITERIA_OF: Readonly<Record<PilotProbeKind, readonly string[]>> =
  Object.freeze({
    "window-cherry-picking": ["window-honesty", "end-of-window-accounting"],
    "dropped-shift": ["schedule-completeness", "end-of-window-accounting"],
    "double-driven-resume": [
      "continuation-exactly-once",
      "end-of-window-accounting",
      "budget-policy-envelope",
    ],
    "drift-normalizing": ["drift-classification-honesty", "end-of-window-accounting"],
    "incident-hiding": ["incident-honesty"],
    "residual-hiding": ["end-of-window-accounting"],
    "boundary-leak": ["customer-boundary"],
  });

// ---------------------------------------------------------------------------
// The recorded basis (the VAL-049 audited economics over the VAL-050
// digest-chained journey — imported, never rewritten)
// ---------------------------------------------------------------------------

/** The drift-classification vocabulary (never a narrative). */
export type DriftClassificationKind = "within-bounds" | "drifting" | "regressing";

/**
 * The window's declared drift bands (the operating policy the honest
 * classification derives from): a segment whose observed economics
 * stay within the bands is WITHIN BOUNDS, a cost/latency deviation
 * beyond the bands is DRIFTING (a mechanism must be named), and a
 * segment whose observed quality falls below the floor is REGRESSING
 * (a mechanism must be named) — never silently normalized away.
 */
export const DRIFT_BANDS: Readonly<{
  readonly costMicroUsd: string;
  readonly latencyMs: number;
  readonly qualityFloor: number;
}> = Object.freeze({ costMicroUsd: "480", latencyMs: 48, qualityFloor: 0.9 });

/** The recorded quality of one shift's recorded workload (the quality basis). */
export const RECORDED_SEGMENT_QUALITY = 0.98;

/** The recorded journey row the pilot window's shifts replay (the chained basis). */
const JOURNEY_BASIS_ROW = journeyRowById("full-journey-recorded-portfolio");

/** The recorded continuation row the declared incident's shift carries economics from. */
const JOURNEY_CONTINUATION_ROW = journeyRowById("journey-continuation-resume");

if (JOURNEY_BASIS_ROW === null || JOURNEY_CONTINUATION_ROW === null) {
  throw new Error("the VAL-050 digest-chained journey basis is not resolvable");
}

/**
 * The recorded basis slice of one workload (the VAL-050 journey
 * stage's recorded input digests and its carried VAL-049 audited
 * economics — imported, never re-priced).
 */
interface RecordedBasisSlice {
  readonly workload: PilotWorkloadKind;
  readonly recordedInputDigests: readonly string[];
  readonly economics: {
    readonly costMicroUsd: string;
    readonly latencyMs: number;
    readonly basisAuditRowId: string;
    readonly basisDigest: string;
  };
}

/** The recorded basis slices the pilot's shifts replay (digest-chained). */
const RECORDED_BASIS: Readonly<Record<PilotWorkloadKind, RecordedBasisSlice>> = Object.freeze(
  Object.fromEntries(
    PILOT_WORKLOADS.map((workload) => {
      const stage = JOURNEY_BASIS_ROW?.stages.find((entry) => entry.stage === workload);
      if (stage === undefined) {
        throw new Error(`the VAL-050 journey basis holds no ${workload} stage`);
      }
      return [
        workload,
        {
          workload,
          recordedInputDigests: stage.recordedInputDigests,
          economics: stage.economics,
        },
      ];
    }),
  ) as Readonly<Record<PilotWorkloadKind, RecordedBasisSlice>>,
);

// ---------------------------------------------------------------------------
// The row shape (the pilot shape + the operating discipline + the verdict)
// ---------------------------------------------------------------------------

/** One scheduled shift's declaration (the schedule of shifts). */
export interface ShiftDeclaration {
  /** The shift's ordinal in the window's schedule (1-based). */
  readonly shiftIndex: number;
  readonly shiftId: string;
  /** The recorded workload the shift replays (the chained basis). */
  readonly workload: PilotWorkloadKind;
  /** The recorded input digests the shift's workload composes (digest references only). */
  readonly recordedInputDigests: readonly string[];
  /** The shift's recorded economics (the carried VAL-049 cost basis). */
  readonly economics: {
    readonly costMicroUsd: string;
    readonly latencyMs: number;
    readonly basisAuditRowId: string;
    readonly basisDigest: string;
  };
  /** The shift's budget reservation (the envelope; settles at end of window). */
  readonly reservationMicroUsd: string;
  /** The shift's latency policy (the envelope: observed latency must stay within). */
  readonly maxLatencyMs: number;
}

/** A declared incident (the recorded failure/continuation machinery). */
export interface IncidentDeclaration {
  readonly shiftIndex: number;
  /** The recorded failure mechanism the incident is attributed to. */
  readonly mechanism: string;
  readonly detail: string;
}

/** The window's declared observed drift (the deterministic deviation the world observes). */
export interface DriftDeclaration {
  readonly shiftIndex: number;
  readonly costDeltaMicroUsd: string;
  readonly latencyDeltaMs: number;
  readonly qualityDelta: number;
  /** The mechanism a drifting/regressing classification must name (null within bounds). */
  readonly mechanism: string | null;
}

/** The expected verdict vocabulary (never a narrative). */
export type PilotVerdictKind = "PILOT-COMPLETED" | "PILOT-FAILED" | "NOT-RUN";

/** One declared pilot corpus row. */
export interface ProductionPilotCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The observation window (first and last scheduled shift). */
  readonly window: { readonly startShift: number; readonly endShift: number };
  /** The schedule of shifts (the recorded workloads the window replays). */
  readonly schedule: readonly ShiftDeclaration[];
  /** The observation families the row's verification drives (the oracle slice). */
  readonly observationFamilies: readonly PilotObservationFamily[];
  /** The window's budget (the whole-window spend envelope). */
  readonly budgetMicroUsd: string;
  /** The declared incidents (the recorded failure/continuation machinery). */
  readonly incidents: readonly IncidentDeclaration[];
  /** The declared observed drift (honestly classified, never normalized). */
  readonly declaredDrift: readonly DriftDeclaration[];
  readonly expected: {
    readonly verdict: PilotVerdictKind;
    /** The criteria a PILOT-FAILED verdict must NAME (empty otherwise). */
    readonly failedCriteria: readonly string[];
    readonly terminal: "COMPLETED" | "FAILED";
  };
  readonly probe?: { readonly kind: PilotProbeKind };
  readonly needsDispatch: boolean;
  readonly liveGate?: { readonly envVars: readonly ["OPENROUTER_API_KEY"] };
}

/** The shift id convention (one id per scheduled shift). */
export function shiftIdOf(shiftIndex: number): string {
  return `shift-${shiftIndex}`;
}

/**
 * Build one pilot row: the schedule of shifts over the recorded
 * basis (each shift's recorded input digests and carried economics
 * imported from the VAL-050 chained journey — the declared
 * incident's shift carries the RECORDED continuation economics, the
 * failed attempt plus exactly one resume, honestly), the operating
 * discipline (reservations, latency policy, the window budget) and
 * the expected verdict derived HONESTLY (the pure oracle —
 * PILOT-COMPLETED for the honest rows, PILOT-FAILED with the failed
 * criteria NAMED for the adversarial probe rows, an honest NOT-RUN
 * for the env-gated live row).
 */
function pilotRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly incidentAtShift?: number;
  readonly drift?: DriftDeclaration;
  /** Reserve 10% headroom per shift (the released remainder is NAMED at end of window). */
  readonly headroom?: boolean;
  readonly probe?: { readonly kind: PilotProbeKind };
  readonly live?: boolean;
}): ProductionPilotCorpusRow {
  if (input.live === true && input.probe !== undefined) {
    throw new Error("a live row never carries an adversarial probe");
  }
  if (input.drift !== undefined && input.incidentAtShift === input.drift.shiftIndex) {
    throw new Error(
      "a drifting shift never carries the window's incident (one discipline per row)",
    );
  }
  const incidentAt = input.incidentAtShift ?? null;
  const schedule: ShiftDeclaration[] = PILOT_WORKLOADS.map((workload, index) => {
    const shiftIndex = index + 1;
    // The declared incident's shift carries the RECORDED continuation
    // economics (the failed attempt plus exactly one resume); every
    // other shift carries the recorded single-drive economics.
    const economics =
      incidentAt === shiftIndex
        ? (JOURNEY_CONTINUATION_ROW?.stages.find((entry) => entry.stage === workload)?.economics ??
          null)
        : RECORDED_BASIS[workload].economics;
    if (economics === null) {
      throw new Error(`the VAL-050 continuation basis holds no ${workload} stage`);
    }
    const cost = BigInt(economics.costMicroUsd);
    // The reservation covers the shift's recorded work PLUS its
    // declared observed drift (the envelope must never be breached by
    // an honestly classified deviation), with the optional headroom
    // (the released remainder NAMED at end of window).
    const driftDelta =
      input.drift !== undefined && input.drift.shiftIndex === shiftIndex
        ? BigInt(input.drift.costDeltaMicroUsd)
        : 0n;
    const reservation = (input.headroom === true ? cost + cost / 10n : cost) + driftDelta;
    return {
      shiftIndex,
      shiftId: shiftIdOf(shiftIndex),
      workload,
      recordedInputDigests: RECORDED_BASIS[workload].recordedInputDigests,
      economics,
      reservationMicroUsd: reservation.toString(),
      maxLatencyMs: economics.latencyMs * 2,
    };
  });
  const incidents: IncidentDeclaration[] =
    incidentAt === null
      ? []
      : [
          {
            shiftIndex: incidentAt,
            mechanism: "recorded-failure-machinery",
            detail: "substrate-timeout-resumed-exactly-once",
          },
        ];
  const declaredDrift: DriftDeclaration[] = input.drift === undefined ? [] : [input.drift];
  // The window budget: the whole-window spend envelope (the total of
  // the per-shift reservations — the budget the envelope oracle pins).
  const budget = schedule.reduce((total, shift) => total + BigInt(shift.reservationMicroUsd), 0n);
  const expected = input.live
    ? {
        verdict: "NOT-RUN" as const,
        failedCriteria: [] as readonly string[],
        terminal: "COMPLETED" as const,
      }
    : input.probe === undefined
      ? {
          verdict: "PILOT-COMPLETED" as const,
          failedCriteria: [] as readonly string[],
          terminal: "COMPLETED" as const,
        }
      : {
          verdict: "PILOT-FAILED" as const,
          failedCriteria: [...PROBE_FAILED_CRITERIA_OF[input.probe.kind]],
          terminal: "FAILED" as const,
        };
  return {
    rowId: input.rowId,
    description: input.description,
    window: { startShift: 1, endShift: schedule.length },
    schedule,
    observationFamilies: [...PILOT_OBSERVATION_FAMILIES],
    budgetMicroUsd: budget.toString(),
    incidents,
    declaredDrift,
    expected,
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch: input.live === true,
    ...(input.live === true ? { liveGate: { envVars: ["OPENROUTER_API_KEY"] as const } } : {}),
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

export const OFFLINE_CORPUS_ROWS: readonly ProductionPilotCorpusRow[] = [
  pilotRow({
    rowId: "full-window-recorded-basis",
    description:
      "The canonical sustained-observation row: the declared pilot window over the full schedule of shifts — onboarding, intent, plan, daily-usage and outcome workloads replayed over the VAL-050 digest-chained journey (whose stages carry the VAL-049 audited economics) — with a 10% reservation headroom per shift (the released remainder NAMED at end of window), the whole-window budget enforced, no incidents, every segment observed exactly at the recorded basis (within the declared drift bands) and every shift executing under the pilot's own customer identity. The end-of-window accounting reconciles shift-for-shift against the recorded basis with zero residual. All eight observation families verified.",
    headroom: true,
  }),
  pilotRow({
    rowId: "window-incident-resume",
    description:
      "The incident row: the window suffers a mid-window incident at the daily-usage shift — handled through the RECORDED failure/continuation machinery, the failed shift RESUMES EXACTLY ONCE (two durable executions: the failed attempt plus one resume, its economics carried honestly from the recorded continuation basis, the failed attempt's cost never hidden). The incident is recorded in the window's incident log with its mechanism and detail attributed; the continuation-exactly-once oracle verifies the resume count mechanically (a double-driven resume FAILs named — see the probe row).",
    incidentAtShift: 4,
  }),
  pilotRow({
    rowId: "window-drift-within-bounds",
    description:
      "The within-bounds drift row: the intent shift's observed economics deviate from the recorded basis by +64 microUsd and +12 ms — WITHIN the window's declared drift bands — and the drift report honestly classifies the segment within-bounds (no mechanism needed, the deviation carried as a named delta so the end-of-window accounting still reconciles shift-for-shift against the recorded basis).",
    drift: {
      shiftIndex: 2,
      costDeltaMicroUsd: "64",
      latencyDeltaMs: 12,
      qualityDelta: 0,
      mechanism: null,
    },
  }),
  pilotRow({
    rowId: "window-drift-declared",
    description:
      "The declared-drift row: the daily-usage shift's observed cost deviates from the recorded basis by +1152 microUsd — BEYOND the window's declared drift bands — and the drift report honestly classifies the segment DRIFTING with the mechanism named (provider-route-inefficiency), the delta carried into the reconciliation so the end-of-window accounting reconciles against the recorded basis with zero unexplained residual. A silently normalized drift would FAIL named — see the drift-normalizing probe row.",
    drift: {
      shiftIndex: 4,
      costDeltaMicroUsd: "1152",
      latencyDeltaMs: 0,
      qualityDelta: 0,
      mechanism: "provider-route-inefficiency",
    },
  }),
  pilotRow({
    rowId: "window-regression-declared",
    description:
      "The declared-regression row: the outcome shift's observed quality falls from the recorded 0.98 to 0.72 — BELOW the window's declared quality floor — and the drift report honestly classifies the segment REGRESSING with the mechanism named (output-quality-degradation), the regression REPORTED AS REGRESSING (never silently normalized away). The cost/latency basis is unchanged; the accounting reconciles with zero residual.",
    drift: {
      shiftIndex: 5,
      costDeltaMicroUsd: "0",
      latencyDeltaMs: 0,
      qualityDelta: -0.26,
      mechanism: "output-quality-degradation",
    },
  }),
  pilotRow({
    rowId: "probe-window-cherry-picking",
    description:
      "The window-cherry-picking probe row (the adversarial pilot shape): the observation window cherry-picks a sub-window — the dishonest pilot observes only the first four shifts and reports the window as if complete. The window-honesty oracle FAILs with the omitted segment NAMED (shift-5), and the end-of-window accounting FAILs with the omitted segment's recorded cost NAMED as the window-basis residual (400 microUsd). A pilot that cherry-picks its observation window never passes.",
    probe: { kind: "window-cherry-picking" },
  }),
  pilotRow({
    rowId: "probe-dropped-shift",
    description:
      "The dropped-shift probe row (the adversarial pilot shape): the daily-usage shift is silently DROPPED from the window's shift records (the schedule declares it; the observation never lands it). The schedule-completeness oracle FAILs with the missing shift NAMED (shift-4), and the end-of-window accounting FAILs with the dropped shift's recorded cost NAMED as the window-basis residual (9600 microUsd). A pilot that drops a scheduled shift never passes.",
    probe: { kind: "dropped-shift" },
  }),
  pilotRow({
    rowId: "probe-double-driven-resume",
    description:
      "The double-driven-resume probe row (the adversarial pilot shape): the window's declared incident at the daily-usage shift is resumed TWICE — three durable executions for the one shift (the failed attempt plus two resume attempts). The continuation-exactly-once oracle FAILs with the duplicated resume NAMED (observed executions=3 against the declared exactly 2), the budget-policy envelope FAILs with the unauthorized spend NAMED (the third drive spends beyond the shift's reservation) and the end-of-window accounting FAILs with the duplicated work's residual NAMED. A resumed shift that double-drives never passes.",
    incidentAtShift: 4,
    probe: { kind: "double-driven-resume" },
  }),
  pilotRow({
    rowId: "probe-drift-normalizing",
    description:
      "The drift-normalizing probe row (the adversarial pilot shape): the daily-usage shift's observed cost deviates from the recorded basis by +1152 microUsd — beyond the declared drift bands — but the dishonest drift report silently classifies the segment WITHIN BOUNDS with its delta normalized away (reported delta zero, no mechanism named). The drift-classification-honesty oracle FAILs with the segment and mechanism NAMED (normalized-drift:shift-4), and the end-of-window accounting FAILs with the unexplained residual NAMED (1152 microUsd). Drift is never silently normalized away.",
    drift: {
      shiftIndex: 4,
      costDeltaMicroUsd: "1152",
      latencyDeltaMs: 0,
      qualityDelta: 0,
      mechanism: "provider-route-inefficiency",
    },
    probe: { kind: "drift-normalizing" },
  }),
  pilotRow({
    rowId: "probe-incident-hiding",
    description:
      "The incident-hiding probe row (the adversarial pilot shape): the window's declared incident at the daily-usage shift resumes exactly once (two durable executions, its economics carried honestly) but the incident log entry is silently OMITTED — the resumed shift's failure never recorded. The incident-honesty oracle FAILs with the hidden incident NAMED (shift-4, a resumed execution with no incident record). An incident in the window is always recorded and attributed.",
    incidentAtShift: 4,
    probe: { kind: "incident-hiding" },
  }),
  pilotRow({
    rowId: "probe-residual-hiding",
    description:
      "The residual-hiding probe row (the adversarial pilot shape): the window reports an end-of-window total that HIDES part of the daily-usage shift's observed spend (4800 of 9600 microUsd) — the shift-for-shift sum does not reconcile against the reported window total. The end-of-window accounting oracle FAILs with the hidden residual NAMED (the exact unexplained amount); an unexplained pilot-level residual never passes.",
    probe: { kind: "residual-hiding" },
  }),
  pilotRow({
    rowId: "probe-boundary-leak",
    description:
      "The boundary-leak probe row (the adversarial pilot shape): the daily-usage shift executes under ANOTHER customer's application identity — a cross-tenant leak inside the pilot window. The customer-boundary oracle FAILs with the leaking shift NAMED and the foreign application identity NAMED; the boundary is respected at every shift of every honest window.",
    probe: { kind: "boundary-leak" },
  }),
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL live dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL live dispatch). */
export const LIVE_CORPUS_ROWS: readonly ProductionPilotCorpusRow[] = [
  pilotRow({
    rowId: "live-pilot-window",
    description:
      "A REAL live pilot window (env-gated on OPENROUTER_API_KEY): one REAL sustained-observation slice with live dispatches held across the declared live window through the REAL platform path, recorded through the REAL recorder with honest measured economics — the same five-shift schedule over the recorded portfolio, the audited cost basis carried per shift, the live slice's own dispatch usage MEASURED (never estimated, never fabricated). Without the credential the row is honestly NOT RUN (the env var named); the offline fake world never serves the live rail.",
    live: true,
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const PRODUCTION_PILOT_CORPUS: readonly ProductionPilotCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The row ids in corpus order (config.json mirrors this slice). */
export const PRODUCTION_PILOT_ROW_IDS: readonly string[] = PRODUCTION_PILOT_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function pilotRowById(rowId: string): ProductionPilotCorpusRow | null {
  return PRODUCTION_PILOT_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: ProductionPilotCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one pilot submission: each row's
 * window lands its OWN durable execution (one submission per row —
 * never a re-issue of another row's key).
 */
export function pilotSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-051-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one pilot submission: the task kind, the
 * pinned row, the observation window, the schedule of shifts (their
 * workloads and their recorded input digest counts) and the
 * observation families under test — REFERENCES ONLY (never a price,
 * never a recorded result copy; the platform resolves the recorded
 * corpora through their registries).
 */
export function pilotTaskBodyFor(options: {
  readonly row: ProductionPilotCorpusRow;
}): Record<string, unknown> {
  const row = options.row;
  return {
    kind: PRODUCTION_PILOT_TASK_KIND,
    rowId: row.rowId,
    pilot: {
      window: { startShift: row.window.startShift, endShift: row.window.endShift },
      shifts: row.schedule.map((shift) => ({
        shiftId: shift.shiftId,
        workload: shift.workload,
        recordedInputDigests: shift.recordedInputDigests.length,
      })),
      observationFamilies: [...row.observationFamilies],
      incidents: row.incidents.map((incident) => incident.shiftIndex),
      driftShifts: row.declaredDrift.map((drift) => drift.shiftIndex),
    },
  };
}

/**
 * The corpus input digest (the stable FNV-1a over the pinned corpus
 * vocabulary — the reproducibility pin).
 */
export function pinnedPilotInputDigest(): string {
  return economicDigestOf({
    version: PRODUCTION_PILOT_CORPUS_VERSION,
    rows: [...PRODUCTION_PILOT_ROW_IDS],
    customer: PILOT_CUSTOMER_APPLICATION_ID,
  });
}

/**
 * The VAL-049 audit rows this corpus carries economics from (the
 * cost-basis anchors, deduplicated in first-reference order — exported
 * for the anchoring tests).
 */
export const CARRIED_AUDIT_ROW_IDS: readonly string[] = [
  ...new Set(
    PRODUCTION_PILOT_CORPUS.flatMap((row) =>
      row.schedule.map((shift) => shift.economics.basisAuditRowId),
    ),
  ),
];

/**
 * The carried basis digest of one audit anchor (PURE — FNV-1a over
 * the referenced VAL-049 audit row's recorded evidence digests,
 * imported never rewritten; exported for the anchoring tests).
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
