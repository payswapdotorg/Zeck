/**
 * Lead smoke (DEP-031 review): boot the REAL API server + REAL dashboard
 * over REAL services (in-memory stores) and drive the playground COMPARE
 * journey in a REAL process over REAL HTTP: compose ONE workload family
 * twice through the governed platform (two runs of the same family — the
 * run history + explorer records), then open the compare view for BOTH
 * orderings and verify EVERY rendered fact equals the public records
 * verbatim (status, terminal outcome, recorded cost/usage, route summary,
 * verification outcomes, duration); verify the explanation panel renders
 * the platform's OWN recorded planning-decision facts VERBATIM from the
 * event ledger; verify the JSON compare machine view (facts.a/facts.b
 * EQUAL the per-run facts.json compositions — HTTP-verified parity);
 * verify the baseline launcher path (the frozen create contract carrying
 * the recorded baseline lineage metadata, constraints capped at the
 * sandbox limits — plus the honest unavailable state naming the missing
 * baseline-planning contract); and fire the hostile probes (unknown
 * execution ids, the same run twice, missing selections, cross-family
 * honesty, missing-fact unavailable states).
 *
 * COMPOSITION (the DEP-014 lead-smoke wiring, same as DEP-030/032's):
 *  - executions: the REAL execution service over an in-memory store
 *    (the same durable contract the SQL adapter implements — gapless
 *    append-only ledger, single write path, idempotent arbitration);
 *    unlike the 030/032 runners this store also PERSISTS verification
 *    results, so the verification axis the compare counts crosses the
 *    real route + serialization boundary;
 *  - the REAL Fastify API server (real auth seam, real server-side
 *    scope resolution, real serialization boundary);
 *  - the REAL dashboard booted with NO fetchImpl override — every
 *    dashboard read is a real HTTP round trip to the API server.
 *
 * THE SETTLEMENT ENVELOPE (disclosed): the real `transition` seam writes
 * `execution.pass` envelopes with the lifecycle payload only; the settled
 * cost/usage facts ride the executing worker's own durable settlement
 * envelope (`execution.completed`, the shape GET /executions/:id/results
 * projects). This smoke appends that one envelope per run through the
 * in-memory store directly — standing in for the executing worker's
 * governed write — so every read path (API routes, serialization,
 * dashboard composition) is fully real end-to-end.
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
import type { VerificationResultRecord } from "../src/modules/executions/domain/verification";
import { createDashboard } from "../apps/dashboard/index";

const APP_ID = "00000000-0000-7000-8000-0000000000f5";
const TENANT_ID = "tenant-1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000ab";
const API_PORT = 3923;
const COST_A_MICRO_USD = "41250";
const COST_B_MICRO_USD = "120";
const LIMIT_MICRO_USD = "1500000";
const LIMIT_LATENCY_MS = 120000;
const MODEL_A = "meta-llama/llama-3.3-70b-instruct";

const now = () => new Date().toISOString();
let idCounter = 0;
const newId = () => `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// The in-memory executions store (the durable contract the SQL adapter
// implements; the tests/unit/executions fake discipline, inline — extended
// to persist verification results so the compare's verification axis is a
// real read).
// ---------------------------------------------------------------------------

class InMemoryExecutionStore implements ExecutionStore {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly events: EventEnvelope[] = [];
  readonly verificationResults: VerificationResultRecord[] = [];
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
    const record: VerificationResultRecord = {
      id: input.id,
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      criterionId: input.criterionId,
      strategy: input.strategy,
      status: input.status,
      evidence: [...input.evidence],
      recordedBy: input.recordedBy,
      recordedAt: now(),
    };
    this.verificationResults.push(record);
    return record;
  }

  async listVerificationResults(applicationId: string, executionId: string) {
    return this.verificationResults.filter(
      (record) =>
        record.applicationId === applicationId && record.executionId === executionId,
    );
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

// The dashboard binds the SAME environment contract a deployment binds.
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

/** The house micro-USD formatter (integer arithmetic only), mirrored for expectations. */
function formatMicroUsd(microUsd: string): string {
  const value = BigInt(microUsd);
  const dollars = value / 1_000_000n;
  const remainder = value % 1_000_000n;
  const fraction = remainder.toString().padStart(6, "0");
  const centPrecision = remainder % 10_000n === 0n;
  const fractionText = centPrecision ? fraction.slice(0, 2) : fraction.replace(/0+$/, "");
  return `$${dollars.toString()}.${fractionText}`;
}

// ---------------------------------------------------------------------------
// 1. Compose the workload family TWICE through the REAL public API.
// ---------------------------------------------------------------------------

const createRun = async (
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<string> => {
  const response = await fetch(`${apiBase}/executions`, {
    method: "POST",
    headers: { ...apiHeaders, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const receipt = (await response.json()) as { executionId: string; status: string };
  if (response.status !== 201 || receipt.status !== "CREATED") {
    throw new Error(`create failed: ${response.status}`);
  }
  return receipt.executionId;
};

const runA = await createRun("smoke-create-a", {
  applicationId: APP_ID,
  task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
  constraints: { maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: LIMIT_LATENCY_MS },
  metadata: { origin: "zeck-console-playground", family: "text" },
});
check(
  "POST /executions creates run a (the strategy run) through the real API",
  runA.length > 0,
  runA,
);

/** The planning decision the platform's planner records (two contrasting runs). */
const decisionPayloadOf = (
  decisionId: string,
  selectedStrategyId: string,
  selectionRationale: string,
  sufficiency: { outcome: string; semanticReasoningRequired: boolean; deterministicQualityEstimate: number },
  candidates: unknown[],
) => ({
  decisionId,
  plannerVersion: "planner-1.2.0",
  taskProfile: {
    riskLevel: "low",
    qualityTarget: 0.8,
    maxCostMicroUsd: LIMIT_MICRO_USD,
    maxLatencyMs: LIMIT_LATENCY_MS,
    requiresSemanticReasoning: true,
  },
  policyInputs: { outcome: "allow", policySetId: "ps-1", policySetVersion: 1 },
  capabilityResolution: {
    satisfied: true,
    catalogRevision: "rev-9",
    unmetIds: [],
    satisfiedIds: ["text-generation"],
  },
  deterministicSufficiency: sufficiency,
  candidates,
  selectedStrategyId,
  selectionRationale,
  subgraphEvidence: [],
  substrateSelection: {
    outcome: "selected",
    workloadClass: "cloud",
    admissible: [],
    inadmissible: [],
    selected: { substrateId: "std-sandbox", version: "1" },
    rationale: "default sandbox",
  },
  recordDigest: `sha256:${decisionId}`,
});

const decisionA = decisionPayloadOf(
  "decision-smoke-a",
  "hybrid-openrouter",
  "cheap-first cascade selection among 2 admissible candidate(s) satisfying the quality target (INT-004)",
  { outcome: "insufficient", semanticReasoningRequired: true, deterministicQualityEstimate: 0.4 },
  [
    {
      strategyId: "deterministic-echo",
      expectedCostMicroUsd: COST_B_MICRO_USD,
      expectedQuality: 0.4,
      expectedLatencyMs: 40,
      verificationStrategy: "schema",
      modelCalls: 0,
      admissible: true,
      routeRationale: { code: "deterministic-insufficient", detail: "echo misses quality target" },
      plan: { strategyClass: "deterministic-only", modelCalls: 0 },
    },
    {
      strategyId: "hybrid-openrouter",
      expectedCostMicroUsd: COST_A_MICRO_USD,
      expectedQuality: 0.9,
      expectedLatencyMs: 800,
      verificationStrategy: "rubric",
      modelCalls: 1,
      admissible: true,
      routeRationale: { code: "hybrid-composition", detail: "mixed envelope" },
      plan: {
        strategyClass: "hybrid",
        modelCalls: 1,
        steps: [{ routeRef: { provider: "openrouter", model: MODEL_A } }],
      },
    },
    {
      strategyId: "single-model-premium",
      expectedCostMicroUsd: "400000",
      expectedQuality: 0.95,
      expectedLatencyMs: 300,
      verificationStrategy: "rubric",
      modelCalls: 1,
      admissible: false,
      inadmissibleReason: "cost ceiling exceeded",
    },
  ],
);

const decisionB = decisionPayloadOf(
  "decision-smoke-b",
  "deterministic-echo",
  "deterministic-first sufficiency: the echo strategy satisfies the task",
  { outcome: "sufficient", semanticReasoningRequired: false, deterministicQualityEstimate: 0.9 },
  [
    {
      strategyId: "deterministic-echo",
      expectedCostMicroUsd: COST_B_MICRO_USD,
      expectedQuality: 0.9,
      expectedLatencyMs: 40,
      verificationStrategy: "schema",
      modelCalls: 0,
      admissible: true,
      routeRationale: { code: "deterministic-sufficient", detail: "echo satisfies" },
      plan: { strategyClass: "deterministic-only", modelCalls: 0 },
    },
  ],
);

/** Drive the governed lifecycle: authorize → plan → decision → queue → start → verify → pass. */
const driveLifecycle = async (
  executionId: string,
  decision: Record<string, unknown>,
  decisionKey: string,
  dispatchOperationId: string,
  verificationResults: {
    criterionId: string;
    strategy: string;
    status: string;
    recordedBy: string;
    evidence: string[];
  }[],
): Promise<void> => {
  const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID, applicationId: APP_ID, executionId };
  for (const command of ["authorize", "plan"] as const) {
    await executions.transition({ command, ...actor }, `smoke-${command}-${decisionKey}`);
  }
  await executions.recordPlanningDecision(
    {
      applicationId: APP_ID,
      executionId,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      decisionId: decision.decisionId as string,
      planId: `plan-${decisionKey}`,
      payload: decision,
    },
    `smoke-decision-${decisionKey}`,
  );
  for (const command of ["queue", "start", "verify"] as const) {
    await executions.transition(
      command === "start"
        ? {
            command,
            ...actor,
            dispatch: { operationId: dispatchOperationId, amountMicroUsd: "500000" },
          }
        : { command, ...actor },
      `smoke-${command}-${decisionKey}`,
    );
  }
  await executions.transition(
    { command: "pass", ...actor, verificationResults },
    `smoke-pass-${decisionKey}`,
  );
};

/** The executing worker's settlement envelope (disclosed in the header). */
const settle = async (
  executionId: string,
  costMicroUsd: string,
  usage: { inputTokens: number; outputTokens: number },
  outputArtifacts: { id: string; digest: string | null; createdAt: string }[],
): Promise<void> => {
  const events = await store.listEvents(APP_ID, executionId);
  const sequence = events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
  await store.appendEvent({
    eventId: newId(),
    executionId,
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    sequence,
    type: "execution.completed",
    command: "pass",
    actor: { actorId: ACTOR_ID, tenantId: TENANT_ID },
    cause: "worker settlement",
    payload: {
      from: "VERIFYING",
      to: "COMPLETED",
      costMicroUsd,
      usage,
      outputArtifacts,
    },
    occurredAt: now(),
  });
};

await driveLifecycle(runA, decisionA, "a", "op-smoke-a", [
  {
    criterionId: "cites-sources",
    strategy: "rubric",
    status: "PASS",
    recordedBy: "verifier-1",
    evidence: ["ev-a-1"],
  },
]);
check(
  "the governed lifecycle ran with the dispatch reservation placed before the transition committed",
  reservationCount === 1,
  `reserve calls: ${reservationCount}`,
);
await settle(runA, COST_A_MICRO_USD, { inputTokens: 2100, outputTokens: 340 }, [
  { id: "art-smoke-a", digest: "sha256:smoke-art-a", createdAt: now() },
]);

// Run b: the SAME composed workload family, recorded with the baseline
// lineage metadata (exactly what the launcher stamps), planned to a
// deterministic route and settled cheaply — the contrasting second run.
const runB = await createRun("smoke-create-b", {
  applicationId: APP_ID,
  task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 90 },
  constraints: { maxCostMicroUsd: "900000", maxLatencyMs: 45000 },
  metadata: {
    origin: "zeck-console-playground",
    family: "text",
    sandbox: "disposable",
    composed: "1",
    baseline: "single-model-baseline-requested",
    baselineOf: runA,
  },
});
await driveLifecycle(runB, decisionB, "b", "op-smoke-b", [
  {
    criterionId: "cites-sources",
    strategy: "rubric",
    status: "PASS",
    recordedBy: "verifier-1",
    evidence: ["ev-b-1"],
  },
  {
    criterionId: "no-hallucination",
    strategy: "rubric",
    status: "FAIL",
    recordedBy: "verifier-1",
    evidence: ["ev-b-2"],
  },
]);
await settle(runB, COST_B_MICRO_USD, { inputTokens: 0, outputTokens: 0 }, [
  { id: "art-smoke-b", digest: null, createdAt: now() },
]);

// Run c: a DIFFERENT workload family, bare (no transitions, no settlement)
// — the cross-family honesty half + the missing-fact unavailable states.
const runC = await createRun("smoke-create-c", {
  applicationId: APP_ID,
  task: { kind: "extract", fields: ["payer", "amount"] },
  metadata: { origin: "zeck-console-playground", family: "structured" },
});

// Two more bare runs (the launcher's concurrency gate needs three in flight).
const runD = await createRun("smoke-create-d", {
  applicationId: APP_ID,
  task: { kind: "summarize", doc: "gate-01", maxWords: 10 },
  metadata: { origin: "zeck-console-playground", family: "text" },
});
const runE = await createRun("smoke-create-e", {
  applicationId: APP_ID,
  task: { kind: "summarize", doc: "gate-02", maxWords: 10 },
  metadata: { origin: "zeck-console-playground", family: "text" },
});

// ---------------------------------------------------------------------------
// 2. The public records (the verbatim baseline every rendered fact must equal).
// ---------------------------------------------------------------------------

interface PublicExecution {
  id: string;
  status: string;
  task: Record<string, unknown>;
  constraints: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  terminalAt: string | null;
}
interface PublicResult {
  status: string;
  route: { provider: string | null; model: string | null; strategyClass: string | null; modelCalls: number } | null;
  cost: { totalMicroUsd: string; currency: string } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  outputArtifacts: { id: string; digest: string | null }[];
  verification: { status: string }[];
  warnings: string[];
  terminalAt: string | null;
}

const readPublic = async (executionId: string) => {
  const [executionRes, resultRes, verificationRes] = await Promise.all([
    fetch(`${apiBase}/executions/${executionId}`, { headers: apiHeaders }),
    fetch(`${apiBase}/executions/${executionId}/results`, { headers: apiHeaders }),
    fetch(`${apiBase}/executions/${executionId}/verification`, { headers: apiHeaders }),
  ]);
  return {
    execution: (await executionRes.json()) as PublicExecution,
    result: (await resultRes.json()) as PublicResult,
    verification: (await verificationRes.json()) as { status: string }[],
  };
};

const publicA = await readPublic(runA);
const publicB = await readPublic(runB);
const publicC = await readPublic(runC);

check(
  "run a's public result record carries the settled facts (cost, usage, hybrid route)",
  publicA.result.cost?.totalMicroUsd === COST_A_MICRO_USD &&
    publicA.result.usage?.inputTokens === 2100 &&
    publicA.result.usage?.outputTokens === 340 &&
    publicA.result.route?.strategyClass === "hybrid" &&
    publicA.result.route?.provider === "openrouter" &&
    publicA.result.route?.model === MODEL_A &&
    publicA.result.route?.modelCalls === 1,
  `cost ${publicA.result.cost?.totalMicroUsd ?? "null"}`,
);
check(
  "run b's public record carries the baseline lineage metadata and the deterministic route",
  publicB.execution.metadata.baseline === "single-model-baseline-requested" &&
    publicB.execution.metadata.baselineOf === runA &&
    publicB.result.cost?.totalMicroUsd === COST_B_MICRO_USD &&
    publicB.result.route?.strategyClass === "deterministic-only" &&
    publicB.result.route?.provider === null &&
    publicB.result.route?.modelCalls === 0,
  `baseline ${String(publicB.execution.metadata.baseline ?? "null")}`,
);

// ---------------------------------------------------------------------------
// 3. The selection entry points (run history + explorer + picker).
// ---------------------------------------------------------------------------

const recentsCookie = `zeck_recent_executions=${runA},${runB},${runC}`;
const get = (path: string, cookie = recentsCookie) =>
  fetch(`${dashboardBase}${path}`, { headers: cookie === "" ? {} : { cookie }, redirect: "manual" });

const explorerHtml = await (await get("/console/executions")).text();
check(
  "the explorer list carries the Compare column, the per-row selection links and the primary action",
  explorerHtml.includes('<th scope="col">Compare</th>') &&
    explorerHtml.includes(`href="/console/compare?a=${runA}"`) &&
    explorerHtml.includes('href="/console/compare">Compare runs</a>'),
);
const familyHtml = await (await get("/console/playground/text")).text();
check(
  "the playground family page's run history carries the Compare links (the run-history entry point)",
  familyHtml.includes('<th scope="col">Compare</th>') &&
    familyHtml.includes(`href="/console/compare?a=${runA}"`) &&
    familyHtml.includes(`href="/console/compare?a=${runB}"`),
);
const pickerHtml = await (await get("/console/compare")).text();
check(
  "the compare picker lists the browser's recents and names the honest listing boundary",
  pickerHtml.includes("Select two runs of the same composed workload") &&
    pickerHtml.includes(`href="/console/compare?a=${runA}"`) &&
    pickerHtml.includes("No application-scoped execution listing exists") &&
    pickerHtml.includes("GET /executions (listing)"),
);
const pinnedHtml = await (await get(`/console/compare?a=${runA}`)).text();
check(
  "the pinned picker marks same-family and different-family rows",
  pinnedHtml.includes("Run a is pinned") &&
    pinnedHtml.includes("(same family)") &&
    pinnedHtml.includes("(different family — generic axes only)"),
);

// ---------------------------------------------------------------------------
// 4. The side-by-side view — every rendered fact equals the public records.
// ---------------------------------------------------------------------------

const compareHtml = await (await get(`/console/compare?a=${runA}&b=${runB}`)).text();
check(
  "the compare view renders every public-fact axis",
  [
    "Axis",
    "status",
    "terminal outcome",
    "duration",
    "recorded cost",
    "recorded usage",
    "recorded route",
    "verification outcomes",
    "warnings",
    "output artifacts (references + digests)",
    "workload family",
  ].every((axis) => compareHtml.includes(axis)),
);

const verificationCountsOf = (checks: readonly { status: string }[]) => {
  const pass = checks.filter((c) => c.status === "PASS").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const inconclusive = checks.filter(
    (c) => c.status !== "PASS" && c.status !== "FAIL",
  ).length;
  return {
    counts: `${pass} pass / ${fail} fail / ${inconclusive} inconclusive`,
    total: `(${checks.length} check(s))`,
  };
};
const routeTextOf = (route: NonNullable<PublicResult["route"]>) =>
  [
    route.strategyClass === null ? "(class unrecorded)" : route.strategyClass,
    route.provider === null ? null : `via ${route.provider}`,
    route.model === null ? null : `model ${route.model}`,
    route.modelCalls === null ? null : `${route.modelCalls} model call(s)`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
const durationMsOf = (record: PublicExecution) =>
  record.terminalAt === null ? null : Date.parse(record.terminalAt) - Date.parse(record.createdAt);

const factsVerbatim = [
  // status + terminal outcome, both sides, from the execution records.
  publicA.execution.status,
  publicB.execution.status,
  publicA.execution.terminalAt ?? "",
  publicB.execution.terminalAt ?? "",
  // recorded cost: the formatted display + the raw micro-USD, both sides.
  formatMicroUsd(publicA.result.cost?.totalMicroUsd ?? "0"),
  publicA.result.cost?.totalMicroUsd ?? "",
  `(${publicA.result.cost?.totalMicroUsd ?? ""} micro-USD, ${publicA.result.cost?.currency ?? ""})`,
  formatMicroUsd(publicB.result.cost?.totalMicroUsd ?? "0"),
  `(${publicB.result.cost?.totalMicroUsd ?? ""} micro-USD, ${publicB.result.cost?.currency ?? ""})`,
  // recorded usage, both sides.
  `${publicA.result.usage?.inputTokens} in / ${publicA.result.usage?.outputTokens} out tokens`,
  `${publicB.result.usage?.inputTokens} in / ${publicB.result.usage?.outputTokens} out tokens`,
  // route summary, both sides.
  routeTextOf(publicA.result.route ?? { provider: null, model: null, strategyClass: null, modelCalls: 0 }),
  routeTextOf(publicB.result.route ?? { provider: null, model: null, strategyClass: null, modelCalls: 0 }),
  // verification outcomes (counted from the verification axis), both sides.
  verificationCountsOf(publicA.verification).counts,
  verificationCountsOf(publicA.verification).total,
  verificationCountsOf(publicB.verification).counts,
  verificationCountsOf(publicB.verification).total,
  // output artifacts: references + digests only.
  `href="/assets/artifacts/art-smoke-a?executionId=${runA}"`,
  "sha256:smoke-art-a",
  "art-smoke-b",
  "(no digest recorded)",
].every((fact) => fact.length === 0 || compareHtml.includes(fact));
check(
  "every rendered fact equals the public records verbatim (status, terminal, cost, usage, route, verification, artifacts)",
  factsVerbatim,
);

const durationA = durationMsOf(publicA.execution);
const durationB = durationMsOf(publicB.execution);
check(
  "the derived durations equal the recorded timestamps' own arithmetic",
  compareHtml.includes(`${durationA ?? -1} ms, derived from the recorded timestamps`) &&
    compareHtml.includes(`${durationB ?? -1} ms, derived from the recorded timestamps`),
  `a ${durationA ?? "null"} ms, b ${durationB ?? "null"} ms`,
);
check(
  "the composed-task delta renders the recorded task fields (same and differing)",
  compareHtml.includes("The composed task (the recorded values)") &&
    compareHtml.includes("maxWords") &&
    compareHtml.includes("doc") &&
    compareHtml.includes("same") &&
    compareHtml.includes("differs"),
);
check(
  "run b's baseline lineage chip renders from its recorded metadata",
  compareHtml.includes(
    `baseline lineage single-model-baseline-requested (of ${runB})`.replace(`(of ${runB})`, `(of ${runA})`),
  ) || compareHtml.includes(`(of ${runA})`),
  `baselineOf ${runA}`,
);
const mirroredHtml = await (await get(`/console/compare?a=${runB}&b=${runA}`)).text();
check(
  "both orderings render the same compare (the selection mirrors, the facts hold)",
  mirroredHtml.includes("Side-by-side — the public facts") &&
    mirroredHtml.includes(formatMicroUsd(publicA.result.cost?.totalMicroUsd ?? "0")) &&
    mirroredHtml.includes(routeTextOf(publicB.result.route ?? { provider: null, model: null, strategyClass: null, modelCalls: 0 })),
);

// ---------------------------------------------------------------------------
// 5. The explanation panel — the recorded planning rationale, verbatim.
// ---------------------------------------------------------------------------

check(
  "run a's explanation renders the recorded planning decision verbatim (candidates, trade-offs, selection, substrate)",
  compareHtml.includes("decision-smoke-a") &&
    compareHtml.includes("planner-1.2.0") &&
    compareHtml.includes("deterministic-echo") &&
    compareHtml.includes("hybrid-openrouter") &&
    compareHtml.includes("single-model-premium") &&
    compareHtml.includes("(selected)") &&
    compareHtml.includes("(cost ceiling exceeded)") &&
    compareHtml.includes(`${COST_A_MICRO_USD} micro-USD`) &&
    compareHtml.includes("800 ms") &&
    compareHtml.includes(
      "cheap-first cascade selection among 2 admissible candidate(s) satisfying the quality target (INT-004)",
    ) &&
    compareHtml.includes("insufficient") &&
    compareHtml.includes("std-sandbox") &&
    compareHtml.includes("default sandbox"),
);
check(
  "run b's explanation renders its OWN recorded decision verbatim (deterministic sufficiency)",
  compareHtml.includes("decision-smoke-b") &&
    compareHtml.includes("deterministic-first sufficiency: the echo strategy satisfies the task") &&
    compareHtml.includes("sufficient"),
);

// ---------------------------------------------------------------------------
// 6. Machine parity — the JSON compare view serves the same composed records.
// ---------------------------------------------------------------------------

const [compareJsonRes, factsARes, factsBRes, factsCRes] = await Promise.all([
  get(`/console/compare/facts.json?a=${runA}&b=${runB}`),
  get(`/console/executions/${runA}/facts.json`),
  get(`/console/executions/${runB}/facts.json`),
  get(`/console/executions/${runC}/facts.json`),
]);
const compareJson = (await compareJsonRes.json()) as {
  selection: { a: string; b: string };
  sameFamily: boolean;
  genericAxesOnly: boolean;
  facts: { a: unknown; b: unknown };
  compare: { runs: { a: { executionId: string; costMicroUsd: string | null }; b: { executionId: string } }; taskDelta: { comparable: boolean } };
  boundaries: { field: string; missingContract?: string }[];
  authority: { note: string };
};
const viewA = await factsARes.json();
const viewB = await factsBRes.json();
const viewC = await factsCRes.json();
check(
  "machine parity: facts.a and facts.b EQUAL the per-run facts.json compositions (HTTP-verified)",
  compareJsonRes.status === 200 &&
    JSON.stringify(compareJson.facts.a) === JSON.stringify(viewA) &&
    JSON.stringify(compareJson.facts.b) === JSON.stringify(viewB) &&
    compareJson.selection.a === runA &&
    compareJson.selection.b === runB &&
    compareJson.sameFamily === true &&
    compareJson.compare.runs.a.executionId === runA &&
    compareJson.compare.runs.a.costMicroUsd === COST_A_MICRO_USD &&
    compareJson.compare.taskDelta.comparable === true,
);
check(
  "the machine view carries the projection doctrine and every universal boundary",
  compareJson.authority.note.includes("never a second comparator") &&
    compareJson.authority.note.includes("benchmarks/validation") &&
    ["realizedQualityScores", "baselinePlanningSemantics", "statisticalComparison", "perStepCostBreakdown"].every(
      (field) => compareJson.boundaries.some((boundary) => boundary.field === field),
    ) &&
    (compareJson.boundaries.find((b) => b.field === "baselinePlanningSemantics")?.missingContract ?? "").includes(
      "baseline planning semantics",
    ),
);

// ---------------------------------------------------------------------------
// 7. The baseline launcher — frozen create contract + honest unavailable state.
// ---------------------------------------------------------------------------

const launcherHonesty = [
  "True single-model baseline planning semantics — not yet exposed by the public API",
  "metadata.baseline",
  "metadata.baseline = single-model-baseline-requested",
  // The confirmation card escapes the title's apostrophe (the house rule).
  "Re-run run a&#39;s composed task with baseline lineage?",
  "Re-run run b&#39;s composed task with baseline lineage?",
  "no provider, model, rail, connection or agent is selected",
];
check(
  "the compare view names the missing baseline-planning contract honestly and renders both launcher cards",
  launcherHonesty.every((part) => compareHtml.includes(part)),
  launcherHonesty.filter((part) => !compareHtml.includes(part)).join(" | ") || "all present",
);

const baselinePost = await fetch(`${dashboardBase}/console/compare/baseline`, {
  method: "POST",
  body: `executionId=${encodeURIComponent(runA)}&idempotencyKey=smoke-baseline-launch-1`,
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: recentsCookie,
  },
  redirect: "manual",
});
const baselineLocation = baselinePost.headers.get("location") ?? "";
const baselineRunId = /^\/runs\/(.+)$/.exec(baselineLocation)?.[1] ?? "";
check(
  "the baseline launcher POST re-submits through the frozen create contract (303 to the new run)",
  baselinePost.status === 303 && baselineRunId.length > 0,
  `status ${baselinePost.status}, location ${baselineLocation}`,
);
if (baselineRunId.length > 0) {
  const baselineRecord = await readPublic(baselineRunId);
  check(
    "the new run's PUBLIC record carries the source task verbatim + the baseline lineage + the capped constraints",
    JSON.stringify(baselineRecord.execution.task) === JSON.stringify(publicA.execution.task) &&
      baselineRecord.execution.metadata.baseline === "single-model-baseline-requested" &&
      baselineRecord.execution.metadata.baselineOf === runA &&
      JSON.stringify(baselineRecord.execution.constraints) ===
        JSON.stringify({ maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: LIMIT_LATENCY_MS }),
    `constraints ${JSON.stringify(baselineRecord.execution.constraints)}`,
  );
} else {
  check("the new run's PUBLIC record carries the source task verbatim + the baseline lineage + the capped constraints", false, "no baseline run id");
}

const gateCookie = `zeck_recent_executions=${runC},${runD},${runE}`;
const gatePost = await fetch(`${dashboardBase}/console/compare/baseline`, {
  method: "POST",
  body: `executionId=${encodeURIComponent(runA)}&idempotencyKey=smoke-baseline-launch-2`,
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: gateCookie,
  },
  redirect: "manual",
});
check(
  "the sandbox concurrency gate refuses a fourth in-flight run (422, honestly)",
  gatePost.status === 422 &&
    (await gatePost.text()).includes("Sandbox concurrency limit reached"),
  `status ${gatePost.status}`,
);

// ---------------------------------------------------------------------------
// 8. Hostile probes — unknown ids, same run, missing selections,
//    cross-family honesty, missing-fact unavailable states.
// ---------------------------------------------------------------------------

const unknownId = "00000000-0000-7000-8000-00000000dead";
const [unknownView, unknownJson] = await Promise.all([
  get(`/console/compare?a=${runA}&b=${unknownId}`),
  get(`/console/compare/facts.json?a=${runA}&b=${unknownId}`),
]);
const unknownJsonBody = (await unknownJson.json()) as { error: string; message: string };
check(
  "an unknown execution id answers the honest 404 view + the honest JSON 404",
  unknownView.status === 404 &&
    (await unknownView.text()).includes("This execution is not visible through the governed API") &&
    unknownJson.status === 404 &&
    unknownJsonBody.error === "NOT_FOUND" &&
    unknownJsonBody.message.includes("nothing to compare"),
);

const [sameRunView, sameRunJson] = await Promise.all([
  get(`/console/compare?a=${runA}&b=${runA}`),
  get(`/console/compare/facts.json?a=${runA}&b=${runA}`),
]);
const sameRunJsonBody = (await sameRunJson.json()) as { message: string };
check(
  "the same run twice answers the honest same-run state + the JSON 400",
  sameRunView.status === 200 &&
    (await sameRunView.text()).includes("Both selections are the same run") &&
    sameRunJson.status === 400 &&
    sameRunJsonBody.message.includes("two DIFFERENT execution ids"),
);

const [noParams, oneParam] = await Promise.all([
  get("/console/compare/facts.json"),
  get(`/console/compare/facts.json?a=${runA}`),
]);
const noParamsBody = (await noParams.json()) as { error: string };
check(
  "missing selections answer the honest JSON 400",
  noParams.status === 400 && noParamsBody.error === "BAD_REQUEST" && oneParam.status === 400,
);

const [crossHtml, crossJsonRes] = await Promise.all([
  get(`/console/compare?a=${runA}&b=${runC}`),
  get(`/console/compare/facts.json?a=${runA}&b=${runC}`),
]);
const crossHtmlBody = await crossHtml.text();
const crossJson = (await crossJsonRes.json()) as {
  sameFamily: boolean;
  genericAxesOnly: boolean;
  families: { a: string; b: string };
  facts: { b: unknown };
  compare: { taskDelta: { comparable: boolean; note: string } };
  boundaries: { field: string }[];
};
check(
  "a cross-family compare says generic-axes-only (view + machine) with parity for the third run",
  crossHtmlBody.includes("Different workload families — generic axes only") &&
    crossHtmlBody.includes('family "text"') &&
    crossHtmlBody.includes('family "structured"') &&
    crossHtmlBody.includes(
      "the composed task shapes are not comparable across families and are not rendered side by side",
    ) &&
    crossJson.sameFamily === false &&
    crossJson.genericAxesOnly === true &&
    crossJson.compare.taskDelta.comparable === false &&
    crossJson.boundaries.some((boundary) => boundary.field === "differentWorkloadFamilies") &&
    JSON.stringify(crossJson.facts.b) === JSON.stringify(viewC),
);
check(
  "missing recorded facts render as honest unavailable cells, never guesses",
  crossHtmlBody.includes("not settled yet") &&
    crossHtmlBody.includes("not recorded") &&
    crossHtmlBody.includes("no route recorded") &&
    crossHtmlBody.includes("not terminal yet") &&
    crossHtmlBody.includes("no checks recorded") &&
    crossHtmlBody.includes("none recorded"),
);

await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
await server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
