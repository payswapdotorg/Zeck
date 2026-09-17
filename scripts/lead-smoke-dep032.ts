/**
 * Lead smoke (DEP-032 review): boot the REAL API server + REAL dashboard
 * over REAL services (in-memory stores) and drive the reproducibility-
 * bundle export journey in a REAL process over REAL HTTP: create →
 * plan (recorded decision) → dispatch → settle (worker envelope with an
 * artifact + digest) → the explorer carries the export action → the
 * bundle view renders the composed sections → the bundle.json machine
 * twin serves the SAME composition as facts.json (HTTP-verified parity)
 * → the artifact rows are references + digests only → the reproduction
 * recipe is real (the recorded facts, verbatim) → the machine manifests'
 * revision facts pin this checkout's exact bytes → the bare run exports
 * with honest boundaries → the self-host guide serves under the console
 * docs routes.
 *
 * COMPOSITION (the DEP-014 lead-smoke wiring, same as DEP-030's):
 *  - executions: the REAL execution service over an in-memory store
 *    (the same durable contract the SQL adapter implements — gapless
 *    append-only ledger, single write path, idempotent arbitration);
 *  - the REAL Fastify API server (real auth seam, real server-side
 *    scope resolution, real serialization boundary);
 *  - the REAL dashboard booted with NO fetchImpl override — every
 *    dashboard read is a real HTTP round trip to the API server.
 *
 * THE SETTLEMENT ENVELOPE (disclosed): the real `transition` seam writes
 * `execution.completed` envelopes with the lifecycle payload only; the
 * settled cost/usage facts ride the executing worker's own durable
 * settlement envelope (the shape GET /executions/:id/results projects).
 * This smoke appends that one envelope through the in-memory store
 * directly — standing in for the executing worker's governed write — so
 * every read path (API routes, serialization, dashboard composition,
 * export bundle) is fully real end-to-end.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const APP_ID = "00000000-0000-7000-8000-0000000000f4";
const TENANT_ID = "tenant-1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000ab";
const API_PORT = 3919;
const COST_MICRO_USD = "41250";
const LIMIT_MICRO_USD = "1250000";

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

// 1. Create the settled execution through the REAL public API.
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

// 2. Drive the governed lifecycle through the REAL service.
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

// 3. The executing worker's settlement envelope (disclosed above): the
//    durable `execution.completed` record carrying the settled cost,
//    provider-reported usage and ONE output artifact with its digest.
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

// 4. The REAL public records: the result package projects cost/usage/artifacts.
const resultResponse = await fetch(`${apiBase}/executions/${executionId}/results`, {
  headers: apiHeaders,
});
const result = (await resultResponse.json()) as {
  status: string;
  cost: { totalMicroUsd: string } | null;
  outputArtifacts: { id: string; digest: string | null }[];
};
check(
  "GET /executions/:id/results serves the settled cost and the artifact reference + digest",
  resultResponse.status === 200 &&
    result.cost?.totalMicroUsd === COST_MICRO_USD &&
    result.outputArtifacts[0]?.id === "art-smoke-1" &&
    result.outputArtifacts[0]?.digest === "sha256:smoke-art",
);

// 5. Create the BARE execution (no settlement envelope: no cost, no usage,
//    no artifacts) — the honest-boundary half of the export journey.
const bareCreate = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "smoke-create-bare" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "postmortem-02", maxWords: 45 },
  }),
});
const bareReceipt = (await bareCreate.json()) as { executionId: string };
const bareId = bareReceipt.executionId;

// 6. The export journey over the REAL dashboard (real HTTP, recents cookie).
const cookie = `zeck_recent_executions=${executionId}`;
const explorerHtml = await (
  await fetch(`${dashboardBase}/console/executions/${executionId}`, { headers: { cookie } })
).text();
check(
  "the explorer carries the export action linking the bundle view",
  explorerHtml.includes(`href="/console/executions/${executionId}/export"`) &&
    explorerHtml.includes("Export reproducibility bundle"),
);
const exportHtml = await (
  await fetch(`${dashboardBase}/console/executions/${executionId}/export`, { headers: { cookie } })
).text();
check(
  "the bundle view renders every composition section",
  exportHtml.includes("Output artifacts (references and digests only)") &&
    exportHtml.includes("Repository revision facts (the machine manifests)") &&
    exportHtml.includes("Reproduction recipe") &&
    exportHtml.includes("Self-host / deployment handoff") &&
    exportHtml.includes("Honest boundaries") &&
    exportHtml.includes("The bundle (copyable JSON)"),
);
check(
  "the bundle view renders the artifact REFERENCE + DIGEST, never content",
  exportHtml.includes("sha256:smoke-art") &&
    exportHtml.includes(`href="/assets/artifacts/art-smoke-1?executionId=${executionId}"`) &&
    exportHtml.includes("never content"),
);
check(
  "the bundle view links the machine twin and the facts.json view",
  exportHtml.includes(`href="/console/executions/${executionId}/export/bundle.json"`) &&
    exportHtml.includes(`href="/console/executions/${executionId}/facts.json"`),
);

// 7. Machine parity over the REAL stack: the bundle's facts ARE the
//    facts.json composition (HTTP-verified verbatim equality).
const [bundleResponse, factsResponse] = await Promise.all([
  fetch(`${dashboardBase}/console/executions/${executionId}/export/bundle.json`, {
    headers: { cookie },
  }),
  fetch(`${dashboardBase}/console/executions/${executionId}/facts.json`, { headers: { cookie } }),
]);
const bundle = (await bundleResponse.json()) as {
  schemaVersion: number;
  export: { executionId: string };
  facts: unknown;
  artifacts: { outputArtifacts: Record<string, unknown>[] };
  reproduction: {
    example: { path: string };
    recreatedCreateRequest: Record<string, unknown>;
    selfHostingGuide: { consolePath: string };
  };
  boundaries: { field: string; statement: string }[];
  repository: {
    manifests: { path: string; sha256: string; carriedRevisionFacts: Record<string, string> }[];
  };
};
const machineView = (await factsResponse.json()) as unknown;
check(
  "GET /export/bundle.json serves parseable JSON with schemaVersion 1",
  bundleResponse.status === 200 && bundle.schemaVersion === 1,
);
check(
  "machine parity by construction: bundle.facts EQUALS the facts.json composition",
  JSON.stringify(bundle.facts) === JSON.stringify(machineView),
);
check(
  "the artifact rows carry references + digests only (the closed key set)",
  bundle.artifacts.outputArtifacts.length === 1 &&
    Object.keys(bundle.artifacts.outputArtifacts[0] ?? {}).sort().join(",") ===
      "createdAt,digest,id,reference",
);
check(
  "the recreated create request is the RECORDED task/constraints/metadata verbatim",
  JSON.stringify(bundle.reproduction.recreatedCreateRequest.task) ===
    JSON.stringify({ kind: "summarize", doc: "quarterly-report-01", maxWords: 60 }) &&
    JSON.stringify(bundle.reproduction.recreatedCreateRequest.constraints) ===
    JSON.stringify({ maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: 120000 }) &&
    JSON.stringify(bundle.reproduction.recreatedCreateRequest.metadata) ===
    JSON.stringify({ origin: "zeck-console-playground", family: "text" }),
);
check(
  "the recipe's example is the family's real integration-kit example",
  bundle.reproduction.example.path === "examples/text-summarization.ts",
);

// 8. The repository revision facts pin THIS checkout's exact manifest bytes.
const manifestChecks = bundle.repository.manifests.map((manifest) => {
  const bytes = readFileSync(
    fileURLToPath(new URL(`../${manifest.path}`, import.meta.url)),
  );
  return (
    manifest.sha256 === `sha256:${createHash("sha256").update(bytes).digest("hex")}` &&
    Object.keys(manifest.carriedRevisionFacts).length > 0
  );
});
check(
  "every machine manifest's revision facts pin this checkout's exact bytes (sha256 re-computed)",
  bundle.repository.manifests.length === 6 && manifestChecks.every((ok) => ok),
  `${manifestChecks.filter(Boolean).length}/6 pinned`,
);
check(
  "the deployment git revision stays an explicit boundary, never approximated",
  bundle.boundaries.some(
    (boundary) => boundary.field === "deploymentGitRevision" && boundary.statement.includes("GET /identity"),
  ),
);

// 9. The bare run exports with the honest boundaries (no cost/usage/artifacts).
const bareBundleResponse = await fetch(
  `${dashboardBase}/console/executions/${bareId}/export/bundle.json`,
  { headers: { cookie } },
);
const bareBundle = (await bareBundleResponse.json()) as {
  facts: { result: { cost: unknown; usage: unknown } };
  artifacts: { outputArtifacts: unknown[] };
  boundaries: { field: string }[];
};
const bareFields = bareBundle.boundaries.map((boundary) => boundary.field);
check(
  "the bare run's export names its boundaries (settledCost, usage, outputArtifacts)",
  bareBundleResponse.status === 200 &&
    bareBundle.facts.result.cost === null &&
    bareBundle.facts.result.usage === null &&
    bareBundle.artifacts.outputArtifacts.length === 0 &&
    ["settledCost", "usage", "outputArtifacts"].every((field) => bareFields.includes(field)),
);

// 10. The not-found paths stay honest (view + machine twin).
const unknownId = "00000000-0000-7000-8000-00000000dead";
const notFoundView = await fetch(`${dashboardBase}/console/executions/${unknownId}/export`, {
  headers: { cookie },
});
const notFoundMachine = await fetch(
  `${dashboardBase}/console/executions/${unknownId}/export/bundle.json`,
  { headers: { cookie },
  },
);
check(
  "an unknown execution exports nothing: 404 view + 404 JSON machine twin",
  notFoundView.status === 404 &&
    notFoundMachine.status === 404 &&
    (await notFoundMachine.json()).error === "NOT_FOUND",
);

// 11. The self-host handoff guide serves under the console docs routes.
const guideResponse = await fetch(`${dashboardBase}/console/docs/SELF-HOSTING.md`);
const guideHtml = await guideResponse.text();
check(
  "the self-host guide serves under /console/docs/SELF-HOSTING.md",
  guideResponse.status === 200 && guideHtml.includes("Self-Hosting"),
);
const docsIndex = await (
  await fetch(`${dashboardBase}/console/docs`)
).text();
check(
  "the docs index lists the guide (the directory is the index)",
  docsIndex.includes("SELF-HOSTING.md"),
);

await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
await server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
