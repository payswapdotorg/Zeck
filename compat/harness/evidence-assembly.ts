/**
 * The evidence assembly (PPR-018A) — turn a corpus run report into a
 * structurally valid `CompatibilityEvidenceRecord` draft, plus the
 * fail-closed file writer for the record the work order records.
 *
 * WHAT THE ASSEMBLY DECIDES (all derived from the report — nothing
 * asserted):
 *  - per-edge dispositions: every edge the run executed through Zeck
 *    becomes `delegated` (its execution ids + live basis); every edge
 *    the run never executed becomes `not-run` with the run's honest
 *    cause and owner (or the work order's declared owner);
 *  - `zeckTraces`: the correlated trace facts, verbatim;
 *  - `egressObservation`: the run's aggregated observation, verbatim;
 *  - `providerCredentials`: the erasure audit's facts (names only);
 *  - `runtimeEvidence`: corpusDeclared=true, corpusUsability derived
 *    (verified only when EVERY task resolved PASS);
 *  - `comparison`: the baselines' labeled comparison facts (never
 *    Zeck evidence).
 *
 * The derived STATUS is never a field — the record this produces is
 * assessed by `evaluateCompatibility` like any other (the work order
 * records it; the Lead certifies; nothing upgrades).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BaselineRunRecord,
  type CompatibilityEvidenceRecord,
  type ComparisonFact,
  type EdgeDispositionEntry,
  type ExecutionGraphEdge,
  type LimitationEntry,
  type NotRunCause,
  type PinnedApplication,
  validateCompatibilityEvidenceRecord,
} from "../../src/integrations/compatibility/public";
import { comparisonFactsOf } from "./baseline-runner";
import type { CorpusRunReport } from "./corpus-runner";

/** A named assembly issue (fail-closed; the draft must validate). */
export interface EvidenceAssemblyIssue {
  readonly issue: string;
}

export interface EvidenceRecordDraftOptions {
  readonly recordId: string;
  readonly pinnedApplication: PinnedApplication;
  /** The declared execution graph (the work order's inventory). */
  readonly graph: { readonly edges: readonly ExecutionGraphEdge[] };
  /** The corpus run report (the run's own facts). */
  readonly report: CorpusRunReport;
  /** The captured baselines (labeled comparison facts; never Zeck evidence). */
  readonly baselines?: readonly BaselineRunRecord[];
  /** Additional work-order limitations (rendered verbatim). */
  readonly limitations?: readonly LimitationEntry[];
  /** Additional work-order NOT-RUN causes (rendered verbatim). */
  readonly notRunCauses?: readonly NotRunCause[];
  /** The work-order owner named on never-executed edges' not-run dispositions. */
  readonly undelegatedEdgeOwner?: string;
}

/** Assemble the evidence record draft from the run's facts (fail-closed). */
export function evidenceRecordDraftOf(options: EvidenceRecordDraftOptions): CompatibilityEvidenceRecord {
  const { report } = options;
  const owner = options.undelegatedEdgeOwner ?? "work-order";

  // Per-edge execution observations grouped by edge.
  const executedEdges = new Map<string, string[]>();
  for (const taskReport of report.taskReports) {
    for (const edge of taskReport.outcome.edgeExecutions) {
      const ids = executedEdges.get(edge.edgeId) ?? [];
      ids.push(edge.executionId);
      executedEdges.set(edge.edgeId, ids);
    }
  }

  const dispositions: EdgeDispositionEntry[] = options.graph.edges.map((edge) => {
    const executionIds = executedEdges.get(edge.edgeId);
    if (executionIds !== undefined && executionIds.length > 0) {
      return {
        edgeId: edge.edgeId,
        disposition: "delegated" as const,
        zeckExecutionIds: executionIds,
        evidenceBasis: "live" as const,
      };
    }
    // The run never executed this edge: the honest not-run disposition.
    // When the whole run declared an unavailability, its cause names it;
    // otherwise the generic honest cause stands (the work order refines
    // it with the edge's precise cause when it records the record).
    const wholeRunUnavailable = report.taskReports.find(
      (taskReport) =>
        taskReport.outcome.unavailable !== null && taskReport.outcome.unavailable !== undefined,
    )?.outcome.unavailable;
    return {
      edgeId: edge.edgeId,
      disposition: "not-run" as const,
      cause:
        wholeRunUnavailable?.cause ??
        "the corpus run did not execute this edge (no Zeck execution was observed for it)",
      owner: wholeRunUnavailable?.owner ?? owner,
    };
  });

  const everyTaskPassed =
    report.runOutcomes.length > 0 && report.runOutcomes.every((entry) => entry.outcome === "PASS");

  const record: CompatibilityEvidenceRecord = {
    recordId: options.recordId,
    recordBasis: "live-proof",
    pinnedApplication: options.pinnedApplication,
    graph: options.graph,
    dispositions,
    egressObservation:
      report.egressObservation ?? { mode: "observe", status: "not-run", violations: [] },
    providerCredentials: report.credentialErasure?.facts ?? [],
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: report.taskReports.length === 0 ? "not-run" : everyTaskPassed ? "verified" : "not-verified",
      observations: report.taskReports.map(
        (taskReport) =>
          `${taskReport.task.taskId}: ${taskReport.outcome.detail} (duration ${taskReport.outcome.durationMs} ms)`,
      ),
    },
    comparison: comparisonFactsOf(options.baselines ?? []) as readonly ComparisonFact[],
    zeckTraces: report.taskReports.flatMap((taskReport) => [...taskReport.traces]),
    limitations: options.limitations ?? [],
    notRunCauses: options.notRunCauses ?? [],
    recordedAt: report.finishedAt,
  };
  const issues = validateCompatibilityEvidenceRecord(record);
  if (issues.length > 0) {
    throw new Error(
      `assembled evidence record is invalid: ${issues
        .map((issue) => `${issue.field}: ${issue.issue}`)
        .join("; ")}`,
    );
  }
  return record;
}

/**
 * Write a record file (the proof harness's write path — persisting
 * evidence is the harness's/the Lead's act, never a projection's).
 * Writes, then READS BACK and validates (the file store's own
 * discipline): a written record that does not validate fails closed.
 */
export function writeEvidenceRecordFile(file: string, record: CompatibilityEvidenceRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const readBack = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const issues = validateCompatibilityEvidenceRecord(readBack);
  if (issues.length > 0) {
    throw new Error(
      `written evidence record failed read-back validation (${file}): ${issues
        .map((issue) => `${issue.field}: ${issue.issue}`)
        .join("; ")}`,
    );
  }
}
