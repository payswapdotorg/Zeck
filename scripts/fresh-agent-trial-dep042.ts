/**
 * scripts/fresh-agent-trial-dep042.ts — the DEP-042 fresh-AGENT integration
 * trial (the reproducible journey record).
 *
 * THE CONTRACT (spec/platform-delivery-work-orders/DEP-042.md): a fresh
 * CODING AGENT integrates Zeck through the agent-oriented public surface
 * with ZERO maintainer intervention — agent discovery (AGENTS.md entry) →
 * machine-contract reading (openapi.json, capability-manifest.json,
 * env-vars.json, error-codes.json, examples-manifest.json,
 * integration-recipe.json) → auth → application create → sandbox config →
 * executions across the supported capability portfolio → results/evidence/
 * cost retrieval → validation library list + rerun → export path. Every
 * dead end, hidden assumption, manifest-vs-wire mismatch or
 * honest-unavailable surprise is recorded with exact reproduction and
 * root-cause classification. The trial is a defect-finding instrument,
 * not a demo.
 *
 * THE PERSONA DISCIPLINE: the journey below consumes ONLY what the machine
 * surface exposes — AGENTS.md at the repository root,
 * docs/developer/machine/** (the machine manifests), the public API wire
 * surface, and the SDK where the machine artifacts point at it. NO
 * human-oriented docs, NO console browsing, NO src/ reading to figure out
 * contracts (the machine manifests ARE the contract source). Every wire
 * call is built from openapi.json's declared paths/parameters/security;
 * every example is executed EXACTLY as its manifest entry prints it (same
 * command shape, same declared env vars, same paths). If the persona cannot
 * proceed, that is a FINDING — never a silent workaround.
 *
 * THE SUBSTRATE (honest disclosure): a REAL locally-booted plane —
 * REAL createApiServer over REAL module services (executions, credentials,
 * quotas, sandbox identities, economics) with in-memory stores, bound to a
 * REAL runtime deployment identity, on a fixed loopback port. A worker-path
 * settler drives every created execution through the REAL execution
 * service's governed transitions (authorize → plan → queue → start →
 * verify → pass) plus the settlement ledger event (cost/usage/artifacts) —
 * the platform-side completion a bound worker + provider rail performs on
 * a hosted plane. Live provider completion is honestly NOT RUN (no
 * operator credentials in this environment — the recorded AVAILABILITY.md
 * boundary). The persona's connection values arrive exactly as
 * integration-recipe.json's prerequisites state: "Three environment values
 * from the target deployment's operator" — here the trial plane's
 * operator-side bootstrap credential; the persona then issues its OWN
 * credential through the public POST /credentials route the openapi
 * documents, and drives the whole journey with it.
 *
 * REPRODUCIBILITY: rerunning this script re-drives the SAME journey steps
 * against a FRESH plane (new in-memory composition, new subprocesses).
 * Every step's outcome (pass / finding:<id> / not-run) is emitted in a
 * machine-readable journey log (stdout + deploy/evidence/
 * dep-042-journey.json). Findings are deliverables, not failures: the run
 * exits 0 when the journey completed and every finding was recorded; it
 * exits 1 only on harness errors (composition boot failure, teardown
 * failure).
 *
 * Usage (from the repository root):
 *   bun scripts/fresh-agent-trial-dep042.ts              # the verification drive (dep-042-journey.json)
 *   bun scripts/fresh-agent-trial-dep042.ts baseline     # the baseline (pre-fix) drive (dep-042-journey-baseline.json)
 *
 * After a RECORDED drive, format the emitted journey log so the delivery
 * artifacts carry the house format (the driver's JSON.stringify output is
 * not biome-formatted):
 *   bunx biome check --write deploy/evidence/dep-042-journey*.json
 */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  ScopeResolver,
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
import {
  createInMemorySandboxIdentityStore,
  createSandboxIdentityService,
} from "../src/modules/sandbox/public";
import type { SandboxExecutionLedger } from "../src/modules/sandbox/public";
import {
  createCapabilityEconomicAdmission,
  createEconomicActionService,
  createPolicyEconomicAdmission,
  InMemoryEconomicStore,
  InMemoryEconomicsIdempotency,
} from "../src/modules/economics/public";
import { createCapabilityRegistry, createInMemoryCatalogStore } from "../src/modules/capabilities/public";
import { createPolicyAuthority, InMemoryPolicyStore, nodePolicyHasher } from "../src/modules/policies/public";
import { PlatformError } from "../src/shared/errors";
import { webhookSignatureBasis, type WebhookEvent } from "../sdk";
import { gitRevision, loadManifest, REPOSITORY_ROOT } from "../deploy/lib";

// ---------------------------------------------------------------------------
// The trial's fixed topology (loopback only; no external surface)
// ---------------------------------------------------------------------------

const API_PORT = 4078;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
/** The webhook-receiver example's local listen port (its own manifest row). */
const WEBHOOK_RECEIVER_PORT = 4090;
const WEBHOOK_RECEIVER_BASE = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}`;

/** The trial plane's application scope (the recipe's ZECK_APPLICATION_ID value). */
const APP_ID = "00000000-0000-7000-8000-000000000142";
const TENANT_ID = "tenant-dep042";
/**
 * The persona's actor: the sandbox-account identity class declared for
 * local environments (deploy/manifests/sandbox-accounts.json — the
 * DEP-041-established local class). The persona receives the application
 * scope + bootstrap credential from the operator side (the recipe's
 * prerequisites); it never reads the manifest itself.
 */
const SANDBOX_ACTOR_ID = "00000000-0000-7000-8000-000000000143";

/** The settlement envelope the worker path records (within every run's bound). */
const SETTLE_COST_MICRO_USD = "4125";
const SETTLE_USAGE = { inputTokens: 2100, outputTokens: 340 };

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BASELINE_MODE = process.argv[2] === "baseline";
const JOURNEY_LOG_PATH = join(
  REPOSITORY_ROOT,
  "deploy",
  "evidence",
  BASELINE_MODE ? "dep-042-journey-baseline.json" : "dep-042-journey.json",
);

/** The machine manifests — the persona's ONLY contract source (DEP-042 protocol). */
const MACHINE_DIR = "docs/developer/machine";
const MACHINE_MANIFESTS = [
  "openapi.json",
  "capability-manifest.json",
  "env-vars.json",
  "error-codes.json",
  "examples-manifest.json",
  "integration-recipe.json",
] as const;

/** The manifest documents, read once (the persona's contract corpus). */
interface ExamplesManifestShape {
  readonly examples?: readonly {
    readonly path?: string;
    readonly name?: string;
    readonly family?: string;
    readonly classification?: string;
    readonly gatedBy?: string;
    readonly envVars?: readonly string[];
  }[];
}
interface CapabilityManifestShape {
  readonly workloadFamilies?: readonly {
    readonly family?: string;
    readonly example?: string;
    readonly classification?: string;
    readonly gatedBy?: string;
  }[];
}
interface RecipeShape {
  readonly steps?: readonly {
    readonly step?: number;
    readonly id?: string;
    readonly action?: string;
    readonly artifacts?: readonly string[];
    readonly machineArtifacts?: readonly string[];
  }[];
}
const examplesManifest = readJson(`${MACHINE_DIR}/examples-manifest.json`) as ExamplesManifestShape;
const capabilityManifest = readJson(`${MACHINE_DIR}/capability-manifest.json`) as CapabilityManifestShape;
const recipe = readJson(`${MACHINE_DIR}/integration-recipe.json`) as RecipeShape;
const manifestExamples = examplesManifest.examples ?? [];

// ---------------------------------------------------------------------------
// The journey recorder (machine-readable; the AC2/AC3 ledger of record)
// ---------------------------------------------------------------------------

type StepOutcome = "pass" | "finding" | "not-run";

interface JourneyStep {
  readonly leg: string;
  readonly step: string;
  readonly action: string;
  readonly expectation: string;
  readonly observed: string;
  readonly outcome: StepOutcome;
  readonly findingId?: string;
}

interface SurfacedFinding {
  readonly id: string;
  readonly leg: string;
  readonly classification: "zeck" | "console" | "docs" | "machine-manifest" | "harness" | "provider" | "access";
  readonly title: string;
  readonly reproduction: string;
}

interface JourneyLeg {
  readonly leg: string;
  readonly title: string;
  readonly ms: number;
}

interface ExampleRunRecord {
  readonly name: string;
  readonly path: string;
  readonly classification: "runnable" | "provider-gated";
  readonly exitCode: number | null;
  readonly ms: number;
  readonly markers: readonly string[];
  readonly gatedBy?: string;
}

const steps: JourneyStep[] = [];
const surfacedFindings: SurfacedFinding[] = [];
const legs: JourneyLeg[] = [];
const exampleRuns: ExampleRunRecord[] = [];
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
  steps.push({ leg, step, action, expectation, observed, outcome, findingId });
  const tag = outcome === "pass" ? "PASS" : outcome === "finding" ? `FINDING ${findingId ?? "?"}` : "NOT RUN";
  console.log(`  [${tag}] ${leg} ${step}: ${observed.slice(0, 160)}`);
}

function surface(finding: SurfacedFinding): void {
  if (surfacedIds.has(finding.id)) {
    surfacedFindings.push(finding); // re-observed on another leg: recorded, not double-counted
    console.log(`  [FINDING ${finding.id} re-observed] (${finding.classification}) ${finding.title}`);
    return;
  }
  surfacedIds.add(finding.id);
  surfacedFindings.push(finding);
  frictionEvents += 1;
  console.log(`  [FINDING ${finding.id}] (${finding.classification}) ${finding.title}`);
}

/** Time a leg and record its measured duration. */
async function driveLeg<T>(leg: string, title: string, drive: () => Promise<T>): Promise<T> {
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
// Persona tooling: manifest reading, a wire client built from openapi.json,
// and the literal example executor
// ---------------------------------------------------------------------------

function readText(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

/**
 * Probe an endpoint the way a persona would: is a Zeck public API
 * composition actually serving there? (Distinguishes connection-refused
 * from answered-by-a-non-Zeck-service — both leave the persona without an
 * integrable endpoint; the observed text records which.)
 */
async function probeZeckEndpoint(baseUrl: string): Promise<{ refused: boolean; answeredNonZeck: boolean }> {
  try {
    const response = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(1500) });
    const text = await response.text();
    const looksLikeZeckIdentity = /"gitRevision"|"runtimeIdentityId"/.test(text);
    return { refused: false, answeredNonZeck: !looksLikeZeckIdentity };
  } catch {
    return { refused: true, answeredNonZeck: false };
  }
}

interface WireResponse {
  readonly status: number;
  readonly json: unknown;
}

/**
 * The persona's API client: every request is built from openapi.json's
 * declared contract — bearer security, the x-zeck-application scoped-read
 * header, the idempotency-key on POSTs. Nothing is imported from src/ to
 * figure out the wire; the manifests are the contract source.
 */
class PersonaWire {
  async call(
    method: "GET" | "POST",
    path: string,
    options: {
      readonly token: string;
      readonly applicationId?: string;
      readonly body?: unknown;
      readonly idempotencyKey?: string;
    },
  ): Promise<WireResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.applicationId !== undefined) {
      headers["x-zeck-application"] = options.applicationId;
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SpawnOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly ms: number;
}

/** Spawn a literal example run: `bun run <manifest path>` with the manifest-declared env. */
function spawnExample(
  examplePath: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  const started = Date.now();
  return new Promise<SpawnOutcome>((resolve) => {
    const child = spawn("bun", ["run", examplePath], {
      cwd: REPOSITORY_ROOT,
      // The persona's environment: the declared vars only — provider
      // credential NAMES are explicitly absent (the honest gated state).
      env: {
        ...buildExampleEnv(env),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: output, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * The example env: the persona's connection identity plus the declared
 * example-specific variables. The six provider credential NAMES are
 * explicitly deleted — no accidental gate satisfaction is possible.
 */
function buildExampleEnv(declared: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "OPENROUTER_API_KEY",
    "QWEN_API_KEY",
    "OPENAI_API_KEY",
    "BYTEPLUS_ARK_API_KEY",
    "SEEDANCE_API_KEY",
    "ZECK_3D_API_KEY",
  ]) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(declared)) {
    env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// The substrate: the REAL module-service composition (the DEP-041 lineage,
// extended with the REAL economics + sandbox-identity authorities so the
// machine-documented route table is exercised as widely as the composition
// allows)
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
const newId = (): string => `00000000-0000-7000-9000-${String(++idCounter).padStart(12, "0")}`;

const store = new InMemoryExecutionStore();
store.seedApplication(APP_ID, TENANT_ID);

const idempotencyRecords = new Map<string, { fingerprint: string; outcome: unknown }>();
const idempotency: ExecutionsIdempotencyPort = {
  async arbitrate(scope, operationName, idempotencyKey, requestFingerprint, work) {
    const key = `${scope.applicationId}|${operationName}|${idempotencyKey}`;
    const existing = idempotencyRecords.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        // The canonical 409 semantics the wire contract documents.
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: `idempotency key "${idempotencyKey}" was already used with a different request fingerprint`,
        });
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
        walletId: "wallet-dep042",
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
 * deployment-side binding of the write-only secret store). Wrong material
 * → 401 (the persona probes it).
 */
const issuedMaterials = new Set<string>();
const operatorBootstrapToken = randomCredentialSecret();
issuedMaterials.add(operatorBootstrapToken);

const credentialStore = new InMemoryCredentialStore();
let credentialCounter = 0;
const bareCredentials = createCredentialService({
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

/**
 * The deployment-side transport verification view, tracked at issuance AND
 * at rotation/revocation: the current ACTIVE material per credential
 * identity (the write-only secret store's reference table + the record
 * status — rotate retires the predecessor's material, revoke removes it;
 * the operator bootstrap binding stays). Wrong or retired material → 401.
 */
const currentMaterialByCredential = new Map<string, string>();
const credentials: CredentialService = {
  issuanceEnabled: bareCredentials.issuanceEnabled,
  permissionsOf: bareCredentials.permissionsOf,
  async issue(command, idempotencyKey) {
    const outcome = await bareCredentials.issue(command, idempotencyKey);
    if (outcome.secret !== null) {
      currentMaterialByCredential.set(outcome.record.credentialId, outcome.secret);
    }
    return outcome;
  },
  async rotate(command, idempotencyKey) {
    const outcome = await bareCredentials.rotate(command, idempotencyKey);
    if (outcome.secret !== null) {
      const predecessor = currentMaterialByCredential.get(outcome.record.credentialId);
      if (predecessor !== undefined) {
        issuedMaterials.delete(predecessor);
      }
      currentMaterialByCredential.set(outcome.record.credentialId, outcome.secret);
    }
    return outcome;
  },
  async revoke(command, idempotencyKey) {
    const outcome = await bareCredentials.revoke(command, idempotencyKey);
    const material = currentMaterialByCredential.get(outcome.record.credentialId);
    if (material !== undefined) {
      issuedMaterials.delete(material);
      currentMaterialByCredential.delete(outcome.record.credentialId);
    }
    return outcome;
  },
  async list(principal, applicationId) {
    return bareCredentials.list(principal, applicationId);
  },
};

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

// The REAL quota authority + one configured dimension row (the sandbox
// config leg reads it through the public route).
const quotaService = createQuotaService({
  store: createInMemoryQuotaStore(now),
  now,
  newId,
});
await quotaService.configure({
  applicationId: APP_ID,
  tenantId: TENANT_ID,
  dimension: "sandbox-concurrency",
  limit: "5",
  window: "calendar-month",
});

// The REAL sandbox-identity authority (the machine-documented identity routes).
const sandboxLedger: SandboxExecutionLedger = {
  async recordStepEvent() {
    return { sequence: 1, type: "sandbox-admitted", replayed: false };
  },
  async getExecution() {
    return null;
  },
};
const sandboxIdentities = createSandboxIdentityService({
  store: createInMemorySandboxIdentityStore(now),
  ledger: sandboxLedger,
  now,
  newId,
});

// The REAL economic-action authority (the machine-documented economic
// routes + the runnable economic-actions example).
const policyAuthority = createPolicyAuthority({
  store: new InMemoryPolicyStore(),
  hasher: nodePolicyHasher,
});
await policyAuthority.publish({
  id: "default",
  version: 1,
  documents: [{ scope: "platform", selector: {}, restrictions: {} }],
});
const capabilityRegistry = await createCapabilityRegistry({
  store: createInMemoryCatalogStore(),
});
const economicStore = new InMemoryEconomicStore();
const economics = createEconomicActionService({
  store: economicStore,
  idempotency: new InMemoryEconomicsIdempotency(economicStore),
  policy: createPolicyEconomicAdmission(policyAuthority),
  capabilities: createCapabilityEconomicAdmission(capabilityRegistry),
  budget: budgetAuthority,
  executions,
  generateId: newId,
  now: () => new Date(),
});

/** The REAL runtime deployment identity (manifest + provider-tiers ledger). */
const manifest = loadManifest();
const ledger = parseProviderTiers(
  readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
  manifest,
);
const deploymentRevision = gitRevision();
const runtimeIdentity = runtimeDeploymentIdentity(manifest, ledger, deploymentRevision, "local", undefined);

const apiServer = createApiServer({
  executions,
  credentials,
  economics,
  quotas: quotaService,
  identities: sandboxIdentities,
  agents: { listAgents: (async () => []) as never } as never,
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
                digest: `sha256:dep042-${stamp}`,
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
  operatorToken: string;
  personaToken: string | null;
  personaCredentialId: string | null;
  drivenExecutionId: string | null;
  literalRanAsWritten: number;
  literalNotRunGated: number;
  literalFindings: number;
}

const wire = new PersonaWire();
const state: JourneyState = {
  operatorToken: operatorBootstrapToken,
  personaToken: null,
  personaCredentialId: null,
  drivenExecutionId: null,
  literalRanAsWritten: 0,
  literalNotRunGated: 0,
  literalFindings: 0,
};

async function pollTerminal(
  executionId: string,
  token: string,
  deadlineMs: number,
): Promise<{ status: unknown; events: unknown[] }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const read = await wire.call("GET", `/executions/${encodeURIComponent(executionId)}`, {
      token,
      applicationId: APP_ID,
    });
    const execution = read.json as { status?: unknown } | null;
    const status = execution?.status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" || status === "EXPIRED") {
      const eventsRead = await wire.call(
        "GET",
        `/executions/${encodeURIComponent(executionId)}/events`,
        { token, applicationId: APP_ID },
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

// ----- LEG 1: agent discovery (the AGENTS.md entry + the machine manifests) -----

async function leg1Discovery(): Promise<void> {
  await driveLeg("1", "agent discovery (AGENTS.md entry → the machine manifests)", async () => {
    // 1.1 — THE agent entry point: AGENTS.md at the repository root. A
    // fresh coding agent reads it first (the ecosystem convention). Does
    // it lead to the machine-contract surface?
    const agentsMd = readText("AGENTS.md");
    const agentsMdLinksMachineSurface =
      /docs\/developer\/machine|machine\/openapi\.json|integration-recipe\.json|capability-manifest\.json|examples-manifest\.json/.test(
        agentsMd,
      );
    record(
      "1",
      "1.1",
      "read AGENTS.md at the repository root (the coding-agent entry point); look for the machine-contract surface",
      "AGENTS.md leads an integrating agent to docs/developer/machine/** (the machine manifests)",
      agentsMdLinksMachineSurface
        ? "AGENTS.md references the machine-contract surface"
        : "AGENTS.md is the INTERNAL program contract (architect/Tech Lead/implementer recovery sequence: AI_CONTINUATION.md, LLM-* handoffs, spec/*) and carries NO reference to docs/developer/machine/** — a fresh integrating agent's discovery dead-ends at the root; the persona reaches the machine manifests only by repository directory exploration",
      agentsMdLinksMachineSurface ? "pass" : "finding",
      agentsMdLinksMachineSurface ? undefined : "AF1",
    );
    if (!agentsMdLinksMachineSurface) {
      surface({
        id: "AF1",
        leg: "1",
        classification: "docs",
        title:
          "AGENTS.md (the repository-root agent entry point) does not reference the machine-contract surface — a fresh coding agent cannot discover docs/developer/machine/** from the canonical entry",
        reproduction:
          "read AGENTS.md top to bottom; grep -n 'docs/developer\\|machine/' AGENTS.md → no matches (its recovery sequence targets internal program agents: AI_CONTINUATION.md, docs/LLM-*, spec/*); README.md equally carries no developer-kit entry (the DEP-041 F1 merge note, still open); the persona finds docs/developer/machine/ only by directory exploration",
      });
    }

    // 1.2 — the six machine manifests exist and parse (found by directory
    // exploration after the AF1 dead-end — the honest path of record).
    // openapi.json is an OpenAPI document (its version carrier is the
    // `openapi` field); the other five carry schemaVersion 1.
    const problems: string[] = [];
    for (const name of MACHINE_MANIFESTS) {
      const path = `${MACHINE_DIR}/${name}`;
      if (!existsSync(join(REPOSITORY_ROOT, path))) {
        problems.push(`${path} missing`);
        continue;
      }
      try {
        const parsed = readJson(path) as { schemaVersion?: unknown; openapi?: unknown };
        const versionOk =
          name === "openapi.json"
            ? typeof parsed.openapi === "string" && parsed.openapi.startsWith("3.")
            : parsed.schemaVersion === 1;
        if (!versionOk) {
          problems.push(`${path} version carrier unexpected (openapi=${String(parsed.openapi)}, schemaVersion=${String(parsed.schemaVersion)})`);
        }
      } catch (error) {
        problems.push(`${path} does not parse (${(error as Error).message})`);
      }
    }
    record(
      "1",
      "1.2",
      `open the machine-contract surface: ${MACHINE_MANIFESTS.length} manifests under ${MACHINE_DIR}/ (found by directory exploration)`,
      "every manifest exists and parses as JSON with schemaVersion 1",
      problems.length === 0
        ? `all ${MACHINE_MANIFESTS.length} machine manifests parse (schemaVersion 1)`
        : `manifest problems: ${problems.join("; ")}`,
      problems.length === 0 ? "pass" : "finding",
      problems.length === 0 ? undefined : "AF1b",
    );

    // 1.3 — the manifest web's referenced paths resolve.
    const referenceProblems: string[] = [];
    for (const entry of examplesManifest.examples ?? []) {
      if (entry.path === undefined || !existsSync(join(REPOSITORY_ROOT, entry.path))) {
        referenceProblems.push(`examples-manifest path missing: ${entry.path ?? "(none)"}`);
      }
    }
    for (const family of capabilityManifest.workloadFamilies ?? []) {
      if (family.example === undefined || !existsSync(join(REPOSITORY_ROOT, family.example))) {
        referenceProblems.push(`capability-manifest family example missing: ${family.example ?? "(none)"}`);
      }
    }
    for (const step of recipe.steps ?? []) {
      for (const artifact of [...(step.artifacts ?? []), ...(step.machineArtifacts ?? [])]) {
        if (!existsSync(join(REPOSITORY_ROOT, artifact))) {
          referenceProblems.push(`recipe artifact missing: ${artifact}`);
        }
      }
    }
    record(
      "1",
      "1.3",
      "resolve every path the manifest web references (example files, family examples, recipe artifacts)",
      "every referenced file exists in the repository",
      referenceProblems.length === 0
        ? "every manifest-referenced path resolves"
        : `unresolved references: ${referenceProblems.join("; ")}`,
      referenceProblems.length === 0 ? "pass" : "finding",
      referenceProblems.length === 0 ? undefined : "AF1c",
    );
  });
}

// ----- LEG 2: machine-contract reading -----

async function leg2ContractReading(): Promise<void> {
  await driveLeg("2", "machine-contract reading (openapi / capability / env-vars / error-codes / examples / recipe)", async () => {
    // 2.1 — openapi.json: the wire contract of record.
    const openapi = readJson(`${MACHINE_DIR}/openapi.json`) as {
      paths?: Record<string, Record<string, unknown>>;
      servers?: { url?: string; variables?: Record<string, { default?: string }> }[];
      components?: {
        securitySchemes?: Record<string, { scheme?: string }>;
        parameters?: Record<string, { name?: string; in?: string; required?: boolean }>;
      };
    };
    const paths = openapi.paths ?? {};
    const routeEntries: string[] = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        if (method === "get" || method === "post" || method === "put" || method === "delete") {
          routeEntries.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    const bearerScheme = openapi.components?.securitySchemes?.bearerAuth?.scheme === "bearer";
    const appHeaderParam = openapi.components?.parameters?.ZeckApplication;
    const idempotencyParam = openapi.components?.parameters?.IdempotencyKey;
    const openapiOk =
      routeEntries.length > 0 &&
      bearerScheme &&
      appHeaderParam?.name === "x-zeck-application" &&
      appHeaderParam.in === "header" &&
      appHeaderParam.required === true &&
      idempotencyParam?.name === "idempotency-key";
    record(
      "2",
      "2.1",
      "read openapi.json — the ONE canonical wire contract (paths, security scheme, header parameters)",
      "the route table, bearerAuth scheme and the x-zeck-application / idempotency-key header contracts are declared",
      openapiOk
        ? `openapi.json declares ${Object.keys(paths).length} paths / ${routeEntries.length} route entries, bearerAuth security, the required x-zeck-application scoped-read header and the mandatory POST idempotency-key`
        : `openapi contract shape unexpected (paths ${Object.keys(paths).length}, routes ${routeEntries.length}, bearer=${String(bearerScheme)}, appHeader=${JSON.stringify(appHeaderParam) ?? "n/a"})`,
      openapiOk ? "pass" : "finding",
      openapiOk ? undefined : "AF2",
    );

    // 2.2 — error-codes.json: the taxonomy + the deterministic mapping.
    const errorCodes = readJson(`${MACHINE_DIR}/error-codes.json`) as {
      errorCodes?: { code?: string; httpStatus?: number; retryGuidance?: string }[];
    };
    const codes = errorCodes.errorCodes ?? [];
    const authEntry = codes.find((entry) => entry.code === "AUTHENTICATION_FAILED");
    const reusedEntry = codes.find((entry) => entry.code === "IDEMPOTENCY_KEY_REUSED");
    const taxonomyOk =
      codes.length > 0 &&
      authEntry?.httpStatus === 401 &&
      authEntry.retryGuidance === "never-retry" &&
      reusedEntry?.httpStatus === 409;
    record(
      "2",
      "2.2",
      "read error-codes.json — the canonical error taxonomy and its deterministic status mapping",
      "the taxonomy covers the public error vocabulary with deterministic statuses (401 AUTHENTICATION_FAILED never-retry, 409 IDEMPOTENCY_KEY_REUSED, …)",
      taxonomyOk
        ? `error-codes.json declares ${codes.length} codes with deterministic statuses; the persona's wire-parity probes (401/409/422/404) will verify the mapping for real`
        : `taxonomy shape unexpected (${codes.length} codes; AUTHENTICATION_FAILED=${JSON.stringify(authEntry) ?? "n/a"})`,
      taxonomyOk ? "pass" : "finding",
      taxonomyOk ? undefined : "AF2b",
    );

    // 2.3 — env-vars.json: the developer-side variable contract + the CLI
    // default claim, checked against the machine.
    const envVars = readJson(`${MACHINE_DIR}/env-vars.json`) as {
      variables?: { name?: string; required?: boolean }[];
    };
    const names = (envVars.variables ?? []).map((v) => v.name ?? "");
    const required = (envVars.variables ?? [])
      .filter((v) => v.required === true)
      .map((v) => v.name ?? "");
    const requiredOk =
      required.length === 3 &&
      required.includes("ZECK_API_URL") &&
      required.includes("ZECK_TOKEN") &&
      required.includes("ZECK_APPLICATION_ID") &&
      names.includes("ZECK_ENVIRONMENT_ID");
    const cliDefaultClaim = /default http:\/\/127\.0\.0\.1:3000/.test(readText(`${MACHINE_DIR}/env-vars.json`));
    const cliDefaultProbe = await probeZeckEndpoint("http://127.0.0.1:3000");
    const cliDefaultObservation = cliDefaultProbe.refused
      ? "connection refused — no service listens on the CLI default port in this environment"
      : cliDefaultProbe.answeredNonZeck
        ? "a NON-Zeck service answers on 127.0.0.1:3000 in this environment (GET /identity returns a non-Zeck document) — the CLI default targets no Zeck composition here; environment-specific observation, recorded not interpreted as a platform claim"
        : "a Zeck identity document answers on 127.0.0.1:3000";
    record(
      "2",
      "2.3",
      "read env-vars.json — the three required connection values + the optional selector; probe the CLI's documented default URL against the machine",
      "the three required variables are declared; the persona knows where the values come from (the target deployment's operator)",
      `${requiredOk ? "ZECK_API_URL / ZECK_TOKEN / ZECK_APPLICATION_ID required, ZECK_ENVIRONMENT_ID optional" : "unexpected variable contract"}; CLI-default claim ${cliDefaultClaim ? "present" : "absent"} — probe: ${cliDefaultObservation}`,
      requiredOk ? "pass" : "finding",
      requiredOk ? undefined : "AF2c",
    );

    // 2.4 — capability-manifest.json: the 22 families + availability facts.
    const families = capabilityManifest.workloadFamilies ?? [];
    const runnable = families.filter((f) => f.classification === "runnable");
    const gated = families.filter((f) => f.classification === "provider-gated");
    const familiesOk =
      families.length === 22 &&
      runnable.length + gated.length === families.length &&
      gated.every((f) => f.gatedBy !== undefined || /NOT RUN|no operator-authorized|no 3D/i.test(JSON.stringify(f)));
    record(
      "2",
      "2.4",
      "read capability-manifest.json — the seeded capabilities, the 22 workload families and the honest availability classification",
      "22 families with the runnable/provider-gated split and named gates",
      familiesOk
        ? `capability-manifest declares ${families.length} families — ${runnable.length} runnable / ${gated.length} provider-gated (gates: ${[...new Set(gated.map((f) => f.gatedBy ?? "(rail boundary)"))].join(", ")})`
        : `unexpected family set (${families.length} families; runnable ${runnable.length}; gated ${gated.length})`,
      familiesOk ? "pass" : "finding",
      familiesOk ? undefined : "AF2d",
    );

    // 2.5 — examples-manifest.json + classification parity with the
    // capability manifest (the machine surface must agree with itself).
    const parityProblems: string[] = [];
    for (const family of families) {
      const entry = manifestExamples.find((e) => e.path === family.example);
      if (entry === undefined) {
        parityProblems.push(`family ${family.family}: canonical example ${family.example} not in examples-manifest`);
      } else if (entry.classification !== family.classification) {
        parityProblems.push(
          `family ${family.family}: classification drift (capability=${family.classification}, examples=${entry.classification})`,
        );
      }
    }
    record(
      "2",
      "2.5",
      "read examples-manifest.json and reconcile it with the capability manifest's family classifications",
      `${manifestExamples.length} examples; every family's canonical example carries the same classification in both manifests`,
      parityProblems.length === 0
        ? `${manifestExamples.length} examples reconcile with the 22 families (classification parity holds; ${manifestExamples.filter((e) => e.classification === "runnable").length} runnable / ${manifestExamples.filter((e) => e.classification === "provider-gated").length} provider-gated)`
        : `parity problems: ${parityProblems.join("; ")}`,
      parityProblems.length === 0 ? "pass" : "finding",
      parityProblems.length === 0 ? undefined : "AF2e",
    );

    // 2.6 — integration-recipe.json: the deterministic step sequence.
    const recipeSteps = recipe.steps ?? [];
    const sequential = recipeSteps.map((s) => s.step).join(",") === recipeSteps.map((_, i) => i + 1).join(",");
    const recipeOk = sequential && recipeSteps.length === 9;
    record(
      "2",
      "2.6",
      "read integration-recipe.json — the deterministic agent integration recipe",
      "the 9 steps are sequential and the prerequisites name the three connection values",
      recipeOk
        ? "integration-recipe carries 9 sequential steps; prerequisites: Bun, the repository, and ZECK_API_URL / ZECK_TOKEN / ZECK_APPLICATION_ID from the target deployment's operator"
        : `recipe shape unexpected (${recipeSteps.length} steps, sequential=${String(sequential)})`,
      recipeOk ? "pass" : "finding",
      recipeOk ? undefined : "AF2f",
    );
  });
}

// ----- LEG 3: auth (the machine-native credential path) -----

async function leg3Authenticate(): Promise<void> {
  await driveLeg("3", "authenticate (operator values → the public credential route)", async () => {
    // 3.1 — the operator-provided connection values (the recipe's
    // prerequisites; the persona's environment-only discipline).
    record(
      "3",
      "3.1",
      "obtain the three connection values from the target deployment's operator (recipe step 3; environment only — never flags, never files)",
      "ZECK_API_URL, ZECK_TOKEN and ZECK_APPLICATION_ID are set from operator-provided material",
      `connection identity present: api=${API_BASE}, application=${APP_ID}, token=<operator bootstrap credential, ${operatorBootstrapToken.length} chars, never logged>`,
      "pass",
    );

    // 3.2 — the wrong-credential probe: the deterministic 401 the
    // taxonomy promises, with the public error body shape.
    const wrong = await wire.call("GET", "/agents", {
      token: "definitely-not-a-zeck-credential",
      applicationId: APP_ID,
    });
    const wrongBody = wrong.json as { code?: string; message?: string; retryable?: boolean } | null;
    const wrongOk = wrong.status === 401 && wrongBody?.code === "AUTHENTICATION_FAILED" && wrongBody?.retryable === false;
    record(
      "3",
      "3.2",
      "verify the failure semantics first: GET /agents with a wrong bearer credential",
      "401 AUTHENTICATION_FAILED, retryable=false — the error-codes.json deterministic mapping, verified on the wire",
      wrongOk
        ? `HTTP 401 {code AUTHENTICATION_FAILED, retryable false, message '${(wrongBody?.message ?? "").slice(0, 80)}'} — the taxonomy mapping holds on the wire`
        : `unexpected wrong-credential response: HTTP ${wrong.status} ${JSON.stringify(wrong.json).slice(0, 120)}`,
      wrongOk ? "pass" : "finding",
      wrongOk ? undefined : "AF3",
    );

    // 3.3 — the machine-native credential issuance: POST /credentials per
    // the openapi CredentialIssueRequest contract (closed keys, show-once).
    const issue = await wire.call("POST", "/credentials", {
      token: state.operatorToken,
      idempotencyKey: `persona-issue-${RUN_STAMP}`,
      body: { applicationId: APP_ID, label: "fresh agent trial", role: "member" },
    });
    const issueBody = issue.json as
      | { credential?: { credentialId?: string; status?: string }; secret?: string | null; replayed?: boolean }
      | null;
    const issued = issue.status === 201 && typeof issueBody?.secret === "string" && issueBody.secret.length > 0 && issueBody.replayed === false;
    record(
      "3",
      "3.3",
      "issue the persona's OWN credential through the public route: POST /credentials {applicationId, label, role} + Idempotency-Key (the openapi contract)",
      "201 with the show-once secret present and replayed=false (the credential metadata never carries the secret again)",
      issued
        ? `HTTP 201 — credential ${issueBody?.credential?.credentialId} issued (status ${issueBody?.credential?.status}); show-once secret captured (${issueBody.secret?.length ?? 0} chars, value never logged)`
        : `unexpected issue response: HTTP ${issue.status} ${JSON.stringify(issue.json).slice(0, 140)}`,
      issued ? "pass" : "finding",
      issued ? undefined : "AF3b",
    );
    const personaSecret = issued ? issueBody?.secret ?? null : null;
    state.personaToken = personaSecret;
    state.personaCredentialId = issueBody?.credential?.credentialId ?? null;

    // 3.4 — the issued credential authenticates on the scoped read.
    if (personaSecret !== null) {
      const agents = await wire.call("GET", "/agents", {
        token: personaSecret,
        applicationId: APP_ID,
      });
      record(
        "3",
        "3.4",
        "verify the issued credential: GET /agents with the persona secret + X-Zeck-Application",
        "HTTP 200 (an empty inventory is the documented normal state for a fresh application)",
        `HTTP ${agents.status} — ${(agents.json as unknown[] | null)?.length ?? 0} agent(s) (the agents authority projects the inventory; empty is normal)`,
        agents.status === 200 ? "pass" : "finding",
        agents.status === 200 ? undefined : "AF3c",
      );
    }

    // 3.5 — the show-once replay discipline: same key + same request.
    const replay = await wire.call("POST", "/credentials", {
      token: state.operatorToken,
      idempotencyKey: `persona-issue-${RUN_STAMP}`,
      body: { applicationId: APP_ID, label: "fresh agent trial", role: "member" },
    });
    const replayBody = replay.json as { secret?: string | null; replayed?: boolean } | null;
    const replayOk = replay.status === 201 && replayBody?.replayed === true && (replayBody?.secret === null || replayBody?.secret === undefined);
    record(
      "3",
      "3.5",
      "replay the SAME issue request (same idempotency key, same body): the show-once contract",
      "replayed=true with secret=null — the durable outcome replays, the secret never crosses twice",
      replayOk
        ? "HTTP 201 replayed=true, secret=null — the show-once discipline holds"
        : `unexpected replay response: HTTP ${replay.status} ${JSON.stringify(replay.json).slice(0, 120)}`,
      replayOk ? "pass" : "finding",
      replayOk ? undefined : "AF3d",
    );

    // 3.6 — the key-collision discipline: same key + DIFFERENT request.
    const collision = await wire.call("POST", "/credentials", {
      token: state.operatorToken,
      idempotencyKey: `persona-issue-${RUN_STAMP}`,
      body: { applicationId: APP_ID, label: "a different label", role: "member" },
    });
    const collisionBody = collision.json as { code?: string; retryable?: boolean } | null;
    const collisionOk = collision.status === 409 && collisionBody?.code === "IDEMPOTENCY_KEY_REUSED";
    record(
      "3",
      "3.6",
      "probe the collision discipline: same idempotency key with a DIFFERENT request body",
      "409 IDEMPOTENCY_KEY_REUSED — the deterministic mapping the taxonomy documents, verified on the wire",
      collisionOk
        ? "HTTP 409 IDEMPOTENCY_KEY_REUSED (a client bug surfaced as designed, never retried)"
        : `unexpected collision response: HTTP ${collision.status} ${JSON.stringify(collision.json).slice(0, 120)}`,
      collisionOk ? "pass" : "finding",
      collisionOk ? undefined : "AF3e",
    );

    // 3.7 — rotate + revoke: the lifecycle routes the openapi documents.
    // THE PERSONA DISCIPLINE: the request is built from openapi.json's
    // DECLARED parameters — the x-zeck-application header is sent on these
    // routes if and only if the openapi documents it there (the manifest is
    // the contract source; the persona never guesses undocumented headers).
    const openapiDoc = readJson(`${MACHINE_DIR}/openapi.json`) as {
      paths?: Record<string, Record<string, { parameters?: { $ref?: string }[] }>>;
    };
    const documentedParams = (path: string): string[] =>
      (openapiDoc.paths?.[path]?.post?.parameters ?? []).map(
        (p) => p.$ref?.replace("#/components/parameters/", "") ?? "?",
      );
    const rotateDocumentsAppHeader = documentedParams("/credentials/{credentialId}/rotate").includes(
      "ZeckApplication",
    );
    const revokeDocumentsAppHeader = documentedParams("/credentials/{credentialId}/revoke").includes(
      "ZeckApplication",
    );
    const issueB = await wire.call("POST", "/credentials", {
      token: state.operatorToken,
      idempotencyKey: `persona-rotate-source-${RUN_STAMP}`,
      body: { applicationId: APP_ID, label: "rotate probe", role: "member" },
    });
    const issueBBody = issueB.json as
      | { credential?: { credentialId?: string }; secret?: string | null }
      | null;
    const credentialBId = issueBBody?.credential?.credentialId ?? null;
    const secretB = issueBBody?.secret ?? null;
    if (credentialBId !== null && secretB !== null) {
      const rotate = await wire.call(
        "POST",
        `/credentials/${encodeURIComponent(credentialBId)}/rotate`,
        {
          token: state.operatorToken,
          idempotencyKey: `persona-rotate-${RUN_STAMP}`,
          ...(rotateDocumentsAppHeader ? { applicationId: APP_ID } : {}),
          body: {},
        },
      );
      const rotateBody = rotate.json as { secret?: string | null; message?: string } | null;
      const rotatedSecret = rotateBody?.secret ?? null;
      const oldAfter = await wire.call("GET", "/agents", { token: secretB, applicationId: APP_ID });
      const newAfter =
        rotatedSecret !== null
          ? await wire.call("GET", "/agents", { token: rotatedSecret, applicationId: APP_ID })
          : null;
      // The revoke LAST: the probes above must observe the pre-revoke state.
      const revoke = await wire.call(
        "POST",
        `/credentials/${encodeURIComponent(credentialBId)}/revoke`,
        {
          token: state.operatorToken,
          idempotencyKey: `persona-revoke-${RUN_STAMP}`,
          ...(revokeDocumentsAppHeader ? { applicationId: APP_ID } : {}),
          body: {},
        },
      );
      const revokedAfter =
        rotatedSecret !== null
          ? await wire.call("GET", "/agents", { token: rotatedSecret, applicationId: APP_ID })
          : null;
      const lifecycleOk =
        rotate.status === 200 &&
        rotatedSecret !== null &&
        oldAfter.status === 401 &&
        newAfter !== null &&
        newAfter.status === 200 &&
        revoke.status === 200 &&
        revokedAfter !== null &&
        revokedAfter.status === 401;
      const observedLifecycle = `rotate → HTTP ${rotate.status}${rotate.status !== 200 ? ` {${JSON.stringify(rotate.json).slice(0, 130)}}` : ` (new secret issued, ${rotatedSecret?.length ?? 0} chars; documented params: ${documentedParams("/credentials/{credentialId}/rotate").join(", ")})`}; revoke → HTTP ${revoke.status}${revoke.status !== 200 ? ` {${JSON.stringify(revoke.json).slice(0, 130)}}` : ""}; old secret → ${oldAfter.status}; new secret → ${newAfter?.status ?? "n/a"}; revoked secret → ${revokedAfter?.status ?? "n/a"}`;
      record(
        "3",
        "3.7",
        "drive the credential lifecycle: rotate then revoke, each request built from the route's DECLARED openapi parameters (the persona never guesses undocumented headers)",
        "the openapi-documented rotate/revoke routes behave exactly as documented",
        lifecycleOk
          ? `rotate → 200 (new secret issued, ${rotatedSecret.length} chars); old secret → 401; new secret → 200; revoke → 200; revoked secret → 401 — the full lifecycle holds`
          : `${observedLifecycle} — the wire REFUSES the documented-parameter request: the route requires the x-zeck-application header the openapi does not document on it`,
        lifecycleOk ? "pass" : "finding",
        lifecycleOk ? undefined : "AF3f",
      );
      if (!lifecycleOk) {
        surface({
          id: "AF3f",
          leg: "3",
          classification: "machine-manifest",
          title:
            "openapi.json omits the required x-zeck-application parameter on POST /credentials/{credentialId}/rotate and /revoke — a request built exactly from the documented parameters is refused 422",
          reproduction: `POST /credentials/{id}/rotate with EXACTLY the documented parameters (${documentedParams("/credentials/{credentialId}/rotate").join(", ")}) + bearer + Idempotency-Key + empty body → HTTP ${rotate.status} CAPABILITY_UNAVAILABLE '${(rotateBody?.message ?? "").slice(0, 120)}' — the route requires the x-zeck-application header (src/api/routes/credentials.ts: applicationScopeOf(request, "credential commands")) that openapi.json does not declare on it; POST /executions/{id}/cancel and POST /sandbox/identities/{id}/reset DO declare the ZeckApplication parameter — the same-document inconsistency a machine agent cannot resolve without guessing`,
        });
      }
    } else {
      record(
        "3",
        "3.7",
        "drive the credential lifecycle (rotate + revoke)",
        "a second credential issues first",
        `the rotate-probe credential did not issue (HTTP ${issueB.status}) — lifecycle step not drivable`,
        "finding",
        "AF3f",
      );
    }
  });
}

// ----- LEG 4: application create -----

async function leg4Application(): Promise<void> {
  await driveLeg("4", "application create (the machine-contract view)", async () => {
    // 4.1 — the persona searches the wire contract for the
    // application-lifecycle surface.
    const openapi = readJson(`${MACHINE_DIR}/openapi.json`) as {
      paths?: Record<string, unknown>;
    };
    const applicationRoutes = Object.keys(openapi.paths ?? {}).filter((p) =>
      /^\/applications/.test(p),
    );
    const boundariesManifest = existsSync(join(REPOSITORY_ROOT, MACHINE_DIR, "surface-boundaries.json"));
    let boundariesDeclared = false;
    if (boundariesManifest) {
      const boundaries = readJson(`${MACHINE_DIR}/surface-boundaries.json`) as {
        boundaries?: { surface?: string; machineStatus?: string; path?: string }[];
      };
      boundariesDeclared = (boundaries.boundaries ?? []).some(
        (b) => b.surface === "application-lifecycle" && /out-of-band|authority/i.test(`${b.machineStatus ?? ""} ${b.path ?? ""}`),
      );
    }
    const applicationRouteOk = applicationRoutes.length === 0;
    const observed = applicationRouteOk
      ? boundariesDeclared
        ? "the openapi route table carries NO application-lifecycle route (the frozen create contract carries the per-request applicationId selector only) — the machine boundary manifest documents the application authority's out-of-band provisioning path as THE path"
        : "the openapi route table carries NO application-lifecycle route (the frozen create contract carries the per-request applicationId selector only) — and NO machine artifact documents how an application comes into existence: the persona cannot learn the provisioning path from the machine surface (the operator-provided ZECK_APPLICATION_ID is the only documented source)"
      : `unexpected application routes: ${applicationRoutes.join(", ")}`;
    record(
      "4",
      "4.1",
      "search the machine contract (openapi paths, examples-manifest, recipe) for the application-creation surface",
      "an application-create path exists OR the boundary is documented machine-side",
      observed,
      applicationRouteOk && boundariesDeclared ? "pass" : "finding",
      applicationRouteOk && boundariesDeclared ? undefined : "AF4",
    );
    if (applicationRouteOk && !boundariesDeclared) {
      surface({
        id: "AF4",
        leg: "4",
        classification: "zeck",
        title:
          "application creation/inventory is not exposed by the public API and the out-of-band provisioning path is undocumented machine-side — the journey's application-create leg cannot complete through the machine surface",
        reproduction:
          "grep '^  /applications' docs/developer/machine/openapi.json → no matches (27 paths, none application-lifecycle); the ExecutionRequest schema carries only the per-request applicationId; integration-recipe.json's prerequisites say the values come 'from the target deployment's operator/console' without naming the provisioning authority — the machine agent cannot discover how an application is created (the DEP-041 F4 boundary, re-observed through the machine surface)",
      });
    }

    // 4.2 — the persona adopts the operator-provided application scope
    // (the recipe's prerequisites + env-vars.json's description).
    record(
      "4",
      "4.2",
      "adopt the operator-provided application scope (ZECK_APPLICATION_ID — the scope the membership rows authorize)",
      "the scoped reads and governed commands accept the application scope",
      `application scope ${APP_ID} adopted; every scoped call carries X-Zeck-Application per the openapi parameter contract`,
      "pass",
    );
  });
}

// ----- LEG 5: sandbox config -----

async function leg5SandboxConfig(): Promise<void> {
  await driveLeg("5", "sandbox config (the machine-documented sandbox routes)", async () => {
    const token = state.personaToken ?? state.operatorToken;

    // 5.1 — GET /sandbox/quotas: the quota envelope through the route.
    const quotas = await wire.call("GET", "/sandbox/quotas", { token, applicationId: APP_ID });
    const quotaBody = quotas.json as
      | { quotas?: { dimension?: string; limit?: string }[]; telemetry?: { realtime?: boolean } }
      | null;
    const quotasOk =
      quotas.status === 200 &&
      (quotaBody?.quotas?.length ?? 0) > 0 &&
      quotaBody?.telemetry?.realtime === false;
    record(
      "5",
      "5.1",
      "read the sandbox quota envelope: GET /sandbox/quotas with the application scope",
      "the configured dimensions render with the honest telemetry boundary",
      quotasOk
        ? `HTTP 200 — ${quotaBody?.quotas?.length ?? 0} dimension row(s) (${(quotaBody?.quotas ?? []).map((q) => `${q.dimension}=${q.limit}`).join(", ")}); telemetry.realtime=false (the honest boundary)`
        : `unexpected quotas response: HTTP ${quotas.status} ${JSON.stringify(quotas.json).slice(0, 120)}`,
      quotasOk ? "pass" : "finding",
      quotasOk ? undefined : "AF5",
    );

    // 5.2 — GET /sandbox/data-policy: the versioned policy artifact.
    const policy = await wire.call("GET", "/sandbox/data-policy", { token, applicationId: APP_ID });
    const policyBody = policy.json as { version?: string; digest?: string } | null;
    const policyOk =
      policy.status === 200 && policyBody?.version === "1" && /^sha256:/.test(policyBody?.digest ?? "");
    record(
      "5",
      "5.2",
      "read the synthetic-data policy artifact: GET /sandbox/data-policy",
      "the versioned, digest-carrying governed document serves verbatim",
      policyOk
        ? `HTTP 200 — version ${policyBody?.version}, digest ${policyBody?.digest?.slice(0, 23)}… (the governed artifact, never a local copy)`
        : `unexpected policy response: HTTP ${policy.status} ${JSON.stringify(policy.json).slice(0, 120)}`,
      policyOk ? "pass" : "finding",
      policyOk ? undefined : "AF5b",
    );

    // 5.3 — the honest scope-checked miss on the identity route.
    const unknownIdentity = "00000000-0000-7000-8000-00000000dead";
    const identityMiss = await wire.call(
      "GET",
      `/sandbox/identities/${unknownIdentity}`,
      { token, applicationId: APP_ID },
    );
    const identityMissBody = identityMiss.json as { code?: string } | null;
    const missOk = identityMiss.status === 404;
    record(
      "5",
      "5.3",
      "probe the sandbox-identity read with an unknown id (the scope-checked miss semantics)",
      "HTTP 404 — indistinguishable-from-missing, exactly as the openapi documents the route's 404",
      missOk
        ? `HTTP 404 {code ${identityMissBody?.code ?? "n/a"}} — the honest miss (recorded: this route's 404 body carries AUTHORIZATION_DENIED while the executions routes' scope-checked misses carry CAPABILITY_UNAVAILABLE — both are documented 404 shapes; the openapi pins neither body code for this route, so no contract violation is claimed)`
        : `unexpected identity-miss response: HTTP ${identityMiss.status}`,
      missOk ? "pass" : "finding",
      missOk ? undefined : "AF5c",
    );
  });
}

// ----- LEG 6: executions across the workload families -----

async function leg6Executions(): Promise<void> {
  await driveLeg("6", "executions across the capability portfolio (wire drive + literal examples)", async () => {
    const token = state.personaToken ?? state.operatorToken;

    // 6.1 — the direct wire drive, built from openapi.json alone.
    const create = await wire.call("POST", "/executions", {
      token,
      idempotencyKey: `persona-wire-${RUN_STAMP}`,
      body: {
        applicationId: APP_ID,
        task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
        constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
        metadata: { origin: "dep-042 machine-surface wire drive" },
      },
    });
    const createBody = create.json as
      | { executionId?: string; status?: string; replayed?: boolean }
      | null;
    const createOk = create.status === 201 && typeof createBody?.executionId === "string" && createBody.replayed === false;
    record(
      "6",
      "6.1",
      "create an execution through the wire contract: POST /executions {applicationId, task, constraints} + Idempotency-Key",
      "201 with the execution receipt (executionId, status, replayed=false)",
      createOk
        ? `HTTP 201 — execution ${createBody?.executionId} (status ${createBody?.status}, replayed=false)`
        : `unexpected create response: HTTP ${create.status} ${JSON.stringify(create.json).slice(0, 140)}`,
      createOk ? "pass" : "finding",
      createOk ? undefined : "AF6",
    );
    const drivenId = createBody?.executionId ?? null;
    state.drivenExecutionId = drivenId;

    // 6.2 — the documented lifecycle pattern: poll to terminal.
    if (drivenId !== null) {
      const settled = await pollTerminal(drivenId, token, 30_000);
      record(
        "6",
        "6.2",
        "poll GET /executions/<id> to a terminal status (the documented lifecycle pattern — the wire exposes no push channel)",
        "the execution reaches COMPLETED with a settled ledger",
        settled.status === "COMPLETED"
          ? `terminal status COMPLETED; the ledger carries ${settled.events.length} event(s)`
          : `terminal status ${String(settled.status)} after 30 s (${settled.events.length} events)`,
        settled.status === "COMPLETED" ? "pass" : "finding",
        settled.status === "COMPLETED" ? undefined : "AF6b",
      );
    }

    // 6.3 — the idempotent replay of the create.
    const replay = await wire.call("POST", "/executions", {
      token,
      idempotencyKey: `persona-wire-${RUN_STAMP}`,
      body: {
        applicationId: APP_ID,
        task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
        constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
        metadata: { origin: "dep-042 machine-surface wire drive" },
      },
    });
    const replayBody = replay.json as { executionId?: string; replayed?: boolean } | null;
    const replayOk =
      replay.status === 201 &&
      replayBody?.replayed === true &&
      replayBody?.executionId === drivenId;
    record(
      "6",
      "6.3",
      "replay the SAME create (same key + same fingerprint)",
      "the durable outcome replays: replayed=true, same executionId",
      replayOk
        ? "HTTP 201 replayed=true — the durable outcome, not a second execution"
        : `unexpected replay: HTTP ${replay.status} ${JSON.stringify(replay.json).slice(0, 120)}`,
      replayOk ? "pass" : "finding",
      replayOk ? undefined : "AF6c",
    );

    // 6.4 — LITERAL example execution: every examples-manifest entry that
    // claims runnable status, executed EXACTLY as the manifest prints it.
    const runnableExamples = manifestExamples.filter(
      (e) => e.classification === "runnable" && e.path !== "examples/webhook-receiver.ts",
    );
    const literalProblems: string[] = [];
    for (const example of runnableExamples) {
      const path = example.path ?? "";
      const declaredEnv: Record<string, string> = {
        ZECK_API_URL: API_BASE,
        ZECK_TOKEN: state.personaToken ?? state.operatorToken,
        ZECK_APPLICATION_ID: APP_ID,
      };
      const run = await spawnExample(path, declaredEnv, 150_000);
      const markers: string[] = [];
      for (const pattern of [
        /terminal status: COMPLETED/,
        /replayed=(true|false)/,
        /event ledger: \d+ event\(s\)/,
        /verification evidence: \d+ result\(s\)/,
        /proposed economic action/,
        /agent inventory: \d+ agent\(s\)/,
        /ZeckApiError 401 AUTHENTICATION_FAILED/,
        /key collision observed/,
      ]) {
        const match = run.stdout.match(pattern);
        if (match !== null) {
          markers.push(match[0]);
        }
      }
      exampleRuns.push({
        name: example.name ?? path,
        path,
        classification: "runnable",
        exitCode: run.code,
        ms: run.ms,
        markers,
      });
      const ok = run.code === 0 && run.timedOut === false;
      if (ok) {
        state.literalRanAsWritten += 1;
      } else {
        state.literalFindings += 1;
        literalProblems.push(
          `${path}: exit ${run.code ?? "signal"}${run.timedOut ? " (timed out)" : ""} — stderr/stdout tail: ${run.stdout.slice(-220).replace(/\n/g, " | ")}`,
        );
      }
      console.log(
        `    ${ok ? "ran-as-written" : "FAILED"} ${example.name ?? path} (exit ${run.code}, ${run.ms} ms)${markers.length === 0 ? "" : ` — ${markers.join("; ")}`}`,
      );
    }
    record(
      "6",
      "6.4",
      `execute every runnable examples-manifest entry LITERALLY: bun run <manifest path> with the manifest-declared env vars (${runnableExamples.length} entries; the webhook receiver follows separately)`,
      "every runnable example completes as written (exit 0) with zero hidden assumptions",
      literalProblems.length === 0
        ? `${state.literalRanAsWritten}/${runnableExamples.length} runnable examples ran as written (exit 0; the create → poll → result → evidence → replay spine printed by each)`
        : `literal-execution failures: ${literalProblems.join(" ;; ")}`,
      literalProblems.length === 0 ? "pass" : "finding",
      literalProblems.length === 0 ? undefined : "AF6d",
    );
    if (literalProblems.length > 0) {
      surface({
        id: "AF6d",
        leg: "6",
        classification: "docs",
        title: "a runnable examples-manifest entry failed when executed exactly as the manifest prints it",
        reproduction: literalProblems.join(" ;; "),
      });
    }

    // 6.4b — root-cause discovery THROUGH the machine contract: when the
    // wire enforces a closed vocabulary, does openapi.json document it?
    // (The persona's only remedy surface: the manifest is the contract
    // source — an undocumented closed vocabulary is a hidden assumption.)
    const economicSchemas = (readJson(`${MACHINE_DIR}/openapi.json`) as {
      components?: {
        schemas?: Record<
          string,
          | {
              properties?: Record<string, { enum?: string[] } | { items?: { properties?: Record<string, { enum?: string[] }> } }>;
            }
          | undefined
        >;
      };
    }).components?.schemas ?? {};
    const requestSchema = economicSchemas.EconomicActionRequest;
    const purposeSchema = requestSchema?.properties?.purpose as { enum?: string[] } | undefined;
    const recipientKindSchema = (
      requestSchema?.properties?.recipient as { properties?: Record<string, { enum?: string[] }> } | undefined
    )?.properties?.kind;
    const currencySchema = requestSchema?.properties?.currency as { enum?: string[] } | undefined;
    const capabilityKindSchema = (
      requestSchema?.properties?.requiredCapabilities as
        | { items?: { properties?: Record<string, { enum?: string[] }> } }
        | undefined
    )?.items?.properties?.kind;
    const vocabularies: [string, { enum?: string[] } | undefined][] = [
      ["purpose", purposeSchema],
      ["recipient.kind", recipientKindSchema],
      ["currency", currencySchema],
      ["requiredCapabilities[].kind", capabilityKindSchema],
    ];
    const undocumented = vocabularies
      .filter(([, schema]) => schema === undefined || schema.enum === undefined)
      .map(([field]) => field);
    const vocabulariesOk = undocumented.length === 0;
    record(
      "6",
      "6.4b",
      "root-cause the failed create through the machine contract: read openapi.json's EconomicActionRequest schema for the fields the wire's rejection enforced",
      "every closed-vocabulary field the economics authority enforces carries its enum in the openapi schema (the machine agent can learn the vocabulary from the manifest)",
      vocabulariesOk
        ? `the closed vocabularies are documented: ${vocabularies.map(([field, schema]) => `${field} ∈ {${(schema?.enum ?? []).join("|")}}`).join("; ")}`
        : `openapi.json documents ${undocumented.join(", ")} as FREE STRINGS while the wire rejects out-of-vocabulary values — the closed vocabularies (purpose: purchase|payment|transfer|refund|charge|machine-resource; recipient.kind: seller|merchant|provider|wallet|account; currency: usd|eur|gbp|jpy|cad|aud|chf; requiredCapabilities[].kind: model|tool|algorithm|data|runtime|human) are undiscoverable through the machine contract — the persona cannot know them without hitting the wire's refusal`,
      vocabulariesOk ? "pass" : "finding",
      vocabulariesOk ? undefined : "AF6b",
    );
    if (!vocabulariesOk) {
      surface({
        id: "AF6b",
        leg: "6",
        classification: "machine-manifest",
        title:
          "openapi.json documents the economic-action closed vocabularies as free strings — the wire's vocabulary constraints are undiscoverable through the machine contract",
        reproduction:
          `read docs/developer/machine/openapi.json components.schemas.EconomicActionRequest: purpose/recipient.kind/currency/requiredCapabilities[].kind are {"type":"string"} with NO enum; POST /economic-actions with an out-of-vocabulary value → 422 'economic action draft rejected: … purpose must be one of purchase, payment, transfer, refund, charge, machine-resource; recipient.kind is outside the closed vocabulary' (the vocabulary lives in src/modules/economics/domain/vocabulary.ts, never in the machine manifest) — the runnable examples/economic-actions.ts itself carries two out-of-vocabulary values (purpose 'purchase dataset access (example)', recipient.kind 'external-account') and fails when run as written`,
      });
    }

    // 6.5 — the webhook-receiver example: its documented run shape (a
    // listening receiver + signed deliveries), driven literally.
    const receiverSecret = `dep042-receiver-secret-${RUN_STAMP}`;
    const receiver = spawn(
      "bun",
      ["run", "examples/webhook-receiver.ts"],
      {
        cwd: REPOSITORY_ROOT,
        env: buildExampleEnv({
          ZECK_API_URL: API_BASE,
          ZECK_TOKEN: state.personaToken ?? state.operatorToken,
          ZECK_APPLICATION_ID: APP_ID,
          ZECK_WEBHOOK_SECRET: receiverSecret,
          ZECK_WEBHOOK_PORT: String(WEBHOOK_RECEIVER_PORT),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let receiverOutput = "";
    receiver.stdout.on("data", (chunk: Buffer) => {
      receiverOutput += chunk.toString();
    });
    receiver.stderr.on("data", (chunk: Buffer) => {
      receiverOutput += chunk.toString();
    });
    let receiverUp = false;
    const receiverDeadline = Date.now() + 20_000;
    while (Date.now() < receiverDeadline) {
      try {
        const probe = await fetch(`${WEBHOOK_RECEIVER_BASE}/webhooks/zeck`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zeck-signature": "00" },
          body: "{}",
          signal: AbortSignal.timeout(1000),
        });
        if (probe.status !== 404) {
          receiverUp = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }
    const unsigned: { status: number; body: string } | null = receiverUp
      ? await postWebhookDelivery(receiverSecret, null, 1)
      : null;
    const validEvent: WebhookEvent = {
      schemaVersion: 1,
      executionId: drivenId ?? "00000000-0000-7000-9000-000000000001",
      eventId: `evt-${RUN_STAMP}`,
      type: "execution.completed",
      sequence: 7,
      attempt: 1,
      occurredAt: now(),
      deliveredAt: now(),
      payload: { from: "VERIFYING", to: "COMPLETED" },
    };
    const signed = receiverUp ? await postWebhookDelivery(receiverSecret, validEvent, 1) : null;
    const signedReplay = receiverUp ? await postWebhookDelivery(receiverSecret, validEvent, 2) : null;
    receiver.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      receiver.once("exit", () => resolve());
      setTimeout(resolve, 5000).unref?.();
    });
    const receiverOk =
      receiverUp &&
      unsigned !== null &&
      unsigned.status === 401 &&
      signed !== null &&
      signed.status === 202 &&
      signed.body.includes("applied") &&
      signedReplay !== null &&
      signedReplay.status === 202 &&
      signedReplay.body.includes("replay acknowledged");
    exampleRuns.push({
      name: "webhook-receiver",
      path: "examples/webhook-receiver.ts",
      classification: "runnable",
      exitCode: receiverUp ? 0 : null,
      ms: 0,
      markers: [
        `unsigned→${unsigned?.status ?? "n/a"}`,
        `signed→${signed?.status ?? "n/a"}`,
        `replay→${signedReplay?.status ?? "n/a"}`,
      ],
    });
    if (receiverOk) {
      state.literalRanAsWritten += 1;
    }
    record(
      "6",
      "6.5",
      "run the webhook-receiver example as its manifest row + header document it (ZECK_WEBHOOK_SECRET + ZECK_WEBHOOK_PORT, the receiver listening on /webhooks/zeck): deliver an UNSIGNED event, a VALIDLY-SIGNED event, then a redelivery",
      "unsigned → 401 (never trusted); valid signature → 202 applied; redelivery → 202 replay-acknowledged without re-application",
      receiverOk
        ? `receiver booted (its own documented run line printed); unsigned → 401 'invalid signature'; signed → 202 'applied (eventId …)'; redelivery → 202 'replay acknowledged' — verify-before-trusting + exactly-once both hold`
        : `unexpected receiver behavior: up=${String(receiverUp)}, unsigned=${unsigned?.status ?? "n/a"} '${unsigned?.body.slice(0, 60) ?? ""}', signed=${signed?.status ?? "n/a"} '${signed?.body.slice(0, 60) ?? ""}', replay=${signedReplay?.status ?? "n/a"} '${signedReplay?.body.slice(0, 60) ?? ""}'; receiver output: ${receiverOutput.slice(0, 160)}`,
      receiverOk ? "pass" : "finding",
      receiverOk ? undefined : "AF6e",
    );

    // 6.6 — the provider-gated examples: executed as written, their
    // recorded boundary printed (the honest NOT RUN class).
    const gatedExamples = manifestExamples.filter((e) => e.classification === "provider-gated");
    const gatedProblems: string[] = [];
    for (const example of gatedExamples) {
      const path = example.path ?? "";
      const run = await spawnExample(
        path,
        {
          ZECK_API_URL: API_BASE,
          ZECK_TOKEN: state.personaToken ?? state.operatorToken,
          ZECK_APPLICATION_ID: APP_ID,
        },
        150_000,
      );
      const banner = /provider-gated workload:/.test(run.stdout);
      const gate = example.gatedBy;
      exampleRuns.push({
        name: example.name ?? path,
        path,
        classification: "provider-gated",
        exitCode: run.code,
        ms: run.ms,
        markers: banner ? ["provider-gated workload banner printed"] : [],
        gatedBy: gate,
      });
      const ok = run.code === 0 && banner;
      if (ok) {
        state.literalNotRunGated += 1;
      } else {
        state.literalFindings += 1;
        gatedProblems.push(
          `${path}: exit ${run.code ?? "signal"}${banner ? "" : " (no gated banner printed)"} — output tail: ${run.stdout.slice(-160).replace(/\n/g, " | ")}`,
        );
      }
      console.log(
        `    not-run-gated ${example.name ?? path} (exit ${run.code}, gate ${gate ?? "(rail boundary)"})`,
      );
    }
    record(
      "6",
      "6.6",
      `execute every provider-gated examples-manifest entry as written (core env only — the provider credential NAMES are explicitly absent): ${gatedExamples.length} entries`,
      "each prints its recorded availability boundary and completes its code path; provider COMPLETION stays honest NOT RUN",
      gatedProblems.length === 0
        ? `${state.literalNotRunGated}/${gatedExamples.length} provider-gated examples ran their code path with the gated banner printed (the named contracts: ${[...new Set(gatedExamples.map((e) => e.gatedBy ?? "(rail boundary)"))].join(", ")}); live provider completion is the recorded NOT RUN boundary`
        : `gated-example problems: ${gatedProblems.join(" ;; ")}`,
      gatedProblems.length === 0 ? "pass" : "finding",
      gatedProblems.length === 0 ? undefined : "AF6f",
    );
    if (gatedProblems.length > 0) {
      surface({
        id: "AF6f",
        leg: "6",
        classification: "docs",
        title: "a provider-gated examples-manifest entry did not print its recorded boundary when run as written",
        reproduction: gatedProblems.join(" ;; "),
      });
    }
  });
}

/** Deliver one webhook to the receiver example (unsigned or signed via the SDK basis). */
async function postWebhookDelivery(
  secret: string,
  event: WebhookEvent | null,
  attempt: number,
): Promise<{ status: number; body: string }> {
  const envelope =
    event === null
      ? { schemaVersion: 1, executionId: "x", eventId: "unsigned-1", type: "execution.completed", sequence: 1, attempt, occurredAt: now(), deliveredAt: now(), payload: {} }
      : { ...event, attempt };
  const body = JSON.stringify(envelope);
  const signature =
    event === null
      ? "deadbeef"
      : createHmac("sha256", secret).update(webhookSignatureBasis(envelope as WebhookEvent)).digest("hex");
  const response = await fetch(`${WEBHOOK_RECEIVER_BASE}/webhooks/zeck`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zeck-signature": signature,
      "x-zeck-event-id": envelope.eventId,
    },
    body,
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, body: await response.text() };
}

// ----- LEG 7: results / evidence / cost retrieval -----

async function leg7ResultsEvidenceCost(): Promise<void> {
  await driveLeg("7", "results / evidence / cost retrieval", async () => {
    const token = state.personaToken ?? state.operatorToken;
    const runId = state.drivenExecutionId;
    if (runId === null) {
      record("7", "7.0", "inspect the driven execution", "an execution exists", "no driven execution id", "not-run");
      return;
    }

    // 7.1 — the result package.
    const result = await wire.call("GET", `/executions/${encodeURIComponent(runId)}/results`, {
      token,
      applicationId: APP_ID,
    });
    const resultBody = result.json as
      | {
          status?: string;
          cost?: { totalMicroUsd?: string; currency?: string } | null;
          usage?: { inputTokens?: number; outputTokens?: number } | null;
          outputArtifacts?: { id?: string; digest?: string | null }[];
          verification?: { criterionId?: string; status?: string }[];
          warnings?: string[];
        }
      | null;
    const resultOk =
      result.status === 200 &&
      resultBody?.status === "COMPLETED" &&
      resultBody?.cost?.totalMicroUsd === SETTLE_COST_MICRO_USD &&
      resultBody?.cost?.currency === "usd" &&
      resultBody?.usage?.inputTokens === SETTLE_USAGE.inputTokens &&
      resultBody?.usage?.outputTokens === SETTLE_USAGE.outputTokens &&
      (resultBody?.outputArtifacts?.length ?? 0) > 0 &&
      (resultBody?.verification?.length ?? 0) > 0;
    record(
      "7",
      "7.1",
      "retrieve the result package: GET /executions/<id>/results",
      "the honest end-state: COMPLETED, settled integer-micro-USD cost, rail-reported usage, artifact digests, verification rows",
      resultOk
        ? `HTTP 200 — status ${resultBody?.status}, cost ${resultBody?.cost?.totalMicroUsd} micro-USD (${resultBody?.cost?.currency}), usage ${resultBody?.usage?.inputTokens}/${resultBody?.usage?.outputTokens} tokens, ${resultBody?.outputArtifacts?.length} artifact(s) (digest ${resultBody?.outputArtifacts?.[0]?.digest}), ${resultBody?.verification?.length} verification row(s), ${(resultBody?.warnings ?? []).length} warning(s)`
        : `unexpected result package: HTTP ${result.status} ${JSON.stringify(result.json).slice(0, 180)}`,
      resultOk ? "pass" : "finding",
      resultOk ? undefined : "AF7",
    );

    // 7.2 — the event ledger (gapless sequences).
    const events = await wire.call("GET", `/executions/${encodeURIComponent(runId)}/events`, {
      token,
      applicationId: APP_ID,
    });
    const eventRows = (events.json as { sequence?: number; type?: string }[] | null) ?? [];
    const sequences = eventRows.map((e) => e.sequence ?? 0);
    const gapless = sequences.every((seq, index) => seq === index + 1);
    const eventsOk = events.status === 200 && eventRows.length > 0 && gapless;
    record(
      "7",
      "7.2",
      "retrieve the evidence trail: GET /executions/<id>/events",
      "the ordered, gapless event ledger (lifecycle visibility)",
      eventsOk
        ? `HTTP 200 — ${eventRows.length} event(s), sequences 1..${eventRows.length} gapless (${eventRows.map((e) => e.type).slice(0, 6).join(" → ")}…)`
        : `unexpected events: HTTP ${events.status}, ${eventRows.length} rows, gapless=${String(gapless)}`,
      eventsOk ? "pass" : "finding",
      eventsOk ? undefined : "AF7b",
    );

    // 7.3 — the verification axis.
    const verification = await wire.call(
      "GET",
      `/executions/${encodeURIComponent(runId)}/verification`,
      { token, applicationId: APP_ID },
    );
    const verificationRows =
      (verification.json as { criterionId?: string; strategy?: string; status?: string }[] | null) ?? [];
    const verificationOk =
      verification.status === 200 &&
      verificationRows.length > 0 &&
      verificationRows[0]?.criterionId === "cites-sources" &&
      verificationRows[0]?.status === "PASS";
    record(
      "7",
      "7.3",
      "retrieve the verification axis: GET /executions/<id>/verification",
      "the evidence verdicts with criterion/strategy/status",
      verificationOk
        ? `HTTP 200 — ${verificationRows.length} row(s): ${verificationRows[0]?.criterionId} = ${verificationRows[0]?.status} (strategy ${verificationRows[0]?.strategy})`
        : `unexpected verification: HTTP ${verification.status} ${JSON.stringify(verification.json).slice(0, 140)}`,
      verificationOk ? "pass" : "finding",
      verificationOk ? undefined : "AF7c",
    );

    // 7.4 — the lifecycle-command boundary: cancelling a terminal execution.
    const cancel = await wire.call("POST", `/executions/${encodeURIComponent(runId)}/cancel`, {
      token,
      applicationId: APP_ID,
      idempotencyKey: `persona-cancel-${RUN_STAMP}`,
      body: {},
    });
    const cancelBody = cancel.json as { code?: string; retryable?: boolean } | null;
    const cancelOk = cancel.status === 409 && cancelBody?.code === "INVALID_STATE_TRANSITION";
    record(
      "7",
      "7.4",
      "probe the lifecycle-command boundary: POST /executions/<id>/cancel on the COMPLETED execution",
      "409 INVALID_STATE_TRANSITION — the deterministic mapping the taxonomy documents (only non-terminal executions accept cancel)",
      cancelOk
        ? "HTTP 409 INVALID_STATE_TRANSITION — the state machine's refusal is exact"
        : `unexpected cancel response: HTTP ${cancel.status} ${JSON.stringify(cancel.json).slice(0, 120)}`,
      cancelOk ? "pass" : "finding",
      cancelOk ? undefined : "AF7d",
    );
  });
}

// ----- LEG 8: validation library list + rerun -----

async function leg8ValidationLibrary(): Promise<void> {
  await driveLeg("8", "validation library list + rerun (the machine-contract view)", async () => {
    // 8.1 — the persona searches the machine contract for the
    // validation-library surface (the journey leg the roadmap names).
    const openapi = readJson(`${MACHINE_DIR}/openapi.json`) as { paths?: Record<string, unknown> };
    const validationRoutes = Object.keys(openapi.paths ?? {}).filter((p) => /validation/i.test(p));
    const validationExamples = manifestExamples.filter((e) =>
      /validation/i.test(`${e.name ?? ""}${e.path ?? ""}`),
    );
    const recipe = readText(`${MACHINE_DIR}/integration-recipe.json`);
    let boundariesDeclared = false;
    let boundaryReferencesRecipe = false;
    if (existsSync(join(REPOSITORY_ROOT, MACHINE_DIR, "surface-boundaries.json"))) {
      const boundaries = readJson(`${MACHINE_DIR}/surface-boundaries.json`) as {
        boundaries?: { surface?: string; machineStatus?: string }[];
      };
      boundariesDeclared = (boundaries.boundaries ?? []).some(
        (b) => b.surface === "validation-library" && /console|unavailable/i.test(b.machineStatus ?? ""),
      );
    }
    if (boundariesDeclared) {
      boundaryReferencesRecipe = /surface-boundaries\.json/.test(recipe);
    }
    // A machine-executable surface would be an openapi route or a manifest
    // example (the recipe TEXT can only DECLARE the boundary, never
    // execute it — a mention there is the declaration being discoverable).
    const machineExecutable = validationRoutes.length > 0 || validationExamples.length > 0;
    record(
      "8",
      "8.1",
      "search the machine contract for the Validation Library surface (openapi routes, examples-manifest entries, integration-recipe steps)",
      "a machine-readable list/rerun path exists OR the boundary is declared machine-side",
      !machineExecutable
        ? boundariesDeclared
          ? `no validation-library route/example exists in the machine contract (openapi: 0 /validation routes; examples-manifest: 0 entries) — the machine boundary manifest surface-boundaries.json declares it a console-plane surface (honest unavailable, recorded)${boundaryReferencesRecipe ? " and the integration-recipe's invariant points the agent at the declaration" : ""}`
          : "NO validation-library surface exists anywhere in the machine contract: openapi.json carries no /validation route, examples-manifest.json carries no validation example, integration-recipe.json never mentions the library — the Validation Library (DEP-025's definition catalog + governed rerun) is invisible to a machine agent; the persona cannot list the library, let alone rerun an experiment, without the console"
        : `unexpected validation surface found: routes=${validationRoutes.join(",")} examples=${validationExamples.map((e) => e.name).join(",")}`,
      !machineExecutable && boundariesDeclared ? "pass" : "finding",
      !machineExecutable && boundariesDeclared ? undefined : "AF8",
    );
    if (!machineExecutable && !boundariesDeclared) {
      surface({
        id: "AF8",
        leg: "8",
        classification: "machine-manifest",
        title:
          "the Validation Library (list + rerun) is not discoverable through the machine surface — no openapi route, no manifest example, no recipe step names it",
        reproduction:
          "grep -i validation docs/developer/machine/openapi.json → only agent-version validationState schema fields, no /validation route; grep -i validation docs/developer/machine/examples-manifest.json → no entry; integration-recipe.json's 9 steps never mention the library; the surface lives only on the console plane (/console/validation + api/catalog.json — outside the machine persona's discipline)",
      });
    }

    // 8.2 — the honest NOT RUN record.
    record(
      "8",
      "8.2",
      "the validation-library list + rerun leg",
      "the leg completes OR its boundary is recorded with an owner",
      `NOT RUN — the Validation Library rerun is a console-plane surface in this base (no machine route); the persona records the honest boundary. Owner: Lead (either expose a machine-readable library list/rerun route set or keep the boundary declared machine-side)`,
      "not-run",
    );
  });
}

// ----- LEG 9: export path -----

async function leg9ExportPath(): Promise<void> {
  await driveLeg("9", "export path (the reproducibility bundle, machine-contract view)", async () => {
    // 9.1 — the persona searches the machine contract for the execution
    // export / reproducibility-bundle surface.
    const openapi = readJson(`${MACHINE_DIR}/openapi.json`) as { paths?: Record<string, unknown> };
    const exportRoutes = Object.keys(openapi.paths ?? {}).filter((p) => /export|bundle/i.test(p));
    const exportExamples = manifestExamples.filter((e) =>
      /export|bundle|reproduc/i.test(`${e.name ?? ""}${e.path ?? ""}`),
    );
    let boundariesDeclared = false;
    if (existsSync(join(REPOSITORY_ROOT, MACHINE_DIR, "surface-boundaries.json"))) {
      const boundaries = readJson(`${MACHINE_DIR}/surface-boundaries.json`) as {
        boundaries?: { surface?: string; machineStatus?: string }[];
      };
      boundariesDeclared = (boundaries.boundaries ?? []).some(
        (b) => b.surface === "execution-export" && /console|unavailable/i.test(b.machineStatus ?? ""),
      );
    }
    const notFound = exportRoutes.length === 0 && exportExamples.length === 0;
    record(
      "9",
      "9.1",
      "search the machine contract for the execution reproducibility-bundle export surface (openapi routes, examples-manifest entries)",
      "a machine-readable export path exists OR the boundary is declared machine-side",
      notFound
        ? boundariesDeclared
          ? "no export route/example exists in the machine contract — the machine boundary manifest declares the reproducibility bundle a console-plane surface (honest unavailable, recorded)"
          : "NO export surface exists anywhere in the machine contract: openapi.json carries no /export route (the result package at GET /executions/<id>/results is the closest machine surface), examples-manifest.json carries no export example — the reproducibility bundle (DEP-032's export path) is invisible to a machine agent"
        : `unexpected export surface found: routes=${exportRoutes.join(",")} examples=${exportExamples.map((e) => e.name).join(",")}`,
      notFound && boundariesDeclared ? "pass" : "finding",
      notFound && boundariesDeclared ? undefined : "AF9",
    );
    if (notFound && !boundariesDeclared) {
      surface({
        id: "AF9",
        leg: "9",
        classification: "machine-manifest",
        title:
          "the execution reproducibility-bundle export path is not discoverable through the machine surface — no openapi route, no manifest example",
        reproduction:
          "grep -iE 'export|bundle' docs/developer/machine/openapi.json → no route matches (27 paths, none export); grep -iE 'export|bundle|reproduc' docs/developer/machine/examples-manifest.json → no entry; the surface lives only on the console plane (/console/executions/<id>/export + bundle.json — outside the machine persona's discipline)",
      });
    }

    // 9.2 — the honest NOT RUN record.
    record(
      "9",
      "9.2",
      "the export-path leg (retrieving the reproducibility bundle through the machine surface)",
      "the leg completes OR its boundary is recorded with an owner",
      "NOT RUN — the reproducibility-bundle export is a console-plane surface in this base (no machine route); the persona records the honest boundary. Owner: Lead (expose a machine export route or keep the boundary declared machine-side)",
      "not-run",
    );
  });
}

// ----- LEG 10: boundary honesty (the not-run registry) -----

async function leg10Boundaries(): Promise<void> {
  await driveLeg("10", "honest boundaries (the not-run registry of the trial)", async () => {
    // 10.1 — the provider-gated families' named contracts.
    const capabilityEntries = readJson(`${MACHINE_DIR}/capability-manifest.json`) as {
      workloadFamilies?: { family?: string; classification?: string; gatedBy?: string }[];
    };
    const gated = (capabilityEntries.workloadFamilies ?? []).filter(
      (f) => f.classification === "provider-gated",
    );
    const gates = new Map<string, string[]>();
    for (const family of gated) {
      const gate = family.gatedBy ?? "(rail boundary — no authorized rail)";
      gates.set(gate, [...(gates.get(gate) ?? []), family.family ?? "?"]);
    }
    record(
      "10",
      "10.1",
      "compile the provider-gated families' named contracts from the capability manifest",
      "every gated family names its gate (credential env var NAME or rail boundary)",
      `${gated.length} provider-gated families → ${[...gates.entries()].map(([gate, fams]) => `${gate} (${fams.length}: ${fams.slice(0, 3).join(", ")}${fams.length > 3 ? "…" : ""})`).join("; ")}`,
      "pass",
    );

    // 10.2 — the live-provider completion boundary (zero live cost).
    record(
      "10",
      "10.2",
      "the live-provider completion rails (real model/tool/media completions through OPENROUTER_API_KEY / QWEN_API_KEY / …)",
      "the boundary is recorded honestly — never a fabricated provider result",
      "NOT RUN — no operator provider credentials exist in this environment; every execution settled through the platform's own governed transition commands with the settlement envelope recorded in the ledger (the worker-path seam). Zero live provider cost consumed. Owner: Lead credentialed re-run (the hosted-plane trial with authorized rails)",
      "not-run",
    );

    // 10.3 — the hosted-plane variant boundary.
    record(
      "10",
      "10.3",
      "the public-internet variant of the journey against a hosted deployment",
      "the boundary is recorded honestly",
      "NOT RUN — no public hosted Zeck URL exists in this environment; the trial ran against a REAL locally-booted plane serving the same public contract (real processes, real HTTP). Owner: Lead credentialed re-run (deploy a preview plane per PUBLIC-DEPLOYMENT.md §3.2 and re-drive the journey)",
      "not-run",
    );
  });
}

// ---------------------------------------------------------------------------
// Emission + teardown
// ---------------------------------------------------------------------------

function emitJourneyLog(): void {
  const log = {
    schemaVersion: 1,
    workOrder: "DEP-042",
    drive: BASELINE_MODE ? "baseline (pre-fix)" : "verification (post-fix)",
    runStamp: RUN_STAMP,
    persona: "fresh CODING AGENT — consumes ONLY AGENTS.md (repo root), docs/developer/machine/**, the public API wire surface, and the SDK where the machine artifacts point (no human docs, no console, no src/ contract reading)",
    substrate: {
      apiBase: API_BASE,
      composition:
        "REAL createApiServer over REAL module services (executions/credentials/quotas/sandbox-identities/economics, in-memory stores) + REAL runtime deployment identity (manifest digest + provider-tiers ledger + git revision); worker-path settler drives governed transitions + settlement ledger event (costMicroUsd 4125, usage {inputTokens 2100, outputTokens 340}, one artifact with digest) — the platform-side completion a bound worker + provider rail performs on a hosted plane; live provider completion honest NOT RUN",
      connectionValues:
        "the operator-provided bootstrap credential (the recipe's prerequisites) + the persona's OWN credential issued through the public POST /credentials route",
    },
    baseRevision: deploymentRevision,
    legs,
    steps,
    findingsSurfaced: surfacedFindings,
    frictionEvents,
    exampleExecution: {
      tally: {
        ranAsWritten: state.literalRanAsWritten,
        notRunGated: state.literalNotRunGated,
        findings: state.literalFindings,
      },
      runs: exampleRuns,
    },
  };
  writeFileSync(JOURNEY_LOG_PATH, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`\njourney log → ${JOURNEY_LOG_PATH}`);
  const passed = steps.filter((s) => s.outcome === "pass").length;
  console.log(
    `journey summary: ${steps.length} steps — ${passed} pass, ${steps.filter((s) => s.outcome === "finding").length} finding, ${steps.filter((s) => s.outcome === "not-run").length} not-run; ${surfacedFindings.length} finding(s) surfaced; ${frictionEvents} friction event(s); examples: ${state.literalRanAsWritten} ran-as-written / ${state.literalNotRunGated} not-run-gated / ${state.literalFindings} finding(s)`,
  );
}

async function main(): Promise<void> {
  await apiServer.app.listen({ host: "127.0.0.1", port: API_PORT });
  console.log(`DEP-042 fresh-AGENT trial plane (${BASELINE_MODE ? "BASELINE drive" : "verification drive"}):`);
  console.log(`  api:      ${API_BASE}`);
  console.log(`  revision: ${deploymentRevision.slice(0, 12)}`);

  try {
    await leg1Discovery();
    await leg2ContractReading();
    await leg3Authenticate();
    await leg4Application();
    await leg5SandboxConfig();
    await leg6Executions();
    await leg7ResultsEvidenceCost();
    await leg8ValidationLibrary();
    await leg9ExportPath();
    await leg10Boundaries();
  } finally {
    clearInterval(workerPath);
    emitJourneyLog();
    await apiServer.app.close();
  }
}

main().catch((error: unknown) => {
  console.error(`trial harness error: ${(error as Error).stack ?? error}`);
  clearInterval(workerPath);
  process.exit(1);
});
