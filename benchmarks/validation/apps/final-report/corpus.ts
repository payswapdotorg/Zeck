/**
 * The final-report corpus (VAL-052, AC1): the declared rows of the
 * FINAL VALIDATION REPORT, FINDINGS, SOLUTIONS AND RELEASE GATE — the
 * consolidated evidence inventory of the ENTIRE validation program
 * (every work order VAL-001..052 with its registered title,
 * completion status, resolved evidence document and merge/finalize
 * record) and the mechanical NINE-CONDITION RELEASE GATE, each
 * condition adjudicated from the RECORDED evidence with the evidence
 * NAMED. The inventory is pure derivation over the RECORDED governed
 * program state and evidence documents (digest-referenced, never
 * re-measured, never copied) — this work order adds NO new product
 * surface and NO new workload corpus.
 *
 * Per row (the work order's AC1) the corpus declares:
 *
 *   * the REPORT SHAPE — the program slice under inventory (the full
 *     governed program for the honest rows: 46 registered work
 *     orders, 45 complete + VAL-052 itself honestly recorded as the
 *     IN-FLIGHT work order) and its recorded evidence references (the
 *     governed state files + the evidence documents at their
 *     registered locations, content-digest referenced only);
 *   * the GATE FAMILY under test (the mechanical verification core:
 *     the consolidated-evidence-inventory family / the nine
 *     release-gate conditions / the deadline-remainder honesty / the
 *     acceptance-chain honesty);
 *   * the EXPECTED VERDICT — the honest vocabulary of record:
 *     COMPLETED / FAILED with the criterion NAMED / NOT-RUN with the
 *     gating env var named.
 *
 * The seven adversarial probe rows (a missing work order, a deleted
 * evidence document, a reasonless NOT RUN boundary, a
 * protocol-stripped finding, a phantom coverage claim, a silently
 * dropped incomplete work order, a self-declared acceptance) each
 * FAIL their NAMED criteria; the ONE live row is env-gated on the
 * operator-authorized rail and is honestly NOT RUN without the
 * credential.
 */

import { economicDigestOf } from "../economic-baseline/driver";

/** The task kind every report submission carries (the app's task vocabulary). */
export const FINAL_REPORT_TASK_KIND = "final-report.release-gate.v1";

/** The corpus version (the pinned vocabulary of record). */
export const FINAL_REPORT_CORPUS_VERSION = "val-052-final-report-v1";

/**
 * The report application's customer identity — the application
 * identity every honest report submission executes under (the app's
 * own boundary; a submission under any other identity is a leak and
 * FAILs named).
 */
export const FINAL_REPORT_APPLICATION_ID = "app-final-report";

/**
 * The operator deadline of record (the roadmap's validation
 * completion deadline — the deadline-remainder honesty oracle pins
 * it; every remaining-window derivation is measured against THIS
 * instant, never a wall clock).
 */
export const OPERATOR_DEADLINE_UTC = "2026-09-15T00:00:00Z";

/**
 * The governed state location of record (READ-ONLY data at run time —
 * the report engine READS the governed state; any edit to it FAILs
 * the work order's forbidden surface).
 */
export const GOVERNED_PROGRAM_STATE_PATH = "spec/validation-state/program-state.json";

/** The governed dependency-state location of record (READ-ONLY data). */
export const GOVERNED_DEPENDENCY_STATE_PATH = "spec/validation-state/dependency-state.json";

/**
 * The registered evidence-document location of one work order (the
 * registered locations of record: `benchmarks/validation/evidence/
 * VAL-001.md` for VAL-001 — the bootstrap's own evidence file — and
 * `docs/work-items/VAL-0NN.md` for every other work order).
 */
export function registeredEvidencePathOf(workOrderId: string): string {
  return workOrderId === "VAL-001"
    ? "benchmarks/validation/evidence/VAL-001.md"
    : `docs/work-items/${workOrderId}.md`;
}

// ---------------------------------------------------------------------------
// The vocabulary (the verification families + the probes)
// ---------------------------------------------------------------------------

/**
 * The mechanical verification families (the verification core — the
 * three inventory oracles, the NINE release-gate conditions, the
 * deadline-remainder honesty and the acceptance-chain honesty; the
 * ninth gate condition IS the acceptance-chain honesty condition).
 */
export type FinalReportVerificationFamily =
  | "inventory-completeness"
  | "inventory-registration"
  | "inventory-evidence-resolution"
  | "gate-category-coverage"
  | "gate-integration-paths"
  | "gate-thresholds-bounded"
  | "gate-longitudinal-learning"
  | "gate-economic-fairness"
  | "gate-not-run-disclosure"
  | "gate-findings-protocol"
  | "gate-reproducibility"
  | "acceptance-chain-honesty"
  | "deadline-remainder-honesty";

/** The declared verification-family vocabulary (all thirteen). */
export const FINAL_REPORT_VERIFICATION_FAMILIES: readonly FinalReportVerificationFamily[] =
  Object.freeze([
    "inventory-completeness",
    "inventory-registration",
    "inventory-evidence-resolution",
    "gate-category-coverage",
    "gate-integration-paths",
    "gate-thresholds-bounded",
    "gate-longitudinal-learning",
    "gate-economic-fairness",
    "gate-not-run-disclosure",
    "gate-findings-protocol",
    "gate-reproducibility",
    "acceptance-chain-honesty",
    "deadline-remainder-honesty",
  ]);

/**
 * The nine release-gate conditions of record (the roadmap's validation
 * completion gate — the gate family ids map 1:1 onto the criteria the
 * driver adjudicates; each condition derives from the recorded
 * evidence with the evidence NAMED, zero subjective judgment).
 */
export const RELEASE_GATE_CONDITIONS: readonly {
  readonly condition: number;
  readonly family: FinalReportVerificationFamily;
  readonly statement: string;
}[] = Object.freeze([
  {
    condition: 1,
    family: "gate-category-coverage",
    statement:
      "every application category exercised (each coverage row cites its completed work order)",
  },
  {
    condition: 2,
    family: "gate-integration-paths",
    statement:
      "public integration paths proven (the SDK harness, the capability matrix and the end-to-end journey records)",
  },
  {
    condition: 3,
    family: "gate-thresholds-bounded",
    statement:
      "quality/safety/reliability thresholds met or explicitly bounded (no unbounded claim)",
  },
  {
    condition: 4,
    family: "gate-longitudinal-learning",
    statement:
      "longitudinal learning demonstrated (the recorded answer, whatever it measured — a recorded tie or negative is a valid demonstration, never a failed gate)",
  },
  {
    condition: 5,
    family: "gate-economic-fairness",
    statement:
      "economic experiments compared against strong baselines fairly (the recorded paired-structure discipline)",
  },
  {
    condition: 6,
    family: "gate-not-run-disclosure",
    statement:
      "every missing-provider-access limitation disclosed (each NOT RUN boundary with its exact reason and gating env var named)",
  },
  {
    condition: 7,
    family: "gate-findings-protocol",
    statement:
      "findings carrying proposed solutions and residual risks (the seven-part solution protocol per material issue)",
  },
  {
    condition: 8,
    family: "gate-reproducibility",
    statement:
      "results reproducible from repository-defined experiments (the VAL-049 replay-bit-stability record and the run identities)",
  },
  {
    condition: 9,
    family: "acceptance-chain-honesty",
    statement:
      "the Architect's acceptance of the exact final evidence package carried by the authority chain (PR → CI → merge → program-state finalize) — never self-declared by the report",
  },
]);

/** The adversarial report-probe vocabulary (each FAILs its named criteria). */
export type ReportProbeKind =
  | "missing-work-order"
  | "deleted-evidence-document"
  | "boundary-without-env-var"
  | "protocol-stripped-finding"
  | "phantom-coverage"
  | "silent-omission"
  | "self-declared-acceptance";

/** The NAMED mechanism per probe (the exact catch the oracle must cite). */
export const PROBE_MECHANISM_OF: Readonly<Record<ReportProbeKind, string>> = Object.freeze({
  "missing-work-order":
    "inventory-completeness:omitted-work-order (the consolidated inventory omits a registered work order — VAL-031 silently dropped)",
  "deleted-evidence-document":
    "inventory-evidence-resolution:unresolved-evidence-document (the work order's evidence document does not resolve at its registered location — VAL-033's work-item doc deleted)",
  "boundary-without-env-var":
    "gate-not-run-disclosure:reasonless-not-run-boundary (a NOT RUN boundary recorded without its gating env var named — the live-journey-slice boundary stripped of OPENROUTER_API_KEY)",
  "protocol-stripped-finding":
    "gate-findings-protocol:protocol-stripped-finding (a material finding stripped of its seven-part solution protocol)",
  "phantom-coverage":
    "gate-category-coverage:phantom-coverage (a category claimed covered without its recorded work order — a coverage row and an inventory entry citing the never-registered VAL-027)",
  "silent-omission":
    "deadline-remainder-honesty:silently-dropped-incomplete (an incomplete work order silently dropped from the deadline accounting — VAL-052's planned status never named)",
  "self-declared-acceptance":
    "acceptance-chain-honesty:self-declared-acceptance (the report claims the Architect's acceptance itself instead of carrying it through the authority chain)",
});

/**
 * The NAMED criteria each probe row must FAIL (the expected failure
 * surface, pinned so the corpus, the driver and the tests share ONE
 * vocabulary).
 */
export const PROBE_FAILED_CRITERIA_OF: Readonly<Record<ReportProbeKind, readonly string[]>> =
  Object.freeze({
    "missing-work-order": ["inventory-completeness"],
    "deleted-evidence-document": ["inventory-evidence-resolution"],
    "boundary-without-env-var": ["gate-not-run-disclosure"],
    "protocol-stripped-finding": ["gate-findings-protocol"],
    "phantom-coverage": ["inventory-completeness", "gate-category-coverage"],
    "silent-omission": ["deadline-remainder-honesty"],
    "self-declared-acceptance": ["acceptance-chain-honesty"],
  });

// ---------------------------------------------------------------------------
// The recorded evidence registries (the report's declared slices —
// REFERENCES ONLY: work-order ids and their recorded facts, never a
// re-measured value, never a copied evidence body)
// ---------------------------------------------------------------------------

/** One application-coverage category row (each cites its completed work order). */
export interface CoverageCategoryRow {
  readonly category: string;
  readonly workOrderId: string;
  readonly categoryTitle: string;
}

/**
 * The application coverage registry — every customer-style workload
 * category the roadmap registered, each row citing the completed work
 * order that exercised it (the registered titles of record).
 */
export const APPLICATION_CATEGORIES: readonly CoverageCategoryRow[] = Object.freeze([
  {
    category: "text-generation-extraction-transformation",
    workOrderId: "VAL-010",
    categoryTitle: "Text generation, extraction and transformation apps",
  },
  {
    category: "rag-knowledge-assistant",
    workOrderId: "VAL-011",
    categoryTitle: "RAG / knowledge-assistant application",
  },
  {
    category: "tool-agent-multi-step-workflow",
    workOrderId: "VAL-012",
    categoryTitle: "Tool-using agent and multi-step business workflow apps",
  },
  {
    category: "long-running-resumable",
    workOrderId: "VAL-013",
    categoryTitle: "Long-running / resumable agent application",
  },
  {
    category: "voice-and-realtime-voice",
    workOrderId: "VAL-014",
    categoryTitle: "Voice and realtime voice",
  },
  {
    category: "image-generation-and-transformation",
    workOrderId: "VAL-015",
    categoryTitle: "Image generation and transformation",
  },
  {
    category: "video-media-generation",
    workOrderId: "VAL-016",
    categoryTitle: "Video/media generation",
  },
  {
    category: "image-recognition-vlm-audio-understanding",
    workOrderId: "VAL-017",
    categoryTitle: "Image recognition, VLM and audio understanding",
  },
  {
    category: "multimodal-transformation-3d-rendering",
    workOrderId: "VAL-018",
    categoryTitle: "Multimodal transformation and 3D rendering",
  },
  {
    category: "customer-service-browser-computer-research-coding-operations-hitl",
    workOrderId: "VAL-019",
    categoryTitle:
      "Customer-service, browser-use, computer-use, research, coding, operations and HITL application suite",
  },
]);

/** One public integration-path row (the proven public boundary of record). */
export interface IntegrationPathRow {
  readonly surface: string;
  readonly workOrderId: string;
}

/** The public integration-path registry (the proven public paths). */
export const INTEGRATION_PATHS: readonly IntegrationPathRow[] = Object.freeze([
  { surface: "sdk-harness", workOrderId: "VAL-002" },
  { surface: "capability-matrix", workOrderId: "VAL-009" },
  { surface: "e2e-journey-record", workOrderId: "VAL-050" },
]);

/** One quality/safety/reliability threshold row (met or explicitly bounded). */
export interface ThresholdRow {
  readonly workOrderId: string;
  readonly bound: string;
}

/**
 * The quality/safety/reliability threshold registry — every threshold
 * row cites its completed work order and its EXPLICIT bound (an
 * unbounded threshold claim FAILs the gate named).
 */
export const QUALITY_SAFETY_RELIABILITY_THRESHOLDS: readonly ThresholdRow[] = Object.freeze([
  {
    workOrderId: "VAL-006",
    bound:
      "cost/latency/quality/reliability/successful-outcome accounting recorded with explicit comparison intervals — no unbounded aggregate",
  },
  {
    workOrderId: "VAL-008",
    bound:
      "evaluation/scoring engine with the full error taxonomy recorded — no silently unclassified failure",
  },
  {
    workOrderId: "VAL-020",
    bound:
      "every provider/model/tool failure attributed and recovered per the recorded taxonomy — no unattributed failure",
  },
  {
    workOrderId: "VAL-021",
    bound:
      "duplicate/replay/retry/escalation/continuation semantics verified — a resumed execution continues exactly once",
  },
  {
    workOrderId: "VAL-022",
    bound:
      "sandbox/compute/substrate failure and readiness verified against the recorded readiness record",
  },
  {
    workOrderId: "VAL-023",
    bound:
      "prompt-injection defenses verified — defended or honestly refused, never silently passed",
  },
  {
    workOrderId: "VAL-024",
    bound: "tenant and application isolation verified — no cross-tenant leak",
  },
  {
    workOrderId: "VAL-025",
    bound: "concurrency/load/endurance/soak held within the recorded endurance window",
  },
  {
    workOrderId: "VAL-026",
    bound: "outcome-state and side-effect verification — every declared side effect verified",
  },
  {
    workOrderId: "VAL-044",
    bound:
      "quality/latency/failure-adjusted cost — the adjusted basis bounded by the recorded failure rates",
  },
]);

/** One longitudinal-learning chain row (the learning program of record). */
export interface LearningRow {
  readonly workOrderId: string;
  readonly learningTitle: string;
}

/**
 * The longitudinal-learning registry (the learning chain of record —
 * freeze baselines through determinization maturity; the recorded
 * answer of the chain is WHATEVER it measured: a recorded tie or
 * negative is a valid demonstration, never a failed gate).
 */
export const LONGITUDINAL_LEARNING_CHAIN: readonly LearningRow[] = Object.freeze([
  { workOrderId: "VAL-030", learningTitle: "Freeze baselines and pre-learning controls" },
  { workOrderId: "VAL-031", learningTitle: "Repeated workload replay and trajectory analysis" },
  {
    workOrderId: "VAL-032",
    learningTitle: "Learned reuse/cache/competence/deterministicization discovery",
  },
  { workOrderId: "VAL-033", learningTitle: "Equivalence testing and deterministic replacement" },
  { workOrderId: "VAL-034", learningTitle: "Shadow deterministic execution" },
  { workOrderId: "VAL-035", learningTitle: "Canary promotion and rollback" },
  { workOrderId: "VAL-036", learningTitle: "Determinization maturity benchmark" },
]);

/**
 * The recorded learning outcome of record — the determinization
 * maturity benchmark's RECORDED answer, carried as recorded (never
 * converted into a pass/fail judgment: a recorded tie or negative is
 * a VALID demonstration of longitudinal learning).
 */
export const RECORDED_LEARNING_OUTCOME = Object.freeze({
  workOrderId: "VAL-036",
  recordedOutcome:
    "the recorded determinization-maturity answer of the VAL-036 benchmark — carried as RECORDED (a recorded tie or negative is a valid demonstration, never a failed gate)",
} as const);

/** One economic comparison row (the paired structure of record). */
export interface EconomicComparisonRow {
  readonly workOrderId: string;
  readonly baselineWorkOrderIds: readonly string[];
}

/**
 * The economic-experiment registry — every economic comparison cites
 * its STRONG BASELINES (the paired-structure discipline: the
 * direct-provider controls VAL-041, the strong optimized non-Zeck
 * baseline VAL-042 and the competing gateway/router/agent benchmark
 * VAL-043 — the recorded baseline set each comparison measured
 * against, per the recorded dependency structure).
 */
export const ECONOMIC_COMPARISONS: readonly EconomicComparisonRow[] = Object.freeze([
  { workOrderId: "VAL-040", baselineWorkOrderIds: ["VAL-005", "VAL-006", "VAL-008"] },
  { workOrderId: "VAL-044", baselineWorkOrderIds: ["VAL-041", "VAL-042", "VAL-043"] },
  { workOrderId: "VAL-045", baselineWorkOrderIds: ["VAL-036", "VAL-044"] },
  { workOrderId: "VAL-047", baselineWorkOrderIds: ["VAL-045", "VAL-046"] },
  { workOrderId: "VAL-048", baselineWorkOrderIds: ["VAL-047"] },
]);

/** One disclosed NOT RUN boundary (the missing-provider-access record). */
export interface NotRunBoundaryRow {
  readonly scope: string;
  readonly workOrderId: string;
  readonly envVar: string;
  readonly reason: string;
}

/**
 * The missing-provider-access limitation registry — every NOT RUN
 * boundary the recorded program disclosed, each with its exact
 * reason and its gating env var NAMED (a reasonless boundary or a
 * boundary without its env var FAILs the gate named).
 */
export const NOT_RUN_BOUNDARIES: readonly NotRunBoundaryRow[] = Object.freeze([
  {
    scope: "live-journey-slice",
    workOrderId: "VAL-050",
    envVar: "OPENROUTER_API_KEY",
    reason:
      "the live journey slice demands the operator-authorized rail (the Lead's live-review lane)",
  },
  {
    scope: "live-pilot-window",
    workOrderId: "VAL-051",
    envVar: "OPENROUTER_API_KEY",
    reason: "the live pilot window demands the operator-authorized rail (the live-review lane's)",
  },
  {
    scope: "live-re-run-row",
    workOrderId: "VAL-049",
    envVar: "OPENROUTER_API_KEY",
    reason: "the reproducibility arm's live re-run slice demands the operator-authorized rail",
  },
  {
    scope: "live-economic-rows",
    workOrderId: "VAL-040",
    envVar: "OPENROUTER_API_KEY",
    reason: "the two live economic rows demand the operator-authorized rail",
  },
  {
    scope: "live-openrouter-injection-rows",
    workOrderId: "VAL-023",
    envVar: "OPENROUTER_API_KEY",
    reason: "the three OpenRouter live injection rows demand the operator-authorized rail",
  },
  {
    scope: "live-dashscope-row",
    workOrderId: "VAL-023",
    envVar: "QWEN_API_KEY",
    reason: "the dashscope compatible-mode live row demands its provider credential",
  },
  {
    scope: "real-sql-integration-crowns",
    workOrderId: "VAL-049",
    envVar: "ZECK_PG_TEST_URL",
    reason:
      "the REAL-SQL integration crowns skip cleanly without the PostgreSQL URL (never a fake success)",
  },
]);

/** The seven parts of the solution protocol of record (per material issue). */
export const SEVEN_PART_PROTOCOL_PARTS: readonly string[] = Object.freeze([
  "reproduction",
  "impact",
  "root-cause-classification",
  "viable-solutions",
  "recommended-solution-with-trade-offs",
  "defect-classification",
  "required-verification-evidence",
]);

/** One material finding (the seven-part solution protocol + the residual risk). */
export interface FindingRow {
  readonly findingId: string;
  readonly workOrderId: string;
  readonly summary: string;
  readonly protocol: Readonly<Record<string, string>>;
  readonly residualRisk: string;
}

/**
 * The material-findings registry — every material finding of the
 * recorded program, each carrying its SEVEN-PART solution protocol
 * and its NAMED residual risk (a protocol-stripped finding or a
 * hidden residual risk FAILs the gate named).
 */
export const MATERIAL_FINDINGS: readonly FindingRow[] = Object.freeze([
  {
    findingId: "F-01-live-rail-credential-custody",
    workOrderId: "VAL-040",
    summary:
      "the live model rail is unverifiable inside delivery sandboxes — no operator-authorized provider credential exists in the delivery pods (the recurring recorded NOT RUN boundary across the live-gated slices)",
    protocol: {
      reproduction:
        "run any live-gated suite in a delivery pod with no OPENROUTER_API_KEY/QWEN_API_KEY in the environment — every live row lands its recorded NOT RUN boundary with the env var named (VAL-023/040/049/050/051)",
      impact:
        "the live verification of every live-gated slice depends on the Lead's credentialed re-run at review time; no live divergence can be caught inside the delivery lane itself",
      "root-cause-classification":
        "credential custody (environmental boundary, not a product defect): operator-authorized credentials cannot live in delivery environments or the repository",
      "viable-solutions":
        "(a) the Lead's credentialed live-review lane (the recorded pattern); (b) ephemeral scoped credentials issued per delivery (rejected: custody risk, audit surface); (c) recorded-only live evidence without re-run (rejected: unverifiable, converts a NOT RUN boundary into a pass)",
      "recommended-solution-with-trade-offs":
        "the Lead's credentialed live review at finalize time, with the measured facts bounds-checked against the recorded bounds — trade-off: the live lane serializes behind the credential holder instead of running concurrently",
      "defect-classification": "environmental boundary (NOT RUN), never a fabricated success",
      "required-verification-evidence":
        "the live-review lane's recorded run identities plus the measured economics bounds-checked against the recorded live-window bounds",
    },
    residualRisk:
      "the final live confirmation remains pending until the Lead's credentialed re-run lands; a live divergence measured there reopens the economic and coverage sections of this report",
  },
  {
    findingId: "F-02-serial-frontier-stall-pattern",
    workOrderId: "VAL-051",
    summary:
      "delivery sessions stalled twice consecutively on the serial frontier (VAL-050: 2h31m52s and VAL-051: 2h47m06s with zero remote-visible artifacts), forcing takeover deliveries under the first-PR arbitration",
    protocol: {
      reproduction:
        "inspect the governed program state's VAL-050/VAL-051 notes — both record session-B claims stalling past 2.5h with zero remote-visible artifacts and the A-lane takeover deliveries via PR #116/#117",
      impact:
        "the serial frontier idles for the stall duration; takeover deliveries carry branch-metadata divergence (the 051 branch-name collision recorded in the state notes)",
      "root-cause-classification":
        "liveness discipline (process risk, not a product defect): an exclusive dispatch window without a visible-progress obligation can idle the frontier",
      "viable-solutions":
        "(a) the deadline-inverted liveness rule (session A proceeds immediately when the deadline window is critical); (b) shorter exclusivity windows with mandatory progress heartbeats; (c) parallel lanes on the same work order (rejected: duplicate-merge risk)",
      "recommended-solution-with-trade-offs":
        "the deadline-inverted liveness rule already issued in the VAL-052 spec — trade-off: a takeover can race a late resurfacing session (arbitrated by the first-PR rule, as the 051 collision was)",
      "defect-classification": "process risk (recorded in the governed state notes)",
      "required-verification-evidence":
        "the authority-chain records of the takeover deliveries (PR #116/#117, the takeover commits and the program-state finalize records)",
    },
    residualRisk:
      "the alternation discipline may still produce takeover races whose branch metadata diverges; the first-PR arbitration resolves them, but review attention is required at every finalize",
  },
  {
    findingId: "F-03-sandbox-reset-destroyed-embedded-postgresql",
    workOrderId: "VAL-049",
    summary:
      "the 07:39–07:50 UTC sandbox reset destroyed the program's embedded PostgreSQL, forcing userland re-provisioning of the verification-of-record database",
    protocol: {
      reproduction:
        "inspect the VAL-049 work-item evidence: the program's original embedded PG at :55432 was destroyed by the sandbox reset and re-provisioned userland at :5433 before the recorded battery runs",
      impact:
        "pinned infrastructural endpoints can be invalidated mid-cycle; any verification bound to the destroyed instance must be re-provisioned and re-run",
      "root-cause-classification":
        "infrastructural transient (environmental reset, not a product defect): the delivery sandbox's lifecycle is outside the program's control",
      "viable-solutions":
        "(a) userland re-provisioning of an equivalent REAL PostgreSQL for the verification of record (the recorded choice); (b) waiting for program infra to be restored (rejected: the deadline window); (c) skipping the REAL-SQL crown (rejected: converts a REAL verification into a fake success)",
      "recommended-solution-with-trade-offs":
        "userland re-provisioning of the same REAL wire protocol with the CI cross-check left binding — trade-off: the verification-of-record instance differs from the program's own instance until the Lead's re-run",
      "defect-classification": "infrastructural transient (environmental)",
      "required-verification-evidence":
        "the re-provisioned battery's recorded run identities over the REAL wire, plus the CI PostgreSQL cross-check of the identical crown",
    },
    residualRisk:
      "environmental resets can recur mid-cycle; every pinned infrastructural endpoint carries a re-provisioning obligation that the deadline accounting must absorb",
  },
]);

/** One reproducibility record row (the repository-defined experiment of record). */
export interface ReproducibilityRow {
  readonly record: string;
  readonly workOrderId: string;
}

/**
 * The reproducibility registry (the repository-defined experiments of
 * record: the VAL-049 replay-bit-stability record and the immutable
 * run identities).
 */
export const REPRODUCIBILITY_RECORDS: readonly ReproducibilityRow[] = Object.freeze([
  { record: "replay-bit-stability", workOrderId: "VAL-049" },
  { record: "immutable-run-identity", workOrderId: "VAL-007" },
]);

// ---------------------------------------------------------------------------
// The row shape (the report shape + the gate family + the verdict)
// ---------------------------------------------------------------------------

/** The expected verdict vocabulary (never a narrative). */
export type ReportVerdictKind = "COMPLETED" | "FAILED" | "NOT-RUN";

/** One declared final-report corpus row. */
export interface FinalReportCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The program slice under inventory (the report shape of record). */
  readonly programSlice: string;
  /** The verification families the row's verification drives (the oracle slice). */
  readonly verificationFamilies: readonly FinalReportVerificationFamily[];
  readonly expected: {
    readonly verdict: ReportVerdictKind;
    /** The criteria a FAILED verdict must NAME (empty otherwise). */
    readonly failedCriteria: readonly string[];
    readonly terminal: "COMPLETED" | "FAILED";
  };
  readonly probe?: { readonly kind: ReportProbeKind };
  readonly needsDispatch: boolean;
  readonly liveGate?: { readonly envVars: readonly ["OPENROUTER_API_KEY"] };
}

/**
 * Build one report row: the declared report shape (the full governed
 * program slice for every honest row — the consolidated inventory and
 * the nine-gate adjudication derive over the RECORDED state), the
 * verification families under test and the expected verdict derived
 * HONESTLY (the pure oracle — COMPLETED for the honest rows, FAILED
 * with the failed criteria NAMED for the adversarial probe rows, an
 * honest NOT-RUN for the env-gated live row).
 */
function reportRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly probe?: { readonly kind: ReportProbeKind };
  readonly live?: boolean;
}): FinalReportCorpusRow {
  if (input.live === true && input.probe !== undefined) {
    throw new Error("a live row never carries an adversarial probe");
  }
  const expected = input.live
    ? {
        verdict: "NOT-RUN" as const,
        failedCriteria: [] as readonly string[],
        terminal: "COMPLETED" as const,
      }
    : input.probe === undefined
      ? {
          verdict: "COMPLETED" as const,
          failedCriteria: [] as readonly string[],
          terminal: "COMPLETED" as const,
        }
      : {
          verdict: "FAILED" as const,
          failedCriteria: [...PROBE_FAILED_CRITERIA_OF[input.probe.kind]],
          terminal: "FAILED" as const,
        };
  return {
    rowId: input.rowId,
    description: input.description,
    programSlice:
      "the full governed program of record (every registered work order VAL-001..052 — 45 complete + VAL-052 itself honestly recorded as the in-flight work order)",
    verificationFamilies: [...FINAL_REPORT_VERIFICATION_FAMILIES],
    expected,
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch: input.live === true,
    ...(input.live === true ? { liveGate: { envVars: ["OPENROUTER_API_KEY"] as const } } : {}),
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

export const OFFLINE_CORPUS_ROWS: readonly FinalReportCorpusRow[] = [
  reportRow({
    rowId: "inventory-consolidated-governed-state",
    description:
      "The consolidated-evidence-inventory row: the report's inventory derives over the REAL governed program state (spec/validation-state/program-state.json, READ-ONLY data) — every registered work order present with its REGISTERED TITLE and completion status, its evidence document resolved AT ITS REGISTERED LOCATION (benchmarks/validation/evidence/VAL-001.md for VAL-001; docs/work-items/VAL-0NN.md for the rest) and content-digest referenced (never copied), its merge/finalize record cited where recorded (the mergedAs PR + mergeCommit where present; the program-state finalize carrier otherwise) — and VAL-052 itself honestly recorded as the IN-FLIGHT work order (planned status, its evidence pending the report's own landing). An omitted work order, a mistitled entry, an unresolvable evidence document or a phantom inventory entry each FAILs NAMED — see the probe rows.",
  }),
  reportRow({
    rowId: "release-gate-nine-conditions",
    description:
      "The release-gate row: the roadmap's NINE completion-gate conditions adjudicated mechanically from the RECORDED evidence with the evidence NAMED per condition — every application category exercised (each coverage row citing its completed work order), the public integration paths proven (the SDK harness VAL-002, the capability matrix VAL-009, the end-to-end journey records VAL-050), quality/safety/reliability thresholds met or explicitly bounded (no unbounded claim), longitudinal learning demonstrated (the recorded answer, whatever it measured — a recorded tie or negative is a valid demonstration), economic experiments compared against strong baselines fairly (the recorded paired-structure discipline), every missing-provider-access limitation disclosed (each NOT RUN boundary with its exact reason and gating env var NAMED), findings carrying proposed solutions and residual risks (the seven-part solution protocol per material issue), reproducibility from repository-defined experiments (the VAL-049 replay-bit-stability record and the run identities), and the Architect's acceptance carried by the authority chain — never self-declared.",
  }),
  reportRow({
    rowId: "program-coverage-and-disclosures",
    description:
      "The coverage-and-disclosures row: the report's application-coverage section (every customer-style workload category row completed — no TBD/OPEN row remains — each citing its completed work order over the recorded evidence documents), the provider/model coverage and access section (every missing-provider-access limitation disclosed with its exact reason and gating env var NAMED), and the findings section (every material finding carrying its seven-part solution protocol and its NAMED residual risk). A phantom coverage claim, a reasonless NOT RUN boundary or a protocol-stripped finding each FAILs NAMED — see the probe rows.",
  }),
  reportRow({
    rowId: "deadline-remainder-honest",
    description:
      "The deadline-remainder-honesty row: the report names the program's completion state against the operator deadline — the completion timestamp (the governed state's asOf of record), the remaining window measured against the 2026-09-15T00:00:00Z deadline, and every work order not complete at report time NAMED with its status (VAL-052, planned — the in-flight work order, never silently dropped). A silently dropped incomplete work order FAILs NAMED — see the silent-omission probe row.",
  }),
  reportRow({
    rowId: "acceptance-chain-carried",
    description:
      "The acceptance-chain-honesty row: the Architect's acceptance of the exact final evidence package is carried by the AUTHORITY CHAIN — every completed work order's acceptance carried by its recorded mergedAs record (PR + mergeCommit) where recorded, otherwise by the program-state finalize record (the governed state's own completion record), and VAL-052's own acceptance honestly recorded as PENDING the authority chain (the PR → CI → merge → program-state finalize that will carry it) — NEVER self-declared by the report. A self-declared acceptance FAILs NAMED — see the probe row.",
  }),
  reportRow({
    rowId: "probe-missing-work-order",
    description:
      "The missing-work-order probe row (the adversarial report shape): the consolidated inventory OMITS a registered work order — VAL-031 (Repeated workload replay and trajectory analysis) silently dropped from the inventory. The inventory-completeness oracle FAILs with the omitted work order NAMED (omitted-work-order:VAL-031). A report that omits a work order from its inventory never passes.",
    probe: { kind: "missing-work-order" },
  }),
  reportRow({
    rowId: "probe-deleted-evidence-document",
    description:
      "The deleted-evidence-document probe row (the adversarial report shape): the inventory entry for VAL-033 (Equivalence testing and deterministic replacement) cites its registered evidence location docs/work-items/VAL-033.md — but the document does NOT resolve (deleted). The inventory-evidence-resolution oracle FAILs with the unresolved evidence document NAMED (unresolved-evidence-document:VAL-033). A report citing an unresolvable evidence document never passes.",
    probe: { kind: "deleted-evidence-document" },
  }),
  reportRow({
    rowId: "probe-boundary-without-env-var",
    description:
      "The boundary-without-env-var probe row (the adversarial report shape): a disclosed NOT RUN boundary loses its gating env var — the live-journey-slice boundary (VAL-050) recorded WITHOUT OPENROUTER_API_KEY named (a reasonless NOT RUN boundary). The gate-not-run-disclosure oracle FAILs with the reasonless boundary NAMED (reasonless-not-run-boundary:live-journey-slice, no gating env var named). A NOT RUN boundary without its exact reason and env var never passes.",
    probe: { kind: "boundary-without-env-var" },
  }),
  reportRow({
    rowId: "probe-protocol-stripped-finding",
    description:
      "The protocol-stripped-finding probe row (the adversarial report shape): a material finding (F-01-live-rail-credential-custody) is stripped of its SEVEN-PART solution protocol — every protocol part emptied, the residual risk unnamed. The gate-findings-protocol oracle FAILs with the stripped finding NAMED (protocol-stripped-finding:F-01-live-rail-credential-custody). A finding without its solution protocol and residual risk never passes.",
    probe: { kind: "protocol-stripped-finding" },
  }),
  reportRow({
    rowId: "probe-phantom-coverage",
    description:
      "The phantom-coverage probe row (the adversarial report shape): the coverage section claims a category covered WITHOUT its recorded work order — a phantom coverage row citing the NEVER-REGISTERED VAL-027, and a phantom inventory entry for it claimed complete (its evidence document unresolvable because the work order was never registered). The gate-category-coverage oracle FAILs with the phantom NAMED (phantom-coverage:ambient-voice-translation→VAL-027) and the inventory-completeness oracle FAILs with the phantom inventory entry NAMED (phantom-inventory-entry:VAL-027). A report that claims unrecorded coverage never passes.",
    probe: { kind: "phantom-coverage" },
  }),
  reportRow({
    rowId: "probe-silent-omission",
    description:
      "The silent-omission probe row (the adversarial report shape): the deadline accounting silently DROPS the incomplete work order — VAL-052 (planned, the in-flight work order) never named in the deadline-remainder report, as if the program were already complete. The deadline-remainder-honesty oracle FAILs with the silently dropped incomplete work order NAMED (silently-dropped-incomplete:VAL-052, status planned at report time). A report that hides an incomplete work order from the deadline accounting never passes.",
    probe: { kind: "silent-omission" },
  }),
  reportRow({
    rowId: "probe-self-declared-acceptance",
    description:
      "The self-declared-acceptance probe row (the adversarial report shape): the report claims the Architect's acceptance ITSELF — the in-flight work order's acceptance record forged as SELF-DECLARED by the report instead of honestly pending the authority chain (PR → CI → merge → program-state finalize). The acceptance-chain-honesty oracle FAILs with the self-declared acceptance NAMED (self-declared-acceptance:VAL-052 — the Architect's acceptance is carried by the authority chain, never self-declared by the report).",
    probe: { kind: "self-declared-acceptance" },
  }),
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL live confirmation)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL live confirmation slice). */
export const LIVE_CORPUS_ROWS: readonly FinalReportCorpusRow[] = [
  reportRow({
    rowId: "live-gate-confirmation-slice",
    description:
      "A REAL live confirmation slice (env-gated on OPENROUTER_API_KEY): one live dispatch at the pinned rail through the REAL platform path, recorded through the REAL recorder with honest measured economics — the measured facts bounds-checked against the recorded live-window bounds (the final report's own live confirmation lane). Without the credential the row is honestly NOT RUN (the env var named); the offline fake world never serves the live rail.",
    live: true,
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const FINAL_REPORT_CORPUS: readonly FinalReportCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The row ids in corpus order (config.json mirrors this slice). */
export const FINAL_REPORT_ROW_IDS: readonly string[] = FINAL_REPORT_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function finalReportRowById(rowId: string): FinalReportCorpusRow | null {
  return FINAL_REPORT_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: FinalReportCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one report submission: each row's
 * report lands its OWN durable execution (one submission per row —
 * never a re-issue of another row's key).
 */
export function reportSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-052-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one report submission: the task kind, the
 * pinned row, the program slice under inventory, the verification
 * families under test and the deadline of record — REFERENCES ONLY
 * (never a copied evidence body, never a re-measured value; the
 * platform resolves the recorded state and evidence through their
 * registered locations).
 */
export function reportTaskBodyFor(options: {
  readonly row: FinalReportCorpusRow;
}): Record<string, unknown> {
  const row = options.row;
  return {
    kind: FINAL_REPORT_TASK_KIND,
    rowId: row.rowId,
    report: {
      programSlice: row.programSlice,
      verificationFamilies: [...row.verificationFamilies],
      applicationCategories: APPLICATION_CATEGORIES.length,
      integrationPaths: INTEGRATION_PATHS.length,
      thresholds: QUALITY_SAFETY_RELIABILITY_THRESHOLDS.length,
      learningChain: LONGITUDINAL_LEARNING_CHAIN.length,
      economicComparisons: ECONOMIC_COMPARISONS.length,
      notRunBoundaries: NOT_RUN_BOUNDARIES.length,
      findings: MATERIAL_FINDINGS.length,
      reproducibilityRecords: REPRODUCIBILITY_RECORDS.length,
      operatorDeadline: OPERATOR_DEADLINE_UTC,
    },
  };
}

/**
 * The corpus input digest (the stable FNV-1a over the pinned corpus
 * vocabulary — the reproducibility pin).
 */
export function pinnedReportInputDigest(): string {
  return economicDigestOf({
    version: FINAL_REPORT_CORPUS_VERSION,
    rows: [...FINAL_REPORT_ROW_IDS],
    program: "zeck-validation",
    deadline: OPERATOR_DEADLINE_UTC,
    families: [...FINAL_REPORT_VERIFICATION_FAMILIES],
  });
}
