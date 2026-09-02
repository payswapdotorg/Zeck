/**
 * Shared real-PostgreSQL fixture for the deterministicization lifecycle
 * suites (WORK-021; migration 0019).
 *
 * Wires the FULL honest substrate over the provider-neutral
 * DatabasePort (migrations 0001..0019):
 *
 *   * the observation population: REAL executions created and driven to
 *     a terminal COMPLETED state through the REAL executions service
 *     (SQL store + idempotency — the single write path), with
 *     execution-outcome telemetry recorded through the REAL learning
 *     service (SqlLearningStore) — every telemetry datum is bound to a
 *     REAL execution row and carries the SAME recurring AI subgraph
 *     (`sg-normalize-entity`, computationType generative) so discovery
 *     (DTR-001) mines it honestly;
 *   * the deterministicization fabric: SqlDeterministicizationStore
 *     (migration 0019) + the REAL deterministicization lifecycle
 *     service;
 *   * the process-restart crash primitive: `boot(point)` re-boots the
 *     service over the SURVIVING PG store with a Proxy-based injector
 *     that arms ONE durable-boundary crash point (a store method,
 *     before/after its durable commit) and kills the process
 *     mid-flight (the WORK-024 pattern — the unit suite
 *     deterministicization-crash-recovery.test.ts proves the behavioral
 *     half; THIS world backs the physical real-PG proofs).
 */

import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import { SqlDeterministicizationStore } from "../../../src/modules/learning/adapters/sql-deterministicization-store";
import { SqlLearningStore } from "../../../src/modules/learning/adapters/sql-learning-store";
import {
  createDeterministicizationService,
  createLearningService,
  createNodeDigest,
  type DeterministicizationService,
  type DiscoveredSubgraph,
  discoveryCorpusBasis,
} from "../../../src/modules/learning/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000da";

/** The recurring AI subgraph every seeded telemetry datum exhibits. */
export const RECURRING_SUBGRAPH_ID = "sg-normalize-entity";
export const RECURRING_SUBGRAPH_STEP_PATH = ["plan", "normalize-entity"];
export const TASK_CLASS = "summarize";

/** The seeded observation population (>= the discovery floor of 5). */
export const TELEMETRY_POPULATION = 24;

export interface DeterministicizationPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly store: SqlDeterministicizationStore;
  /** The REAL executions + learning substrate behind the observations. */
  readonly executionService: ExecutionService;
  /** The source executions the discovery population is bound to. */
  readonly sourceExecutionIds: readonly string[];
  /** The real recorded telemetry count (the honest population). */
  readonly telemetryCount: number;
  /**
   * Boot (or re-boot) the deterministicization lifecycle service over
   * the SURVIVING world — the process-restart primitive for the
   * crash-injection proofs: the PG store persists across a Zeck process
   * death; a `point` arms ONE durable-boundary crash (a store method,
   * before/after its durable commit) that kills the booted process
   * mid-flight.
   */
  readonly boot: (point?: DtrCrashInjectionPoint | null) => {
    readonly service: DeterministicizationService;
    readonly crashed: () => boolean;
  };
  actor(): { actorId: string; tenantId: string };
  /** The honest proposal request (provenance = the real observations). */
  proposalRequest(): Parameters<DeterministicizationService["proposeCandidate"]>[0];
}

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface DtrCrashInjectionPoint {
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap the durable store so the process dies at the planned point
 * (`before` = the durable commit did NOT happen; `after` = the commit
 * DID happen and the process died immediately after). The wrapper
 * records the firing so a vacuous proof (a point the service never
 * reaches) fails its `crashed()` assertion.
 */
function crashableStore(
  store: SqlDeterministicizationStore,
  point: DtrCrashInjectionPoint | null,
): { proxy: SqlDeterministicizationStore; crashed: () => boolean } {
  let fired = false;
  if (point === null) {
    return { proxy: store, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, target);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`store.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

export async function seedDeterministicizationWorld(
  db: DatabasePort,
  telemetryCount = TELEMETRY_POPULATION,
): Promise<DeterministicizationPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "deterministicization tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "dtr app"],
  });

  // The REAL executions + learning substrate (the observation source).
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });
  const learningStore = new SqlLearningStore(db);
  const learning = createLearningService({
    store: learningStore,
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(),
  });

  const actor = () => ({ actorId: ACTOR_ID, tenantId });

  // Seed the observation population: every execution driven to a REAL
  // terminal state, telemetry recorded through the real learning
  // service with the SAME recurring AI subgraph.
  const sourceExecutionIds: string[] = [];
  for (let index = 0; index < telemetryCount; index += 1) {
    const receipt = await executionService.createExecution(
      { applicationId, task: { kind: "summarize", input: "artifact-1" } },
      `dtr-create-${index}`,
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
        `dtr-${command}-${index}`,
      );
    await step("authorize");
    await step("plan");
    await step("queue");
    await step("start");
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
    sourceExecutionIds.push(executionId);
    await learning.recordExecutionTelemetry({
      executionId,
      applicationId,
      tenantId,
      taskClass: TASK_CLASS,
      capabilities: ["text-generation"],
      planId: `plan-${executionId.slice(-8)}`,
      planRevision: 1,
      strategyClass: "generative-route",
      routes: [{ provider: "rail-a", model: "model-x" }],
      tools: [],
      environments: [],
      verification: {
        resultIds: [`ver-${executionId.slice(-8)}`],
        statuses: ["PASS"],
        evaluatorIds: ["deterministic:schema@1"],
        passCount: 1,
        failCount: 0,
        inconclusiveCount: 0,
        verified: true,
      },
      costMicroUsd: "200",
      latencyMs: 150,
      outcome: "execution-completed",
      evidenceRefs: [`execution:${executionId}:receipt`],
      subgraphs: [
        {
          subgraphId: RECURRING_SUBGRAPH_ID,
          stepPath: [...RECURRING_SUBGRAPH_STEP_PATH],
          computationType: "generative",
        },
      ],
      schemaVersion: 1,
    });
  }

  const store = new SqlDeterministicizationStore(db);
  const newId = createUuidv7Generator();
  const now = () => new Date();
  const boot = (point: DtrCrashInjectionPoint | null = null) => {
    const process = crashableStore(store, point);
    const service = createDeterministicizationService({
      store: process.proxy,
      digest: createNodeDigest(),
      generateId: newId,
      now,
    });
    return { service, crashed: process.crashed };
  };

  const world: DeterministicizationPgWorld = {
    db,
    tenantId,
    applicationId,
    store,
    executionService,
    sourceExecutionIds,
    telemetryCount,
    actor,
    boot,
    proposalRequest() {
      return {
        applicationId,
        tenantId,
        candidateClass: "deterministic-replacement" as const,
        subgraph: {
          subgraphId: RECURRING_SUBGRAPH_ID,
          stepPath: [...RECURRING_SUBGRAPH_STEP_PATH],
          computationType: "generative",
          taskClass: TASK_CLASS,
          routes: [{ provider: "rail-a", model: "model-x" }],
          tools: [],
        },
        provenance: {
          sourceExecutionIds: [...sourceExecutionIds],
          evidenceRefs: sourceExecutionIds.map((id) => `execution:${id}:receipt`),
          corpusDigest: "b".repeat(64),
          windowFrom: "2026-09-10T12:00:00Z",
          windowTo: "2030-09-20T12:00:00Z",
          population: telemetryCount,
        },
        recurrence: {
          occurrenceCount: telemetryCount,
          totalCostMicroUsd: String(telemetryCount * 200),
          errorRate: 0,
        },
        incumbent: {
          strategyClass: "generative-route",
          routes: [{ provider: "rail-a", model: "model-x" }],
          descriptionDigest: "c".repeat(64),
          rollbackTarget: "incumbent:generative-route@v1",
        },
        contract: {
          inputFields: [{ name: "value", type: "number" as const, required: true }],
          outputFields: [{ name: "doubled", type: "number" as const, required: true }],
          acceptanceCriterion: {
            kind: "exact-output" as const,
            description:
              "the replacement must reproduce the incumbent output exactly on the corpus",
          },
          compute: {
            pureComputeOnly: true as const,
            networkEgress: "none" as const,
            allowedHosts: [] as readonly string[],
            timeoutMs: 5000,
          },
        },
        program: {
          language: "javascript-v1" as const,
          source: "console.log(JSON.stringify({ doubled: INPUT.value * 2 }));",
          sourceDigest: "d".repeat(64),
        },
        proposedBy: "agent-1",
      };
    },
  };
  return world;
}

// ---------------------------------------------------------------------------
// The honest lifecycle driver (shared by both PG suites).
// ---------------------------------------------------------------------------

export function stageRuns(
  count: number,
  outcome: "success" | "failure" = "success",
  stage:
    | "offline-replay"
    | "differential-evaluation"
    | "property-tests"
    | "mutation-tests" = "offline-replay",
) {
  return Array.from({ length: count }, (_, index) => ({
    runKey: `${stage}-run-${index}`,
    sandboxExecutionId: `sbx-${stage}-${index}`,
    inputDigest: `${index}`.padStart(64, "0"),
    outputDigest: "e".repeat(64),
    outcome,
    failureClass: outcome === "failure" ? "assertion-mismatch" : null,
    costMicroUsd: "10",
    latencyMs: 12,
  }));
}

export function differentialPairs(count: number, accepted = true) {
  return Array.from({ length: count }, (_, index) => ({
    inputDigest: `${index}`.padStart(64, "0"),
    incumbentOutputDigest: "4".repeat(64),
    replacementOutputDigest: "5".repeat(64),
    accepted,
  }));
}

/**
 * Drive a candidate through the honest lifecycle (no crash injection):
 * proposal → the four offline validation stages → (validated) →
 * shadow rollout → canary phase → (canary) → promotion.
 */
export async function driveTo(
  service: DeterministicizationService,
  world: DeterministicizationPgWorld,
  to: "validated" | "canary" | "promoted",
): Promise<string> {
  const { candidate } = await service.proposeCandidate(world.proposalRequest());
  const candidateId = candidate.candidateId;
  const stages: Array<
    "offline-replay" | "differential-evaluation" | "property-tests" | "mutation-tests"
  > = ["offline-replay", "differential-evaluation", "property-tests", "mutation-tests"];
  for (const stage of stages) {
    await service.recordStageEvidence({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      stageKind: stage,
      runs:
        stage === "mutation-tests"
          ? stageRuns(24, "failure", stage)
          : stageRuns(24, "success", stage),
      ...(stage === "differential-evaluation"
        ? { pairs: differentialPairs(24), incumbentCostMicroUsd: String(24 * 200) }
        : {}),
      recordedBy: "validator-1",
    });
  }
  if (to === "validated") {
    return candidateId;
  }
  await service.beginShadowRollout({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeShadowRollout({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    mode: "shadow",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2200",
    qualityDelta: 1,
    latencyDeltaMs: -140,
    evidenceRefs: ["ev-shadow"],
    requestedBy: "operator-1",
  });
  await service.beginCanaryPhase({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeCanaryPhase({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    mode: "canary",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2100",
    qualityDelta: 1,
    latencyDeltaMs: -130,
    evidenceRefs: ["ev-canary"],
    requestedBy: "operator-1",
  });
  if (to === "canary") {
    return candidateId;
  }
  await service.applyPromotion({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    decidedBy: "architect-1",
  });
  return candidateId;
}

/** The content-derived corpus basis of the discovered subgraph (digest input). */
export function corpusBasisOf(discovered: DiscoveredSubgraph): Record<string, unknown> {
  return discoveryCorpusBasis({
    subgraphId: discovered.subgraphId,
    taskClass: discovered.taskClass,
    computationType: discovered.computationType,
    sourceExecutionIds: [...discovered.sourceExecutionIds],
    evidenceRefs: [...discovered.evidenceRefs],
    windowFrom: discovered.windowFrom,
    windowTo: discovered.windowTo,
  });
}
