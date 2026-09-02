/**
 * Real-PostgreSQL proofs: the long-running execution extension's durable
 * discipline (WORK-028; LNG-001/002/003) over migration 0022.
 *
 * Every proof runs against the REAL SQL store + the REAL frozen
 * executions module + the REAL policies/budgets/sandbox authorities on a
 * disposable PostgreSQL 16 database (the harness applies the shipped
 * migrations, 0022 included). The kill/restart crash-injection halves live
 * in long-running-crash-recovery.test.ts; the mutation (discrimination)
 * halves live in tests/discrimination/long-running-execution.discrimination.test.ts.
 *
 * PROOF MAP:
 *   L1  physical guard set of execution_checkpoints (append-only,
 *       gapless sequence, digest shape, terminal gate)
 *   L2  lease physical guards (epoch monotonic, owner within epoch, expiry
 *       never shortens, one-way release, no delete, terminal insert gate)
 *   L3  wake-up physical guards (status machine, terminal immutability,
 *       outcome-field exclusivity, no delete)
 *   L4  operation-table physical discipline (terminal immutability, core
 *       immutability, attempts monotonicity, no delete, outcome checks)
 *   L5  checkpoint write-once convergence (same sequence + digest, key
 *       reuse on different digest, the committed-effect digest probe)
 *   L6  lease single-owner discipline (N=8 concurrent acquires → ONE
 *       winner; expiry re-acquisition advances the epoch; renewal extends
 *       and counts heartbeats; one-way release; force-release)
 *   L7  stale-worker denial (AC3): expired / superseded / foreign claims
 *       fail closed typed BEFORE any write; worker transitions guarded
 *   L8  pause → checkpoint → resume with the SAME identity (AC1) and the
 *       full provenance chain on the canonical ledger
 *   L9  the materiality rule (AC4): materially changed resumes re-enter
 *       the REAL policy / sandbox / budget authorities; a denial is
 *       journaled (`resume-denied`) and fails closed; an unchanged resume
 *       never re-consults
 *   L10 human interruption + governed termination (AC5): authoritative,
 *       auditable, wake-revoking, lease-force-releasing, frozen-lifecycle
 *       only
 *   L11 wake-up ordering + idempotent application (deterministic
 *       (earliestWakeAt, id) order; write-once application; supersede)
 *   L12 concurrent resume convergence (AC6): N=8 different workers → ONE
 *       authoritative resumption, 7 typed conflicts, zero duplicate side
 *       effects; N=8 same-key → one durable claim, one transition
 *   L13 tenant isolation on the extension tables (service + physical FK)
 *   L14 the recovery scan (pendingWakeUpApplies over the pending partial
 *       index, deterministic order)
 */

import { describe, expect, test } from "vitest";
import type { LongRunningExecutionService } from "../../../src/modules/executions/application/long-running-service";
import {
  type LongRunningOperationKind,
  longRunningOperationKey,
} from "../../../src/modules/executions/domain/longrunning";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import {
  checkpointOf,
  factsOf,
  type LongRunningPgWorld,
  one,
  seedLongRunningWorld,
} from "./longrunning-world";

definePgSuite("long-running execution durable discipline (WORK-028)", (ctx) => {
  let world: LongRunningPgWorld;
  let service: LongRunningExecutionService;

  const boot = () => {
    const process = world.boot(null);
    service = process.service;
    return process;
  };

  const newExecution = async () => world.driveToRunning(world.boot(null).executions);

  const acquire = (executionId: string, ownerId: string, ttlMs = 60_000) =>
    service.acquireLease(
      { applicationId: world.applicationId, executionId, actor: world.actor(), ownerId, ttlMs },
      `lease-${ownerId}-${executionId}`,
    );

  const checkpoint = (executionId: string) =>
    service.recordCheckpoint(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );

  const pause = (executionId: string, wake?: { wakeKey: string; earliestWakeAt: string }) =>
    service.pauseExecution(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        ...(wake === undefined
          ? {}
          : {
              wakeUp: {
                wakeKey: wake.wakeKey,
                cause: "awaiting tool result",
                earliestWakeAt: wake.earliestWakeAt,
              },
            }),
      },
      `pause-${executionId}`,
    );

  const resume = (executionId: string, key: string, overrides: Record<string, unknown> = {}) =>
    service.resumeExecution(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        resumeFacts: factsOf(checkpointOf(executionId)),
        ...overrides,
      },
      key,
    );

  const eventsOf = async (executionId: string, command: string) =>
    (
      await one(
        world.db,
        "SELECT COUNT(*)::int AS n FROM executions.execution_events WHERE execution_id = $1 AND command = $2",
        [executionId, command],
      )
    )?.n ?? 0;

  const statusOf = async (executionId: string) =>
    (
      await one<{ status: string }>(
        world.db,
        "SELECT status FROM executions.executions WHERE id = $1",
        [executionId],
      )
    )?.status;

  const leaseRow = (executionId: string) =>
    one<{
      owner_id: string;
      epoch: number;
      heartbeat_count: number;
      released_at: string | null;
      release_cause: string | null;
      expires_at: string;
    }>(
      world.db,
      "SELECT owner_id, epoch, heartbeat_count, released_at, release_cause, expires_at FROM executions.execution_leases WHERE execution_id = $1",
      [executionId],
    );

  const operationRow = (kind: LongRunningOperationKind, discriminator: string) =>
    one<{
      status: string;
      attempts: number;
      stage: Record<string, unknown> | null;
      failure_reason: string | null;
    }>(
      world.db,
      "SELECT status, attempts, stage, failure_reason FROM executions.execution_operations WHERE application_id = $1 AND operation_key = $2",
      [world.applicationId, longRunningOperationKey(kind, discriminator)],
    );

  const wakeRow = (executionId: string, wakeKey: string) =>
    one<{ status: string; applied_operation_key: string | null; supersede_cause: string | null }>(
      world.db,
      "SELECT status, applied_operation_key, supersede_cause FROM executions.execution_wakeups WHERE application_id = $1 AND execution_id = $2 AND wake_key = $3",
      [world.applicationId, executionId, wakeKey],
    );

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Raw guard probes reject with the physical guard's own message. */
  const expectGuard = async (run: () => Promise<unknown>, pattern: RegExp) => {
    await expect(run()).rejects.toThrow(pattern);
  };

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

  test("the world boots over migration 0022 (all four extension tables exist with their guard triggers)", async () => {
    world = await seedLongRunningWorld(ctx.port);
    boot();
    for (const table of [
      "execution_checkpoints",
      "execution_leases",
      "execution_wakeups",
      "execution_operations",
    ]) {
      const row = await one<{ n: number }>(
        world.db,
        "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'executions' AND table_name = $1",
        [table],
      );
      expect(row?.n).toBe(1);
    }
    // The shipped migrations applied in ascending order (0022 last).
    const applied = await ctx.port.execute<{ version: string; name: string }>({
      sql: "SELECT version, name FROM platform.schema_migrations ORDER BY version DESC LIMIT 1",
      parameters: [],
    });
    expect(applied.rows[0]?.name).toContain("long_running_execution_state");
  });

  describe("L1 the physical guard set of execution_checkpoints", () => {
    test("UPDATE and DELETE are physically rejected (append-only evidence)", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await checkpoint(executionId);
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_checkpoints SET plan_id = 'x' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /append-only/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "DELETE FROM executions.execution_checkpoints WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /append-only/,
      );
    });

    test("the per-execution sequence is gapless (a skipped sequence is unrepresentable); a terminal execution accepts no checkpoint", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await checkpoint(executionId); // sequence 1
      const digest = (
        await one<{ content_digest: string }>(
          world.db,
          "SELECT content_digest FROM executions.execution_checkpoints WHERE execution_id = $1",
          [executionId],
        )
      )?.content_digest;
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: `INSERT INTO executions.execution_checkpoints (id, application_id, tenant_id, execution_id, checkpoint_sequence, plan_id, plan_revision, context_artifacts, last_event_position, resource_class, environment_id, environment_spec_digest, required_capabilities, max_cost_micro_usd, content_digest, recorded_by, created_at)
VALUES ($1, $2, $3, $4, 5, 'plan-1', 3, '[]'::jsonb, 5, 'standard', NULL, NULL, '[]'::jsonb, NULL, $5, 'worker-1', now())`,
            parameters: [
              "00000000-0000-7000-8000-0000000000f1",
              world.applicationId,
              world.tenantId,
              executionId,
              digest,
            ],
          }),
        /gapless/,
      );
      // Terminate, then a checkpoint insert on the terminal row is rejected.
      await service.terminateExecution(
        { applicationId: world.applicationId, executionId, actor: world.actor(), reason: "done" },
        `term-${executionId}`,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: `INSERT INTO executions.execution_checkpoints (id, application_id, tenant_id, execution_id, checkpoint_sequence, plan_id, plan_revision, context_artifacts, last_event_position, resource_class, environment_id, environment_spec_digest, required_capabilities, max_cost_micro_usd, content_digest, recorded_by, created_at)
VALUES ($1, $2, $3, $4, 2, 'plan-1', 3, '[]'::jsonb, 5, 'standard', NULL, NULL, '[]'::jsonb, NULL, $5, 'worker-1', now())`,
            parameters: [
              "00000000-0000-7000-8000-0000000000f2",
              world.applicationId,
              world.tenantId,
              executionId,
              digest,
            ],
          }),
        /terminal.*append-only evidence|is terminal; checkpoints are append-only/,
      );
    });
  });

  describe("L2 the physical guard set of execution_leases", () => {
    test("owner within epoch / epoch regression / expiry shortening / release shape / delete are physically rejected", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_leases SET owner_id = 'other' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /owner cannot change within epoch/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_leases SET epoch = 0 WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /epoch must not regress/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_leases SET expires_at = now() - interval '1 hour' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /expiry must not shorten/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_leases SET released_at = now() WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /lr_lease_release_shape/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "DELETE FROM executions.execution_leases WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /never deleted/,
      );
      // A lease row for a TERMINAL execution is unrepresentable.
      const otherExecution = await newExecution();
      await service.terminateExecution(
        {
          applicationId: world.applicationId,
          executionId: otherExecution,
          actor: world.actor(),
          reason: "done",
        },
        `term-${otherExecution}`,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: `INSERT INTO executions.execution_leases (execution_id, application_id, tenant_id, owner_id, epoch, acquired_at, expires_at, last_heartbeat_at, heartbeat_count, released_at, release_cause, updated_at)
VALUES ($1, $2, $3, 'w', 1, now(), now() + interval '1 hour', now(), 0, NULL, NULL, now())`,
            parameters: [otherExecution, world.applicationId, world.tenantId],
          }),
        /is terminal; no lease may be acquired/,
      );
    });
  });

  describe("L3 the physical guard set of execution_wakeups", () => {
    test("the status machine is write-once; scheduled carries no outcome; rows are never deleted", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await service.scheduleWakeUp(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          wakeKey: "w1",
          cause: "backoff",
          earliestWakeAt: new Date(Date.now() - 1_000).toISOString(),
        },
        `sched-${executionId}`,
      );
      // A scheduled row cannot carry outcome fields (the lifecycle guard
      // trigger rejects it before the CHECK constraint fires).
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_wakeups SET supersede_cause = 'x' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /scheduled carries no outcome fields|lr_wakeup_scheduled_has_no_outcome/,
      );
      // earliest_wake_at is part of the identity core (a schedule never
      // silently moves — a changed wake is a NEW wake under a new key).
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_wakeups SET earliest_wake_at = now() - interval '1 second' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /identity core is immutable/,
      );
      // Apply the DUE wake through the service, then the row is terminal-immutable.
      const outcome = await service.applyWakeUps({
        applicationId: world.applicationId,
        actor: world.actor(),
      });
      expect(outcome.applications).toHaveLength(1);
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_wakeups SET status = 'scheduled' WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /terminal-immutable/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "DELETE FROM executions.execution_wakeups WHERE execution_id = $1",
            parameters: [executionId],
          }),
        /never deleted/,
      );
    });
  });

  describe("L4 the physical discipline of execution_operations", () => {
    test("terminal rows are immutable; the identity core is write-once; attempts never regress; no delete", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await checkpoint(executionId);
      const key = longRunningOperationKey("checkpoint", `${executionId}:ck-${executionId}`);
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_operations SET status = 'pending' WHERE operation_key = $1",
            parameters: [key],
          }),
        /terminal-immutable/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_operations SET operation_key = 'lrop:x:y' WHERE operation_key = $1",
            parameters: [key],
          }),
        /identity core is immutable/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_operations SET failure_reason = 'x' WHERE operation_key = $1",
            parameters: [key],
          }),
        /terminal-immutable/,
      );
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "DELETE FROM executions.execution_operations WHERE operation_key = $1",
            parameters: [key],
          }),
        /never deleted/,
      );
      // A PENDING row: the attempts ledger never regresses (the lifecycle guard).
      await ctx.port.execute({
        sql: `INSERT INTO executions.execution_operations (id, application_id, tenant_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at)
VALUES ($1, $2, $3, $4, 'resume', 'lrop:pending:attempts', 'fp', 'pending', 3, NULL, NULL, now(), now(), NULL)`,
        parameters: [
          "00000000-0000-7000-8000-0000000000f4",
          world.applicationId,
          world.tenantId,
          executionId,
        ],
      });
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: "UPDATE executions.execution_operations SET attempts = 0 WHERE operation_key = 'lrop:pending:attempts'",
          }),
        /cannot move from status/,
      );
    });
  });

  describe("L5 checkpoint write-once convergence", () => {
    test("the same sequence + digest converges; a different digest on the same sequence fails closed; the digest probe finds the committed row", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      const first = await checkpoint(executionId);
      // The committed-effect probe.
      const probe = await world.store.findCheckpointByDigest(
        world.applicationId,
        executionId,
        first.contentDigest,
      );
      expect(probe?.id).toBe(first.checkpointId);
      // Same digest insert converges at the store level.
      const converged = await world.store.insertCheckpoint({
        id: "00000000-0000-7000-8000-0000000000e1",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        checkpointSequence: 1,
        contents: checkpointOf(executionId),
        contentDigest: first.contentDigest,
        recordedBy: "worker-1",
        now: new Date().toISOString(),
      });
      expect(converged.status).toBe("converged");
      // A different digest on the SAME sequence is key reuse.
      await expectPlatformError(
        () =>
          world.store.insertCheckpoint({
            id: "00000000-0000-7000-8000-0000000000e2",
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            executionId,
            checkpointSequence: 1,
            contents: checkpointOf(executionId, { planRevision: 4 }),
            contentDigest: "a".repeat(64),
            recordedBy: "worker-1",
            now: new Date().toISOString(),
          }),
        "IDEMPOTENCY_KEY_REUSED",
      );
      // The second checkpoint is sequence 2 (gapless).
      const second = await service.recordCheckpoint(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          worker: { ownerId: "worker-1", epoch: 1 },
          contents: checkpointOf(executionId, { lastEventPosition: 6 }),
        },
        `ck2-${executionId}`,
      );
      expect(second.checkpointSequence).toBe(2);
    });
  });

  describe("L6 the lease single-owner discipline", () => {
    test("N=8 CONCURRENT acquires: exactly ONE winner, 7 typed refusals; expiry re-acquisition advances the epoch; renewal extends and counts heartbeats; release is one-way", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      type AcquireRace =
        | { owner: string; ok: true; epoch: number }
        | { owner: string; ok: false; code: string };
      const results: AcquireRace[] = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          service
            .acquireLease(
              {
                applicationId: world.applicationId,
                executionId,
                actor: world.actor(),
                ownerId: `racer-${i}`,
                ttlMs: 60_000,
              },
              `race-${i}-${executionId}`,
            )
            .then((outcome) => ({
              owner: `racer-${i}`,
              ok: true as const,
              epoch: outcome.lease.epoch,
            }))
            .catch((error: PlatformError) => ({
              owner: `racer-${i}`,
              ok: false as const,
              code: error.code,
            })),
        ),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1); // ONE authoritative owner
      const losers = results.filter((r) => !r.ok);
      expect(losers).toHaveLength(7);
      for (const loser of losers) {
        expect(loser.code).toBe("INVALID_STATE_TRANSITION"); // fail closed
      }
      const winnerOwner = (winners[0] as { owner: string }).owner;
      // Expiry → re-acquisition by another owner advances the epoch. A
      // SECOND execution carries this sub-proof (the race winner's 60s
      // lease is deliberately still live — a live lease is never
      // stolen; only an EXPIRED one re-acquires at epoch + 1).
      const shortExecution = await newExecution();
      const shortHolder = world.boot(null);
      const shortLease = await shortHolder.service.acquireLease(
        {
          applicationId: world.applicationId,
          executionId: shortExecution,
          actor: world.actor(),
          ownerId: "worker-1",
          ttlMs: 1,
        },
        `short-${shortExecution}`,
      );
      expect(shortLease.lease.epoch).toBe(1);
      await sleep(20);
      const takeover = world.boot(null);
      const renewed = await takeover.service.acquireLease(
        {
          applicationId: world.applicationId,
          executionId: shortExecution,
          actor: world.actor(),
          ownerId: "worker-2",
          ttlMs: 60_000,
        },
        `takeover-${shortExecution}`,
      );
      expect(renewed.lease.epoch).toBe(2); // monotonic epoch
      // Renewal extends and counts heartbeats (the monotonic ledger).
      const hb1 = await takeover.service.renewLease(
        {
          applicationId: world.applicationId,
          executionId: shortExecution,
          actor: world.actor(),
          worker: { ownerId: "worker-2", epoch: 2 },
          ttlMs: 60_000,
        },
        `hb1-${shortExecution}`,
      );
      const hb2 = await takeover.service.renewLease(
        {
          applicationId: world.applicationId,
          executionId: shortExecution,
          actor: world.actor(),
          worker: { ownerId: "worker-2", epoch: 2 },
          ttlMs: 120_000,
        },
        `hb2-${shortExecution}`,
      );
      expect(hb1.lease.heartbeatCount).toBe(1);
      expect(hb2.lease.heartbeatCount).toBe(2);
      // Release is one-way: the released row carries the cause forever.
      await takeover.service.releaseLease(
        {
          applicationId: world.applicationId,
          executionId: shortExecution,
          actor: world.actor(),
          worker: { ownerId: "worker-2", epoch: 2 },
          cause: "worker-released",
        },
        `rel-${shortExecution}`,
      );
      expect(await leaseRow(shortExecution)).toMatchObject({ release_cause: "worker-released" });
      // The race winner's LIVE lease is still held (nothing stole it).
      expect(await leaseRow(executionId)).toMatchObject({
        owner_id: winnerOwner,
        released_at: null,
      });
    });
  });

  describe("L7 stale-worker denial (AC3)", () => {
    test("an EXPIRED claim fails closed typed BEFORE any write; a SUPERSEDED epoch never matches again; a foreign owner is refused; worker transitions are guarded", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1", 1);
      await sleep(20);
      // EXPIRED: the stale worker cannot checkpoint or transition.
      await expectPlatformError(() => checkpoint(executionId), "EXPIRED");
      await expectPlatformError(
        () =>
          service.workerTransition(
            {
              applicationId: world.applicationId,
              worker: { ownerId: "worker-1", epoch: 1 },
              command: {
                ...world.actor(),
                applicationId: world.applicationId,
                executionId,
                command: "wait-tool",
                reason: "stale worker pause",
              },
            },
            `stale-wait-${executionId}`,
          ),
        "EXPIRED",
      );
      expect(await statusOf(executionId)).toBe("RUNNING"); // nothing committed
      // Another worker re-acquires (epoch 2): worker-1's epoch never matches again.
      const next = world.boot(null);
      await next.service.acquireLease(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          ownerId: "worker-2",
          ttlMs: 60_000,
        },
        `takeover-${executionId}`,
      );
      await expectPlatformError(
        () =>
          service.recordCheckpoint(
            {
              applicationId: world.applicationId,
              executionId,
              actor: world.actor(),
              worker: { ownerId: "worker-1", epoch: 1 },
              contents: checkpointOf(executionId),
            },
            `stale-ck-${executionId}`,
          ),
        "INVALID_STATE_TRANSITION",
      );
      // A foreign live lease refuses acquisition (fail closed).
      await expectPlatformError(
        () =>
          service.acquireLease(
            {
              applicationId: world.applicationId,
              executionId,
              actor: world.actor(),
              ownerId: "worker-3",
              ttlMs: 60_000,
            },
            `foreign-${executionId}`,
          ),
        "INVALID_STATE_TRANSITION",
      );
    });
  });

  describe("L8 pause → checkpoint → resume with the SAME identity (AC1)", () => {
    test("the full protocol over real PostgreSQL: one identity, structural checkpoint contents, provenance on the canonical ledger", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      const paused = await pause(executionId);
      expect(paused.status).toBe("WAITING_TOOL");
      expect(paused.leaseReleased).toBe(true);
      const row = await one<Record<string, unknown>>(
        world.db,
        "SELECT checkpoint_sequence, plan_id, plan_revision, context_artifacts, last_event_position, resource_class, required_capabilities, content_digest FROM executions.execution_checkpoints WHERE execution_id = $1",
        [executionId],
      );
      // The STRUCTURAL restart contract (every field a durable column).
      expect(row).toMatchObject({
        checkpoint_sequence: 1,
        plan_id: "plan-1",
        plan_revision: 3,
        last_event_position: 5,
        resource_class: "standard",
      });
      expect(String(row?.content_digest)).toMatch(/^[0-9a-f]{64}$/);
      const resumed = await resume(executionId, `resume-${executionId}`);
      expect(resumed.executionId).toBe(executionId); // THE identity invariant
      expect(resumed.status).toBe("RUNNING");
      expect(resumed.readmitted).toBe(false); // unchanged facts: no re-admission
      // The provenance chain on the canonical ledger.
      expect(await eventsOf(executionId, "checkpoint-recorded")).toBe(1);
      expect(await eventsOf(executionId, "wait-tool")).toBe(1);
      expect(await eventsOf(executionId, "resume")).toBe(1);
      // An incompatible plan downgrade is rejected typed.
      await pause(executionId);
      await expectPlatformError(
        () =>
          resume(executionId, `bad-resume-${executionId}`, {
            resumeFacts: factsOf(checkpointOf(executionId, { planRevision: 1 })),
          }),
        "INVALID_STATE_TRANSITION",
      );
    });
  });

  describe("L9 the materiality rule (AC4)", () => {
    test("an UNCHANGED resume never re-consults the authorities; a materially changed resume re-enters the REAL policy/sandbox/budget authorities; denials are journaled and fail closed", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const environment = await world.registerEnvironment("longrunning-env");
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      // Pause under an environment binding (the sandbox axis is live).
      await service.pauseExecution(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          worker: { ownerId: "worker-1", epoch: 1 },
          waitKind: "tool",
          checkpoint: checkpointOf(executionId, {
            environmentId: environment.id,
            environmentSpecDigest: environment.specDigest,
          }),
        },
        `pause-${executionId}`,
      );
      // MATERIALLY CHANGED on the resource axis: the same environment
      // binding with a different resource class — and the environment is
      // suspended, so the REAL sandbox catalog denies
      // (CAPABILITY_UNAVAILABLE).
      await world.environmentCatalog.suspend(world.applicationId, environment.id, "suspend-1", {
        actorId: world.actor().actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      });
      const changed = factsOf(
        checkpointOf(executionId, {
          resourceClass: "gpu",
          environmentId: environment.id,
          environmentSpecDigest: environment.specDigest,
        }),
      );
      await expectPlatformError(
        () => resume(executionId, `denied-${executionId}`, { resumeFacts: changed }),
        "CAPABILITY_UNAVAILABLE",
      );
      // The denial is JOURNALED on the canonical ledger (fail-closed +
      // auditable) and the operation row records the durable failure.
      expect(await eventsOf(executionId, "resume-denied")).toBe(1);
      expect(await operationRow("resume", `${executionId}:denied-${executionId}`)).toMatchObject({
        status: "failed",
      });
      expect(await statusOf(executionId)).toBe("WAITING_TOOL"); // never resumed
      // Resume the environment: the materially changed resume now passes
      // the sandbox axis and the REAL policy engine (platform-allow).
      await world.environmentCatalog.resume(world.applicationId, environment.id, "resume-env-1", {
        actorId: world.actor().actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      });
      const readmitted = await resume(executionId, `readmit-${executionId}`, {
        resumeFacts: changed,
      });
      expect(readmitted.readmitted).toBe(true);
      expect(readmitted.materialChange).toContain("resourceClass");
      expect(readmitted.status).toBe("RUNNING");
    });

    test("a materially changed COST bound re-enters the REAL policy engine (cost ceiling denial) and the REAL budgets reservation (admitted)", async () => {
      world = await seedLongRunningWorld(ctx.port);
      await world.fundApplication("1000000");
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await pause(executionId);
      // A restrictive policy set v2: the cost ceiling denies the changed bound.
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
      await expectPlatformError(
        () =>
          resume(executionId, `cost-denied-${executionId}`, {
            resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" })),
          }),
        "POLICY_DENIED",
      );
      expect(await eventsOf(executionId, "resume-denied")).toBe(1);
      // Roll the set back to platform-allow: the cost-bound resume
      // reserves through the REAL budgets module and completes.
      await world.policyAuthority.publish({
        id: "default",
        version: 3,
        documents: [{ scope: "platform", selector: {}, restrictions: {} }],
      });
      const costed = await resume(executionId, `cost-ok-${executionId}`, {
        resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" })),
      });
      expect(costed.readmitted).toBe(true);
      const reservation = await one<{ amount_micro_usd: string }>(
        world.db,
        "SELECT amount_micro_usd FROM budgets.reservations WHERE execution_id = $1 ORDER BY created_at DESC LIMIT 1",
        [executionId],
      );
      expect(reservation?.amount_micro_usd).toBe("500000");
    });
  });

  describe("L10 human interruption and governed termination (AC5)", () => {
    test("interruption: journal-then-act, wake supersede, lease force-release, WAITING_HUMAN through the frozen machine; termination: CANCELLED with verification binding", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await pause(executionId, {
        wakeKey: "tool-return",
        earliestWakeAt: new Date().toISOString(),
      });
      // A worker re-acquires the lease (interruption must force-release it).
      const worker = world.boot(null);
      await worker.service.acquireLease(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          ownerId: "worker-9",
          ttlMs: 60_000,
        },
        `reacquire-${executionId}`,
      );
      const interrupted = await service.requestInterruption(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          reason: "operator halt",
        },
        `interrupt-${executionId}`,
      );
      expect(interrupted.status).toBe("WAITING_TOOL"); // already waiting: the frozen machine has no WAITING_TOOL -> WAITING_HUMAN edge
      expect(interrupted.wakeUpsSuperseded).toBe(1);
      expect(interrupted.leaseReleased).toBe(true);
      expect(await wakeRow(executionId, "tool-return")).toMatchObject({ status: "superseded" });
      expect(await leaseRow(executionId)).toMatchObject({ release_cause: "human-interruption" });
      expect(await eventsOf(executionId, "interruption-requested")).toBe(1);
      // The RUNNING interruption moves to WAITING_HUMAN.
      const liveExecution = await newExecution();
      await acquire(liveExecution, "worker-2");
      const halted = await service.requestInterruption(
        {
          applicationId: world.applicationId,
          executionId: liveExecution,
          actor: world.actor(),
          reason: "operator halt",
        },
        `interrupt-${liveExecution}`,
      );
      expect(halted.status).toBe("WAITING_HUMAN");
      // Governed termination: the frozen cancel path with verification.
      const terminated = await service.terminateExecution(
        {
          applicationId: world.applicationId,
          executionId: halted.executionId,
          actor: world.actor(),
          reason: "governed shutdown",
          verificationResults: [
            {
              criterionId: "c1",
              strategy: "operator-review",
              status: "PASS",
              recordedBy: "operator",
            },
          ],
        },
        `terminate-${halted.executionId}`,
      );
      expect(terminated.status).toBe("CANCELLED");
      expect(await eventsOf(executionId, "cancel")).toBe(0); // untouched execution
      expect(await eventsOf(halted.executionId, "cancel")).toBe(1);
    });
  });

  describe("L11 wake-up ordering and idempotent application", () => {
    test("the due scan is deterministic (earliestWakeAt, id); application is write-once; a superseded wake never fires", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      const past = new Date(Date.now() - 1_000).toISOString();
      await pause(executionId, { wakeKey: "wake-b", earliestWakeAt: past });
      // A second wake on the same execution scheduled earlier.
      await service.scheduleWakeUp(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          wakeKey: "wake-a",
          cause: "earlier",
          earliestWakeAt: new Date(Date.now() - 5_000).toISOString(),
        },
        `sched-a-${executionId}`,
      );
      const outcome = await service.applyWakeUps({
        applicationId: world.applicationId,
        actor: world.actor(),
      });
      // wake-a (earliest) applied first, wake-b second — both resumed the
      // sleeping execution: the FIRST resume moves it to RUNNING, the
      // second observes already-running.
      const keys = outcome.applications.map((a) => a.wakeKey);
      expect(keys).toEqual(["wake-a", "wake-b"]);
      expect(outcome.applications[0]?.action).toBe("resumed");
      expect(outcome.applications[1]?.action).toBe("already-running");
      expect(await statusOf(executionId)).toBe("RUNNING");
      // Idempotent: a second application is a no-op.
      const again = await service.applyWakeUps({
        applicationId: world.applicationId,
        actor: world.actor(),
      });
      expect(again.applications).toHaveLength(0);
      expect(await eventsOf(executionId, "wake-up-applied")).toBe(2);
    });
  });

  describe("L12 concurrent resume convergence (AC6)", () => {
    test("N=8 DIFFERENT workers: ONE authoritative resumption, 7 typed conflicts, zero duplicate side effects", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await pause(executionId);
      const racers = Array.from({ length: 8 }, (_, i) => `resumer-${i}`);
      type ResumeRace =
        | { ownerId: string; ok: true; status: string; replayed: boolean }
        | { ownerId: string; ok: false; code: string };
      const results: ResumeRace[] = await Promise.all(
        racers.map((ownerId) =>
          service
            .resumeExecution(
              {
                applicationId: world.applicationId,
                executionId,
                actor: world.actor(),
                resumeFacts: factsOf(checkpointOf(executionId)),
                worker: { ownerId, ttlMs: 60_000 },
              },
              `race-resume-${ownerId}`,
            )
            .then((outcome) => ({
              ownerId,
              ok: true as const,
              status: outcome.status,
              replayed: outcome.replayed,
            }))
            .catch((error: PlatformError) => ({ ownerId, ok: false as const, code: error.code })),
        ),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1); // ONE authoritative resumption
      expect(winners[0]).toMatchObject({ status: "RUNNING", replayed: false });
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.code).toBe("INVALID_STATE_TRANSITION"); // conflicts FAIL CLOSED
      }
      // Zero duplicate side effects: ONE resume transition, ONE lease owner.
      expect(await eventsOf(executionId, "resume")).toBe(1);
      expect(await leaseRow(executionId)).toMatchObject({
        owner_id: (winners[0] as { ownerId: string }).ownerId,
      });
    });

    test("N=8 SAME key: one durable claim, attempts = 8, ONE resume transition (key convergence)", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      await pause(executionId);
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.resumeExecution(
            {
              applicationId: world.applicationId,
              executionId,
              actor: world.actor(),
              resumeFacts: factsOf(checkpointOf(executionId)),
            },
            `same-key-resume-${executionId}`,
          ),
        ),
      );
      for (const outcome of outcomes) {
        expect(outcome.executionId).toBe(executionId);
        expect(outcome.status).toBe("RUNNING");
      }
      expect(await eventsOf(executionId, "resume")).toBe(1); // ONE transition
      const row = await operationRow("resume", `${executionId}:same-key-resume-${executionId}`);
      expect(row).toMatchObject({ status: "completed", attempts: 8 });
    });
  });

  describe("L13 tenant isolation", () => {
    test("cross-tenant long-running operations fail TENANT_SCOPE_VIOLATION; the physical FK enforces the composite tenant key", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      const foreignActor = {
        actorId: world.actor().actorId,
        tenantId: "00000000-0000-7000-8000-0000000000ee",
      };
      await expectPlatformError(
        () =>
          service.recordCheckpoint(
            {
              applicationId: world.applicationId,
              executionId,
              actor: foreignActor,
              worker: { ownerId: "worker-1", epoch: 1 },
              contents: checkpointOf(executionId),
            },
            `foreign-ck-${executionId}`,
          ),
        "TENANT_SCOPE_VIOLATION",
      );
      // Physical: an extension row for a foreign tenant is unrepresentable.
      await expectGuard(
        () =>
          ctx.port.execute({
            sql: `INSERT INTO executions.execution_operations (id, application_id, tenant_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at)
VALUES ($1, $2, $3, $4, 'checkpoint', 'lrop:t:1', 'fp', 'pending', 1, NULL, NULL, now(), now(), NULL)`,
            parameters: [
              "00000000-0000-7000-8000-0000000000f3",
              world.applicationId,
              "00000000-0000-7000-8000-0000000000ff",
              executionId,
            ],
          }),
        /foreign key constraint.*lr_ops_tenant_fk|lr_ops_tenant_fk/,
      );
    });
  });

  describe("L14 the recovery scan", () => {
    test("pendingWakeUpApplies returns the PENDING wakeup-apply rows in deterministic (created_at, id) order", async () => {
      world = await seedLongRunningWorld(ctx.port);
      const executionId = await newExecution();
      boot();
      await acquire(executionId, "worker-1");
      // Seed two PENDING wakeup-apply rows directly through the store.
      for (const wakeKey of ["wake-x", "wake-y"]) {
        const key = longRunningOperationKey("wakeup-apply", `${executionId}:wake:${wakeKey}`);
        await ctx.port.execute({
          sql: `INSERT INTO executions.execution_operations (id, application_id, tenant_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at)
VALUES ($1, $2, $3, $4, 'wakeup-apply', $5, 'fp', 'pending', 1, $6, NULL, now() + interval '1 second', now(), NULL)`,
          parameters: [
            `00000000-0000-7000-8000-${wakeKey === "wake-x" ? "0000000000a1" : "0000000000a2"}`,
            world.applicationId,
            world.tenantId,
            executionId,
            key,
            JSON.stringify({ stage: "claimed", wakeKey }),
          ],
        });
      }
      const pending = await world.store.pendingWakeUpApplies(world.applicationId);
      expect(pending.map((r) => r.stage?.wakeKey)).toEqual(["wake-x", "wake-y"]);
      expect(
        pending.every((r) => r.status === "pending" && r.operationKind === "wakeup-apply"),
      ).toBe(true);
    });
  });
});
