/**
 * VAL-024 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * tenant-isolation application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions service — the store's locked-row
 *     discipline (every query bound by application + tenant) is the
 *     system under test: cross-tenant creates, transitions, planning
 *     decisions and step events get the typed TENANT_SCOPE_VIOLATION
 *     from the locked-row checks; cross-tenant and cross-application
 *     reads are scope-checked misses (zero rows — never data);
 *   - the REAL server-side scope derivation (the auth scope resolver
 *     over the real membership rows): a forged application-scope
 *     header and a confused application-id create are refused with
 *     AUTHORIZATION_DENIED before any durable write;
 *   - the REAL SQL row counts: the row-count invariants verify the
 *     foreign application's durable rows are IDENTICAL before and
 *     after every battery (zero foreign effects) and the own
 *     application's delta equals exactly the driver's accounted
 *     journal writes;
 *   - the isolation journal rides the REAL ledger (the
 *     `agent-action-recorded` step-event vocabulary, ledger-verified
 *     exactly once per probe);
 *   - the customer application performs its own cross-tenant access
 *     attempts through the public SDK over the REAL wire — the
 *     customer-style primary evidence path.
 *
 * The foreign world is seeded with SYNTHETIC canary material (never
 * real tenant data): any cross-tenant data disclosure would surface
 * the canary in the evidence — mechanically scanned everywhere (the
 * driver's run result, the app's evidence, the own application's
 * durable ledger rows).
 *
 * No provider credential is needed or used: the isolation probes are
 * pre-dispatch (the scope checks fire before anything is dispatched,
 * executed or written). The PostgreSQL server itself is env-gated
 * (absent ZECK_PG_TEST_URL = the whole suite skips cleanly, never a
 * fake success — the Lead's credential-gated verification domain).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runTenantIsolationApp } from "../../../benchmarks/validation/apps/tenant-isolation/application";
import { TENANT_ISOLATION_CORPUS } from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  FOREIGN_CONTENT_MARKERS,
  FOREIGN_EVENT_MARKER,
  FOREIGN_METADATA_MARKER,
  FOREIGN_TASK_CANARY,
} from "../../../benchmarks/validation/apps/tenant-isolation/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  driveTenantIsolationExecution,
  type IsolationCountSnapshotter,
  type IsolationExecutionsSurface,
  type IsolationWireSurface,
  type TenantIsolationLifecyclePort,
  type WorldRowCounts,
} from "../../../benchmarks/validation/platform/tenant-isolation";
import { createZeckClient } from "../../../sdk";
import type { ExecutionTransitionCommand } from "../../../src/modules/executions/application/execution-service";
import type { StepEventCommand } from "../../../src/modules/executions/domain/event";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const REVISION = createHash("sha256")
  .update("val-024|tenant-isolation|pinned")
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly probes: number;
  readonly denied: number;
  readonly journaled: number;
  readonly leaked: number;
  readonly rowCountViolations: number;
  readonly appProbes: number;
  readonly appPassed: boolean;
  readonly latencyMs: number;
  readonly evidenceScan: "clean" | "LEAK";
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): TenantIsolationLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  let probeCounter = 0;
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
                  steps: [],
                },
              },
            ],
            selectedStrategyId: "val-024-pinned",
          },
        },
        `val-024-${executionId}-decision`,
      );
    },
    async recordProbeOutcome({ executionId, record }) {
      probeCounter += 1;
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-024-isolation-probe-${record.probeId}`,
          reference: {
            probeId: record.probeId,
            surface: record.surface,
            operation: record.operation,
            reference: record.reference,
            expectedCode: record.expectedCode,
            expectedKind: record.expectedKind,
            observedKind: record.observedKind,
            observedCode: record.observedCode,
            httpStatus: record.httpStatus,
            denied: record.denied,
            dataLeak: record.dataLeak,
            latencyMs: record.latencyMs,
            requestDigest: record.requestDigest,
          },
          payload: { probeId: record.probeId, denied: record.denied },
        },
        // Distinct per probe (the ledger sees distinct payloads).
        `val-024-${executionId}-probe-${probeCounter}`,
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

/** Bind the REAL executions service onto the driver's service seam. */
function createExecutionsSurface(world: ApiPgWorld): IsolationExecutionsSurface {
  return {
    async createExecution(input, idempotencyKey, actor) {
      return world.executions.createExecution(
        {
          applicationId: input.applicationId,
          ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
          task: { ...input.task },
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        },
        idempotencyKey,
        actor,
      );
    },
    async getExecution(applicationId, executionId) {
      return world.executions.getExecution(applicationId, executionId);
    },
    async listEvents(applicationId, executionId) {
      return world.executions.listEvents(applicationId, executionId);
    },
    async listVerificationResults(applicationId, executionId) {
      return world.executions.listVerificationResults(applicationId, executionId);
    },
    async transition(command, idempotencyKey) {
      return world.executions.transition(
        {
          command: command.command,
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          executionId: command.executionId,
          actorId: command.actorId,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        } as ExecutionTransitionCommand,
        idempotencyKey,
      );
    },
    async recordStepEvent(input, idempotencyKey) {
      return world.executions.recordStepEvent(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
          command: input.command as StepEventCommand,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
          ...(input.reference === undefined ? {} : { reference: { ...input.reference } }),
          payload: { ...input.payload },
        },
        idempotencyKey,
      );
    },
    async recordPlanningDecision(input, idempotencyKey) {
      return world.executions.recordPlanningDecision(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          decisionId: input.decisionId,
          planId: input.planId,
          payload: { ...input.payload },
        },
        idempotencyKey,
      );
    },
  };
}

/** Bind the REAL public clients onto the driver's wire seam. */
function createWireSurface(address: string, world: ApiPgWorld): IsolationWireSurface {
  const scoped = createZeckClient({
    baseUrl: address,
    token: world.bearerToken,
    applicationId: world.applicationId,
    fetchImpl: globalThis.fetch,
  });
  const forged = createZeckClient({
    baseUrl: address,
    token: world.bearerToken,
    applicationId: world.otherApplicationId,
    fetchImpl: globalThis.fetch,
  });
  return {
    scoped: {
      createExecution: (request, key) =>
        scoped.createExecution(
          {
            applicationId: request.applicationId,
            ...(request.environmentId === undefined
              ? {}
              : { environmentId: request.environmentId }),
            task: { ...request.task },
          },
          key,
        ),
      getExecution: (executionId) => scoped.getExecution(executionId),
      cancelExecution: (executionId, key) => scoped.cancelExecution(executionId, key),
      getResult: (executionId) => scoped.getResult(executionId),
      listEvents: (executionId) => scoped.listEvents(executionId),
      listVerification: (executionId) => scoped.listVerification(executionId),
    },
    forged: {
      getExecution: (executionId) => forged.getExecution(executionId),
      createExecution: (request, key) =>
        forged.createExecution(
          { applicationId: request.applicationId, task: { ...request.task } },
          key,
        ),
    },
  };
}

/** Count one application's durable rows (the REAL SQL row counts). */
async function countApplicationRows(
  ctx: PgContext,
  applicationId: string,
): Promise<WorldRowCounts> {
  const single = async (sql: string): Promise<number> => {
    const rows = await ctx.port.execute<{ count: number }>({ sql, parameters: [applicationId] });
    return Number(rows.rows[0]?.count ?? 0);
  };
  const [executions, events, verification, idempotency] = await Promise.all([
    single("SELECT count(*)::int AS count FROM executions.executions WHERE application_id = $1"),
    single(
      "SELECT count(*)::int AS count FROM executions.execution_events WHERE application_id = $1",
    ),
    single(
      "SELECT count(*)::int AS count FROM executions.verification_results WHERE application_id = $1",
    ),
    single(
      "SELECT count(*)::int AS count FROM platform.idempotency_records WHERE application_id = $1",
    ),
  ]);
  return {
    executions,
    executionEvents: events,
    verificationResults: verification,
    idempotencyRecords: idempotency,
  };
}

/** The mechanical foreign-content scan over serialized evidence. */
function foreignContentScan(evidence: unknown): { clean: boolean; findings: string[] } {
  const text = JSON.stringify(evidence) ?? "null";
  const findings: string[] = [];
  for (const marker of FOREIGN_CONTENT_MARKERS) {
    if (text.includes(marker.material)) {
      findings.push(`foreign-content-found:${marker.label}`);
    }
  }
  return { clean: findings.length === 0, findings };
}

definePgSuite("VAL-024 tenant isolation over the real platform path", (ctx) => {
  test("the isolation corpus battery denies every cross-tenant probe over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    // ---- the foreign world (tenant B): seeded over the REAL service ----
    const otherActorRows = await ctx.port.execute<{ actor_id: string }>({
      sql: "SELECT actor_id FROM identity.memberships WHERE application_id = $1 ORDER BY created_at LIMIT 1",
      parameters: [world.otherApplicationId],
    });
    const foreignActorId = otherActorRows.rows[0]?.actor_id;
    expect(foreignActorId).toBeDefined();
    const runTag = generateId().slice(-8);
    const foreignEnvironmentId = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, 'staging', $4)",
      parameters: [
        foreignEnvironmentId,
        world.otherApplicationId,
        world.otherTenantId,
        `staging-${runTag}`,
      ],
    });
    const foreignExecution = await world.executions.createExecution(
      {
        applicationId: world.otherApplicationId,
        task: { kind: "foreign-workload", input: FOREIGN_TASK_CANARY },
        metadata: { classification: FOREIGN_METADATA_MARKER },
      },
      `val-024-foreign-seed-${runTag}`,
      { actorId: foreignActorId as string, tenantId: world.otherTenantId },
    );
    await world.executions.recordStepEvent(
      {
        applicationId: world.otherApplicationId,
        executionId: foreignExecution.executionId,
        actor: { actorId: foreignActorId as string, tenantId: world.otherTenantId },
        command: "agent-action-recorded",
        cause: "val-024-foreign-marker",
        reference: { marker: FOREIGN_EVENT_MARKER },
        payload: { marker: FOREIGN_EVENT_MARKER },
      },
      `val-024-foreign-event-${runTag}`,
    );
    const foreignRefs = {
      foreignApplicationId: world.otherApplicationId,
      foreignTenantId: world.otherTenantId,
      foreignActorId: foreignActorId as string,
      foreignExecutionId: foreignExecution.executionId,
      foreignEnvironmentId,
      contentMarkers: FOREIGN_CONTENT_MARKERS,
    };

    // ---- the battery-wide row-count snapshot (before) ----
    const before = await (async () => ({
      ownApplication: await countApplicationRows(ctx, world.applicationId),
      foreignApplication: await countApplicationRows(ctx, world.otherApplicationId),
    }))();

    const lifecycle = createLifecycleBinding(world);
    const executionsSurface = createExecutionsSurface(world);
    const wireSurface = createWireSurface(address, world);

    try {
      for (const [taskIndex, row] of TENANT_ISOLATION_CORPUS.entries()) {
        // The customer application: its own cross-tenant access
        // attempts through the public SDK + the carrier submission
        // (the probes complete before the carrier exists).
        const appPromise = runTenantIsolationApp({
          config: {
            applicationId: world.applicationId,
            baseUrl: address,
            tokenEnvVar: "ZECK_VALIDATION_TOKEN",
            applicationRevision: REVISION,
            corpusRevision: REVISION,
            integrationSurface: "sdk",
            pollIntervalMs: 250,
            completionTimeoutMs: 120_000,
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
          runSuffix: `it-${runTag}-${taskIndex}`,
          taskIndex,
          foreignRefs,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        // Platform side: wait for THIS task's carrier to land.
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

        // Drive the carrier's probe battery through the REAL
        // platform path (the locked-row checks + the wire probes +
        // the SQL row-count window + the isolation journal).
        const result = await driveTenantIsolationExecution({
          executionId: executionId as string,
          task: { kind: "isolation-probe", scenario: row.rowId, probe: row.probe },
          probe: row.probe,
          lifecycle,
          executions: executionsSurface,
          wire: wireSurface,
          counts: (async () => ({
            ownApplication: await countApplicationRows(ctx, world.applicationId),
            foreignApplication: await countApplicationRows(ctx, world.otherApplicationId),
          })) as IsolationCountSnapshotter,
          foreign: foreignRefs,
          own: {
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            actorId: world.actorId,
          },
          now: () => new Date(),
          idempotencyPrefix: "val-024",
        });

        // The durable ledger evidence for THIS carrier — the
        // external cross-check of the isolation journal (each
        // denied probe exactly once).
        const events = await ctx.port.execute<{
          command: string;
          cause: string | null;
          reference: unknown;
          payload: unknown;
        }>({
          sql: `SELECT command, cause, reference, payload FROM executions.execution_events
                  WHERE application_id = $1 AND execution_id = $2 ORDER BY sequence ASC`,
          parameters: [world.applicationId, executionId],
        });
        const journalRows = events.rows.filter(
          (event) =>
            event.command === "agent-action-recorded" &&
            String(event.cause ?? "").startsWith("val-024-isolation-probe-"),
        );

        // The mechanical DURABLE foreign-content scan: the row's
        // planted synthetic canaries must not appear in ANY
        // evidence field — the driver's run result, the own
        // application's ledger rows, the app's evidence.
        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const durableScan = foreignContentScan({
          runResult: { probes: result.probes, criteria: result.criteria },
          ledgerEvents: events.rows,
          appEvidence: appSettled.outcome.evidence,
          appProbes: appSettled.outcome.probes,
        });

        // ---- the honest outcome contract for every row ----
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual(
          [],
        );
        expect(result.deniedProbes, `${row.rowId} denied`).toBe(result.totalProbes);
        expect(result.leakedProbes, `${row.rowId} leaks`).toBe(0);
        expect(result.rowCountViolations, `${row.rowId} row counts`).toEqual([]);
        // The isolation journal: each denied probe EXACTLY once.
        expect(journalRows.length, `${row.rowId} journal`).toBe(result.totalProbes);
        // The application's assertions PASS on the honest outcome.
        expect(appSettled.outcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appSettled.outcome.evidence as never)).toEqual([]);
        for (const probe of appSettled.outcome.probes) {
          expect(probe.denied, `${row.rowId}/${probe.probeId} app probe denied`).toBe(true);
          expect(probe.dataLeak, `${row.rowId}/${probe.probeId} app probe leak`).toBe(false);
        }
        // The durable evidence scan stays clean.
        expect(
          durableScan.clean,
          `${row.rowId} durable leak: ${durableScan.findings.join(";")}`,
        ).toBe(true);

        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          probes: result.totalProbes,
          denied: result.deniedProbes,
          journaled: journalRows.length,
          leaked: result.leakedProbes,
          rowCountViolations: result.rowCountViolations.length,
          appProbes: appSettled.outcome.probes.length,
          appPassed: appSettled.outcome.passed,
          latencyMs: result.totalProbeLatencyMs,
          evidenceScan: durableScan.clean ? "clean" : "LEAK",
        });
        console.info(
          `[VAL-024]   ${row.rowId} -> ${result.terminal} probes=${result.totalProbes} ` +
            `denied=${result.deniedProbes} journaled=${journalRows.length} ` +
            `appProbes=${appSettled.outcome.probes.length} latency=${result.totalProbeLatencyMs}ms ` +
            `evidence=${durableScan.clean ? "clean" : "LEAK"}`,
        );
      }

      // ---- the battery-wide mechanical invariants ----
      const after = await (async () => ({
        ownApplication: await countApplicationRows(ctx, world.applicationId),
        foreignApplication: await countApplicationRows(ctx, world.otherApplicationId),
      }))();

      // Cross-application contamination is verified absent: the
      // foreign application's durable rows are IDENTICAL (zero
      // foreign effects — no probe created, transitioned or
      // journaled anything in tenant B's world).
      expect(after.foreignApplication).toEqual(before.foreignApplication);
      // The own application gained EXACTLY one execution per row
      // (the carriers — no probe ever created an execution).
      expect(after.ownApplication.executions - before.ownApplication.executions).toBe(
        TENANT_ISOLATION_CORPUS.length,
      );
      // No own-application row references the foreign execution
      // (and no foreign row references any carrier).
      const ownForeignRefs = await ctx.port.execute<{ count: number }>({
        sql: `SELECT count(*)::int AS count FROM executions.execution_events
                WHERE application_id = $1 AND execution_id = $2`,
        parameters: [world.applicationId, foreignExecution.executionId],
      });
      expect(Number(ownForeignRefs.rows[0]?.count ?? 0)).toBe(0);
      const foreignOwnRefs = await ctx.port.execute<{ count: number }>({
        sql: `SELECT count(*)::int AS count FROM executions.execution_events
                WHERE application_id = $1 AND execution_id = ANY($2::uuid[])`,
        parameters: [world.otherApplicationId, [...drivenExecutionIds].map((id) => id)],
      });
      expect(Number(foreignOwnRefs.rows[0]?.count ?? 0)).toBe(0);
      // The foreign execution is untouched (still CREATED — no
      // cross-tenant transition ever landed).
      const foreignRow = await ctx.port.execute<{ status: string }>({
        sql: "SELECT status FROM executions.executions WHERE id = $1",
        parameters: [foreignExecution.executionId],
      });
      expect(foreignRow.rows[0]?.status).toBe("CREATED");
      // The durable battery-wide canary scan (the whole own ledger).
      const ownLedger = await ctx.port.execute<{ payload: unknown }>({
        sql: "SELECT payload FROM executions.execution_events WHERE application_id = $1",
        parameters: [world.applicationId],
      });
      expect(foreignContentScan(ownLedger.rows).clean).toBe(true);

      const denied = runFacts.reduce((sum, fact) => sum + fact.denied, 0);
      const journaled = runFacts.reduce((sum, fact) => sum + fact.journaled, 0);
      console.info(
        `[VAL-024] BATTERY summary: ${runFacts.length}/${runFacts.length} rows COMPLETED over ` +
          `the REAL platform path; ${denied} probes denied (${journaled} journal rows, each ` +
          `exactly once); zero foreign effects (tenant B's durable rows identical before and ` +
          `after); zero data disclosure (the durable evidence scan clean on every row); the ` +
          `control row's legitimate same-tenant access admitted.`,
      );
      expect(runFacts.length).toBe(TENANT_ISOLATION_CORPUS.length);
      expect(runFacts.every((fact) => fact.terminal === "COMPLETED")).toBe(true);
      expect(runFacts.every((fact) => fact.evidenceScan === "clean")).toBe(true);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL service surfaces the pinned typed violations for every locked-row probe family", {
    timeout: 120_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const otherActorRows = await ctx.port.execute<{ actor_id: string }>({
        sql: "SELECT actor_id FROM identity.memberships WHERE application_id = $1 ORDER BY created_at LIMIT 1",
        parameters: [world.otherApplicationId],
      });
      const foreignActorId = otherActorRows.rows[0]?.actor_id ?? "";
      const runTag = generateId().slice(-8);
      const foreignEnvironmentId = generateId();
      await ctx.port.execute({
        sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, 'staging', $4)",
        parameters: [
          foreignEnvironmentId,
          world.otherApplicationId,
          world.otherTenantId,
          `staging-${runTag}`,
        ],
      });
      const foreignExecution = await world.executions.createExecution(
        {
          applicationId: world.otherApplicationId,
          task: { kind: "foreign-workload", input: FOREIGN_TASK_CANARY },
        },
        `val-024-typed-${runTag}`,
        { actorId: foreignActorId, tenantId: world.otherTenantId },
      );
      const ownExecution = await world.executions.createExecution(
        {
          applicationId: world.applicationId,
          task: { kind: "isolation-probe", scenario: "typed" },
        },
        `val-024-own-${runTag}`,
        { actorId: world.actorId, tenantId: world.tenantId },
      );

      // The create-path application-tenant check.
      await expect(
        world.executions.createExecution(
          { applicationId: world.otherApplicationId, task: { kind: "probe" } },
          `val-024-typed-app-${runTag}`,
          { actorId: world.actorId, tenantId: world.tenantId },
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // The create-path environment-ownership check.
      await expect(
        world.executions.createExecution(
          {
            applicationId: world.applicationId,
            environmentId: foreignEnvironmentId,
            task: { kind: "probe" },
          },
          `val-024-typed-env-${runTag}`,
          { actorId: world.actorId, tenantId: world.tenantId },
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // The locked-row transition miss + the tenant mismatch.
      await expect(
        world.executions.transition(
          {
            command: "cancel",
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            executionId: foreignExecution.executionId,
            actorId: world.actorId,
          },
          `val-024-typed-tr1-${runTag}`,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      await expect(
        world.executions.transition(
          {
            command: "cancel",
            applicationId: world.applicationId,
            tenantId: world.otherTenantId,
            executionId: ownExecution.executionId,
            actorId: foreignActorId,
          },
          `val-024-typed-tr2-${runTag}`,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // The step-event locked-row checks.
      await expect(
        world.executions.recordStepEvent(
          {
            applicationId: world.applicationId,
            executionId: foreignExecution.executionId,
            actor: { actorId: world.actorId, tenantId: world.tenantId },
            command: "agent-action-recorded",
            payload: {},
          },
          `val-024-typed-se1-${runTag}`,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      await expect(
        world.executions.recordStepEvent(
          {
            applicationId: world.applicationId,
            executionId: ownExecution.executionId,
            actor: { actorId: foreignActorId, tenantId: world.otherTenantId },
            command: "agent-action-recorded",
            payload: {},
          },
          `val-024-typed-se2-${runTag}`,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // The planning-decision locked-row checks.
      await expect(
        world.executions.recordPlanningDecision(
          {
            applicationId: world.applicationId,
            executionId: foreignExecution.executionId,
            tenantId: world.tenantId,
            actorId: world.actorId,
            decisionId: generateId(),
            planId: generateId(),
            payload: { probe: "cross-tenant-planning" },
          },
          `val-024-typed-pd1-${runTag}`,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // The read seams: zero rows, never data.
      await expect(
        world.executions.getExecution(world.applicationId, foreignExecution.executionId),
      ).resolves.toBeNull();
      await expect(
        world.executions.listEvents(world.applicationId, foreignExecution.executionId),
      ).resolves.toEqual([]);
      await expect(
        world.executions.listVerificationResults(world.applicationId, foreignExecution.executionId),
      ).resolves.toEqual([]);

      // The wire boundary over the REAL public API: the typed
      // violations and the scope-checked misses a customer sees.
      const client = createZeckClient({
        baseUrl: address,
        token: world.bearerToken,
        applicationId: world.applicationId,
        fetchImpl: globalThis.fetch,
      });
      const foreignError = async (
        operation: () => Promise<unknown>,
      ): Promise<{ status: number; code: string }> => {
        try {
          await operation();
          throw new Error("expected the REAL wire to deny the cross-tenant probe");
        } catch (error) {
          const asZeck = error as { status?: number; body?: { code?: string } };
          return { status: asZeck.status ?? -1, code: asZeck.body?.code ?? "UNEXPECTED" };
        }
      };
      const read = await foreignError(() => client.getExecution(foreignExecution.executionId));
      expect(read).toEqual({ status: 404, code: "CAPABILITY_UNAVAILABLE" });
      const cancel = await foreignError(() =>
        client.cancelExecution(foreignExecution.executionId, `val-024-wire-cancel-${runTag}`),
      );
      expect(cancel).toEqual({ status: 404, code: "CAPABILITY_UNAVAILABLE" });
      const results = await foreignError(() => client.getResult(foreignExecution.executionId));
      expect(results).toEqual({ status: 404, code: "CAPABILITY_UNAVAILABLE" });
      const envCreate = await foreignError(() =>
        client.createExecution(
          {
            applicationId: world.applicationId,
            environmentId: foreignEnvironmentId,
            task: { kind: "probe" },
          },
          `val-024-wire-env-${runTag}`,
        ),
      );
      expect(envCreate).toEqual({ status: 403, code: "TENANT_SCOPE_VIOLATION" });
      const appCreate = await foreignError(() =>
        client.createExecution(
          { applicationId: world.otherApplicationId, task: { kind: "probe" } },
          `val-024-wire-app-${runTag}`,
        ),
      );
      expect(appCreate).toEqual({ status: 403, code: "AUTHORIZATION_DENIED" });
      const forgedClient = createZeckClient({
        baseUrl: address,
        token: world.bearerToken,
        applicationId: world.otherApplicationId,
        fetchImpl: globalThis.fetch,
      });
      const forgedRead = await foreignError(() =>
        forgedClient.getExecution(foreignExecution.executionId),
      );
      expect(forgedRead).toEqual({ status: 403, code: "AUTHORIZATION_DENIED" });
    } finally {
      await world.server.app.close();
    }
  });
});
