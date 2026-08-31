/**
 * Real-PostgreSQL tool-composition proofs (WORK-017; recommendation
 * identity, source-execution binding, provenance, evaluation window,
 * duplicate/concurrent generation, activation, rollback, immutable
 * historical evidence, tenant/application scope).
 *
 * Required-test mapping (the Work Order's real-PostgreSQL axis):
 *  - recommendation-set identity + version arbitration: UNIQUE
 *    (application, set_version); concurrent builds converge on ONE
 *    durable winner; same-basis retries CONVERGE (§22);
 *  - provenance: every recommendation is bound to REAL terminal
 *    executions (seeded through the real executions single write
 *    path) with non-empty evidence refs (M11);
 *  - evaluation window + population + version anchors recorded on the
 *    durable row (M12/M13/M14);
 *  - activation: the journal append; the LATEST entry is the single
 *    active pointer; duplicate activations converge (§22);
 *  - rollback: activates the PRIOR set — the historical rows are
 *    byte-identical (M15) and PHYSICALLY immutable (the triggers);
 *  - tenant/application scope: cross-scope reads return nothing
 *    (M25);
 *  - physical immutability: UPDATE/DELETE on sets and the journal are
 *    rejected by the migration triggers;
 *  - the migration applies on fresh databases as version 0010 (the
 *    collision rule).
 */

import { expect, test } from "vitest";
import {
  createCompositionAdvisor,
  createNodeDigest,
  SqlCompositionStore,
  type ToolFact,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import { generateId, seedLearningWorld, telemetryFor } from "./learning-world";

const FACTS: readonly ToolFact[] = [
  {
    toolId: "fetch",
    version: "1.0.0",
    capabilityIds: ["web-retrieval"],
    inputFields: [],
    outputFields: [],
  },
  {
    toolId: "parse",
    version: "2.1.0",
    capabilityIds: ["parsing"],
    inputFields: [],
    outputFields: [],
  },
];

definePgSuite("learning compositions (real PostgreSQL)", (ctx) => {
  async function seedToolPopulation(
    world: Awaited<ReturnType<typeof seedLearningWorld>>,
    count: number,
    final: "COMPLETED" | "FAILED" = "COMPLETED",
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const executionId = await world.seedTerminalExecution(final);
      await world.learning.recordExecutionTelemetry(
        telemetryFor(world, executionId, final, { tools: ["fetch", "parse"] }),
      );
    }
  }

  test("migration 0010 applies on fresh databases (the inventory rule)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const exists = await world.db.execute<{ readonly exists: boolean }>({
      sql: `SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'learning'
                AND table_name IN ('composition_recommendation_sets', 'composition_activation_log')
            ) AS exists`,
      parameters: [],
    });
    expect(exists.rows[0]?.exists).toBe(true);
  });

  test("generation persists a durable versioned set with full provenance (M11/M12/M26)", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const compositionStore = new SqlCompositionStore(ctx.port);
    const advisor = createCompositionAdvisor({
      store: compositionStore,
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const outcome = await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    expect(outcome.set.setVersion).toBe(1);
    expect(outcome.replayed).toBe(false);

    // The durable row exists with the exact digest + window.
    const row = await ctx.port.execute<{
      readonly digest: string;
      readonly evaluation_window_from: Date;
      readonly evaluation_window_to: Date;
      readonly total_population: number;
      readonly recommendations: readonly unknown[];
    }>({
      sql: `SELECT digest, evaluation_window_from, evaluation_window_to, total_population,
                   recommendations
            FROM learning.composition_recommendation_sets
            WHERE id = $1`,
      parameters: [outcome.set.setId],
    });
    expect(row.rows[0]?.digest).toBe(outcome.set.digest);
    expect(String(row.rows[0]?.total_population)).toBe("7");
    expect(row.rows[0]?.recommendations).toHaveLength(1);

    const recommendation = outcome.set.recommendations[0];
    expect(recommendation?.sourceExecutionIds).toHaveLength(7);
    expect(recommendation?.evidenceRefs.length).toBeGreaterThanOrEqual(7);
    expect(recommendation?.toolVersions).toEqual([
      { toolId: "fetch", version: "1.0.0" },
      { toolId: "parse", version: "2.1.0" },
    ]);
    expect(recommendation?.evaluationWindowFrom).toBeTruthy();
    expect(recommendation?.evaluationWindowTo).toBeTruthy();

    // The source executions are REAL rows bound through the telemetry
    // FK (M10-class physical binding inherited from 0009).
    const executionCheck = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM executions.executions
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(executionCheck.rows[0]?.count)).toBe("7");
  });

  test("same-basis retries converge; concurrent builds converge through version arbitration (§22)", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const store = new SqlCompositionStore(ctx.port);
    const makeAdvisor = () =>
      createCompositionAdvisor({
        store,
        digest: createNodeDigest(),
        generateId,
        now: () => new Date("2026-09-15T14:00:00Z"),
      });
    const first = await makeAdvisor().generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    // Same basis ⇒ replay.
    const retry = await makeAdvisor().generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    expect(retry.replayed).toBe(true);
    expect(retry.set.setId).toBe(first.set.setId);

    // CONCURRENT generation (new evidence first so the fingerprints
    // diverge from the replay path): two advisors racing for version 2.
    await seedToolPopulation(world, 1);
    const left = makeAdvisor();
    const right = makeAdvisor();
    const [leftOutcome, rightOutcome] = await Promise.all([
      left.generateRecommendationSet({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        toolFacts: [...FACTS],
      }),
      right.generateRecommendationSet({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        toolFacts: [...FACTS],
      }),
    ]);
    // Exactly one landed version 2; both callers hold a durable set.
    expect(leftOutcome.set.setVersion).toBe(2);
    expect(rightOutcome.set.setVersion).toBe(2);
    const versions = await ctx.port.execute<{ readonly set_version: string }>({
      sql: `SELECT set_version::text AS set_version FROM learning.composition_recommendation_sets
            WHERE application_id = $1 ORDER BY set_version`,
      parameters: [world.applicationId],
    });
    expect(versions.rows.map((row) => row.set_version)).toEqual(["1", "2"]);
  });

  test("activation + rollback: the journal is append-only and history is byte-identical (M15/§21/§22)", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const store = new SqlCompositionStore(ctx.port);
    const advisor = createCompositionAdvisor({
      store,
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const first = await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    await seedToolPopulation(world, 1);
    const second = await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });

    // No activation ⇒ consult is empty.
    expect(
      await advisor.consultRecommendations({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      }),
    ).toHaveLength(0);

    // Activate v2; duplicate activation converges.
    await advisor.activateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      setId: second.set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    await advisor.activateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      setId: second.set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    const active = await advisor.consultRecommendations({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(active[0]?.setVersion).toBe(2);
    expect(active[0]?.setId).toBe(second.set.setId);

    // ROLLBACK to v1 — history stays byte-identical.
    await advisor.rollbackRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toSetId: first.set.setId,
      activatedBy: "operator-1",
    });
    const afterRollback = await advisor.consultRecommendations({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(afterRollback[0]?.setVersion).toBe(1);
    expect(
      await store.getRecommendationSet(
        { applicationId: world.applicationId, tenantId: world.tenantId },
        second.set.setId,
      ),
    ).toEqual(second.set);

    // The journal: exactly two entries (initial + rollback — the
    // duplicate activation converged).
    const journal = await ctx.port.execute<{ readonly reason: string }>({
      sql: `SELECT reason FROM learning.composition_activation_log
            WHERE application_id = $1 ORDER BY activation_seq`,
      parameters: [world.applicationId],
    });
    expect(journal.rows.map((row) => row.reason)).toEqual(["initial", "rollback"]);
  });

  test("physical immutability: UPDATE and DELETE are rejected by the triggers", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const advisor = createCompositionAdvisor({
      store: new SqlCompositionStore(ctx.port),
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const { set } = await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    await advisor.activateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.composition_recommendation_sets SET total_population = 999 WHERE id = $1`,
        parameters: [set.setId],
      }),
    ).rejects.toThrow();
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.composition_recommendation_sets WHERE id = $1`,
        parameters: [set.setId],
      }),
    ).rejects.toThrow();
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.composition_activation_log WHERE application_id = $1`,
        parameters: [world.applicationId],
      }),
    ).rejects.toThrow();
  });

  test("tenant/application scope: cross-scope reads return nothing (M25)", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const advisor = createCompositionAdvisor({
      store: new SqlCompositionStore(ctx.port),
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const { set } = await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });
    await advisor.activateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    // A foreign application's advisor consults: nothing.
    expect(
      await advisor.consultRecommendations({
        applicationId: "00000000-0000-7000-8000-0000000000ee",
        tenantId: world.tenantId,
      }),
    ).toHaveLength(0);
    // Activation of a foreign set fails closed.
    await expect(
      advisor.activateRecommendationSet({
        applicationId: "00000000-0000-7000-8000-0000000000ee",
        tenantId: world.tenantId,
        setId: set.setId,
        activatedBy: "operator-1",
        reason: "initial",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("M14: composition generation leaves historical scorecards byte-identical", async () => {
    const world = await seedLearningWorld(ctx.port);
    await seedToolPopulation(world, 7);
    const scorecard = await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "tool-outcome-by-task-class",
    });
    const before = await ctx.port.execute<{ readonly digest: string }>({
      sql: `SELECT digest FROM learning.scorecards WHERE id = $1`,
      parameters: [scorecard.scorecardId],
    });

    const advisor = createCompositionAdvisor({
      store: new SqlCompositionStore(ctx.port),
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    await advisor.generateRecommendationSet({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolFacts: [...FACTS],
    });

    const after = await ctx.port.execute<{ readonly digest: string }>({
      sql: `SELECT digest FROM learning.scorecards WHERE id = $1`,
      parameters: [scorecard.scorecardId],
    });
    expect(after.rows[0]?.digest).toBe(before.rows[0]?.digest);
  });
});
