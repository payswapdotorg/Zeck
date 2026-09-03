/**
 * TRAINING SAME-KEY CONVERGENCE STRESS REGRESSION (WORK-030; the
 * closing-tail defect found by the first complete-gate run at 35a9429 —
 * the P14 same-key convergence proof failed ~2 of 12 full-suite runs,
 * intermittently).
 *
 * DEFECT (root-caused from the failing P14 run's captured results — two
 * root causes, both fixed in the same commit as this suite):
 *
 *  (1) LEASE-ACQUIRE TOCTOU STOMP — the SQL store's
 *      `acquireTrainingRunLease` read the standing lease and then
 *      re-acquired it with an UNCONDITIONAL identity-keyed UPDATE; under
 *      READ COMMITTED a racer that had read the lease FREE (lapsed)
 *      before a concurrent re-acquisition committed would then STOMP the
 *      now-live lease (epoch+1, itself the owner), silently superseding
 *      a live foreign owner — the lease's mutual exclusion never fired
 *      and MULTIPLE processes drove the same run concurrently (the
 *      observed failing run ended with the lease at epoch 6, three
 *      different owners seen mid-flight).
 *
 *  (2) CHECKPOINT SEQUENCE-RESOLUTION STATEMENT TEARING — the service
 *      resolved the run-emitted checkpoint position with TWO separate
 *      store reads (identity lookup, then the workload COUNT); under
 *      READ COMMITTED those two statements can tear (the identity
 *      invisible, the count visible), allocating a sequence that
 *      belongs to DIFFERENT content — the seq-keyed checkpoint
 *      operation row then collided on the operation-key unique with a
 *      different request fingerprint (typed IDEMPOTENCY_KEY_REUSED) and
 *      every racing driver aborted mid-drive, so NO driver completed
 *      the workload (the observed failing run: 5x IDEMPOTENCY_KEY_REUSED
 *      + 3x lease-conflict refusals, the row left `running` with one
 *      checkpoint of three). The inherited edge-gate
 *      statement-snapshot-tearing family, in this service's own
 *      allocation.
 *
 * FIX (the 0025 single-snapshot house pattern, both halves):
 *   - the lease acquire is now ONE statement (INSERT ... ON CONFLICT DO
 *     UPDATE ... WHERE free) — a LIVE lease never satisfies the conflict
 *     arm, so a stale free-read can never stomp a live re-acquired
 *     lease; the mutual exclusion is decided by one statement's
 *     snapshot;
 *   - the checkpoint position resolution is now ONE store statement
 *     (scalar subqueries in a single SELECT: the identity's recorded
 *     position + the workload's recorded count) — the two lookups share
 *     one snapshot and cannot tear; the in-memory twin resolves both in
 *     one synchronous pass (store parity).
 *
 * THIS SUITE is the stress pinner: it repeats the P13 shape (N=8
 * same-key DISPATCHES converge) and the P14 shape (a crash mid-run, the
 * lease lapse, then N=8 concurrent RESUMES converge) ~15 times each.
 * It is a PROBABILISTIC pinner (honestly labeled): each iteration races
 * 8 concurrent same-key drivers through the lease acquire and the
 * checkpoint sequence allocation — the tearing defect fired on roughly
 * 2 of 12 such races under full-suite load, so 15 iterations x 2
 * classes make a recurrence overwhelmingly likely to fire here if the
 * fix regressed. The DETERMINISTIC proofs are the single-statement
 * snapshots themselves (one snapshot per resolution, by construction);
 * this suite pins that the observable behavior — the N=8 racers
 * converging onto the ONE durable exactly-once outcome — holds under
 * sustained concurrency.
 */

import { describe, expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite, type PgContext } from "./harness";
import { countOf, seedTrainingWorld, type TrainingPgWorld, trainingSpecOf } from "./training-world";

const ITERATIONS = 15;
const CONCURRENCY = 8;

definePgSuite(
  "training same-key convergence stress regression (WORK-030 closing-tail fix)",
  (ctx: PgContext) => {
    let world: TrainingPgWorld;

    const freshWorld = async () => {
      world = await seedTrainingWorld(ctx.port, {});
      return world;
    };

    const workloadRow = (workloadKey: string) =>
      world.db
        .execute<{ status: string }>({
          sql: "SELECT status FROM sandbox.training_workloads WHERE application_id = $1 AND workload_key = $2",
          parameters: [world.applicationId, workloadKey],
        })
        .then((result) => result.rows[0] ?? null);

    const checkpointsOf = (workloadKey: string) =>
      countOf(
        world.db,
        "SELECT 1 FROM sandbox.training_checkpoints WHERE application_id = $1 AND workload_key = $2",
        [world.applicationId, workloadKey],
      );

    const reservationsOf = (operationId: string) =>
      world.db
        .execute<{ status: string }>({
          sql: "SELECT r.status FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1 AND r.operation_id = $2",
          parameters: [world.applicationId, operationId],
        })
        .then((result) => result.rows[0]?.status ?? null);

    const completedEnvelopesOf = (executionId: string) =>
      world.executionService
        .listEvents(world.applicationId, executionId)
        .then((events) => events.filter((event) => event.command === "sandbox-completed").length);

    /** Submit one funded workload on a fresh running execution. */
    const submitFunded = async (workloadKey: string) => {
      const executionId = await world.seedExecution("RUNNING");
      const admitted = await world
        .boot(null)
        .service.submitWorkload(
          { executionId, spec: trainingSpecOf() },
          workloadKey,
          world.actor(),
        );
      return { admitted, executionId };
    };

    describe("stress", () => {
      test("N=8 same-key DISPATCHES converge ~15 iterations in a row (P13 under sustained concurrency)", async () => {
        const w = await freshWorld();
        await w.fundApplication();
        for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
          const key = `stress-dispatch-${iteration}`;
          const { admitted, executionId } = await submitFunded(key);
          const service = () => w.boot(null).service;
          // THE RACE: 8 concurrent same-key dispatches through the guarded
          // transition, the lease acquire and the checkpoint sequence
          // allocation.
          const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
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
          expect(
            completed.length,
            `iteration ${iteration}: no dispatcher completed the workload`,
          ).toBeGreaterThanOrEqual(1);
          expect(
            results.every((r) => !(r instanceof Error) || r instanceof PlatformError),
            `iteration ${iteration}: a non-typed error surfaced`,
          ).toBe(true);
          expect((await workloadRow(key))?.status, `iteration ${iteration}`).toBe("completed");
          // Exactly-once durable side effects per stable key.
          expect(await checkpointsOf(key), `iteration ${iteration}`).toBe(3);
          expect(await completedEnvelopesOf(executionId), `iteration ${iteration}`).toBe(1);
          expect(
            await reservationsOf(admitted.budgetOperationId as string),
            `iteration ${iteration}`,
          ).toBe("settled");
          // One paid allocation and one run per workload across the loop.
          expect(w.fleet.listAllocations().length, `iteration ${iteration}`).toBe(iteration);
          expect(w.fleet.runCount(), `iteration ${iteration}`).toBe(iteration);
        }
      });

      test("N=8 same-key RESUMES after a crash + lease lapse converge ~15 iterations in a row (P14 under sustained concurrency)", async () => {
        const w = await freshWorld();
        await w.fundApplication();
        for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
          const key = `stress-resume-${iteration}`;
          const { admitted, executionId } = await submitFunded(key);
          // The first process dies mid-run (after the run observation,
          // before the checkpoint writes) — the P14 shape.
          const dying = w.boot({
            target: "store",
            method: "insertTrainingCheckpoint",
            when: "before",
          });
          await dying.service
            .dispatchWorkload(
              { applicationId: w.applicationId, workloadId: admitted.id },
              w.actor(),
            )
            .then(
              () => undefined,
              () => undefined,
            );
          expect(dying.crashed(), `iteration ${iteration}: the dying process did not crash`).toBe(
            true,
          );
          // The crashed worker's lease lapses.
          w.clock.advance(120_000);
          const service = () => w.boot(null).service;
          // THE RACE: 8 concurrent same-key re-drives (resumes) through
          // the lapsed-lease CAS acquire and the checkpoint sequence
          // allocation.
          const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
              service()
                .resumeWorkload(
                  { applicationId: w.applicationId, workloadId: admitted.id },
                  w.actor(),
                )
                .catch((error: unknown) => error),
            ),
          );
          const completed = results.filter(
            (r) => !(r instanceof Error) && (r as { status?: string }).status === "completed",
          );
          expect(
            completed.length,
            `iteration ${iteration}: no re-driver completed the workload`,
          ).toBeGreaterThanOrEqual(1);
          expect(
            results.every((r) => !(r instanceof Error) || r instanceof PlatformError),
            `iteration ${iteration}: a non-typed error surfaced`,
          ).toBe(true);
          expect((await workloadRow(key))?.status, `iteration ${iteration}`).toBe("completed");
          // Exactly-once durable side effects per stable key after the
          // restart.
          expect(await checkpointsOf(key), `iteration ${iteration}`).toBe(3);
          expect(await completedEnvelopesOf(executionId), `iteration ${iteration}`).toBe(1);
          expect(
            await reservationsOf(admitted.budgetOperationId as string),
            `iteration ${iteration}`,
          ).toBe("settled");
          // One paid allocation and one run per workload across the loop.
          expect(w.fleet.listAllocations().length, `iteration ${iteration}`).toBe(iteration);
          expect(w.fleet.runCount(), `iteration ${iteration}`).toBe(iteration);
        }
      });
    });
  },
);
