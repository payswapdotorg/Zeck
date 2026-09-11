/**
 * Cumulative validation report projection (VAL-001, acceptance criterion 5).
 *
 * The cumulative report (`docs/VALIDATION-REPORT.md`) must separate
 * observed facts from interpretation. This module is the pure projection
 * from submission records to the five report sections the roadmap
 * mandates: observed facts, failures, hypotheses, recommendations and
 * NOT RUN boundaries. It is a projection only — it holds no authority,
 * makes no claims beyond the submissions it is given, and never converts
 * a NOT RUN boundary into a pass.
 */

import type { SubmissionRecord } from "./submission";

/** The five mandated report sections, in report order. */
export const REPORT_SECTIONS = [
  "observed-facts",
  "failures",
  "hypotheses",
  "recommendations",
  "not-run",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** One projected line of the cumulative report. */
export interface ReportEntry {
  readonly section: ReportSection;
  readonly source: string;
  readonly text: string;
}

/**
 * Project submissions into the five-section cumulative report structure.
 *
 * Provenance rule: every projected entry names the submission (work order
 * + final head) it came from, so the report can always be audited back to
 * exact evidence. Failed battery commands become failures; issues carry
 * their root causes into failures and their recommended solutions into
 * recommendations; NOT RUN boundaries stay NOT RUN — never a pass.
 */
export function projectReport(submissions: readonly SubmissionRecord[]): readonly ReportEntry[] {
  const entries: ReportEntry[] = [];
  for (const submission of submissions) {
    const source = `${submission.workOrder}@${submission.finalHead.slice(0, 12)}`;

    for (const entry of submission.battery) {
      entries.push({
        section: "observed-facts",
        source,
        text: `${entry.command} -> ${entry.outcome}: ${entry.detail}`,
      });
      if (entry.outcome === "fail") {
        entries.push({
          section: "failures",
          source,
          text: `battery command failed: ${entry.command} — ${entry.detail}`,
        });
      }
    }

    for (const issue of submission.issues) {
      entries.push({
        section: "failures",
        source,
        text: `issue (${issue.classification}): ${issue.impact} — root cause: ${issue.rootCause.join(", ")}; reproduction: ${issue.reproduction}`,
      });
      entries.push({
        section: "recommendations",
        source,
        text: `${issue.recommendedSolution} — verification required: ${issue.verificationEvidence}`,
      });
    }

    for (const boundary of submission.notRun) {
      entries.push({
        section: "not-run",
        source,
        text: `NOT RUN ${boundary.surface}: ${boundary.reason}`,
      });
    }
  }
  return entries;
}

/**
 * Group projected entries by report section (stable order within a
 * section: submission order then entry order).
 */
export function groupBySection(
  entries: readonly ReportEntry[],
): Readonly<Record<ReportSection, readonly ReportEntry[]>> {
  const grouped: Record<ReportSection, ReportEntry[]> = {
    "observed-facts": [],
    failures: [],
    hypotheses: [],
    recommendations: [],
    "not-run": [],
  };
  for (const entry of entries) {
    grouped[entry.section].push(entry);
  }
  return grouped;
}

/**
 * The hypotheses section is interpretation, never fact: hypotheses enter
 * the report explicitly (the Tech Lead records them as open questions),
 * they are never derived from battery output. This helper records one.
 */
export function recordHypothesis(source: string, text: string): ReportEntry {
  if (text.length === 0) {
    throw new Error("a hypothesis must carry non-empty text");
  }
  return { section: "hypotheses", source, text };
}
