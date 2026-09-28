/**
 * The baseline capture hooks (PPR-018A scope item 5; the Tech-Lead
 * handoff §9 Baseline methodology).
 *
 * "Never compare an optimized Zeck path against a deliberately weak
 * direct baseline": the program mandates BOTH a direct baseline AND a
 * strong optimized non-Zeck baseline, captured through the SAME corpus
 * (comparable quality/reliability/latency constraints, the same task
 * success definition) — on a NON-ZECK stack.
 *
 * THE LABELING LAW (structural): a `BaselineRunRecord` cannot carry
 * Zeck facts (no field exists for them); the ONLY bridge into a
 * compatibility evidence record is `baselineComparisonFact`, which
 * labels the fact as a BASELINE in its `baseline` kind field and in
 * its statement. A baseline fact can never satisfy any admission rule,
 * never render as a Zeck execution, and never upgrade anything.
 */

import {
  type BaselineIssue,
  type BaselineKind,
  type BaselineRunRecord,
  type BaselineTaskRun,
  type ComparisonFact,
  assertNotZeckEvidence,
  baselineComparisonFact,
  validateBaselineRun,
} from "../../src/integrations/compatibility/public";

/** One baseline task the baseline executor runs (the same corpus task, non-Zeck execution). */
export interface BaselineTask {
  readonly taskId: string;
  readonly title: string;
  readonly instruction: string;
}

/** The result of one baseline task execution (non-Zeck stack). */
export interface BaselineTaskResult {
  readonly succeeded: boolean | null;
  readonly detail: string;
  readonly durationMs: number;
  readonly costMicroUsd?: string | null;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/** The baseline executor the WORK ORDER implements (its non-Zeck stack). */
export interface BaselineExecutor {
  /** What runs (named verbatim — the stack this baseline measures). */
  readonly stack: string;
  /** The comparable methodology statement (constraints named). */
  readonly methodology: string;
  /** Execute one task on the baseline stack (never through Zeck). */
  executeTask(task: BaselineTask): Promise<BaselineTaskResult>;
}

export interface BaselineRunnerOptions {
  /** direct-baseline | optimized-baseline (the two mandated kinds). */
  readonly kind: BaselineKind;
  /** The work order's baseline executor (its non-Zeck stack). */
  readonly executor: BaselineExecutor;
  /** The same corpus the Zeck-path run replays (comparable constraints). */
  readonly corpus: readonly BaselineTask[];
  /** The injected clock (ISO strings). */
  readonly now: () => string;
}

/** A raised, named baseline error (fail-closed). */
export class BaselineRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineRunnerError";
  }
}

/**
 * Capture ONE baseline over the corpus (the same tasks, the non-Zeck
 * stack). The result is a labeled `BaselineRunRecord` — structurally
 * not Zeck evidence — validated fail-closed before it is returned.
 */
export async function captureBaseline(options: BaselineRunnerOptions): Promise<BaselineRunRecord> {
  const record: BaselineRunRecord = {
    kind: options.kind,
    stack: options.executor.stack,
    methodology: options.executor.methodology,
    taskRuns: [] as readonly BaselineTaskRun[],
    recordedAt: options.now(),
  };
  const runs: BaselineTaskRun[] = [];
  for (const task of options.corpus) {
    const result = await options.executor.executeTask(task);
    runs.push({
      taskId: task.taskId,
      succeeded: result.succeeded,
      detail: result.detail,
      durationMs: result.durationMs,
      costMicroUsd: result.costMicroUsd ?? null,
      usage: result.usage ?? null,
    });
  }
  const composed: BaselineRunRecord = { ...record, taskRuns: runs };
  const issues: BaselineIssue[] = [
    ...validateBaselineRun(composed),
    ...assertNotZeckEvidence(composed),
  ];
  if (issues.length > 0) {
    throw new BaselineRunnerError(
      `invalid baseline run: ${issues.map((issue) => `${issue.field}: ${issue.issue}`).join("; ")}`,
    );
  }
  return composed;
}

/**
 * Convert baselines into the evidence record's comparison facts — the
 * ONLY sanctioned bridge. Every fact carries its baseline kind and a
 * statement that names it a BASELINE (never Zeck evidence).
 */
export function comparisonFactsOf(
  baselines: readonly BaselineRunRecord[],
): readonly ComparisonFact[] {
  return baselines.map((baseline) => baselineComparisonFact(baseline));
}
