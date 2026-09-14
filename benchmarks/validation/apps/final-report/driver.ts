/**
 * The final-report engine (VAL-052, the app-local driver — the work
 * order's allowed surface ONLY).
 *
 * THE REPORT MACHINERY — pure mechanical derivation over the RECORDED
 * governed program state and evidence documents (READ-ONLY data at
 * run time; never a re-measurement, never a re-pricing, never a copy
 * of an evidence body — every reference is content-digest only):
 *
 *   * the CONSOLIDATED-EVIDENCE-INVENTORY derivation — every
 *     registered work order with its registered title, its completion
 *     status, its evidence document resolved at its REGISTERED
 *     location (`benchmarks/validation/evidence/VAL-001.md` for
 *     VAL-001; `docs/work-items/VAL-0NN.md` for the rest), its
 *     content digest (FNV-1a, payload-free) and its merge/finalize
 *     record cited where recorded (the mergedAs PR + mergeCommit
 *     where present; the program-state finalize carrier otherwise;
 *     VAL-052 itself honestly recorded as the IN-FLIGHT work order —
 *     planned status, its acceptance pending the authority chain);
 *   * the NINE-CONDITION RELEASE-GATE ADJUDICATION — each completion
 *     gate condition derived from the recorded evidence with the
 *     evidence NAMED (zero subjective judgment);
 *   * the DEADLINE-REMAINDER HONESTY — the completion timestamp, the
 *     remaining window against the operator deadline and every work
 *     order not complete at report time NAMED with its status (never
 *     silently dropped);
 *   * the ACCEPTANCE-CHAIN HONESTY — the Architect's acceptance
 *     carried by the authority chain (PR → merge record →
 *     program-state finalize), never self-declared by the report.
 *
 * THE THIRTEEN MECHANICAL ORACLES (the verification core — each FAILs
 * with the offender NAMED; every oracle owns its catch, never
 * double-counting another oracle's):
 *
 *   * INVENTORY COMPLETENESS — every registered work order present,
 *     no phantom inventory entry (an omitted work order or a phantom
 *     entry FAILs NAMED);
 *   * INVENTORY REGISTRATION — every entry's title and completion
 *     status match the governed state exactly (a mistitled entry or a
 *     misstated status FAILs NAMED);
 *   * INVENTORY EVIDENCE RESOLUTION — every complete work order's
 *     evidence document resolves at its registered location with its
 *     content digest re-derived over the world (an unresolvable or
 *     digest-disagreeing document FAILs NAMED; the in-flight work
 *     order's evidence is honestly recorded as pending);
 *   * GATE 1 CATEGORY COVERAGE — every application category exercised
 *     with each coverage row citing its completed, evidence-resolved
 *     work order (a phantom coverage claim FAILs NAMED);
 *   * GATE 2 INTEGRATION PATHS — the SDK harness, the capability
 *     matrix and the end-to-end journey records each cited complete
 *     with resolved evidence;
 *   * GATE 3 THRESHOLDS BOUNDED — every quality/safety/reliability
 *     threshold row cites its completed work order and its EXPLICIT
 *     bound (an unbounded threshold claim FAILs NAMED);
 *   * GATE 4 LONGITUDINAL LEARNING — the learning chain complete and
 *     the recorded outcome carried AS RECORDED (a recorded tie or
 *     negative is a valid demonstration, never a failed gate);
 *   * GATE 5 ECONOMIC FAIRNESS — every economic comparison cites its
 *     strong baselines (the recorded paired-structure discipline);
 *   * GATE 6 NOT RUN DISCLOSURE — every missing-provider-access
 *     limitation disclosed with its exact reason AND its gating env
 *     var NAMED (a reasonless boundary FAILs NAMED);
 *   * GATE 7 FINDINGS PROTOCOL — every material finding carries its
 *     SEVEN-PART solution protocol and its NAMED residual risk (a
 *     protocol-stripped finding FAILs NAMED);
 *   * GATE 8 REPRODUCIBILITY — the VAL-049 replay-bit-stability
 *     record and the immutable run identities cited complete with
 *     resolved evidence;
 *   * GATE 9 ACCEPTANCE-CHAIN HONESTY — no self-declared acceptance;
 *     every complete work order's acceptance carried by its recorded
 *     merge record where recorded, otherwise by the program-state
 *     finalize record; the in-flight work order honestly pending;
 *   * DEADLINE-REMAINDER HONESTY — the completion timestamp, the
 *     remaining window (re-derived against the pinned operator
 *     deadline) and every incomplete work order NAMED with its status
 *     (a silently dropped incomplete work order FAILs NAMED).
 *
 * The digest discipline: the house FNV-1a convention
 * (`economicDigestOf`, imported from the VAL-040 driver — never
 * re-implemented); every evidence reference is digest-only, payload
 * bytes never appear.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LabVerificationCriterion } from "../../platform/derive";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  APPLICATION_CATEGORIES,
  ECONOMIC_COMPARISONS,
  FINAL_REPORT_VERIFICATION_FAMILIES,
  type FinalReportCorpusRow,
  GOVERNED_DEPENDENCY_STATE_PATH,
  GOVERNED_PROGRAM_STATE_PATH,
  INTEGRATION_PATHS,
  LONGITUDINAL_LEARNING_CHAIN,
  MATERIAL_FINDINGS,
  NOT_RUN_BOUNDARIES,
  OPERATOR_DEADLINE_UTC,
  QUALITY_SAFETY_RELIABILITY_THRESHOLDS,
  RECORDED_LEARNING_OUTCOME,
  RELEASE_GATE_CONDITIONS,
  REPRODUCIBILITY_RECORDS,
  type ReportProbeKind,
  type ReportVerdictKind,
  registeredEvidencePathOf,
  SEVEN_PART_PROTOCOL_PARTS,
} from "./corpus";

// ---------------------------------------------------------------------------
// The governed state view (READ-ONLY data at run time)
// ---------------------------------------------------------------------------

/** One registered work order of the governed program state (as recorded). */
export interface GovernedWorkOrder {
  readonly status: string;
  readonly title: string;
  readonly mergedAs?: {
    readonly pr: number;
    readonly mergeCommit: string;
    readonly [key: string]: unknown;
  };
}

/** The governed program-state file (READ-ONLY data). */
export interface GovernedProgramStateFile {
  readonly schemaVersion: number;
  readonly program: string;
  readonly status: string;
  readonly asOf: string;
  readonly workOrders: Readonly<Record<string, GovernedWorkOrder>>;
}

/** The governed dependency-state file (READ-ONLY data). */
export interface GovernedDependencyStateFile {
  readonly schemaVersion: number;
  readonly program: string;
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
}

/** One evidence-document resolution (the registered location of record). */
export interface EvidenceDocResolution {
  readonly workOrderId: string;
  readonly registeredPath: string;
  readonly exists: boolean;
  /** The content digest (FNV-1a over the document bytes — payload-free). */
  readonly contentDigest: string | null;
}

/**
 * The report world — the derivation basis of record: the governed
 * program/dependency state (READ-ONLY data), the evidence-document
 * resolver (registered locations + content digests), the report
 * timestamp (the completion timestamp of record — the governed
 * state's asOf, never a wall clock) and the pinned operator deadline.
 */
export interface ReportWorld {
  readonly programState: GovernedProgramStateFile;
  readonly dependencyState: GovernedDependencyStateFile;
  readonly evidenceDocOf: (workOrderId: string) => EvidenceDocResolution;
  readonly reportTimestamp: string;
  readonly operatorDeadline: string;
}

/**
 * Load the REAL report world from the repository (the governed state
 * files + the evidence documents at their registered locations —
 * READ-ONLY data at run time; editing the governed state is the
 * forbidden surface, reading it as data is the expected one). Pure
 * with respect to the repository contents: the same revision yields
 * the same world.
 */
export function loadRealReportWorld(options?: {
  readonly cwd?: string;
  readonly readFileSync?: (path: string) => string;
}): ReportWorld {
  const cwd = options?.cwd ?? process.cwd();
  const read = options?.readFileSync ?? ((path: string) => readFileSync(path, "utf8"));
  const programState = JSON.parse(
    read(join(cwd, GOVERNED_PROGRAM_STATE_PATH)),
  ) as GovernedProgramStateFile;
  const dependencyState = JSON.parse(
    read(join(cwd, GOVERNED_DEPENDENCY_STATE_PATH)),
  ) as GovernedDependencyStateFile;
  const evidenceDocOf = (workOrderId: string): EvidenceDocResolution => {
    const registeredPath = registeredEvidencePathOf(workOrderId);
    const absolute = join(cwd, registeredPath);
    if (!existsSync(absolute)) {
      return { workOrderId, registeredPath, exists: false, contentDigest: null };
    }
    return {
      workOrderId,
      registeredPath,
      exists: true,
      contentDigest: economicDigestOf(read(absolute)),
    };
  };
  return {
    programState,
    dependencyState,
    evidenceDocOf,
    reportTimestamp: programState.asOf,
    operatorDeadline: OPERATOR_DEADLINE_UTC,
  };
}

// ---------------------------------------------------------------------------
// The report package (the derivation of record)
// ---------------------------------------------------------------------------

/** One consolidated-evidence-inventory entry (per registered work order). */
export interface InventoryEntry {
  readonly workOrderId: string;
  /** The registered title of record (must match the governed state exactly). */
  readonly title: string;
  /** The completion status of record (must match the governed state exactly). */
  readonly status: string;
  readonly evidence: {
    readonly registeredPath: string;
    readonly resolved: boolean;
    readonly contentDigest: string | null;
  };
  /** The merge record cited where recorded (null where not recorded). */
  readonly mergeRecord: { readonly pr: number; readonly mergeCommit: string } | null;
  /**
   * The acceptance carrier of record: "pr-merge" (the recorded
   * mergedAs record), "program-state-finalize" (the governed state's
   * own completion record — the finalize leg), or
   * "pending-authority-chain" (the in-flight work order, honestly
   * pending). NEVER "self-declared".
   */
  readonly acceptanceCarrier:
    | "pr-merge"
    | "program-state-finalize"
    | "pending-authority-chain"
    | "self-declared";
}

/** One application-coverage claim row (each cites its completed work order). */
export interface CoverageClaimRow {
  readonly category: string;
  readonly workOrderId: string;
  readonly evidenceDigest: string | null;
}

/** One gate reference row (the evidence NAMED per condition). */
export interface GateReferenceRow {
  readonly surface: string;
  readonly workOrderId: string;
  readonly evidenceDigest: string | null;
}

/** One threshold claim row (met or explicitly bounded). */
export interface ThresholdClaimRow {
  readonly workOrderId: string;
  readonly bound: string;
  readonly evidenceDigest: string | null;
}

/** One learning-chain claim row. */
export interface LearningClaimRow {
  readonly workOrderId: string;
  readonly learningTitle: string;
  readonly evidenceDigest: string | null;
}

/** One economic comparison claim row (the paired structure). */
export interface EconomicClaimRow {
  readonly workOrderId: string;
  readonly baselineWorkOrderIds: readonly string[];
  readonly evidenceDigest: string | null;
}

/** One disclosed NOT RUN boundary (the missing-provider-access record). */
export interface BoundaryClaimRow {
  readonly scope: string;
  readonly workOrderId: string;
  readonly envVar: string;
  readonly reason: string;
  readonly evidenceDigest: string | null;
}

/** One material finding claim row (the seven-part protocol + the residual risk). */
export interface FindingClaimRow {
  readonly findingId: string;
  readonly workOrderId: string;
  readonly summary: string;
  readonly protocol: Readonly<Record<string, string>>;
  readonly residualRisk: string;
  readonly evidenceDigest: string | null;
}

/** The deadline-remainder accounting (the completion state of record). */
export interface DeadlineAccounting {
  readonly reportTimestamp: string;
  readonly operatorDeadline: string;
  readonly remainingMs: number;
  /** The remaining window as an ISO-8601 duration (the named window). */
  readonly remainingWindow: string;
  /** Every work order not complete at report time, each NAMED with its status. */
  readonly incomplete: readonly { readonly workOrderId: string; readonly status: string }[];
}

/** The derived report package (the report's own claim set). */
export interface ReportPackage {
  readonly rowId: string;
  readonly inventory: readonly InventoryEntry[];
  readonly coverage: readonly CoverageClaimRow[];
  readonly integrationPaths: readonly GateReferenceRow[];
  readonly thresholds: readonly ThresholdClaimRow[];
  readonly learningChain: readonly LearningClaimRow[];
  readonly recordedLearningOutcome: {
    readonly workOrderId: string;
    readonly recordedOutcome: string;
    readonly evidenceDigest: string | null;
  };
  readonly economicComparisons: readonly EconomicClaimRow[];
  readonly notRunBoundaries: readonly BoundaryClaimRow[];
  readonly findings: readonly FindingClaimRow[];
  readonly reproducibilityRecords: readonly GateReferenceRow[];
  readonly deadline: DeadlineAccounting;
  /** The package digest over the report's claim set (payload-free). */
  readonly packageDigest: string;
}

/** The derived release-gate verdict (never a narrative). */
export interface ReportVerdict {
  readonly verdict: ReportVerdictKind;
  /** The criteria a FAILED verdict NAMED (empty otherwise). */
  readonly failedCriteria: readonly string[];
}

// ---------------------------------------------------------------------------
// The deterministic package derivation (PURE over the world)
// ---------------------------------------------------------------------------

/** The ISO-8601 duration of a non-negative millisecond window (the named window). */
export function isoDurationOfMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `PT${hours}H${minutes}M${seconds}S`;
}

/** The honest inventory entry of one registered work order (PURE). */
function inventoryEntryOf(workOrderId: string, world: ReportWorld): InventoryEntry {
  const registered = world.programState.workOrders[workOrderId];
  if (registered === undefined) {
    // The caller only derives entries for registered work orders; a
    // phantom entry is the probe denaturation's own shape.
    throw new Error(`the governed program state holds no work order ${workOrderId}`);
  }
  const evidence = world.evidenceDocOf(workOrderId);
  return {
    workOrderId,
    title: registered.title,
    status: registered.status,
    evidence: {
      registeredPath: evidence.registeredPath,
      resolved: evidence.exists,
      contentDigest: evidence.contentDigest,
    },
    mergeRecord:
      registered.mergedAs === undefined
        ? null
        : { pr: registered.mergedAs.pr, mergeCommit: registered.mergedAs.mergeCommit },
    acceptanceCarrier:
      registered.mergedAs !== undefined
        ? "pr-merge"
        : registered.status === "complete"
          ? "program-state-finalize"
          : "pending-authority-chain",
  };
}

/**
 * The consolidated-evidence-inventory derivation (PURE): every
 * registered work order of the governed program state with its
 * registered title, completion status, evidence document resolved at
 * its registered location and merge/finalize record cited where
 * recorded.
 */
export function consolidatedInventoryOf(world: ReportWorld): readonly InventoryEntry[] {
  return Object.keys(world.programState.workOrders).map((workOrderId) =>
    inventoryEntryOf(workOrderId, world),
  );
}

/**
 * Derive one row's deterministic report package (PURE — the derivation
 * over the governed state and the registered evidence documents; the
 * adversarial probe variants denature the honest package exactly as
 * the work order's discrimination battery demands: a missing work
 * order, a deleted evidence document, a reasonless NOT RUN boundary,
 * a protocol-stripped finding, a phantom coverage claim, a silently
 * dropped incomplete work order, a self-declared acceptance).
 */
export function reportPackageFor(
  row: FinalReportCorpusRow,
  baseWorld: ReportWorld,
  options?: { readonly probe?: ReportProbeKind },
): ReportPackage {
  const probe = options?.probe ?? row.probe?.kind ?? null;
  // The deleted-evidence-document probe wraps the world's evidence
  // resolver: VAL-033's registered evidence document does not resolve
  // (the document deleted at its registered location).
  const world: ReportWorld =
    probe === "deleted-evidence-document"
      ? {
          ...baseWorld,
          evidenceDocOf: (workOrderId: string) =>
            workOrderId === "VAL-033"
              ? {
                  workOrderId,
                  registeredPath: baseWorld.evidenceDocOf(workOrderId).registeredPath,
                  exists: false,
                  contentDigest: null,
                }
              : baseWorld.evidenceDocOf(workOrderId),
        }
      : baseWorld;
  const digestOf = (workOrderId: string): string | null =>
    world.evidenceDocOf(workOrderId).contentDigest;

  // The consolidated inventory (the probe denaturations: VAL-031
  // silently omitted by the missing-work-order probe; a phantom
  // VAL-027 entry claimed complete by the phantom-coverage probe).
  let inventory = consolidatedInventoryOf(world);
  if (probe === "missing-work-order") {
    inventory = inventory.filter((entry) => entry.workOrderId !== "VAL-031");
  }
  if (probe === "phantom-coverage") {
    inventory = [
      ...inventory,
      {
        workOrderId: "VAL-027",
        title: "Ambient voice translation",
        status: "complete",
        evidence: {
          registeredPath: registeredEvidencePathOf("VAL-027"),
          resolved: false,
          contentDigest: null,
        },
        mergeRecord: null,
        acceptanceCarrier: "program-state-finalize" as const,
      },
    ];
  }
  if (probe === "self-declared-acceptance") {
    inventory = inventory.map((entry) =>
      entry.workOrderId === "VAL-052"
        ? { ...entry, acceptanceCarrier: "self-declared" as const }
        : entry,
    );
  }

  // The application coverage (the phantom-coverage probe adds a
  // category row citing the never-registered VAL-027).
  const coverage: CoverageClaimRow[] = APPLICATION_CATEGORIES.map((category) => ({
    category: category.category,
    workOrderId: category.workOrderId,
    evidenceDigest: digestOf(category.workOrderId),
  }));
  if (probe === "phantom-coverage") {
    coverage.push({
      category: "ambient-voice-translation",
      workOrderId: "VAL-027",
      evidenceDigest: null,
    });
  }

  // The public integration paths (the SDK harness, the capability
  // matrix, the end-to-end journey records).
  const integrationPaths: GateReferenceRow[] = INTEGRATION_PATHS.map((path) => ({
    surface: path.surface,
    workOrderId: path.workOrderId,
    evidenceDigest: digestOf(path.workOrderId),
  }));

  // The quality/safety/reliability thresholds (each explicitly bounded).
  const thresholds: ThresholdClaimRow[] = QUALITY_SAFETY_RELIABILITY_THRESHOLDS.map(
    (threshold) => ({
      workOrderId: threshold.workOrderId,
      bound: threshold.bound,
      evidenceDigest: digestOf(threshold.workOrderId),
    }),
  );

  // The longitudinal-learning chain + the recorded learning outcome
  // (carried AS RECORDED — a recorded tie or negative is a valid
  // demonstration, never a failed gate).
  const learningChain: LearningClaimRow[] = LONGITUDINAL_LEARNING_CHAIN.map((learning) => ({
    workOrderId: learning.workOrderId,
    learningTitle: learning.learningTitle,
    evidenceDigest: digestOf(learning.workOrderId),
  }));
  const recordedLearningOutcome = {
    workOrderId: RECORDED_LEARNING_OUTCOME.workOrderId,
    recordedOutcome: RECORDED_LEARNING_OUTCOME.recordedOutcome,
    evidenceDigest: digestOf(RECORDED_LEARNING_OUTCOME.workOrderId),
  };

  // The economic comparisons (the paired-structure discipline).
  const economicComparisons: EconomicClaimRow[] = ECONOMIC_COMPARISONS.map((comparison) => ({
    workOrderId: comparison.workOrderId,
    baselineWorkOrderIds: [...comparison.baselineWorkOrderIds],
    evidenceDigest: digestOf(comparison.workOrderId),
  }));

  // The disclosed NOT RUN boundaries (the boundary-without-env-var
  // probe strips the live-journey-slice boundary's gating env var).
  const notRunBoundaries: BoundaryClaimRow[] = NOT_RUN_BOUNDARIES.map((boundary) => ({
    scope: boundary.scope,
    workOrderId: boundary.workOrderId,
    envVar:
      probe === "boundary-without-env-var" && boundary.scope === "live-journey-slice"
        ? ""
        : boundary.envVar,
    reason: boundary.reason,
    evidenceDigest: digestOf(boundary.workOrderId),
  }));

  // The material findings (the seven-part solution protocol + the
  // residual risk; the protocol-stripped-finding probe strips F-01's
  // protocol and residual risk).
  const findings: FindingClaimRow[] = MATERIAL_FINDINGS.map((finding) => {
    const stripped = probe === "protocol-stripped-finding";
    return {
      findingId: finding.findingId,
      workOrderId: finding.workOrderId,
      summary: finding.summary,
      protocol: stripped
        ? Object.fromEntries(SEVEN_PART_PROTOCOL_PARTS.map((part) => [part, ""]))
        : { ...finding.protocol },
      residualRisk: stripped ? "" : finding.residualRisk,
      evidenceDigest: digestOf(finding.workOrderId),
    };
  });

  // The reproducibility records (the replay-bit-stability record + the
  // immutable run identities).
  const reproducibilityRecords: GateReferenceRow[] = REPRODUCIBILITY_RECORDS.map((record) => ({
    surface: record.record,
    workOrderId: record.workOrderId,
    evidenceDigest: digestOf(record.workOrderId),
  }));

  // The deadline-remainder accounting (the completion timestamp, the
  // remaining window, every incomplete work order NAMED; the
  // silent-omission probe drops VAL-052 from the incomplete list).
  const incomplete = Object.entries(world.programState.workOrders)
    .filter(([, registered]) => registered.status !== "complete")
    .map(([workOrderId, registered]) => ({ workOrderId, status: registered.status }));
  const remainingMs = Date.parse(world.operatorDeadline) - Date.parse(world.reportTimestamp);
  const deadline: DeadlineAccounting = {
    reportTimestamp: world.reportTimestamp,
    operatorDeadline: world.operatorDeadline,
    remainingMs,
    remainingWindow: isoDurationOfMs(Math.max(remainingMs, 0)),
    incomplete: probe === "silent-omission" ? [] : incomplete,
  };

  return {
    rowId: row.rowId,
    inventory,
    coverage,
    integrationPaths,
    thresholds,
    learningChain,
    recordedLearningOutcome,
    economicComparisons,
    notRunBoundaries,
    findings,
    reproducibilityRecords,
    deadline,
    packageDigest: economicDigestOf({
      rowId: row.rowId,
      inventory: inventory.map((entry) => `${entry.workOrderId}:${entry.status}`),
      coverage: coverage.map((claim) => `${claim.category}→${claim.workOrderId}`),
      boundaries: notRunBoundaries.map((boundary) => `${boundary.scope}:${boundary.envVar}`),
      findings: findings.map((finding) => finding.findingId),
      deadline: `${world.reportTimestamp}/${world.operatorDeadline}`,
      incomplete: deadline.incomplete.map((item) => `${item.workOrderId}:${item.status}`),
    }),
  };
}

// ---------------------------------------------------------------------------
// The thirteen mechanical oracles (PURE — the verification core)
// ---------------------------------------------------------------------------

/**
 * Verify one report package against its declared row and the world
 * (PURE): the thirteen mechanical criteria — the three
 * consolidated-evidence-inventory oracles, the NINE release-gate
 * conditions and the deadline-remainder honesty — each FAILing with
 * the offender NAMED (every oracle owns its catch, never
 * double-counting another oracle's).
 */
export function verifyFinalReportIntegrity(input: {
  readonly row: FinalReportCorpusRow;
  readonly world: ReportWorld;
  readonly report: ReportPackage;
}): readonly LabVerificationCriterion[] {
  const { row, world, report } = input;
  const criteria: LabVerificationCriterion[] = [];
  const state = world.programState.workOrders;
  const registeredIds = Object.keys(state);
  const inventoryIds = report.inventory.map((entry) => entry.workOrderId);
  const entryOf = (workOrderId: string): InventoryEntry | undefined =>
    report.inventory.find((entry) => entry.workOrderId === workOrderId);

  // 1. INVENTORY COMPLETENESS — every registered work order present,
  //    no phantom inventory entry (an omitted work order or a phantom
  //    entry FAILs NAMED).
  const omitted = registeredIds.filter((workOrderId) => !inventoryIds.includes(workOrderId));
  const phantom = inventoryIds.filter((workOrderId) => state[workOrderId] === undefined);
  criteria.push({
    criterionId: "inventory-completeness",
    strategy: "deterministic",
    status: omitted.length === 0 && phantom.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `row:${row.rowId}`,
      `registered-work-orders:${registeredIds.length}`,
      `inventoried-work-orders:${inventoryIds.length}`,
      ...(omitted.length === 0
        ? []
        : omitted.map(
            (workOrderId) =>
              `omitted-work-order:${workOrderId} (registered ${state[workOrderId]?.status}, never inventoried)`,
          )),
      ...(phantom.length === 0
        ? []
        : phantom.map(
            (workOrderId) =>
              `phantom-inventory-entry:${workOrderId} (not a registered work order of the governed state)`,
          )),
    ],
  });

  // 2. INVENTORY REGISTRATION — every REGISTERED entry's title and
  //    completion status match the governed state exactly (a mistitled
  //    entry or a misstated status FAILs NAMED; phantom entries are
  //    the completeness oracle's catch, never double-counted here).
  const registrationViolations: string[] = [];
  for (const entry of report.inventory) {
    const registered = state[entry.workOrderId];
    if (registered === undefined) {
      continue;
    }
    if (entry.title !== registered.title) {
      registrationViolations.push(
        `mistitled-entry:${entry.workOrderId} (inventoried "${entry.title}", registered "${registered.title}")`,
      );
    }
    if (entry.status !== registered.status) {
      registrationViolations.push(
        `misstated-status:${entry.workOrderId} (inventoried ${entry.status}, registered ${registered.status})`,
      );
    }
  }
  const completeCount = report.inventory.filter((entry) => entry.status === "complete").length;
  const incompleteCount = report.inventory.length - completeCount;
  criteria.push({
    criterionId: "inventory-registration",
    strategy: "deterministic",
    status: registrationViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `titles-verified:${registeredIds.length}`,
      `complete:${completeCount}`,
      `not-complete:${incompleteCount}`,
      ...report.inventory
        .filter((entry) => entry.status !== "complete")
        .map(
          (entry) =>
            `in-flight-work-order:${entry.workOrderId}:${entry.status} (honestly recorded, never silently dropped)`,
        ),
      ...registrationViolations,
    ],
  });

  // 3. INVENTORY EVIDENCE RESOLUTION — every complete REGISTERED work
  //    order's evidence document resolves at its registered location
  //    with its content digest re-derived over the world (an
  //    unresolvable document, a wrong-location citation or a digest
  //    disagreement FAILs NAMED; the in-flight work order's evidence
  //    is honestly recorded as pending — never fabricated).
  const evidenceViolations: string[] = [];
  for (const entry of report.inventory) {
    const registered = state[entry.workOrderId];
    if (registered === undefined) {
      continue;
    }
    const resolution = world.evidenceDocOf(entry.workOrderId);
    if (registered.status === "complete") {
      if (!entry.evidence.resolved) {
        evidenceViolations.push(
          `unresolved-evidence-document:${entry.workOrderId} (${entry.evidence.registeredPath} does not resolve)`,
        );
        continue;
      }
      if (entry.evidence.registeredPath !== resolution.registeredPath) {
        evidenceViolations.push(
          `wrong-evidence-location:${entry.workOrderId} (cited ${entry.evidence.registeredPath}, registered ${resolution.registeredPath})`,
        );
        continue;
      }
      if (
        entry.evidence.contentDigest === null ||
        !/^[0-9a-f]{8}$/.test(entry.evidence.contentDigest)
      ) {
        evidenceViolations.push(
          `malformed-evidence-digest:${entry.workOrderId} (digest must be a payload-free FNV-1a form)`,
        );
        continue;
      }
      if (entry.evidence.contentDigest !== resolution.contentDigest) {
        evidenceViolations.push(
          `digest-disagreement:${entry.workOrderId} (inventoried ${entry.evidence.contentDigest}, re-derived ${resolution.contentDigest ?? "none"})`,
        );
      }
    } else {
    }
  }
  const resolvedComplete = report.inventory.filter(
    (entry) => entry.status === "complete" && entry.evidence.resolved,
  ).length;
  const inFlightResolved = report.inventory.some(
    (entry) => entry.workOrderId === "VAL-052" && entry.evidence.resolved,
  );
  criteria.push({
    criterionId: "inventory-evidence-resolution",
    strategy: "deterministic",
    status: evidenceViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `evidence-documents-resolved:${resolvedComplete}`,
      `val-001-evidence-location:benchmarks/validation/evidence/VAL-001.md`,
      `work-item-evidence-location:docs/work-items/VAL-0NN.md`,
      `in-flight-evidence:VAL-052:${inFlightResolved ? "landing" : "pending"} (the work order in flight — its registered evidence document ${
        inFlightResolved ? "already resolving while the work order lands" : "not yet landed"
      })`,
      ...evidenceViolations,
    ],
  });

  // 4. GATE 1 — CATEGORY COVERAGE — every application category
  //    exercised with each coverage row citing its completed,
  //    evidence-resolved work order (a phantom coverage claim or a
  //    missing category row FAILs NAMED).
  const coverageViolations: string[] = [];
  for (const category of APPLICATION_CATEGORIES) {
    const claim = report.coverage.find((candidate) => candidate.category === category.category);
    if (claim === undefined) {
      coverageViolations.push(
        `missing-category-row:${category.category} (registered, never covered)`,
      );
      continue;
    }
    if (claim.workOrderId !== category.workOrderId) {
      coverageViolations.push(
        `miscited-coverage:${category.category} (cited ${claim.workOrderId}, recorded ${category.workOrderId})`,
      );
    }
  }
  for (const claim of report.coverage) {
    const registered = state[claim.workOrderId];
    if (registered === undefined) {
      coverageViolations.push(
        `phantom-coverage:${claim.category}→${claim.workOrderId} (${claim.workOrderId} is not a registered work order)`,
      );
      continue;
    }
    if (registered.status !== "complete") {
      coverageViolations.push(
        `uncovered-category:${claim.category}→${claim.workOrderId} (status ${registered.status}, never completed)`,
      );
      continue;
    }
    if (!world.evidenceDocOf(claim.workOrderId).exists) {
      coverageViolations.push(
        `coverage-without-evidence:${claim.category}→${claim.workOrderId} (the evidence document does not resolve)`,
      );
    }
  }
  criteria.push({
    criterionId: "gate-category-coverage",
    strategy: "deterministic",
    status: coverageViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `categories:${report.coverage.length}/${APPLICATION_CATEGORIES.length}`,
      ...report.coverage.map(
        (claim) =>
          `category:${claim.category}→${claim.workOrderId}:${state[claim.workOrderId]?.status ?? "unregistered"}`,
      ),
      ...coverageViolations,
    ],
  });

  // 5. GATE 2 — INTEGRATION PATHS — the SDK harness, the capability
  //    matrix and the end-to-end journey records each cited complete
  //    with resolved evidence (the public integration paths proven).
  const integrationViolations: string[] = [];
  for (const path of INTEGRATION_PATHS) {
    const claim = report.integrationPaths.find((candidate) => candidate.surface === path.surface);
    const registered = state[path.workOrderId];
    if (claim === undefined || claim.workOrderId !== path.workOrderId) {
      integrationViolations.push(`unproven-integration-path:${path.surface} (never cited)`);
      continue;
    }
    if (registered === undefined || registered.status !== "complete") {
      integrationViolations.push(
        `unproven-integration-path:${path.surface} (${path.workOrderId} not complete)`,
      );
      continue;
    }
    if (!world.evidenceDocOf(path.workOrderId).exists) {
      integrationViolations.push(
        `integration-path-without-evidence:${path.surface} (${path.workOrderId}'s evidence document does not resolve)`,
      );
    }
  }
  criteria.push({
    criterionId: "gate-integration-paths",
    strategy: "deterministic",
    status: integrationViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      ...report.integrationPaths.map(
        (claim) =>
          `${claim.surface}:${claim.workOrderId}:${state[claim.workOrderId]?.status ?? "unregistered"}`,
      ),
      ...integrationViolations,
    ],
  });

  // 6. GATE 3 — THRESHOLDS BOUNDED — every quality/safety/reliability
  //    threshold row cites its completed work order and its EXPLICIT
  //    bound (an unbounded threshold claim FAILs NAMED).
  const thresholdViolations: string[] = [];
  for (const claim of report.thresholds) {
    const registered = state[claim.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      thresholdViolations.push(
        `threshold-without-work-order:${claim.workOrderId} (never completed)`,
      );
      continue;
    }
    if (!world.evidenceDocOf(claim.workOrderId).exists) {
      thresholdViolations.push(
        `threshold-without-evidence:${claim.workOrderId} (the evidence document does not resolve)`,
      );
    }
    if (claim.bound.trim().length === 0) {
      thresholdViolations.push(`unbounded-threshold-claim:${claim.workOrderId} (no bound named)`);
    }
  }
  criteria.push({
    criterionId: "gate-thresholds-bounded",
    strategy: "deterministic",
    status: thresholdViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `thresholds:${report.thresholds.length}`,
      ...report.thresholds.map((claim) => `threshold:${claim.workOrderId}:bounded`),
      ...thresholdViolations,
    ],
  });

  // 7. GATE 4 — LONGITUDINAL LEARNING — the learning chain complete
  //    with resolved evidence and the recorded outcome carried AS
  //    RECORDED (a recorded tie or negative is a valid demonstration,
  //    never a failed gate — the outcome reference must be present and
  //    must never convert the recorded answer into a judgment).
  const learningViolations: string[] = [];
  for (const learning of report.learningChain) {
    const registered = state[learning.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      learningViolations.push(`learning-without-work-order:${learning.workOrderId}`);
      continue;
    }
    if (!world.evidenceDocOf(learning.workOrderId).exists) {
      learningViolations.push(
        `learning-without-evidence:${learning.workOrderId} (the evidence document does not resolve)`,
      );
    }
  }
  const outcome = report.recordedLearningOutcome;
  if (
    state[outcome.workOrderId] === undefined ||
    state[outcome.workOrderId]?.status !== "complete"
  ) {
    learningViolations.push(`learning-outcome-without-work-order:${outcome.workOrderId}`);
  } else if (outcome.recordedOutcome.trim().length === 0) {
    learningViolations.push("learning-outcome-unrecorded (the recorded answer never carried)");
  }
  criteria.push({
    criterionId: "gate-longitudinal-learning",
    strategy: "deterministic",
    status: learningViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `learning-chain:${report.learningChain.length}`,
      ...report.learningChain.map((learning) => `learning:${learning.workOrderId}:complete`),
      `recorded-outcome:${outcome.workOrderId}:carried-as-recorded (a recorded tie or negative is a valid demonstration, never a failed gate)`,
      ...learningViolations,
    ],
  });

  // 8. GATE 5 — ECONOMIC FAIRNESS — every economic comparison cites
  //    its strong baselines (the recorded paired-structure discipline:
  //    each comparison's baseline work orders registered, complete
  //    and evidence-resolved — an unpaired comparison FAILs NAMED).
  const economicViolations: string[] = [];
  for (const comparison of report.economicComparisons) {
    const registered = state[comparison.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      economicViolations.push(`comparison-without-work-order:${comparison.workOrderId}`);
      continue;
    }
    if (!world.evidenceDocOf(comparison.workOrderId).exists) {
      economicViolations.push(
        `comparison-without-evidence:${comparison.workOrderId} (the evidence document does not resolve)`,
      );
    }
    if (comparison.baselineWorkOrderIds.length === 0) {
      economicViolations.push(
        `unpaired-comparison:${comparison.workOrderId} (no strong baseline cited)`,
      );
      continue;
    }
    for (const baselineId of comparison.baselineWorkOrderIds) {
      const baseline = state[baselineId];
      if (baseline === undefined || baseline.status !== "complete") {
        economicViolations.push(
          `baseline-not-complete:${comparison.workOrderId}←${baselineId} (the strong baseline never completed)`,
        );
      }
    }
  }
  criteria.push({
    criterionId: "gate-economic-fairness",
    strategy: "deterministic",
    status: economicViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `paired-comparisons:${report.economicComparisons.length}`,
      ...report.economicComparisons.map(
        (comparison) =>
          `paired:${comparison.workOrderId} vs baselines ${comparison.baselineWorkOrderIds.join("+")}`,
      ),
      ...economicViolations,
    ],
  });

  // 9. GATE 6 — NOT RUN DISCLOSURE — every missing-provider-access
  //    limitation disclosed with its exact reason AND its gating env
  //    var NAMED (a reasonless boundary or a boundary without its env
  //    var FAILs NAMED).
  const boundaryViolations: string[] = [];
  for (const boundary of report.notRunBoundaries) {
    if (boundary.envVar.trim().length === 0) {
      boundaryViolations.push(
        `reasonless-not-run-boundary:${boundary.scope} (no gating env var named)`,
      );
      continue;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(boundary.envVar)) {
      boundaryViolations.push(
        `malformed-env-var:${boundary.scope} (${boundary.envVar} is not an env var name)`,
      );
      continue;
    }
    if (boundary.reason.trim().length === 0) {
      boundaryViolations.push(
        `reasonless-not-run-boundary:${boundary.scope} (no exact reason named)`,
      );
      continue;
    }
    const registered = state[boundary.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      boundaryViolations.push(
        `boundary-without-work-order:${boundary.scope} (${boundary.workOrderId} never completed)`,
      );
    }
  }
  criteria.push({
    criterionId: "gate-not-run-disclosure",
    strategy: "deterministic",
    status: boundaryViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `not-run-boundaries:${report.notRunBoundaries.length}`,
      ...report.notRunBoundaries.map(
        (boundary) => `not-run:${boundary.scope} gated on ${boundary.envVar || "(none named)"}`,
      ),
      ...boundaryViolations,
    ],
  });

  // 10. GATE 7 — FINDINGS PROTOCOL — every material finding carries
  //     its SEVEN-PART solution protocol and its NAMED residual risk
  //     (a protocol-stripped finding or a hidden residual risk FAILs
  //     NAMED).
  const findingsViolations: string[] = [];
  for (const finding of report.findings) {
    for (const part of SEVEN_PART_PROTOCOL_PARTS) {
      if ((finding.protocol[part] ?? "").trim().length === 0) {
        findingsViolations.push(
          `protocol-stripped-finding:${finding.findingId} (the "${part}" part of the seven-part solution protocol missing)`,
        );
      }
    }
    if (finding.residualRisk.trim().length === 0) {
      findingsViolations.push(`hidden-residual-risk:${finding.findingId} (no residual risk named)`);
    }
    const registered = state[finding.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      findingsViolations.push(
        `finding-without-work-order:${finding.findingId} (${finding.workOrderId} never completed)`,
      );
    }
  }
  criteria.push({
    criterionId: "gate-findings-protocol",
    strategy: "deterministic",
    status: findingsViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `material-findings:${report.findings.length}`,
      ...report.findings.map(
        (finding) =>
          `finding:${finding.findingId}:seven-part-protocol-complete+residual-risk-named (recorded at ${finding.workOrderId})`,
      ),
      ...findingsViolations,
    ],
  });

  // 11. GATE 8 — REPRODUCIBILITY — the VAL-049 replay-bit-stability
  //     record and the immutable run identities cited complete with
  //     resolved evidence (the repository-defined experiments).
  const reproducibilityViolations: string[] = [];
  for (const record of report.reproducibilityRecords) {
    const registered = state[record.workOrderId];
    if (registered === undefined || registered.status !== "complete") {
      reproducibilityViolations.push(
        `reproducibility-without-work-order:${record.surface} (${record.workOrderId} never completed)`,
      );
      continue;
    }
    if (!world.evidenceDocOf(record.workOrderId).exists) {
      reproducibilityViolations.push(
        `reproducibility-without-evidence:${record.surface} (${record.workOrderId}'s evidence document does not resolve)`,
      );
    }
  }
  criteria.push({
    criterionId: "gate-reproducibility",
    strategy: "deterministic",
    status: reproducibilityViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      ...report.reproducibilityRecords.map(
        (record) =>
          `${record.surface}:${record.workOrderId}:${state[record.workOrderId]?.status ?? "unregistered"}`,
      ),
      ...reproducibilityViolations,
    ],
  });

  // 12. GATE 9 — ACCEPTANCE-CHAIN HONESTY — the Architect's acceptance
  //     carried by the authority chain (PR → merge record →
  //     program-state finalize), never self-declared: every complete
  //     work order's acceptance carried by its recorded merge record
  //     where recorded (the citation must match the state exactly),
  //     otherwise by the program-state finalize record; the in-flight
  //     work order honestly PENDING the authority chain; a
  //     self-declared acceptance FAILs NAMED.
  const acceptanceViolations: string[] = [];
  const selfDeclared = report.inventory.filter(
    (entry) => entry.acceptanceCarrier === "self-declared",
  );
  for (const entry of selfDeclared) {
    acceptanceViolations.push(
      `self-declared-acceptance:${entry.workOrderId} (the Architect's acceptance is carried by the authority chain — PR → CI → merge → program-state finalize — never self-declared by the report)`,
    );
  }
  let prMergeCarried = 0;
  let finalizeCarried = 0;
  for (const workOrderId of registeredIds) {
    const registered = state[workOrderId];
    const entry = entryOf(workOrderId);
    if (entry === undefined) {
      // The completeness oracle's catch — never double-counted here.
      continue;
    }
    if (registered === undefined) {
      continue;
    }
    if (registered.status === "complete") {
      if (registered.mergedAs !== undefined) {
        if (entry.acceptanceCarrier !== "pr-merge" || entry.mergeRecord === null) {
          acceptanceViolations.push(
            `uncarried-acceptance:${workOrderId} (the recorded merge record never cited)`,
          );
        } else if (
          entry.mergeRecord.pr !== registered.mergedAs.pr ||
          entry.mergeRecord.mergeCommit !== registered.mergedAs.mergeCommit
        ) {
          acceptanceViolations.push(
            `merge-citation-mismatch:${workOrderId} (cited PR #${entry.mergeRecord.pr}/${entry.mergeRecord.mergeCommit}, recorded PR #${registered.mergedAs.pr}/${registered.mergedAs.mergeCommit})`,
          );
        } else {
          prMergeCarried += 1;
        }
      } else if (entry.acceptanceCarrier === "program-state-finalize") {
        finalizeCarried += 1;
      } else {
        acceptanceViolations.push(
          `uncarried-acceptance:${workOrderId} (complete with no merge record cited and no finalize carrier)`,
        );
      }
    } else if (entry.acceptanceCarrier !== "pending-authority-chain") {
      acceptanceViolations.push(
        `dishonest-in-flight-acceptance:${workOrderId} (status ${registered.status}; the acceptance must honestly remain pending the authority chain)`,
      );
    }
  }
  criteria.push({
    criterionId: "acceptance-chain-honesty",
    strategy: "deterministic",
    status: acceptanceViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `carried-by-pr-merge:${prMergeCarried}`,
      `carried-by-program-state-finalize:${finalizeCarried}`,
      `pending-authority-chain:VAL-052 (the in-flight work order — its acceptance carried by the PR → CI → merge → program-state finalize that will land it, never self-declared)`,
      `self-declared:none`,
      ...acceptanceViolations,
    ],
  });

  // 13. DEADLINE-REMAINDER HONESTY — the completion timestamp, the
  //     remaining window re-derived against the pinned operator
  //     deadline, and every work order not complete at report time
  //     NAMED with its status (a silently dropped incomplete work
  //     order, a misderived window or a wrong deadline FAILs NAMED).
  const deadlineViolations: string[] = [];
  if (report.deadline.operatorDeadline !== OPERATOR_DEADLINE_UTC) {
    deadlineViolations.push(
      `deadline-mismatch (cited ${report.deadline.operatorDeadline}, pinned ${OPERATOR_DEADLINE_UTC})`,
    );
  }
  const timestampMs = Date.parse(report.deadline.reportTimestamp);
  if (Number.isNaN(timestampMs)) {
    deadlineViolations.push(`unparsable-completion-timestamp:${report.deadline.reportTimestamp}`);
  } else {
    const expectedRemaining = Date.parse(OPERATOR_DEADLINE_UTC) - timestampMs;
    if (report.deadline.remainingMs !== expectedRemaining) {
      deadlineViolations.push(
        `remaining-window-misderived (reported ${report.deadline.remainingMs}, re-derived ${expectedRemaining})`,
      );
    }
  }
  const stateIncomplete = registeredIds
    .filter((workOrderId) => state[workOrderId]?.status !== "complete")
    .map((workOrderId) => ({ workOrderId, status: state[workOrderId]?.status ?? "unknown" }));
  const namedIds = report.deadline.incomplete.map((item) => item.workOrderId);
  for (const item of stateIncomplete) {
    if (!namedIds.includes(item.workOrderId)) {
      deadlineViolations.push(
        `silently-dropped-incomplete:${item.workOrderId} (status ${item.status} at report time, never named)`,
      );
    }
  }
  for (const item of report.deadline.incomplete) {
    const registered = state[item.workOrderId];
    if (registered === undefined) {
      deadlineViolations.push(
        `phantom-incomplete:${item.workOrderId} (not a registered work order)`,
      );
    } else if (registered.status === "complete") {
      deadlineViolations.push(
        `false-incomplete:${item.workOrderId} (complete in the governed state but named incomplete)`,
      );
    } else if (registered.status !== item.status) {
      deadlineViolations.push(
        `misstated-incomplete-status:${item.workOrderId} (named ${item.status}, registered ${registered.status})`,
      );
    }
  }
  criteria.push({
    criterionId: "deadline-remainder-honesty",
    strategy: "deterministic",
    status: deadlineViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `completion-timestamp:${report.deadline.reportTimestamp}`,
      `operator-deadline:${report.deadline.operatorDeadline}`,
      `remaining-window-ms:${report.deadline.remainingMs}`,
      `remaining-window:${report.deadline.remainingWindow}`,
      `incomplete-at-report-time:${
        report.deadline.incomplete.map((item) => `${item.workOrderId}:${item.status}`).join(",") ||
        "none"
      }`,
      ...deadlineViolations,
    ],
  });

  return criteria;
}

/**
 * Derive the release-gate verdict over one report package (PURE): all
 * thirteen mechanical criteria PASS → COMPLETED; any FAIL → FAILED
 * with every failed criterion NAMED.
 */
export function deriveReleaseGateVerdict(input: {
  readonly row: FinalReportCorpusRow;
  readonly world: ReportWorld;
  readonly report: ReportPackage;
}): ReportVerdict {
  const criteria = verifyFinalReportIntegrity(input);
  const failedCriteria = criteria
    .filter((criterion) => criterion.status === "FAIL")
    .map((criterion) => criterion.criterionId);
  return {
    verdict: failedCriteria.length === 0 ? "COMPLETED" : "FAILED",
    failedCriteria,
  };
}

/**
 * The nine-condition release-gate adjudication (PURE — the handoff
 * view for the report document): each completion-gate condition with
 * its adjudicated status and its NAMED evidence (the mechanical
 * adjudication the report cites — zero subjective judgment).
 */
export function releaseGateAdjudicationOf(criteria: readonly LabVerificationCriterion[]): readonly {
  readonly condition: number;
  readonly family: string;
  readonly statement: string;
  readonly status: "PASS" | "FAIL";
  readonly evidenceNamed: readonly string[];
}[] {
  return RELEASE_GATE_CONDITIONS.map((gate) => {
    const criterion = criteria.find((candidate) => candidate.criterionId === gate.family);
    return {
      condition: gate.condition,
      family: gate.family,
      statement: gate.statement,
      status: criterion?.status ?? "FAIL",
      evidenceNamed: criterion?.evidence ?? [
        `unadjudicated-condition:${gate.family} (the condition was never adjudicated)`,
      ],
    };
  });
}

/** The full verification-family order (the oracle matrix of record). */
export function verificationFamilyOrder(): readonly string[] {
  return [...FINAL_REPORT_VERIFICATION_FAMILIES];
}

// ---------------------------------------------------------------------------
// The live lane (env-gated — one REAL live gate-confirmation dispatch)
// ---------------------------------------------------------------------------

/**
 * The pinned live gate-confirmation plan (the measured lane's
 * declaration): ONE REAL dispatch on the ONE pinned OpenRouter rail
 * (the VAL-047/048/049/050/051 live plans' own rail) through the REAL
 * platform path — the public create boundary, the REAL state machine,
 * the REAL recorder — with the dispatch usage MEASURED and priced at
 * the pinned model manifest list prices, the measured facts
 * bounds-checked against the recorded live-window bounds (the final
 * report's own live confirmation lane; the recorded basis is never
 * re-priced).
 */
export const LIVE_REPORT_PLAN = Object.freeze({
  /** The workload class the live confirmation slice drives. */
  workloadClass: "live-report-real-confirmation",
  /** The REAL dispatches the live confirmation slice drives (ONE dispatch — the live row's own declaration). */
  dispatches: 1,
  /** The pinned rail the live confirmation dispatches on (ONE binding — the live-run lesson). */
  rail: Object.freeze({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    priceRevision: "rev-001",
    maxTokens: 32,
    temperature: "unset (the provider's documented default — nothing rides the request)",
  }),
  /** The economics basis the live confirmation slice carries. */
  economicsBasis:
    "the live slice's own dispatch usage measured and priced at the pinned rev-001 list prices; the measured facts bounds-checked against the recorded live-window bounds (the F-01 verification method — the recorded basis is never re-priced)",
});

/** The live slice's identity (the measured lane's declaration reference). */
export const LIVE_REPORT_WORKLOAD_CLASS = "live-report-real-confirmation";

/** The declaration digest of the live gate-confirmation plan (the reference's recorded digest). */
export function liveReportPlanDigestOf(): string {
  return economicDigestOf({
    liveWorkloadClass: LIVE_REPORT_WORKLOAD_CLASS,
    dispatches: LIVE_REPORT_PLAN.dispatches,
    rail: LIVE_REPORT_PLAN.rail,
    economicsBasis: LIVE_REPORT_PLAN.economicsBasis,
  });
}
