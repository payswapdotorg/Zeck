/**
 * Shared real-PostgreSQL fixture for the learning suites (WORK-014).
 *
 * Seeds a tenant + application and wires the FULL learning fabric over
 * the provider-neutral DatabasePort (migration 0009) plus the REAL
 * executions service (SQL store + idempotency): source executions are
 * created and driven to TERMINAL states through the real single write
 * path — every telemetry datum is bound to a REAL execution row (M10).
 *
 * Terminal seeding uses the real state machine:
 *   - COMPLETED: authorize -> plan -> queue -> start -> verify -> pass
 *     (bound to durable verification results — the completion rule);
 *   - CANCELLED: cancel from a non-terminal state;
 *   - FAILED: authorize -> plan -> queue -> start -> fail.
 */

import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import { SqlLearningStore } from "../../../src/modules/learning/adapters/sql-learning-store";
import {
  createLearningService,
  createNodeDigest,
  createShadowEvaluator,
  type ExecutionOutcomeTelemetry,
  type LearningService,
  type RecordTelemetryInput,
  type ShadowEvaluator,
  TELEMETRY_SCHEMA_VERSION,
} from "../../../src/modules/learning/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

export interface LearningPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly learning: LearningService;
  readonly store: SqlLearningStore;
  readonly shadow: ShadowEvaluator;
  actor(): { actorId: string; tenantId: string };
  /** Create an execution and drive it to a REAL terminal state. */
  seedTerminalExecution(final: "COMPLETED" | "CANCELLED" | "FAILED"): Promise<string>;
}

export async function seedLearningWorld(db: DatabasePort): Promise<LearningPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "learning tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "learning app"],
  });

  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });

  let clock = 0;
  const store = new SqlLearningStore(db);
  const learning = createLearningService({
    store,
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(Date.parse("2026-09-15T12:00:00Z") + ++clock * 1000),
  });
  const shadow = createShadowEvaluator({
    store,
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(Date.parse("2026-09-15T14:00:00Z") + ++clock * 1000),
  });

  const actor = () => ({ actorId: ACTOR_ID, tenantId });

  const world: LearningPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    learning,
    store,
    shadow,
    actor,
    async seedTerminalExecution(final) {
      const key = `create-${generateId()}`;
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        key,
        actor(),
      );
      const executionId = receipt.executionId;
      const step = async (command: string, extras: Record<string, unknown> = {}) =>
        executionService.transition(
          {
            command: command as never,
            applicationId,
            tenantId,
            executionId,
            actorId: ACTOR_ID,
            ...extras,
          } as never,
          `${command}-${generateId()}`,
        );
      if (final === "CANCELLED") {
        await step("cancel");
        return executionId;
      }
      await step("authorize");
      await step("plan");
      await step("queue");
      await step("start");
      if (final === "FAILED") {
        await step("fail");
        return executionId;
      }
      await step("verify");
      await step("pass", {
        verificationResults: [
          {
            criterionId: "cites-sources",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "verifier-1",
            evidence: ["ev-1"],
          },
        ],
      });
      return executionId;
    },
  };
  return world;
}

export interface TelemetryOverrides extends Partial<RecordTelemetryInput> {
  readonly route?: { provider: string; model: string };
  readonly succeeded?: boolean;
}

/** Build an honest telemetry input bound to a REAL source execution. */
export function telemetryFor(
  world: LearningPgWorld,
  executionId: string,
  final: "COMPLETED" | "CANCELLED" | "FAILED",
  overrides: TelemetryOverrides = {},
): RecordTelemetryInput {
  const outcome =
    final === "COMPLETED"
      ? "execution-completed"
      : final === "CANCELLED"
        ? "execution-cancelled"
        : "execution-failed";
  const route = overrides.route ?? { provider: "rail-a", model: "model-x" };
  return {
    executionId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    taskClass: "summarize",
    capabilities: ["text-generation"],
    planId: `plan-${executionId.slice(-8)}`,
    planRevision: 1,
    strategyClass: "generative",
    routes: [route],
    tools: [],
    environments: [],
    verification: {
      resultIds: [`ver-${executionId.slice(-8)}`],
      statuses: final === "COMPLETED" ? ["PASS"] : ["FAIL"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: final === "COMPLETED" ? 1 : 0,
      failCount: final === "COMPLETED" ? 0 : 1,
      inconclusiveCount: 0,
      verified: final === "COMPLETED",
    },
    costMicroUsd: "1000",
    latencyMs: 2000,
    outcome,
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [
      {
        subgraphId: `step:${executionId.slice(-8)}:s1`,
        stepPath: ["s1"],
        computationType: "generative",
      },
    ],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ...(({ route: _route, succeeded: _succeeded, ...rest }) => rest)(overrides),
  };
}

export type { ExecutionOutcomeTelemetry };
