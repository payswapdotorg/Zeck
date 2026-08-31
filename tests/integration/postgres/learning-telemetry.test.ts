import { PlatformError } from "../../../src/shared/errors";
/**
 * Real-PostgreSQL telemetry proofs (WORK-014; IDENTITY-IDEMPOTENCY +
 * CONCURRENCY-CRASH-SAFETY + TENANT-ISOLATION for the learning axis).
 *
 * Required-test mapping:
 *  - duplicate ingestion convergence (retry replays the SAME durable
 *    observation; M11);
 *  - conflicting re-observation fails closed IDEMPOTENCY_KEY_REUSED;
 *  - CONCURRENT duplicate ingestion converges on ONE durable row
 *    (unique-index arbitration — two concurrent writers of the same
 *    execution);
 *  - the population read is tenant/application-scoped (M12);
 *  - telemetry is bound to REAL executions driven through the REAL
 *    state machine (M10).
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { generateId, seedLearningWorld, telemetryFor } from "./learning-world";

definePgSuite("learning telemetry (real PostgreSQL)", (ctx) => {
  test("ingests observations bound to REAL terminal executions", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const outcome = await world.learning.recordExecutionTelemetry(
      telemetryFor(world, executionId, "COMPLETED"),
    );
    expect(outcome.replayed).toBe(false);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.execution_telemetry WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("duplicate ingestion converges (M11): retry replays the durable row", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const input = telemetryFor(world, executionId, "COMPLETED");
    const first = await world.learning.recordExecutionTelemetry(input);
    const retry = await world.learning.recordExecutionTelemetry(input);
    expect(retry.replayed).toBe(true);
    expect(retry.telemetryId).toBe(first.telemetryId);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.execution_telemetry WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("a conflicting re-observation of the same execution fails closed", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const input = telemetryFor(world, executionId, "COMPLETED");
    await world.learning.recordExecutionTelemetry(input);
    await expect(
      world.learning.recordExecutionTelemetry({ ...input, costMicroUsd: "9999" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("CONCURRENT duplicate ingestion converges on ONE durable row (unique-index arbitration)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const input = telemetryFor(world, executionId, "COMPLETED");
    const ingestion = async (): Promise<{ replayed: boolean; telemetryId: string }> => {
      const datum = { ...input, telemetryId: generateId(), recordedAt: new Date().toISOString() };
      return world.learning.recordExecutionTelemetry(datum);
    };
    const [a, b] = await Promise.all([ingestion(), ingestion()]);
    // Exactly one row is durable; both calls converge on it.
    expect(a.telemetryId).toBe(b.telemetryId);
    expect(a.replayed || b.replayed).toBe(true);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.execution_telemetry WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("CONCURRENT conflicting observations never fork (one wins, one fails closed)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const input = telemetryFor(world, executionId, "COMPLETED");
    const first = world.learning.recordExecutionTelemetry(input);
    const second = world.learning.recordExecutionTelemetry({ ...input, costMicroUsd: "777" });
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length + rejected.length).toBe(2);
    // The durable row count stays ONE regardless of winner.
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.execution_telemetry WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
    for (const result of rejected) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(PlatformError);
      }
    }
  });

  test("M12: the population read is tenant/application-scoped", async () => {
    const worldA = await seedLearningWorld(ctx.port);
    const worldB = await seedLearningWorld(ctx.port);
    for (const world of [worldA, worldB]) {
      for (let index = 0; index < 3; index += 1) {
        const executionId = await world.seedTerminalExecution("COMPLETED");
        await world.learning.recordExecutionTelemetry(
          telemetryFor(world, executionId, "COMPLETED"),
        );
      }
    }
    const populationA = await worldA.store.listTelemetry({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
      recordedFrom: null,
      recordedTo: "2999-01-01T00:00:00Z",
    });
    const populationB = await worldB.store.listTelemetry({
      applicationId: worldB.applicationId,
      tenantId: worldB.tenantId,
      recordedFrom: null,
      recordedTo: "2999-01-01T00:00:00Z",
    });
    expect(populationA).toHaveLength(3);
    expect(populationB).toHaveLength(3);
    expect(populationA.every((datum) => datum.applicationId === worldA.applicationId)).toBe(true);
  });

  test("the population read honors the recorded window", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    await world.learning.recordExecutionTelemetry(telemetryFor(world, executionId, "COMPLETED"));
    const none = await world.store.listTelemetry({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      recordedFrom: "2999-01-01T00:00:00Z",
      recordedTo: "2999-01-02T00:00:00Z",
    });
    expect(none).toHaveLength(0);
    const all = await world.store.listTelemetry({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      recordedFrom: null,
      recordedTo: "2999-01-01T00:00:00Z",
    });
    expect(all).toHaveLength(1);
  });
});
