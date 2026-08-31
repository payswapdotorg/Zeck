/**
 * Real-PostgreSQL proofs: BYOA interop + the benchmark harness
 * (WORK-016 / AGT-007, ACP-005 — the durable halves).
 *
 * Required-test mapping:
 *  - BYOA registration over the REAL SQL registry (durable identity,
 *    version, promotion; idempotent retries converge);
 *  - the governed session through the REAL policy admission over the
 *    SQL store (the external wrapper rides the same chain);
 *  - the external side receives ONLY references over real rows;
 *  - the benchmark harness over real SQL: durable benchmark evidence —
 *    every referenced execution/verification row is authoritative
 *    platform state (provenance = the durable ledger);
 *  - the fair comparison completes under real SQL for all three
 *    strategies;
 *  - benchmark non-authority: the evidence record is pure data.
 */

import { expect, test } from "vitest";
import {
  type BenchmarkTask,
  buildBenchmarkReport,
  createBenchmarkHarness,
  createBenchmarkStrategies,
} from "../../../benchmarks";
import {
  BYOA_RUNTIME_KIND,
  createByoaAgentProvider,
} from "../../../src/integrations/workflowos/public";
import { definePgSuite } from "./harness";
import { pgStubExternalAgent, seedIntegrationPgWorld } from "./integrations-world";

definePgSuite("BYOA interop over real PostgreSQL (AGT-007/ACP-005)", (ctx) => {
  test("registration lands in the REAL SQL registry (no second registry)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const outcome = await world.registerByoa("pg-byoa-1", "pg-byoa-reg-1");
    // The durable agent row exists in the agents table.
    const agentRow = await ctx.port.execute<{ slug: string; tenant_id: string }>({
      sql: `SELECT slug, tenant_id FROM agents.agents WHERE id = $1`,
      parameters: [outcome.agent.id],
    });
    expect(agentRow.rows[0]?.slug).toBe("pg-byoa-1");
    expect(agentRow.rows[0]?.tenant_id).toBe(world.tenantId);
    // The immutable version row + the selection record.
    const versionRow = await ctx.port.execute<{ version: string }>({
      sql: `SELECT version FROM agents.agent_versions WHERE id = $1`,
      parameters: [outcome.version.id],
    });
    expect(versionRow.rows[0]?.version).toBe("1.0.0");
    const selectionRow = await ctx.port.execute<{ selected_version_id: string }>({
      sql: `SELECT selected_version_id FROM agents.agent_selections WHERE agent_id = $1 ORDER BY selected_at DESC LIMIT 1`,
      parameters: [outcome.agent.id],
    });
    expect(selectionRow.rows[0]?.selected_version_id).toBe(outcome.version.id);
  });

  test("registration retries converge (idempotent through the authority)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const first = await world.registerByoa("pg-byoa-2", "pg-byoa-reg-2");
    const second = await world.registerByoa("pg-byoa-2", "pg-byoa-reg-2");
    expect(second.agent.id).toBe(first.agent.id);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM agents.agents WHERE slug = $1 AND application_id = $2`,
      parameters: ["pg-byoa-2", world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("a governed session runs the external agent through the REAL admission chain", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const outcome = await world.registerByoa("pg-byoa-3", "pg-byoa-reg-3");
    // Seed a RUNNING execution through the REAL SQL service.
    const receipt = await world.executions.createExecution(
      { applicationId: world.applicationId, task: { kind: "byoa-run" } },
      "pg-byoa-3-create",
      { actorId: world.actor.actorId, tenantId: world.tenantId },
    );
    const executionId = receipt.executionId;
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await world.executions.transition(
        {
          command,
          applicationId: world.applicationId,
          executionId,
          actorId: world.actor.actorId,
          tenantId: world.tenantId,
        },
        `pg-byoa-3-${command}`,
      );
    }
    const provider = createByoaAgentProvider(pgStubExternalAgent());
    expect(provider.runtimeKind).toBe(BYOA_RUNTIME_KIND);
    const session = await world.sessions.createSession(
      { executionId, agentId: outcome.agent.id, inputDigest: "digest:pg-byoa-3" },
      "pg-byoa-3-session",
      {
        actorId: world.actor.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      },
    );
    const observation = await world.sessions.runSession(session.id, provider, "pg-byoa-3-run", {
      actorId: world.actor.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(observation.outcomeClass).toBe("session-success");
    // The session evidence is DURABLE on the real ledger.
    const events = await world.executions.listEvents(world.applicationId, executionId);
    const types = events.map((event) => event.type);
    expect(types).toContain("execution.agent-session-started");
    expect(types).toContain("execution.agent-session-completed");
  });

  test("the external side receives ONLY references over real rows (M23/M24)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const outcome = await world.registerByoa("pg-byoa-4", "pg-byoa-reg-4");
    const receipt = await world.executions.createExecution(
      { applicationId: world.applicationId, task: { kind: "byoa-run" } },
      "pg-byoa-4-create",
      { actorId: world.actor.actorId, tenantId: world.tenantId },
    );
    const executionId = receipt.executionId;
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await world.executions.transition(
        {
          command,
          applicationId: world.applicationId,
          executionId,
          actorId: world.actor.actorId,
          tenantId: world.tenantId,
        },
        `pg-byoa-4-${command}`,
      );
    }
    const seen: unknown[] = [];
    const inspecting = {
      descriptor: { name: "pg-inspector", version: "1.0.0" },
      async executeSession(identity: unknown, task: { inputDigest: string }) {
        seen.push(identity);
        return {
          outcomeClass: "session-success" as const,
          outputDigest: `inspected:${task.inputDigest}`,
          output: null,
          failureReason: null,
        };
      },
    };
    const session = await world.sessions.createSession(
      { executionId, agentId: outcome.agent.id, inputDigest: "digest:pg-byoa-4" },
      "pg-byoa-4-session",
      {
        actorId: world.actor.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      },
    );
    await world.sessions.runSession(
      session.id,
      createByoaAgentProvider(inspecting),
      "pg-byoa-4-run",
      {
        actorId: world.actor.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      },
    );
    const identity = seen[0] as {
      credentials: readonly { grantId: string; scopeKind: string; scopeRef: string }[];
      permissions: { tools: readonly string[] };
    };
    expect(identity.permissions.tools).toEqual(["search-web"]);
    for (const grant of identity.credentials) {
      expect(Object.keys(grant).sort()).toEqual(["grantId", "scopeKind", "scopeRef"]);
    }
  });
});

definePgSuite("the benchmark harness over real PostgreSQL (§19–§22)", (ctx) => {
  const TASKS: readonly BenchmarkTask[] = [
    {
      taskId: "pg-review",
      description: "a representative review work item",
      task: { kind: "review", repo: "acme/api" },
      verification: { criterionId: "cites-sources", strategy: "rubric", expectedStatus: "PASS" },
    },
  ];

  async function benchmarkOverRealSql() {
    const world = await seedIntegrationPgWorld(ctx.port);
    const nativeAgent = await world.registerByoa("bench-native", "bench-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "bench-reg-byoa");
    const strategies = createBenchmarkStrategies({
      executions: world.executions,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actor.actorId,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const harness = createBenchmarkHarness({
      executions: world.executions,
      applicationId: world.applicationId,
      label: "pg-benchmark",
      environment: {
        wiring: "postgresql",
        clock: "performance",
        repetitions: 1,
        notes: ["real SQL authority wiring"],
      },
    });
    return { world, strategies, harness };
  }

  test("durable benchmark evidence: every referenced row is authoritative platform state", async () => {
    const { strategies, harness } = await benchmarkOverRealSql();
    const evidence = await harness.run(strategies, TASKS);
    expect(evidence.runs).toHaveLength(3);
    for (const run of evidence.runs) {
      // The referenced execution is a REAL durable row.
      const row = await ctx.port.execute<{ status: string }>({
        sql: `SELECT status FROM executions.executions WHERE id = $1`,
        parameters: [run.executionId],
      });
      expect(row.rows[0]?.status).toBe(run.status);
      expect(run.status).toBe("COMPLETED");
      // The verification outcome is a REAL durable result row.
      const verification = await ctx.port.execute<{ status: string }>({
        sql: `SELECT status FROM executions.verification_results WHERE execution_id = $1`,
        parameters: [run.executionId],
      });
      expect(verification.rows).toHaveLength(1);
      expect(verification.rows[0]?.status).toBe(run.verificationOutcomes[0]);
    }
    // The evidence record itself is pure data (no authority power).
    expect(() => JSON.parse(JSON.stringify(evidence))).not.toThrow();
  });

  test("the fair comparison completes under real SQL for all three strategies (§20)", async () => {
    const { world, strategies, harness } = await benchmarkOverRealSql();
    const evidence = await harness.run(strategies, TASKS);
    const byStrategy = new Map(evidence.runs.map((run) => [run.strategy, run]));
    expect([...byStrategy.keys()].sort()).toEqual([
      "byoa-agent-session",
      "native-agent-session",
      "workflowos-submission",
    ]);
    for (const run of byStrategy.values()) {
      expect(run.terminal).toBe(true);
      expect(run.verificationOutcomes).toEqual(["PASS"]);
      expect(run.failureMode).toBeNull();
    }
    // The WorkflowOS-submission run carries the provenance (round trip).
    const wosRun = byStrategy.get("workflowos-submission");
    expect(wosRun).toBeDefined();
    const record = await world.executions.getExecution(
      world.applicationId,
      wosRun?.executionId ?? "",
    );
    expect(record?.metadata.workflowos).toEqual({
      source: "workflowos",
      workRef: "bench-work:pg-review",
    });
  });

  test("the report is a pure projection over the real-SQL evidence (§21)", async () => {
    const { strategies, harness } = await benchmarkOverRealSql();
    const evidence = await harness.run(strategies, TASKS);
    const report = buildBenchmarkReport(evidence);
    expect(report.strategyTotals).toHaveLength(3);
    for (const total of report.strategyTotals) {
      expect(total.runs).toBe(1);
      expect(total.successRate).toBe(1);
      expect(total.passRate).toBe(1);
    }
    // The report's environment block records the real wiring honestly.
    expect(report.evidence.environment.wiring).toBe("postgresql");
    expect(report.evidence.environment.verificationProvenance).toContain("benchmark-harness");
  });
});
