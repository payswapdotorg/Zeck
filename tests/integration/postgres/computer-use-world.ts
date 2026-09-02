/**
 * Shared real-PostgreSQL fixture for the computer-use and GUI execution
 * suites (WORK-027, CUI-001/002/003).
 *
 * Extends the house PG pattern (WORK-010 tools-world / WORK-026
 * media-world / WORK-028 longrunning-world) with the WORK-027 governed
 * computer-use fabric over the provider-neutral DatabasePort (migration
 * 0023):
 *
 *   * computer-use durable state: SqlComputerUseStore (migration 0023 —
 *     sessions/escalations/actions/observations/operations, the state
 *     this Work Order owns);
 *   * the FROZEN executions module: SqlExecutionStore +
 *     SqlExecutionsIdempotency + the execution service (the single write
 *     path and the canonical EventEnvelope ledger the computer-use
 *     evidence rides through the tools module's ExecutionLedger adapter);
 *   * policy admission: the REAL policies engine (WORK-007) behind the
 *     tools module's policy-computer-use adapter, with a default
 *     platform-allow document (tests publish restrictive v2 sets to
 *     deny tool facts, network hosts and secret references — the
 *     REAL-engine denial proofs);
 *   * capability admission: the REAL capabilities registry (WORK-005,
 *     in-memory catalog seeded with the platform seeds + the three
 *     computer-use route-atom claims) behind the tools module's
 *     computer-use capability gate;
 *   * secret mediation: the REAL connections module (WORK-003 — the
 *     SQL store + BYOK credential vault + scope resolver) behind the
 *     connection-computer-use mediation adapter (the world registers a
 *     real BYOK-credentialed connection; a toggle disables it for the
 *     refusal proof);
 *   * budget admission: the REAL budgets service (WORK-004 —
 *     SqlBudgetStore + SqlBudgetsIdempotency, a developer-funded wallet
 *     with granted credits) directly behind the BudgetAuthority seam —
 *     the budget-before-spend boundary is PHYSICAL in PostgreSQL;
 *   * the sandbox terminal rail: the REAL sandbox module (WORK-012 —
 *     SqlSandboxStore + the environment catalog + the sandbox service
 *     with the REAL policy/capability/budget/ledger seams and the
 *     ProcessSandboxProvider) behind the sandbox-computer-use terminal
 *     executor — every terminal-exec action is a fully admitted,
 *     dispatched and journaled sandbox execution;
 *   * the environment rail: the in-process simulated isolated
 *     computer-use environment (the provider-honesty stance — no
 *     external computer-use provider credentials exist in this
 *     environment; external browser/desktop behavior is UNVERIFIED and
 *     recorded as such in docs/work-items/WORK-027.md);
 *   * the process-restart crash primitive: `boot(point)` re-boots the
 *     computer-use service over the SURVIVING world (the PG stores, the
 *     frozen executions module, the budgets service, the sandbox
 *     catalog, the connections catalog and the capability declarations
 *     persist across a Zeck process death); a `point` arms ONE
 *     durable-boundary crash (a method on the computer-use store, the
 *     executions service, the sandbox service, the budget authority or
 *     the simulated environment, before/after its durable commit or
 *     external effect) that kills the booted process mid-flight.
 */

import { createHash } from "node:crypto";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import { createTxCredentialVault } from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import type { ConnectionService } from "../../../src/modules/connections/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createSandboxCapabilityGate } from "../../../src/modules/sandbox/adapters/capability-gate";
import { createSandboxExecutionLedgerAdapter } from "../../../src/modules/sandbox/adapters/execution-ledger";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createSandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import type {
  ComputerUseActionRequest,
  ComputerUseCapabilityDeclaration,
  ComputerUseService,
  ComputerUseSessionReceipt,
} from "../../../src/modules/tools/public";
import {
  createComputerUseCapabilityGate,
  createComputerUseService,
  createConnectionComputerUseSecretMediation,
  createExecutionLedgerAdapter,
  createPolicyComputerUseAdmission,
  createSandboxComputerUseTerminal,
  createSimulatedComputerUseEnvironment,
  InMemoryComputerUseRegistry,
  registerComputerUseCapability,
  type SimulatedComputerUseEnvironment,
  SqlComputerUseStore,
} from "../../../src/modules/tools/public";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The neutral terminal compute-environment spec of the world. */
export const COMPUTER_USE_TERMINAL_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface ComputerUseCrashPoint {
  readonly target: "store" | "executions" | "sandbox" | "budgets" | "environment";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the booted process dies at the
 * planned point (`before` = the durable commit / external effect did
 * not happen; `after` = it did). The wrapper records the firing so a
 * vacuous proof (a point the service never reaches) fails its
 * `crashed()` assertion.
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: ComputerUseCrashPoint | null,
) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

export interface ComputerUsePgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly otherTenantId: string;
  /** The owner actor of the world's application (membership-backed). */
  readonly actorId: string;
  readonly store: SqlComputerUseStore;
  readonly registry: InMemoryComputerUseRegistry;
  readonly policyAuthority: PolicyAuthority;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly connectionService: ConnectionService;
  readonly budgets: BudgetService;
  readonly sandboxCatalog: ReturnType<typeof createEnvironmentCatalog>;
  readonly sandboxEnvironmentId: string;
  readonly connectionId: string;
  /** The default booted process's service (the house default helpers use it). */
  readonly service: ComputerUseService;
  /** The world-level shared simulated environment (the journal proofs — durable across process death). */
  readonly environment: SimulatedComputerUseEnvironment;
  /** Boot (or re-boot) the computer-use service over the SURVIVING world. */
  readonly boot: (point?: ComputerUseCrashPoint | null) => {
    readonly service: ComputerUseService;
    readonly executions: ExecutionService;
    readonly environment: SimulatedComputerUseEnvironment;
    readonly crashed: () => boolean;
  };
  readonly actor: () => { actorId: string; tenantId: string };
  readonly register: (declaration: ComputerUseCapabilityDeclaration) => Promise<void>;
  readonly fundApplication: (amountMicroUsd?: string) => Promise<void>;
  readonly disableConnection: () => Promise<void>;
  readonly driveToRunning: (executions: ExecutionService) => Promise<string>;
  readonly createSession: (
    request: Partial<Parameters<ComputerUseService["createSession"]>[0]>,
    idempotencyKey?: string,
  ) => Promise<ComputerUseSessionReceipt>;
  readonly dispatch: (
    sessionId: string,
    action: ComputerUseActionRequest,
    idempotencyKey?: string,
  ) => ReturnType<ComputerUseService["dispatchAction"]>;
}

export const TERMINAL_RUNNER = {
  command: process.execPath,
  // The sandbox spawns ONE argv without a shell: the runner, its arg,
  // then the computer-use terminal command and its args.
  args: ["-e", "console.log('cu-terminal-ok')"],
} as const;

/**
 * The canonical declarations the PG suites use (deterministic /
 * browser / desktop — the unit world's shapes, plus the credentialed
 * deterministic variant for the mediation proofs).
 */
export function deterministicDeclaration(
  overrides: Partial<ComputerUseCapabilityDeclaration> = {},
): ComputerUseCapabilityDeclaration {
  return {
    capabilityId: "computer-use-api-det",
    kind: "deterministic",
    description: "deterministic API capability",
    capabilityAtom: "computer-use-deterministic",
    covers: ["atom-a", "atom-b"],
    deterministicQuality: 0.95,
    qualityConfidence: "verified",
    estimatedMicroUsd: "10",
    hosts: ["api.example.com"],
    secretRef: null,
    desktopEnvelope: null,
    terminalPolicy: null,
    browserProfile: null,
    ...overrides,
  };
}

export function credentialedDeclaration(
  overrides: Partial<ComputerUseCapabilityDeclaration> = {},
): ComputerUseCapabilityDeclaration {
  return deterministicDeclaration({
    capabilityId: "computer-use-api-credentialed",
    description: "deterministic API capability behind a mediated credential",
    secretRef: "connections:api-credential",
    ...overrides,
  });
}

export function browserDeclaration(
  overrides: Partial<ComputerUseCapabilityDeclaration> = {},
): ComputerUseCapabilityDeclaration {
  return {
    capabilityId: "computer-use-browser-isolated",
    kind: "browser",
    description: "isolated browser automation",
    capabilityAtom: "computer-use-browser",
    covers: [],
    deterministicQuality: null,
    qualityConfidence: null,
    estimatedMicroUsd: "40",
    hosts: ["site.example.com"],
    secretRef: null,
    desktopEnvelope: null,
    terminalPolicy: null,
    browserProfile: {
      egressAllowlist: ["site.example.com"],
      cookieJar: "session-fresh-empty",
      ambientHostInheritance: "none",
    },
    ...overrides,
  };
}

export function desktopDeclaration(
  overrides: Partial<ComputerUseCapabilityDeclaration> = {},
): ComputerUseCapabilityDeclaration {
  return {
    capabilityId: "computer-use-desktop-isolated",
    kind: "desktop",
    description: "isolated desktop/terminal interaction",
    capabilityAtom: "computer-use-desktop",
    covers: [],
    deterministicQuality: null,
    qualityConfidence: null,
    estimatedMicroUsd: "80",
    hosts: [],
    secretRef: null,
    desktopEnvelope: {
      inputDevices: true,
      windowsApps: true,
      filesystem: true,
      network: false,
      clipboard: true,
      downloads: true,
      terminal: true,
    },
    terminalPolicy: { process: true, filesystem: true, network: false, egressAllowlist: [] },
    browserProfile: null,
    ...overrides,
  };
}

export async function seedComputerUseWorld(db: DatabasePort): Promise<ComputerUsePgWorld> {
  const generateId = createUuidv7Generator();
  const now = () => new Date();
  const tenantId = generateId();
  const applicationId = generateId();
  const otherTenantId = generateId();
  const actorId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)",
    parameters: [
      tenantId,
      `t-${tenantId.slice(-6)}`,
      "computer-use tenant",
      otherTenantId,
      `t-${otherTenantId.slice(-6)}`,
      "computer-use other tenant",
    ],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "computer-use app"],
  });
  // The identity rows the connections authorization path needs (the
  // owner actor is a member of the world's application).
  await db.execute({
    sql: "INSERT INTO identity.actors (id, external_subject, display_name) VALUES ($1, $2, $3)",
    parameters: [actorId, `subj-${actorId}`, "computer-use owner"],
  });
  await db.execute({
    sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner')",
    parameters: [generateId(), actorId, applicationId, tenantId],
  });

  // The REAL policies engine behind the executions authorize seam AND
  // the computer-use policy admission seam AND the sandbox admission
  // seam. The default set is platform-allow; tests publish restrictive
  // v2 sets for the denial proofs.
  const authority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // The REAL capabilities registry (WORK-005): platform seeds + the
  // three computer-use route atoms the capability gate resolves.
  const computerUseRouteClaims = [
    "computer-use-deterministic",
    "computer-use-browser",
    "computer-use-desktop",
  ].map((id) => ({
    claim: { id, kind: "tool" as const, version: "1.0.0", attributes: { governed: true } },
    provenance: { publisher: "tests:computer-use-world", publishedAt: "2026-09-02T00:00:00Z" },
    evidence: { kind: "catalog-seeded" as const, reference: `computer-use-world:${id}` },
  }));
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS, ...computerUseRouteClaims],
  });

  // The REAL budgets service (WORK-004) directly behind the
  // BudgetAuthority seam — reserve/settle/release are PHYSICAL wallet
  // operations in PG.
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now,
  });
  const fundApplication = async (amountMicroUsd = "100000000") => {
    const scope = { actorId, applicationId, tenantId };
    await budgets.configureFundingMode(
      { ...scope, fundingMode: "developer" },
      `cu-fund-${applicationId}:mode`,
    );
    await budgets.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd },
      `cu-fund-${applicationId}:credits`,
    );
  };
  await fundApplication();

  // The REAL connections module (WORK-003) behind the secret-mediation
  // seam: SQL store + BYOK credential vault + scope resolver. The world
  // registers one active BYOK connection.
  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(db, generateId);
  const connectionService = createConnectionService(
    new SqlConnectionStore(db),
    new SqlConnectionsIdempotency(
      db,
      (tx) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  const registered = await connectionService.registerConnection(
    {
      principal: { actorId, authenticatedAt: "2026-09-02T00:00:00Z" },
      applicationId,
      rail: "openrouter",
      label: "cu-primary",
      registerCredential: { material: "cu-byok-material-DO-NOT-LEAK" },
    },
    `cu-register-${applicationId}`,
  );
  const connectionId = registered.connection.id;
  const disableConnection = async (): Promise<void> => {
    await connectionService.updateStatus(
      {
        principal: { actorId, authenticatedAt: "2026-09-02T00:00:00Z" },
        applicationId,
        connectionId,
        status: "disabled",
      },
      `cu-disable-${connectionId}`,
    );
  };

  // The REAL sandbox module (WORK-012) behind the terminal executor: the
  // SQL environment catalog + the sandbox service with the REAL
  // policy/capability/budget/ledger seams and the process runtime.
  const sandboxStore = new SqlSandboxStore(db);
  const sandboxCatalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now,
    hashSpec: sha256Hex,
  });
  const providers = createSandboxProviderRegistry();
  providers.register(new ProcessSandboxProvider());
  const environmentRecord = await sandboxCatalog.register(
    {
      applicationId,
      tenantId,
      slug: "cu-terminal",
      name: "computer-use terminal environment",
      spec: COMPUTER_USE_TERMINAL_SPEC,
    },
    `cu-env-${applicationId}`,
    { actorId, applicationId, tenantId },
  );
  const sandboxEnvironmentId = environmentRecord.id;

  // The shared, surviving authority adapters (each consults a REAL
  // authority; none of them is re-created by boot — the authorities
  // survive the process death, exactly as a restart would find them).
  const policyAdmission = createPolicyComputerUseAdmission(authority);
  const capabilityGate = createComputerUseCapabilityGate(capabilityRegistry);
  const secretMediation = createConnectionComputerUseSecretMediation(connectionService);

  // The computer-use capability declarations (the registry is
  // process-local configuration — a restart re-reads the same static
  // declarations, so the world shares ONE registry instance).
  const registry = new InMemoryComputerUseRegistry();
  const register = (declaration: ComputerUseCapabilityDeclaration) =>
    registerComputerUseCapability(registry, declaration);
  await register(deterministicDeclaration());
  await register(credentialedDeclaration());
  await register(browserDeclaration());
  await register(desktopDeclaration());

  const store = new SqlComputerUseStore(db);
  // The world-level simulated environment (shared by every boot — the
  // durable external substrate; see boot()).
  const environment = createSimulatedComputerUseEnvironment();

  const boot = (point: ComputerUseCrashPoint | null = null) => {
    // A NEW executions service over the SURVIVING SQL store + key
    // ledger (the process-local composition of the frozen module).
    const executionsProcess = crashableSeam(
      createExecutionService({
        store: new SqlExecutionStore(db),
        idempotency: new SqlExecutionsIdempotency(
          db,
          (tx) => new SqlExecutionStore(tx),
          generateId,
        ),
        authorization: createExecutionAuthorization(authority),
        generateId,
        now,
      }),
      "executions",
      point,
    );
    // The REAL sandbox service for THIS process over the SURVIVING
    // sandbox store (the terminal rail's own durable authority).
    const sandboxProcess = crashableSeam(
      createSandboxService({
        store: sandboxStore,
        admission: createPolicySandboxAdmission(authority),
        capabilities: createSandboxCapabilityGate(capabilityRegistry),
        budgetAuthority: budgets,
        ledger: createSandboxExecutionLedgerAdapter(executionsProcess.proxy as ExecutionService),
        providers,
        generateId,
        now,
      }),
      "sandbox",
      point,
    );
    const budgetsProcess = crashableSeam(budgets, "budgets", point);
    // The simulated isolated environment models the DURABLE external
    // computer-use substrate: a real isolated browser/desktop
    // environment OUTLIVES the controller process, so ONE world-level
    // instance is shared by every booted process. The keyed external
    // effects journal (env-open / action external keys) converges
    // re-dispatches across process death — exactly one external effect
    // per stable key — which is the semantics the service's external
    // key discipline presumes (and the real adapter's idempotent
    // provider endpoints would deliver).
    const environmentProcess = crashableSeam(environment, "environment", point);
    const storeProcess = crashableSeam(new SqlComputerUseStore(db), "store", point);
    const terminal = createSandboxComputerUseTerminal({
      service: sandboxProcess.proxy as ReturnType<typeof createSandboxService>,
      catalog: sandboxCatalog,
      options: {
        environmentId: sandboxEnvironmentId,
        runnerCommand: TERMINAL_RUNNER.command,
        runnerArgs: [...TERMINAL_RUNNER.args],
      },
    });
    const service = createComputerUseService({
      registry,
      policy: policyAdmission,
      capabilities: capabilityGate,
      secrets: secretMediation,
      budgetAuthority: budgetsProcess.proxy as BudgetService,
      store: storeProcess.proxy,
      ledger: createExecutionLedgerAdapter(executionsProcess.proxy as ExecutionService),
      environment: environmentProcess.proxy,
      terminal,
      generateId,
      now,
      digest: sha256Hex,
    });
    return {
      service,
      executions: executionsProcess.proxy as ExecutionService,
      environment: environmentProcess.proxy,
      crashed: () =>
        executionsProcess.crashed() ||
        sandboxProcess.crashed() ||
        budgetsProcess.crashed() ||
        environmentProcess.crashed() ||
        storeProcess.crashed(),
    };
  };

  const actor = () => ({ actorId, tenantId });

  const driveToRunning = async (executions: ExecutionService): Promise<string> => {
    const created = await executions.createExecution(
      { applicationId, task: { kind: "summarize", input: "artifact-1" } },
      `cu-create-${generateId()}`,
      actor(),
    );
    const executionId = created.executionId;
    const scope = { ...actor(), applicationId, executionId };
    await executions.transition({ ...scope, command: "authorize" }, `cu-authorize-${executionId}`);
    await executions.transition({ ...scope, command: "plan" }, `cu-plan-${executionId}`);
    await executions.transition({ ...scope, command: "queue" }, `cu-queue-${executionId}`);
    await executions.transition({ ...scope, command: "start" }, `cu-start-${executionId}`);
    return executionId;
  };

  const defaultBooted = boot();

  const world: ComputerUsePgWorld = {
    db,
    tenantId,
    applicationId,
    otherTenantId,
    actorId,
    store,
    registry,
    policyAuthority: authority,
    capabilityRegistry,
    connectionService,
    budgets,
    sandboxCatalog,
    sandboxEnvironmentId,
    connectionId,
    service: defaultBooted.service,
    environment: defaultBooted.environment,
    boot,
    actor,
    register,
    fundApplication,
    disableConnection,
    driveToRunning,
    createSession(request, idempotencyKey = `cu-sk-${generateId()}`) {
      const executionId = request.executionId ?? "";
      return defaultBooted.service.createSession(
        {
          applicationId,
          executionId,
          actor: actor(),
          task: {
            kind: "structured-data-retrieval",
            requirementAtoms: ["atom-a", "atom-b"],
            qualityTarget: 0.9,
          },
          candidates: {
            deterministic: ["computer-use-api-det"],
            browser: "computer-use-browser-isolated",
            desktop: "computer-use-desktop-isolated",
          },
          connectionRef: null,
          ...request,
        },
        idempotencyKey,
      );
    },
    dispatch(sessionId, action, idempotencyKey = `cu-ak-${generateId()}`) {
      return defaultBooted.service.dispatchAction(applicationId, sessionId, action, idempotencyKey);
    },
  };
  return world;
}

// ---------------------------------------------------------------------------
// Scenario helpers shared by the PG suites.
// ---------------------------------------------------------------------------

/**
 * Run one operation in a DYING process: the armed crash point kills it
 * mid-flight (the promise's terminal state is irrelevant — the process
 * is gone; only the durable world matters).
 */
export async function diesDuring(
  run: () => Promise<unknown>,
  crashed: () => boolean,
): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  if (!crashed()) {
    throw new Error("the armed crash point never fired (a vacuous crash proof)");
  }
}

/** Query one row (proof assertions). */
export async function one<T = Record<string, unknown>>(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[],
): Promise<T | null> {
  const result = await db.execute<T>({ sql, parameters });
  return result.rows.length > 0 ? (result.rows[0] as T) : null;
}

/** Query a count (proof assertions). */
export async function count(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM (${sql}) AS q`,
    parameters,
  );
  return row?.n ?? 0;
}

/** The tools producer-vocabulary step events of one execution. */
export async function eventsOf(
  db: DatabasePort,
  executionId: string,
): Promise<readonly { sequence: number; type: string }[]> {
  const result = await db.execute<{ sequence: number; type: string }>({
    sql: "SELECT sequence, type FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence",
    parameters: [executionId],
  });
  return result.rows;
}
