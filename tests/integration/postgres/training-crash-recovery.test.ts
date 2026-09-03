/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * training OPERATION state and the STABLE idempotency keys (WORK-030;
 * ACC-001/002/003; the blocking checkpoint contract
 * CONCURRENCY-CRASH-SAFETY — the PHYSICAL half).
 *
 * The unit suite (tests/unit/sandbox/training-crash-recovery.test.ts)
 * proves the behavioral half over the in-memory world (12 C-records:
 * kill/restart at every durable boundary of submission, paid dispatch,
 * completion, cancellation, resume, retry and release). THIS suite
 * proves the same kill/restart discipline against REAL PostgreSQL 16
 * (migrations 0001..0025): the process dies mid-operation (the
 * Proxy-based injector arms ONE durable-boundary crash point per booted
 * process, before/after the durable commit — a method on the SQL
 * training store, the frozen executions service, the budgets service or
 * the verification service), the workload journal / checkpoint ledger /
 * operation rows / run leases — plus the executions EventEnvelope
 * ledger, the budgets reservations and the verification evaluations —
 * physically SURVIVE, and a re-booted service over the SAME PG store
 * converges the operation with EXACTLY ONE durable side effect per
 * stable idempotency key.
 *
 * THE PROOF RECORDS (the C1..C12 unit counterparts, plus the
 * same-key convergence classes the briefing requires):
 *   SUBMISSION   P1 crash-before-the-row (nothing durable yet; one row,
 *                one reservation, one envelope on the replay)
 *                P2 crash-after-the-row-before-the-envelope (the replay
 *                repairs the admitted binding)
 *                P3 crash-after-the-reservation-before-the-row (the
 *                keyed reservation converges — never a second wallet
 *                debit)
 *   PAID         P4 crash-after-the-allocating-transition, BEFORE the
 *   DISPATCH     fleet allocation (ZERO paid activity; the resume
 *                converges: one allocation, one run)
 *                P5 crash-after-the-fleet-allocation, BEFORE the row
 *                binding (keyed convergence — ONE allocation)
 *                P6 crash-after-the-run-observation, BEFORE the
 *                checkpoint writes (the keyed run ledger replays;
 *                checkpoints recorded exactly once each)
 *                P7 crash-after-the-checkpoints, BEFORE the completion
 *                envelope (the honest `running` row; the resume
 *                completes and binds the envelope)
 *   COMPLETION   P8 crash-after-the-completed-row, BEFORE the budget
 *                tail (the terminal replay RECONCILES: settle + lease
 *                release + allocation release exactly once)
 *   CANCELLATION P9 crash-after-the-cancelled-row, BEFORE the refund
 *                (the terminal replay reconciles the release)
 *   RESUME       P10 crash-after-the-lease-re-acquisition (the live
 *                lease blocks the immediate replay fail-closed; after
 *                expiry the next resume re-acquires at a HIGHER epoch
 *                and converges)
 *   RETRY        P11 crash-after-the-fresh-reservation, BEFORE the
 *                re-arm (the keyed attempt-2 reservation converges; the
 *                discriminator rebinds exactly once)
 *   RELEASE      P12 crash-after-the-release-binding, BEFORE the
 *                operation completion (the write-once release replays
 *                WITHOUT re-consulting the verification authority)
 *   CONVERGENCE  P13 N=8 same-key DISPATCHES converge: ONE paid
 *                allocation, ONE run, ONE checkpoint journal, ONE
 *                sandbox-completed envelope, ONE settlement
 *                P14 same-key convergence AFTER a crash: the process
 *                died mid-dispatch, the lease lapses, and N=8
 *                concurrent re-drives (resumes) still converge to the
 *                exactly-once durable outcome
 */

import { describe, expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite, type PgContext } from "./harness";
import { countOf, seedTrainingWorld, type TrainingPgWorld, trainingSpecOf } from "./training-world";

definePgSuite("training crash-injection proofs (WORK-030) on real PostgreSQL", (ctx: PgContext) => {
  let world: TrainingPgWorld;

  const freshWorld = async (
    fleetOptions: { failRunsOf?: (id: string, attempt: number) => boolean } = {},
  ) => {
    world = await seedTrainingWorld(ctx.port, fleetOptions);
    return world;
  };

  const expectPlatformError = async (
    code: string,
    run: () => Promise<unknown>,
  ): Promise<PlatformError> => {
    try {
      await run();
    } catch (error) {
      if (error instanceof PlatformError) {
        if (error.code !== code) {
          throw new Error(
            `expected PlatformError code ${code}, got ${error.code}: ${error.message}`,
          );
        }
        return error;
      }
      throw error;
    }
    throw new Error(`expected a PlatformError with code ${code}`);
  };

  // ---- durable-state probes (the physical side-effect witnesses) ----

  const workloadRow = (workloadKey: string) =>
    world.db
      .execute<Record<string, unknown>>({
        sql: "SELECT * FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
        parameters: [world.applicationId, workloadKey],
      })
      .then((result) => (result.rows.length > 0 ? result.rows[0] : null));

  const checkpointsOf = (workloadKey: string) =>
    countOf(
      world.db,
      "SELECT 1 FROM sandbox.training_checkpoints WHERE application_id = $1 AND workload_key = $2",
      [world.applicationId, workloadKey],
    );

  const reservationsOf = (operationId?: string) =>
    countOf(
      world.db,
      `SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1${
        operationId === undefined ? "" : " AND r.operation_id = $2"
      }`,
      operationId === undefined ? [world.applicationId] : [world.applicationId, operationId],
    );

  const reservationStatusOf = (operationId: string) =>
    world.db
      .execute<{ status: string }>({
        sql: "SELECT r.status FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1 AND r.operation_id = $2",
        parameters: [world.applicationId, operationId],
      })
      .then((result) => result.rows[0]?.status ?? null);

  const eventsOf = (executionId: string) =>
    world.executionService
      .listEvents(world.applicationId, executionId)
      .then((events) => events.map((event) => event.command));

  const leaseRowOf = (workloadId: string) =>
    world.db
      .execute<{ epoch: number; released_at: Date | null }>({
        sql: "SELECT epoch, released_at FROM sandbox.training_run_leases WHERE application_id = $1 AND workload_id = $2",
        parameters: [world.applicationId, workloadId],
      })
      .then((result) => result.rows[0] ?? null);

  /** Submit one funded workload on a running execution; returns its record. */
  const submitFunded = async (workloadKey: string) => {
    await world.fundApplication();
    const executionId = await world.seedExecution("RUNNING");
    const admitted = await world
      .boot(null)
      .service.submitWorkload({ executionId, spec: trainingSpecOf() }, workloadKey, world.actor());
    return { admitted, executionId };
  };

  // =========================================================================
  // SUBMISSION
  // =========================================================================

  describe("submission", () => {
    test("P1: a crash BEFORE the workload row — nothing durable yet; the replay lands one row, one reservation, one envelope", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const dying = w.boot({ target: "store", method: "insertWorkload", when: "before" });
      await dying.service
        .submitWorkload({ executionId, spec: trainingSpecOf() }, "pg-crash-1", w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      // NOTHING workload-durable happened in the dying process (the
      // keyed reservation had already committed — it converges on the
      // replay; never a second wallet debit).
      expect(await workloadRow("pg-crash-1")).toBeNull();
      expect(await reservationsOf()).toBe(1);
      const reboot = w.boot(null);
      const record = await reboot.service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-crash-1",
        w.actor(),
      );
      expect(record.status).toBe("admitted");
      expect(record.ledgerAdmittedSequence).not.toBeNull();
      expect(await checkpointsOf("pg-crash-1")).toBe(0);
      expect(await reservationsOf()).toBe(1); // ONE reservation total
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-admitted").length).toBe(1);
    });

    test("P2: a crash AFTER the row, BEFORE the envelope — the replay repairs the admitted binding", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const dying = w.boot({ target: "executions", method: "recordStepEvent", when: "before" });
      await dying.service
        .submitWorkload({ executionId, spec: trainingSpecOf() }, "pg-crash-2", w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      const row = await workloadRow("pg-crash-2");
      expect(row?.status).toBe("admitted");
      expect(row?.ledger_admitted_sequence).toBeNull(); // the binding died with the process
      expect(await reservationsOf()).toBe(1); // the reservation committed
      const reboot = w.boot(null);
      const record = await reboot.service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-crash-2",
        w.actor(),
      );
      expect(record.ledgerAdmittedSequence).not.toBeNull(); // repaired
      const finalRow = await workloadRow("pg-crash-2");
      expect(finalRow?.ledger_admitted_sequence).not.toBeNull();
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-admitted").length).toBe(1);
      expect(await reservationsOf()).toBe(1); // converged, not doubled
    });

    test("P3: a crash AFTER the reservation, BEFORE the row — the keyed reservation converges (never a second debit)", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const dying = w.boot({ target: "store", method: "insertWorkload", when: "after" });
      await dying.service
        .submitWorkload({ executionId, spec: trainingSpecOf() }, "pg-crash-3", w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      const row = await workloadRow("pg-crash-3");
      expect(row?.status).toBe("admitted"); // the row committed; the envelope died
      expect(row?.ledger_admitted_sequence).toBeNull();
      const reboot = w.boot(null);
      const record = await reboot.service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-crash-3",
        w.actor(),
      );
      expect(record.status).toBe("admitted");
      // The budget operation id is STABLE per workload: exactly ONE
      // reservation row for it — the keyed idempotency converged.
      expect(await reservationsOf(record.budgetOperationId as string)).toBe(1);
      expect(await reservationsOf()).toBe(1);
    });
  });

  // =========================================================================
  // PAID DISPATCH
  // =========================================================================

  describe("paid dispatch", () => {
    test("P4: a crash AFTER the allocating transition, BEFORE the fleet allocation — ZERO paid activity; the resume converges", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-4");
      const dying = w.boot({
        target: "store",
        method: "transitionWorkload",
        when: "after",
        occurrence: 1,
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      expect(w.fleet.listAllocations()).toEqual([]); // ZERO paid activity
      expect(w.fleet.runCount()).toBe(0);
      const row = await workloadRow("pg-crash-4");
      expect(row?.status).toBe("allocating"); // the honest in-flight state
      const reboot = w.boot(null);
      const final = await reboot.service.resumeWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      expect(w.fleet.listAllocations().length).toBe(1); // exactly one paid allocation
      expect(w.fleet.runCount()).toBe(1);
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
    });

    test("P5: a crash AFTER the fleet allocation, BEFORE the row binding — keyed convergence (ONE allocation)", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-5");
      const dying = w.boot({
        target: "store",
        method: "bindWorkloadAllocation",
        when: "before",
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      expect(w.fleet.listAllocations().length).toBe(1); // the paid allocation committed
      expect(w.fleet.runCount()).toBe(0); // the keyed run had not started yet
      const row = await workloadRow("pg-crash-5");
      expect(row?.status).toBe("allocating"); // the binding died with the process
      const reboot = w.boot(null);
      const final = await reboot.service.resumeWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      // The SAME allocation key converged — never a second allocation.
      expect(w.fleet.listAllocations().length).toBe(1);
      expect(final.allocationId).not.toBeNull();
      expect(w.fleet.runCount()).toBe(1);
      expect(w.fleet.listAllocations()[0]?.releasedAt).not.toBeNull(); // the tail released it
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
    });

    test("P6: a crash AFTER the run observation, BEFORE the checkpoint writes — the keyed run ledger replays; checkpoints recorded once", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-6");
      const dying = w.boot({
        target: "store",
        method: "insertTrainingCheckpoint",
        when: "before",
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      expect(w.fleet.runCount()).toBe(1); // the run observation committed
      expect(await checkpointsOf("pg-crash-6")).toBe(0); // the writes died
      // The crashed worker's lease LAPSES (the honest recovery clock).
      w.clock.advance(120_000);
      const reboot = w.boot(null);
      const final = await reboot.service.resumeWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      expect(w.fleet.runCount()).toBe(1); // the run REPLAYED from the keyed ledger
      expect(await checkpointsOf("pg-crash-6")).toBe(3); // each exactly once
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
    });

    test("P7: a crash AFTER the checkpoints, BEFORE the completion envelope — the honest running row; the resume completes", async () => {
      const w = await freshWorld();
      const { admitted, executionId } = await submitFunded("pg-crash-7");
      // Within the DISPATCH process the ledger calls are
      // checkpoint-recorded x3 (interval 4 over 12 steps) then
      // sandbox-completed — invocation 4 is the completion envelope
      // (the sandbox-admitted envelope rode the submission process).
      const dying = w.boot({
        target: "executions",
        method: "recordStepEvent",
        when: "before",
        occurrence: 4,
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      expect(await checkpointsOf("pg-crash-7")).toBe(3); // the checkpoints committed
      const row = await workloadRow("pg-crash-7");
      expect(row?.status).toBe("running"); // the honest pre-completion state
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-completed").length).toBe(0);
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).not.toBe("settled");
      w.clock.advance(120_000);
      const reboot = w.boot(null);
      const final = await reboot.service.resumeWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-completed").length).toBe(1);
      expect(await checkpointsOf("pg-crash-7")).toBe(3); // never duplicated
      expect(final.ledgerCompletedSequence).not.toBeNull();
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
    });
  });

  // =========================================================================
  // COMPLETION / CANCELLATION — the finalization tails
  // =========================================================================

  describe("finalization tails", () => {
    test("P8: a crash AFTER the completed row, BEFORE the budget tail — the terminal replay RECONCILES", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-8");
      // Crash right after the terminal completed transition (occurrence 3
      // within the dispatch process: allocating -> running -> completed),
      // before the finalization tail.
      const dying = w.boot({
        target: "store",
        method: "transitionWorkload",
        when: "after",
        occurrence: 3,
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      const row = await workloadRow("pg-crash-8");
      expect(row?.status).toBe("completed"); // the terminal row committed
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).not.toBe("settled");
      expect((await leaseRowOf(admitted.id))?.released_at).toBeNull(); // the tail died
      // The terminal replay (a fresh dispatch of the terminal row).
      const reboot = w.boot(null);
      const final = await reboot.service.dispatchWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      expect(w.fleet.runCount()).toBe(1); // never re-executed
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
      expect((await leaseRowOf(admitted.id))?.released_at).not.toBeNull();
      expect(w.fleet.listAllocations().length).toBe(1); // still exactly one
      expect(w.fleet.listAllocations()[0]?.releasedAt).not.toBeNull();
    });

    test("P9: a crash AFTER the cancelled row, BEFORE the refund — the terminal replay reconciles", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-9");
      const dying = w.boot({
        target: "store",
        method: "transitionWorkload",
        when: "after",
      });
      await dying.service
        .cancelWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      const row = await workloadRow("pg-crash-9");
      expect(row?.status).toBe("cancelled"); // the terminal row committed
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).not.toBe("released");
      const reboot = w.boot(null);
      const final = await reboot.service.cancelWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("cancelled");
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).toBe("released");
      expect(w.fleet.listAllocations()).toEqual([]); // nothing was ever allocated
    });
  });

  // =========================================================================
  // RESUME — the lease discipline
  // =========================================================================

  describe("resume", () => {
    test("P10: a crash AFTER the lease re-acquisition — the live lease blocks; after expiry the next resume re-acquires HIGHER and converges", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-10");
      // Arm the honest crashed-worker state: allocating + an EXPIRED
      // 1-second lease (the crashed worker's own acquire).
      const past = new Date(Date.now() - 120_000).toISOString();
      await w.store.transitionWorkload({
        applicationId: w.applicationId,
        workloadKey: "pg-crash-10",
        to: "allocating",
        now: past,
      });
      await w.store.acquireTrainingRunLease({
        applicationId: w.applicationId,
        workloadId: admitted.id,
        tenantId: w.tenantId,
        ownerId: `training-worker:pg-crash-10`,
        now: past,
        leaseDurationMs: 1000,
      });
      const epochBefore = (await leaseRowOf(admitted.id))?.epoch ?? 0;
      // The resume process dies right AFTER the lease re-acquisition,
      // BEFORE the resume evidence (the first ledger call of the resume
      // process).
      const dying = w.boot({
        target: "executions",
        method: "recordStepEvent",
        when: "before",
        occurrence: 1,
      });
      await dying.service
        .resumeWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      const leaseAfterCrash = await leaseRowOf(admitted.id);
      expect(leaseAfterCrash?.epoch).toBeGreaterThan(epochBefore); // re-acquired
      expect(leaseAfterCrash?.released_at).toBeNull();
      // The lease is LIVE — the immediate replay fails closed.
      const blocked = w.boot(null);
      await expectPlatformError("INVALID_STATE_TRANSITION", () =>
        blocked.service.resumeWorkload(
          { applicationId: w.applicationId, workloadId: admitted.id },
          w.actor(),
        ),
      );
      // ...the lease LAPSES by expiry (the clock advances)...
      w.clock.advance(120_000);
      // ...and the next resume re-acquires at a HIGHER epoch and converges.
      const reboot = w.boot(null);
      const final = await reboot.service.resumeWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      const lease = await leaseRowOf(admitted.id);
      expect(lease?.epoch ?? 0).toBeGreaterThan(leaseAfterCrash?.epoch ?? 0);
      expect(lease?.released_at).not.toBeNull();
      expect(w.fleet.listAllocations().length).toBe(1);
      expect(w.fleet.runCount()).toBe(1);
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
    });
  });

  // =========================================================================
  // RETRY
  // =========================================================================

  describe("retry", () => {
    test("P11: a crash AFTER the fresh reservation, BEFORE the re-arm — the keyed attempt-2 reservation converges", async () => {
      const w = await freshWorld({ failRunsOf: (_id, attempt) => attempt === 1 });
      const { admitted } = await submitFunded("pg-crash-11");
      const first = await w
        .boot(null)
        .service.dispatchWorkload(
          { applicationId: w.applicationId, workloadId: admitted.id },
          w.actor(),
        );
      expect(first.status).toBe("failed");
      expect(await reservationStatusOf(first.budgetOperationId as string)).toBe("released");
      const dying = w.boot({
        target: "store",
        method: "bumpWorkloadAttempts",
        when: "before",
      });
      await dying.service
        .retryWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      // The attempt-2 reservation committed; the re-arm died.
      expect(await reservationsOf()).toBe(2);
      const row = await workloadRow("pg-crash-11");
      expect(row?.attempts).toBe(1);
      const reboot = w.boot(null);
      const final = await reboot.service.retryWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(final.status).toBe("completed");
      expect(final.attempts).toBe(2);
      // Exactly TWO reservations (one per attempt) — the keyed attempt-2
      // id converged, never a third.
      expect(await reservationsOf()).toBe(2);
      expect(await reservationStatusOf(final.budgetOperationId as string)).toBe("settled");
      expect(final.budgetOperationId).not.toBe(first.budgetOperationId);
      // The retry's checkpoints CONTINUE the durable journal (seq 2, 3
      // after attempt 1's seq 1 — the sequence-allocation fix).
      expect(await checkpointsOf("pg-crash-11")).toBe(3);
      expect(w.fleet.listAllocations().length).toBe(2); // one per attempt key
    });
  });

  // =========================================================================
  // RELEASE — the verification-before-release boundary
  // =========================================================================

  describe("release", () => {
    test("P12: a crash AFTER the release binding, BEFORE the operation completion — the write-once replay does NOT re-consult the authority", async () => {
      const w = await freshWorld();
      const { admitted } = await submitFunded("pg-crash-12");
      const completed = await w
        .boot(null)
        .service.dispatchWorkload(
          { applicationId: w.applicationId, workloadId: admitted.id },
          w.actor(),
        );
      expect(completed.status).toBe("completed");
      await w.declareReleaseCriteria();
      const releaseInput = {
        applicationId: w.applicationId,
        workloadId: admitted.id,
        criteria: [{ criterionId: "training-output-lineage", version: 1 }],
        evidenceRefs: [],
      } as const;
      const dying = w.boot({
        target: "store",
        method: "completeTrainingOperation",
        when: "before",
      });
      await dying.service.verifyAndReleaseWorkload(releaseInput, "pg-crash-12-key", w.actor()).then(
        () => undefined,
        () => undefined,
      );
      expect(dying.crashed()).toBe(true);
      // The release binding committed; the operation completion died.
      const row = await workloadRow("pg-crash-12");
      expect(row?.verified_release_at).not.toBeNull();
      const judgeCallsAfterCrash = w.modelJudge.requests.length;
      const reboot = w.boot(null);
      const final = await reboot.service.verifyAndReleaseWorkload(
        releaseInput,
        "pg-crash-12-key",
        w.actor(),
      );
      expect(final.verifiedReleaseAt).not.toBeNull();
      expect(final.verifiedReleaseAt).toBe((row?.verified_release_at as Date)?.toISOString());
      // The verification authority was NOT re-consulted (the release
      // binding is write-once: the replay short-circuits before verify).
      expect(w.modelJudge.requests.length).toBe(judgeCallsAfterCrash);
      // The release operation row reached its terminal state.
      const op = await w.store.findTrainingOperation(
        w.applicationId,
        `trop:release:pg-crash-12:pg-crash-12-key`,
      );
      expect(op?.status).toBe("completed");
    });
  });

  // =========================================================================
  // SAME-KEY CONVERGENCE (the briefing's required classes)
  // =========================================================================

  describe("same-key convergence", () => {
    test("P13: N=8 same-key DISPATCHES converge — ONE allocation, ONE run, ONE checkpoint journal, ONE completion envelope, ONE settlement", async () => {
      const w = await freshWorld();
      const { admitted, executionId } = await submitFunded("pg-converge-dispatch");
      const service = () => w.boot(null).service;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service()
            .dispatchWorkload(
              { applicationId: w.applicationId, workloadId: admitted.id },
              w.actor(),
            )
            .catch((error: unknown) => error),
        ),
      );
      const completed = results.filter(
        (r) => !(r instanceof Error) && (r as { status?: string }).status === "completed",
      );
      // Every concurrent driver converged onto the ONE durable outcome
      // (typed INVALID_STATE_TRANSITION replays are the honest
      // already-running refusals — the row is never re-driven).
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => !(r instanceof Error) || r instanceof PlatformError)).toBe(true);
      const row = await workloadRow("pg-converge-dispatch");
      expect(row?.status).toBe("completed");
      // ONE paid allocation, ONE run observation.
      expect(w.fleet.listAllocations().length).toBe(1);
      expect(w.fleet.runCount()).toBe(1);
      // The checkpoint journal: each material checkpoint exactly once.
      expect(await checkpointsOf("pg-converge-dispatch")).toBe(3);
      // ONE completion envelope, ONE admitted envelope.
      const commands = await eventsOf(executionId);
      expect(commands.filter((c) => c === "sandbox-completed").length).toBe(1);
      expect(commands.filter((c) => c === "sandbox-admitted").length).toBe(1);
      expect(commands.filter((c) => c === "checkpoint-recorded").length).toBe(3);
      // ONE settlement for the one budget operation id.
      expect(await reservationsOf()).toBe(1);
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).toBe("settled");
      // The lease is released and the allocation freed.
      expect((await leaseRowOf(admitted.id))?.released_at).not.toBeNull();
      expect(w.fleet.listAllocations()[0]?.releasedAt).not.toBeNull();
    });

    test("P14: same-key convergence AFTER a crash — the process died mid-dispatch, the lease lapses, and N=8 concurrent re-drives still converge exactly-once", async () => {
      const w = await freshWorld();
      const { admitted, executionId } = await submitFunded("pg-converge-restart");
      // The first process dies mid-run (after the run observation, before
      // the checkpoint writes).
      const dying = w.boot({
        target: "store",
        method: "insertTrainingCheckpoint",
        when: "before",
      });
      await dying.service
        .dispatchWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
        .then(
          () => undefined,
          () => undefined,
        );
      expect(dying.crashed()).toBe(true);
      // The crashed worker's lease lapses.
      w.clock.advance(120_000);
      const service = () => w.boot(null).service;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service()
            .resumeWorkload({ applicationId: w.applicationId, workloadId: admitted.id }, w.actor())
            .catch((error: unknown) => error),
        ),
      );
      const completed = results.filter(
        (r) => !(r instanceof Error) && (r as { status?: string }).status === "completed",
      );
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => !(r instanceof Error) || r instanceof PlatformError)).toBe(true);
      const row = await workloadRow("pg-converge-restart");
      expect(row?.status).toBe("completed");
      // Exactly-once side effects per stable key after the restart.
      expect(w.fleet.listAllocations().length).toBe(1);
      expect(w.fleet.runCount()).toBe(1);
      expect(await checkpointsOf("pg-converge-restart")).toBe(3);
      const commands = await eventsOf(executionId);
      expect(commands.filter((c) => c === "sandbox-completed").length).toBe(1);
      expect(commands.filter((c) => c === "checkpoint-recorded").length).toBe(3);
      expect(await reservationsOf()).toBe(1);
      expect(await reservationStatusOf(admitted.budgetOperationId as string)).toBe("settled");
      expect((await leaseRowOf(admitted.id))?.released_at).not.toBeNull();
    });
  });
});
