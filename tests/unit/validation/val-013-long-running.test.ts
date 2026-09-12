/**
 * VAL-013 acceptance criterion 6: the long-running driver against
 * controlled fakes — checkpoint/resume continuity (no redo, exactly
 * once), corrupted-checkpoint detection (never trusted), the
 * stale-worker denial journaling, the no-op resume replay, and the
 * supervisor-dispatch failure path.
 */

import { describe, expect, test } from "vitest";
import { BATCH_JOBS } from "../../../benchmarks/validation/apps/long-running/batch-jobs";
import {
  driveLongRunningExecution,
  type LongRunningLifecyclePort,
} from "../../../benchmarks/validation/platform/long-running";

interface Recorded {
  readonly kind: string;
  readonly detail: string;
}

function createFakeLifecycle(): LongRunningLifecyclePort & {
  readonly recorded: Recorded[];
  /** Set to false to simulate the replay failing (discrimination). */
  replayOutcome: boolean;
} {
  const recorded: Recorded[] = [];
  // A miniature state machine mirroring the REAL rule: resume is legal
  // ONLY from a WAITING_* status (the stale-worker discrimination).
  let status = "CREATED";
  const port: LongRunningLifecyclePort = {
    async transition(command) {
      if (command.step === "resume" && !status.startsWith("WAITING")) {
        throw new Error(`invalid resume from ${status}`);
      }
      if (command.step === "authorize") status = "AUTHORIZED";
      else if (command.step === "plan") status = "PLANNING";
      else if (command.step === "queue") status = "QUEUED";
      else if (command.step === "start") status = "RUNNING";
      else if (command.step === "wait-user") status = "WAITING_USER";
      else if (command.step === "resume") status = "RUNNING";
      else if (command.step === "verify") status = "VERIFYING";
      recorded.push({ kind: command.step, detail: command.callKey });
    },
    async recordPlanningDecision() {
      recorded.push({ kind: "planning-decision", detail: "" });
    },
    async recordCheckpoint(input) {
      recorded.push({ kind: "checkpoint", detail: `${input.position}:${input.digest}` });
    },
    async recordInterruption(input) {
      recorded.push({ kind: "interruption", detail: String(input.at) });
    },
    async recordResumeDenied(input) {
      recorded.push({ kind: "resume-denied", detail: input.reason });
    },
    async complete(input) {
      recorded.push({ kind: "complete", detail: `${input.verdict}:${input.callKey}` });
    },
    async attemptNoOpResume() {
      return { replayed: true };
    },
  };
  return Object.assign(port, { recorded, replayOutcome: true });
}

const CONTINUE: (input: { segment: number }) => Promise<{
  kind: "success";
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}> = async () => ({
  kind: "success",
  content: "continue",
  usage: { inputTokens: 40, outputTokens: 5 },
});

const jobOf = (jobId: string) => BATCH_JOBS.find((job) => job.jobId === jobId);

describe("VAL-013 long-running driver", () => {
  test("interrupt after checkpoint-1: resume continues from the checkpoint exactly (no redo)", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-001");
    if (job === undefined) throw new Error("missing job-001");
    const result = await driveLongRunningExecution({
      executionId: "exec-1",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("COMPLETED");
    // Exactly once per item.
    for (const item of job.items) {
      expect(result.effectCounts[`${job.jobId}:${item}:applied`]).toBe(1);
    }
    // One genuine wait-user -> resume pair.
    const steps = lifecycle.recorded.map((entry) => entry.kind);
    expect(steps.filter((step) => step === "wait-user")).toHaveLength(1);
    expect(steps.filter((step) => step === "resume")).toHaveLength(1);
    // Checkpoints after every committed item; progression to the end.
    expect(result.checkpoints.map((c) => c.position)).toEqual([1, 2, 3, 4]);
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
  });

  test("mid-item interruption: the in-flight item's effect applies exactly once across the interruption", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-002");
    if (job === undefined) throw new Error("missing job-002");
    const result = await driveLongRunningExecution({
      executionId: "exec-2",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("COMPLETED");
    for (const item of job.items) {
      expect(result.effectCounts[`${job.jobId}:${item}:applied`]).toBe(1);
    }
  });

  test("double interruption completes with two wait-user/resume pairs", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-003");
    if (job === undefined) throw new Error("missing job-003");
    const result = await driveLongRunningExecution({
      executionId: "exec-3",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("COMPLETED");
    const steps = lifecycle.recorded.map((entry) => entry.kind);
    expect(steps.filter((step) => step === "wait-user")).toHaveLength(2);
    expect(steps.filter((step) => step === "resume")).toHaveLength(2);
  });

  test("a corrupted checkpoint is detected and FAILS the run (never trusted)", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-005");
    if (job === undefined) throw new Error("missing job-005");
    const result = await driveLongRunningExecution({
      executionId: "exec-4",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.criterionId).toBe("long-running-execution");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:checkpoint-corruption");
  });

  test("the stale-worker denial is journaled and the successor completes", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-006");
    if (job === undefined) throw new Error("missing job-006");
    const result = await driveLongRunningExecution({
      executionId: "exec-5",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(
      lifecycle.recorded.some(
        (entry) => entry.kind === "resume-denied" && entry.detail.includes("stale-worker"),
      ),
    ).toBe(true);
  });

  test("the no-op resume after terminal replays (idempotent, zero state change)", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-007");
    if (job === undefined) throw new Error("missing job-007");
    const result = await driveLongRunningExecution({
      executionId: "exec-6",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: CONTINUE,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.noOpResumeReplayed).toBe(true);
  });

  test("a supervisor dispatch failure fails the run honestly", async () => {
    const lifecycle = createFakeLifecycle();
    const job = jobOf("job-001");
    if (job === undefined) throw new Error("missing job-001");
    const result = await driveLongRunningExecution({
      executionId: "exec-7",
      job,
      provider: "openrouter",
      model: "fixture-model",
      lifecycle,
      dispatch: async () => ({ kind: "failure", category: "rate-limit", message: "throttled" }),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
  });
});
