/**
 * Real-PostgreSQL proofs: the training/accelerator workload fabric's
 * durable discipline (WORK-030; ACC-001/002/003) over migration 0025.
 *
 * Every proof runs against the REAL SQL training store + the REAL
 * frozen executions module + the REAL policies/capabilities/budgets/
 * artifacts/verification authorities on a disposable PostgreSQL 16
 * database (the harness applies the shipped migrations, 0025
 * included). The kill/restart crash-injection halves live in
 * training-crash-recovery.test.ts; the mutation (discrimination)
 * halves live in tests/discrimination/training.discrimination.test.ts.
 *
 * PROOF MAP:
 *   TR1  the governed happy path over the REAL authorities (admission
 *        chain → allocation → run → checkpoints → completion → settle;
 *        the output is a REAL content-addressed artifact)
 *   TR2  budget-before-allocation over the REAL budgets authority
 *        (an unfunded application fails closed with a durable denied
 *        row and ZERO paid allocation activity)
 *   TR3  workload physical guards (insert vocabulary, terminal
 *        execution binding, key uniqueness, runtime-metadata
 *        immutability, terminal immutability, write-once bindings,
 *        monotonic attempts, no delete)
 *   TR4  checkpoint ledger physical guards (append-only, gapless
 *        sequence, identity uniqueness, convergence, no delete)
 *   TR5  operation-table physical discipline (unique key, fingerprint
 *        arbitration, terminal immutability, no delete)
 *   TR6  run-lease physical guards (epoch monotonic, owner within
 *        epoch, one-way release, no delete)
 *   TR7  verification-before-release over the REAL verification
 *        authority (PASS releases once; undeclared criteria fail
 *        closed; a FAILED workload never releases; write-once)
 *   TR8  retry: fresh reservation per attempt, discriminator rebind,
 *        per-attempt ledger envelopes
 *   TR9  N=8 same-key submission convergence (ONE workload row, ONE
 *        reservation, ONE admitted envelope)
 */

import { describe, expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite, type PgContext } from "./harness";
import {
  countOf,
  type TrainingPgWorld,
  trainingSpecOf,
  seedTrainingWorld,
} from "./training-world";

definePgSuite("training durable discipline (real PostgreSQL; WORK-030)", (ctx: PgContext) => {
  let world: TrainingPgWorld;

  const freshWorld = async (
    fleetOptions: { failRunsOf?: (id: string, attempt: number) => boolean } = {},
  ) => {
    world = await seedTrainingWorld(ctx.port, fleetOptions);
    return world;
  };

  const expectPlatformError = async (
    code: string,
    run: Promise<unknown> | (() => Promise<unknown>),
  ): Promise<PlatformError> => {
    const promise = typeof run === "function" ? run() : run;
    try {
      await promise;
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

  const operationsOfKind = (kind: string) =>
    countOf(
      world.db,
      "SELECT 1 FROM sandbox.training_operations WHERE application_id = $1 AND operation_kind = $2",
      [world.applicationId, kind],
    );

  const reservationsOf = () =>
    countOf(
      world.db,
      "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
      [world.applicationId],
    );

  const settledOf = (operationId: string) =>
    countOf(
      world.db,
      "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1 AND r.operation_id = $2 AND r.status = 'settled'",
      [world.applicationId, operationId],
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

  // The governed happy path: funded application + running execution.
  const submitAndDispatch = async (key = "pg-training-1", fund = true) => {
    if (fund) {
      await world.fundApplication();
    }
    const executionId = await world.seedExecution("RUNNING");
    const admitted = await world.boot(null).service.submitWorkload(
      { executionId, spec: trainingSpecOf() },
      key,
      world.actor(),
    );
    const final = await world.boot(null).service.dispatchWorkload(
      { applicationId: world.applicationId, workloadId: admitted.id },
      world.actor(),
    );
    return { executionId, admitted, final };
  };

  // =========================================================================
  // TR1 — the governed happy path over the REAL authorities
  // =========================================================================

  describe("training governed lifecycle (TR1)", () => {
    test("submit → dispatch → complete: one allocation, one run, checkpoints, settle — the output is a REAL artifact", async () => {
      const w = await freshWorld();
      const { executionId, final } = await submitAndDispatch();
      expect(final.status).toBe("completed");
      expect(final.outputArtifactDigest).not.toBeNull();
      expect(final.usageMicroUsd).not.toBeNull();
      expect(w.fleet.listAllocations().length).toBe(1);
      expect(w.fleet.runCount()).toBe(1);
      expect(await checkpointsOf("pg-training-1")).toBe(3);
      // The output adopted is a REAL artifact in the artifacts authority
      // (content-addressed, tenant-scoped).
      const artifact = await w.artifacts.getArtifact(
        { tenantId: w.tenantId },
        final.outputArtifactDigest as unknown as Parameters<
          typeof w.artifacts.getArtifact
        >[1],
      );
      expect(artifact.digest).toBe(final.outputArtifactDigest);
      // The budget reservation was settled exactly once (REAL budgets).
      expect(await settledOf(final.budgetOperationId as string)).toBe(1);
      // The canonical ledger carries the full training vocabulary with
      // per-checkpoint and per-attempt envelopes.
      const commands = await eventsOf(executionId);
      expect(commands.filter((c) => c === "sandbox-admitted").length).toBe(1);
      expect(commands.filter((c) => c === "checkpoint-recorded").length).toBe(3);
      expect(commands.filter((c) => c === "sandbox-completed").length).toBe(1);
      // The completed binding points at the completion event.
      const row = await workloadRow("pg-training-1");
      expect(row?.ledger_completed_sequence).not.toBeNull();
      expect(row?.ledger_admitted_sequence).not.toBeNull();
      // The run lease was released by the finalization tail.
      expect(
        await countOf(
          w.db,
          "SELECT 1 FROM sandbox.training_run_leases WHERE application_id = $1 AND released_at IS NOT NULL",
          [w.applicationId],
        ),
      ).toBe(1);
    });

    test("cancellation releases the allocation and refunds the unspent reservation", async () => {
      const w = await freshWorld();
      await world.fundApplication();
      const executionId = await world.seedExecution("RUNNING");
      const admitted = await world.boot(null).service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-cancel-1",
        world.actor(),
      );
      const cancelled = await world.boot(null).service.cancelWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(cancelled.status).toBe("cancelled");
      expect(w.fleet.listAllocations().length).toBe(0); // ZERO paid activity
      expect(w.fleet.runCount()).toBe(0);
      expect(await reservationStatusOf(cancelled.budgetOperationId as string)).toBe("released");
      expect(await reservationsOf()).toBe(1); // the single (released) reservation
      // interruption-requested rides the canonical ledger.
      expect((await eventsOf(executionId)).filter((c) => c === "interruption-requested").length).toBe(1);
    });
  });

  // =========================================================================
  // TR2 — budget-before-allocation over the REAL budgets authority
  // =========================================================================

  describe("budget admission BEFORE paid allocation (TR2)", () => {
    test("an unfunded application fails closed (the funding-policy denial) with a durable denied row and ZERO allocation activity", async () => {
      const w = await freshWorld();
      const executionId = await w.seedExecution("RUNNING");
      // The REAL budgets authority denies the unconfigured application
      // (the funding-policy denial) — journaled fail-closed as a
      // budget-class denial (the re-review defect: previously propagated
      // raw, leaving NO durable denied row).
      await expectPlatformError("POLICY_DENIED", () =>
        w.boot(null).service.submitWorkload(
          { executionId, spec: trainingSpecOf() },
          "pg-denied-unfunded",
          w.actor(),
        ),
      );
      const row = await workloadRow("pg-denied-unfunded");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("budget");
      expect(row?.denial_code).toBe("POLICY_DENIED");
      expect(row?.allocation_id).toBeNull();
      // ZERO paid activity and ZERO live reservations.
      expect(w.fleet.listAllocations().length).toBe(0);
      expect(w.fleet.runCount()).toBe(0);
      expect(await reservationsOf()).toBe(0);
      // sandbox-denied rides the canonical ledger.
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-denied").length).toBe(1);
    });

    test("an exhausted budget fails closed (BUDGET_EXCEEDED) with a durable denied row and ZERO allocation activity", async () => {
      const w = await freshWorld();
      await w.fundApplication("100"); // far below the 250000 estimate
      const executionId = await w.seedExecution("RUNNING");
      await expectPlatformError("BUDGET_EXCEEDED", () =>
        w.boot(null).service.submitWorkload(
          { executionId, spec: trainingSpecOf() },
          "pg-denied-overspend",
          w.actor(),
        ),
      );
      const row = await workloadRow("pg-denied-overspend");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("budget");
      expect(row?.denial_code).toBe("BUDGET_EXCEEDED");
      expect(row?.allocation_id).toBeNull();
      expect(w.fleet.listAllocations()).toEqual([]); // ZERO paid activity
      expect(w.fleet.runCount()).toBe(0);
      expect(await reservationsOf()).toBe(0);
    });

    test("the reservation precedes the allocation durably (the timestamp order witness)", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-order-1");
      expect(final.status).toBe("completed");
      // The workload row was created (the admission bundle — AFTER the
      // reserve) no later than its own allocation binding (AFTER the
      // reservation settled into the row's budget discriminator), and
      // the REAL budgets reservation for this exact operation exists
      // and was settled — the physical order witnesses of
      // budget-before-paid-allocation.
      const order = await w.db
        .execute<{ created: Date; allocated: Date }>({
          sql: "SELECT created_at AS created, allocated_at AS allocated FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-order-1"],
        })
        .then((result) => result.rows[0]);
      expect(order).toBeDefined();
      expect(order!.created.getTime()).toBeLessThanOrEqual(order!.allocated.getTime());
      expect(await settledOf(final.budgetOperationId as string)).toBe(1);
      expect(
        await countOf(
          w.db,
          "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets wal ON wal.id = r.wallet_id WHERE wal.application_id = $1 AND r.operation_id = $2",
          [w.applicationId, final.budgetOperationId],
        ),
      ).toBe(1);
    });
  });

  // =========================================================================
  // TR3 — workload physical guards
  // =========================================================================

  describe("workload physical guards (TR3)", () => {
    test("insert vocabulary: only denied|admitted rows can be inserted", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const id = "00000000-0000-7000-8000-00000000e101";
      await expect(
        w.db.execute({
          sql: `INSERT INTO sandbox.training_workloads
  (id, application_id, tenant_id, execution_id, workload_key, request_fingerprint, workload_kind,
   status, runtime_metadata, created_at)
VALUES ($1, $2, $3, $4, 'bad-status', 'fp', 'training', 'running', '{}'::jsonb, now())`,
          parameters: [id, w.applicationId, w.tenantId, executionId],
        }),
      ).rejects.toThrow(/inserted in denied\|admitted only/);
    });

    test("an admitted workload cannot bind to a terminal execution", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("CANCELLED");
      const id = "00000000-0000-7000-8000-00000000e102";
      await expect(
        w.db.execute({
          sql: `INSERT INTO sandbox.training_workloads
  (id, application_id, tenant_id, execution_id, workload_key, request_fingerprint, workload_kind,
   status, runtime_metadata, created_at)
VALUES ($1, $2, $3, $4, 'terminal-exec', 'fp', 'training', 'admitted', '{}'::jsonb, now())`,
          parameters: [id, w.applicationId, w.tenantId, executionId],
        }),
      ).rejects.toThrow(/is terminal; no training workload may be admitted/);
    });

    test("the workload key is unique per application (convergent ON CONFLICT)", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const spec = trainingSpecOf();
      const service = w.boot(null).service;
      const first = await service.submitWorkload({ executionId, spec }, "pg-unique-1", w.actor());
      const second = await service.submitWorkload({ executionId, spec }, "pg-unique-1", w.actor());
      expect(second.id).toBe(first.id);
      expect(await reservationsOf()).toBe(1);
      expect(
        await countOf(
          w.db,
          "SELECT 1 FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
          [w.applicationId, "pg-unique-1"],
        ),
      ).toBe(1);
    });

    test("runtime metadata is immutable; the identity core never moves", async () => {
      const w = await freshWorld();
      await submitAndDispatch("pg-immutable-1");
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET runtime_metadata = '{}'::jsonb WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-immutable-1"],
        }),
      ).rejects.toThrow(/identity core \(incl\. runtime_metadata\) is immutable/);
    });

    test("completed rows are terminal-immutable; write-once bindings never move", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-terminal-1");
      expect(final.status).toBe("completed");
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET status = 'failed' WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-terminal-1"],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET output_artifact_digest = repeat('a', 64) WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-terminal-1"],
        }),
      ).rejects.toThrow(/output adoption is write-once/);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET allocation_id = 'other-allocation' WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-terminal-1"],
        }),
      ).rejects.toThrow(/allocation binding is write-once/);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET ledger_completed_sequence = 999 WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-terminal-1"],
        }),
      ).rejects.toThrow(/completed ledger binding is write-once/);
      await expect(
        w.db.execute({
          sql: "DELETE FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-terminal-1"],
        }),
      ).rejects.toThrow(/rows are never deleted/);
    });

    test("the illegal status transition is rejected by the lifecycle guard", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const admitted = await w.boot(null).service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-transition-1",
        w.actor(),
      );
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET status = 'completed' WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-transition-1"],
        }),
      ).rejects.toThrow(/cannot move from status admitted to completed/);
      expect(admitted.status).toBe("admitted");
    });
  });

  // =========================================================================
  // TR4 — checkpoint ledger physical guards
  // =========================================================================

  describe("checkpoint physical guards (TR4)", () => {
    test("checkpoints are append-only, identity-unique and never deleted", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-ckpt-1");
      const row = await w.db
        .execute<Record<string, unknown>>({
          sql: "SELECT id, content_digest FROM sandbox.training_checkpoints WHERE application_id = $1 AND workload_key = $2 AND checkpoint_sequence = 1",
          parameters: [w.applicationId, "pg-ckpt-1"],
        })
        .then((r) => r.rows[0]);
      expect(row).toBeDefined();
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_checkpoints SET metrics_digest = repeat('b', 64) WHERE id = $1",
          parameters: [row?.id],
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        w.db.execute({
          sql: "DELETE FROM sandbox.training_checkpoints WHERE id = $1",
          parameters: [row?.id],
        }),
      ).rejects.toThrow(/append-only/);
      // A different digest at the SAME sequence is rejected by the
      // by-sequence identity gate (the same-content duplicate converges
      // through the unique arbiter instead).
      await expect(
        w.db.execute({
          sql: `INSERT INTO sandbox.training_checkpoints
  (id, application_id, tenant_id, execution_id, workload_id, workload_key, checkpoint_sequence,
   step_position, lineage, metrics_digest, substrate_id, resource_class, recorded_by, content_digest, created_at)
VALUES ('00000000-0000-7000-8000-00000000e201', $1, $2, $3, $4, $5, 1, 4, '{}'::jsonb, repeat('c', 64), 's', 'r', 'rec', repeat('f', 64), now())`,
          parameters: [
            w.applicationId,
            w.tenantId,
            final.executionId,
            final.id,
            "pg-ckpt-1",
          ],
        }),
      ).rejects.toThrow(/checkpoint sequence 1 already exists with a different content identity/);
    });

    test("the per-workload checkpoint sequence is gapless (physical gate)", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-ckpt-2");
      await expect(
        w.db.execute({
          sql: `INSERT INTO sandbox.training_checkpoints
  (id, application_id, tenant_id, execution_id, workload_id, workload_key, checkpoint_sequence,
   step_position, lineage, metrics_digest, substrate_id, resource_class, recorded_by, content_digest, created_at)
VALUES ('00000000-0000-7000-8000-00000000e202', $1, $2, $3, $4, $5, 9, 36, '{}'::jsonb, repeat('d', 64), 's', 'r', 'rec', repeat('e', 64), now())`,
          parameters: [
            w.applicationId,
            w.tenantId,
            final.executionId,
            final.id,
            "pg-ckpt-2",
          ],
        }),
      ).rejects.toThrow(/checkpoint sequence must be gapless/);
    });
  });

  // =========================================================================
  // TR5 — operation-table physical discipline
  // =========================================================================

  describe("operation physical discipline (TR5)", () => {
    test("operations converge on the unique key; fingerprint reuse fails closed; terminal rows immutable; no delete", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-ops-1");
      const row = await w.db
        .execute<Record<string, unknown>>({
          sql: "SELECT * FROM sandbox.training_operations WHERE application_id = $1 AND operation_key = $2",
          parameters: [w.applicationId, `trop:allocate:${"pg-ops-1"}:attempt:1`],
        })
        .then((r) => r.rows[0]);
      expect(row?.status).toBe("completed");
      // Terminal immutability.
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_operations SET status = 'pending' WHERE id = $1",
          parameters: [row?.id],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      await expect(
        w.db.execute({
          sql: "DELETE FROM sandbox.training_operations WHERE id = $1",
          parameters: [row?.id],
        }),
      ).rejects.toThrow(/rows are never deleted/);
      // Fingerprint arbitration: same key, different body.
      await expect(
        w.db.execute({
          sql: `INSERT INTO sandbox.training_operations
  (id, application_id, tenant_id, execution_id, workload_id, operation_kind, operation_key,
   request_fingerprint, created_at, updated_at)
VALUES ('00000000-0000-7000-8000-00000000e301', $1, $2, $3, $4, 'allocate', $5, 'different-fingerprint', now(), now())`,
          parameters: [w.applicationId, w.tenantId, final.executionId, final.id, `trop:allocate:pg-ops-1:attempt:1`],
        }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
      // The workload key of the operation is scoped to the application.
      expect(await operationsOfKind("allocate")).toBe(1);
      expect(await operationsOfKind("checkpoint")).toBe(3);
    });
  });

  // =========================================================================
  // TR6 — run-lease physical guards
  // =========================================================================

  describe("run-lease physical guards (TR6)", () => {
    test("epoch is monotonic, owner never moves within an epoch, release is one-way, rows never deleted", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-lease-1");
      const lease = await w.db
        .execute<Record<string, unknown>>({
          sql: "SELECT * FROM sandbox.training_run_leases WHERE application_id = $1 AND workload_id = $2",
          parameters: [w.applicationId, final.id],
        })
        .then((r) => r.rows[0]);
      expect(lease?.released_at).not.toBeNull();
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_run_leases SET epoch = 0 WHERE application_id = $1 AND workload_id = $2",
          parameters: [w.applicationId, final.id],
        }),
      ).rejects.toThrow(/lease epoch must not regress/);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_run_leases SET owner_id = 'other-worker' WHERE application_id = $1 AND workload_id = $2",
          parameters: [w.applicationId, final.id],
        }),
      ).rejects.toThrow(/lease owner cannot change within epoch/);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_run_leases SET released_at = NULL, release_cause = NULL WHERE application_id = $1 AND workload_id = $2",
          parameters: [w.applicationId, final.id],
        }),
      ).rejects.toThrow(/lease is released; it can only be re-acquired at a new epoch/);
      await expect(
        w.db.execute({
          sql: "DELETE FROM sandbox.training_run_leases WHERE application_id = $1 AND workload_id = $2",
          parameters: [w.applicationId, final.id],
        }),
      ).rejects.toThrow(/rows are never deleted/);
    });
  });

  // =========================================================================
  // TR7 — verification-before-release over the REAL verification authority
  // =========================================================================

  describe("verification before release (TR7, ACC-003)", () => {
    test("a completed workload releases ONLY through the verification authority PASS (write-once)", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-release-1");
      expect(final.verifiedReleaseAt).toBeNull(); // completion is NOT release
      await w.declareReleaseCriteria();
      const released = await w.boot(null).service.verifyAndReleaseWorkload(
        {
          applicationId: w.applicationId,
          workloadId: final.id,
          criteria: [{ criterionId: "training-output-lineage", version: 1 }],
          evidenceRefs: [],
        },
        "pg-release-1-key",
        w.actor(),
      );
      expect(released.verifiedReleaseAt).not.toBeNull();
      expect(released.verificationEvaluationId).not.toBeNull();
      // The evaluation is durable in the REAL verification module.
      const row = await w.db
        .execute<Record<string, unknown>>({
          sql: "SELECT COUNT(*)::int AS n FROM verification.evaluations WHERE application_id = $1",
          parameters: [w.applicationId],
        })
        .then((r) => r.rows[0]);
      expect(Number(row?.n ?? 0)).toBe(1);
      // The release binding is write-once (a replay re-binds nothing).
      const replay = await w.boot(null).service.verifyAndReleaseWorkload(
        {
          applicationId: w.applicationId,
          workloadId: final.id,
          criteria: [{ criterionId: "training-output-lineage", version: 1 }],
          evidenceRefs: [],
        },
        "pg-release-1-key",
        w.actor(),
      );
      expect(replay.verifiedReleaseAt).toBe(released.verifiedReleaseAt);
      await expect(
        w.db.execute({
          sql: "UPDATE sandbox.training_workloads SET verified_release_at = NULL WHERE application_id = $1 AND workload_key = $2",
          parameters: [w.applicationId, "pg-release-1"],
        }),
      ).rejects.toThrow(/release_shape|verification-release binding is write-once/);
    });

    test("undeclared criteria fail closed: the release dimension stays null (no evidence never promotes)", async () => {
      const w = await freshWorld();
      const { final } = await submitAndDispatch("pg-release-2");
      // The REAL verification authority rejects undeclared criteria
      // (typed CAPABILITY_UNAVAILABLE — fail closed before any
      // evaluation; the release dimension stays null).
      const error = await expectPlatformError("CAPABILITY_UNAVAILABLE", () =>
        w.boot(null).service.verifyAndReleaseWorkload(
          {
            applicationId: w.applicationId,
            workloadId: final.id,
            criteria: [{ criterionId: "undeclared-criterion", version: 1 }],
            evidenceRefs: [],
          },
          "pg-release-2-key",
          w.actor(),
        ),
      );
      expect(error.message).toMatch(/not declared/);
      const row = await workloadRow("pg-release-2");
      expect(row?.verified_release_at).toBeNull();
    });

    test("a FAILED workload can never enter release verification", async () => {
      const w = await freshWorld({ failRunsOf: () => true });
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const admitted = await w.boot(null).service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-release-3",
        w.actor(),
      );
      const failed = await w.boot(null).service.dispatchWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(failed.status).toBe("failed");
      await expectPlatformError("INVALID_STATE_TRANSITION", () =>
        w.boot(null).service.verifyAndReleaseWorkload(
          {
            applicationId: w.applicationId,
            workloadId: admitted.id,
            criteria: [{ criterionId: "training-output-lineage", version: 1 }],
            evidenceRefs: [],
          },
          "pg-release-3-key",
          w.actor(),
        ),
      );
      const row = await workloadRow("pg-release-3");
      expect(row?.verified_release_at).toBeNull();
    });
  });

  // =========================================================================
  // TR8 — retry: fresh reservation per attempt, discriminator rebind
  // =========================================================================

  describe("training retry (TR8)", () => {
    test("a retried workload gets a FRESH reservation, rebinds the discriminator, and records per-attempt envelopes", async () => {
      const w = await freshWorld({ failRunsOf: (_id, attempt) => attempt === 1 });
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const admitted = await w.boot(null).service.submitWorkload(
        { executionId, spec: trainingSpecOf() },
        "pg-retry-1",
        w.actor(),
      );
      const first = await w.boot(null).service.dispatchWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(first.status).toBe("failed");
      expect(await reservationStatusOf(first.budgetOperationId as string)).toBe("released");
      const retry = await w.boot(null).service.retryWorkload(
        { applicationId: w.applicationId, workloadId: admitted.id },
        w.actor(),
      );
      expect(retry.status).toBe("completed");
      expect(retry.attempts).toBe(2);
      expect(retry.budgetOperationId).not.toBe(first.budgetOperationId);
      expect(await settledOf(retry.budgetOperationId as string)).toBe(1);
      // Two paid allocations (one per attempt), two ledger envelopes.
      expect(w.fleet.listAllocations().length).toBe(2);
      const commands = await eventsOf(executionId);
      expect(commands.filter((c) => c === "sandbox-completed").length).toBe(2);
      const row = await workloadRow("pg-retry-1");
      expect(row?.ledger_completed_sequence).not.toBeNull();
      expect(row?.budget_operation_id).toBe(retry.budgetOperationId);
    });
  });

  // =========================================================================
  // TR9 — N=8 same-key submission convergence
  // =========================================================================

  describe("training concurrency (same-key convergence, TR9)", () => {
    test("N=8 same-key submissions converge to ONE workload row and ONE reservation", async () => {
      const w = await freshWorld();
      await w.fundApplication();
      const executionId = await w.seedExecution("RUNNING");
      const spec = trainingSpecOf();
      const service = () => w.boot(null).service;
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () =>
          service().submitWorkload({ executionId, spec }, "pg-converge-1", w.actor()),
        ),
      );
      const ids = new Set(receipts.map((receipt) => receipt.id));
      expect(ids.size).toBe(1);
      expect(await reservationsOf()).toBe(1);
      expect(
        await countOf(
          w.db,
          "SELECT 1 FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
          [w.applicationId, "pg-converge-1"],
        ),
      ).toBe(1);
      expect((await eventsOf(executionId)).filter((c) => c === "sandbox-admitted").length).toBe(1);
    });
  });
});
