/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * OPERATION STATE and the STABLE execution-scoped idempotency keys of
 * the long-running execution extension (WORK-028; LNG-001/002/003; the
 * blocking checkpoint contract CONCURRENCY-CRASH-SAFETY — the PHYSICAL
 * half).
 *
 * The unit suite (tests/unit/executions/longrunning-crash-recovery.test.ts)
 * proves the behavioral half over the in-memory world (23 C-records:
 * kill/restart at every durable boundary, re-admission non-re-invocation
 * on unchanged resumes, key discipline, the two real recovery defects the
 * proofs found). THIS suite proves the same kill/restart discipline
 * against REAL PostgreSQL (migrations 0001..0022): the process dies
 * mid-operation (a Proxy-based injector arms ONE durable-boundary crash
 * point per booted process, before/after the durable commit), the
 * execution_operations row (PENDING, stage jsonb, attempts ledger) —
 * plus every checkpoint/lease/wake-up/frozen-lifecycle row — physically
 * SURVIVES, and a re-booted service over the SAME PG store converges the
 * operation with EXACTLY ONE durable side effect per stable key.
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   CHECKPOINT COMMIT  P1 crash-after-claim → resume-and-complete
 *                      P2 crash-after-insert (the committed-effect
 *                      probe; the lease EXPIRED inside the crash
 *                      window) → converge, never duplicate
 *   PAUSE              P3 crash-after the frozen wait transition →
 *                      converge to WAITING_TOOL, lease released
 *   RESUME             P4 crash-after the frozen resume transition →
 *                      recovery-evidence convergence, ONE resume
 *                      P5 crash-after-claim + the CURRENT authority
 *                      CHANGED during the crash window → the retry
 *                      re-enters the LIVE policy engine (denial), the
 *                      FAILED row replays typed forever after
 *   INTERRUPTION       P6 crash-after the journal-then-act evidence →
 *                      converge to WAITING_HUMAN, lease force-released
 *   TERMINATION        P7 crash-after the frozen cancel transition →
 *                      the pre-terminal stage converges (no orphaned
 *                      PENDING claim on a terminal execution)
 *   WAKE-UP APPLY      P8 crash-after the applied marker → the
 *                      recovery scan converges the evidence tail
 *                      P9 crash-after the resume INSIDE the wake → the
 *                      recovery scan converges BOTH the wake and the
 *                      orphaned PENDING resume row
 *   LEASE              P10 renew crash-after the durable heartbeat →
 *                      exactly ONE bump per stable key
 *                      P11 acquire crash-after the guarded insert →
 *                      same-owner convergence, no epoch inflation
 *                      P12 release crash-after the durable release →
 *                      converge onto the released row (one-way); the
 *                      released epoch never renews
 *   WAKE SCHEDULING    P13 schedule crash-after the durable insert →
 *                      wake-key convergence, one row, evidence once
 *   STALE WORKER       P14 crash-after the claim (NO committed
 *                      effect) + lease expiry + NEW-worker takeover
 *                      (epoch 2) → the stale worker's retry FAILS
 *                      CLOSED typed with ZERO side effects (the
 *                      mirror of P2: an UNCOMMITTED effect is never
 *                      converged past the lease guard)
 *
 * The concurrent-resume convergence and the general stale-worker
 * discrimination classes live in the sibling PG suite
 * long-running-lifecycle.test.ts (L-records): N=8 different workers →
 * ONE authoritative resumption + 7 typed conflicts, N=8 same key →
 * one durable claim + ONE transition, expired/superseded/foreign
 * claims fail closed BEFORE any write (PG + physical trigger levels).
 */

import { describe, expect, test } from "vitest";
import type { LongRunningExecutionService } from "../../../src/modules/executions/application/long-running-service";
import { longRunningOperationKey } from "../../../src/modules/executions/domain/longrunning";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import {
  checkpointOf,
  diesDuring,
  factsOf,
  type LongRunningPgWorld,
  one,
  seedLongRunningWorld,
} from "./longrunning-world";

definePgSuite("long-running crash-injection proofs (WORK-028) on real PostgreSQL", (ctx) => {
  let world: LongRunningPgWorld;

  const freshWorld = async () => {
    world = await seedLongRunningWorld(ctx.port);
    return world;
  };

  const actor = () => world.actor();
  const APPLICATION_ID = () => world.applicationId;

  // ---- shared operation drivers (always in their own booted process) ----

  const acquire = (service: LongRunningExecutionService, executionId: string, ttlMs = 60_000) =>
    service.acquireLease(
      { applicationId: APPLICATION_ID(), executionId, actor: actor(), ownerId: "worker-1", ttlMs },
      `lease-${executionId}`,
    );

  const checkpoint = (service: LongRunningExecutionService, executionId: string) =>
    service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID(),
        executionId,
        actor: actor(),
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );

  const pause = (
    service: LongRunningExecutionService,
    executionId: string,
    key = `pause-${executionId}`,
  ) =>
    service.pauseExecution(
      {
        applicationId: APPLICATION_ID(),
        executionId,
        actor: actor(),
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      key,
    );

  const pauseWithWake = (
    service: LongRunningExecutionService,
    executionId: string,
    wakeKey: string,
    key: string,
  ) =>
    service.pauseExecution(
      {
        applicationId: APPLICATION_ID(),
        executionId,
        actor: actor(),
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey,
          cause: "tool result pending",
          earliestWakeAt: new Date(Date.now() - 1_000).toISOString(),
        },
      },
      key,
    );

  const resume = (
    service: LongRunningExecutionService,
    executionId: string,
    key: string,
    factsOverrides: Record<string, unknown> = {},
  ) =>
    service.resumeExecution(
      {
        applicationId: APPLICATION_ID(),
        executionId,
        actor: actor(),
        resumeFacts: factsOf(checkpointOf(executionId)),
        ...factsOverrides,
      },
      key,
    );

  const interrupt = (service: LongRunningExecutionService, executionId: string) =>
    service.requestInterruption(
      { applicationId: APPLICATION_ID(), executionId, actor: actor(), reason: "operator halt" },
      `interrupt-${executionId}`,
    );

  const terminate = (service: LongRunningExecutionService, executionId: string) =>
    service.terminateExecution(
      { applicationId: APPLICATION_ID(), executionId, actor: actor(), reason: "governed shutdown" },
      `terminate-${executionId}`,
    );

  // ---- SQL inspection helpers ---------------------------------------------

  const operationRow = (kind: string, discriminator: string) =>
    one<{
      status: string;
      attempts: number;
      stage: Record<string, unknown> | null;
      failure_reason: string | null;
    }>(
      ctx.port,
      "SELECT status, attempts, stage, failure_reason FROM executions.execution_operations WHERE application_id = $1 AND operation_key = $2",
      [APPLICATION_ID(), longRunningOperationKey(kind as never, discriminator)],
    );

  const leaseRow = (executionId: string) =>
    one<{
      owner_id: string;
      epoch: number;
      heartbeat_count: number;
      released_at: string | null;
      release_cause: string | null;
    }>(
      ctx.port,
      "SELECT owner_id, epoch, heartbeat_count, released_at, release_cause FROM executions.execution_leases WHERE execution_id = $1",
      [executionId],
    );

  const wakeRow = (executionId: string, wakeKey: string) =>
    one<{ status: string; applied_operation_key: string | null; supersede_cause: string | null }>(
      ctx.port,
      "SELECT status, applied_operation_key, supersede_cause FROM executions.execution_wakeups WHERE application_id = $1 AND execution_id = $2 AND wake_key = $3",
      [APPLICATION_ID(), executionId, wakeKey],
    );

  const checkpointCount = async (executionId: string) =>
    Number(
      (
        await one<{ n: number }>(
          ctx.port,
          "SELECT COUNT(*)::int AS n FROM executions.execution_checkpoints WHERE execution_id = $1",
          [executionId],
        )
      )?.n ?? 0,
    );

  const wakeCount = async (executionId: string) =>
    Number(
      (
        await one<{ n: number }>(
          ctx.port,
          "SELECT COUNT(*)::int AS n FROM executions.execution_wakeups WHERE execution_id = $1",
          [executionId],
        )
      )?.n ?? 0,
    );

  const eventsOf = async (executionId: string, command: string) =>
    Number(
      (
        await one<{ n: number }>(
          ctx.port,
          "SELECT COUNT(*)::int AS n FROM executions.execution_events WHERE execution_id = $1 AND command = $2",
          [executionId, command],
        )
      )?.n ?? 0,
    );

  const statusOf = async (executionId: string) =>
    (
      await one<{ status: string }>(
        ctx.port,
        "SELECT status FROM executions.executions WHERE id = $1",
        [executionId],
      )
    )?.status;

  const expectPlatformError = async (run: () => Promise<unknown>, code: string) => {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
      return;
    }
    throw new Error(`expected a typed ${code} failure`);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe("P-records: kill/restart at the durable boundaries", () => {
    test("P1 CHECKPOINT: crash AFTER the durable operation claim — the PENDING row survives; the restart commits EXACTLY ONE checkpoint and completes the operation", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const dying = world.boot({ target: "store", method: "beginOperation", when: "after" });
      await diesDuring(() => checkpoint(dying.service, executionId), dying.crashed);
      // The claim is durable; nothing else committed.
      expect(await operationRow("checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
        status: "pending",
        attempts: 1,
        stage: null,
      });
      expect(await checkpointCount(executionId)).toBe(0);
      // RESTART: the same logical checkpoint completes with exactly one row.
      const restarted = world.boot(null);
      const outcome = await checkpoint(restarted.service, executionId);
      expect(outcome.replayed).toBe(false);
      expect(outcome.checkpointSequence).toBe(1);
      expect(await checkpointCount(executionId)).toBe(1);
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(1);
      expect(await operationRow("checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P2 CHECKPOINT: crash AFTER the durable checkpoint insert — the committed-effect probe converges WITHOUT a second row and WITHOUT the lease guard (the lease EXPIRED during the crash window)", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      // A 250ms lease: live through the checkpoint insert (the guard
      // passes with ~100x margin), expired inside the crash window.
      await acquire(world.boot(null).service, executionId, 250);
      const dying = world.boot({ target: "store", method: "insertCheckpoint", when: "after" });
      await diesDuring(() => checkpoint(dying.service, executionId), dying.crashed);
      expect(await checkpointCount(executionId)).toBe(1); // the side effect is durable
      expect(await operationRow("checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
        status: "pending",
      });
      await sleep(400); // the lease expires while the process is dead
      // RESTART with the STALE worker claim: the digest probe converges the
      // committed effect BEFORE the lease guard — an already-committed
      // effect is never duplicated and never blocked by a stale lease.
      const restarted = world.boot(null);
      const outcome = await checkpoint(restarted.service, executionId);
      expect(outcome.checkpointSequence).toBe(1);
      expect(await checkpointCount(executionId)).toBe(1); // EXACTLY ONE row
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(1);
      expect(await operationRow("checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P3 PAUSE: crash AFTER the frozen wait transition — the restart converges to WAITING_TOOL with one checkpoint, one wait event, and the lease released", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const dying = world.boot({ target: "executions", method: "transition", when: "after" });
      await diesDuring(() => pause(dying.service, executionId), dying.crashed);
      // The checkpoint + the frozen wait move committed; the wake/release
      // tail did not.
      expect(await checkpointCount(executionId)).toBe(1);
      expect(await statusOf(executionId)).toBe("WAITING_TOOL");
      expect(await operationRow("pause", `${executionId}:pause-${executionId}`)).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key converges the whole pause protocol.
      const restarted = world.boot(null);
      const outcome = await pause(restarted.service, executionId);
      expect(outcome.status).toBe("WAITING_TOOL");
      expect(outcome.leaseReleased).toBe(true);
      expect(await checkpointCount(executionId)).toBe(1);
      expect(await eventsOf(executionId, "wait-tool")).toBe(1);
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(1);
      expect(await leaseRow(executionId)).toMatchObject({ release_cause: "paused" });
      expect(await operationRow("pause", `${executionId}:pause-${executionId}`)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P4 RESUME: crash AFTER the frozen resume transition — the restart converges through the recovery-evidence path; ONE resume transition, the identity unchanged", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      await pause(world.boot(null).service, executionId);
      expect(await statusOf(executionId)).toBe("WAITING_TOOL");
      const dying = world.boot({ target: "executions", method: "transition", when: "after" });
      await diesDuring(
        () => resume(dying.service, executionId, `resume-${executionId}`),
        dying.crashed,
      );
      // The resume move committed; the stage/completion tail did not.
      expect(await statusOf(executionId)).toBe("RUNNING");
      expect(await operationRow("resume", `${executionId}:resume-${executionId}`)).toMatchObject({
        status: "pending",
      });
      // RESTART: the RUNNING recovery path records the recovery evidence
      // exactly once and completes the operation.
      const restarted = world.boot(null);
      const outcome = await resume(restarted.service, executionId, `resume-${executionId}`);
      expect(outcome.executionId).toBe(executionId); // the SAME identity
      expect(outcome.status).toBe("RUNNING");
      expect(outcome.readmitted).toBe(false);
      expect(await eventsOf(executionId, "resume")).toBe(1); // ONE transition
      expect(await eventsOf(executionId, "resume-recorded")).toBe(1);
      expect(await operationRow("resume", `${executionId}:resume-${executionId}`)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P5 RESUME (materially changed): crash AFTER the claim; the CURRENT policy authority CHANGED during the crash window — the retry re-enters the LIVE engine, is denied, and the FAILED row replays typed forever", async () => {
      await freshWorld();
      await world.fundApplication("1000000");
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      await pause(world.boot(null).service, executionId);
      // The materially changed resume: a NEW cost bound (null -> 500000).
      const changedFacts = factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" }));
      const dying = world.boot({ target: "store", method: "beginOperation", when: "after" });
      await diesDuring(
        () =>
          dying.service.resumeExecution(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              resumeFacts: changedFacts,
            },
            `cost-${executionId}`,
          ),
        dying.crashed,
      );
      expect(await operationRow("resume", `${executionId}:cost-${executionId}`)).toMatchObject({
        status: "pending",
        attempts: 1,
      });
      // The CURRENT authority state changes while the process is dead: a
      // restrictive policy set v2 (cost ceiling 100000) is published.
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { cost: { maxCostMicroUsd: "100000" } },
          },
        ],
      });
      // RESTART: the retry re-enters the LIVE engine (never a snapshot of
      // the pre-crash authority state) and fails closed, journaled.
      const restarted = world.boot(null);
      await expectPlatformError(
        () =>
          restarted.service.resumeExecution(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              resumeFacts: changedFacts,
            },
            `cost-${executionId}`,
          ),
        "POLICY_DENIED",
      );
      expect(await eventsOf(executionId, "resume-denied")).toBe(1);
      expect(await statusOf(executionId)).toBe("WAITING_TOOL"); // never resumed
      expect(await operationRow("resume", `${executionId}:cost-${executionId}`)).toMatchObject({
        status: "failed",
        attempts: 2,
      });
      // The durable denial replays typed on the SAME key — never re-derived.
      await expectPlatformError(
        () =>
          restarted.service.resumeExecution(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              resumeFacts: changedFacts,
            },
            `cost-${executionId}`,
          ),
        "POLICY_DENIED",
      );
      expect(await eventsOf(executionId, "resume-denied")).toBe(1); // exactly once
      // The authority state rolls forward again (v3 platform-allow): a
      // retry under the SAME key is STILL denied (terminal FAILED), but a
      // NEW claim re-enters the LIVE engine and completes.
      await world.policyAuthority.publish({
        id: "default",
        version: 3,
        documents: [{ scope: "platform", selector: {}, restrictions: {} }],
      });
      await expectPlatformError(
        () =>
          restarted.service.resumeExecution(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              resumeFacts: changedFacts,
            },
            `cost-${executionId}`,
          ),
        "POLICY_DENIED",
      );
      const readmitted = await resume(restarted.service, executionId, `cost-ok-${executionId}`, {
        resumeFacts: changedFacts,
      });
      expect(readmitted.readmitted).toBe(true);
      expect(readmitted.status).toBe("RUNNING");
    });

    test("P6 INTERRUPTION: crash AFTER the journal-then-act evidence — the restart completes the interruption; the request evidence exists exactly once", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const dying = world.boot({ target: "executions", method: "recordStepEvent", when: "after" });
      await diesDuring(() => interrupt(dying.service, executionId), dying.crashed);
      // The interruption request evidence committed (journal-then-act);
      // nothing else did.
      expect(await eventsOf(executionId, "interruption-requested")).toBe(1);
      expect(await statusOf(executionId)).toBe("RUNNING");
      expect(
        await operationRow("interrupt", `${executionId}:interrupt-${executionId}`),
      ).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key converges the whole interruption.
      const restarted = world.boot(null);
      const outcome = await interrupt(restarted.service, executionId);
      expect(outcome.status).toBe("WAITING_HUMAN");
      expect(outcome.leaseReleased).toBe(true);
      expect(await eventsOf(executionId, "interruption-requested")).toBe(1); // once
      expect(await eventsOf(executionId, "wait-human")).toBe(1);
      expect(await leaseRow(executionId)).toMatchObject({ release_cause: "human-interruption" });
      expect(
        await operationRow("interrupt", `${executionId}:interrupt-${executionId}`),
      ).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P7 TERMINATION: crash AFTER the frozen cancel transition — the pre-terminal stage converges the recovery; no orphaned PENDING claim on a terminal execution", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const dying = world.boot({ target: "executions", method: "transition", when: "after" });
      await diesDuring(() => terminate(dying.service, executionId), dying.crashed);
      // The governed cancel committed; the completion tail did not.
      expect(await statusOf(executionId)).toBe("CANCELLED");
      expect(
        await operationRow("terminate", `${executionId}:terminate-${executionId}`),
      ).toMatchObject({
        status: "pending",
      });
      // RESTART: the durable "terminating" stage + the terminal row prove
      // the cancel committed DURING this operation — the retry converges
      // instead of failing the honest retry closed.
      const restarted = world.boot(null);
      const outcome = await terminate(restarted.service, executionId);
      expect(outcome.status).toBe("CANCELLED");
      expect(outcome.replayed).toBe(false);
      expect(await eventsOf(executionId, "cancel")).toBe(1);
      expect(
        await operationRow("terminate", `${executionId}:terminate-${executionId}`),
      ).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P8 WAKE-UP APPLY: crash AFTER the applied marker — the recovery scan converges the evidence tail; the marker is write-once", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      await pauseWithWake(
        world.boot(null).service,
        executionId,
        "tool-return",
        `pause-${executionId}`,
      );
      expect(await statusOf(executionId)).toBe("WAITING_TOOL");
      const dying = world.boot({ target: "store", method: "markWakeUpApplied", when: "after" });
      await diesDuring(
        () => dying.service.applyWakeUps({ applicationId: APPLICATION_ID(), actor: actor() }),
        dying.crashed,
      );
      // The wake marker + the resume committed; the evidence/completion
      // tail did not.
      expect(await wakeRow(executionId, "tool-return")).toMatchObject({ status: "applied" });
      expect(await statusOf(executionId)).toBe("RUNNING");
      expect(await operationRow("wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "pending",
      });
      // RESTART: the recovery scan converges the PENDING claim ("replayed").
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyWakeUps({
        applicationId: APPLICATION_ID(),
        actor: actor(),
      });
      expect(outcome.applications).toEqual([
        { action: "replayed", wakeKey: "tool-return", executionId },
      ]);
      expect(await eventsOf(executionId, "resume")).toBe(1); // ONE resume
      expect(await eventsOf(executionId, "wake-up-applied")).toBe(1); // once
      expect(await operationRow("wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "completed",
        attempts: 1, // the restart never re-claimed (recovery-scan convergence)
      });
    });

    test("P9 WAKE-UP APPLY: crash AFTER the resume INSIDE the wake application — the recovery scan converges BOTH the wake and the orphaned PENDING resume row", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      await pauseWithWake(
        world.boot(null).service,
        executionId,
        "tool-return",
        `pause-${executionId}`,
      );
      expect(await statusOf(executionId)).toBe("WAITING_TOOL");
      // The ONLY transition of the dying process is the wake's resume.
      const dying = world.boot({ target: "executions", method: "transition", when: "after" });
      await diesDuring(
        () => dying.service.applyWakeUps({ applicationId: APPLICATION_ID(), actor: actor() }),
        dying.crashed,
      );
      // The resume transition committed; the wake marker, the evidence and
      // both completions did not: TWO orphaned PENDING rows (wakeup-apply +
      // resume under the wake's stable key).
      expect(await statusOf(executionId)).toBe("RUNNING");
      expect(await wakeRow(executionId, "tool-return")).toMatchObject({ status: "scheduled" });
      expect(await operationRow("wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "pending",
      });
      expect(await operationRow("resume", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "pending",
      });
      // RESTART: the recovery scan + the RUNNING branch converge both rows.
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyWakeUps({
        applicationId: APPLICATION_ID(),
        actor: actor(),
      });
      expect(outcome.applications).toEqual([
        { action: "already-running", wakeKey: "tool-return", executionId },
      ]);
      expect(await statusOf(executionId)).toBe("RUNNING");
      expect(await wakeRow(executionId, "tool-return")).toMatchObject({ status: "applied" });
      expect(await eventsOf(executionId, "resume")).toBe(1); // ONE resume, total
      expect(await eventsOf(executionId, "resume-recorded")).toBe(1); // the recovery evidence
      expect(await eventsOf(executionId, "wake-up-applied")).toBe(1);
      expect(await operationRow("wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "completed",
      });
      expect(await operationRow("resume", `${executionId}:wake:tool-return`)).toMatchObject({
        status: "completed",
      });
    });

    test("P10 LEASE RENEW: crash AFTER the durable heartbeat — the pre-state comparison converges; the heartbeat ledger advances EXACTLY ONCE per key", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const setup = world.boot(null);
      await acquire(setup.service, executionId);
      // The renew crashes AFTER the durable store renew (before the
      // "renewed" stage).
      const dying = world.boot({ target: "store", method: "renewLease", when: "after" });
      await diesDuring(
        () =>
          dying.service.renewLease(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              worker: { ownerId: "worker-1", epoch: 1 },
              ttlMs: 60_000,
            },
            `hb-${executionId}`,
          ),
        dying.crashed,
      );
      // The durable renew committed (heartbeat_count 1); the operation row
      // is the honest PENDING claim with the "renewing" pre-state.
      expect(await leaseRow(executionId)).toMatchObject({ heartbeat_count: 1 });
      expect(await operationRow("lease-renew", `${executionId}:hb-${executionId}`)).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key CONVERGES (the counter is already past the
      // pre-state) — no second bump.
      const restarted = world.boot(null);
      const outcome = await restarted.service.renewLease(
        {
          applicationId: APPLICATION_ID(),
          executionId,
          actor: actor(),
          worker: { ownerId: "worker-1", epoch: 1 },
          ttlMs: 60_000,
        },
        `hb-${executionId}`,
      );
      expect(outcome.replayed).toBe(true);
      expect(outcome.lease.heartbeatCount).toBe(1); // EXACTLY ONE bump
      expect(await leaseRow(executionId)).toMatchObject({ heartbeat_count: 1 });
      expect(await operationRow("lease-renew", `${executionId}:hb-${executionId}`)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P11 LEASE ACQUIRE: crash AFTER the guarded insert — the same-owner convergence completes WITHOUT a second row or epoch inflation", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const dying = world.boot({ target: "store", method: "acquireLease", when: "after" });
      await diesDuring(() => acquire(dying.service, executionId), dying.crashed);
      // The lease row committed (epoch 1, worker-1); the operation row is
      // the honest PENDING claim.
      expect(await leaseRow(executionId)).toMatchObject({ owner_id: "worker-1", epoch: 1 });
      expect(
        await operationRow("lease-acquire", `${executionId}:lease-${executionId}`),
      ).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key converges through the same-owner branch.
      const restarted = world.boot(null);
      const outcome = await acquire(restarted.service, executionId);
      expect(outcome.replayed).toBe(false);
      expect(outcome.lease.epoch).toBe(1); // NO epoch inflation
      expect(await leaseRow(executionId)).toMatchObject({ owner_id: "worker-1", epoch: 1 });
      expect(
        await operationRow("lease-acquire", `${executionId}:lease-${executionId}`),
      ).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P12 LEASE RELEASE: crash AFTER the durable release — the retry converges onto the released row (one-way release); the released epoch never renews", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const dying = world.boot({ target: "store", method: "releaseLease", when: "after" });
      await diesDuring(
        () =>
          dying.service.releaseLease(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              worker: { ownerId: "worker-1", epoch: 1 },
              cause: "worker-released",
            },
            `release-${executionId}`,
          ),
        dying.crashed,
      );
      // The durable release committed (one-way, with cause); the operation
      // row is the honest PENDING claim.
      expect(await leaseRow(executionId)).toMatchObject({ release_cause: "worker-released" });
      expect(
        await operationRow("lease-release", `${executionId}:release-${executionId}`),
      ).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key converges onto the RELEASED row — the
      // release is one-way; no epoch moved, no owner changed.
      const restarted = world.boot(null);
      const outcome = await restarted.service.releaseLease(
        {
          applicationId: APPLICATION_ID(),
          executionId,
          actor: actor(),
          worker: { ownerId: "worker-1", epoch: 1 },
          cause: "worker-released",
        },
        `release-${executionId}`,
      );
      expect(outcome.lease?.releaseCause).toBe("worker-released");
      expect(await leaseRow(executionId)).toMatchObject({
        owner_id: "worker-1",
        epoch: 1,
        release_cause: "worker-released",
      });
      expect(
        await operationRow("lease-release", `${executionId}:release-${executionId}`),
      ).toMatchObject({
        status: "completed",
        attempts: 2,
      });
      // The released epoch is stale forever: a renew under the released
      // claim fails closed typed (stale workers never mutate the lease).
      await expectPlatformError(
        () =>
          restarted.service.renewLease(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              worker: { ownerId: "worker-1", epoch: 1 },
              ttlMs: 60_000,
            },
            `hb2-${executionId}`,
          ),
        "INVALID_STATE_TRANSITION",
      );
      expect(await leaseRow(executionId)).toMatchObject({ heartbeat_count: 0 });
    });

    test("P13 WAKE-UP SCHEDULING: crash AFTER the durable wake insert — the wake-key convergence completes the schedule; ONE row, ONE evidence event", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await acquire(world.boot(null).service, executionId);
      const earliestWakeAt = new Date(Date.now() + 60_000).toISOString();
      const dying = world.boot({ target: "store", method: "insertWakeUp", when: "after" });
      await diesDuring(
        () =>
          dying.service.scheduleWakeUp(
            {
              applicationId: APPLICATION_ID(),
              executionId,
              actor: actor(),
              wakeKey: "retry-backoff",
              cause: "backoff retry",
              earliestWakeAt,
            },
            `sched-${executionId}`,
          ),
        dying.crashed,
      );
      // The durable wake row committed; the evidence/completion tail did not.
      expect(await wakeRow(executionId, "retry-backoff")).toMatchObject({ status: "scheduled" });
      expect(
        await operationRow("wakeup-schedule", `${executionId}:sched-${executionId}`),
      ).toMatchObject({
        status: "pending",
      });
      // RESTART: the same key converges — the wake-key UNIQUE absorbs the
      // duplicate insert; the evidence exists exactly once.
      const restarted = world.boot(null);
      const outcome = await restarted.service.scheduleWakeUp(
        {
          applicationId: APPLICATION_ID(),
          executionId,
          actor: actor(),
          wakeKey: "retry-backoff",
          cause: "backoff retry",
          earliestWakeAt,
        },
        `sched-${executionId}`,
      );
      expect(outcome.status).toBe("scheduled");
      expect(await wakeCount(executionId)).toBe(1); // EXACTLY ONE row
      expect(await eventsOf(executionId, "wake-up-scheduled")).toBe(1);
      expect(
        await operationRow("wakeup-schedule", `${executionId}:sched-${executionId}`),
      ).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    test("P14 STALE WORKER: crash AFTER the claim (NO committed effect) + lease expiry + NEW-worker takeover — the stale worker's retry FAILS CLOSED with ZERO side effects; the successor works", async () => {
      await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      // A 250ms lease: live through the claim, expired inside the crash
      // window.
      await acquire(world.boot(null).service, executionId, 250);
      const dying = world.boot({ target: "store", method: "beginOperation", when: "after" });
      await diesDuring(() => checkpoint(dying.service, executionId), dying.crashed);
      // NO committed checkpoint — the claim is the ONLY durable artifact.
      expect(await checkpointCount(executionId)).toBe(0);
      await sleep(400); // the lease expires while the process is dead
      // A NEW worker re-acquires the expired lease: epoch 2 (monotonic).
      const successor = world.boot(null);
      const takeover = await successor.service.acquireLease(
        {
          applicationId: APPLICATION_ID(),
          executionId,
          actor: actor(),
          ownerId: "worker-2",
          ttlMs: 60_000,
        },
        `takeover-${executionId}`,
      );
      expect(takeover.lease.epoch).toBe(2);
      expect(takeover.lease.ownerId).toBe("worker-2");
      // The STALE worker's retry (same key, NO committed effect): FAIL
      // CLOSED typed — an uncommitted effect is never converged past the
      // lease guard (the mirror of P2's committed-effect convergence).
      await expectPlatformError(
        () => checkpoint(successor.service, executionId),
        "INVALID_STATE_TRANSITION",
      );
      // ZERO side effects: no checkpoint row, no ledger evidence, the
      // lease stays with the successor; the claim stays honestly PENDING.
      expect(await checkpointCount(executionId)).toBe(0);
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(0);
      expect(await leaseRow(executionId)).toMatchObject({ owner_id: "worker-2", epoch: 2 });
      expect(await operationRow("checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
        status: "pending",
        attempts: 2,
      });
      // The execution is NOT wedged: the CURRENT owner checkpoints under
      // its own claim.
      const outcome = await successor.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID(),
          executionId,
          actor: actor(),
          worker: { ownerId: "worker-2", epoch: 2 },
          contents: checkpointOf(executionId),
        },
        `ck2-${executionId}`,
      );
      expect(outcome.replayed).toBe(false);
      expect(outcome.checkpointSequence).toBe(1);
      expect(await checkpointCount(executionId)).toBe(1);
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(1);
    });
  });
});
