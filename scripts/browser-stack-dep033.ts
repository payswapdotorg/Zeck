/**
 * The DEP-033 browser-drive stack runner: boots the REAL API server
 * (in-memory stores — the REAL execution service AND the REAL credential
 * authority) and the REAL dashboard on FIXED ports, and stays alive until
 * killed — the stack a real browser drives for the DEP-033 hardening
 * verification (focus visibility + tab order, table semantics under
 * display:block in the accessibility tree, responsive measurements at the
 * representative viewport classes).
 *
 * Same composition as scripts/lead-smoke-dep033.ts (see that file's
 * header): one SETTLED execution through the governed lifecycle + the
 * disclosed settlement envelope, one BARE non-terminal execution, and the
 * credential authority ready for the issue → reveal journey.
 */
import { createApiServer } from "../src/api";
import type { Authenticate } from "../src/api";
import {
  createCredentialService,
  InMemoryCredentialIdempotency,
  InMemoryCredentialSecretStore,
  InMemoryCredentialStore,
} from "../src/modules/auth/public";
import type {
  CredentialService,
  IdentityStore,
  MembershipRecord,
} from "../src/modules/auth/public";
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

const APP_ID = "00000000-0000-7000-8000-0000000000f6";
const TENANT_ID = "tenant-1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000ab";
const API_PORT = 3928;
const DASH_PORT = 3929;
const COST_MICRO_USD = "41250";
const LIMIT_MICRO_USD = "1500000";
const LIMIT_LATENCY_MS = 120000;

const now = () => new Date().toISOString();
let idCounter = 0;
const newId = () => `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

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
    throw new Error("settle is not exercised by this stack");
  },
  async release() {
    throw new Error("release is not exercised by this stack");
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

const notImplemented = (name: string) => () => {
  throw new Error(`not implemented in fake: ${name}`);
};
const membershipRows = new Map([
  [
    `${ACTOR_ID}:${APP_ID}`,
    {
      membership: { actorId: ACTOR_ID, applicationId: APP_ID, tenantId: TENANT_ID, role: "owner" },
      applicationTenantId: TENANT_ID,
    },
  ],
]);
const identityStore: IdentityStore = {
  provisionActor: notImplemented("provisionActor") as never,
  findActor: (async () => null) as never,
  findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
    (membershipRows.get(`${actorId}:${applicationId}`) as {
      membership: MembershipRecord;
      applicationTenantId: string;
    }) ?? null) as never,
  findTenantMembership: (async () => null) as never,
  listMemberships: (async () => []) as never,
  insertMembership: notImplemented("insertMembership") as never,
  updateMembershipRole: notImplemented("updateMembershipRole") as never,
  deleteMembership: notImplemented("deleteMembership") as never,
  lockApplicationMemberships: (async () => []) as never,
};
const credentialStore = new InMemoryCredentialStore();
let credentialCounter = 0;
const credentials: CredentialService = createCredentialService({
  identityStore,
  credentialStore,
  idempotency: new InMemoryCredentialIdempotency(credentialStore),
  resolver: {
    resolveApplicationScope: (async () => ({ applicationId: APP_ID, tenantId: TENANT_ID })) as never,
    resolveTenantScope: (async () => ({ tenantId: TENANT_ID })) as never,
    requirePermission: () => {},
  },
  generateId: () => `00000000-0000-7000-c000-${String(++credentialCounter).padStart(12, "0")}`,
  generateSecret: () => `zeck-test-secret-${String(++credentialCounter).padStart(8, "0")}`,
  now: () => new Date(),
  secretStore: new InMemoryCredentialSecretStore(),
  issuanceEnabled: true,
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
  credentials,
  agents: { listAgents: (async () => []) as never } as never,
  economics: { recordAction: (async () => ({})) as never } as never,
  quotas: createQuotaService({ store: createInMemoryQuotaStore(now), now, newId }),
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

process.env.ZECK_API_URL = apiBase;
process.env.ZECK_TOKEN = "smoke-token";
process.env.ZECK_APPLICATION_ID = APP_ID;

const { server: dashboardServer } = createDashboard({
  apiUrl: apiBase,
  token: "smoke-token",
  applicationId: APP_ID,
  port: DASH_PORT,
});
await new Promise<void>((resolve) => dashboardServer.listen(DASH_PORT, "0.0.0.0", resolve));
const dashboardBase = `http://127.0.0.1:${DASH_PORT}`;

// The SETTLED execution through the REAL public API.
const createResponse = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "browser-create-1" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: LIMIT_LATENCY_MS },
    metadata: { origin: "zeck-console-playground", family: "text" },
  }),
});
const receipt = (await createResponse.json()) as { executionId: string };
const executionId = receipt.executionId;
const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID, applicationId: APP_ID, executionId };
for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
  await executions.transition(
    command === "start"
      ? { command, ...actor, dispatch: { operationId: "op-browser-1", amountMicroUsd: "500000" } }
      : { command, ...actor },
    `browser-${command}-1`,
  );
}
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
  "browser-pass-1",
);
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
    outputArtifacts: [{ id: "art-browser-1", digest: "sha256:browser-art", createdAt: now() }],
  },
  occurredAt: now(),
});

// The BARE non-terminal execution (the cancel journey + honest absences).
const bareCreate = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "browser-create-bare" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "postmortem-02", maxWords: 45 },
    metadata: { origin: "zeck-console-playground", family: "text" },
  }),
});
const bareReceipt = (await bareCreate.json()) as { executionId: string };
const bareId = bareReceipt.executionId;

console.log(`DEP-033 browser-drive stack:`);
console.log(`  dashboard:            ${dashboardBase}`);
console.log(`  quickstart:           /console/quickstart`);
console.log(`  keys:                 /console/applications/keys`);
console.log(`  playground:           /console/playground/text`);
console.log(`  explorer:             /console/executions`);
console.log(`  settled run (detail): /console/executions/${executionId}`);
console.log(`  settled run (events): /runs/${executionId}?tab=activity&view=events`);
console.log(`  bare run (cancel):    /runs/${bareId}?action=cancel`);
console.log(`  settings:             /console/settings`);

// Stay alive until killed.
setInterval(() => {}, 60_000);
