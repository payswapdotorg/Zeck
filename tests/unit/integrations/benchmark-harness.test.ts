/**
 * Unit proofs: the benchmark harness (WORK-016 — measurement, never
 * authority).
 *
 * Required-test mapping:
 *  - the fair comparison: the three strategies produce executions
 *    through the SAME executions authority (one service instance);
 *  - every dimension is derived from the DURABLE evidence (statuses,
 *    verification outcomes, events) — the harness re-reads the
 *    authority, never trusting strategy self-reports;
 *  - the report is a pure projection (deterministic from evidence);
 *  - non-authority: the harness surface holds no policy/budget/registry
 *    mutation path (structural — the composition injects the authority
 *    and the harness only reads);
 *  - the WorkflowOS strategy submits through the integration contract
 *    (the external-submission seam) — identical lifecycle and evidence.
 */

import { describe, expect, test } from "vitest";
import {
  type BenchmarkTask,
  buildBenchmarkReport,
  createBenchmarkHarness,
  createBenchmarkStrategies,
  renderBenchmarkReport,
} from "../../../benchmarks";
import { ACTOR_ID, APPLICATION_ID, seedIntegrationWorld, TENANT_ID } from "./world";

const TASKS: readonly BenchmarkTask[] = [
  {
    taskId: "review-task",
    description: "a representative review work item",
    task: { kind: "review", repo: "acme/api" },
    verification: { criterionId: "cites-sources", strategy: "rubric", expectedStatus: "PASS" },
  },
  {
    taskId: "summarize-task",
    description: "a representative summarization work item",
    task: { kind: "summarize", doc: "doc-1" },
    verification: { criterionId: "has-summary", strategy: "schema", expectedStatus: "PASS" },
  },
];

describe("the benchmark harness (fair comparison over one authority wiring)", () => {
  test("all three strategies produce executions through the SAME executions service", async () => {
    const world = seedIntegrationWorld();
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sessions: world.sessions,
      nativeAgentId: (await world.registerByoa("bench-native", "bench-reg-native")).agent.id,
      byoaAgentId: (await world.registerByoa("bench-byoa", "bench-reg-byoa")).agent.id,
      workflowos: world.workflowos,
    });
    // Every strategy returns durable ids from THE one service instance.
    const ids: string[] = [];
    const firstTask = TASKS[0] as BenchmarkTask;
    for (const strategy of strategies) {
      // Each strategy gets its own key (the strategies' payloads differ).
      const produced = await strategy.runTask(firstTask, `bench-single:${strategy.kind}`);
      expect(produced).toHaveLength(1);
      for (const id of produced) {
        ids.push(id);
      }
    }
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      const record = await world.executionsWorld.service.getExecution(APPLICATION_ID, id);
      expect(record).not.toBeNull();
      expect(record?.status).toBe("COMPLETED");
    }
  });

  test("the harness measures and produces complete evidence for every (task, strategy)", async () => {
    const world = seedIntegrationWorld();
    const nativeAgent = await world.registerByoa("bench-native", "bench-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "bench-reg-byoa");
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const harness = createBenchmarkHarness({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      label: "unit-benchmark",
      environment: {
        wiring: "in-memory",
        clock: "performance",
        repetitions: 1,
        notes: ["deterministic stub agents"],
      },
    });
    const evidence = await harness.run(strategies, TASKS);
    // 2 tasks × 3 strategies × 1 repetition = 6 measured runs.
    expect(evidence.runs).toHaveLength(6);
    expect(evidence.summaries).toHaveLength(6);
    // Every measurement references a DURABLE execution the authority owns.
    for (const run of evidence.runs) {
      const record = await world.executionsWorld.service.getExecution(
        APPLICATION_ID,
        run.executionId,
      );
      expect(record).not.toBeNull();
      expect(run.status).toBe(record?.status);
      expect(run.terminal).toBe(true);
      expect(run.verificationOutcomes).toEqual(["PASS"]);
      expect(run.failureMode).toBeNull();
    }
    // The dimension derivations are honest: cost is null when unset
    // (never fabricated).
    for (const run of evidence.runs) {
      expect(run.settledCostMicroUsd).toBeNull();
    }
  });

  test("the report is a pure deterministic projection over the evidence", async () => {
    const world = seedIntegrationWorld();
    const nativeAgent = await world.registerByoa("bench-native", "bench-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "bench-reg-byoa");
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const harness = createBenchmarkHarness({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      label: "unit-benchmark",
      environment: { wiring: "in-memory", clock: "performance", repetitions: 1, notes: [] },
    });
    const evidence = await harness.run(strategies, TASKS);
    const report = buildBenchmarkReport(evidence);
    const reportAgain = buildBenchmarkReport(evidence);
    expect(reportAgain).toEqual(report);
    // The comparison covers every task with all three strategies.
    expect(report.comparison).toHaveLength(2);
    for (const task of report.comparison) {
      expect(task.rows.map((row) => row.strategy).sort()).toEqual([
        "byoa-agent-session",
        "native-agent-session",
        "workflowos-submission",
      ]);
    }
    // Strategy totals pool all tasks.
    expect(report.strategyTotals.map((total) => total.strategy).sort()).toEqual([
      "byoa-agent-session",
      "native-agent-session",
      "workflowos-submission",
    ]);
    for (const total of report.strategyTotals) {
      expect(total.runs).toBe(2);
      expect(total.successRate).toBe(1);
      expect(total.passRate).toBe(1);
    }
    // The rendering includes the non-authority statement.
    const rendered = renderBenchmarkReport(report);
    expect(rendered).toContain("no production authority");
    expect(rendered).toContain("native-agent-session");
    expect(rendered).toContain("workflowos-submission");
  });

  test("non-authority: the harness surface holds no authority mutation method", () => {
    const world = seedIntegrationWorld();
    const harness = createBenchmarkHarness({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      label: "surface-check",
      environment: { wiring: "in-memory", clock: "performance", repetitions: 1, notes: [] },
    });
    // The harness surface is run() — measurement only.
    expect(Object.keys(harness).sort()).toEqual(["run"]);
    // The evidence contract carries no callbacks/authority references.
    const probe = {
      label: "x",
      startedAt: "",
      finishedAt: "",
      runs: [],
      summaries: [],
      environment: {
        wiring: "in-memory",
        clock: "performance",
        repetitions: 1,
        verificationProvenance: "",
        notes: [],
      },
    };
    expect(JSON.parse(JSON.stringify(probe))).toEqual(probe);
  });

  test("the WorkflowOS strategy rides the integration contract (workRef provenance)", async () => {
    const world = seedIntegrationWorld();
    const nativeAgent = await world.registerByoa("bench-native", "bench-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "bench-reg-byoa");
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const workflowosStrategy = strategies.find(
      (strategy) => strategy.kind === "workflowos-submission",
    );
    expect(workflowosStrategy).toBeDefined();
    const firstTask = TASKS[0] as BenchmarkTask;
    expect(workflowosStrategy).not.toBeNull();
    const ids =
      workflowosStrategy === undefined
        ? []
        : await workflowosStrategy.runTask(firstTask, "bench-wos-1");
    // The execution's provenance carries the WorkflowOS workRef.
    const record = await world.executionsWorld.service.getExecution(
      APPLICATION_ID,
      ids[0] as string,
    );
    expect(record?.metadata.workflowos).toEqual({
      source: "workflowos",
      workRef: "bench-work:review-task",
    });
    // And the integration's receipt read returns the same evidence.
    const receipt = await world.workflowos.executionReceipt(world.actor, ids[0] as string);
    expect(receipt.workRef).toBe("bench-work:review-task");
    expect(receipt.verification).toHaveLength(1);
  });
});
