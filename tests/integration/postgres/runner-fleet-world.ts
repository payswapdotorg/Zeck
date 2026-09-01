/**
 * Shared real-PostgreSQL fixture for the runner-fleet suites (WORK-019).
 *
 * Seeds a tenant + application and wires the governed runner-fleet fabric
 * over the provider-neutral DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service with the REAL policy authority behind the
 *     authorize seam (the composite FK target of migration 0015 — runner
 *     assignments anchor REAL execution identities);
 *   * policies: the REAL authority (in-memory definitions + node hasher),
 *     a baseline permissive set published (deny-by-default otherwise);
 *   * sandbox: SqlSandboxStore + the environment catalog (the
 *     customer-runner environments runners register against) — the
 *     admitted-parent sandbox rows assignments anchor;
 *   * runners: SqlRunnerStore + the runner fleet service with the REAL
 *     sha256 token fingerprinting (node:crypto) and a generous heartbeat
 *     window/lease by default (tests shrink them explicitly).
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
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
import { SqlRunnerStore } from "../../../src/modules/sandbox/adapters/sql-runner-store";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import type { EnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import {
  createRunnerFleetService,
  type RunnerFleetService,
} from "../../../src/modules/sandbox/application/runner-fleet";
import {
  createSandboxService,
  type SandboxService,
} from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import type { SandboxProvider } from "../../../src/modules/sandbox/ports/sandbox-provider";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000d1";

export const CUSTOMER_RUNNER_SPEC: ComputeEnvironmentSpec = {
  kind: "customer-runner",
  limits: { cpuMilliCores: 1000, memoryMiB: 512, executionTimeoutMs: 60_000 },
  network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "customer-runner-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

export const BASELINE_TASK = {
  command: "python3",
  args: ["analyze.py", "--mode", "batch"],
  publicEnv: { MODE: "batch" },
};

export const REGISTRATION_TOKEN = "runner-registration-token-0001";

export interface RunnerFleetPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly policyAuthority: PolicyAuthority;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly catalog: EnvironmentCatalog;
  readonly sandboxStore: SqlSandboxStore;
  readonly runnerStore: SqlRunnerStore;
  readonly fleet: RunnerFleetService;
  readonly hashToken: (token: string) => string;
  registerEnvironment(slug?: string, spec?: ComputeEnvironmentSpec): Promise<string>;
  seedExecution(): Promise<string>;
  seedSandbox(
    environmentId: string,
    executionId?: string,
  ): Promise<{
    sandboxId: string;
    executionId: string;
  }>;
  registerRunner(
    environmentId: string,
    options?: {
      slug?: string;
      declaredCapabilities?: readonly string[];
      registrationToken?: string;
      authorize?: boolean;
      heartbeat?: boolean;
    },
  ): Promise<string>;
  /** Compose the FULL governed sandbox service over the real SQL fabric. */
  buildSandboxService(providers: readonly SandboxProvider[]): SandboxService;
  actor(): { actorId: string; applicationId: string; tenantId: string };
}

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export async function seedRunnerFleetWorld(
  db: DatabasePort,
  options: { readonly heartbeatWindowMs?: number; readonly leaseDurationMs?: number } = {},
): Promise<RunnerFleetPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "runner fleet tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "runner fleet app"],
  });

  // Policies: the REAL authority (baseline permissive set).
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric (the FK target of runner assignments).
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Sandbox: the SQL store + catalog.
  const sandboxStore = new SqlSandboxStore(db);
  const catalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now: () => new Date(),
    hashSpec: sha256Hex,
  });

  // Capabilities: the REAL registry with platform seeds + a
  // customer-runner runtime claim (the composition wiring a runner fleet
  // provides).
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS],
  });
  await capabilityRegistry.publish({
    claim: {
      id: "customer-runner-runtime",
      kind: "runtime",
      version: "1.0.0",
      attributes: { isolation: "customer-runner", networkEgress: true },
    },
    provenance: { publisher: "runners:world", publishedAt: new Date().toISOString() },
    evidence: { kind: "catalog-seeded", reference: "runner-fleet-world-customer-runner-runtime" },
  });

  // Runners: the SQL store + the fleet service (REAL token fingerprinting).
  const runnerStore = new SqlRunnerStore(db);
  const fleet = createRunnerFleetService({
    store: runnerStore,
    sandboxStore,
    generateId,
    now: () => new Date(),
    heartbeatWindowMs: options.heartbeatWindowMs ?? 30_000,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    hashToken: sha256Hex,
  });

  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });

  const world: RunnerFleetPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    policyAuthority: authority,
    capabilityRegistry,
    catalog,
    sandboxStore,
    runnerStore,
    fleet,
    hashToken: sha256Hex,
    async registerEnvironment(slug = "runner-env", spec = CUSTOMER_RUNNER_SPEC) {
      const record = await catalog.register(
        { applicationId, tenantId, slug, name: slug, spec },
        `env-${generateId()}`,
        actor(),
      );
      return record.id;
    },
    async seedExecution() {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "run-program", input: "artifact-1" } },
        `create-${generateId()}`,
        { actorId: ACTOR_ID, tenantId },
      );
      return receipt.executionId;
    },
    async seedSandbox(environmentId, executionId) {
      const parentExecutionId = executionId ?? (await world.seedExecution());
      const sandboxId = generateId();
      const sandboxKey = `sandbox-${sandboxId}`;
      const claim = await sandboxStore.insertSandbox({
        id: sandboxId,
        applicationId,
        tenantId,
        executionId: parentExecutionId,
        sandboxKey,
        requestFingerprint: `fp-${sandboxId}`,
        environmentId,
        kind: "customer-runner",
        status: "admitted",
        runtimeMetadata: {
          kind: "customer-runner",
          environmentId,
          environmentDigest: "digest-1",
          task: BASELINE_TASK,
          limits: CUSTOMER_RUNNER_SPEC.limits,
          network: CUSTOMER_RUNNER_SPEC.network,
          filesystem: CUSTOMER_RUNNER_SPEC.filesystem,
          secretRefs: [],
          runtime: CUSTOMER_RUNNER_SPEC.runtime,
          policyEvidence: null,
          capabilitySatisfaction: null,
          budgetOperationId: null,
        },
        denialClass: null,
        denialCode: null,
        denialReason: null,
        budgetOperationId: null,
        createdAt: new Date().toISOString(),
      });
      expect(claim.claimed).toBe(true);
      await sandboxStore.claimDispatching(applicationId, sandboxKey);
      return { sandboxId, executionId: parentExecutionId };
    },
    async registerRunner(environmentId, registrationOptions = {}) {
      const runner = await fleet.registerRunner(
        {
          applicationId,
          tenantId,
          environmentId,
          slug: registrationOptions.slug ?? `runner-${generateId().slice(-6)}`,
          name: "Customer runner",
          runnerVersion: "1.2.3",
          declaredCapabilities: registrationOptions.declaredCapabilities ?? [
            "customer-runner",
            "cpu",
            "memory",
            "filesystem",
            "network",
          ],
          registrationToken: registrationOptions.registrationToken ?? REGISTRATION_TOKEN,
        },
        `register-${generateId()}`,
        actor(),
      );
      if (registrationOptions.authorize !== false) {
        await fleet.authorizeRunner(
          { applicationId, runnerId: runner.id },
          `authorize-${generateId()}`,
          actor(),
        );
      }
      if (registrationOptions.heartbeat !== false) {
        await fleet.observeHeartbeat({ applicationId, runnerId: runner.id }, actor());
      }
      return runner.id;
    },
    buildSandboxService(providers) {
      const registry = createSandboxProviderRegistry();
      for (const provider of providers) {
        registry.register(provider);
      }
      return createSandboxService({
        store: sandboxStore,
        admission: createPolicySandboxAdmission(authority),
        capabilities: createSandboxCapabilityGate(capabilityRegistry),
        ledger: createSandboxExecutionLedgerAdapter(executionService),
        providers: registry,
        generateId,
        now: () => new Date(),
      });
    },
    actor,
  };
  return world;
}
