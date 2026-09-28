/**
 * Baseline capture + labeling (PPR-018A scope item 5; the Tech-Lead
 * handoff §9 "Baseline methodology").
 *
 * THE LAW: baselines are ALWAYS labeled as baselines, and can NEVER be
 * presented as Zeck evidence. This module makes that structural:
 *
 *  - a `BaselineRunRecord` is a SEPARATE type from every Zeck evidence
 *    shape: it has NO field where a Zeck execution id, trace fact or
 *    disposition could even appear (the type cannot pose);
 *  - the ONLY bridge into a compatibility evidence record is
 *    `baselineComparisonFact`, which converts a baseline record into
 *    the record's own `ComparisonFact` shape — carrying the baseline's
 *    kind label verbatim in the `baseline` field and a statement that
 *    names it a BASELINE (never Zeck evidence);
 *  - `assertNotZeckEvidence` guards the presentation path: anything
 *    that would render a baseline fact as Zeck evidence fails closed.
 *
 * The two baseline kinds the program mandates:
 *  - `direct-baseline` — the application on its own direct provider
 *    stack (no deliberate weakening);
 *  - `optimized-baseline` — a STRONG optimized non-Zeck stack (the
 *    comparison must never beat a strawman).
 *
 * Pure and total: no environment, no clock, no I/O.
 */

import type { ComparisonFact } from "./evidence";

/** The baseline kinds the program mandates (frozen vocabulary). */
export const BASELINE_KINDS = ["direct-baseline", "optimized-baseline"] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

export function isBaselineKind(value: unknown): value is BaselineKind {
  return typeof value === "string" && (BASELINE_KINDS as readonly string[]).includes(value);
}

/** One baseline task run (a task executed WITHOUT Zeck, on the baseline stack). */
export interface BaselineTaskRun {
  readonly taskId: string;
  readonly succeeded: boolean | null;
  readonly detail: string;
  readonly durationMs: number;
  readonly costMicroUsd?: string | null;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/**
 * A baseline run record. STRUCTURALLY NOT ZECK EVIDENCE: there is no
 * executions/trace/disposition/verification field on this type — the
 * record cannot carry Zeck facts, so a baseline can never satisfy any
 * admission rule and can never be presented as a delegated execution.
 */
export interface BaselineRunRecord {
  readonly kind: BaselineKind;
  /** What ran (the application + its non-Zeck execution stack, named). */
  readonly stack: string;
  readonly taskRuns: readonly BaselineTaskRun[];
  /** The verbatim methodology statement (comparable quality/reliability/latency constraints). */
  readonly methodology: string;
  /** When the baseline was captured (ISO timestamp). */
  readonly recordedAt: string;
}

/** A named baseline defect (fail-closed, machine-readable). */
export interface BaselineIssue {
  readonly field: string;
  readonly issue: string;
}

/** Validate a baseline run record (kind, stack, methodology, runs). */
export function validateBaselineRun(record: unknown): readonly BaselineIssue[] {
  if (typeof record !== "object" || record === null) {
    return [{ field: "baseline", issue: "baseline run record must be an object" }];
  }
  const value = record as Record<string, unknown>;
  const issues: BaselineIssue[] = [];
  if (!isBaselineKind(value.kind)) {
    issues.push({
      field: "kind",
      issue: 'baseline kind must be "direct-baseline" or "optimized-baseline"',
    });
  }
  if (typeof value.stack !== "string" || value.stack.trim().length === 0) {
    issues.push({
      field: "stack",
      issue: "the baseline's stack (what ran without Zeck) is mandatory",
    });
  }
  if (typeof value.methodology !== "string" || value.methodology.trim().length === 0) {
    issues.push({
      field: "methodology",
      issue: "the baseline's methodology statement is mandatory (comparable constraints named)",
    });
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.trim().length === 0) {
    issues.push({
      field: "recordedAt",
      issue: "the baseline's recorded-at timestamp is mandatory",
    });
  }
  if (!Array.isArray(value.taskRuns)) {
    issues.push({ field: "taskRuns", issue: "task runs must be an array" });
  }
  return issues;
}

/**
 * The ONLY sanctioned bridge from a baseline record into a
 * compatibility evidence record: a `ComparisonFact` whose baseline
 * field carries the baseline kind and whose statement names it a
 * BASELINE — never Zeck evidence.
 */
export function baselineComparisonFact(record: BaselineRunRecord): ComparisonFact {
  const successes = record.taskRuns.filter((run) => run.succeeded === true).length;
  const executed = record.taskRuns.filter((run) => run.succeeded !== null).length;
  const totalCost = record.taskRuns.reduce(
    (sum, run) =>
      run.costMicroUsd !== undefined && run.costMicroUsd !== null
        ? sum + Number(run.costMicroUsd)
        : sum,
    0,
  );
  const statement =
    `BASELINE (${record.kind}, stack: ${record.stack}) — ${successes}/${executed} task(s) resolved` +
    (totalCost > 0 ? `, settled cost ${totalCost} micro-USD` : ", cost not carried") +
    `. Methodology: ${record.methodology} Baseline facts are measured on a NON-ZECK stack and are never Zeck evidence; they contextualize the Zeck-path record only.`;
  return {
    baseline: record.kind,
    basis: record.taskRuns.length > 0 ? "measured" : "not-measured",
    statement,
  };
}

/**
 * The presentation guard: does a value carry Zeck-evidence shapes it
 * could not have produced? A baseline record (or its JSON) containing
 * Zeck-execution-shaped fields is INCONSISTENT — a baseline runs
 * without Zeck, so it cannot legitimately carry Zeck facts; the guard
 * fails closed (the caller surfaces the defect, never renders it).
 */
export function assertNotZeckEvidence(value: unknown): readonly BaselineIssue[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const issues: BaselineIssue[] = [];
  const forbidden = [
    "zeckExecutionIds",
    "zeckTraces",
    "dispositions",
    "evidenceBasis",
    "applicationResult",
  ] as const;
  for (const key of forbidden) {
    if (record[key] !== undefined) {
      issues.push({
        field: key,
        issue:
          "a baseline record cannot carry Zeck-evidence fields — baseline facts are never Zeck evidence (a baseline that claims Zeck executions is inconsistent and fails closed)",
      });
    }
  }
  return issues;
}
