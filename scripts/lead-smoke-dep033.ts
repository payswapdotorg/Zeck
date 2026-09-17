/**
 * Lead smoke (DEP-033 review): boot the REAL API server + REAL dashboard
 * over REAL services (in-memory stores — including the REAL credential
 * authority, so the credentials keyboard journey is fully real) and drive
 * the console-hardening checks over real HTTP:
 *
 *  - KEYBOARD-JOURNEY checks: every interactive element on the console
 *    primary-journey pages is a NATIVE focusable control (links, buttons,
 *    inputs, selects, textareas, details/summary) — no positive tabindex,
 *    no tabindex="-1" on interactive controls, no script-built widgets;
 *    the skip link is the first focusable element; :focus-visible styling
 *    and the ≥44px touch-target minimum are present in the served CSS;
 *    the credentials journey (issue → show-once reveal → replay → rotate
 *    → revoke) and the explorer lookup journey run as native forms end
 *    to end.
 *
 *  - HOSTILE probes (AC3): markup-carrying execution ids (lookup + path),
 *    family ids, credential labels, form values and cookie-derived
 *    recents are refused/escaped — no reflected markup anywhere, and the
 *    [not displayed] redaction doctrine holds on the raw payload view.
 *
 *  - RESPONSIVE-class render checks (AC2): viewport meta, the D1
 *    scroll-trap fix (min-width:0 shell regions + in-box table scroll),
 *    the 1024px/640px media queries and the touch-target rules in the
 *    SERVED wire CSS.
 *
 *  - NO-SCRIPT foundation checks (AC4): native links, GET forms and
 *    details/summary disclosures on the console pages; zero inline
 *    handlers; client.js the single deferred external script; the
 *    mode-switch GET form round-trips without any script.
 *
 * COMPOSITION (the DEP-014/030/031/032 lead-smoke wiring):
 *  - executions: the REAL execution service over an in-memory store
 *    (the durable contract the SQL adapter implements — gapless
 *    append-only ledger, single write path, idempotent arbitration);
 *  - credentials: the REAL credential service over the in-memory
 *    credential store + idempotency ledger + secret store (issuance
 *    enabled) — issue → reveal → rotate → revoke crosses the real
 *    route + serialization boundary;
 *  - the REAL Fastify API server (real auth seam, real server-side
 *    scope resolution, real serialization boundary);
 *  - the REAL dashboard booted with NO fetchImpl override — every
 *    dashboard read is a real HTTP round trip to the API server, and
 *    the credential console transport is derived from the SAME
 *    environment contract a deployment binds.
 *
 * THE SETTLEMENT ENVELOPE (disclosed, the DEP-031/032 precedent): the
 * real `transition` seam writes `execution.pass` envelopes with the
 * lifecycle payload only; the settled cost/usage facts ride the
 * executing worker's own durable settlement envelope
 * (`execution.completed`, the shape GET /executions/:id/results
 * projects). This smoke appends that one envelope through the in-memory
 * store directly — standing in for the executing worker's governed
 * write — so every read path (API routes, serialization, dashboard
 * composition) is fully real end-to-end.
 *
 * HONEST BOUNDARY: this is an HTTP-level smoke. The real-browser drive
 * (focus visibility in a live accessibility tree, table semantics under
 * display:block, measured viewport behavior in Chromium) is recorded
 * separately in deploy/evidence/dep-033.json (the browser-drive step),
 * with WebKit/Firefox as NOT RUN where those engines are unavailable.
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

const APP_ID = "00000000-0000-7000-8000-0000000000f5";
const TENANT_ID = "tenant-1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000ab";
const API_PORT = 3925;
const COST_MICRO_USD = "41250";
const LIMIT_MICRO_USD = "1500000";
const LIMIT_LATENCY_MS = 120000;
const HOSTILE = `"><script>zeck("x")</script>&'`;

const now = () => new Date().toISOString();
let idCounter = 0;
const newId = () => `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// The in-memory executions store (the durable contract the SQL adapter
// implements; the tests/unit/executions fake discipline, inline).
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

// The REAL credential authority (DEP-011) over the in-memory stores —
// the same wiring tests/unit/api/world.ts composes (the identity-store
// fake stands in for the identity authority's read).
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
  credentials,
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

// The dashboard binds the SAME environment contract a deployment binds —
// including the credential console transport (derived from these env
// vars, the deployment's own path).
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

const get = async (path: string, cookie?: string): Promise<Response> =>
  fetch(`${dashboardBase}${path}`, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });
const getHtml = async (path: string, cookie?: string): Promise<string> => {
  const response = await get(path, cookie);
  if (response.status !== 200) {
    throw new Error(`GET ${path} → ${response.status}`);
  }
  return response.text();
};
const postForm = async (path: string, form: Record<string, string>): Promise<Response> =>
  fetch(`${dashboardBase}${path}`, {
    method: "POST",
    body: new URLSearchParams(form).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });

// ---------------------------------------------------------------------------
// 0. Seed one settled execution through the REAL public API (the run the
//    journeys read), with the disclosed settlement envelope.
// ---------------------------------------------------------------------------

const createResponse = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "smoke-create-1" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: LIMIT_MICRO_USD, maxLatencyMs: LIMIT_LATENCY_MS },
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
for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
  await executions.transition(
    command === "start"
      ? { command, ...actor, dispatch: { operationId: "op-smoke-1", amountMicroUsd: "500000" } }
      : { command, ...actor },
    `smoke-${command}-1`,
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
  "smoke-pass-1",
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
    outputArtifacts: [{ id: "art-smoke-1", digest: "sha256:smoke-art", createdAt: now() }],
  },
  occurredAt: now(),
});
check(
  "the settled run's public record carries the cost/usage/artifact facts",
  await (async () => {
    const results = await fetch(`${apiBase}/executions/${executionId}/results`, {
      headers: apiHeaders,
    });
    const body = (await results.json()) as {
      cost: { totalMicroUsd: string } | null;
      outputArtifacts: { id: string }[];
    };
    return (
      results.status === 200 &&
      body.cost?.totalMicroUsd === COST_MICRO_USD &&
      body.outputArtifacts[0]?.id === "art-smoke-1"
    );
  })(),
);

// ---------------------------------------------------------------------------
// 1. KEYBOARD-JOURNEY checks over the real rendered pages.
// ---------------------------------------------------------------------------

const JOURNEY_PAGES = [
  "/console/quickstart",
  "/console/applications/keys",
  "/console/playground",
  "/console/playground/text",
  "/console/executions",
  `/console/executions/${executionId}`,
  "/console/docs",
  "/console/settings",
] as const;

check(
  "every console journey page: the skip link is the first focusable element",
  await (async () => {
    for (const path of JOURNEY_PAGES) {
      const html = await getHtml(path);
      const skipIndex = html.indexOf('<a class="skip-link"');
      const firstAnchor = html.indexOf("<a ");
      if (skipIndex < 0 || skipIndex !== firstAnchor) {
        return false;
      }
    }
    return true;
  })(),
);

check(
  "every console journey page: no positive tabindex, no tabindex removal on interactive controls",
  await (async () => {
    for (const path of JOURNEY_PAGES) {
      const html = await getHtml(path);
      if (/tabindex="(?:[1-9]\d*)"/.test(html)) return false;
      if (/(?:<a |<button |<input |<select |<textarea )[^>]*tabindex="-1"/.test(html)) return false;
    }
    return true;
  })(),
);

check(
  "every console journey page: interactive elements are native controls only (no script-built widgets)",
  await (async () => {
    for (const path of JOURNEY_PAGES) {
      const html = await getHtml(path);
      // No div/span/role="button" widgets: every interactive surface is an
      // a/button/input/select/textarea/summary/details element.
      if (/<(?:div|span|p)[^>]*role="button"/.test(html)) return false;
      if (/<(?:div|span)[^>]*onclick/i.test(html)) return false;
    }
    return true;
  })(),
);

check(
  "the served stylesheet carries :focus-visible outlines and the ≥44px touch-target minimum",
  await (async () => {
    const html = await getHtml("/console/quickstart");
    return (
      html.includes(":focus-visible") &&
      html.includes("--touch-target: 2.75rem") &&
      html.includes("min-height: var(--touch-target)")
    );
  })(),
);

// A second, BARE execution (no transitions — non-terminal) so the run
// page's governed cancel POST form renders (terminal runs carry none).
const bareCreate = await fetch(`${apiBase}/executions`, {
  method: "POST",
  headers: { ...apiHeaders, "Idempotency-Key": "smoke-create-bare" },
  body: JSON.stringify({
    applicationId: APP_ID,
    task: { kind: "summarize", doc: "postmortem-02", maxWords: 45 },
    metadata: { origin: "zeck-console-playground", family: "text" },
  }),
});
const bareReceipt = (await bareCreate.json()) as { executionId: string };
const bareId = bareReceipt.executionId;

// The explorer lookup journey: a native GET form that lands on the run.
check(
  "the lookup journey: GET /executions?id=… redirects to the run page which renders the run's facts",
  await (async () => {
    const redirect = await get(`/executions?id=${executionId}`);
    if (redirect.status !== 303 || redirect.headers.get("location") !== `/runs/${executionId}`) {
      return false;
    }
    const runHtml = await getHtml(`/runs/${executionId}`);
    return runHtml.includes(executionId) && runHtml.includes("Completed");
  })(),
);
check(
  "the non-terminal run's cancel journey: link → confirm-then-act card → native POST form",
  await (async () => {
    const runHtml = await getHtml(`/runs/${bareId}`);
    if (!runHtml.includes(`/runs/${bareId}?action=cancel`)) {
      return false;
    }
    const confirmHtml = await getHtml(`/runs/${bareId}?action=cancel`);
    return (
      confirmHtml.includes("Cancel this execution?") &&
      confirmHtml.includes("Consequential action") &&
      confirmHtml.includes(`<form method="post" action="/runs/${bareId}/cancel`) &&
      confirmHtml.includes('name="idempotencyKey"') &&
      confirmHtml.includes(">Cancel execution</button>")
    );
  })(),
);

// The credentials journey, fully real (issue → reveal → replay → rotate → revoke).
const keysPage = await getHtml("/console/applications/keys");
const issueKey = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(keysPage)?.[1] ?? "";
check(
  "the keys page renders the live list + the guided issue form (real credential authority behind it)",
  keysPage.includes("Credentials in this application") &&
    keysPage.includes("No credentials are issued for this application scope") &&
    keysPage.includes('action="/console/applications/keys/issue"') &&
    issueKey.length > 0,
);

const issueResponse = await postForm("/console/applications/keys/issue", {
  label: "ci integration",
  role: "member",
  idempotencyKey: issueKey,
});
const revealHtml = await issueResponse.text();
const secret = /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(revealHtml)?.[1] ?? "";
const credentialId = /Credential identity<\/th><td>([^<]+)<\/td>/.exec(revealHtml)?.[1] ?? "";
check(
  "issue → the show-once reveal (readonly copy field, D6 styling, shown exactly once)",
  issueResponse.status === 200 &&
    secret.length > 0 &&
    revealHtml.includes('<section class="reveal" aria-labelledby="reveal-title">') &&
    revealHtml.includes('<div class="secret-reveal">') &&
    revealHtml.includes("shown exactly once"),
  `credential ${credentialId}`,
);

const replayResponse = await postForm("/console/applications/keys/issue", {
  label: "ci integration",
  role: "member",
  idempotencyKey: issueKey,
});
const replayHtml = await replayResponse.text();
check(
  "replay (same idempotency key) → the honest replay page, never a re-displayed secret",
  replayResponse.status === 200 &&
    replayHtml.includes("the secret is not shown again") &&
    !replayHtml.includes(secret),
);

const rotatePage = await getHtml(`/console/applications/keys?rotate=${encodeURIComponent(credentialId)}`);
const rotateKey = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(rotatePage)?.[1] ?? "";
check(
  "the rotate confirm-then-act card states the consequence rows and POSTs natively",
  rotatePage.includes("Consequential action — review the consequence before committing") &&
    rotatePage.includes("What it costs") &&
    rotatePage.includes("Can it be undone") &&
    rotatePage.includes(
      `/console/applications/keys/${encodeURIComponent(credentialId)}/rotate`,
    ) &&
    rotateKey.length > 0,
);
const rotateResponse = await postForm(
  `/console/applications/keys/${encodeURIComponent(credentialId)}/rotate`,
  { idempotencyKey: rotateKey },
);
const rotatedHtml = await rotateResponse.text();
const rotatedSecret =
  /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(rotatedHtml)?.[1] ?? "";
check(
  "rotate → the successor reveal (a DIFFERENT show-once secret, never the old one)",
  rotateResponse.status === 200 &&
    rotatedSecret.length > 0 &&
    rotatedSecret !== secret &&
    !rotatedHtml.includes(secret),
);

const revokePage = await getHtml(`/console/applications/keys?revoke=${encodeURIComponent(credentialId)}`);
const revokeKey = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(revokePage)?.[1] ?? "";
check(
  "the revoke confirm-then-act card states the consequence and terminality before the POST",
  revokePage.includes("Consequential action — review the consequence before committing") &&
    revokePage.includes("Can it be undone") &&
    revokePage.includes("revoked is terminal") &&
    revokeKey.length > 0,
);
const revokeResponse = await postForm(
  `/console/applications/keys/${encodeURIComponent(credentialId)}/revoke`,
  { idempotencyKey: revokeKey },
);
check(
  "revoke → PRG back to the list with the revoked status rendered",
  revokeResponse.status === 303 &&
    (revokeResponse.headers.get("location") ?? "") === "/console/applications/keys" &&
    (await (async () => {
      const list = await getHtml("/console/applications/keys");
      return list.includes("revoked");
    })()),
);

// ---------------------------------------------------------------------------
// 2. HOSTILE probes (AC3) — refused/escaped, no reflected markup.
// ---------------------------------------------------------------------------

const hostileEncoded = encodeURIComponent(HOSTILE);
check(
  "hostile probe: a markup-carrying execution id is refused (honest 404) and rendered escaped",
  await (async () => {
    const response = await get(`/runs/${hostileEncoded}`);
    const html = await response.text();
    return (
      response.status === 404 &&
      !html.includes("<script>") &&
      !html.includes(HOSTILE) &&
      html.includes("&quot;&gt;&lt;script&gt;")
    );
  })(),
);

check(
  "hostile probe: the lookup redirect percent-encodes a markup-carrying id",
  await (async () => {
    const response = await get(`/executions?id=${hostileEncoded}`);
    return (
      response.status === 303 &&
      (response.headers.get("location") ?? "") === `/runs/${hostileEncoded}` &&
      !(response.headers.get("location") ?? "").includes("<")
    );
  })(),
);

check(
  "hostile probe: a markup-carrying family id renders the honest unknown-family 404, escaped",
  await (async () => {
    const response = await get(`/console/playground/${hostileEncoded}`);
    const html = await response.text();
    return (
      response.status === 404 &&
      html.includes("No such workload family") &&
      !html.includes("<script>") &&
      html.includes("&quot;&gt;&lt;script&gt;")
    );
  })(),
);

check(
  "hostile probe: a markup-carrying credential label is refused client-side and re-rendered escaped (D3/D5 wiring live)",
  await (async () => {
    const response = await postForm("/console/applications/keys/issue", {
      label: HOSTILE,
      role: "member",
      idempotencyKey: "dash-hostile-label",
    });
    const html = await response.text();
    return (
      response.status === 422 &&
      html.includes('class="field-error" id="label-error" role="alert"') &&
      html.includes('aria-describedby="credential-label-help label-error"') &&
      !html.includes("<script>")
    );
  })(),
);

check(
  "hostile probe: markup in a playground composer field is refused by the synthetic-data rules before any wire call",
  await (async () => {
    const response = await postForm("/console/playground/text", {
      applicationId: APP_ID,
      idempotencyKey: "dash-hostile-compose",
      "task.doc": HOSTILE,
      "task.maxWords": "60",
    });
    const html = await response.text();
    return (
      response.status === 422 &&
      html.includes("field-error") &&
      html.includes("synthetic corpus values") &&
      !html.includes("<script>") &&
      // The refused value is re-rendered escaped inside its field.
      !html.includes(`value="${HOSTILE}"`)
    );
  })(),
);

check(
  "hostile probe: cookie-derived recents carrying a hostile unknown id are pruned and never reflected raw",
  await (async () => {
    const cookie = `zeck_recent_executions=${encodeURIComponent(`${executionId},${HOSTILE}`)}`;
    const response = await get("/", cookie);
    const html = await response.text();
    const setCookie = response.headers.get("set-cookie") ?? "";
    return (
      response.status === 200 &&
      !html.includes("<script>") &&
      html.includes(executionId) &&
      setCookie.includes(encodeURIComponent(executionId)) &&
      !setCookie.includes("<") &&
      !setCookie.includes(encodeURIComponent(HOSTILE))
    );
  })(),
);

check(
  "redaction doctrine: secret-shaped keys in the raw payload view render [not displayed], never the value",
  await (async () => {
    // A hostile event with secret-shaped payload keys, appended through
    // the store (the executing worker's governed write seam).
    const sequence =
      (await store.listEvents(APP_ID, executionId)).reduce(
        (max, event) => Math.max(max, event.sequence),
        0,
      ) + 1;
    await store.appendEvent({
      eventId: newId(),
      executionId,
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      sequence,
      type: "execution.probe",
      command: "pass",
      actor: { actorId: ACTOR_ID, tenantId: TENANT_ID },
      cause: "smoke hostile payload",
      payload: { note: HOSTILE, api_key: "sk-live-smoke-never-render-4471" },
      occurredAt: now(),
    });
    const html = await getHtml(`/runs/${executionId}?tab=activity&view=raw`);
    return html.includes("[not displayed]") && !html.includes("sk-live-smoke-never-render-4471") && !html.includes("<script>");
  })(),
);

// ---------------------------------------------------------------------------
// 3. RESPONSIVE-class render checks (AC2) — the served wire CSS.
// ---------------------------------------------------------------------------

check(
  "responsive render: viewport meta + the D1 scroll-trap fix + the 1024/640 media queries are served",
  await (async () => {
    const html = await getHtml("/console/executions");
    return (
      html.includes('name="viewport"') &&
      html.includes(".app-header, .app-nav, .app-main, .app-footer { min-width: 0; }") &&
      html.includes("table.data, table.kv { display: block; overflow-x: auto; }") &&
      html.includes("@media (max-width: 1024px)") &&
      html.includes("@media (max-width: 640px)") &&
      html.includes("ol.steps { display: grid;")
    );
  })(),
);

check(
  "responsive render: the wide console tables keep REAL table semantics beside the in-box scroll",
  await (async () => {
    // The explorer detail's fact tables: kv rows with scope="row".
    const detail = await getHtml(`/console/executions/${executionId}`);
    // The run's activity events view: a table.data with thead + scope="col".
    const events = await getHtml(`/runs/${executionId}?tab=activity&view=events`);
    return (
      detail.includes('<table class="kv">') &&
      detail.includes('scope="row"') &&
      events.includes('<table class="data">') &&
      events.includes("<thead>") &&
      events.includes('scope="col"')
    );
  })(),
);

// ---------------------------------------------------------------------------
// 4. NO-SCRIPT foundation checks (AC4).
// ---------------------------------------------------------------------------

check(
  "no-script foundation: every console journey page carries native links and zero inline handlers",
  await (async () => {
    for (const path of JOURNEY_PAGES) {
      const html = await getHtml(path);
      if (!html.includes('<a href="/')) return false;
      if (/\son[a-z]+\s*=/i.test(html)) return false;
      if (html.includes("javascript:")) return false;
    }
    return true;
  })(),
);

check(
  "no-script foundation: native GET forms (lookup + mode/appearance preferences) and details/summary disclosures",
  await (async () => {
    const explorer = await getHtml("/console/executions");
    const settings = await getHtml("/console/settings");
    const keys = await getHtml("/console/applications/keys");
    return (
      explorer.includes('<form method="get" action="/executions" class="flow card">') &&
      settings.includes('method="get" action="/mode"') &&
      settings.includes('method="get" action="/appearance"') &&
      keys.includes("<details") &&
      keys.includes("<summary") &&
      explorer.includes("<details")
    );
  })(),
);

check(
  "no-script foundation: client.js is the single deferred external script (the enhancement layer)",
  await (async () => {
    const html = await getHtml("/console/quickstart");
    const scriptTags = html.match(/<script/g) ?? [];
    const client = await get("/assets/client.js");
    return (
      scriptTags.length === 1 &&
      html.includes('<script src="/assets/client.js" defer></script>') &&
      client.status === 200 &&
      (client.headers.get("content-type") ?? "").includes("javascript")
    );
  })(),
);

check(
  "no-script foundation: the mode switch round-trips as a plain GET (cookie set, redirect back)",
  await (async () => {
    const response = await get("/mode?level=simple&returnTo=/console/settings");
    const setCookie = response.headers.get("set-cookie") ?? "";
    return (
      response.status === 303 &&
      (response.headers.get("location") ?? "") === "/console/settings" &&
      setCookie.includes("zeck_mode=simple")
    );
  })(),
);

await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
await server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
