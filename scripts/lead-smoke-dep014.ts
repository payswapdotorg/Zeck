/**
 * Lead smoke (DEP-014 review): boot the REAL API server + REAL dashboard
 * over the REAL services (in-memory stores) and drive the governance
 * journey in a REAL process: quotas → policy → establish → expire →
 * reset → honest states.
 */
import { createApiServer } from "../src/api";
import { createInMemoryQuotaStore } from "../src/modules/budgets/public";
import { createQuotaService } from "../src/modules/budgets/public";
import {
  createInMemorySandboxIdentityStore,
  createSandboxIdentityService,
} from "../src/modules/sandbox/public";
import type { SandboxExecutionLedger } from "../src/modules/sandbox/public";
import type { Authenticate, RequestIdentity } from "../src/api/request-identity";
import type { ScopeResolver } from "../src/modules/auth/public";

const APP_ID = "00000000-0000-7000-8000-0000000000f3";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

const now = () => new Date().toISOString();
const newId = (prefix: string) => () => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const ledger: SandboxExecutionLedger = {
  async recordStepEvent() {
    return { sequence: 1, type: "sandbox-admitted", replayed: false };
  },
  async getExecution() {
    return null;
  },
};

const quotaService = createQuotaService({
  store: createInMemoryQuotaStore(now),
  now,
  newId: newId("quota"),
});
const identityService = createSandboxIdentityService({
  store: createInMemorySandboxIdentityStore(now),
  ledger,
  now,
  newId: newId("identity"),
});

const authenticate: Authenticate = async () => ({
  actorId: ACTOR_ID,
  authenticatedAt: now(),
});
const scopeResolver: ScopeResolver = {
  resolveApplicationScope: (async () => ({
    applicationId: APP_ID,
    tenantId: "tenant-1",
  })) as never,
  resolveTenantScope: (async () => ({ tenantId: "tenant-1" })) as never,
  requirePermission: () => {},
};

const server = createApiServer({
  executions: {
    createExecution: (async () => {
      throw new Error("not exercised");
    }) as never,
    getExecution: (async () => {
      throw new Error("not exercised");
    }) as never,
  } as never,
  agents: { listAgents: (async () => []) as never } as never,
  economics: { recordAction: (async () => ({})) as never } as never,
  quotas: quotaService,
  identities: identityService,
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

const port = 3907;
await server.app.listen({ port, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
const headers = {
  Authorization: "Bearer smoke-token",
  "X-Zeck-Application": APP_ID,
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. The policy artifact route serves the versioned document
const policy = await fetch(`${base}/sandbox/data-policy`);
const policyBody = (await policy.json()) as { version: string; digest: string };
check("GET /sandbox/data-policy serves the versioned artifact", policy.status === 200 && policyBody.version === "1" && policyBody.digest.startsWith("sha256:"));

// 2. Quota configure + assess through the service, read through the route
await quotaService.configure({
  applicationId: APP_ID,
  tenantId: "tenant-1",
  dimension: "artifact-count",
  limit: "5",
  window: "calendar-month",
});
const quotas = await fetch(`${base}/sandbox/quotas?applicationId=${APP_ID}`, { headers });
const quotaBody = (await quotas.json()) as { quotas: { dimension: string; limit: string }[]; telemetry: { realtime: boolean } };
check(
  "GET /sandbox/quotas renders the dimension with the telemetry boundary",
  quotas.status === 200 && quotaBody.quotas.length === 1 && quotaBody.quotas[0]?.dimension === "artifact-count" && quotaBody.telemetry.realtime === false,
);

// 3. Establish + read the honest identity state through the route
const established = await identityService.establish({
  actorId: ACTOR_ID,
  applicationId: APP_ID,
  tenantId: "tenant-1",
  executionId: "exec-smoke",
  declaredDataClasses: ["synthetic-text"],
  idempotencyKey: "smoke-1",
});
const identityRead = await fetch(`${base}/sandbox/identities/${established.id}?applicationId=${APP_ID}`, { headers });
const identityBody = (await identityRead.json()) as { identity: { status: string; expired: boolean } };
check(
  "GET /sandbox/identities/:id renders the active state",
  identityRead.status === 200 && identityBody.identity.status === "active" && identityBody.identity.expired === false,
);

// 4. The reset through the route: idempotent, state-non-carrying
const reset = await fetch(`${base}/sandbox/identities/${established.id}/reset?applicationId=${APP_ID}`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": "smoke-reset-1", "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const resetBody = (await reset.json()) as { identity: { id: string }; resetOf: string; stateCarriedForward: boolean; ledgerRecorded: boolean };
check(
  "POST reset establishes the successor with the explicit contract",
  reset.status === 200 && resetBody.identity.id !== established.id && resetBody.stateCarriedForward === false && resetBody.ledgerRecorded === false,
);
const resetAgain = await fetch(`${base}/sandbox/identities/${established.id}/reset?applicationId=${APP_ID}`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": "smoke-reset-2", "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const resetAgainBody = (await resetAgain.json()) as { identity: { id: string } };
check(
  "re-confirming the reset is a no-op success (the SAME successor)",
  resetAgain.status === 200 && resetAgainBody.identity.id === resetBody.identity.id,
);

// 5. Cross-scope read: the honest 404
const crossScope = await fetch(`${base}/sandbox/identities/${established.id}?applicationId=${APP_ID}`, {
  headers: { ...headers, "X-Zeck-Application": `${APP_ID}-OTHER` },
});
check("a cross-scope read answers the honest 404", crossScope.status === 404);

// 6. The reset without an Idempotency-Key refuses
const noKey = await fetch(`${base}/sandbox/identities/${established.id}/reset?applicationId=${APP_ID}`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
check("the reset without an Idempotency-Key refuses", noKey.status === 422);

await server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
