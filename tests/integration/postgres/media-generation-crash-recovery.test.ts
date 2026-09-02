/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * OPERATION STATE and the STABLE rail-level idempotency keys (WORK-026;
 * checkpoint contract CONCURRENCY-CRASH-SAFETY — the PHYSICAL half).
 *
 * The unit suite (tests/unit/deployments/media-generation-
 * crash-recovery.test.ts) proves the behavioral half over the
 * in-memory world (23 C-records: kill/restart at every durable
 * boundary, admission/seam non-re-invocation, key discipline). THIS
 * suite proves the same kill/restart discipline against REAL
 * PostgreSQL (migrations 0001..0021): the process dies mid-operation,
 * the `media_operations` row (PENDING, checkpoint jsonb, attempts
 * ledger) physically SURVIVES, and a re-booted service (the process
 * restart) — over the SAME PG store, the SAME executions ledger, the
 * SAME real budgets/verification/artifacts services and the SAME
 * upstream rail (the external provider's idempotency-key ledger) —
 * converges the operation to COMPLETED with EXACTLY ONE upstream paid
 * side effect per stable key (MOD-013: retries and callbacks are
 * idempotent and cannot silently create uncontrolled paid duplicates).
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   SUBMISSION        P1 crash after the job-recorded checkpoint →
 *                     replay-path resume · P2 crash after the durable
 *                     job row insert → dispatch resume, zero re-admission
 *   PAID DISPATCH     P3 crash after the rail accepted the paid
 *                     dispatch → stable-key replay · P4 crash after the
 *                     dispatched checkpoint → resume WITHOUT a second
 *                     rail call · P5 crash after the guarded generating
 *                     move → reconcile from the job row's proof
 *   CALLBACK APPLY    P6 crash after the observation evidence row →
 *                     converge + complete · P7 crash after the
 *                     artifact-adopted checkpoint → resume the
 *                     verification/completion tail (write-once adoption)
 *   CANCELLATION      P8 crash after the rail cancellation → stable-key
 *                     replay · P9 crash after the guarded cancelled
 *                     move → reconcile + re-drive the executions tail
 *   BUDGET RELEASE    P10 the pre-settlement crash window: cancel a
 *                     dispatched-but-unsettled job → the HELD
 *                     reservation is physically RELEASED (the wallet is
 *                     refunded) and the pending dispatch operation is
 *                     reconciled FAILED
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { completedCallbackFor, type MediaPgWorld, seedMediaWorld } from "./media-world";

definePgSuite("media crash-injection proofs (WORK-026) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<MediaPgWorld> {
    return seedMediaWorld(ctx.port);
  }

  /** Run one operation in a DYING process (the outcome is irrelevant — the process is gone). */
  async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
    await run().then(
      () => undefined,
      () => undefined,
    );
    expect(crashed()).toBe(true);
  }

  const railDispatches = (world: MediaPgWorld) =>
    world.rail.sends.filter((record) => record.kind === "dispatch");
  const railCancels = (world: MediaPgWorld) =>
    world.rail.sends.filter((record) => record.kind === "cancel");

  // ---- SQL inspection helpers ---------------------------------------------

  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.media_operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
  }

  async function jobRow(applicationId: string, jobId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.media_jobs WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, jobId],
    });
    return result.rows[0] ?? null;
  }

  async function observationCount(applicationId: string, jobId: string, observationKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.media_observations WHERE application_id = $1 AND job_id = $2 AND observation_key = $3`,
      parameters: [applicationId, jobId, observationKey],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function artifactRowCount(applicationId: string, jobId: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.media_artifacts WHERE application_id = $1 AND job_id = $2`,
      parameters: [applicationId, jobId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function executionStatusOf(applicationId: string, executionId: string) {
    const result = await ctx.port.execute<{ status: string }>({
      sql: `SELECT status FROM executions.executions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, executionId],
    });
    return result.rows[0]?.status ?? null;
  }

  async function walletBalance(applicationId: string): Promise<string> {
    const result = await ctx.port.execute<{ balance_micro_usd: string }>({
      sql: `SELECT balance_micro_usd FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'`,
      parameters: [applicationId],
    });
    return result.rows[0]?.balance_micro_usd ?? "missing";
  }

  async function reservationCount(applicationId: string, operationId: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM budgets.reservations WHERE application_id = $1 AND operation_id = $2`,
      parameters: [applicationId, operationId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  const IMAGE_COST = 80000;
  const GRANT = "50000000";

  const submitInput = (world: MediaPgWorld, prompt: string) => ({
    deploymentId: world.deploymentId,
    generationKind: "image" as const,
    prompt,
  });

  describe("P-records: kill/restart at the durable boundaries", () => {
    test("P1 SUBMIT: crash AFTER the job-recorded checkpoint — the PG rows survive PENDING; the restart replay resumes the dispatch with exactly ONE paid dispatch", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const dying = world.boot({
        target: "store",
        method: "recordMediaOperationCheckpoint",
        when: "after",
        occurrence: 1,
      });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "an amber wolf"), "submit-p1", actor),
        dying.crashed,
      );
      // The durable job row exists (submitted — the checkpoint follows
      // the insert); the submission operation is PENDING with the
      // checkpoint; the rail was never called.
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p1"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("submitted");
      const row = await operationRow(world.applicationId, "mediaop:job-submission:submit-p1");
      expect(row?.status).toBe("pending");
      expect((row?.checkpoint as Record<string, unknown> | null)?.stage).toBe("job-recorded");
      expect(railDispatches(world)).toHaveLength(0);
      // RESTART: the submission replay (find-by-key → fingerprint
      // arbitration → dispatch) completes the durable tail.
      const restarted = world.boot(null);
      const outcome = await restarted.service.submitJob(
        submitInput(world, "an amber wolf"),
        "submit-p1",
        actor,
      );
      expect(outcome.jobId).toBe(jobId);
      expect(outcome.status).toBe("generating");
      expect(outcome.replayed).toBe(true);
      // EXACTLY ONE upstream paid dispatch (the rail never saw the key
      // before the crash); ONE reservation for the stable operation id.
      expect(railDispatches(world)).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      expect(await reservationCount(world.applicationId, `media-reserve:${jobId}`)).toBe(1);
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
      // The operation rows converged to COMPLETED (the submission op
      // completed through the replay's tail).
      expect(
        (await operationRow(world.applicationId, "mediaop:job-submission:submit-p1"))?.status,
      ).toBe("completed");
      expect(
        (await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`))?.status,
      ).toBe("completed");
      // The execution is RUNNING (the mapped governed execution).
      expect(await executionStatusOf(world.applicationId, outcome.executionId)).toBe("RUNNING");
    });

    test("P2 SUBMIT: crash AFTER the durable job row insert — the restart resumes the dispatch (zero re-admission side effects beyond the keyed convergence)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const dying = world.boot({ target: "store", method: "insertJob", when: "after" });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "a bronze fox"), "submit-p2", actor),
        dying.crashed,
      );
      // The job row is durably submitted; the operation row is PENDING
      // WITHOUT a checkpoint (the crash preceded it); no dispatch.
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p2"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("submitted");
      const row = await operationRow(world.applicationId, "mediaop:job-submission:submit-p2");
      expect(row?.status).toBe("pending");
      // NO checkpoint yet (the crash landed between the insert and the
      // checkpoint write) — the honest PENDING state.
      expect(row?.checkpoint).toBeNull();
      expect(railDispatches(world)).toHaveLength(0);
      // RESTART: the replay dispatches exactly once.
      const restarted = world.boot(null);
      const outcome = await restarted.service.submitJob(
        submitInput(world, "a bronze fox"),
        "submit-p2",
        actor,
      );
      expect(outcome.status).toBe("generating");
      expect(railDispatches(world)).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
      expect(
        (await operationRow(world.applicationId, "mediaop:job-submission:submit-p2"))?.status,
      ).toBe("completed");
      expect(
        (await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`))?.status,
      ).toBe("completed");
    });

    test("P3 PAID DISPATCH: crash AFTER the rail accepted the paid dispatch — the restart re-issues under the SAME key and the rail converges (ONE paid dispatch)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const dying = world.boot({ target: "rail", method: "submitJob", when: "after" });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "a violet owl"), "submit-p3", actor),
        dying.crashed,
      );
      // The upstream PAID side effect HAPPENED (the external world
      // moved); the durable tail did not — the job row is at
      // dispatching, the paid-dispatch operation is PENDING (no
      // checkpoint: the crash preceded it).
      expect(railDispatches(world)).toHaveLength(1);
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p3"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("dispatching");
      const dispatchOp = await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`);
      expect(dispatchOp?.status).toBe("pending");
      // The reservation is HELD (reserve committed, settle did not).
      expect(await reservationCount(world.applicationId, `media-reserve:${jobId}`)).toBe(1);
      // RESTART: the resubmission re-issues the paid dispatch under the
      // SAME stable key — the rail REPLAYS the original acknowledgment
      // (the wallet is debited exactly once: the settled reservation).
      const restarted = world.boot(null);
      const outcome = await restarted.service.submitJob(
        submitInput(world, "a violet owl"),
        "submit-p3",
        actor,
      );
      expect(outcome.status).toBe("generating");
      expect(railDispatches(world)).toHaveLength(1);
      const dispatchReplays = world.rail.replays.filter((r) => r.kind === "dispatch");
      expect(dispatchReplays).toHaveLength(1);
      expect(dispatchReplays[0]?.idempotencyKey).toBe(`mediarail:dispatch:${jobId}`);
      expect(outcome.providerJobRef).toBe(railDispatches(world)[0]?.providerJobRef);
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
      expect(
        (await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`))?.status,
      ).toBe("completed");
    });

    test("P4 PAID DISPATCH: crash AFTER the dispatched checkpoint — the restart completes the tail WITHOUT re-admission and WITHOUT a second rail call", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      // The SECOND checkpoint in the submission flow is the paid
      // dispatch's `dispatched` stage (past the point of no return).
      const dying = world.boot({
        target: "store",
        method: "recordMediaOperationCheckpoint",
        when: "after",
        occurrence: 2,
      });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "a crimson kite"), "submit-p4", actor),
        dying.crashed,
      );
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p4"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("dispatching");
      const dispatchOp = await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`);
      expect(dispatchOp?.status).toBe("pending");
      expect((dispatchOp?.checkpoint as Record<string, unknown> | null)?.stage).toBe("dispatched");
      expect(railDispatches(world)).toHaveLength(1);
      // RESTART: the durable tail completes from the checkpoint facts —
      // NO second rail call AT ALL, NO second reservation (admission is
      // never re-run past the point of no return).
      const restarted = world.boot(null);
      const outcome = await restarted.service.submitJob(
        submitInput(world, "a crimson kite"),
        "submit-p4",
        actor,
      );
      expect(outcome.status).toBe("generating");
      expect(railDispatches(world)).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      expect(await reservationCount(world.applicationId, `media-reserve:${jobId}`)).toBe(1);
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
      expect(
        (await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`))?.status,
      ).toBe("completed");
    });

    test("P5 PAID DISPATCH: crash AFTER the guarded generating move — the restart reconciles the PENDING row from the job row's durable proof", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      // The SECOND guarded mutation in the submission flow is the
      // dispatching → generating move (which records the rail reference).
      const dying = world.boot({
        target: "store",
        method: "applyGuardedJobMutation",
        when: "after",
        occurrence: 2,
      });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "an ivory stag"), "submit-p5", actor),
        dying.crashed,
      );
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status, provider_job_ref FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p5"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("generating");
      expect(String(pendingJob.rows[0]?.provider_job_ref)).toMatch(/^simmedia-job-\d+$/);
      // The paid-dispatch operation is PENDING (the crash landed between
      // the guarded move and the operation completion).
      const pending = await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`);
      expect(pending?.status).toBe("pending");
      // RESTART: the submission replay reconciles the row from the job
      // row's durable proof (generating + the rail reference).
      const restarted = world.boot(null);
      const outcome = await restarted.service.submitJob(
        submitInput(world, "an ivory stag"),
        "submit-p5",
        actor,
      );
      expect(outcome.status).toBe("generating");
      expect(railDispatches(world)).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      const reconciled = await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`);
      expect(reconciled?.status).toBe("completed");
    });

    test("P6 CALLBACK APPLY: crash AFTER the observation evidence row — the restart converges the application and completes the job through the deterministic boundary", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const submitted = await clean.service.submitJob(
        submitInput(world, "a cobalt whale"),
        "submit-p6",
        actor,
      );
      const dying = world.boot({ target: "store", method: "appendObservation", when: "after" });
      const frame = completedCallbackFor(submitted.jobId, submitted.providerJobRef ?? "", "cb-p6");
      await diesDuring(() => dying.service.applyCallback(frame, actor), dying.crashed);
      // The observation evidence row committed; the operation row is
      // PENDING; the job is still generating (the projection never ran).
      expect(await observationCount(world.applicationId, submitted.jobId, "cb-p6")).toBe(1);
      const row = await operationRow(
        world.applicationId,
        `mediaop:observation-apply:${submitted.jobId}:cb-p6`,
      );
      expect(row?.status).toBe("pending");
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("generating");
      // RESTART: the SAME callback frame re-applies — the observation
      // row converges (ONE physical row), and the completion tail runs
      // (verifying → adoption → completed; the execution COMPLETED).
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyCallback(frame, actor);
      expect(outcome.status).toBe("completed");
      expect(outcome.replayed).toBe(true);
      expect(await observationCount(world.applicationId, submitted.jobId, "cb-p6")).toBe(1);
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("completed");
      expect(await artifactRowCount(world.applicationId, submitted.jobId)).toBe(1);
      expect(await executionStatusOf(world.applicationId, submitted.executionId)).toBe("COMPLETED");
      expect(
        (
          await operationRow(
            world.applicationId,
            `mediaop:observation-apply:${submitted.jobId}:cb-p6`,
          )
        )?.status,
      ).toBe("completed");
      expect(
        (await operationRow(world.applicationId, `mediaop:job-completion:${submitted.jobId}`))
          ?.status,
      ).toBe("completed");
    });

    test("P7 COMPLETION: crash AFTER the artifact-adopted checkpoint — the restart resumes the verification/completion tail; the adoption is WRITE-ONCE", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const submitted = await clean.service.submitJob(
        submitInput(world, "a jade heron"),
        "submit-p7",
        actor,
      );
      // The FIRST checkpoint in the callback process's flow is the
      // job-completion operation's `artifact-adopted` stage (the
      // submission checkpoints happened in the earlier process).
      const dying = world.boot({
        target: "store",
        method: "recordMediaOperationCheckpoint",
        when: "after",
        occurrence: 1,
      });
      const frame = completedCallbackFor(submitted.jobId, submitted.providerJobRef ?? "", "cb-p7");
      await diesDuring(() => dying.service.applyCallback(frame, actor), dying.crashed);
      // The canonical adoption happened and the CHECKPOINT (the
      // past-no-return marker) committed — the deployments adoption
      // RECORD row follows the checkpoint in the write order, so at
      // this instant it is not yet written; the job is at verifying;
      // the job-completion operation is PENDING with the checkpoint.
      expect(await artifactRowCount(world.applicationId, submitted.jobId)).toBe(0);
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("verifying");
      const completionOp = await operationRow(
        world.applicationId,
        `mediaop:job-completion:${submitted.jobId}`,
      );
      expect(completionOp?.status).toBe("pending");
      expect((completionOp?.checkpoint as Record<string, unknown> | null)?.stage).toBe(
        "artifact-adopted",
      );
      // RESTART: the callback re-application resumes the completion tail
      // from the checkpoint — the canonical adoption converges by
      // content, the deployments adoption RECORD is written ONCE
      // (write-once key convergence), the job completes, the execution
      // COMPLETES. A SECOND re-application after the restart stays at
      // ONE record row (the write-once discipline).
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyCallback(frame, actor);
      expect(outcome.status).toBe("completed");
      expect(await artifactRowCount(world.applicationId, submitted.jobId)).toBe(1);
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("completed");
      expect(
        String((await jobRow(world.applicationId, submitted.jobId))?.output_artifact_digest),
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(await executionStatusOf(world.applicationId, submitted.executionId)).toBe("COMPLETED");
      const completed = await operationRow(
        world.applicationId,
        `mediaop:job-completion:${submitted.jobId}`,
      );
      expect(completed?.status).toBe("completed");
      expect(Number(completed?.attempts)).toBe(2);
    });

    test("P8 CANCELLATION: crash AFTER the rail cancellation — the restart re-issues under the SAME key and the rail converges (ONE cancellation)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const submitted = await clean.service.submitJob(
        submitInput(world, "a scarlet lynx"),
        "submit-p8",
        actor,
      );
      const dying = world.boot({ target: "rail", method: "cancelJob", when: "after" });
      await diesDuring(
        () => dying.service.cancelJob(submitted.jobId, "fixture cancel", actor),
        dying.crashed,
      );
      // The rail cancellation HAPPENED; the durable tail did not.
      expect(railCancels(world)).toHaveLength(1);
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("generating");
      const cancelOp = await operationRow(
        world.applicationId,
        `mediaop:job-cancellation:${submitted.jobId}`,
      );
      expect(cancelOp?.status).toBe("pending");
      // RESTART: the cancellation re-issues under the same stable key —
      // the rail replays the original outcome; the job reaches
      // cancelled; the execution is CANCELLED.
      const restarted = world.boot(null);
      const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancel", actor);
      expect(outcome.status).toBe("cancelled");
      expect(railCancels(world)).toHaveLength(1);
      const cancelReplays = world.rail.replays.filter((r) => r.kind === "cancel");
      expect(cancelReplays).toHaveLength(1);
      expect(cancelReplays[0]?.idempotencyKey).toBe(`mediarail:cancel:${submitted.jobId}`);
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("cancelled");
      expect(await executionStatusOf(world.applicationId, submitted.executionId)).toBe("CANCELLED");
      expect(
        (await operationRow(world.applicationId, `mediaop:job-cancellation:${submitted.jobId}`))
          ?.status,
      ).toBe("completed");
      // The settled paid dispatch is not refunded by the cancellation.
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
    });

    test("P9 CANCELLATION: crash AFTER the guarded cancelled move — the restart replay reconciles the PENDING operation row and re-drives the executions tail", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const submitted = await clean.service.submitJob(
        submitInput(world, "an obsidian crow"),
        "submit-p9",
        actor,
      );
      // The FIRST guarded mutation in the cancellation flow is the
      // terminal cancelled move.
      const dying = world.boot({
        target: "store",
        method: "applyGuardedJobMutation",
        when: "after",
        occurrence: 1,
      });
      await diesDuring(
        () => dying.service.cancelJob(submitted.jobId, "fixture cancel", actor),
        dying.crashed,
      );
      // The job row is cancelled (the durable proof); the cancellation
      // operation is PENDING (the crash landed between the guarded move
      // and the operation completion); the execution tail did not run.
      expect((await jobRow(world.applicationId, submitted.jobId))?.status).toBe("cancelled");
      const cancelOp = await operationRow(
        world.applicationId,
        `mediaop:job-cancellation:${submitted.jobId}`,
      );
      expect(cancelOp?.status).toBe("pending");
      expect(railCancels(world)).toHaveLength(1);
      expect(await executionStatusOf(world.applicationId, submitted.executionId)).toBe("RUNNING");
      // RESTART: the cancellation replay converges — the operation row
      // is reconciled COMPLETED and the keyed executions tail is
      // re-driven (the execution reaches CANCELLED).
      const restarted = world.boot(null);
      const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancel", actor);
      expect(outcome.status).toBe("cancelled");
      expect(outcome.replayed).toBe(true);
      expect(railCancels(world)).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      expect(
        (await operationRow(world.applicationId, `mediaop:job-cancellation:${submitted.jobId}`))
          ?.status,
      ).toBe("completed");
      expect(await executionStatusOf(world.applicationId, submitted.executionId)).toBe("CANCELLED");
    });

    test("P10 BUDGET RELEASE: the pre-settlement crash window — cancelling a dispatched-but-unsettled job PHYSICALLY RELEASES the held reservation", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      // Crash AFTER the rail accepted the paid dispatch but BEFORE the
      // dispatched checkpoint / generating move: the reservation is
      // HELD (reserve committed, settle did not) and the job row is at
      // dispatching WITHOUT a rail reference.
      const dying = world.boot({ target: "rail", method: "submitJob", when: "after" });
      await diesDuring(
        () => dying.service.submitJob(submitInput(world, "a pallid moth"), "submit-p10", actor),
        dying.crashed,
      );
      expect(railDispatches(world)).toHaveLength(1);
      const pendingJob = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id, status, provider_job_ref, reservation_id FROM deployments.media_jobs WHERE application_id = $1 AND submission_key = $2`,
        parameters: [world.applicationId, "submit-p10"],
      });
      const jobId = pendingJob.rows[0]?.id as string;
      expect(pendingJob.rows[0]?.status).toBe("dispatching");
      expect(pendingJob.rows[0]?.provider_job_ref).toBeNull();
      expect(pendingJob.rows[0]?.reservation_id).not.toBeNull();
      // The wallet is down by the image cost (the HELD reservation).
      expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - IMAGE_COST));
      // RESTART + CANCEL: the cancellation converges the job (the rail
      // job is at its acceptance plateau — cancellable) and the HELD
      // reservation is RELEASED — the wallet is PHYSICALLY refunded.
      const restarted = world.boot(null);
      const cancelled = await restarted.service.cancelJob(jobId, "fixture cancel", actor);
      expect(cancelled.status).toBe("cancelled");
      expect(railCancels(world)).toHaveLength(1);
      expect(await walletBalance(world.applicationId)).toBe(GRANT);
      expect(await executionStatusOf(world.applicationId, cancelled.executionId)).toBe("CANCELLED");
      // The replay cancellation reconciles the pending paid-dispatch
      // operation row: the job left dispatching without a rail
      // reference — the row is FAILED with the recorded cause.
      const replay = await restarted.service.cancelJob(jobId, "fixture cancel", actor);
      expect(replay.replayed).toBe(true);
      const dispatchOp = await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`);
      expect(dispatchOp?.status).toBe("failed");
      expect(String(dispatchOp?.failure_reason ?? "")).toMatch(
        /left dispatching without a rail reference/,
      );
      expect(
        (await operationRow(world.applicationId, `mediaop:job-cancellation:${jobId}`))?.status,
      ).toBe("completed");
      // Exactly ONE paid dispatch ever (the released reservation window
      // created NO second dispatch).
      expect(railDispatches(world)).toHaveLength(1);
    });
  });
});
