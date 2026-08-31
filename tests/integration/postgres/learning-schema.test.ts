import { PlatformError } from "../../../src/shared/errors";
/**
 * Real-PostgreSQL schema proofs for the learning axis (WORK-014;
 * migration `0009_learning.sql`).
 *
 * Physical invariants (the M9/M10/M11/M12/M15/M16 physical halves):
 *  - M10: telemetry FK-binds to a REAL execution; orphaned facts are
 *    rejected by the database itself;
 *  - M11: evidence_refs CHECK non-empty;
 *  - M12: composite application/tenant FK (cross-application telemetry
 *    unrepresentable);
 *  - M9: scorecard rows are IMMUTABLE (update + delete rejected by
 *    trigger); telemetry rows are immutable; rating rows immutable;
 *  - M15: shadow record_class is CHECK-pinned to 'shadow';
 *  - the outcome/status vocabularies are CHECK-bound;
 *  - the rating scale is bounded [1,5];
 *  - UNIQUE (execution_id) — one authoritative observation per source
 *    execution.
 */

import { expect, test } from "vitest";
import { TELEMETRY_SCHEMA_VERSION } from "../../../src/modules/learning/public";
import { definePgSuite } from "./harness";
import { telemetryFor } from "./learning-world";

definePgSuite("learning schema (migration 0009)", (ctx) => {
  test("the learning schema exists with the four tables", async () => {
    const result = await ctx.port.execute<{ table_name: string }>({
      sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'learning' ORDER BY table_name`,
    });
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "execution_telemetry",
      "scorecards",
      "shadow_evaluations",
      "user_ratings",
    ]);
  });

  test("M10: telemetry requires an existing source execution (FK)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const ghost = "00000000-0000-7000-8000-0123456789ab";
    await expect(
      world.learning.recordExecutionTelemetry(telemetryFor(world, ghost, "COMPLETED")),
    ).rejects.toThrow();
  });

  test("M12: cross-application telemetry is unrepresentable (composite FK)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    const wrongApp = "00000000-0000-7000-8000-0123456789cd";
    await expect(
      world.learning.recordExecutionTelemetry({
        ...telemetryFor(world, executionId, "CANCELLED"),
        applicationId: wrongApp,
      }),
    ).rejects.toThrow();
  });

  test("M11: empty evidence refs are rejected by the physical CHECK", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    await expect(
      world.store.ingestTelemetry(
        {
          ...telemetryFor(world, executionId, "CANCELLED"),
          telemetryId: generateLearningId(),
          recordedAt: "2026-09-15T12:00:00Z",
          evidenceRefs: [],
        },
        "fingerprint-1",
      ),
    ).rejects.toThrow(/evidence/i);
  });

  test("the outcome vocabulary is CHECK-bound (learning never invents outcome classes)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    await expect(
      world.store.ingestTelemetry(
        {
          ...telemetryFor(world, executionId, "CANCELLED"),
          telemetryId: generateLearningId(),
          recordedAt: "2026-09-15T12:00:00Z",
          outcome: "verification-passed" as never,
        },
        "fingerprint-1",
      ),
    ).rejects.toThrow(/outcome/i);
  });

  test("M9: telemetry rows are physically immutable (no update, no delete)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    const outcome = await world.learning.recordExecutionTelemetry(
      telemetryFor(world, executionId, "CANCELLED"),
    );
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.execution_telemetry SET cost_micro_usd = 999999 WHERE id = $1`,
        parameters: [outcome.telemetryId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.execution_telemetry WHERE id = $1`,
        parameters: [outcome.telemetryId],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("M9: scorecard rows are physically immutable (no update, no delete)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    for (let index = 0; index < 6; index += 1) {
      const executionId = await world.seedTerminalExecution(index < 5 ? "COMPLETED" : "FAILED");
      await world.learning.recordExecutionTelemetry(
        telemetryFor(world, executionId, index < 5 ? "COMPLETED" : "FAILED"),
      );
    }
    const scorecard = await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(scorecard.scorecardVersion).toBe(1);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.scorecards SET total_population = 999 WHERE id = $1`,
        parameters: [scorecard.scorecardId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.scorecards WHERE id = $1`,
        parameters: [scorecard.scorecardId],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("M15: shadow record_class is CHECK-pinned to 'shadow'", async () => {
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.shadow_evaluations
              (id, application_id, tenant_id, record_class, proposed, evaluation_basis,
               proposed_scores, baseline_scores, status, evidence_refs, source_execution_ids,
               requested_by, recorded_at, schema_version)
              VALUES ($1, $2, $3, 'production', '{}'::jsonb, '{"kind":"none"}'::jsonb,
                      '[]'::jsonb, '[]'::jsonb, 'insufficient-evidence', '[]'::jsonb, '[]'::jsonb,
                      'actor', NOW(), 1)`,
        parameters: [
          "00000000-0000-7000-8000-0123456789ef",
          "00000000-0000-7000-8000-012345678900",
          "00000000-0000-7000-8000-012345678901",
        ],
      }),
    ).rejects.toThrow(/record_class|shadow/i);
  });

  test("the shadow status vocabulary and honest 'none' basis are CHECK-bound", async () => {
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.shadow_evaluations
              (id, application_id, tenant_id, record_class, proposed, evaluation_basis,
               proposed_scores, baseline_scores, status, evidence_refs, source_execution_ids,
               requested_by, recorded_at, schema_version)
              VALUES ($1, $2, $3, 'shadow', '{}'::jsonb, '{"kind":"none"}'::jsonb,
                      '[]'::jsonb, '[]'::jsonb, 'scored', '[]'::jsonb, '[]'::jsonb,
                      'actor', NOW(), 1)`,
        parameters: [
          "00000000-0000-7000-8000-0123456789ef",
          "00000000-0000-7000-8000-012345678900",
          "00000000-0000-7000-8000-012345678901",
        ],
      }),
    ).rejects.toThrow(/none|insufficient/i);
  });

  test("M13: a scorecard-basis shadow row must carry the version anchors", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.shadow_evaluations
              (id, application_id, tenant_id, record_class, proposed, evaluation_basis,
               proposed_scores, baseline_scores, status, evidence_refs, source_execution_ids,
               requested_by, recorded_at, schema_version)
              VALUES ($1, $2, $3, 'shadow', '{}'::jsonb, $4::jsonb,
                      '[]'::jsonb, '[]'::jsonb, 'insufficient-evidence', '[]'::jsonb, '[]'::jsonb,
                      'actor', NOW(), 1)`,
        parameters: [
          "00000000-0000-7000-8000-0123456789ef",
          world.applicationId,
          world.tenantId,
          JSON.stringify({
            kind: "scorecard",
            scorecardId: "sc-x",
            scorecardVersion: 0,
            definitionId: "route-outcome-by-task-class",
            definitionVersion: 1,
            telemetrySchemaVersion: 1,
            populationWindowFrom: null,
            populationWindowTo: "2026-09-15T13:00:00Z",
          }),
        ],
      }),
    ).rejects.toThrow(/version/i);
  });

  test("M16: rating rows are physically immutable and the scale is bounded", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    const rating = await world.learning.recordUserRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      evaluatorId: "user-42",
      ratingDimension: "overall-quality",
      rating: 4,
      provenance: { source: "user", submittedVia: "dashboard" },
      evidenceRefs: [`execution:${executionId}:receipt`],
      schemaVersion: 1,
    });
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.user_ratings SET rating = 5 WHERE id = $1`,
        parameters: [rating.ratingId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.user_ratings
              (id, application_id, tenant_id, execution_id, evaluator_id, rating_dimension,
               rating, provenance, evidence_refs, recorded_at, schema_version, fingerprint)
              VALUES ($1, $2, $3, $4, 'u2', 'dim', 9, '{}'::jsonb, '["ev"]'::jsonb, NOW(), 1, 'fp')`,
        parameters: [
          "00000000-0000-7000-8000-0123456789ff",
          world.applicationId,
          world.tenantId,
          executionId,
        ],
      }),
    ).rejects.toThrow(/rating|scale/i);
  });

  test("M10 (rating half): ratings FK-bind to their target execution", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const ghost = "00000000-0000-7000-8000-0123456789ab";
    await expect(
      world.learning.recordUserRating({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId: ghost,
        evaluatorId: "user-42",
        ratingDimension: "overall-quality",
        rating: 4,
        provenance: { source: "user", submittedVia: "dashboard" },
        evidenceRefs: [`execution:${ghost}:receipt`],
        schemaVersion: 1,
      }),
    ).rejects.toThrow();
  });

  test("telemetry ingest validates the closed shape (typed errors, not SQL leaks)", async () => {
    const { seedLearningWorld } = await import("./learning-world");
    const world = await seedLearningWorld(ctx.port);
    const executionId = await world.seedTerminalExecution("CANCELLED");
    const bad = {
      ...telemetryFor(world, executionId, "CANCELLED"),
      latencyMs: -5,
    };
    await expect(world.learning.recordExecutionTelemetry(bad)).rejects.toBeInstanceOf(
      PlatformError,
    );
    void TELEMETRY_SCHEMA_VERSION;
  });
});

let idCounter = 0;
function generateLearningId(): string {
  idCounter += 1;
  return `00000000-0000-7000-a000-${String(idCounter).padStart(12, "0")}`;
}
