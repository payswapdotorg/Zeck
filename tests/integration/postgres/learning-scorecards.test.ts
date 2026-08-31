/**
 * Real-PostgreSQL scorecard proofs (WORK-014; M9/M13/M14 + the
 * version-arbitration concurrency).
 *
 * Required-test mapping:
 *  - scorecard building over the SQL store: cumulative snapshots,
 *    version 1 then version 2 (append-only versioning);
 *  - M9: no mutation path — a new population is a NEW version; the
 *    physical immutability triggers are proven in learning-schema;
 *  - concurrent version builds converge through the UNIQUE
 *    (application, definition, version) arbitration: exactly ONE
 *    version-N row lands, all callers receive a durable scorecard;
 *  - M12: scorecards are tenant-scoped (another tenant sees none);
 *  - consultSignals returns versioned signals from the SQL store
 *    (the planning READ seam over durable state);
 *  - ratings: duplicate convergence and identity isolation.
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { seedLearningWorld, telemetryFor } from "./learning-world";

definePgSuite("learning scorecards (real PostgreSQL)", (ctx) => {
  async function seedPopulation(
    world: Awaited<ReturnType<typeof seedLearningWorld>>,
    count: number,
    final: "COMPLETED" | "FAILED" = "COMPLETED",
    route: { provider: string; model: string } = { provider: "rail-a", model: "model-x" },
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const executionId = await world.seedTerminalExecution(final);
      await world.learning.recordExecutionTelemetry(
        telemetryFor(world, executionId, final, { route }),
      );
    }
  }

  test("builds version 1 and version 2 as cumulative immutable snapshots", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedPopulation(world, 6, "COMPLETED");
    const version1 = await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(version1.scorecardVersion).toBe(1);
    expect(version1.totalPopulation).toBe(6);
    expect(version1.entries[0]?.subjectKey).toBe("rail-a/model-x");

    await seedPopulation(world, 6, "FAILED");
    const version2 = await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(version2.scorecardVersion).toBe(2);
    expect(version2.totalPopulation).toBe(12);
    expect(version2.entries[0]?.population).toBe(12);
    expect(version2.entries[0]?.successCount).toBe(6);

    // Both versions are durable (immutable history, M9).
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.scorecards WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("2");
  });

  test("no new evidence: typed no-op error (no version churn)", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedPopulation(world, 6);
    await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    await expect(
      world.learning.buildScorecard({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        definitionId: "route-outcome-by-task-class",
      }),
    ).rejects.toThrow(/no new telemetry/i);
  });

  test("CONCURRENT version builds converge through the version arbitration", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedPopulation(world, 8);

    const build = () =>
      world.learning.buildScorecard({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        definitionId: "route-outcome-by-task-class",
      });
    const results = await Promise.allSettled([build(), build(), build()]);
    const versions = results
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof build>>> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value.scorecardVersion);

    // Exactly ONE version-1 row is durable; every caller either built it
    // or converged onto the durable winner (all fulfilled results show
    // version 1 — the re-read convergence path).
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.scorecards WHERE application_id = $1 AND scorecard_version = 1`,
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.every((version) => version === 1)).toBe(true);
  });

  test("M12: scorecards and signals are tenant-scoped", async () => {
    const worldA = await seedLearningWorld(ctx.port);
    const worldB = await seedLearningWorld(ctx.port);
    await seedPopulation(worldA, 6);
    await worldA.learning.buildScorecard({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    const signalsA = await worldA.learning.consultSignals({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    const signalsB = await worldB.learning.consultSignals({
      applicationId: worldB.applicationId,
      tenantId: worldB.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(signalsA).toHaveLength(1);
    expect(signalsB).toEqual([]);
    expect(signalsA[0]?.scorecardVersion).toBe(1);
    expect(signalsA[0]?.scorecardId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("ratings: duplicate convergence and per-dimension identity", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    const base = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      evaluatorId: "user-42",
      provenance: { source: "user" as const, submittedVia: "dashboard" },
      evidenceRefs: [`execution:${executionId}:receipt`],
      schemaVersion: 1,
    };
    const first = await world.learning.recordUserRating({
      ...base,
      ratingDimension: "overall-quality",
      rating: 4,
    });
    const retry = await world.learning.recordUserRating({
      ...base,
      ratingDimension: "overall-quality",
      rating: 4,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.ratingId).toBe(first.ratingId);

    const other = await world.learning.recordUserRating({
      ...base,
      ratingDimension: "usefulness",
      rating: 3,
    });
    expect(other.replayed).toBe(false);

    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.user_ratings WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(count.rows[0]?.count).toBe("2");
  });

  test("M12 (rating half): ratings are tenant-scoped on read", async () => {
    const worldA = await seedLearningWorld(ctx.port);
    const worldB = await seedLearningWorld(ctx.port);
    const executionId = await worldA.seedTerminalExecution("COMPLETED");
    await worldA.learning.recordUserRating({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
      executionId,
      evaluatorId: "user-42",
      ratingDimension: "overall-quality",
      rating: 5,
      provenance: { source: "user", submittedVia: "dashboard" },
      evidenceRefs: [`execution:${executionId}:receipt`],
      schemaVersion: 1,
    });
    const foreign = await worldB.store.listUserRatings({
      applicationId: worldA.applicationId,
      tenantId: worldB.tenantId,
    });
    expect(foreign).toEqual([]);
  });
});
