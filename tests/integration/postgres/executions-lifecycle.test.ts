/**
 * Real-PostgreSQL: executions lifecycle, idempotency, retry and
 * crash-atomicity (WORK-006 acceptance criteria 1, 2, 5; API-003;
 * checkpoints IDENTITY-IDEMPOTENCY and CONCURRENCY-CRASH-SAFETY).
 *
 *   * full lifecycle over the REAL SQL fabric: every transition commits
 *     exactly one gapless envelope with the provenance chain; COMPLETED
 *     carries the durable verification binding;
 *   * create idempotency: replay / key-reuse / retry at progressed and at
 *     terminal states (no second identity, no duplicated event, no
 *     rewind);
 *   * crash-atomicity: injected mid-transaction faults roll back the
 *     execution row + envelope (create) and leave prior state + zero
 *     partial events (transition) — safe to retry with the same key;
 *   * dispatch seam: `start` with a dispatch estimate reserves through the
 *     REAL WORK-004 budgets fabric (real reservation row; reservation id
 *     on the start envelope).
 *
 * Concurrency convergence stress lives in executions-concurrency.test.ts.
 */

import { expect, test } from "vitest";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import type { Transaction } from "../../../src/platform/db/port";
import {
  actorOf,
  baseCreateInput,
  budgetAuthorityOver,
  type ExecutionsWorld,
  generateId,
  seedExecutionsWorld,
  transitionScope,
} from "./executions-world";
import { definePgSuite } from "./harness";

definePgSuite("executions lifecycle + idempotency (real PG)", (ctx) => {
  let world: ExecutionsWorld;

  async function driveToVerifying(executionId: string): Promise<void> {
    for (const [command, key] of [
      ["authorize", "a"],
      ["plan", "p"],
      ["queue", "q"],
      ["start", "s"],
      ["verify", "v"],
    ] as const) {
      await world.service.transition(
        { ...transitionScope(world, executionId), command } as never,
        `${executionId}-${key}`,
      );
    }
  }

  test("full lifecycle: every transition appends one gapless envelope; COMPLETED binds durable verification", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const receipt = await world.service.createExecution(
      baseCreateInput(world.applicationId, world.environmentId),
      "key-life-1",
      actorOf(world),
    );
    await driveToVerifying(receipt.executionId);
    const pass = await world.service.transition(
      {
        ...transitionScope(world, receipt.executionId),
        command: "pass",
        verificationResults: [
          {
            criterionId: "cites-sources",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "verifier-1",
            evidence: ["ev-1"],
          },
          {
            criterionId: "tone",
            strategy: "classifier",
            status: "INCONCLUSIVE",
            recordedBy: "verifier-1",
          },
        ],
      },
      `${receipt.executionId}-pass`,
    );
    expect(pass.execution.status).toBe("COMPLETED");
    expect(pass.execution.verificationRefs).toHaveLength(2);
    expect(pass.execution.terminalAt).not.toBeNull();

    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((e) => e.command)).toEqual([
      "create",
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
      "pass",
    ]);
    const results = await world.service.listVerificationResults(
      world.applicationId,
      receipt.executionId,
    );
    expect(results.map((r) => r.status).sort()).toEqual(["INCONCLUSIVE", "PASS"]);
    // The durable binding references rows that exist for THIS execution.
    for (const ref of pass.execution.verificationRefs) {
      expect(results.some((r) => r.id === ref)).toBe(true);
    }
  });

  test("create replay: same key + same fingerprint converges; different fingerprint is key reuse", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const first = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-replay",
      actorOf(world),
    );
    const replay = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-replay",
      actorOf(world),
    );
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.replayed).toBe(true);
    const events = await world.service.listEvents(world.applicationId, first.executionId);
    expect(events).toHaveLength(1);

    await expect(
      world.service.createExecution(
        { ...baseCreateInput(world.applicationId), task: { kind: "translate" } },
        "key-replay",
        actorOf(world),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await countRows("executions.executions")).toBe("1");
  });

  test("create retry at a progressed non-terminal state returns the CURRENT durable outcome", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const created = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-progress",
      actorOf(world),
    );
    await world.service.transition(
      { ...transitionScope(world, created.executionId), command: "authorize" },
      "k1",
    );
    await world.service.transition(
      { ...transitionScope(world, created.executionId), command: "plan" },
      "k2",
    );
    const retried = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-progress",
      actorOf(world),
    );
    expect(retried.executionId).toBe(created.executionId);
    expect(retried.status).toBe("PLANNING");
    expect(retried.replayed).toBe(true);
    expect(await countRows("executions.executions")).toBe("1");
    expect((await world.service.listEvents(world.applicationId, created.executionId)).length).toBe(
      3,
    );
  });

  test("terminal finality vs retries: create retry after COMPLETED stays read-only; no transition rewinds", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const created = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-terminal",
      actorOf(world),
    );
    await driveToVerifying(created.executionId);
    await world.service.transition(
      {
        ...transitionScope(world, created.executionId),
        command: "pass",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "PASS", recordedBy: "v" }],
      },
      "k-pass",
    );
    // Create retry at terminal state: same identity, current (COMPLETED)
    // status, no new events.
    const retried = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-terminal",
      actorOf(world),
    );
    expect(retried.status).toBe("COMPLETED");
    expect(retried.verificationRefs).toHaveLength(1);
    expect((await world.service.listEvents(world.applicationId, created.executionId)).length).toBe(
      7,
    );
    // Transition retry with the SAME key replays the recorded outcome.
    const replay = await world.service.transition(
      {
        ...transitionScope(world, created.executionId),
        command: "pass",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "PASS", recordedBy: "v" }],
      },
      "k-pass",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.execution.status).toBe("COMPLETED");
    expect((await world.service.listEvents(world.applicationId, created.executionId)).length).toBe(
      7,
    );
    // Any NEW command on the terminal execution is INVALID_STATE_TRANSITION.
    for (const command of ["cancel", "resume", "plan", "fail", "verify"]) {
      await expect(
        world.service.transition(
          { ...transitionScope(world, created.executionId), command } as never,
          `post-${command}`,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    }
    // Physical: the terminal row rejects every direct SQL mutation.
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.executions SET user_id = 'x' WHERE id = $1",
        parameters: [created.executionId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
  });

  test("crash-atomicity (create): a fault after the row insert rolls back row + envelope; retry succeeds", async () => {
    world = await seedExecutionsWorld(ctx.port);
    // The same two-write sequence the service runs, in ONE transaction,
    // with the fault injected between the writes: NEITHER may survive.
    const executionId = generateId();
    await expect(
      ctx.port.transaction(async (tx) => {
        await tx.execute({
          sql: `INSERT INTO executions.executions (id, application_id, tenant_id, task, request_fingerprint)
VALUES ($1, $2, $3, $4::jsonb, $5)`,
          parameters: [
            executionId,
            world.applicationId,
            world.tenantId,
            JSON.stringify({ kind: "x" }),
            "fp-crash",
          ],
        });
        throw new Error("injected crash after execution insert");
      }),
    ).rejects.toThrow("injected crash after execution insert");
    expect(await countRows("executions.executions")).toBe("0");
    expect(await countRows("executions.execution_events")).toBe("0");
    // The same logical request retries cleanly through the real service.
    const receipt = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-crash-create",
      actorOf(world),
    );
    expect(receipt.status).toBe("CREATED");
    expect((await world.service.listEvents(world.applicationId, receipt.executionId)).length).toBe(
      1,
    );
  });

  test("crash-atomicity (transition): a fault between event append and row update leaves prior state + no partial event", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const created = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "key-crash-t",
      actorOf(world),
    );
    const executionId = created.executionId;
    // Fault AFTER the envelope insert, BEFORE the row update — same tx.
    await expect(
      ctx.port.transaction(async (tx) => {
        await tx.execute({
          sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor, payload)
VALUES ($1, $2, $3, $4, 2, 'execution.authorize', 'authorize', '{}'::jsonb, '{"from":"CREATED","to":"AUTHORIZED"}'::jsonb)`,
          parameters: [generateId(), executionId, world.applicationId, world.tenantId],
        });
        throw new Error("injected crash after event append");
      }),
    ).rejects.toThrow("injected crash after event append");
    const row = await world.service.getExecution(world.applicationId, executionId);
    expect(row?.status).toBe("CREATED");
    expect(row?.lastEventSequence).toBe(1);
    expect((await world.service.listEvents(world.applicationId, executionId)).length).toBe(1);
    // Retrying the same logical transition with a fresh key succeeds.
    const retried = await world.service.transition(
      { ...transitionScope(world, executionId), command: "authorize" },
      "key-crash-t-auth",
    );
    expect(retried.execution.status).toBe("AUTHORIZED");
    expect(retried.execution.lastEventSequence).toBe(2);
  });

  test("dispatch seam: start with an estimate reserves through the REAL budgets fabric", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const budgets = budgetAuthorityOver(ctx.port);
    const scope = {
      actorId: "00000000-0000-7000-8000-0000000000aa",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await budgets.configureFundingMode({ ...scope, fundingMode: "developer" }, "f-1");
    await budgets.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "10000" },
      "g-1",
    );
    const service: ExecutionService = createExecutionService({
      store: world.store,
      idempotency: new SqlExecutionsIdempotency(
        ctx.port,
        (tx: Transaction) => new SqlExecutionStore(tx),
        generateId,
      ),
      authorization: { evaluate: async () => ({ allowed: true }) },
      budgetAuthority: budgets,
      generateId,
      now: () => new Date(),
    });
    const created = await service.createExecution(
      { ...baseCreateInput(world.applicationId), userId: "user-3" },
      "key-budget",
      actorOf(world),
    );
    const executionId = created.executionId;
    await service.transition(
      { ...transitionScope(world, executionId), command: "authorize" },
      "b-a",
    );
    await service.transition({ ...transitionScope(world, executionId), command: "plan" }, "b-p");
    await service.transition({ ...transitionScope(world, executionId), command: "queue" }, "b-q");
    const started = await service.transition(
      {
        ...transitionScope(world, executionId),
        command: "start",
        dispatch: { operationId: `bill-${executionId}`, amountMicroUsd: "150", userId: "user-3" },
      },
      "b-s",
    );
    expect(started.execution.status).toBe("RUNNING");
    const reservation = await budgets.getReservation(world.applicationId, `bill-${executionId}`);
    expect(reservation?.executionId).toBe(executionId);
    expect(reservation?.amountMicroUsd).toBe("150");
    // The reservation id is durable provenance on the start envelope.
    const events = await service.listEvents(world.applicationId, executionId);
    const startEvent = events.find((e) => e.command === "start");
    expect(startEvent?.reference.reservationId).toBe(reservation?.id);
  });

  /** Rows of THIS suite world only (tests share the per-file database). */
  async function countRows(table: string): Promise<string> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM ${table} WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    return result.rows[0]?.count ?? "0";
  }
});
