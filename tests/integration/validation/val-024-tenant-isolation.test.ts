/**
 * VAL-024 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * tenant-isolation application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port — TWO
 *     tenants, TWO applications, real membership rows, two bearer
 *     credentials;
 *   - the REAL PostgreSQL row-scoping (every store query bound by
 *     application + tenant): the app-scoped execution getter, the
 *     locked-row transition/planning checks, the application-scoped
 *     event ledger, the environment-ownership check at create, the
 *     scope resolver's membership boundary — the system under test;
 *   - the REAL artifacts service (the platform's tenant-namespaced
 *     artifact substrate) with the foreign tenant's canary artifact
 *     planted in its namespace;
 *   - the app-side probes ride the public SDK boundary over the REAL
 *     served API (create confusion, foreign-environment create,
 *     foreign reads/cancel/events, the forged scope selector, the
 *     own-tenant control);
 *   - the platform-side probes drive the REAL executions service /
 *     artifacts service / scope resolver directly (the operator-side
 *     surface), each journaled EXACTLY once on the probe execution's
 *     ledger (the `agent-action-recorded` vocabulary, per-probe
 *     distinct idempotency keys);
 *   - the battery-level row-count invariants: the foreign tenant's
 *     executions, events and idempotency rows are UNCHANGED before
 *     and after the whole probe battery (the cross-application
 *     contamination check — zero foreign effects, zero foreign rows);
 *   - the miss-indistinguishability check over the REAL served API:
 *     the 404 for the foreign execution is byte-identical to the 404
 *     for an unknown id (no tenant oracle).
 *
 * The suite is gated on ZECK_PG_TEST_URL (the honest NOT RUN boundary
 * when absent — no provider credential is needed by this slice: the
 * isolation probes are pre-dispatch).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runTenantIsolationApp } from "../../../benchmarks/validation/apps/tenant-isolation/application";
import {
  ISOLATION_CORPUS,
  type IsolationCorpusRow,
} from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  driveIsolationExecution,
  type IsolationLifecyclePort,
  type IsolationProbeObservation,
  type IsolationProbeSeam,
  type IsolationWorldFacts,
  isolationDigestOf,
  redactForeignMarkers,
  scanForForeignContent,
} from "../../../benchmarks/validation/platform/tenant-isolation";
import {
  type ArtifactDigest,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import { createScopeResolver, type ScopeResolver } from "../../../src/modules/auth/public";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const REVISION = createHash("sha256")
  .update("val-024|tenant-isolation|pinned")
  .digest("hex")
  .slice(0, 40);

/** The foreign tenant's canary content (labels + markers — never secrets). */
const FOREIGN_MARKERS = [
  {
    label: "foreign-execution-canary",
    marker: "TENANT-B-CANARY-EXECUTION-4d81f2c6",
  },
  {
    label: "foreign-artifact-canary",
    marker: "TENANT-B-CANARY-ARTIFACT-9a37e5b1",
  },
] as const;

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly probes: number;
  readonly journaled: number;
  readonly probeLatencyMs: number;
  readonly appPassed: boolean;
  readonly appProbeKinds: string;
}

/** The REAL world bindings the crown seeds beyond the api world. */
interface IsolationWorld {
  readonly foreignExecutionId: string;
  readonly foreignEnvironmentId: string;
  readonly foreignArtifactDigest: ArtifactDigest;
  readonly ownArtifactDigest: ArtifactDigest;
  readonly artifacts: ReturnType<typeof createArtifactService>;
  readonly artifactStore: ReturnType<typeof createInMemoryArtifactStore>;
  readonly scopeResolver: ScopeResolver;
  readonly foreignFacts: () => Promise<IsolationWorldFacts>;
}

/** Seed the isolation world: the foreign execution, environment and artifacts. */
async function seedIsolationWorld(ctx: PgContext, world: ApiPgWorld): Promise<IsolationWorld> {
  const generateId = createUuidv7Generator();

  // The foreign tenant's actor (from the durable membership rows).
  const membership = await ctx.port.execute<{ actor_id: string }>({
    sql: `SELECT actor_id FROM identity.memberships WHERE application_id = $1 ORDER BY created_at ASC LIMIT 1`,
    parameters: [world.otherApplicationId],
  });
  const foreignActorId = membership.rows[0]?.actor_id;
  if (foreignActorId === undefined) {
    throw new Error("the api world seeded no membership for the foreign application");
  }

  // The foreign execution: created under the OTHER tenant's application
  // through the REAL service, carrying the canary content in its task.
  const foreignExecution = await world.executions.createExecution(
    {
      applicationId: world.otherApplicationId,
      task: {
        kind: "tenant-b-lead-record",
        input: `confidential tenant-B content ${FOREIGN_MARKERS[0].marker}`,
      },
    },
    `val-024-seed-foreign-${generateId()}`,
    { actorId: foreignActorId, tenantId: world.otherTenantId },
  );

  // The foreign environment: a REAL environments row under the OTHER
  // tenant's application.
  const foreignEnvironmentId = generateId();
  await ctx.port.execute({
    sql: `INSERT INTO applications.environments (id, application_id, tenant_id, kind, name)
          VALUES ($1, $2, $3, 'production', $4)`,
    parameters: [
      foreignEnvironmentId,
      world.otherApplicationId,
      world.otherTenantId,
      `prod-${foreignEnvironmentId.slice(-6)}`,
    ],
  });

  // The REAL artifacts service over the platform's REAL in-memory
  // substrate: the foreign tenant's canary artifact + the probe
  // tenant's own control artifact.
  const artifactStore = createInMemoryArtifactStore();
  const artifacts = createArtifactService({
    store: artifactStore,
    digest: createNodeDigestPort(),
  });
  const foreignArtifact = await artifacts.putArtifact({
    tenantId: world.otherTenantId,
    kind: "task-output",
    payload: { report: `tenant-B confidential report ${FOREIGN_MARKERS[1].marker}` },
    sourceRefs: [{ kind: "source", id: "tenant-b-ledger", locator: "reports/2026-09" }],
  });
  const ownArtifact = await artifacts.putArtifact({
    tenantId: world.tenantId,
    kind: "task-output",
    payload: { report: "tenant-A own control report" },
    sourceRefs: [{ kind: "source", id: "tenant-a-ledger", locator: "reports/2026-09" }],
  });

  // The REAL scope resolver over the world's durable identity rows
  // (the api-world's own inline-store pattern — REAL membership rows).
  const identityStore = {
    findMembershipWithApplicationTenant: (async (actorId: string, appId: string) => {
      const result = await ctx.port.execute<{
        membership_id: string;
        actor_id: string;
        application_id: string;
        tenant_id: string;
        role: string;
        created_at: Date;
        application_tenant_id: string;
      }>({
        sql: `SELECT m.id AS membership_id, m.actor_id, m.application_id, m.tenant_id, m.role,
                     m.created_at, a.tenant_id AS application_tenant_id
              FROM identity.memberships m
              JOIN applications.applications a ON a.id = m.application_id
              WHERE m.actor_id = $1 AND m.application_id = $2`,
        parameters: [actorId, appId],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        membership: {
          id: row.membership_id,
          actorId: row.actor_id,
          applicationId: row.application_id,
          tenantId: row.tenant_id,
          role: row.role,
          createdAt: row.created_at.toISOString(),
        },
        applicationTenantId: row.application_tenant_id,
      };
    }) as never,
  };
  const scopeResolver = createScopeResolver(identityStore as never);

  const foreignFacts = async (): Promise<IsolationWorldFacts> => {
    const execCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
      parameters: [world.otherApplicationId],
    });
    const eventCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events WHERE application_id = $1`,
      parameters: [world.otherApplicationId],
    });
    const foreignRow = await ctx.port.execute<{
      status: string;
      last_event_sequence: number;
    }>({
      sql: `SELECT status, last_event_sequence FROM executions.executions WHERE id = $1`,
      parameters: [foreignExecution.executionId],
    });
    const row = foreignRow.rows[0];
    if (row === undefined) {
      throw new Error("the foreign execution row disappeared (the world is inconsistent)");
    }
    const artifactCount = await artifactStore.list({ tenantId: world.otherTenantId });
    return {
      foreignExecutionCount: execCount.rows[0]?.c ?? 0,
      foreignEventCount: eventCount.rows[0]?.c ?? 0,
      foreignArtifactCount: artifactCount.length,
      foreignExecutionStatus: row.status,
      foreignExecutionLastEventSequence: row.last_event_sequence,
    };
  };

  return {
    foreignExecutionId: foreignExecution.executionId,
    foreignEnvironmentId,
    foreignArtifactDigest: foreignArtifact.digest,
    ownArtifactDigest: ownArtifact.digest,
    artifacts,
    artifactStore,
    scopeResolver,
    foreignFacts,
  };
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): IsolationLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason }) {
      transitionCounter += 1;
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        // Every call gets a unique key: repeated steps must never
        // collide on the ledger.
        `val-024-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route }) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: world.applicationId,
          executionId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          decisionId: generateId(),
          planId: generateId(),
          payload: {
            candidates: [
              {
                strategyId: "val-024-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-024-pinned",
          },
        },
        `val-024-${executionId}-decision`,
      );
    },
    async recordProbe({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-024-isolation-probe-${record.probe}`,
          reference: {
            probe: record.probe,
            operation: record.operation,
            kind: record.kind,
            rejection: record.rejection,
            latencyMs: record.latencyMs,
            targetDigest: record.targetDigest,
            rowsReturned: record.rowsReturned,
            foreignMarkerLabels: [...record.foreignMarkerLabels],
          },
          payload: { probe: record.probe, operation: record.operation, kind: record.kind },
        },
        // Distinct per probe (the ledger sees distinct payloads — the
        // VAL-018 lesson): the idempotency key carries the probe ordinal.
        `val-024-${executionId}-probe-${record.probe}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: verdict,
          reason,
          verificationResults: criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            strategy: criterion.strategy,
            status: criterion.status,
            recordedBy: "val-024-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-024-${executionId}-${verdict}`,
      );
    },
  };
}

/**
 * Bind the platform-side probe seam to the REAL authorities: the
 * executions service (create/transition/planning/read/events), the
 * artifacts service (fetch/adoption) and the scope resolver (the
 * forged selector). Every call is ONE REAL probe — never retried; the
 * authorities' own typed rejections are classified and the observed
 * text is scanned + redacted (labels only, never content).
 */
function createRealSeam(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly isolation: IsolationWorld;
  readonly executionId: string;
}): IsolationProbeSeam {
  const { world, isolation } = options;
  const generateId = createUuidv7Generator();
  const now = () => Date.now();

  const denied = (
    error: unknown,
    operation: string,
    startedAt: number,
  ): IsolationProbeObservation => {
    const platformError = error instanceof PlatformError ? error : null;
    const code = platformError?.code ?? "UNEXPECTED";
    const message =
      platformError?.message ?? (error instanceof Error ? error.message : String(error));
    const rejection =
      code === "TENANT_SCOPE_VIOLATION"
        ? ("TENANT_SCOPE_VIOLATION" as const)
        : code === "AUTHORIZATION_DENIED"
          ? ("AUTHORIZATION_DENIED" as const)
          : null;
    const labels = scanForForeignContent(message, FOREIGN_MARKERS);
    const base = {
      message: redactForeignMarkers(message, FOREIGN_MARKERS),
      latencyMs: now() - startedAt,
      targetDigest: isolationDigestOf(operation),
      httpStatus: null,
    };
    if (rejection === null) {
      // An unexpected rejection code: the boundary could not be
      // verified — honestly recorded as the breach shape (the criteria
      // fail it, never a fabricated match).
      return {
        kind: "disclosed",
        rejection: null,
        ...base,
        rowsReturned: 1,
        foreignMarkerLabels: labels,
      };
    }
    return {
      kind: "denied",
      rejection,
      ...base,
      ...(labels.length > 0 ? { foreignMarkerLabels: labels } : {}),
    };
  };

  const miss = (operation: string, startedAt: number, rows: number): IsolationProbeObservation => ({
    kind: "miss",
    rejection: "SCOPE_CHECKED_MISS",
    message: "execution not found in this application (scope-checked miss, zero rows)",
    latencyMs: now() - startedAt,
    targetDigest: isolationDigestOf(operation),
    httpStatus: null,
    rowsReturned: rows,
  });

  const granted = (
    operation: string,
    startedAt: number,
    rows: number,
    data: unknown,
  ): IsolationProbeObservation => {
    const text = JSON.stringify(data ?? null) ?? "";
    const labels = scanForForeignContent(text, FOREIGN_MARKERS);
    return {
      kind: "granted",
      rejection: null,
      message: redactForeignMarkers("granted (own-namespace access)", FOREIGN_MARKERS),
      latencyMs: now() - startedAt,
      targetDigest: isolationDigestOf(operation),
      httpStatus: null,
      rowsReturned: rows,
      dataDigest: isolationDigestOf(text),
      ...(labels.length > 0 ? { foreignMarkerLabels: labels } : {}),
    };
  };

  return async ({ probeOrdinal, operation }) => {
    const startedAt = now();
    const key = `val-024-seam-${options.executionId}-${probeOrdinal}`;
    switch (operation) {
      case "svc-create-foreign-application": {
        try {
          await world.executions.createExecution(
            {
              applicationId: world.otherApplicationId,
              task: { kind: "isolation-probe", family: "cross-tenant-create" },
            },
            key,
            { actorId: world.actorId, tenantId: world.tenantId },
          );
          return {
            kind: "disclosed",
            rejection: null,
            message: "the boundary did not reject the cross-tenant create (a foreign effect)",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-create-foreign-environment": {
        try {
          await world.executions.createExecution(
            {
              applicationId: world.applicationId,
              environmentId: isolation.foreignEnvironmentId,
              task: { kind: "isolation-probe", family: "cross-tenant-environment" },
            },
            key,
            { actorId: world.actorId, tenantId: world.tenantId },
          );
          return {
            kind: "disclosed",
            rejection: null,
            message: "the boundary did not reject the foreign-environment create",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-read-foreign-execution": {
        const record = await world.executions.getExecution(
          world.applicationId,
          isolation.foreignExecutionId,
        );
        if (record === null) {
          return miss(operation, startedAt, 0);
        }
        // A foreign row crossed the application-scoped query — the breach.
        const text = JSON.stringify(record);
        return {
          kind: "disclosed",
          rejection: null,
          message: redactForeignMarkers(
            "the application-scoped getter returned the foreign execution row",
            FOREIGN_MARKERS,
          ),
          latencyMs: now() - startedAt,
          targetDigest: isolationDigestOf(operation),
          httpStatus: null,
          rowsReturned: 1,
          foreignMarkerLabels: scanForForeignContent(text, FOREIGN_MARKERS),
        };
      }
      case "svc-events-foreign-execution": {
        const events = await world.executions.listEvents(
          world.applicationId,
          isolation.foreignExecutionId,
        );
        if (events.length === 0) {
          return miss(operation, startedAt, 0);
        }
        const text = JSON.stringify(events);
        return {
          kind: "disclosed",
          rejection: null,
          message: redactForeignMarkers(
            "the application-scoped ledger query returned foreign rows",
            FOREIGN_MARKERS,
          ),
          latencyMs: now() - startedAt,
          targetDigest: isolationDigestOf(operation),
          httpStatus: null,
          rowsReturned: events.length,
          foreignMarkerLabels: scanForForeignContent(text, FOREIGN_MARKERS),
        };
      }
      case "svc-transition-foreign-execution": {
        try {
          await world.executions.transition(
            {
              actorId: world.actorId,
              applicationId: world.applicationId,
              tenantId: world.tenantId,
              executionId: isolation.foreignExecutionId,
              command: "cancel",
              reason: "val-024-cross-tenant-transition-probe",
            },
            key,
          );
          return {
            kind: "disclosed",
            rejection: null,
            message:
              "the locked-row check did not reject the foreign transition (a foreign effect)",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-planning-foreign-execution": {
        try {
          await world.executions.recordPlanningDecision(
            {
              applicationId: world.applicationId,
              executionId: isolation.foreignExecutionId,
              tenantId: world.tenantId,
              actorId: world.actorId,
              decisionId: generateId(),
              planId: generateId(),
              payload: {
                candidates: [
                  {
                    strategyId: "val-024-probe",
                    plan: { strategyClass: "tenant-isolation-probe", modelCalls: 0, steps: [] },
                  },
                ],
                selectedStrategyId: "val-024-probe",
              },
            },
            key,
          );
          return {
            kind: "disclosed",
            rejection: null,
            message: "the locked-row check did not reject the foreign planning decision",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-artifact-fetch-foreign": {
        try {
          const record = await isolation.artifacts.getArtifact(
            { tenantId: world.tenantId },
            isolation.foreignArtifactDigest,
          );
          const text = JSON.stringify(record);
          return {
            kind: "disclosed",
            rejection: null,
            message: redactForeignMarkers(
              "the artifact namespace returned the foreign record",
              FOREIGN_MARKERS,
            ),
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: scanForForeignContent(text, FOREIGN_MARKERS),
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-artifact-adopt-foreign-parent": {
        try {
          await isolation.artifacts.putArtifact({
            tenantId: world.tenantId,
            kind: "task-output",
            payload: { derived: "probe-report" },
            parents: [isolation.foreignArtifactDigest],
            sourceRefs: [{ kind: "source", id: "val-024-probe", locator: "test" }],
          });
          return {
            kind: "disclosed",
            rejection: null,
            message: "the adoption boundary did not reject the foreign parent digest",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-resolve-forged-scope": {
        try {
          const scope = await isolation.scopeResolver.resolveApplicationScope(
            { actorId: world.actorId, authenticatedAt: new Date().toISOString() },
            world.otherApplicationId,
          );
          void scope;
          return {
            kind: "disclosed",
            rejection: null,
            message:
              "the scope resolver granted a scope the actor never held (forged selector accepted)",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 1,
            foreignMarkerLabels: [],
          };
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      case "svc-read-own-execution": {
        const record = await world.executions.getExecution(
          world.applicationId,
          options.executionId,
        );
        if (record === null) {
          return {
            kind: "disclosed",
            rejection: null,
            message: "the own-namespace read missed (the boundary over-denied)",
            latencyMs: now() - startedAt,
            targetDigest: isolationDigestOf(operation),
            httpStatus: null,
            rowsReturned: 0,
            foreignMarkerLabels: [],
          };
        }
        return granted(operation, startedAt, 1, {
          id: record.id,
          status: record.status,
        });
      }
      case "svc-artifact-fetch-own": {
        try {
          const record = await isolation.artifacts.getArtifact(
            { tenantId: world.tenantId },
            isolation.ownArtifactDigest,
          );
          return granted(operation, startedAt, 1, { digest: record.digest });
        } catch (error) {
          return denied(error, operation, startedAt);
        }
      }
      default: {
        const exhaustive: never = operation;
        throw new Error(`unhandled probe operation ${String(exhaustive)}`);
      }
    }
  };
}

/** Submit one corpus row through the public SDK boundary (the app). */
async function submitRow(
  world: ApiPgWorld,
  address: string,
  isolation: IsolationWorld,
  options: {
    readonly generateId: () => string;
    readonly taskIndex: number;
    readonly completionTimeoutMs: number;
  },
): Promise<{ readonly evidence: unknown; readonly passed: boolean }> {
  return runTenantIsolationApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: options.completionTimeoutMs,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-024-tenant-isolation" },
    },
    runSuffix: `it-${options.generateId().slice(-8)}`,
    taskIndex: options.taskIndex,
    worldRefs: {
      foreignApplicationId: world.otherApplicationId,
      foreignEnvironmentId: isolation.foreignEnvironmentId,
      foreignExecutionId: isolation.foreignExecutionId,
      foreignArtifactDigest: isolation.foreignArtifactDigest,
      ownArtifactDigest: isolation.ownArtifactDigest,
      foreignMarkers: FOREIGN_MARKERS,
    },
  });
}

definePgSuite("VAL-024 tenant isolation over the real platform path", (ctx) => {
  test("every isolation probe is denied over the REAL platform path with zero disclosure, zero foreign rows and a journal-exactly-once ledger", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const isolation = await seedIsolationWorld(ctx, world);
    const lifecycle = createLifecycleBinding(world);
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    // The battery-level baseline: the foreign tenant's namespace before
    // the probe battery (the cross-application contamination check).
    const baselineFacts = await isolation.foreignFacts();
    const baselineIdempotency = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM platform.idempotency_records WHERE application_id = $1`,
      parameters: [world.otherApplicationId],
    });

    try {
      for (const [corpusIndex, row] of ISOLATION_CORPUS.entries()) {
        const appPromise = submitRow(world, address, isolation, {
          generateId,
          taskIndex: corpusIndex,
          completionTimeoutMs: 120_000,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        // Platform side: wait for THIS task's submission to land.
        let executionId: string | null = null;
        for (let attempt = 0; attempt < 2_400 && executionId === null; attempt += 1) {
          const rows = await ctx.port.execute<{ id: string }>({
            sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
            parameters: [world.applicationId],
          });
          const id = rows.rows[0]?.id;
          if (id !== undefined && !drivenExecutionIds.has(id)) {
            drivenExecutionIds.add(id);
            executionId = id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(executionId).not.toBeNull();

        const result = await driveIsolationExecution({
          executionId: executionId as string,
          task: {
            kind: "isolation-probe",
            input: {
              rowId: row.rowId,
              family: row.family,
              targetRole: row.targetRole,
            },
          },
          groundTruth: row,
          platformProbes: row.platformProbes,
          lifecycle,
          probe: createRealSeam({ ctx, world, isolation, executionId: executionId as string }),
          worldFacts: isolation.foreignFacts,
          foreignMarkers: FOREIGN_MARKERS,
          now: () => new Date(),
        });

        // The durable ledger evidence for THIS execution — the
        // external cross-check of the isolation journal (exactly once
        // per driven probe).
        const events = await ctx.port.execute<{ command: string }>({
          sql: `SELECT command FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
          parameters: [executionId],
        });
        const commands = events.rows.map((rowEvent) => rowEvent.command);
        const journaled = commands.filter((command) => command === "agent-action-recorded").length;

        // The honest outcome contract: the verified boundary COMPLETES;
        // every criterion PASSES; the journal is exactly-once-per-probe.
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual(
          [],
        );
        expect(journaled, `${row.rowId} journal count`).toBe(row.platformProbes.length);
        expect(result.journaledProbes).toBe(row.platformProbes.length);

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const violations = validateHarnessEvidence(appSettled.outcome.evidence as never);
        expect(violations).toEqual([]);
        // The application's assertions PASS on the verified boundary.
        expect(appSettled.outcome.passed, `${row.rowId} app assertions`).toBe(true);
        // The other tenant's canary content NEVER appears in the app's
        // own evidence (the zero-data-disclosure discipline).
        const evidenceText = JSON.stringify(appSettled.outcome.evidence);
        for (const marker of FOREIGN_MARKERS) {
          expect(
            evidenceText,
            `${row.rowId} evidence must not carry ${marker.label}`,
          ).not.toContain(marker.marker);
        }

        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          probes: result.totalProbes,
          journaled,
          probeLatencyMs: result.totalProbeLatencyMs,
          appPassed: appSettled.outcome.passed,
          appProbeKinds: "denied-or-granted-per-row",
        });
        console.info(
          `[VAL-024]   ${row.rowId} -> ${result.terminal} probes=${result.totalProbes} ` +
            `journaled=${journaled} latency=${result.totalProbeLatencyMs}ms ` +
            `appPassed=${String(appSettled.outcome.passed)}`,
        );
      }

      // The battery-level row-count invariants: the foreign tenant's
      // namespace is UNCHANGED by the whole probe battery (zero
      // foreign effects, zero foreign rows, zero foreign ledger rows).
      const finalFacts = await isolation.foreignFacts();
      const finalIdempotency = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records WHERE application_id = $1`,
        parameters: [world.otherApplicationId],
      });
      expect(finalFacts.foreignExecutionCount).toBe(baselineFacts.foreignExecutionCount);
      expect(finalFacts.foreignEventCount).toBe(baselineFacts.foreignEventCount);
      expect(finalFacts.foreignArtifactCount).toBe(baselineFacts.foreignArtifactCount);
      expect(finalFacts.foreignExecutionStatus).toBe(baselineFacts.foreignExecutionStatus);
      expect(finalFacts.foreignExecutionLastEventSequence).toBe(
        baselineFacts.foreignExecutionLastEventSequence,
      );
      expect(finalIdempotency.rows[0]?.c).toBe(baselineIdempotency.rows[0]?.c);

      // No event row of the probe application's ledger references the
      // foreign execution (no cross-application ledger contamination).
      const crossRows = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.execution_events
              WHERE application_id = $1 AND execution_id = $2`,
        parameters: [world.applicationId, isolation.foreignExecutionId],
      });
      expect(crossRows.rows[0]?.c).toBe(0);

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-024] BATTERY summary: ${completed} COMPLETED (verified boundaries) ` +
          `of ${runFacts.length} driven rows; every probe journaled exactly once; ` +
          `the foreign namespace row-counts unchanged ` +
          `(executions=${finalFacts.foreignExecutionCount}, events=${finalFacts.foreignEventCount}, ` +
          `artifacts=${finalFacts.foreignArtifactCount}); the foreign execution row untouched ` +
          `(${finalFacts.foreignExecutionStatus} @ seq ${finalFacts.foreignExecutionLastEventSequence}).`,
      );
      expect(runFacts.length).toBe(ISOLATION_CORPUS.length);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL served API answers the scope-checked miss indistinguishably (no tenant oracle)", {
    timeout: 120_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const isolation = await seedIsolationWorld(ctx, world);
    const drivenExecutionIds = new Set<string>();

    try {
      // Submit one row so a REAL own-namespace execution exists.
      const appPromise = submitRow(world, address, isolation, {
        generateId,
        taskIndex: 0,
        completionTimeoutMs: 120_000,
      }).then(
        (outcome) => ({ ok: true as const, outcome }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      let executionId: string | null = null;
      for (let attempt = 0; attempt < 2_400 && executionId === null; attempt += 1) {
        const rows = await ctx.port.execute<{ id: string }>({
          sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
          parameters: [world.applicationId],
        });
        const id = rows.rows[0]?.id;
        if (id !== undefined && !drivenExecutionIds.has(id)) {
          drivenExecutionIds.add(id);
          executionId = id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(executionId).not.toBeNull();

      const lifecycle = createLifecycleBinding(world);
      const row: IsolationCorpusRow = ISOLATION_CORPUS[0] as IsolationCorpusRow;
      await driveIsolationExecution({
        executionId: executionId as string,
        task: {
          kind: "isolation-probe",
          input: { rowId: row.rowId, family: row.family, targetRole: row.targetRole },
        },
        groundTruth: row,
        platformProbes: row.platformProbes,
        lifecycle,
        probe: createRealSeam({ ctx, world, isolation, executionId: executionId as string }),
        worldFacts: isolation.foreignFacts,
        foreignMarkers: FOREIGN_MARKERS,
        now: () => new Date(),
      });

      const appSettled = await appPromise;
      if (!appSettled.ok) {
        throw appSettled.error;
      }
      expect(appSettled.outcome.passed).toBe(true);

      // The indistinguishability check over the REAL wire: the 404 for
      // the foreign execution is byte-identical to the 404 for an id
      // that never existed (no tenant oracle in the response).
      const readOf = async (
        executionIdToRead: string,
      ): Promise<{ status: number; text: string }> => {
        const response = await globalThis.fetch(
          `${address}/executions/${encodeURIComponent(executionIdToRead)}`,
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${world.bearerToken}`,
              "x-zeck-application": world.applicationId,
            },
          },
        );
        return { status: response.status, text: await response.text() };
      };
      const foreign = await readOf(isolation.foreignExecutionId);
      const unknown = await readOf("00000000-0000-7000-8000-000000000000");
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      for (const marker of FOREIGN_MARKERS) {
        expect(foreign.text).not.toContain(marker.marker);
      }
      console.info(
        "[VAL-024] MISS indistinguishability: the foreign-execution 404 and the unknown-id 404 " +
          "are byte-identical over the REAL served API (no tenant oracle).",
      );
    } finally {
      await world.server.app.close();
    }
  });
});
