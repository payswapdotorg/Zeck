/**
 * In-memory computer-use world (unit-test infrastructure; WORK-027).
 *
 * The governed computer-use fabric over the REAL domain/service/adapters
 * and the REAL in-memory executions module (the canonical ledger the
 * evidence rides), with the authority seams as recording fakes (the
 * policy/capability/secret seams the real engines fill at the PG level):
 *
 *   - the simulated isolated environment (with its hostile host world);
 *   - the in-memory computer-use store (the migration-0023 faithful fake);
 *   - the in-memory capability registry (validated declarations);
 *   - the budget authority fake from the tools fakes (reserve/settle/
 *     release with denial mode);
 *   - the executions service over the in-memory store — step events ride
 *     the canonical EventEnvelope ledger exactly as in production.
 */

import { createHash } from "node:crypto";
import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import type { ExecutionRecord } from "../../../src/modules/executions/domain/execution";
import type { ExecutionService } from "../../../src/modules/executions/public";
import { createExecutionService } from "../../../src/modules/executions/public";
import type {
  ComputerUseActionRequest,
  ComputerUseCapabilityDeclaration,
  ComputerUseService,
} from "../../../src/modules/tools/public";
import {
  createComputerUseService,
  createExecutionLedgerAdapter,
  createSimulatedComputerUseEnvironment,
  InMemoryComputerUseRegistry,
  InMemoryComputerUseStore,
  registerComputerUseCapability,
  type SimulatedComputerUseEnvironment,
} from "../../../src/modules/tools/public";
import { PlatformError } from "../../../src/shared/errors";
import { InMemoryExecutionStore, InMemoryExecutionsIdempotency } from "../executions/fakes";
import { FakeBudgetAuthority } from "./fakes";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Recording allow/deny policy admission fake (the seam the engine fills). */
export class FakeComputerUsePolicyAdmission {
  readonly calls: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly toolFact: string;
    readonly hosts: readonly string[];
    readonly secretRef: string | null;
  }[] = [];
  private deny = false;
  private reason = "policy says no";
  /** Deny only facts matching a predicate (host-scoped denial proofs). */
  private denyWhen: ((fact: { toolFact: string; host?: string }) => boolean) | null = null;

  denyWith(reason: string): void {
    this.deny = true;
    this.reason = reason;
  }

  denyFactsMatching(predicate: (fact: { toolFact: string; host?: string }) => boolean): void {
    this.denyWhen = predicate;
  }

  readonly impl = {
    admit: async (request: {
      readonly tenantId: string;
      readonly applicationId: string;
      readonly toolFact: string;
      readonly hosts: readonly string[];
      readonly secretRef: string | null;
    }) => {
      this.calls.push({
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        toolFact: request.toolFact,
        hosts: [...request.hosts],
        secretRef: request.secretRef,
      });
      if (this.deny) {
        return { allowed: false as const, reason: this.reason };
      }
      if (this.denyWhen !== null) {
        for (const host of request.hosts) {
          if (this.denyWhen({ toolFact: request.toolFact, host })) {
            return {
              allowed: false as const,
              reason: `policy denies host ${host}`,
            };
          }
        }
      }
      return {
        allowed: true as const,
        evidence: {
          policySetId: "set-1",
          policySetVersion: 1,
          policyContentHash: "hash-1",
          restrictionSetDigest: "digest-1",
        },
      };
    },
  };
}

/** Recording capability gate fake: satisfiable or unmet per configuration. */
export class FakeComputerUseCapabilityGate {
  readonly calls: { readonly requirementAtoms: readonly string[] }[] = [];
  private unmet: readonly string[] = [];

  failWith(unmet: readonly string[]): void {
    this.unmet = unmet;
  }

  readonly impl = {
    resolve: async (request: { readonly requirementAtoms: readonly string[] }) => {
      this.calls.push({ requirementAtoms: [...request.requirementAtoms] });
      if (this.unmet.length > 0) {
        return { satisfied: false as const, unmet: [...this.unmet], satisfactions: [] };
      }
      return {
        satisfied: true as const,
        unmet: [],
        satisfactions: ["claim-1@1.0.0:adapter-declared"],
      };
    },
  };
}

/** Recording secret mediation fake (reference-only grants). */
export class FakeComputerUseSecretMediation {
  readonly calls: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly connectionRef: string;
  }[] = [];
  private refuse = false;
  private reason = "connection disabled";

  refuseWith(reason: string): void {
    this.refuse = true;
    this.reason = reason;
  }

  readonly impl = {
    mediate: async (request: {
      readonly tenantId: string;
      readonly applicationId: string;
      readonly connectionRef: string;
    }) => {
      this.calls.push({
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        connectionRef: request.connectionRef,
      });
      if (this.refuse) {
        return { mediated: false as const, reason: this.reason };
      }
      return { mediated: true as const, grantRef: `cu-grant:${request.connectionRef}` };
    },
  };
}

/** The argv-recording terminal executor fake (no sandbox in the unit world). */
export class FakeComputerUseTerminalExecutor {
  readonly runs: {
    readonly command: string;
    readonly args: readonly string[];
    readonly idempotencyKey: string;
    readonly executionId: string;
  }[] = [];
  private failNext = false;

  failNextRun(): void {
    this.failNext = true;
  }

  readonly impl = {
    execute: async (
      dispatch: {
        readonly command: string;
        readonly args: readonly string[];
        readonly executionId: string;
        readonly timeoutMs: number;
      },
      idempotencyKey: string,
    ) => {
      this.runs.push({
        command: dispatch.command,
        args: [...dispatch.args],
        idempotencyKey,
        executionId: dispatch.executionId,
      });
      if (this.failNext) {
        this.failNext = false;
        return {
          outcome: "failed" as const,
          sandboxExecutionId: `sbx-${idempotencyKey}`,
          stdout: "",
          stderr: "boom",
          failureClass: "sandbox-execution",
          failureMessage: "the terminal run failed (injected)",
          durationMs: 3,
        };
      }
      return {
        outcome: "succeeded" as const,
        sandboxExecutionId: `sbx-${idempotencyKey}`,
        stdout: "ok",
        stderr: "",
        failureClass: null,
        failureMessage: null,
        durationMs: 3,
      };
    },
  };
}

export interface ComputerUseWorldOptions {
  /** Pass `null` to construct the service with NO budget authority wired. */
  readonly budgetAuthority?: BudgetAuthority | null;
}

export interface InMemoryComputerUseWorld {
  readonly executionService: ExecutionService;
  readonly store: InMemoryComputerUseStore;
  readonly registry: InMemoryComputerUseRegistry;
  readonly environment: SimulatedComputerUseEnvironment;
  readonly policy: FakeComputerUsePolicyAdmission;
  readonly capabilities: FakeComputerUseCapabilityGate;
  readonly secrets: FakeComputerUseSecretMediation;
  readonly budgets: FakeBudgetAuthority;
  readonly terminal: FakeComputerUseTerminalExecutor;
  readonly service: ComputerUseService;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly otherTenantId: string;
  register(declaration: ComputerUseCapabilityDeclaration): Promise<void>;
  seedExecution(status?: ExecutionRecord["status"]): Promise<string>;
  actor(): { actorId: string; tenantId: string };
  createSession(
    request: Partial<Parameters<ComputerUseService["createSession"]>[0]>,
    idempotencyKey?: string,
  ): ReturnType<ComputerUseService["createSession"]>;
  dispatch(
    sessionId: string,
    action: ComputerUseActionRequest,
    idempotencyKey?: string,
  ): ReturnType<ComputerUseService["dispatchAction"]>;
}

/** The canonical declarations the suites use (deterministic/browser/desktop). */
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

export function createInMemoryComputerUseWorld(
  options: ComputerUseWorldOptions = {},
): InMemoryComputerUseWorld {
  const executionStore = new InMemoryExecutionStore();
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
  let idCounter = 5000;
  const generateId = () => {
    idCounter += 1;
    return `00000000-0000-7000-8000-${String(idCounter).padStart(12, "0")}`;
  };
  const executionService = createExecutionService({
    store: executionStore,
    idempotency,
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  const store = new InMemoryComputerUseStore();
  const registry = new InMemoryComputerUseRegistry();
  const environment = createSimulatedComputerUseEnvironment();
  const policy = new FakeComputerUsePolicyAdmission();
  const capabilities = new FakeComputerUseCapabilityGate();
  const secrets = new FakeComputerUseSecretMediation();
  const budgets = new FakeBudgetAuthority();
  const terminal = new FakeComputerUseTerminalExecutor();

  const service = createComputerUseService({
    registry,
    policy: policy.impl,
    capabilities: capabilities.impl,
    secrets: secrets.impl,
    ...(options.budgetAuthority === null
      ? {}
      : { budgetAuthority: options.budgetAuthority ?? budgets.impl }),
    store,
    ledger: createExecutionLedgerAdapter(executionService),
    environment,
    terminal: terminal.impl,
    generateId,
    now: () => new Date(),
    digest: sha256Hex,
  });

  const applicationId = "11111111-1111-7000-8000-000000000001";
  const tenantId = "00000000-0000-7000-8000-0000000000bb";
  const otherTenantId = "00000000-0000-7000-8000-0000000000cc";
  const actorId = "00000000-0000-7000-8000-0000000000aa";
  executionStore.seedApplication(applicationId, tenantId);

  return {
    executionService,
    store,
    registry,
    environment,
    policy,
    capabilities,
    secrets,
    budgets,
    terminal,
    service,
    applicationId,
    tenantId,
    actorId,
    otherTenantId,
    async register(declaration) {
      await registerComputerUseCapability(registry, declaration);
    },
    async seedExecution(status: ExecutionRecord["status"] = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        `create-${generateId()}`,
        { actorId, tenantId },
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", actorId, applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (status !== "AUTHORIZED") {
          await executionService.transition(
            { command: "plan", actorId, applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          if (status !== "PLANNING") {
            await executionService.transition(
              { command: "queue", actorId, applicationId, tenantId, executionId },
              `queue-${generateId()}`,
            );
            if (status !== "QUEUED") {
              await executionService.transition(
                { command: "start", actorId, applicationId, tenantId, executionId },
                `start-${generateId()}`,
              );
            }
          }
        }
      }
      return executionId;
    },
    actor() {
      return { actorId, tenantId };
    },
    createSession(request, idempotencyKey = `sk-${generateId()}`) {
      const executionId = request.executionId ?? "";
      return service.createSession(
        {
          applicationId,
          executionId,
          actor: { actorId, tenantId },
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
    dispatch(sessionId, action, idempotencyKey = `ak-${generateId()}`) {
      return service.dispatchAction(applicationId, sessionId, action, idempotencyKey);
    },
  };
}

/** Assert a typed PlatformError with the expected code (the house helper). */
export function expectPlatformError(
  code: string,
  run: Promise<unknown> | (() => Promise<unknown>),
): Promise<PlatformError> {
  const promise = typeof run === "function" ? run() : run;
  return promise.then(
    () => {
      throw new Error(`expected a PlatformError with code ${code}`);
    },
    (error: unknown) => {
      if (error instanceof PlatformError) {
        if (error.code !== code) {
          throw new Error(
            `expected PlatformError code ${code}, got ${error.code}: ${error.message}`,
          );
        }
        return error;
      }
      throw error;
    },
  );
}
