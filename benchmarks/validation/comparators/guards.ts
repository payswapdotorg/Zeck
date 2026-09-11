/**
 * Mechanical fair-comparison guards (VAL-005, acceptance criterion 5).
 *
 * A comparison is fair ONLY when both arms run the SAME corpus tasks
 * with the SAME evaluation configuration and thresholds declared
 * BEFORE any run executes. The comparator plan is content-digested and
 * pinned at declaration time; executing arms against a different plan
 * (post-hoc threshold manipulation, task substitution, evaluation
 * drift) is mechanically rejected.
 */

import { createHash } from "node:crypto";
import type { GoldenTask } from "../corpus/schema";

/** One arm of a comparison (Zeck or a baseline). */
export interface ComparisonArm {
  readonly name: string;
  readonly kind: "zeck" | "direct-provider" | "optimized-baseline" | "competing-stack";
  /** The integration surface the arm rides (sdk / provider / stack). */
  readonly integrationSurface: string;
}

/** The declared comparison plan (thresholds BEFORE runs). */
export interface ComparisonPlan {
  readonly arms: readonly [ComparisonArm, ComparisonArm];
  /** The corpus task identities BOTH arms must execute (identical). */
  readonly taskIds: readonly string[];
  /** The evaluation threshold applied to BOTH arms (declared up front). */
  readonly threshold: {
    readonly rubricPass: number;
    readonly maxTerminalFailureRate: number;
    readonly maxLatencyMs: number;
  };
  readonly declaredAt: string;
}

/** The pinned plan: the declaration digest freezes the fairness terms. */
export interface PinnedComparisonPlan {
  readonly plan: ComparisonPlan;
  readonly digest: string;
}

/** Pin a comparison plan: the fairness terms are frozen by digest. */
export function pinComparisonPlan(plan: ComparisonPlan): PinnedComparisonPlan {
  if (plan.arms[0]?.name === plan.arms[1]?.name) {
    throw new Error("a comparison needs two distinct arms");
  }
  if (plan.taskIds.length === 0) {
    throw new Error("a comparison plan must declare its task slice");
  }
  const seen = new Set(plan.taskIds);
  if (seen.size !== plan.taskIds.length) {
    throw new Error("duplicate task ids in the comparison plan");
  }
  if (plan.threshold.rubricPass < 0 || plan.threshold.rubricPass > 1) {
    throw new Error("the rubric threshold must be in [0,1]");
  }
  if (plan.threshold.maxTerminalFailureRate < 0 || plan.threshold.maxTerminalFailureRate > 1) {
    throw new Error("the terminal-failure-rate bound must be in [0,1]");
  }
  if (plan.threshold.maxLatencyMs <= 0) {
    throw new Error("the latency bound must be positive");
  }
  const digest = `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
  return Object.freeze({ plan, digest });
}

/**
 * Verify an executed comparison against its pinned plan: the executed
 * task set must EXACTLY equal the planned slice for every arm, and the
 * reported threshold facts must match the pinned terms. Any drift is
 * a fairness violation (mechanical, no judgment).
 */
export function verifyFairExecution(
  pinned: PinnedComparisonPlan,
  executed: {
    readonly arm: string;
    readonly executedTaskIds: readonly string[];
    readonly appliedThreshold: ComparisonPlan["threshold"];
  }[],
): readonly string[] {
  const violations: string[] = [];
  const planned = new Set(pinned.plan.taskIds);
  for (const record of executed) {
    const isDeclaredArm =
      record.arm === pinned.plan.arms[0]?.name || record.arm === pinned.plan.arms[1]?.name;
    if (!isDeclaredArm) {
      violations.push(`undeclared arm executed: ${record.arm}`);
      continue;
    }
    if (record.executedTaskIds.length !== pinned.plan.taskIds.length) {
      violations.push(
        `arm ${record.arm} executed ${record.executedTaskIds.length} tasks, plan declares ${pinned.plan.taskIds.length}`,
      );
    }
    for (const taskId of record.executedTaskIds) {
      if (!planned.has(taskId)) {
        violations.push(`arm ${record.arm} executed unplanned task ${taskId}`);
      }
    }
    for (const taskId of pinned.plan.taskIds) {
      if (!record.executedTaskIds.includes(taskId)) {
        violations.push(`arm ${record.arm} skipped planned task ${taskId}`);
      }
    }
    if (canonicalJson(record.appliedThreshold) !== canonicalJson(pinned.plan.threshold)) {
      violations.push(`arm ${record.arm} applied thresholds that differ from the pinned plan`);
    }
  }
  return violations;
}

/** The comparison-relevant slice of a corpus task (input identity). */
export function taskSlice(tasks: readonly GoldenTask[]): readonly string[] {
  return tasks.map((task) => task.taskId);
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
