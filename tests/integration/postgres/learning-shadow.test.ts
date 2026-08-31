/**
 * Real-PostgreSQL shadow-evaluation proofs (WORK-014; M7/M8/M15).
 *
 * Required-test mapping:
 *  - shadow records persist immutably (class 'shadow', versioned basis,
 *    traceability evidence refs + source executions);
 *  - evaluation against the LATEST durable scorecard version;
 *  - honest statuses over durable state (insufficient-evidence,
 *    no-baseline);
 *  - M7: ZERO execution/policy side effects — the execution ledger of
 *    the world's executions is UNCHANGED by any shadow evaluation (the
 *    full runtime zero-side-effect proof over the instrumented world
 *    lives in the discrimination suite);
 *  - M12: shadow records are tenant-scoped on read.
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { seedLearningWorld, telemetryFor } from "./learning-world";

definePgSuite("learning shadow evaluation (real PostgreSQL)", (ctx) => {
  test("scores a proposed strategy against the latest durable scorecard version", async () => {
    const world = await seedLearningWorld(ctx.port);
    for (let index = 0; index < 8; index += 1) {
      const executionId = await world.seedTerminalExecution(index < 6 ? "COMPLETED" : "FAILED");
      await world.learning.recordExecutionTelemetry(
        telemetryFor(world, executionId, index < 6 ? "COMPLETED" : "FAILED", {
          route: { provider: "rail-a", model: "model-x" },
        }),
      );
    }
    await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    const record = await world.shadow.evaluateShadowStrategy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      proposed: {
        strategyIdentity: "switch-to-a",
        taskClass: "summarize",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });

    expect(record.status).toBe("scored");
    expect(record.recordClass).toBe("shadow");
    expect(record.proposedScores[0]?.population).toBe(8);
    expect(record.proposedScores[0]?.successCount).toBe(6);
    expect(record.evaluationBasis.kind).toBe("scorecard");
    if (record.evaluationBasis.kind === "scorecard") {
      expect(record.evaluationBasis.scorecardVersion).toBe(1);
    }
    // M10 traceability on durable rows.
    expect(record.evidenceRefs.length).toBe(8);
    expect(record.sourceExecutionIds.length).toBe(8);

    const persisted = await world.store.listShadowEvaluations({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.shadowId).toBe(record.shadowId);
  });

  test("no scorecard: honest insufficient-evidence with the 'none' basis (durable)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const record = await world.shadow.evaluateShadowStrategy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      proposed: {
        strategyIdentity: "ghost",
        taskClass: "summarize",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    expect(record.status).toBe("insufficient-evidence");
    expect(record.evaluationBasis.kind).toBe("none");
    const persisted = await world.store.listShadowEvaluations({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("insufficient-evidence");
  });

  test("a baseline without evidence: no-baseline (honest, durable)", async () => {
    const world = await seedLearningWorld(ctx.port);
    for (let index = 0; index < 6; index += 1) {
      const executionId = await world.seedTerminalExecution("COMPLETED");
      await world.learning.recordExecutionTelemetry(
        telemetryFor(world, executionId, "COMPLETED", {
          route: { provider: "rail-a", model: "model-x" },
        }),
      );
    }
    await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    const record = await world.shadow.evaluateShadowStrategy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      proposed: {
        strategyIdentity: "stay-on-a",
        taskClass: "summarize",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      baseline: {
        strategyIdentity: "ghost-baseline",
        taskClass: "summarize",
        routeSubjects: ["rail-z/model-9"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    expect(record.status).toBe("no-baseline");
    expect(record.comparison).toBeUndefined();
  });

  test("M7: shadow evaluation leaves the execution ledger UNCHANGED", async () => {
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("COMPLETED");
    await world.learning.recordExecutionTelemetry(telemetryFor(world, executionId, "COMPLETED"));
    for (let index = 0; index < 5; index += 1) {
      const other = await world.seedTerminalExecution("COMPLETED");
      await world.learning.recordExecutionTelemetry(telemetryFor(world, other, "COMPLETED"));
    }
    await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    const eventsBefore = await world.executionService.listEvents(world.applicationId, executionId);
    const executionBefore = await world.executionService.getExecution(
      world.applicationId,
      executionId,
    );

    await world.shadow.evaluateShadowStrategy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      proposed: {
        strategyIdentity: "expensive-proposal",
        taskClass: "summarize",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });

    const eventsAfter = await world.executionService.listEvents(world.applicationId, executionId);
    const executionAfter = await world.executionService.getExecution(
      world.applicationId,
      executionId,
    );
    expect(eventsAfter.length).toBe(eventsBefore.length);
    expect(executionAfter?.status).toBe(executionBefore?.status);
    expect(executionAfter?.lastEventSequence).toBe(executionBefore?.lastEventSequence);
  });

  test("M12: shadow records are tenant-scoped on read", async () => {
    const worldA = await seedLearningWorld(ctx.port);
    const worldB = await seedLearningWorld(ctx.port);
    await worldA.shadow.evaluateShadowStrategy({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
      proposed: {
        strategyIdentity: "x",
        taskClass: "summarize",
        routeSubjects: [],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    const listedA = await worldA.store.listShadowEvaluations({
      applicationId: worldA.applicationId,
      tenantId: worldA.tenantId,
    });
    const listedB = await worldB.store.listShadowEvaluations({
      applicationId: worldA.applicationId,
      tenantId: worldB.tenantId,
    });
    expect(listedA).toHaveLength(1);
    expect(listedB).toEqual([]);
  });
});
