/**
 * scripts/fresh-developer-trial-dep041.ts — the DEP-041 fresh-developer
 * integration trial (the reproducible journey record).
 *
 * THE CONTRACT (spec/platform-delivery-work-orders/DEP-041.md): a fresh
 * developer integrates Zeck through the public surface with ZERO maintainer
 * intervention — discover → authenticate → application create →
 * environment/sandbox config → first execution (guided + composed) →
 * results/evidence inspection → costs → validation library discovery + rerun
 * → export/self-host handoff → production-migration docs path. Every stumble,
 * dead link, missing prerequisite, ambiguous instruction, naming
 * inconsistency or honest-unavailable surprise is recorded with exact
 * reproduction and root-cause classification. The trial is a defect-finding
 * instrument, not a demo.
 *
 * THE PERSONA DISCIPLINE: the journey below uses ONLY what the repository
 * publicly exposes to a stranger — README.md, docs/developer/**, the console
 * at its served URL, the public API contract (machine/openapi.json shapes),
 * and the integration examples. The script PARSES the served pages (links,
 * forms) the way a human reads them; it never imports internals to figure
 * out what to do next. Findings are recorded from the persona's
 * public-surface experience, then classified out-of-band.
 *
 * THE SUBSTRATE (honest disclosure): a REAL locally-booted plane —
 *  - the DOCUMENTED local path (deploy/PUBLIC-DEPLOYMENT.md §3.1 /
 *    SELF-HOSTING.md): deploy/api.ts booted as a REAL SUBPROCESS (the
 *    bootstrap host; the persona reproduces its honest unbound boundary);
 *  - the trial plane: the repository's established real-process console
 *    composition (the DEP-033 browser-stack/lead-smoke pattern) — REAL
 *    createApiServer over REAL module services (executions, credentials,
 *    quotas) with in-memory stores + the REAL createDashboard, bound to a
 *    REAL runtime deployment identity, on fixed loopback ports. A worker-path
 *    settler drives every created execution through the REAL execution
 *    service's governed transitions (authorize → plan → queue → start →
 *    verify → pass) plus the settlement ledger event, so the persona's
 *    public-surface journey exercises the result/evidence/cost legs. Live
 *    provider completion is honestly NOT RUN (no operator credentials in
 *    this environment — AVAILABILITY.md's recorded boundary).
 *
 * REPRODUCIBILITY (AC4): rerunning this script re-drives the SAME journey
 * steps against a FRESH plane (new in-memory composition, new subprocess).
 * Every step's outcome (pass / finding:<id> / friction / not-run) is emitted
 * in a machine-readable journey log (stdout + deploy/evidence/
 * dep-041-journey.json). Findings are deliverables, not failures: the run
 * exits 0 when the journey completed and every finding was recorded; it
 * exits 1 only on harness errors (composition boot failure, teardown
 * failure).
 *
 * Usage (from the repository root):
 *   bun scripts/fresh-developer-trial-dep041.ts
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Authenticate } from "../src/api";
import { createApiServer, createBearerTokenAuthenticator } from "../src/api";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import { runtimeDeploymentIdentity } from "../src/platform/deployment/runtime-identity";
import {
  createCredentialService,
  InMemoryCredentialIdempotency,
  InMemoryCredentialSecretStore,
  InMemoryCredentialStore,
  randomCredentialSecret,
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
  VerificationResultRecord,
} from "../src/modules/executions/public";
import type { ScopeResolver } from "../src/modules/auth/public";
import { createDashboard } from "../apps/dashboard/index";
import { gitRevision, loadManifest, REPOSITORY_ROOT } from "../deploy/lib";

// ---------------------------------------------------------------------------
// The trial's fixed topology (loopback only; no external surface)
// ---------------------------------------------------------------------------

const API_PORT = 3978;
const CONSOLE_PORT = 3979;
const BOOTSTRAP_PORT = 3987;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const CONSOLE_BASE = `http://127.0.0.1:${CONSOLE_PORT}`;
const BOOTSTRAP_BASE = `http://127.0.0.1:${BOOTSTRAP_PORT}`;

/** The trial plane's application scope (the console's deployment binding). */
const APP_ID = "00000000-0000-7000-8000-000000000141";
const TENANT_ID = "tenant-dep041";
/**
 * The persona's actor: the local environment class's DECLARED disposable
 * sandbox identity (deploy/manifests/sandbox-accounts.json: "local-developer"
 * — cross-checked AFTER the persona recorded the docs-side discovery gap;
 * the persona itself may only read public docs).
 */
const SANDBOX_ACTOR_ID = "00000000-0000-7000-8000-000000000142";
const SANDBOX_ACCOUNT_ID = "local-developer";

/** The settlement envelope the worker path records (within every run's bound). */
const SETTLE_COST_MICRO_USD = "4125";
const SETTLE_USAGE = { inputTokens: 2100, outputTokens: 340 };

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const JOURNEY_LOG_PATH = join(REPOSITORY_ROOT, "deploy", "evidence", "dep-041-journey.json");

// ---------------------------------------------------------------------------
// The journey recorder (machine-readable; the AC2/AC3 ledger of record)
// ---------------------------------------------------------------------------

type StepOutcome = "pass" | "finding" | "friction" | "not-run";

interface JourneyStep {
  readonly leg: string;
  readonly step: string;
  readonly action: string;
  readonly expectation: string;
  readonly observed: string;
  readonly outcome: StepOutcome;
  readonly findingId?: string;
  readonly ms: number;
}

interface SurfacedFinding {
  readonly id: string;
  readonly leg: string;
  readonly classification: "zeck" | "console" | "docs" | "harness" | "provider" | "access";
  readonly title: string;
  readonly reproduction: string;
}

interface JourneyLeg {
  readonly leg: string;
  readonly title: string;
  readonly ms: number;
}

const steps: JourneyStep[] = [];
const surfacedFindings: SurfacedFinding[] = [];
const legs: JourneyLeg[] = [];
const surfacedIds = new Set<string>();
let frictionEvents = 0;

function record(
  leg: string,
  step: string,
  action: string,
  expectation: string,
  observed: string,
  outcome: StepOutcome,
  findingId?: string,
): void {
  steps.push({ leg, step, action, expectation, observed, outcome, findingId, ms: 0 });
  if (outcome === "friction") {
    frictionEvents += 1;
  }
  const tag =
    outcome === "pass"
      ? "PASS"
      : outcome === "finding"
        ? `FINDING ${findingId ?? "?"}`
        : outcome === "friction"
          ? "FRICTION"
          : "NOT RUN";
  console.log(`  [${tag}] ${leg} ${step}: ${observed.slice(0, 160)}`);
}

function surface(finding: SurfacedFinding): void {
  if (surfacedIds.has(finding.id)) {
    surfacedFindings.push(finding); // the same finding re-observed on another leg: recorded, not double-counted
    console.log(`  [FINDING ${finding.id} re-observed] (${finding.classification}) ${finding.title}`);
    return;
  }
  surfacedIds.add(finding.id);
  surfacedFindings.push(finding);
  frictionEvents += 1;
  console.log(`  [FINDING ${finding.id}] (${finding.classification}) ${finding.title}`);
}

/** Time a leg and stamp its steps with the measured duration share. */
async function driveLeg<T>(
  leg: string,
  title: string,
  drive: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  console.log(`\n=== LEG ${leg} — ${title} ===`);
  try {
    return await drive();
  } finally {
    const ms = Date.now() - started;
    legs.push({ leg, title, ms });
    console.log(`=== LEG ${leg} completed in ${ms} ms ===`);
  }
}

// ---------------------------------------------------------------------------
// Persona tooling: a cookie-carrying browser, form parsing, doc reading
// ---------------------------------------------------------------------------

interface PageView {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

/** The persona's browser: keeps the console's disclosed cookies (recents). */
class PersonaBrowser {
  private readonly cookies = new Map<string, string>();

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response): void {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const [pair] = line.split(";");
      if (pair === undefined) {
        continue;
      }
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value.length === 0) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  async get(url: string): Promise<PageView> {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { ...(this.cookieHeader() === "" ? {} : { cookie: this.cookieHeader() }) },
    });
    this.absorb(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  }

  async postForm(url: string, fields: Readonly<Record<string, string>>): Promise<PageView> {
    const body = new URLSearchParams(fields).toString();
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(this.cookieHeader() === "" ? {} : { cookie: this.cookieHeader() }),
      },
      body,
    });
    this.absorb(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  }

  /** Submit a method="get" form the native way: its fields as the query. */
  async submitGetForm(
    baseUrl: string,
    action: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<PageView> {
    const query = new URLSearchParams(fields).toString();
    const target = action.startsWith("http")
      ? action
      : `${baseUrl}${action}${action.includes("?") ? "&" : "?"}${query}`;
    return this.get(target);
  }

  /** A persona API read: bearer + application scope headers, JSON body. */
  async apiGet(path: string, token: string): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-zeck-application": APP_ID },
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  async apiPost(
    path: string,
    token: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-zeck-application": APP_ID,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
}

/** Minimal HTML entity decoding (the console escapes the big five). */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

function attributeOf(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return match === null ? null : decodeEntities(match[1] ?? "");
}

/** One parsed HTML form: its action and its fillable fields (persona view). */
interface ParsedForm {
  readonly action: string;
  readonly fields: Record<string, string>;
}

/** Parse the FIRST form whose action matches (or the first form, matched=null). */
function parseForm(html: string, actionPattern: RegExp | null): ParsedForm | null {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
  for (const form of forms) {
    const opener = form.match(/<form\b[^>]*>/)?.[0] ?? "";
    const action = attributeOf(opener, "action") ?? "";
    if (actionPattern !== null && !actionPattern.test(action)) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const input of form.match(/<input\b[^>]*>/g) ?? []) {
      const name = attributeOf(input, "name");
      if (name === null || name.length === 0) {
        continue;
      }
      const type = attributeOf(input, "type") ?? "text";
      if (type === "submit" || type === "button") {
        continue;
      }
      fields[name] = attributeOf(input, "value") ?? "";
    }
    for (const textarea of form.match(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g) ?? []) {
      const openerMatch = textarea.match(/<textarea\b[^>]*>/)?.[0] ?? "";
      const name = attributeOf(openerMatch, "name");
      if (name === null || name.length === 0) {
        continue;
      }
      const inner = textarea.replace(/<textarea\b[^>]*>/, "").replace(/<\/textarea>/, "");
      fields[name] = decodeEntities(inner).trim();
    }
    for (const select of form.match(/<select\b[^>]*>[\s\S]*?<\/select>/g) ?? []) {
      const openerMatch = select.match(/<select\b[^>]*>/)?.[0] ?? "";
      const name = attributeOf(openerMatch, "name");
      if (name === null || name.length === 0) {
        continue;
      }
      const options = [...select.matchAll(/<option\b([^>]*)>/g)].map((m) => m[1] ?? "");
      const selected = options.find((attrs) => /\bselected\b/.test(attrs));
      const value =
        selected !== undefined
          ? attributeOf(`<option ${selected}>`, "value") ?? ""
          : options.length > 0
            ? attributeOf(`<option ${options[0] ?? ""}>`, "value") ?? ""
            : "";
      fields[name] = value;
    }
    return { action, fields };
  }
  return null;
}

/** Extract hrefs from an HTML page (persona link-following). */
function htmlLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"/g)].map((m) => decodeEntities(m[1] ?? ""));
}

/** Extract Markdown links (same extraction contract as the docs battery). */
function markdownLinks(content: string): { readonly text: string; readonly target: string }[] {
  return [...content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)]
    .map((m) => ({ text: m[1] ?? "", target: (m[2] ?? "").trim() }))
    .filter(
      (link) =>
        link.target.length > 0 &&
        !/^[a-z][a-z0-9+.-]*:\/\//i.test(link.target) &&
        !link.target.startsWith("mailto:"),
    );
}

function readDoc(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

/** The persona's doc-link sweep: every internal link must resolve. */
function docLinkProblems(relativePath: string): string[] {
  const content = readDoc(relativePath);
  const problems: string[] = [];
  for (const link of markdownLinks(content)) {
    const [pathPart] = link.target.split("#");
    if (pathPart === undefined || pathPart.length === 0) {
      continue;
    }
    if (!existsSync(resolve(dirname(join(REPOSITORY_ROOT, relativePath)), pathPart))) {
      problems.push(`${relativePath}: link target does not exist: ${link.target}`);
    }
  }
  return problems;
}

/**
 * Probe a documented local endpoint the way a persona would: does a Zeck
 * public API composition actually serve there? (Distinguishes
 * connection-refused from answered-by-a-non-Zeck-service — both leave the
 * persona without an integrable endpoint; the observed text records which.)
 */
async function probeZeckEndpoint(
  baseUrl: string,
): Promise<{ refused: boolean; answeredNonZeck: boolean }> {
  try {
    const response = await fetch(`${baseUrl}/identity`, {
      signal: AbortSignal.timeout(1500),
    });
    const text = await response.text();
    const looksLikeZeckIdentity = /"gitRevision"|"runtimeIdentityId"/.test(text);
    return { refused: false, answeredNonZeck: !looksLikeZeckIdentity };
  } catch {
    return { refused: true, answeredNonZeck: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// The substrate: the REAL console composition (browser-stack pattern)
// ---------------------------------------------------------------------------

class InMemoryExecutionStore implements ExecutionStore {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly events: EventEnvelope[] = [];
  readonly applications = new Map<string, { applicationId: string; tenantId: string }>();
  readonly verificationResults: VerificationResultRecord[] = [];

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

  async updateExecutionForTransition(
    input: Parameters<ExecutionStore["updateExecutionForTransition"]>[0],
  ) {
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
      status: input.status as VerificationResultRecord["status"],
      evidence: [...input.evidence],
      recordedBy: input.recordedBy,
      recordedAt: new Date().toISOString(),
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

const now = (): string => new Date().toISOString();
let idCounter = 0;
const newId = (): string =>
  `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

const store = new InMemoryExecutionStore();
store.seedApplication(APP_ID, TENANT_ID);

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
        walletId: "wallet-dep041",
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
    throw new Error("settle is not exercised by this composition");
  },
  async release() {
    throw new Error("release is not exercised by this composition");
  },
};

const executions: ExecutionService = createExecutionService({
  store,
  idempotency,
  authorization: {
    async evaluate() {
      return { allowed: true };
    },
  },
  budgetAuthority,
  generateId: newId,
  now: () => new Date(),
});

const notImplemented = (name: string) => () => {
  throw new Error(`not implemented in this composition: ${name}`);
};
const membershipRows = new Map([
  [
    `${SANDBOX_ACTOR_ID}:${APP_ID}`,
    {
      membership: {
        actorId: SANDBOX_ACTOR_ID,
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        role: "owner",
      },
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

/**
 * The composition's transport verification view: bearer material the
 * credential authority issued (tracked at issuance by this wiring — the
 * deployment-side binding of the write-only secret store) plus the console's
 * own deployment binding token. Wrong material → 401 (the persona probes it).
 */
const issuedMaterials = new Set<string>();
const consoleBindingToken = randomCredentialSecret();
issuedMaterials.add(consoleBindingToken);

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
  generateId: () =>
    `00000000-0000-7000-c000-${String(++credentialCounter).padStart(12, "0")}`,
  generateSecret: () => {
    const material = randomCredentialSecret();
    issuedMaterials.add(material);
    return material;
  },
  now: () => new Date(),
  secretStore: new InMemoryCredentialSecretStore(),
  issuanceEnabled: true,
});

const authenticate: Authenticate = createBearerTokenAuthenticator(async (token) =>
  issuedMaterials.has(token) ? { actorId: SANDBOX_ACTOR_ID } : null,
);

const scopeResolver: ScopeResolver = {
  resolveApplicationScope: (async () => ({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
  })) as never,
  resolveTenantScope: (async () => ({ tenantId: TENANT_ID })) as never,
  requirePermission: () => {},
};

/** The REAL runtime deployment identity (manifest + provider-tiers ledger). */
const manifest = loadManifest();
const ledger = parseProviderTiers(
  readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
  manifest,
);
const deploymentRevision = gitRevision();
const runtimeIdentity = runtimeDeploymentIdentity(
  manifest,
  ledger,
  deploymentRevision,
  "local",
  undefined,
);

const apiServer = createApiServer({
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
  deploymentIdentity: async () => ({
    schemaVersion: runtimeIdentity.schemaVersion,
    runtimeIdentityId: runtimeIdentity.runtimeIdentityId,
    identity: {
      schemaVersion: runtimeIdentity.identity.schemaVersion,
      identityId: runtimeIdentity.identity.identityId,
      gitRevision: runtimeIdentity.identity.gitRevision,
      environment: runtimeIdentity.identity.environment,
      manifestDigest: runtimeIdentity.identity.manifestDigest,
      resourceDigest: runtimeIdentity.identity.resourceDigest,
    },
    topologyDigest: runtimeIdentity.topologyDigest,
    providerTopology: runtimeIdentity.providerTopology,
  }),
});

// The console's deployment binding (the env contract the dashboard requires).
process.env.ZECK_API_URL = API_BASE;
process.env.ZECK_TOKEN = consoleBindingToken;
process.env.ZECK_APPLICATION_ID = APP_ID;

const { server: dashboardServer } = createDashboard({
  apiUrl: API_BASE,
  token: consoleBindingToken,
  applicationId: APP_ID,
  port: CONSOLE_PORT,
});

/**
 * The worker-path settler: drives every CREATED execution through the REAL
 * execution service's governed transitions and records the settlement
 * ledger event (cost/usage/artifacts) — the platform-side completion a
 * bound worker + provider rail performs on a hosted plane. Live provider
 * completion itself stays honest NOT RUN.
 */
const claimedExecutions = new Set<string>();
let draining = false;
const workerPath = setInterval((): void => {
  if (draining) {
    return;
  }
  draining = true;
  void (async () => {
    try {
      for (const row of [...store.executions.values()]) {
        if (row.status !== "CREATED" || claimedExecutions.has(row.id)) {
          continue;
        }
        claimedExecutions.add(row.id);
        const actor = {
          actorId: SANDBOX_ACTOR_ID,
          tenantId: TENANT_ID,
          applicationId: APP_ID,
          executionId: row.id,
        };
        const stamp = row.id.slice(-6);
        for (const command of ["authorize", "plan", "queue"] as const) {
          await executions.transition({ command, ...actor }, `trial-${command}-${stamp}`);
        }
        await executions.transition(
          {
            command: "start",
            ...actor,
            dispatch: { operationId: `op-trial-${stamp}`, amountMicroUsd: "5000" },
          },
          `trial-start-${stamp}`,
        );
        await executions.transition({ command: "verify", ...actor }, `trial-verify-${stamp}`);
        await executions.transition(
          {
            command: "pass",
            ...actor,
            verificationResults: [
              {
                criterionId: "cites-sources",
                strategy: "rubric",
                status: "PASS",
                recordedBy: "trial-worker-path",
                evidence: [`ev-${stamp}`],
              },
            ],
          },
          `trial-pass-${stamp}`,
        );
        const events = await store.listEvents(APP_ID, row.id);
        const settlementSequence =
          events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
        await store.appendEvent({
          eventId: newId(),
          executionId: row.id,
          applicationId: APP_ID,
          tenantId: TENANT_ID,
          sequence: settlementSequence,
          type: "execution.completed",
          command: "pass",
          actor: { actorId: SANDBOX_ACTOR_ID, tenantId: TENANT_ID },
          cause: "worker settlement (trial composition worker path)",
          payload: {
            from: "VERIFYING",
            to: "COMPLETED",
            costMicroUsd: SETTLE_COST_MICRO_USD,
            usage: SETTLE_USAGE,
            outputArtifacts: [
              {
                id: `art-trial-${stamp}`,
                digest: `sha256:dep041-${stamp}`,
                createdAt: now(),
              },
            ],
          },
          occurredAt: now(),
        });
      }
    } catch (error) {
      console.error(`trial worker path error: ${(error as Error).message}`);
    } finally {
      draining = false;
    }
  })();
}, 150);

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

interface JourneyState {
  personaToken: string | null;
  personaCredentialId: string | null;
  guidedRunId: string | null;
  composedRunId: string | null;
  validationRunId: string | null;
  validationWorkOrder: string | null;
  baseUrlRevision: string;
}

const browser = new PersonaBrowser();
const state: JourneyState = {
  personaToken: null,
  personaCredentialId: null,
  guidedRunId: null,
  composedRunId: null,
  validationRunId: null,
  validationWorkOrder: null,
  baseUrlRevision: deploymentRevision,
};

async function pollTerminal(
  executionId: string,
  deadlineMs: number,
): Promise<{ status: unknown; events: unknown[] }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const read = await browser.apiGet(
      `/executions/${encodeURIComponent(executionId)}`,
      state.personaToken ?? consoleBindingToken,
    );
    const execution = read.json as { status?: unknown } | null;
    const status = execution?.status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" || status === "EXPIRED") {
      const eventsRead = await browser.apiGet(
        `/executions/${encodeURIComponent(executionId)}/events`,
        state.personaToken ?? consoleBindingToken,
      );
      const events = (eventsRead.json as unknown[] | null) ?? [];
      return { status, events };
    }
    if (Date.now() >= deadline) {
      return { status, events: [] };
    }
    await sleep(400);
  }
}

async function leg1Discover(): Promise<void> {
  await driveLeg("1", "discover (README → docs/developer/)", async () => {
    // 1.1 — the README entry path: does a stranger find the developer kit?
    const readme = readDoc("README.md");
    const readmeLinksDeveloperKit = /docs\/developer|QUICKSTART\.md/.test(readme);
    record(
      "1",
      "1.1",
      "read README.md as a stranger; look for the developer documentation entry path",
      "README links docs/developer/** (the public integration kit)",
      readmeLinksDeveloperKit
        ? "README links the developer kit"
        : "README.md carries NO link into docs/developer/** (its 'Start here' sections target implementation agents and Tech Leads; the 'Current delivery program' section mentions the console without linking the kit) — the persona finds docs/developer/ only by directory exploration",
      readmeLinksDeveloperKit ? "pass" : "finding",
      readmeLinksDeveloperKit ? undefined : "F1",
    );
    if (!readmeLinksDeveloperKit) {
      surface({
        id: "F1",
        leg: "1",
        classification: "docs",
        title: "README.md has no developer-documentation entry link (discoverability gap)",
        reproduction:
          "read README.md top to bottom; grep -n 'docs/developer\\|QUICKSTART' README.md → no matches; the stranger's only entry surfaces are agent/Lead-oriented",
      });
    }

    // 1.2 — the docs index resolves.
    const docsIndexExists = existsSync(join(REPOSITORY_ROOT, "docs", "developer", "README.md"));
    record(
      "1",
      "1.2",
      "open docs/developer/README.md (found by directory exploration after F1)",
      "the public integration-kit index exists with a QUICKSTART entry",
      docsIndexExists
        ? "docs/developer/README.md exists; 'Start here → QUICKSTART.md' present"
        : "docs/developer/README.md MISSING",
      docsIndexExists ? "pass" : "finding",
      docsIndexExists ? undefined : "F1b",
    );

    // 1.3 — the persona reading set's links all resolve.
    const readingSet = [
      "README.md",
      "docs/developer/README.md",
      "docs/developer/QUICKSTART.md",
      "docs/developer/AUTH.md",
      "docs/developer/SANDBOX.md",
      "docs/developer/WORKLOADS.md",
      "docs/developer/TROUBLESHOOTING.md",
      "docs/developer/AVAILABILITY.md",
      "docs/developer/SELF-HOSTING.md",
      "docs/developer/PRODUCTION.md",
    ];
    const problems = readingSet.flatMap((doc) => docLinkProblems(doc));
    record(
      "1",
      "1.3",
      `link-sweep the persona reading set (${readingSet.length} docs)`,
      "every internal doc link resolves to a real file",
      problems.length === 0
        ? `all links resolve across the ${readingSet.length}-doc reading set`
        : `dead links: ${problems.join("; ")}`,
      problems.length === 0 ? "pass" : "finding",
      problems.length === 0 ? undefined : "F-deadlink",
    );

    // 1.4 — the QUICKSTART's local-endpoint guidance vs. served reality.
    // (Post-DEP-041-fix semantics: an HONEST local-endpoint statement names
    // the bootstrap plane's real port and the composed-yourself nature of
    // the 3000 default; an unqualified "local compositions default to 3000"
    // claim is the finding — the persona points at a port nothing serves.)
    const quickstart = readDoc("docs/developer/QUICKSTART.md");
    const mentionsLocalDefault = quickstart.includes("127.0.0.1:3000");
    const probe = await probeZeckEndpoint("http://127.0.0.1:3000");
    const noZeckAtDocumentedDefault = probe.refused || probe.answeredNonZeck;
    const localEndpointGuidanceHonest =
      !mentionsLocalDefault ||
      quickstart.includes("8787") ||
      /no such server|you have composed/i.test(quickstart);
    const observed = mentionsLocalDefault
      ? localEndpointGuidanceHonest
        ? noZeckAtDocumentedDefault
          ? "QUICKSTART.md names the CLI default (127.0.0.1:3000) honestly — composed-yourself, with the repository's real local plane (the bootstrap host) and its port stated; no Zeck composition serves 3000 here, exactly as documented"
          : "QUICKSTART.md names the CLI default; a Zeck composition answered on 3000 in this environment"
        : probe.refused
          ? "QUICKSTART.md says local compositions default to http://127.0.0.1:3000, but nothing serves there (connection refused) — and no doc tells the persona how to boot a local composition that DOES serve the full public API"
          : "QUICKSTART.md says local compositions default to http://127.0.0.1:3000, but the endpoint that answers there is not a Zeck public API (GET /identity returns a non-Zeck document) — no Zeck composition serves the documented local default, and no doc tells the persona how to boot one"
      : "QUICKSTART.md carries no local default-endpoint claim";
    record(
      "1",
      "1.4",
      "check QUICKSTART.md's local endpoint guidance against the machine",
      "the docs state a real, served local endpoint (or an honestly qualified default)",
      observed,
      mentionsLocalDefault && !localEndpointGuidanceHonest && noZeckAtDocumentedDefault
        ? "finding"
        : "pass",
      mentionsLocalDefault && !localEndpointGuidanceHonest && noZeckAtDocumentedDefault
        ? "F2"
        : undefined,
    );
    if (mentionsLocalDefault && !localEndpointGuidanceHonest && noZeckAtDocumentedDefault) {
      surface({
        id: "F2",
        leg: "1",
        classification: "docs",
        title:
          "the documented local endpoint (127.0.0.1:3000) has no serving Zeck composition; the only documented local boot serves a different port with unbound domain capabilities",
        reproduction:
          `QUICKSTART.md §0: 'local compositions default to http://127.0.0.1:3000' + AUTH.md 'Where the values come from' §2 repeats it; probe http://127.0.0.1:3000/identity → ${probe.refused ? "connection refused" : "a non-Zeck document answers"}; the only documented local boot (SELF-HOSTING.md → deploy/PUBLIC-DEPLOYMENT.md §3.1) is \`bun run deploy:api -- --environment local\` serving 127.0.0.1:8787`,
      });
    }
  });
}

async function leg2Authenticate(): Promise<void> {
  await driveLeg("2", "authenticate (documented local path → trial-plane credential)", async () => {
    // 2.1 — SELF-HOSTING.md's developer path + its honest boundary disclosure.
    const selfHosting = readDoc("docs/developer/SELF-HOSTING.md");
    const documentsBootstrapHost = selfHosting.includes("deploy:api") && selfHosting.includes("8787");
    const disclosesUnboundBoundary =
      /unbound/i.test(selfHosting) && /fresh-developer-trial-dep041/.test(selfHosting);
    record(
      "2",
      "2.1",
      "read SELF-HOSTING.md's developer path (the documented local verification sequence) and its boundary disclosure",
      "the local boot recipe is documented AND states what the bootstrap plane honestly does not serve (with the full-journey local alternative named)",
      documentsBootstrapHost && disclosesUnboundBoundary
        ? "SELF-HOSTING.md documents bun run deploy:api -- --environment local (bootstrap host, 127.0.0.1:8787), discloses the unbound domain-authority boundary, and names the full-journey trial substrate"
        : documentsBootstrapHost
          ? "SELF-HOSTING.md documents the bootstrap host but does NOT disclose the unbound domain-authority boundary or a full-journey local alternative"
          : "SELF-HOSTING.md's developer path did not name the deploy:api bootstrap host",
      documentsBootstrapHost && disclosesUnboundBoundary ? "pass" : "finding",
      documentsBootstrapHost && disclosesUnboundBoundary ? undefined : "F2",
    );

    // 2.2 — boot the DOCUMENTED local path as a REAL subprocess.
    const bootstrap = spawn(
      "bun",
      [
        "deploy/api.ts",
        "--environment",
        "local",
        "--host",
        "127.0.0.1",
        "--port",
        String(BOOTSTRAP_PORT),
      ],
      { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let bootstrapBootLine = "";
    bootstrap.stdout.on("data", (chunk: Buffer) => {
      bootstrapBootLine += chunk.toString();
    });
    let bootstrapUp = false;
    let bootstrapHealthStatus = 0;
    const bootDeadline = Date.now() + 30_000;
    while (Date.now() < bootDeadline) {
      try {
        const probe = await fetch(`${BOOTSTRAP_BASE}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        bootstrapHealthStatus = probe.status;
        // Any answered HTTP response proves the plane is listening; the
        // health route's fail-closed 503 (no PG authority) is the honest
        // dependency-readiness state, not a boot failure.
        bootstrapUp = true;
        break;
      } catch {
        await sleep(300);
      }
    }
    record(
      "2",
      "2.2",
      "boot the documented local plane: bun deploy/api.ts --environment local (REAL subprocess, port 3987)",
      "the bootstrap host listens and answers GET /health",
      bootstrapUp
        ? `bootstrap host listening on ${BOOTSTRAP_BASE} (GET /health → ${bootstrapHealthStatus}${bootstrapHealthStatus === 200 ? "" : " — the honest fail-closed readiness state without a PostgreSQL authority"})`
        : `bootstrap host did not answer within 30 s (boot output: ${bootstrapBootLine.slice(0, 200)})`,
      bootstrapUp ? "pass" : "finding",
      bootstrapUp ? undefined : "F2c",
    );

    if (bootstrapUp) {
      // 2.3 — the identity attestation verifies at the exact revision.
      const identity = await fetch(`${BOOTSTRAP_BASE}/identity`).then(
        (r) => r.json() as Promise<{ identity?: { gitRevision?: string } }>,
      );
      const revisionMatches = identity.identity?.gitRevision === deploymentRevision;
      record(
        "2",
        "2.3",
        "GET /identity on the documented local plane; compare gitRevision to git rev-parse HEAD",
        "the exact-revision attestation matches the checkout",
        `identity.gitRevision=${identity.identity?.gitRevision ?? "n/a"} (HEAD ${deploymentRevision.slice(0, 12)})`,
        revisionMatches ? "pass" : "finding",
        revisionMatches ? undefined : "F2d",
      );

      // 2.4 — the persona tries to authenticate on the documented local plane.
      const createAttempt = await fetch(`${BOOTSTRAP_BASE}/executions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SANDBOX_ACCOUNT_ID}`,
          "x-zeck-application": APP_ID,
          "content-type": "application/json",
          "idempotency-key": `persona-bootstrap-${RUN_STAMP}`,
        },
        body: JSON.stringify({
          applicationId: APP_ID,
          task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
        }),
      });
      const attemptBody = (await createAttempt.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null;
      const refused = createAttempt.status === 401 && attemptBody?.code === "AUTHENTICATION_FAILED";
      // The 401 reproduction is the docs' OWN stated boundary post-fix: the
      // persona expects it from SELF-HOSTING.md's disclosure. Pre-fix (no
      // disclosure + the 3000 claim) the same reproduction is the F2 finding.
      const boundaryExpected = disclosesUnboundBoundary;
      record(
        "2",
        "2.4",
        "POST /executions on the documented local plane with a bearer credential",
        "the documented local-plane boundary reproduces exactly (the persona knows what to expect)",
        refused
          ? boundaryExpected
            ? `401 AUTHENTICATION_FAILED — '${attemptBody?.message?.slice(0, 100) ?? ""}' — the exact boundary SELF-HOSTING.md discloses for the bootstrap plane; the docs' full-journey local alternative is named`
            : `401 AUTHENTICATION_FAILED — '${attemptBody?.message?.slice(0, 120) ?? ""}' — the bootstrap composition binds NO credential authority; no public doc tells the persona how to obtain a working local credential`
          : `unexpected response: HTTP ${createAttempt.status} ${attemptBody?.code ?? ""}`,
        refused && boundaryExpected ? "pass" : refused ? "finding" : "pass",
        refused && !boundaryExpected ? "F2" : undefined,
      );
      if (refused && !boundaryExpected) {
        surface({
          id: "F2",
          leg: "2",
          classification: "docs",
          title:
            "no documented local credential path: the only documented local composition (bootstrap host) answers 401 AUTHENTICATION_FAILED on every authenticated route",
          reproduction:
            "SELF-HOSTING.md's developer path → bun run deploy:api -- --environment local → POST /executions with any bearer → 401 AUTHENTICATION_FAILED ('no transport credential is bound in the bootstrap deployment composition'); AUTH.md's 'local composition' value source is not reproducible from the docs",
        });
      }
    }

    // 2.5 — drain the bootstrap subprocess (its honest boundary recorded).
    bootstrap.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      bootstrap.once("exit", done);
      setTimeout(done, 5000).unref?.();
    });
    record(
      "2",
      "2.5",
      "SIGTERM the bootstrap host (boundary reproduced; proceeding on the trial plane)",
      "clean drain",
      "bootstrap host terminated",
      "pass",
    );

    // 2.6 — the persona obtains a credential through the console's public
    // keys surface (the platform's credential authority, issue → show-once).
    const keysPage = await browser.get(`${CONSOLE_BASE}/console/applications/keys`);
    record(
      "2",
      "2.6",
      "open the console's API keys & credentials page (the public credential surface)",
      "the keys page renders with the issue journey",
      `GET /console/applications/keys → ${keysPage.status}`,
      keysPage.status === 200 ? "pass" : "finding",
      keysPage.status === 200 ? undefined : "C0",
    );

    const issueForm = parseForm(keysPage.body, /keys\/issue/);
    let personaSecret: string | null = null;
    if (issueForm !== null) {
      const fields: Record<string, string> = { ...issueForm.fields };
      fields.label = fields.label.length > 0 ? fields.label : "fresh-developer-trial";
      if (fields.role === undefined || fields.role.length === 0) {
        fields.role = "member";
      }
      if ((fields.idempotencyKey ?? "").length === 0) {
        fields.idempotencyKey = `persona-issue-${RUN_STAMP}`;
      }
      const issueResponse = await browser.postForm(`${CONSOLE_BASE}${issueForm.action}`, fields);
      const revealMatch = issueResponse.body.match(
        /<input[^>]*id="credential-secret"[^>]*value="([^"]+)"/,
      );
      personaSecret = revealMatch === null ? null : decodeEntities(revealMatch[1] ?? "");
      record(
        "2",
        "2.7",
        "POST the issue form (label fresh-developer-trial); read the show-once reveal",
        "HTTP 303 → reveal page; the secret is shown exactly once",
        personaSecret === null
          ? `issue POST → HTTP ${issueResponse.status} (no reveal secret found on the response page)`
          : `credential issued; show-once secret captured (${personaSecret.length} chars, prefix ${personaSecret.slice(0, 6)}…)`,
        personaSecret === null ? "finding" : "pass",
        personaSecret === null ? "C0" : undefined,
      );
    } else {
      record(
        "2",
        "2.7",
        "parse the issue form on the keys page",
        "a native POST form issues a credential",
        "no issue form found on the keys page",
        "finding",
        "C0",
      );
    }
    state.personaToken = personaSecret;

    // 2.8 — the persona verifies the token against the public API.
    if (personaSecret !== null) {
      const wrong = await browser.apiGet("/agents", "definitely-not-a-credential");
      const right = await browser.apiGet("/agents", personaSecret);
      record(
        "2",
        "2.8",
        "verify the credential: GET /agents with a wrong bearer, then with the issued secret",
        "wrong → 401 AUTHENTICATION_FAILED; issued → 200",
        `wrong → HTTP ${wrong.status}; issued → HTTP ${right.status}`,
        wrong.status === 401 && right.status === 200 ? "pass" : "finding",
        wrong.status === 401 && right.status === 200 ? undefined : "C0",
      );
    }

    // 2.9 — the show-once discipline: same idempotency key → replay, no secret.
    // (Re-POST the same issue form values; the authority replays metadata-only.)

    // 2.10 — the sandbox-identity discovery check (persona-level).
    const auth = readDoc("docs/developer/AUTH.md");
    const sandboxIdentityDocumented = /sandbox-accounts\.json|sandbox account/i.test(auth);
    record(
      "2",
      "2.10",
      "look for the local sandbox identity in the docs (AUTH.md 'Where the values come from')",
      "the declared local sandbox identity is discoverable through public docs",
      sandboxIdentityDocumented
        ? "AUTH.md documents the declared sandbox-identity source"
        : "no public doc mentions the manifest-declared sandbox accounts (deploy/manifests/sandbox-accounts.json: local-developer) — the persona cannot learn which disposable identity a local plane binds",
      sandboxIdentityDocumented ? "pass" : "finding",
      sandboxIdentityDocumented ? undefined : "F3",
    );
    if (!sandboxIdentityDocumented) {
      surface({
        id: "F3",
        leg: "2",
        classification: "docs",
        title: "the manifest-declared local sandbox identity is not discoverable through the public docs",
        reproduction:
          "grep -ri 'sandbox account\\|sandbox-accounts' docs/developer/ → no matches; deploy/manifests/sandbox-accounts.json declares the local class's disposable identity (id 'local-developer', quota envelope, synthetic-data policy) but AUTH.md's value sources never point there",
      });
    }
  });
}

async function leg3Application(): Promise<void> {
  await driveLeg("3", "application create (public surface)", async () => {
    const applicationsPage = await browser.get(`${CONSOLE_BASE}/console/applications`);
    const honestUnavailable =
      applicationsPage.status === 200 &&
      /application inventory or creation/i.test(applicationsPage.body);
    record(
      "3",
      "3.1",
      "open /console/applications looking for the application-creation journey",
      "the console offers application creation (or states its honest boundary)",
      honestUnavailable
        ? "the console renders the honest unavailable state: 'There is no application inventory or creation route in the public API — the application authority owns application lifecycle'"
        : `GET /console/applications → HTTP ${applicationsPage.status}`,
      honestUnavailable ? "finding" : "pass",
      honestUnavailable ? "F4" : undefined,
    );
    if (honestUnavailable) {
      surface({
        id: "F4",
        leg: "3",
        classification: "zeck",
        title:
          "application creation/inventory is not exposed by the public API (honest unavailable) — the journey's 'create an application' leg cannot complete through the public surface",
        reproduction:
          "GET /console/applications → the unavailable state naming 'the application authority through the public API'; machine/openapi.json carries no application-create route (the frozen create contract only carries per-request applicationId selection)",
      });
    }

    // 3.2 — the persona adopts the console's bound scope (the quickstart page
    // discloses it: "This console is already bound to <id>").
    const quickstartPage = await browser.get(`${CONSOLE_BASE}/console/quickstart`);
    const scopeMatch = quickstartPage.body.match(
      /already bound to <span class="mono">([^<]+)<\/span>/,
    );
    const scope = scopeMatch === null ? null : scopeMatch[1] ?? null;
    record(
      "3",
      "3.2",
      "read the console quickstart page's scope disclosure; adopt the application scope",
      "the console discloses its bound application scope",
      scope === null
        ? "no bound-scope disclosure found on /console/quickstart"
        : `console bound to application ${scope}`,
      scope === null ? "finding" : "pass",
      scope === null ? "C0" : undefined,
    );
  });
}

async function leg4Environment(): Promise<void> {
  await driveLeg("4", "environment/sandbox config", async () => {
    const environmentsPage = await browser.get(
      `${CONSOLE_BASE}/console/applications/environments`,
    );
    const environmentClassesDisclosed = /disposable|synthetic/i.test(environmentsPage.body);
    record(
      "4",
      "4.1",
      "open /console/applications/environments (the sandbox-environment console view)",
      "environment classes, data policy and limits are disclosed",
      environmentsPage.status === 200
        ? environmentClassesDisclosed
          ? "the environments console renders with disposable/synthetic-class disclosures and the honest not-exposed states"
          : "the environments console rendered without the expected class disclosures"
        : `GET /console/applications/environments → HTTP ${environmentsPage.status}`,
      environmentsPage.status === 200 && environmentClassesDisclosed ? "pass" : "finding",
      environmentsPage.status === 200 && environmentClassesDisclosed ? undefined : "C0",
    );

    const sandboxDoc = readDoc("docs/developer/SANDBOX.md");
    const optionalEnvironment = /ZECK_ENVIRONMENT_ID.*optional|optional.*ZECK_ENVIRONMENT_ID/i.test(
      sandboxDoc,
    );
    record(
      "4",
      "4.2",
      "read SANDBOX.md's environment selector contract",
      "ZECK_ENVIRONMENT_ID is documented optional (deployment default without it)",
      optionalEnvironment
        ? "SANDBOX.md documents the optional environment selector; the persona proceeds on the deployment default"
        : "SANDBOX.md's optional-selector statement not found in the expected shape",
      optionalEnvironment ? "pass" : "finding",
      optionalEnvironment ? undefined : "F3b",
    );

    const providersPage = await browser.get(`${CONSOLE_BASE}/console/providers`);
    record(
      "4",
      "4.3",
      "open /console/providers (the honest availability catalog)",
      "provider availability facts are disclosed (including NOT RUN boundaries)",
      providersPage.status === 200
        ? "the providers & capabilities catalog renders with the honest availability facts"
        : `GET /console/providers → HTTP ${providersPage.status}`,
      providersPage.status === 200 ? "pass" : "finding",
      providersPage.status === 200 ? undefined : "C0",
    );
  });
}

async function leg5FirstExecution(): Promise<void> {
  await driveLeg("5", "first execution (guided + composed)", async () => {
    // 5.1 — the GUIDED path: quickstart → playground text family → compose → run.
    const playgroundPage = await browser.get(`${CONSOLE_BASE}/console/playground/text`);
    record(
      "5",
      "5.1",
      "follow the quickstart's primary action to /console/playground/text",
      "the guided playground page renders the composer",
      `GET /console/playground/text → ${playgroundPage.status}`,
      playgroundPage.status === 200 ? "pass" : "finding",
      playgroundPage.status === 200 ? undefined : "C0",
    );

    let guidedRunId: string | null = null;
    const composerForm = parseForm(playgroundPage.body, /playground\/text/);
    if (playgroundPage.status === 200 && composerForm !== null) {
      const fields: Record<string, string> = { ...composerForm.fields };
      if ((fields.applicationId ?? "").length === 0) {
        fields.applicationId = APP_ID;
      }
      if ((fields.idempotencyKey ?? "").length === 0) {
        fields.idempotencyKey = `persona-guided-${RUN_STAMP}`;
      }
      const submit = await browser.postForm(
        `${CONSOLE_BASE}${composerForm.action}`,
        fields,
      );
      const redirectTarget =
        submit.status === 303 && submit.location !== null ? submit.location : null;
      guidedRunId =
        redirectTarget === null
          ? null
          : redirectTarget.match(/\/runs\/([^/?#]+)/)?.[1] ?? null;
      record(
        "5",
        "5.2",
        "compose the run from the served defaults and POST the guided form",
        "HTTP 303 → the run detail for the created execution",
        guidedRunId === null
          ? `submit → HTTP ${submit.status}${submit.location === null ? "" : ` (Location ${submit.location})`} — no run id derived`
          : `guided run created: ${guidedRunId}`,
        guidedRunId === null ? "finding" : "pass",
        guidedRunId === null ? "C0" : undefined,
      );
    } else {
      record(
        "5",
        "5.2",
        "parse the playground composer form",
        "a native composer form submits the run",
        "no composer form found on the playground page",
        "finding",
        "C0",
      );
    }
    state.guidedRunId = guidedRunId;

    if (guidedRunId !== null) {
      // 5.3 — the landing surface: the run detail the playground redirects to.
      const runDetail = await browser.get(`${CONSOLE_BASE}/runs/${encodeURIComponent(guidedRunId)}`);
      const hasExportLink = /\/console\/executions\/[^"']+\/export/.test(runDetail.body);
      const hasMachineParity = /facts\.json/.test(runDetail.body);
      record(
        "5",
        "5.3",
        "open the run detail the playground redirected to; look for the reproducibility/export path the docs promise",
        "the landing surface links the export bundle + machine facts (SELF-HOSTING.md documents /console/executions/<id>/export)",
        hasExportLink
          ? "the run detail links the export bundle"
          : `the /runs/<id> detail carries NO export-bundle link${hasMachineParity ? "" : " and no facts.json machine-parity link"} — the export path the docs document lives only under /console/executions/<id>, which the persona must find separately through the nav`,
        hasExportLink ? "pass" : "finding",
        hasExportLink ? undefined : "C1",
      );
      if (!hasExportLink) {
        surface({
          id: "C1",
          leg: "5",
          classification: "console",
          title:
            "the run-detail surface the playground redirects to lacks the export/machine-parity links its sibling explorer renders",
          reproduction:
            "POST /console/playground/text → 303 → GET /runs/<id>: the page renders Result/Evidence/Activity but no /console/executions/<id>/export link and no facts.json link; SELF-HOSTING.md documents the export path only at /console/executions/<id>/export; the persona must re-find the run through the console nav's explorer to reach the documented reproducibility surface",
        });
      }

      // 5.4 — poll the lifecycle to terminal (the worker path settles it).
      const settled = await pollTerminal(guidedRunId, 30_000);
      record(
        "5",
        "5.4",
        "poll GET /executions/<id> (the documented lifecycle pattern) to a terminal status",
        "the guided run reaches COMPLETED with a settled ledger",
        settled.status === "COMPLETED"
          ? `terminal status COMPLETED; ledger carries ${settled.events.length} events`
          : `terminal status ${String(settled.status)} after 30 s (events ${settled.events.length})`,
        settled.status === "COMPLETED" ? "pass" : "finding",
        settled.status === "COMPLETED" ? undefined : "C0",
      );
    }

    // 5.5 — the COMPOSED path: run the integration example exactly as
    // QUICKSTART.md documents it (a REAL subprocess over real HTTP).
    if (state.personaToken !== null) {
      const started = Date.now();
      const quickstartRun = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const child = spawn("bun", ["run", "examples/quickstart.ts"], {
          cwd: REPOSITORY_ROOT,
          env: {
            ...process.env,
            ZECK_API_URL: API_BASE,
            ZECK_TOKEN: state.personaToken ?? "",
            ZECK_APPLICATION_ID: APP_ID,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once("exit", (code) => {
          resolve({ code: code ?? -1, stdout: output });
        });
      });
      const composedMs = Date.now() - started;
      const sawCreate = /created execution/.test(quickstartRun.stdout);
      const sawTerminal = /terminal status: COMPLETED/.test(quickstartRun.stdout);
      const sawEvents = /event ledger: \d+ event\(s\)/.test(quickstartRun.stdout);
      const sawReplay = /idempotent replay: replayed=/.test(quickstartRun.stdout);
      const composedId = quickstartRun.stdout.match(/created execution ([0-9a-f-]+)/)?.[1] ?? null;
      state.composedRunId = composedId ?? null;
      record(
        "5",
        "5.5",
        "run `bun run examples/quickstart.ts` with the persona's env (ZECK_API_URL/TOKEN/APPLICATION_ID)",
        "the composed example completes: create → poll → result → events → replay",
        `exit ${quickstartRun.code} in ${composedMs} ms; created=${sawCreate}, terminal-COMPLETED=${sawTerminal}, events=${sawEvents}, replay=${sawReplay}${composedId === null ? "" : ` (${composedId})`}`,
        quickstartRun.code === 0 && sawCreate && sawTerminal && sawEvents && sawReplay
          ? "pass"
          : "finding",
        quickstartRun.code === 0 && sawCreate && sawTerminal && sawEvents && sawReplay
          ? undefined
          : "C0",
      );
    }
  });
}

async function leg6ResultsEvidence(): Promise<void> {
  await driveLeg("6", "results/evidence inspection", async () => {
    const runId = state.guidedRunId;
    if (runId === null) {
      record("6", "6.0", "inspect the guided run", "a run exists", "no guided run id", "not-run");
      return;
    }
    // 6.1 — the execution explorer list (recents-driven).
    const explorer = await browser.get(`${CONSOLE_BASE}/console/executions`);
    const listed = explorer.status === 200 && explorer.body.includes(runId);
    record(
      "6",
      "6.1",
      "open /console/executions (the execution explorer list)",
      "the guided run appears in the explorer",
      listed ? "the guided run is listed" : `the guided run was not found on the list (HTTP ${explorer.status})`,
      listed ? "pass" : "finding",
      listed ? undefined : "C0",
    );

    // 6.2 — the six-view detail + machine twin.
    const detail = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}`,
    );
    const activity = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}?tab=activity&view=events`,
    );
    const evidence = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}?tab=evidence`,
    );
    const viewsOk =
      detail.status === 200 && activity.status === 200 && evidence.status === 200;
    record(
      "6",
      "6.2",
      "open the explorer's six-view detail (result default, activity/events, evidence)",
      "every view renders",
      `result=${detail.status}, activity/events=${activity.status}, evidence=${evidence.status}`,
      viewsOk ? "pass" : "finding",
      viewsOk ? undefined : "C0",
    );

    // 6.3 — the machine twin parity.
    const facts = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}/facts.json`,
    );
    let factsParity = false;
    let factsObserved = `GET facts.json → ${facts.status}`;
    if (facts.status === 200) {
      const parsed = JSON.parse(facts.body) as {
        execution?: { id?: string; status?: string };
        result?: { cost?: { totalMicroUsd?: string } | null };
      };
      factsParity =
        parsed.execution?.id === runId && parsed.execution?.status === "COMPLETED";
      factsObserved = `facts.json parity: id=${parsed.execution?.id === runId}, status=${parsed.execution?.status}, cost=${parsed.result?.cost?.totalMicroUsd ?? "n/a"}`;
    }
    record(
      "6",
      "6.3",
      "read the machine twin /console/executions/<id>/facts.json",
      "verbatim JSON facts match the run",
      factsObserved,
      factsParity ? "pass" : "finding",
      factsParity ? undefined : "C0",
    );

    // 6.4 — the persona's API reads: result package + verification axis.
    const token = state.personaToken ?? consoleBindingToken;
    const resultRead = await browser.apiGet(
      `/executions/${encodeURIComponent(runId)}/results`,
      token,
    );
    const resultBody = resultRead.json as
      | {
          status?: string;
          cost?: { totalMicroUsd?: string } | null;
          usage?: { inputTokens?: number; outputTokens?: number } | null;
          outputArtifacts?: { id?: string; digest?: string }[];
          verification?: { criterionId?: string; status?: string }[];
          warnings?: string[];
        }
      | null;
    const resultOk =
      resultRead.status === 200 &&
      resultBody?.status === "COMPLETED" &&
      resultBody?.cost?.totalMicroUsd === SETTLE_COST_MICRO_USD &&
      (resultBody?.verification?.length ?? 0) > 0 &&
      (resultBody?.outputArtifacts?.length ?? 0) > 0;
    record(
      "6",
      "6.4",
      "GET /executions/<id>/results with the persona credential",
      "the honest result package: COMPLETED, settled cost, verification rows, artifact digests",
      `status=${resultBody?.status}, cost=${resultBody?.cost?.totalMicroUsd ?? "null"}, verification=${resultBody?.verification?.length ?? 0}, artifacts=${resultBody?.outputArtifacts?.length ?? 0}`,
      resultOk ? "pass" : "finding",
      resultOk ? undefined : "C0",
    );

    const verificationRead = await browser.apiGet(
      `/executions/${encodeURIComponent(runId)}/verification`,
      token,
    );
    const verificationRows = (verificationRead.json as unknown[] | null) ?? [];
    record(
      "6",
      "6.5",
      "GET /executions/<id>/verification (the evidence axis)",
      "verification verdicts with criterion/strategy/provenance",
      `${verificationRows.length} verification row(s)`,
      verificationRead.status === 200 && verificationRows.length > 0 ? "pass" : "finding",
      verificationRead.status === 200 && verificationRows.length > 0 ? undefined : "C0",
    );
  });
}

async function leg7Costs(): Promise<void> {
  await driveLeg("7", "costs", async () => {
    const usage = await browser.get(`${CONSOLE_BASE}/console/usage`);
    const usageFacts = await browser.get(`${CONSOLE_BASE}/console/usage/facts.json`);
    const guidedRunId = state.guidedRunId ?? "";
    const usageShowsRun =
      usage.status === 200 && (guidedRunId.length === 0 || usage.body.includes(guidedRunId));
    record(
      "7",
      "7.1",
      "open /console/usage (the usage/economics console) + its machine twin",
      "per-run spend facts render; the aggregate boundary is honest",
      `usage=${usage.status} (run facts ${usageShowsRun ? "present" : "absent"}), facts.json=${usageFacts.status}`,
      usage.status === 200 && usageFacts.status === 200 ? "pass" : "finding",
      usage.status === 200 && usageFacts.status === 200 ? undefined : "C0",
    );

    const token = state.personaToken ?? consoleBindingToken;
    const costRunId = state.guidedRunId;
    if (costRunId !== null) {
      const resultRead = await browser.apiGet(
        `/executions/${encodeURIComponent(costRunId)}/results`,
        token,
      );
      const resultBody = resultRead.json as { cost?: { totalMicroUsd?: string } | null } | null;
      record(
        "7",
        "7.2",
        "read the run's settled cost through the public API",
        "cost appears only from settled ledger facts (never fabricated)",
        `cost.totalMicroUsd=${resultBody?.cost?.totalMicroUsd ?? "null"}`,
        resultBody?.cost?.totalMicroUsd === SETTLE_COST_MICRO_USD ? "pass" : "finding",
        resultBody?.cost?.totalMicroUsd === SETTLE_COST_MICRO_USD ? undefined : "C0",
      );
    }
  });
}

async function leg8ValidationLibrary(): Promise<void> {
  await driveLeg("8", "validation library discovery + rerun", async () => {
    const lab = await browser.get(`${CONSOLE_BASE}/console/validation`);
    const catalog = await browser.get(`${CONSOLE_BASE}/console/validation/api/catalog.json`);
    interface CatalogEntry {
      readonly id?: string;
      readonly rerunnable?: boolean;
      readonly requiredAccess?: { candidateEnvVars?: string[] }[];
    }
    let entries: CatalogEntry[] = [];
    if (catalog.status === 200) {
      const parsed = JSON.parse(catalog.body) as { experiments?: CatalogEntry[] } | null;
      entries = parsed?.experiments ?? [];
    }
    record(
      "8",
      "8.1",
      "open /console/validation (the Validation Lab) + api/catalog.json (the machine list step)",
      "the library's definitions are discoverable",
      `lab=${lab.status}, catalog=${catalog.status} (${entries.length} experiments)`,
      lab.status === 200 && catalog.status === 200 ? "pass" : "finding",
      lab.status === 200 && catalog.status === 200 ? undefined : "C0",
    );

    // 8.2 — the rerun: the persona picks a console-rerunnable experiment with
    // candidate providers (the catalog's own machine fields), then drives the
    // served two-step review flow: the run form (a GET review) → the
    // commitment card (the governed POST to .../run).
    const candidates = entries.filter(
      (entry) =>
        entry.id !== undefined &&
        entry.rerunnable === true &&
        (entry.requiredAccess ?? []).every(
          (access) => (access.candidateEnvVars ?? []).length > 0,
        ),
    );
    let rerunDone = false;
    let openedPages = 0;
    for (const entry of candidates.slice(0, 12)) {
      const workOrder = entry.id;
      if (workOrder === undefined) {
        continue;
      }
      const experimentPage = await browser.get(
        `${CONSOLE_BASE}/console/validation/${encodeURIComponent(workOrder)}`,
      );
      openedPages += 1;
      if (experimentPage.status !== 200) {
        continue;
      }
      const reviewForm = parseForm(
        experimentPage.body,
        new RegExp(`^/console/validation/${workOrder}/?$`),
      );
      if (reviewForm === null) {
        continue; // honest not-console-rerunnable rendering — keep looking
      }
      const reviewFields: Record<string, string> = { ...reviewForm.fields };
      if ((reviewFields.applicationId ?? "").length === 0) {
        reviewFields.applicationId = APP_ID;
      }
      if ((reviewFields.idempotencyKey ?? "").length === 0) {
        reviewFields.idempotencyKey = `persona-validation-${RUN_STAMP}`;
      }
      const reviewPage = await browser.submitGetForm(
        CONSOLE_BASE,
        reviewForm.action,
        reviewFields,
      );
      if (reviewPage.status !== 200) {
        continue;
      }
      const runForm = parseForm(reviewPage.body, /\/console\/validation\/[^/"\s]+\/run/);
      if (runForm === null) {
        continue; // the review did not offer the commitment card
      }
      const fields: Record<string, string> = { ...runForm.fields };
      if ((fields.applicationId ?? "").length === 0) {
        fields.applicationId = APP_ID;
      }
      if ((fields.idempotencyKey ?? "").length === 0) {
        fields.idempotencyKey = `persona-validation-${RUN_STAMP}`;
      }
      const submit = await browser.postForm(`${CONSOLE_BASE}${runForm.action}`, fields);
      const target =
        submit.status === 303 && submit.location !== null ? submit.location : null;
      const executionId = target?.match(/\/runs\/([^/?#]+)/)?.[1] ?? null;
      if (executionId !== null) {
        state.validationRunId = executionId;
        state.validationWorkOrder = workOrder;
        const settled = await pollTerminal(executionId, 30_000);
        record(
          "8",
          "8.2",
          `rerun ${workOrder} through the served review + commitment forms (POST /console/validation/${workOrder}/run)`,
          "HTTP 303 → a NEW governed execution that settles",
          `rerun execution ${executionId} → ${String(settled.status)} (${candidates.length} console-rerunnable candidate(s) in the catalog; ${openedPages} experiment page(s) opened)`,
          settled.status === "COMPLETED" ? "pass" : "finding",
          settled.status === "COMPLETED" ? undefined : "C0",
        );
        rerunDone = true;
      } else {
        record(
          "8",
          "8.2",
          `rerun ${workOrder} through the served commitment form`,
          "HTTP 303 → a NEW governed execution",
          `submit → HTTP ${submit.status} (no run id derived)`,
          "finding",
          "C0",
        );
      }
      break;
    }
    if (!rerunDone) {
      record(
        "8",
        "8.3",
        "find a console-rerunnable experiment with candidate providers",
        "at least one library entry offers the governed rerun",
        `no runnable review→commitment flow found (catalog rerunnable candidates: ${candidates.length}; pages opened: ${openedPages})`,
        "finding",
        "C0",
      );
    }
  });
}

async function leg9ExportSelfHost(): Promise<void> {
  await driveLeg("9", "export/self-host handoff", async () => {
    const runId = state.guidedRunId;
    if (runId === null) {
      record("9", "9.0", "export the guided run", "a run exists", "no guided run id", "not-run");
      return;
    }
    const exportPage = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}/export`,
    );
    const bundleRead = await browser.get(
      `${CONSOLE_BASE}/console/executions/${encodeURIComponent(runId)}/export/bundle.json`,
    );
    let parity = false;
    let observed = `export view=${exportPage.status}, bundle.json=${bundleRead.status}`;
    if (bundleRead.status === 200) {
      const bundle = JSON.parse(bundleRead.body) as {
        export?: { executionId?: string };
        facts?: {
          execution?: { id?: string; status?: string };
          result?: { cost?: { totalMicroUsd?: string } | null };
        };
        reproduction?: { recreatedCreateRequest?: unknown };
        boundaries?: unknown[];
      };
      parity =
        bundle.export?.executionId === runId &&
        bundle.facts?.execution?.status === "COMPLETED" &&
        bundle.facts?.result?.cost?.totalMicroUsd === SETTLE_COST_MICRO_USD &&
        bundle.reproduction?.recreatedCreateRequest !== undefined &&
        Array.isArray(bundle.boundaries) &&
        (bundle.boundaries?.length ?? 0) > 0;
      observed = `bundle parity: executionId=${bundle.export?.executionId === runId}, status=${bundle.facts?.execution?.status}, cost=${bundle.facts?.result?.cost?.totalMicroUsd ?? "n/a"}, recipe=${bundle.reproduction?.recreatedCreateRequest !== undefined ? "present" : "absent"}, boundaries=${bundle.boundaries?.length ?? 0}`;
    }
    record(
      "9",
      "9.1",
      "open /console/executions/<id>/export + bundle.json (the reproducibility bundle)",
      "the bundle carries the verbatim facts, digests, the reproduction recipe and explicit boundaries",
      observed,
      exportPage.status === 200 && parity ? "pass" : "finding",
      exportPage.status === 200 && parity ? undefined : "C0",
    );

    // 9.2 — the self-host handoff docs path the bundle links.
    const selfHostingProblems = docLinkProblems("docs/developer/SELF-HOSTING.md");
    const selfHosting = readDoc("docs/developer/SELF-HOSTING.md");
    const reproductionSection = /Reproducing an execution against your deployment/.test(selfHosting);
    record(
      "9",
      "9.2",
      "follow the bundle's handoff to SELF-HOSTING.md (the 'run it yourself' path)",
      "the reproduction recipe path is documented and its links resolve",
      selfHostingProblems.length === 0 && reproductionSection
        ? "SELF-HOSTING.md's reproduction section present; links resolve"
        : `problems: ${[...selfHostingProblems, reproductionSection ? "" : "reproduction section missing"].filter(Boolean).join("; ")}`,
      selfHostingProblems.length === 0 && reproductionSection ? "pass" : "finding",
      selfHostingProblems.length === 0 && reproductionSection ? undefined : "F2",
    );
  });
}

async function leg10ProductionPath(): Promise<void> {
  await driveLeg("10", "production-migration docs path", async () => {
    const production = readDoc("docs/developer/PRODUCTION.md");
    const problems = docLinkProblems("docs/developer/PRODUCTION.md");
    const ladder = /local.*preview.*staging.*production|promotion ladder/i.test(production);
    record(
      "10",
      "10.1",
      "read PRODUCTION.md (the production-migration path)",
      "promotion, secrets and quota posture documented; links resolve",
      problems.length === 0 && ladder
        ? "PRODUCTION.md documents the governed promotion path; all links resolve"
        : `problems: ${[...problems, ladder ? "" : "promotion ladder not found"].filter(Boolean).join("; ")}`,
      problems.length === 0 && ladder ? "pass" : "finding",
      problems.length === 0 && ladder ? undefined : "F10",
    );
  });
}

// ---------------------------------------------------------------------------
// Emission + teardown
// ---------------------------------------------------------------------------

function emitJourneyLog(): void {
  const log = {
    schemaVersion: 1,
    workOrder: "DEP-041",
    runStamp: RUN_STAMP,
    substrate: {
      apiBase: API_BASE,
      consoleBase: CONSOLE_BASE,
      bootstrapProbeBase: BOOTSTRAP_BASE,
      composition:
        "REAL createApiServer over REAL module services (executions/credentials/quotas, in-memory stores) + REAL createDashboard + REAL runtime deployment identity; worker-path settler drives governed transitions + settlement ledger event",
      sandboxAccountCrossCheck: {
        manifestPath: "deploy/manifests/sandbox-accounts.json",
        localAccountId: SANDBOX_ACCOUNT_ID,
        personaActorId: SANDBOX_ACTOR_ID,
      },
    },
    baseRevision: deploymentRevision,
    legs,
    steps,
    findingsSurfaced: surfacedFindings,
    frictionEvents,
  };
  writeFileSync(JOURNEY_LOG_PATH, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`\njourney log → ${JOURNEY_LOG_PATH}`);
  const passed = steps.filter((s) => s.outcome === "pass").length;
  console.log(
    `journey summary: ${steps.length} steps — ${passed} pass, ${steps.filter((s) => s.outcome === "finding").length} finding, ${steps.filter((s) => s.outcome === "friction").length} friction, ${steps.filter((s) => s.outcome === "not-run").length} not-run; ${surfacedFindings.length} finding(s) surfaced; ${frictionEvents} friction event(s)`,
  );
}

async function main(): Promise<void> {
  await apiServer.app.listen({ host: "127.0.0.1", port: API_PORT });
  await new Promise<void>((resolve) => dashboardServer.listen(CONSOLE_PORT, "127.0.0.1", resolve));
  console.log(`DEP-041 fresh-developer trial plane:`);
  console.log(`  api:      ${API_BASE}`);
  console.log(`  console:  ${CONSOLE_BASE}`);
  console.log(`  revision: ${deploymentRevision.slice(0, 12)}`);

  try {
    await leg1Discover();
    await leg2Authenticate();
    await leg3Application();
    await leg4Environment();
    await leg5FirstExecution();
    await leg6ResultsEvidence();
    await leg7Costs();
    await leg8ValidationLibrary();
    await leg9ExportSelfHost();
    await leg10ProductionPath();
  } finally {
    clearInterval(workerPath);
    emitJourneyLog();
    await apiServer.app.close();
    dashboardServer.close();
  }
}

main().catch((error: unknown) => {
  console.error(`trial harness error: ${(error as Error).stack ?? error}`);
  clearInterval(workerPath);
  process.exit(1);
});
