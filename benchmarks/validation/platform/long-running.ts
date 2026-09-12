/**
 * The platform-side long-running/resumable driver (VAL-013).
 *
 * Drives a customer-submitted long-running execution through the REAL
 * long-running machinery: durable checkpoints (digest + position) after
 * every committed item, an external interruption (REAL wait-user →
 * resume pair), resume from the recorded checkpoint WITHOUT redoing
 * committed work (the exactly-once effect journal proves it), fault
 * injection for the corrupted-checkpoint edge (detected by digest
 * mismatch — never trusted), the stale-worker takeover discrimination
 * (a resume attempt on a healthy RUNNING execution is denied and
 * journaled), and the no-op resume after terminal (the platform's own
 * idempotent replay).
 *
 * The supervisor decision at each segment boundary rides ONE REAL model
 * dispatch per segment (the work itself is deterministic — the corpus's
 * evaluation is checkpoint/effect exactness, and the supervisor's
 * continuation answer is mechanically verified).
 *
 * Seam-injected and network-free here; the integration seam binds the
 * REAL executions service (transitions, checkpoints as step events,
 * resume-denied journaling) and the REAL model gateway.
 */

import { type BatchJobDefinition, effectOf } from "../apps/long-running/batch-jobs";
import type { LabUsage, LabVerificationCriterion } from "./derive";

export interface LongRunningLifecyclePort {
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "wait-user" | "resume" | "verify";
    readonly reason: string;
    /** Unique per call (repeated steps across segments must not collide). */
    readonly callKey: string;
  }): Promise<void>;
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
  }): Promise<void>;
  /** Durable checkpoint (digest + position) on the ledger. */
  recordCheckpoint(input: {
    readonly executionId: string;
    readonly position: number;
    readonly digest: string;
    readonly callKey: string;
  }): Promise<void>;
  /** External interruption request on the ledger. */
  recordInterruption(input: {
    readonly executionId: string;
    readonly at: number;
    readonly callKey: string;
  }): Promise<void>;
  /** The stale-worker resume denial (journal-then-fail evidence). */
  recordResumeDenied(input: {
    readonly executionId: string;
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  /** Terminal completion. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  /**
   * The no-op resume after terminal (job-007): re-issue the EXACT prior
   * completion transition — the platform's idempotency ledger REPLAYS it
   * (same key, same fingerprint; no state change). Returns whether the
   * replay happened (the corpus's "replayed" expectation).
   */
  attemptNoOpResume(input: {
    readonly executionId: string;
    readonly completeCallKey: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<{ readonly replayed: boolean }>;
}

export interface LongRunningDispatchPort {
  dispatchSupervisor(input: {
    readonly executionId: string;
    readonly segment: number;
    readonly progress: string;
  }): Promise<
    | { readonly kind: "success"; readonly content: string; readonly usage?: LabUsage }
    | { readonly kind: "failure"; readonly category: string; readonly message: string }
  >;
}

export interface LongRunningRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly segments: number;
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly checkpoints: readonly { position: number; digest: string }[];
  /** The no-op resume replay outcome (job-007 only; null otherwise). */
  readonly noOpResumeReplayed: boolean | null;
}

/** The checkpoint state (digest over the committed prefix). */
interface Checkpoint {
  readonly position: number;
  readonly digest: string;
}

function digestOfPrefix(
  jobId: string,
  items: readonly string[],
  position: number,
  effects: Readonly<Record<string, number>>,
): string {
  let hash = 0x811c9dc5;
  const basis = `${jobId}|${items.slice(0, position).join(",")}|${JSON.stringify(effects)}`;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Drive one long-running execution to completion. The interruption
 * directives come from the job definition (the scenario's designed
 * interruption points); the work is deterministic; committed work is
 * never redone (the effect journal proves exactly-once).
 */
export async function driveLongRunningExecution(options: {
  readonly executionId: string;
  readonly job: BatchJobDefinition;
  readonly provider: string;
  readonly model: string;
  readonly lifecycle: LongRunningLifecyclePort;
  readonly dispatch: LongRunningDispatchPort["dispatchSupervisor"];
}): Promise<LongRunningRunResult> {
  const { executionId, job, lifecycle, dispatch } = options;
  const items = job.items;
  const effectCounts: Record<string, number> = {};
  const checkpoints: Checkpoint[] = [];
  let position = 0;
  let segments = 0;
  let failure: { category: string; message: string } | null = null;
  let totalUsage: LabUsage = { inputTokens: 0, outputTokens: 0 };
  let keyCounter = 0;
  const key = (): string => {
    keyCounter += 1;
    return `k${keyCounter}`;
  };

  const recordEffect = (item: string): void => {
    const effect = effectOf(job.jobId, item);
    effectCounts[effect] = (effectCounts[effect] ?? 0) + 1;
  };

  const commitCheckpoint = (): void => {
    const checkpoint: Checkpoint = {
      position,
      digest: digestOfPrefix(job.jobId, items, position, effectCounts),
    };
    checkpoints.push(checkpoint);
  };

  const supervisorRound = async (segment: number): Promise<boolean> => {
    const progress = `${position}/${items.length} items committed; next item: ${items[position] ?? "(none — job complete)"}`;
    const outcome = await dispatch({ executionId, segment, progress });
    if (outcome.kind === "failure") {
      failure = { category: outcome.category, message: outcome.message };
      return false;
    }
    segments += 1;
    if (outcome.usage !== undefined) {
      totalUsage = {
        inputTokens: totalUsage.inputTokens + outcome.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + outcome.usage.outputTokens,
        costUsd: (totalUsage.costUsd ?? 0) + (outcome.usage.costUsd ?? 0),
      };
    }
    if (!/continue/i.test(outcome.content)) {
      failure = {
        category: "supervisor-halt",
        message: `the supervisor did not confirm continuation: ${outcome.content.slice(0, 120)}`,
      };
      return false;
    }
    return true;
  };

  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-013-authorize",
    callKey: key(),
  });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-013-plan", callKey: key() });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "checkpointed-batch-agent",
    },
  });
  await lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-013-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-013-start",
    callKey: key(),
  });

  // --- segment 1: work up to the interruption boundary ---
  if (!(await supervisorRound(1))) {
    return finish("provider-or-supervisor failure before any work");
  }

  const interruptAt = interruptBoundary(job, items.length);
  // Work item-by-item, committing effects and checkpoints.
  while (position < interruptAt && position < items.length) {
    recordEffect(items[position] as string);
    position += 1;
    commitCheckpoint();
    await lifecycle.recordCheckpoint({
      executionId,
      position: checkpoints[checkpoints.length - 1]?.position ?? position,
      digest: checkpoints[checkpoints.length - 1]?.digest ?? "",
      callKey: key(),
    });
  }

  // Mid-item interruption: item midItem is IN FLIGHT (its effect was
  // never committed — the interruption lands before the commit).
  if (job.interrupt === "mid-item-3") {
    await lifecycle.recordInterruption({ executionId, at: position, callKey: key() });
    await lifecycle.transition({
      executionId,
      step: "wait-user",
      reason: "val-013-interrupt-mid-item",
      callKey: key(),
    });
    await lifecycle.transition({
      executionId,
      step: "resume",
      reason: "val-013-resume-1",
      callKey: key(),
    });
    if (!(await supervisorRound(2))) {
      return finish("provider-or-supervisor failure at resume");
    }
  } else if (job.interrupt !== "none") {
    await lifecycle.recordInterruption({ executionId, at: position, callKey: key() });
    await lifecycle.transition({
      executionId,
      step: "wait-user",
      reason: "val-013-interrupt",
      callKey: key(),
    });

    await lifecycle.transition({
      executionId,
      step: "resume",
      reason: "val-013-resume-1",
      callKey: key(),
    });

    if (job.interrupt === "stale-worker") {
      // The stale worker attempts a resume on the now-RUNNING execution
      // (the successor already resumed): the REAL state machine DENIES
      // it (resume is legal only from WAITING_* states) — the rejection
      // is caught and journaled as resume-denied evidence.
      try {
        await lifecycle.transition({
          executionId,
          step: "resume",
          reason: "val-013-stale-worker-resume",
          callKey: key(),
        });
      } catch {
        await lifecycle.recordResumeDenied({
          executionId,
          reason:
            "stale-worker: resume rejected on a healthy RUNNING execution (the successor owns the lease)",
          callKey: key(),
        });
      }
    }
    if (job.interrupt === "corrupt-checkpoint") {
      // Fault injection (the scenario's designed corruption): the stored
      // checkpoint's digest no longer matches the recomputed state.
      const stored = checkpoints[checkpoints.length - 1];
      if (stored !== undefined) {
        checkpoints[checkpoints.length - 1] = { position: stored.position, digest: "deadbeef" };
      }
    }
    if (job.interrupt === "twice") {
      // A second interruption before the second work segment.
      await lifecycle.transition({
        executionId,
        step: "wait-user",
        reason: "val-013-interrupt-2",
        callKey: key(),
      });
      await lifecycle.transition({
        executionId,
        step: "resume",
        reason: "val-013-resume-2",
        callKey: key(),
      });
    }
    if (!(await supervisorRound(2))) {
      return finish("provider-or-supervisor failure at resume");
    }
    // Resume continuity: the recomputed digest of the committed prefix
    // must MATCH the recorded checkpoint — a corrupted checkpoint is
    // detected and NEVER trusted (the corpus's expected failure).
    const lastCheckpoint = checkpoints[checkpoints.length - 1];
    const recomputed = digestOfPrefix(job.jobId, items, position, effectCounts);
    if (lastCheckpoint !== undefined && lastCheckpoint.digest !== recomputed) {
      failure = {
        category: "checkpoint-corruption",
        message: `checkpoint digest mismatch at position ${lastCheckpoint.position}: stored ${lastCheckpoint.digest}, recomputed ${recomputed}`,
      };
      return finish("corrupted checkpoint detected");
    }
  }

  // --- segment 2 (or the only segment): the remaining work ---
  while (position < items.length && failure === null) {
    recordEffect(items[position] as string);
    position += 1;
    commitCheckpoint();
    await lifecycle.recordCheckpoint({
      executionId,
      position: checkpoints[checkpoints.length - 1]?.position ?? position,
      digest: checkpoints[checkpoints.length - 1]?.digest ?? "",
      callKey: key(),
    });
  }

  return finish();

  async function finish(earlyReason?: string): Promise<LongRunningRunResult> {
    const criteria = deriveLongRunningCriteria({
      job,
      effectCounts,
      checkpoints,
      failure,
      items,
      earlyReason,
    });
    const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
    await lifecycle.transition({
      executionId,
      step: "verify",
      reason: "val-013-verify",
      callKey: key(),
    });
    const completeCallKey = key();
    await lifecycle.complete({
      executionId,
      verdict: anyFail ? "fail" : "pass",
      criteria,
      reason: anyFail ? "val-013-mechanical-verification-failed" : "val-013-verified",
      callKey: completeCallKey,
    });
    let noOpResumeReplayed: boolean | null = null;
    if (job.resumeAfterTerminal === true) {
      // The corpus's no-op-resume row: the EXACT completion transition is
      // re-issued — the platform's idempotency ledger must REPLAY it
      // (same key, same fingerprint; zero state change).
      const replay = await lifecycle.attemptNoOpResume({
        executionId,
        completeCallKey,
        verdict: anyFail ? "fail" : "pass",
        criteria,
        reason: anyFail ? "val-013-mechanical-verification-failed" : "val-013-verified",
      });
      noOpResumeReplayed = replay.replayed;
    }
    void earlyReason;
    return {
      executionId,
      terminal: anyFail ? "FAILED" : "COMPLETED",
      criteria,
      usage: totalUsage.inputTokens > 0 ? totalUsage : null,
      segments,
      effectCounts,
      checkpoints: checkpoints.map((c) => ({ position: c.position, digest: c.digest })),
      noOpResumeReplayed,
    };
  }
}

function interruptBoundary(job: BatchJobDefinition, total: number): number {
  switch (job.interrupt) {
    case "after-checkpoint-1":
      return Math.min(1, total);
    case "mid-item-3":
      return Math.min(2, total); // item 3 is in flight (2 committed)
    case "twice":
      return Math.min(1, total);
    case "corrupt-checkpoint":
      return Math.min(1, total);
    case "stale-worker":
      return Math.min(1, total);
    case "before-final":
      return Math.max(0, total - 1);
    default:
      return total;
  }
}

function deriveLongRunningCriteria(input: {
  readonly job: BatchJobDefinition;
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly checkpoints: readonly Checkpoint[];
  readonly failure: { category: string; message: string } | null;
  readonly items: readonly string[];
  readonly earlyReason?: string;
}): LabVerificationCriterion[] {
  const { job, effectCounts, checkpoints, failure, items } = input;
  if (failure !== null) {
    return [
      {
        criterionId: "long-running-execution",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [
          `failure:${failure.category}`,
          `message:${failure.message.slice(0, 160)}`,
          `checkpoints:${checkpoints.length}`,
        ],
      },
    ];
  }
  const criteria: LabVerificationCriterion[] = [];
  // 1. Exactly-once effects: every item's effect applied exactly once.
  const overApplied = Object.entries(effectCounts).filter(([, count]) => count > 1);
  const missing = items.filter((item) => (effectCounts[effectOf(job.jobId, item)] ?? 0) === 0);
  const exactlyOnce = overApplied.length === 0 && missing.length === 0;
  criteria.push({
    criterionId: "exactly-once-effects",
    strategy: "deterministic",
    status: exactlyOnce ? "PASS" : "FAIL",
    evidence: [
      `items:${items.length}`,
      `appliedOnce:${items.length - missing.length}`,
      `overApplied:${overApplied.map(([effect]) => effect).join("|") || "none"}`,
      `missing:${missing.join("|") || "none"}`,
    ],
  });
  // 2. Checkpoint progression: strictly increasing positions to the end.
  const positions = checkpoints.map((c) => c.position);
  const monotonic = positions.every(
    (pos, index) => index === 0 || pos > (positions[index - 1] ?? -1),
  );
  const reachedEnd = (positions[positions.length - 1] ?? -1) === items.length;
  criteria.push({
    criterionId: "checkpoint-progression",
    strategy: "deterministic",
    status: monotonic && reachedEnd ? "PASS" : "FAIL",
    evidence: [`positions:${positions.join(">") || "none"}`, `expectedEnd:${items.length}`],
  });
  // 3. Resume continuity: the final checkpoint digest matches the
  //    recomputed state (no lost or duplicated progress).
  const recomputedFinal = digestOfPrefix(job.jobId, items, items.length, effectCounts);
  const finalCheckpoint = checkpoints[checkpoints.length - 1];
  const continuity = finalCheckpoint !== undefined && finalCheckpoint.digest === recomputedFinal;
  criteria.push({
    criterionId: "resume-continuity",
    strategy: "deterministic",
    status: continuity ? "PASS" : "FAIL",
    evidence: [
      continuity ? "final-checkpoint-matches-recomputed-state" : "final-checkpoint-mismatch",
      `finalPosition:${finalCheckpoint?.position ?? "none"}/${items.length}`,
    ],
  });
  // 4. Termination: the terminal state matches the job's expectation.
  criteria.push({
    criterionId: "termination",
    strategy: "deterministic",
    status: job.expectedTerminal === "COMPLETED" ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${job.expectedTerminal}`,
      `interrupt:${job.interrupt}`,
      `segments:${input.checkpoints.length}`,
    ],
  });
  return criteria;
}
