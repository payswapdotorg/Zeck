/**
 * Integration — the EXTERNAL RUN IDENTITY regressions over REAL
 * PostgreSQL + the REAL `ContainerSandboxProvider` + the REAL
 * container-runtime client over REAL HTTP (WORK-046 / D-05 revision;
 * the Architect finding on PR #10 — checkpoint contract
 * IDENTITY-IDEMPOTENCY).
 *
 * THE DEFECT (pre-revision): the container runner's external `runId`
 * was derived from the container configuration + the timeout ALONE,
 * and the provider-neutral runtime contract carried no
 * execution/sandbox identity — so TWO DIFFERENT Zeck executions doing
 * IDENTICAL work derived the SAME external run id: the second
 * execution's submission was answered 409 and it POLLed AND CONSUMED
 * THE FIRST EXECUTION'S RUN (cross-execution identity collapse).
 *
 * THE FIX: the runtime contract carries the execution-scoped
 * `runIdentity` (the durable application/execution/sandbox binding —
 * `containerRunIdentity`), and the client's derivation binds it:
 *
 *   runId = "run-" + sha256([runIdentity, config, timeoutMs])[0:32]
 *
 * This suite proves the two required properties END-TO-END (the full
 * governed composition — execution lifecycle, admission chain, claim
 * gate, lease, executor, completion — with only the runner HOST being
 * the documented in-process protocol server):
 *
 *  - DISTINCT-EXECUTION SEPARATION: two executions with the IDENTICAL
 *    task (same environment, command, args, env) → the runner holds
 *    TWO distinct external runs, both submitted exactly once (202,
 *    never 409), and each execution observes ITS OWN run's outcome;
 *  - SAME-EXECUTION IDEMPOTENCY: the recovery re-drive of ONE
 *    execution (the C4 crash shape: the run completed on the runner,
 *    the completion write was fenced by lease expiry) converges with
 *    exactly ONE external run — no resubmission (not even the 409),
 *    because the durable sandbox row replays the recorded outcome
 *    under the deterministic sandbox identity.
 */

import { expect, test } from "vitest";
import { ContainerSandboxProvider } from "../../../src/modules/sandbox/adapters/container-provider";
import { createContainerRuntimeClient } from "../../../src/platform/compute/container-runtime";
import { type FakeRunnerServer, startFakeRunner } from "../compute/fake-runner";
import { definePgSuite } from "./harness";
import { seedWorkerFabricWorld, type WorkerFabricWorld } from "./worker-world";

const RUNNER_TOKEN = "worker-identity-regression-token";

/** Wire the REAL container substrate over a real HTTP runner endpoint. */
async function worldOverRunner(
  db: Parameters<typeof seedWorkerFabricWorld>[0],
  runner: FakeRunnerServer,
): Promise<WorkerFabricWorld> {
  return seedWorkerFabricWorld(db, {
    containerProvider: new ContainerSandboxProvider({
      client: createContainerRuntimeClient({
        baseUrl: runner.baseUrl,
        apiToken: RUNNER_TOKEN,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 50,
        maxOutputBytes: 256,
      }),
    }),
  });
}

/** The IDENTICAL worker-executable task both executions will carry. */
const identicalTask = (containerEnvironmentId: string): Readonly<Record<string, unknown>> => ({
  kind: "worker-identity-regression",
  sandbox: {
    environmentId: containerEnvironmentId,
    command: "python3",
    args: ["analyze.py"],
    publicEnv: { MODE: "batch" },
  },
});

definePgSuite("worker external run identity (WORK-046 D-05 revision)", (ctx) => {
  test("REGRESSION distinct executions doing IDENTICAL work never collapse into one external runner run", async () => {
    // The runner completes every accepted run immediately
    // (deterministic stdout derived from the run id).
    const runner = await startFakeRunner({ apiToken: RUNNER_TOKEN, autoSucceed: true });
    try {
      const w = await worldOverRunner(ctx.port, runner);
      const task = identicalTask(w.containerEnvironmentId);

      // TWO executions, the IDENTICAL task object (identical work —
      // the same environment, command, args and public env; only the
      // execution identities differ).
      const executionA = await w.createDispatchedExecution("identity-a", task);
      const executionB = await w.createDispatchedExecution("identity-b", task);

      const fabric = await w.createFabric();
      const report = await fabric.consumeBatch();
      expect(report.executed).toBe(2);
      expect(report.applied).toBe(2);

      // Both executions COMPLETED through the governed path.
      const finalA = await w.service.getExecution(w.applicationId, executionA);
      const finalB = await w.service.getExecution(w.applicationId, executionB);
      expect(finalA?.status).toBe("COMPLETED");
      expect(finalB?.status).toBe("COMPLETED");
      expect(finalA?.verificationRefs.length).toBeGreaterThanOrEqual(1);
      expect(finalB?.verificationRefs.length).toBeGreaterThanOrEqual(1);

      // THE SEPARATION PROOF: the runner holds EXACTLY TWO distinct
      // external runs. Pre-revision this was ONE (the second
      // submission answered 409 and consumed the first execution's
      // run — the cross-execution collapse).
      const runIds = runner.runIds();
      expect(runIds.length).toBe(2);
      expect(new Set(runIds).size).toBe(2);

      // Both submissions were ACCEPTED — neither execution was handed
      // the other's run (the collapse would have answered 409).
      const submissions = runner.submissions();
      expect(submissions.length).toBe(2);
      expect(submissions.every((entry) => entry.status === 202)).toBe(true);

      // Each execution observed ITS OWN run's outcome: the recorded
      // sandbox outputs carry the two distinct external run ids (the
      // deterministic stdout derives from the run id).
      const sandboxA = (
        await w.sandboxService.listSandboxesByExecution(w.applicationId, executionA)
      ).at(0);
      const sandboxB = (
        await w.sandboxService.listSandboxesByExecution(w.applicationId, executionB)
      ).at(0);
      expect(sandboxA?.status).toBe("completed");
      expect(sandboxB?.status).toBe("completed");
      expect(sandboxA?.output?.exitCode).toBe(0);
      expect(sandboxB?.output?.exitCode).toBe(0);
      const stdoutA = sandboxA?.output?.stdout;
      const stdoutB = sandboxB?.output?.stdout;
      expect(typeof stdoutA).toBe("string");
      expect(typeof stdoutB).toBe("string");
      expect(stdoutA).not.toBe(stdoutB);
      // The outcomes map back to the two distinct external runs.
      expect(runIds.filter((id) => stdoutA === `done:${id.slice(-16)}`)).toHaveLength(1);
      expect(runIds.filter((id) => stdoutB === `done:${id.slice(-16)}`)).toHaveLength(1);
      // Provenance: the runtime attribution is the real client.
      expect(sandboxA?.output?.runtimeId).toBe(`container-runner:${runner.baseUrl}`);
      expect(sandboxB?.output?.runtimeId).toBe(`container-runner:${runner.baseUrl}`);
    } finally {
      await runner.close();
    }
  });

  test("REGRESSION same-execution replay: the recovery re-drive converges with exactly ONE external run", async () => {
    // The runner holds each run `running` for 2s before completing it
    // (real execution time), racing the worker's short lease.
    const runner = await startFakeRunner({ apiToken: RUNNER_TOKEN, completeAfterMs: 2_000 });
    try {
      const w = await worldOverRunner(ctx.port, runner);
      const executionId = await w.createDispatchedExecution(
        "replay-convergence",
        identicalTask(w.containerEnvironmentId),
      );

      // Worker 1: short lease, no renewal cadence — the run COMPLETES
      // on the runner (the sandbox row records the terminal outcome)
      // but the completion write is FENCED (the C4 crash shape).
      const first = await w.createFabric({
        policy: { leaseTtlMs: 1_500, heartbeatIntervalMs: 60_000 },
      });
      const report = await first.consumeBatch();
      expect(report.executed).toBe(1);
      expect(report.fenced).toBe(1);
      expect(report.applied).toBe(0);

      // ONE external run exists, submitted exactly once.
      expect(runner.runIds()).toHaveLength(1);
      const externalRunId = runner.runIds()[0] as string;
      expect(runner.submissionsFor(externalRunId)).toStrictEqual([
        { runId: externalRunId, status: 202 },
      ]);

      // Worker 2's recovery: fresh claim + fresh lease epoch; the
      // durable sandbox identity replays the recorded terminal
      // outcome — NO second provider dispatch, NO resubmission of the
      // external run id (not even the idempotent 409) — and the
      // completion lands through the governed path.
      const second = await w.createFabric();
      const recovery = await second.recover();
      expect(recovery.claimed).toBe(1);
      expect(recovery.applied).toBe(1);

      const final = await w.service.getExecution(w.applicationId, executionId);
      expect(final?.status).toBe("COMPLETED");
      expect(final?.verificationRefs.length).toBeGreaterThanOrEqual(1);

      // STILL exactly ONE external run for this execution, with
      // exactly ONE submission — the same-execution idempotency held
      // end-to-end across the crash + re-drive.
      expect(runner.runIds()).toStrictEqual([externalRunId]);
      expect(runner.submissionsFor(externalRunId)).toStrictEqual([
        { runId: externalRunId, status: 202 },
      ]);
    } finally {
      await runner.close();
    }
  });
});
