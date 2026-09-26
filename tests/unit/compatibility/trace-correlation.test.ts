/**
 * PPR-017 — the Zeck trace correlation test (the work order: "Zeck
 * trace correlation test").
 *
 * Correlation maps every delegated edge to Zeck execution identifiers
 * and evidence THROUGH THE EXISTING executions public surface (never
 * reimplementing it). This test pins:
 *  - the in-process adapter (createExecutionsServiceTraceSource) over
 *    a stub of the executions module's PUBLIC service shape — the
 *    exact seam the integration is allowed to consume;
 *  - the correlation service op (correlate) over that adapter: it
 *    reads every delegated edge's declared executions and produces the
 *    durable trace facts (identity, lifecycle status, event count,
 *    verification counts, correlated);
 *  - the rule-4 semantics: found + events + verification results ⇒
 *    correlated; found without verification results ⇒ NOT correlated
 *    (a found execution without durable evidence proves nothing);
 *  - the optional route/cost/usage facts project from the canonical
 *    ledger events and stay honestly null when the ledger carries no
 *    such facts;
 *  - no trace source bound ⇒ correlation fails closed (NOT RUN, never
 *    a fabricated trace fact).
 */

import { describe, expect, test } from "vitest";
import {
  type CompatibilityEvidenceRecord,
  CompatibilityFlowError,
  createCompatibilityService,
  createExecutionsServiceTraceSource,
  type EdgeDispositionEntry,
  type ExecutionGraphEdge,
  traceFactResolved,
  type ZeckTraceSource,
  zeckTraceFactOf,
} from "../../../src/integrations/compatibility/public";
import type { ExecutionService } from "../../../src/modules/executions/public";

const APP_ID = "00000000-0000-7000-8000-0000000000c1";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d1";
const MISSING_EXECUTION_ID = "00000000-0000-7000-8000-0000000000d9";

const MAIN_EDGE: ExecutionGraphEdge = {
  edgeId: "main-completion",
  component: "chat loop",
  surface: "text-generation",
  transport: "provider client",
  externalExecution: "provider model",
  materiality: "the main model call",
};

/** A stub of the executions module's PUBLIC service (the only seam consumed). */
function stubExecutionsService(): ExecutionService {
  return {
    async getExecution(_applicationId: string, executionId: string) {
      if (executionId === EXECUTION_ID) {
        return {
          id: EXECUTION_ID,
          applicationId: APP_ID,
          tenantId: "00000000-0000-7000-8000-0000000000t1",
          environmentId: null,
          status: "COMPLETED",
          task: { kind: "summarize" },
          constraints: null,
          metadata: {},
          createdAt: "2026-09-26T00:00:00Z",
          updatedAt: "2026-09-26T00:01:00Z",
          terminalAt: "2026-09-26T00:01:00Z",
          lastEventSequence: 6,
        };
      }
      return null;
    },
    async listEvents(_applicationId: string, executionId: string) {
      if (executionId !== EXECUTION_ID) {
        return [];
      }
      return [
        {
          eventId: "evt-1",
          executionId,
          applicationId: APP_ID,
          tenantId: "00000000-0000-7000-8000-0000000000t1",
          sequence: 1,
          type: "execution.created",
          command: "created",
          actor: {},
          cause: null,
          reference: {},
          payload: {},
          occurredAt: "2026-09-26T00:00:00Z",
        },
        {
          eventId: "evt-2",
          executionId,
          applicationId: APP_ID,
          tenantId: "00000000-0000-7000-8000-0000000000t1",
          sequence: 2,
          type: "planning.decision-recorded",
          command: "plan",
          actor: {},
          cause: null,
          reference: {},
          payload: {
            candidates: [
              {
                strategyId: "hybrid-1",
                plan: {
                  steps: [{ routeRef: { provider: "neutral-provider", model: "neutral-model" } }],
                  strategyClass: "hybrid",
                  modelCalls: 1,
                },
              },
            ],
            selectedStrategyId: "hybrid-1",
          },
          occurredAt: "2026-09-26T00:00:10Z",
        },
        {
          eventId: "evt-3",
          executionId,
          applicationId: APP_ID,
          tenantId: "00000000-0000-7000-8000-0000000000t1",
          sequence: 3,
          type: "execution.completed",
          command: "verify",
          actor: {},
          cause: null,
          reference: {},
          payload: { costMicroUsd: "4180000", usage: { inputTokens: 120, outputTokens: 80 } },
          occurredAt: "2026-09-26T00:01:00Z",
        },
      ];
    },
    async listVerificationResults(_applicationId: string, executionId: string) {
      if (executionId !== EXECUTION_ID) {
        return [];
      }
      return [
        {
          id: "ver-1",
          executionId,
          applicationId: APP_ID,
          tenantId: "00000000-0000-7000-8000-0000000000t1",
          criterionId: "summary-length",
          strategy: "deterministic-length",
          status: "PASS",
          evidence: ["artifact-1"],
          recordedBy: "deterministic-evaluator",
          recordedAt: "2026-09-26T00:01:00Z",
        },
      ];
    },
    // The correlation path never writes; the remaining service members
    // are unreachable seams on this stub.
    async createExecution() {
      throw new Error("the correlation path never creates executions");
    },
    async transition() {
      throw new Error("the correlation path never transitions executions");
    },
    async recordPlanningDecision() {
      throw new Error("the correlation path never records planning decisions");
    },
    async recordStepEvent() {
      throw new Error("the correlation path never records step events");
    },
  } as unknown as ExecutionService;
}

function delegatedRecord(): CompatibilityEvidenceRecord {
  return {
    recordId: "correlation-test-record",
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Synthetic correlation test application",
        repository: "https://example.invalid/synthetic-correlation",
        applicationId: APP_ID,
      },
      pin: { upstreamRevision: "a".repeat(40), integrationRevision: "b".repeat(40) },
    },
    graph: { edges: [MAIN_EDGE] },
    dispositions: [
      {
        edgeId: "main-completion",
        disposition: "delegated",
        zeckExecutionIds: [EXECUTION_ID, MISSING_EXECUTION_ID],
        evidenceBasis: "live",
      } satisfies EdgeDispositionEntry,
    ],
    egressObservation: { mode: "observe", status: "observed-clean", violations: [] },
    providerCredentials: [],
    runtimeEvidence: { corpusDeclared: true, corpusUsability: "verified", observations: [] },
    comparison: [],
    zeckTraces: [],
    limitations: [],
    notRunCauses: [],
    recordedAt: "2026-09-26T00:00:00Z",
  };
}

describe("the Zeck trace correlation (through the executions public surface)", () => {
  test("the adapter maps the executions public service onto the neutral trace views", async () => {
    const source = createExecutionsServiceTraceSource({ service: stubExecutionsService() });
    const read = await source.readExecutionTrace(APP_ID, EXECUTION_ID);
    expect(read.execution).toEqual({
      id: EXECUTION_ID,
      applicationId: APP_ID,
      status: "COMPLETED",
      terminal: true,
    });
    expect(read.events).toHaveLength(3);
    expect(read.events.map((event) => event.type)).toEqual([
      "execution.created",
      "planning.decision-recorded",
      "execution.completed",
    ]);
    expect(read.verification).toEqual([{ id: "ver-1", status: "PASS" }]);
  });

  test("the optional route/cost/usage facts project from the canonical ledger events", async () => {
    const source = createExecutionsServiceTraceSource({ service: stubExecutionsService() });
    const read = await source.readExecutionTrace(APP_ID, EXECUTION_ID);
    expect(read.route).toEqual({
      provider: "neutral-provider",
      model: "neutral-model",
      strategyClass: "hybrid",
    });
    expect(read.costMicroUsd).toBe("4180000");
    expect(read.usage).toEqual({ inputTokens: 120, outputTokens: 80 });
  });

  test("an absent execution reads as not-found with honest null facts (never fabricated)", async () => {
    const source = createExecutionsServiceTraceSource({ service: stubExecutionsService() });
    const read = await source.readExecutionTrace(APP_ID, MISSING_EXECUTION_ID);
    expect(read.execution).toBeNull();
    expect(read.events).toEqual([]);
    expect(read.verification).toEqual([]);
    expect(read.route).toBeNull();
    expect(read.costMicroUsd).toBeNull();
    expect(read.usage).toBeNull();
  });

  test("correlate produces the durable trace facts for every declared execution of every delegated edge", async () => {
    const service = createCompatibilityService({
      traceSource: createExecutionsServiceTraceSource({ service: stubExecutionsService() }),
    });
    const facts = await service.correlate(delegatedRecord());
    expect(facts).toHaveLength(2);
    const found = facts.find((fact) => fact.executionId === EXECUTION_ID);
    expect(found).toMatchObject({
      edgeId: "main-completion",
      applicationId: APP_ID,
      found: true,
      status: "COMPLETED",
      terminal: true,
      eventCount: 3,
      verificationCount: 1,
      passingVerificationCount: 1,
      correlated: true,
    });
    expect(traceFactResolved(found as never)).toBe(true);
    const missing = facts.find((fact) => fact.executionId === MISSING_EXECUTION_ID);
    expect(missing).toMatchObject({ found: false, correlated: false });
    expect(traceFactResolved(missing as never)).toBe(false);
  });

  test("correlated requires durable evidence: a found execution WITHOUT verification results is not correlated", async () => {
    const fact = zeckTraceFactOf("main-completion", APP_ID, EXECUTION_ID, {
      execution: { id: EXECUTION_ID, applicationId: APP_ID, status: "COMPLETED", terminal: true },
      events: [{ eventId: "evt-1", sequence: 1, type: "execution.created" }],
      verification: [],
      route: null,
      costMicroUsd: null,
      usage: null,
    });
    expect(fact.found).toBe(true);
    expect(fact.correlated).toBe(false);
  });

  test("no trace source bound ⇒ correlation FAILS CLOSED (NOT RUN, never fabricated)", async () => {
    const service = createCompatibilityService();
    await expect(service.correlate(delegatedRecord())).rejects.toBeInstanceOf(
      CompatibilityFlowError,
    );
    await expect(service.correlate(delegatedRecord())).rejects.toThrow(/NOT RUN/);
  });

  test("the correlated facts satisfy rule 4 when recorded back into the evidence record", async () => {
    const service = createCompatibilityService({
      traceSource: createExecutionsServiceTraceSource({ service: stubExecutionsService() }),
    });
    const record = delegatedRecord();
    const facts = await service.correlate(record);
    const withTraces: CompatibilityEvidenceRecord = { ...record, zeckTraces: facts };
    const assessment = service.assess(withTraces, {
      source: "synthetic discovery",
      edges: [MAIN_EDGE],
    });
    // The missing execution (a declared id that the surface cannot
    // find) is a named rule-4 defect — the assessment stays honest.
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "ZECK_TRACE_NOT_FOUND")).toBe(
      true,
    );
  });

  test("an SDK-shaped out-of-process consumer can implement the port (the neutral contract)", async () => {
    // The port is implementable over the public WIRE shapes alone —
    // the sibling integrations (PPR-018/019) drive Zeck through the
    // SDK; this stub mirrors that shape (wire vocabulary strings).
    const sdkShapedSource: ZeckTraceSource = {
      async readExecutionTrace(applicationId, executionId) {
        if (executionId !== EXECUTION_ID) {
          return {
            execution: null,
            events: [],
            verification: [],
            route: null,
            costMicroUsd: null,
            usage: null,
          };
        }
        return {
          execution: {
            id: executionId,
            applicationId,
            status: "COMPLETED",
            terminal: true,
          },
          events: [{ eventId: "evt-1", sequence: 1, type: "execution.created" }],
          verification: [{ id: "ver-1", status: "PASS" }],
          route: null,
          costMicroUsd: null,
          usage: null,
        };
      },
    };
    const service = createCompatibilityService({ traceSource: sdkShapedSource });
    const facts = await service.correlate(delegatedRecord());
    const found = facts.find((fact) => fact.executionId === EXECUTION_ID);
    expect(found?.correlated).toBe(true);
  });
});
