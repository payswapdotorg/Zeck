/**
 * The customer-journey corpus (VAL-050, AC1): the declared rows of the
 * END-TO-END CUSTOMER JOURNEY — the complete customer lifecycle
 * (onboarding → intent → plan → daily usage over the recorded
 * application portfolio → outcome) driven through the REAL platform
 * path, with the audited economics (VAL-049) carried as the journey's
 * cost basis.
 *
 * Per row (the work order's AC1) the corpus declares:
 *
 *   * the JOURNEY SHAPE — the journey's stages and, per stage, the
 *     RECORDED INPUT DIGESTS the stage composes (content digests into
 *     the recorded corpora — the onboarding stage rides the VAL-002
 *     public SDK harness surface, the plan stage composes the VAL-049
 *     audited economics, the daily-usage stage drives the RECORDED
 *     application portfolio — the VAL-010 text apps' recorded fixtures
 *     and the VAL-019 broad suite's recorded tasks — and the intent
 *     and outcome stages carry the journey task vocabulary and the
 *     closeout record; digests only, never payload bytes, never a
 *     copy of a recorded result);
 *   * the per-stage RECORDED ECONOMICS — the cost basis carried from
 *     VAL-049's audited rows: every stage's economics are anchored by
 *     a basis digest re-derived over the referenced audit row's OWN
 *     recorded evidence digests (imported, never rewritten), so a
 *     drifted audit corpus breaks the anchor mechanically;
 *   * the INTEGRITY FAMILY under test (the mechanical verification
 *     core: stage completeness / cross-stage idempotency /
 *     continuation exactly-once / customer-boundary /
 *     accounting-reconciliation) and the EXPECTED VERDICT
 *     (JOURNEY-COMPLETED / JOURNEY-FAILED with the failed criteria
 *     NAMED / NOT-RUN with the env var named).
 *
 * The journey composes the RECORDED corpora where its stages replay
 * recorded workloads — pure derivation over RECORDED results, never a
 * re-measurement and never a re-pricing. The five adversarial probe
 * rows (a dropped stage, an orphaned state, a double-driven resume, a
 * boundary leak, a hidden residual) each FAIL their named criteria;
 * the ONE live row is env-gated on the operator-authorized rail and
 * is honestly NOT RUN without the credential.
 */

import { CUSTOMER_SERVICE_TASKS } from "../customer-service/application";
import { auditRowById } from "../economic-audit/corpus";
import { economicDigestOf } from "../economic-baseline/driver";
import { MATERIALIZED_FIXTURE_KEYS } from "../shared/fixtures";

/** The task kind every journey submission carries (the app's task vocabulary). */
export const CUSTOMER_JOURNEY_TASK_KIND = "customer-journey.lifecycle.v1";

/** The corpus version (the pinned vocabulary of record). */
export const CUSTOMER_JOURNEY_CORPUS_VERSION = "val-050-customer-journey-v1";

/**
 * The journey's customer identity — the application identity every
 * stage of every honest journey executes under (the customer-boundary
 * oracle's pinned basis; a stage executing under any other identity
 * is a cross-tenant leak and FAILs named).
 */
export const JOURNEY_CUSTOMER_APPLICATION_ID = "app-journey-customer";

// ---------------------------------------------------------------------------
// The vocabulary (the journey stages + the integrity families + the probes)
// ---------------------------------------------------------------------------

/** The complete customer lifecycle (the journey's stages, in order). */
export type JourneyStageKind = "onboarding" | "intent" | "plan" | "daily-usage" | "outcome";

/** The journey's stages in canonical order (stage completeness pins this). */
export const JOURNEY_STAGES: readonly JourneyStageKind[] = Object.freeze([
  "onboarding",
  "intent",
  "plan",
  "daily-usage",
  "outcome",
]);

/** The mechanical integrity families (the verification core). */
export type JourneyIntegrityFamily =
  | "stage-completeness"
  | "cross-stage-idempotency"
  | "continuation-exactly-once"
  | "customer-boundary"
  | "accounting-reconciliation";

/** The declared integrity-family vocabulary. */
export const JOURNEY_INTEGRITY_FAMILIES: readonly JourneyIntegrityFamily[] = Object.freeze([
  "stage-completeness",
  "cross-stage-idempotency",
  "continuation-exactly-once",
  "customer-boundary",
  "accounting-reconciliation",
]);

/** The adversarial journey-probe vocabulary (each FAILs its named criteria). */
export type JourneyProbeKind =
  | "dropped-stage"
  | "orphaned-state"
  | "double-driven-resume"
  | "boundary-leak"
  | "residual-hiding";

/** The NAMED mechanism per probe (the exact catch the oracle must cite). */
export const PROBE_MECHANISM_OF: Readonly<Record<JourneyProbeKind, string>> = Object.freeze({
  "dropped-stage":
    "stage-completeness:missing-stage (the daily-usage stage silently dropped from the journey)",
  "orphaned-state":
    "cross-stage-idempotency:orphaned-intent (the submitted daily-usage intent never landed a durable execution)",
  "double-driven-resume":
    "continuation-exactly-once:duplicated-resume (the mid-journey failure resumed twice — never exactly once)",
  "boundary-leak":
    "customer-boundary:foreign-application (the daily-usage stage executed under another customer's application identity)",
  "residual-hiding":
    "accounting-reconciliation:hidden-residual (the journey total hides part of the daily-usage stage cost)",
});

/**
 * The named criteria each probe row must FAIL (the expected failure
 * surface, pinned so the corpus, the driver and the tests share ONE
 * vocabulary).
 */
export const PROBE_FAILED_CRITERIA_OF: Readonly<Record<JourneyProbeKind, readonly string[]>> =
  Object.freeze({
    "dropped-stage": ["stage-completeness", "accounting-reconciliation"],
    "orphaned-state": ["cross-stage-idempotency", "accounting-reconciliation"],
    "double-driven-resume": ["continuation-exactly-once", "accounting-reconciliation"],
    "boundary-leak": ["customer-boundary"],
    "residual-hiding": ["accounting-reconciliation"],
  });

// ---------------------------------------------------------------------------
// The recorded portfolio (the VAL-010 + VAL-019 recorded application suite)
// ---------------------------------------------------------------------------

/** One recorded application portfolio reference (the daily-usage basis). */
export interface RecordedPortfolioRef {
  /** The recorded work order the application corpus belongs to. */
  readonly workOrder: "VAL-010" | "VAL-019";
  /** The recorded application's identity. */
  readonly appId: string;
  /** The recorded row ids the journey's daily usage drives (references only). */
  readonly recordedRowIds: readonly string[];
}

/**
 * The RECORDED application portfolio the journey's daily-usage stage
 * drives: the VAL-010 text apps' recorded fixture slices (the
 * materialized documents, invoices and record sets — the recorded
 * inputs, referenced by key) and the VAL-019 broad suite's recorded
 * customer-service task slice (referenced by ticket id). The recorded
 * rows are referenced, never re-measured and never re-priced.
 */
export const RECORDED_PORTFOLIO: readonly RecordedPortfolioRef[] = [
  {
    workOrder: "VAL-010",
    appId: "text-generation",
    recordedRowIds: MATERIALIZED_FIXTURE_KEYS.filter((key) =>
      key.startsWith("quarterly-report"),
    ).slice(0, 2),
  },
  {
    workOrder: "VAL-010",
    appId: "structured-extraction",
    recordedRowIds: MATERIALIZED_FIXTURE_KEYS.filter((key) => key.startsWith("invoice-")).slice(
      0,
      3,
    ),
  },
  {
    workOrder: "VAL-010",
    appId: "transformation",
    recordedRowIds: MATERIALIZED_FIXTURE_KEYS.filter((key) => key.startsWith("records-")).slice(
      0,
      3,
    ),
  },
  {
    workOrder: "VAL-019",
    appId: "customer-service",
    recordedRowIds: CUSTOMER_SERVICE_TASKS.map((task) => task.ticket),
  },
];

/**
 * The canonical recorded-input digest of one portfolio reference
 * (PURE — FNV-1a over the reference identity, payload-free).
 */
export function recordedPortfolioDigestOf(ref: RecordedPortfolioRef): string {
  return economicDigestOf({
    workOrder: ref.workOrder,
    appId: ref.appId,
    rows: [...ref.recordedRowIds],
  });
}

// ---------------------------------------------------------------------------
// The recorded stage economics (the VAL-049 audited cost basis)
// ---------------------------------------------------------------------------

/** The recorded economics of one journey stage (the carried cost basis). */
export interface RecordedStageEconomics {
  /**
   * The recorded cost of the stage's recorded work (microUsd, a
   * recorded fact carried from the VAL-049 audited basis).
   */
  readonly costMicroUsd: string;
  /** The recorded latency of the stage's recorded work (ms, a recorded fact). */
  readonly latencyMs: number;
  /** The VAL-049 audit row the economics are carried from (the anchor of record). */
  readonly basisAuditRowId: string;
  /**
   * The FNV-1a anchor into VAL-049's audited row (re-derived over the
   * audit row's OWN recorded evidence digests — a drifted audit corpus
   * breaks the anchor mechanically).
   */
  readonly basisDigest: string;
}

/**
 * The base recorded economics per stage (the carried cost basis — the
 * audited economics of VAL-049's recorded rows, carried as the
 * journey's cost basis; each stage's anchor is one of VAL-049's
 * REPRODUCIBILITY rows whose recorded evidence was verified
 * bit-stable at audit time).
 */
const BASE_STAGE_ECONOMICS: Readonly<
  Record<
    JourneyStageKind,
    { readonly costMicroUsd: string; readonly latencyMs: number; readonly basisAuditRowId: string }
  >
> = Object.freeze({
  onboarding: {
    costMicroUsd: "1200",
    latencyMs: 45,
    basisAuditRowId: "replay-controls-recorded-arms",
  },
  intent: {
    costMicroUsd: "800",
    latencyMs: 30,
    basisAuditRowId: "replay-adjusted-cost-verdicts",
  },
  plan: {
    costMicroUsd: "1500",
    latencyMs: 60,
    basisAuditRowId: "replay-savings-attribution-splits",
  },
  "daily-usage": {
    costMicroUsd: "9600",
    latencyMs: 240,
    basisAuditRowId: "replay-cross-workload-verdicts",
  },
  outcome: {
    costMicroUsd: "400",
    latencyMs: 25,
    basisAuditRowId: "replay-longitudinal-curve-points",
  },
});

/**
 * The carried basis digest of one stage's economics anchor (PURE —
 * FNV-1a over the referenced VAL-049 audit row's recorded evidence
 * digests, imported never rewritten).
 */
function carriedBasisDigestOf(auditRowId: string): string {
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

// ---------------------------------------------------------------------------
// The row shape + the row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/** One stage's declaration (the journey shape). */
export interface JourneyStageDeclaration {
  readonly stage: JourneyStageKind;
  /** The recorded input digests the stage composes (digest references only). */
  readonly recordedInputDigests: readonly string[];
  /** The stage's recorded economics (the carried VAL-049 cost basis). */
  readonly economics: RecordedStageEconomics;
}

/** The expected verdict vocabulary (never a narrative). */
export type JourneyVerdictKind = "JOURNEY-COMPLETED" | "JOURNEY-FAILED" | "NOT-RUN";

/** One declared journey corpus row. */
export interface CustomerJourneyCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The journey shape: the stages and their recorded input digests. */
  readonly stages: readonly JourneyStageDeclaration[];
  /** The integrity families the row's verification drives (the oracle slice). */
  readonly integrityFamilies: readonly JourneyIntegrityFamily[];
  /** The declared mid-journey failure + resume (the continuation basis). */
  readonly midJourneyFailureStage?: JourneyStageKind;
  /** Whether the app must prove the idempotent re-issue replays (never double-creates). */
  readonly expectsResubmissionReplay?: boolean;
  readonly expected: {
    readonly verdict: JourneyVerdictKind;
    /** The criteria a JOURNEY-FAILED verdict must NAME (empty otherwise). */
    readonly failedCriteria: readonly string[];
    readonly terminal: "COMPLETED" | "FAILED";
  };
  readonly probe?: { readonly kind: JourneyProbeKind };
  readonly needsDispatch: boolean;
  readonly liveGate?: { readonly envVars: readonly ["OPENROUTER_API_KEY"] };
}

/**
 * The recorded input digests of one stage (PURE — FNV-1a over the
 * stage's recorded composition, payload-free).
 */
function recordedInputDigestsOf(stage: JourneyStageKind): readonly string[] {
  switch (stage) {
    case "onboarding":
      // The onboarding stage rides the VAL-002 public SDK harness surface.
      return [
        economicDigestOf({
          workOrder: "VAL-002",
          integrationSurface: "sdk",
          harness: "ValidationHarness",
        }),
      ];
    case "intent":
      // The intent stage carries the journey task vocabulary.
      return [
        economicDigestOf({
          kind: CUSTOMER_JOURNEY_TASK_KIND,
          intentsPerJourney: JOURNEY_STAGES.length,
        }),
      ];
    case "plan":
      // The plan stage composes the VAL-049 audited economics (the cost basis).
      return [
        economicDigestOf({
          workOrder: "VAL-049",
          planBasis: "audited-economics",
          stages: JOURNEY_STAGES.length,
        }),
      ];
    case "daily-usage":
      // The daily-usage stage drives the RECORDED application portfolio.
      return RECORDED_PORTFOLIO.map(recordedPortfolioDigestOf);
    case "outcome":
      // The outcome stage carries the journey closeout record.
      return [economicDigestOf({ closeout: "journey-outcome", stages: JOURNEY_STAGES.length })];
  }
}

/**
 * Build one journey row: the journey shape over the recorded
 * composition (the stage declarations with their recorded input
 * digests and their carried economics), the integrity family slice,
 * and the expected verdict derived HONESTLY (the pure oracle —
 * JOURNEY-COMPLETED for the honest rows, JOURNEY-FAILED with the
 * failed criteria NAMED for the adversarial probe rows, an honest
 * NOT-RUN for the env-gated live row).
 */
function journeyRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly integrityFamilies?: readonly JourneyIntegrityFamily[];
  readonly midJourneyFailureStage?: JourneyStageKind;
  readonly expectsResubmissionReplay?: boolean;
  readonly probe?: { readonly kind: JourneyProbeKind };
  readonly live?: boolean;
}): CustomerJourneyCorpusRow {
  if (input.live === true && input.probe !== undefined) {
    throw new Error("a live row never carries an adversarial probe");
  }
  const failureStage = input.midJourneyFailureStage ?? null;
  const stages: JourneyStageDeclaration[] = JOURNEY_STAGES.map((stage) => {
    const base = BASE_STAGE_ECONOMICS[stage];
    const drives = failureStage === stage ? 2 : 1;
    const cost = BigInt(base.costMicroUsd) * BigInt(drives);
    return {
      stage,
      recordedInputDigests: recordedInputDigestsOf(stage),
      economics: {
        costMicroUsd: cost.toString(),
        latencyMs: base.latencyMs * drives,
        basisAuditRowId: base.basisAuditRowId,
        basisDigest: carriedBasisDigestOf(base.basisAuditRowId),
      },
    };
  });
  const expected = input.live
    ? {
        verdict: "NOT-RUN" as const,
        failedCriteria: [] as readonly string[],
        terminal: "COMPLETED" as const,
      }
    : input.probe === undefined
      ? {
          verdict: "JOURNEY-COMPLETED" as const,
          failedCriteria: [] as readonly string[],
          terminal: "COMPLETED" as const,
        }
      : {
          verdict: "JOURNEY-FAILED" as const,
          failedCriteria: [...PROBE_FAILED_CRITERIA_OF[input.probe.kind]],
          terminal: "FAILED" as const,
        };
  return {
    rowId: input.rowId,
    description: input.description,
    stages,
    integrityFamilies:
      input.integrityFamilies === undefined
        ? [...JOURNEY_INTEGRITY_FAMILIES]
        : [...input.integrityFamilies],
    ...(failureStage === null ? {} : { midJourneyFailureStage: failureStage }),
    ...(input.expectsResubmissionReplay === undefined
      ? {}
      : { expectsResubmissionReplay: input.expectsResubmissionReplay }),
    expected,
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch: input.live === true,
    ...(input.live === true ? { liveGate: { envVars: ["OPENROUTER_API_KEY"] as const } } : {}),
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly CustomerJourneyCorpusRow[] = [
  journeyRow({
    rowId: "full-journey-recorded-portfolio",
    description:
      "The canonical full-journey row: the complete customer lifecycle — onboarding (over the VAL-002 public SDK harness surface), intent submission (one intent per stage, every submitted intent landing exactly one durable execution), plan construction (composing the VAL-049 audited economics as the journey's cost basis), daily usage over the RECORDED application portfolio (the VAL-010 text apps' recorded fixture slices and the VAL-019 broad suite's recorded customer-service tasks — digest-referenced, never re-measured) and the outcome closeout — every stage executing under the journey's own customer identity, the end-to-end accounting reconciling stage-for-stage against the recorded stage economics with zero residual. All five integrity families verified.",
  }),
  journeyRow({
    rowId: "journey-continuation-resume",
    description:
      "The continuation row: the journey suffers a mid-journey failure at the daily-usage stage (the recorded workload's first attempt fails) and RESUMES EXACTLY ONCE — the resumed stage lands its own durable execution, never a duplicate. The stage's recorded economics carry the two driven attempts honestly (the failed attempt's cost is never hidden); the continuation-exactly-once oracle verifies the resume count mechanically (a double-driven resume FAILs named — see the probe row).",
    midJourneyFailureStage: "daily-usage",
  }),
  journeyRow({
    rowId: "journey-idempotent-reissue",
    description:
      "The idempotent re-issue row: after the journey completes, the customer re-submits the IDENTICAL journey request under the SAME idempotency key — and the platform replays the original durable execution (the same execution id, replayed: true, no second execution created). Every submitted intent still lands exactly one durable execution; a re-issue that double-creates an execution would be a cross-stage idempotency violation and FAILs named.",
    expectsResubmissionReplay: true,
  }),
  journeyRow({
    rowId: "probe-dropped-stage",
    description:
      "The dropped-stage probe row (the adversarial journey shape): the journey silently DROPS the daily-usage stage — the lifecycle runs onboarding → intent → plan → outcome and reports completion. The stage-completeness oracle FAILs with the missing stage NAMED (daily-usage), and the accounting-reconciliation oracle FAILs with the journey-level residual NAMED (the dropped stage's recorded cost is missing from the end-to-end total). A journey that silently drops a stage never passes.",
    probe: { kind: "dropped-stage" },
  }),
  journeyRow({
    rowId: "probe-orphaned-state",
    description:
      "The orphaned-state probe row (the adversarial journey shape): the daily-usage intent is SUBMITTED at the intent stage but never lands its durable execution — the submitted intent's state is orphaned (the stage record exists with no execution). The cross-stage-idempotency oracle FAILs with the orphaned intent NAMED (every submitted intent must land exactly one durable execution), and the accounting-reconciliation oracle FAILs with the missing work's residual NAMED.",
    probe: { kind: "orphaned-state" },
  }),
  journeyRow({
    rowId: "probe-double-driven-resume",
    description:
      "The double-driven-resume probe row (the adversarial journey shape): the journey suffers the mid-journey failure at the daily-usage stage and the resume is driven TWICE — three durable executions for the one stage (the failed attempt plus two resume attempts). The continuation-exactly-once oracle FAILs with the duplicated resume NAMED, and the accounting-reconciliation oracle FAILs with the duplicated work's residual NAMED. A resumed stage that double-drives never passes.",
    midJourneyFailureStage: "daily-usage",
    probe: { kind: "double-driven-resume" },
  }),
  journeyRow({
    rowId: "probe-boundary-leak",
    description:
      "The boundary-leak probe row (the adversarial journey shape): the daily-usage stage executes under ANOTHER customer's application identity — a cross-tenant leak at the journey's core stage. The customer-boundary oracle FAILs with the leaking stage NAMED and the foreign application identity NAMED; the boundary is respected at every stage of every honest journey.",
    probe: { kind: "boundary-leak" },
  }),
  journeyRow({
    rowId: "probe-residual-hiding",
    description:
      "The residual-hiding probe row (the adversarial journey shape): the journey reports an end-to-end total that HIDES part of the daily-usage stage's observed cost — the stage-for-stage sum does not reconcile against the reported journey total. The accounting-reconciliation oracle FAILs with the hidden residual NAMED (the exact unexplained amount); an unexplained journey-level residual never passes.",
    probe: { kind: "residual-hiding" },
  }),
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL live dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL live dispatch). */
export const LIVE_CORPUS_ROWS: readonly CustomerJourneyCorpusRow[] = [
  journeyRow({
    rowId: "live-journey-slice",
    description:
      "A REAL live journey slice (env-gated on OPENROUTER_API_KEY): one REAL journey through the live platform path with live dispatches recorded through the REAL recorder and honest measured economics — the same five-stage lifecycle over the recorded portfolio, the audited cost basis carried per stage, the live slice's own dispatch usage MEASURED (never estimated, never fabricated). Without the credential the row is honestly NOT RUN (the env var named); the offline fake world never serves the live rail.",
    live: true,
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const CUSTOMER_JOURNEY_CORPUS: readonly CustomerJourneyCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The row ids in corpus order (config.json mirrors this slice). */
export const CUSTOMER_JOURNEY_ROW_IDS: readonly string[] = CUSTOMER_JOURNEY_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function journeyRowById(rowId: string): CustomerJourneyCorpusRow | null {
  return CUSTOMER_JOURNEY_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: CustomerJourneyCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one journey submission: each row's
 * journey lands its OWN durable execution (one submission per row —
 * never a re-issue of another row's key).
 */
export function journeySubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-050-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one journey submission: the task kind, the
 * pinned row, the journey shape (its stages) and the integrity
 * families under test — REFERENCES ONLY (never a price, never a
 * recorded result copy; the platform resolves the recorded corpora
 * through their registries).
 */
export function journeyTaskBodyFor(options: {
  readonly row: CustomerJourneyCorpusRow;
}): Record<string, unknown> {
  return {
    kind: CUSTOMER_JOURNEY_TASK_KIND,
    rowId: options.row.rowId,
    journey: {
      stages: options.row.stages.map((stage) => stage.stage),
      integrityFamilies: [...options.row.integrityFamilies],
      stageInputDigests: options.row.stages.map((stage) => stage.recordedInputDigests.length),
      ...(options.row.midJourneyFailureStage === undefined
        ? {}
        : { midJourneyFailureStage: options.row.midJourneyFailureStage }),
    },
  };
}

/**
 * The corpus input digest (the stable FNV-1a over the pinned corpus
 * vocabulary — the reproducibility pin).
 */
export function pinnedJourneyInputDigest(): string {
  return economicDigestOf({
    version: CUSTOMER_JOURNEY_CORPUS_VERSION,
    rows: [...CUSTOMER_JOURNEY_ROW_IDS],
    customer: JOURNEY_CUSTOMER_APPLICATION_ID,
  });
}

/**
 * The VAL-049 audit rows this corpus carries economics from (the
 * cost-basis anchors, deduplicated in first-reference order — exported
 * for the anchoring tests).
 */
export const CARRIED_AUDIT_ROW_IDS: readonly string[] = [
  ...new Set(
    CUSTOMER_JOURNEY_CORPUS.flatMap((row) =>
      row.stages.map((stage) => stage.economics.basisAuditRowId),
    ),
  ),
];
