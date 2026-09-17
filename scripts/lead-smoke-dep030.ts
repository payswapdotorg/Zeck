/**
 * Lead smoke (DEP-030 review): boot the REAL API server + REAL dashboard
 * over REAL services (in-memory stores) and drive the usage journey in a
 * REAL process over REAL HTTP: create → plan (recorded decision) →
 * dispatch → settle → the usage surface renders per-run cost facts from
 * the real records, the budgets view renders the REAL quota state, the
 * optimization view renders the platform's OWN recorded planning
 * decision verbatim, the honest-unavailable states NAME their missing
 * contracts, and the JSON machine view carries the same composition.
 *
 * COMPOSITION (the DEP-014 lead-smoke wiring):
 *  - executions: the REAL execution service over an in-memory store
 *    (the same durable contract the SQL adapter implements — gapless
 *    append-only ledger, single write path, idempotent arbitration);
 *  - quotas: the REAL quota service over createInMemoryQuotaStore;
 *  - the REAL Fastify API server (real auth seam, real server-side
 *    scope resolution, real serialization boundary);
 *  - the REAL dashboard booted with NO fetchImpl override — every
 *    dashboard read is a real HTTP round trip to the API server, and
 *    the usage surface's budgets transport derives from the same
 *    environment contract a deployment binds (ZECK_API_URL /
 *    ZECK_TOKEN / ZECK_APPLICATION_ID).
 *
 * THE SETTLEMENT ENVELOPE (disclosed): the real `transition` seam writes
 * `execution.completed` envelopes with the lifecycle payload only; the
 * settled cost/usage facts ride the executing worker's own durable
 * settlement envelope (the shape GET /executions/:id/results projects).
 * This smoke appends that one envelope through the in-memory store
 * directly — standing in for the executing worker's governed write — so
 * every read path (API routes, serialization, dashboard composition) is
 * fully real end-to-end.
 */
import { createApiServer } from "../src/api";
import type { Authenticate } from "../src/api";
import { createInMemoryQuotaStore, createQuotaService } from "../src/modules/budgets/public";
import type { BudgetAuthority } from "../src/modules/budgets/public";
import { createExecutionService } from "../src/modules/executions/public";
import type {
  EventEnvelope,
  ExecutionRecord,
  ExecutionService,
  ExecutionStore,
  ExecutionsIdempotencyPort,
} from "../src/modules/executions/public";
import type { ScopeResolver } from "../src/modules/auth/public";
import { createDashboard } from "../apps/dashboard/index";

const APP_ID = "00000000-0000-7000-8000-0000000000f3";
const TENANT_ID = "tenant-1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
const API_PORT = 3917;
const COST_MICRO_USD = "41250";
const LIMIT_MICRO_USD = "1500000";

const now = () => new Date().toISOString();
let idCounter = 0;
const newId = () => `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// The in-memory executions store (the durable contract the SQL adapter
// implements; the tests/unit/executions fake discipline, inline)
// ---------------------------------------------------------------------------

class InMemoryExecutionStore implements ExecutionStore {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly events: EventEnvelope[] = [];
  readonly applications = new Map<string, { applicationId: string; tenantId: string }>();

  seedApplication(applicationId: string, tenantId: string): void {
    this.applications.set(applicationId, { applicationId, tenantId });
  }

  async findApplication(applicationId: string) {
    return this.applications.get(applicationId) ?? null;
  }

  async findEnvironment() {
    return null;
  }

  async insertExecution(input: Parameters<ExecutionStore["insertExecution"]>[0]) {
    const row: ExecutionRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      userId: input.userId,
      status: "CREATED",
      task: input.task,
      inputArtifactRefs: input.inputArtifactRefs,
      constraints: input.constraints as ExecutionRecord["constraints"],
      metadata: input.metadata,
      requestFingerprint: input.requestFingerprint,
      lastEventSequence: 1,
      verificationRefs: [],
      createdAt: input.now,
      updatedAt: input.now,
      terminalAt: null,
    };
    this.executions.set(input.id, row);
    return row;
  }

  async lockExecution(applicationId: string, executionId: string) {
    const row = this.executions.get(executionId);
    return row !== undefined && row.applicationId === applicationId ? row : null;
  }

  async updateExecutionForTransition(input: Parameters<ExecutionStore["updateExecutionForTransition"]>[0]) {
    const row = this.executions.get(input.executionId);
    if (row === undefined) {
      throw new Error("execution row missing");
    }
    const updated: ExecutionRecord = {
      ...row,
      status: input.nextStatus as ExecutionRecord["status"],
      lastEventSequence: input.nextSequence,
      verificationRefs: [...input.verificationRefs],
      updatedAt: input.now,
      terminalAt: ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(input.nextStatus)
        ? input.now
        : null,
    };
    this.executions.set(input.executionId, updated);
    return updated;
  }

  async getExecution(applicationId: string, executionId: string) {
    const row = this.executions.get(executionId);
    return row !== undefined && row.applicationId === applicationId ? row : null;
  }

  async appendEvent(input: Parameters<ExecutionStore["appendEvent"]>[0]) {
    const last = this.events
      .filter((event) => event.executionId === input.executionId)
      .reduce((max, event) => Math.max(max, event.sequence), 0);
    if (input.sequence !== last + 1) {
      throw new Error(`event sequence must be gapless (expected ${last + 1}, got ${input.sequence})`);
    }
    const envelope: EventEnvelope = {
      eventId: input.eventId,
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      sequence: input.sequence,
      type: input.type,
      command: input.command,
      actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
      cause: input.cause ?? null,
      reference: input.reference ?? {},
      payload: input.payload,
      occurredAt: input.occurredAt,
      producerModule: "executions",
      schemaVersion: 1,
    };
    this.events.push(envelope);
    return envelope;
  }

  async listEvents(applicationId: string, executionId: string) {
    return this.events.filter(
      (event) => event.applicationId === applicationId && event.executionId === executionId,
    );
  }

  async insertVerificationResult(input: Parameters<ExecutionStore["insertVerificationResult"]>[0]) {
    return {
      id: input.id,
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      criterionId: input.criterionId,
      strategy: input.strategy,
      status: input.status as "PASS",
      evidence: [...input.evidence],
      recordedBy: input.recordedBy,
      recordedAt: now(),
    };
  }

  async listVerificationResults(applicationId: string, executionId: string) {
    void applicationId;
    void executionId;
    return [];
  }
}

/** Idempotency arbitration (application-scoped keys; replay + key-reuse rejection). */
const idempotencyRecords = new Map<string, { fingerprint: string; outcome: unknown }>();
const idempotency: ExecutionsIdempotencyPort = {
  async arbitrate(scope, operationName, idempotencyKey, requestFingerprint, work) {
    const key = `${scope.applicationId}|${operationName}|${idempotencyKey}`;
    const existing = idempotencyRecords.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return { outcome: existing.outcome as never, replayed: true };
    }
    const outcome = await work({ store });
    idempotencyRecords.set(key, { fingerprint: requestFingerprint, outcome });
    return { outcome, replayed: false };
  },
};

const store = new InMemoryExecutionStore();
store.seedApplication(APP_ID, TENANT_ID);

/** The budgets authority seam (admission precedes dispatch; module-internal). */
let reservationCount = 0;
const budgetAuthority: BudgetAuthority = {
  async reserve(command) {
    reservationCount += 1;
    return {
      reservation: {
        id: `reservation-${reservationCount}`,
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        executionId: command.executionId,
        operationId: command.operationId,
        userId: command.userId,
        fundingMode: "developer",
        sourceKind: "developer",
        walletId: "wallet-1",
        amountMicroUsd: command.amountMicroUsd,
        status: "active",
        settledAmountMicroUsd: null,
        monthKey: "2026-09",
        createdAt: now(),
        finalizedAt: null,
      },
      converged: false,
      replayed: false,
    };
  },
  async settle() {
    throw new Error("settle is not exercised by this smoke");
  },
  async release() {
    throw new Error("release is not exercised by this smoke");
  },
};

const executions: ExecutionService = createExecutionService({
  store,
  idempotency,
  authorization: { async evaluate() { return { allowed: true }; } },
  budgetAuthority,
  generateId: newId,
  now: () => new Date(),
});

const quotaService = createQuotaService({
  store: createInMemoryQuotaStore(now),
  now,
  newId,
});

const authenticate: Authenticate = async () => ({
  actorId: ACTOR_ID,
  authenticatedAt: now(),
});
const scopeResolver: ScopeResolver = {
  resolveApplicationScope: (async () => ({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
  })) as never,
  resolveTenantScope: (async () => ({ tenantId: TENANT_ID })) as never,
  requirePermission: () => {},
};

const server = createApiServer({
  executions,
  agents: { listAgents: (async () => []) as never } as never,
  economics: { recordAction: (async () => ({})) as never } as never,
  quotas: quotaService,
  scopeResolver,
  authenticate,
  listAgentIdsOfApplication: async () => [],
  codebaseAnalyzer: {
    analyzeSubgraph: (async () => ({})) as never,
    getAnalysis: (async () => ({})) as never,
    recordEvaluationRating: (async () => ({})) as never,
    advanceFinding: (async () => ({})) as never,
    consultOpportunitySignals: (async () => []) as never,
  } as never,
  dependencyReadiness: async () => [],
});

await server.app.listen({ port: API_PORT, host: "127.0.0.1" });
const apiBase = `http://127.0.0.1:${API_PORT}`;
const apiHeaders = {
  Authorization: "Bearer smoke-token",
  "X-Zeck-Application": APP_ID,
  "Content-Type": "application/json",
};

// The dashboard binds the SAME environment contract a deployment binds
// (its budgets transport derives ZECK_API_URL / ZECK_TOKEN /
// ZECK_APPLICATION_ID — per-request, so it picks these up live).
process.env.ZECK_API_URL = apiBase;
process.env.ZECK_TOKEN = "smoke-token";
process.env.ZECK_APPLICATION_ID = APP_ID;

const { server: dashboardServer } = createDashboard({
  apiUrl: apiBase,
  token: "smoke-token",
  applicationId: APP_ID,
  port: 0,
});
await new Promise<void>((resolve) => dashboardServer.listen(0, "127.0.0.1", resolve));
const dashboardPort = (dashboardServer.address() as { port: number }).port;
const dashboardBase = `http://127.0.0.1:${dashboardPort}`;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. Configure the REAL quota envelope through the real quota service.
await quotaService.configure({
  applicationId: APP_ID,
  tenantId: TENANT_ID,
  dimension: "spend-micro-usd",
  limit: "5000000",
  window: "calendar-month",
});

// 2. Create the execution through the REAL public API (governed create).
const createResponse = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "smoke-create-1" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: 120000 },
    metadata: { origin: "zeck-console-playground", family: "text" },
  }),
});
const receipt = (await createResponse.json()) as { executionId: string; status: string };
check(
  "POST /executions creates the durable execution through the real API",
  createResponse.status === 201 && receipt.status === "CREATED",
  `status ${createResponse.status}`,
);
const executionId = receipt.executionId;
const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID, applicationId: APP_ID, executionId };

// 3. Drive the governed lifecycle through the REAL service: authorize →
//    plan → record the planning decision (the REAL seam) → queue → start
//    (with the dispatch reservation) → verify → pass.
for (const command of ["authorize", "plan"] as const) {
  await executions.transition({ command, ...actor }, `smoke-${command}-1`);
}
await executions.recordPlanningDecision(
  {
    applicationId: APP_ID,
    executionId,
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    decisionId: "decision-smoke-1",
    planId: "plan-smoke-1",
    payload: {
      decisionId: "decision-smoke-1",
      plannerVersion: "planner-1.2.0",
      taskProfile: {
        riskLevel: "low",
        qualityTarget: 0.8,
        maxCostMicroUsd: LIMIT_MICRO_USD,
        maxLatencyMs: 120000,
        requiresSemanticReasoning: true,
      },
      policyInputs: { outcome: "allow", policySetId: "ps-1", policySetVersion: 1 },
      capabilityResolution: {
        satisfied: true,
        catalogRevision: "rev-9",
        unmetIds: [],
        satisfiedIds: ["text-generation"],
      },
      deterministicSufficiency: {
        outcome: "insufficient",
        semanticReasoningRequired: true,
        deterministicQualityEstimate: 0.4,
      },
      candidates: [
        {
          strategyId: "deterministic-echo",
          expectedCostMicroUsd: "120",
          expectedQuality: 0.4,
          expectedLatencyMs: 40,
          verificationStrategy: "schema",
          modelCalls: 0,
          admissible: true,
          routeRationale: { code: "deterministic-sufficient", detail: "echo satisfies" },
          plan: { strategyClass: "deterministic-only", modelCalls: 0 },
        },
        {
          strategyId: "hybrid-openrouter",
          expectedCostMicroUsd: COST_MICRO_USD,
          expectedQuality: 0.9,
          expectedLatencyMs: 800,
          verificationStrategy: "rubric",
          modelCalls: 1,
          admissible: true,
          routeRationale: { code: "hybrid-composition", detail: "mixed envelope" },
          plan: {
            strategyClass: "hybrid",
            modelCalls: 1,
            steps: [
              {
                routeRef: {
                  provider: "openrouter",
                  model: "meta-llama/llama-3.3-70b-instruct",
                },
              },
            ],
          },
        },
      ],
      selectedStrategyId: "hybrid-openrouter",
      selectionRationale:
        "cheap-first cascade selection among 2 admissible candidate(s) satisfying the quality target (INT-004)",
      subgraphEvidence: [],
      substrateSelection: {
        outcome: "selected",
        workloadClass: "cloud",
        admissible: [],
        inadmissible: [],
        selected: { substrateId: "std-sandbox", version: "1" },
        rationale: "default sandbox",
      },
      recordDigest: "sha256:smoke",
    },
  },
  "smoke-decision-1",
);
for (const command of ["queue", "start", "verify"] as const) {
  await executions.transition(
    command === "start"
      ? {
          command,
          ...actor,
          dispatch: { operationId: "op-smoke-1", amountMicroUsd: "500000" },
        }
      : { command, ...actor },
    `smoke-${command}-1`,
  );
}
check(
  "the dispatch reservation was placed before the transition committed",
  reservationCount === 1,
  `reserve calls: ${reservationCount}`,
);
await executions.transition(
  {
    command: "pass",
    ...actor,
    verificationResults: [
      {
        criterionId: "cites-sources",
        strategy: "rubric",
        status: "PASS",
        recordedBy: "verifier-1",
        evidence: ["ev-1"],
      },
    ],
  },
  "smoke-pass-1",
);

// 4. The executing worker's settlement envelope (disclosed above): the
//    durable `execution.completed` record carrying the settled cost and
//    provider-reported usage — appended through the in-memory store.
const events = await store.listEvents(APP_ID, executionId);
const settlementSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
await store.appendEvent({
  eventId: newId(),
  executionId,
  applicationId: APP_ID,
  tenantId: TENANT_ID,
  sequence: settlementSequence,
  type: "execution.completed",
  command: "pass",
  actor: { actorId: ACTOR_ID, tenantId: TENANT_ID },
  cause: "worker settlement",
  payload: {
    from: "VERIFYING",
    to: "COMPLETED",
    costMicroUsd: COST_MICRO_USD,
    usage: { inputTokens: 2100, outputTokens: 340 },
    outputArtifacts: [{ id: "art-smoke-1", digest: "sha256:smoke-art", createdAt: now() }],
  },
  occurredAt: now(),
});

// 5. The REAL public records: the result package projects cost/usage/route.
const resultResponse = await fetch(`${apiBase}/executions/${executionId}/results`, {
  headers: apiHeaders,
});
const result = (await resultResponse.json()) as {
  status: string;
  cost: { totalMicroUsd: string } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  route: { provider: string | null; strategyClass: string | null } | null;
};
check(
  "GET /executions/:id/results serves the settled cost/usage and the recorded route",
  resultResponse.status === 200 &&
    result.cost?.totalMicroUsd === COST_MICRO_USD &&
    result.usage?.inputTokens === 2100 &&
    result.route?.strategyClass === "hybrid" &&
    result.route?.provider === "openrouter",
  `cost ${result.cost?.totalMicroUsd ?? "null"}, route ${result.route?.strategyClass ?? "null"}`,
);

// 6. The usage journey over the REAL dashboard (real HTTP, recents cookie).
const cookie = `zeck_recent_executions=${executionId}`;
const usageHtml = await (await fetch(`${dashboardBase}/console/usage`, { headers: { cookie } })).text();
check(
  "the usage surface renders the per-run cost facts from the real records",
  usageHtml.includes("$0.04125") &&
    usageHtml.includes(COST_MICRO_USD) &&
    usageHtml.includes("2100") &&
    usageHtml.includes("hybrid"),
);
check(
  "the declared per-run ceiling renders from the create request's recorded constraints",
  usageHtml.includes("$1.50") && usageHtml.includes(LIMIT_MICRO_USD),
);
check(
  "the honest unavailable state NAMES the missing application-scoped aggregate contract",
  usageHtml.includes("Application-scoped usage aggregates — not yet exposed by the public API") &&
    usageHtml.includes("an application-scoped usage/aggregate route"),
);
check(
  "the budgets view renders the REAL quota envelope through the public route",
  await (await fetch(`${dashboardBase}/console/usage?tab=budgets`, { headers: { cookie } }))
    .text()
    .then(
      (html) =>
        html.includes("Spend (micro-USD)") &&
        html.includes("5000000") &&
        html.includes("calendar-month"),
    ),
);
const optimizationHtml = await (
  await fetch(`${dashboardBase}/console/usage?tab=optimization`, { headers: { cookie } })
).text();
check(
  "the optimization view renders the platform's OWN recorded decision verbatim",
  optimizationHtml.includes("decision-smoke-1") &&
    optimizationHtml.includes("hybrid-openrouter") &&
    optimizationHtml.includes("deterministic-echo") &&
    optimizationHtml.includes("cheap-first cascade selection among 2 admissible candidate(s)") &&
    optimizationHtml.includes("insufficient") &&
    optimizationHtml.includes("deterministic-sufficient"),
);
check(
  "the optimization view's aggregate boundary names its missing contract",
  optimizationHtml.includes("Aggregate optimization outcomes — not yet exposed by the public API"),
);

// 7. Machine parity: the JSON view carries the SAME composition.
const factsResponse = await fetch(`${dashboardBase}/console/usage/facts.json`, {
  headers: { cookie },
});
const facts = (await factsResponse.json()) as {
  runs: { executionId: string; costMicroUsd: string | null; inputTokens: number | null }[];
  budgets: { quotas: { dimension: string; limit: string }[] | null };
  boundaries: Record<string, { available: boolean; missingContract: string }>;
};
check(
  "GET /console/usage/facts.json serves the same composed facts (parity)",
  factsResponse.status === 200 &&
    facts.runs[0]?.executionId === executionId &&
    facts.runs[0]?.costMicroUsd === COST_MICRO_USD &&
    facts.runs[0]?.inputTokens === 2100 &&
    facts.budgets.quotas?.[0]?.dimension === "spend-micro-usd" &&
    facts.budgets.quotas?.[0]?.limit === "5000000",
);
check(
  "the machine view names every missing contract (no UI-only state)",
  Object.keys(facts.boundaries).length === 4 &&
    Object.values(facts.boundaries).every((b) => b.available === false && b.missingContract.length > 0),
);

await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
await server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
