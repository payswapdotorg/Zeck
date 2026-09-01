/**
 * Runner fleet unit-test fakes (WORK-019 — the sandbox `fakes.ts`
 * discipline, restated for the fleet axis).
 *
 * `RunnerFleetWorld`: an in-memory composition of the runner fleet — the
 * REAL fleet service over the REAL in-memory runner store + the REAL
 * in-memory sandbox store, with an injectable clock (deterministic lease
 * and heartbeat-window tests) and a scriptable runner channel (the
 * integration's in-memory endpoint behind the REAL channel adapter).
 *
 * True cross-connection concurrency/locking cannot be simulated here —
 * the real-PostgreSQL suites own those proofs (the standing precedent).
 */

import {
  CustomerRunnerChannel,
  InMemoryCustomerRunnerEndpoint,
} from "../../../src/integrations/runners/public";
import {
  type ComputeEnvironmentSpec,
  createEnvironmentCatalog,
  createRunnerFleetService,
  InMemoryRunnerStore,
  InMemorySandboxStore,
  type RunnerFleetService,
  type RunnerResultReport,
} from "../../../src/modules/sandbox/public";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000b1";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000a1";
export const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000a2";
export const OTHER_APPLICATION_ID = "00000000-0000-7000-8000-0000000000b2";
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";
export const REGISTRATION_TOKEN = "runner-registration-token-0001";

export const CUSTOMER_RUNNER_SPEC: ComputeEnvironmentSpec = {
  kind: "customer-runner",
  limits: { cpuMilliCores: 1000, memoryMiB: 512, executionTimeoutMs: 60_000 },
  network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "customer-runner-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

export const SUCCESS_REPORT: RunnerResultReport = {
  outcomeClass: "sandbox-success",
  outputDigest: "digest:runner-done",
  output: { exitCode: 0, stdout: "runner ok" },
  usageMicroUsd: "0",
  failure: null,
};

export const FAILURE_REPORT: RunnerResultReport = {
  outcomeClass: "sandbox-failure",
  outputDigest: null,
  output: null,
  usageMicroUsd: null,
  failure: { failureClass: "sandbox-execution", message: "exit code 1", retryable: false },
};

export interface RunnerFleetWorld {
  readonly fleet: RunnerFleetService;
  readonly runnerStore: InMemoryRunnerStore;
  readonly sandboxStore: InMemorySandboxStore;
  readonly channel: CustomerRunnerChannel;
  readonly generateId: () => string;
  now(): Date;
  setNow(next: Date): void;
  registerEnvironment(spec?: ComputeEnvironmentSpec, slug?: string): Promise<string>;
  seedSandbox(
    environmentId: string,
    status?: string,
  ): Promise<{ sandboxId: string; executionId: string }>;
  registerRunner(environmentId: string, options?: RunnerRegistrationOptions): Promise<string>;
  actor(): { actorId: string; applicationId: string; tenantId: string };
}

export interface RunnerRegistrationOptions {
  readonly slug?: string;
  readonly declaredCapabilities?: readonly string[];
  readonly registrationToken?: string;
  readonly authorize?: boolean;
  readonly heartbeat?: boolean;
}

export function createRunnerFleetWorld(
  options: { readonly heartbeatWindowMs?: number; readonly leaseDurationMs?: number } = {},
): RunnerFleetWorld {
  const generateId = createUuidv7Generator();
  let clock = new Date("2026-09-01T12:00:00.000Z");
  const now = () => clock;
  const runnerStore = new InMemoryRunnerStore();
  const sandboxStore = new InMemorySandboxStore();
  const sha256 = (value: string): string => {
    // A stable non-cryptographic stand-in is enough for unit determinism;
    // the real PG suites hash with node:crypto over the real SQL store.
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return `fphash-${hash.toString(16).padStart(8, "0")}`;
  };
  const fleet = createRunnerFleetService({
    store: runnerStore,
    sandboxStore,
    generateId,
    now,
    heartbeatWindowMs: options.heartbeatWindowMs ?? 30_000,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    hashToken: sha256,
  });
  const channel = new CustomerRunnerChannel();
  const catalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now,
    hashSpec: (canonical) => `spechash-${canonical.length}`,
  });
  const actor = () => ({ actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID });

  const world: RunnerFleetWorld = {
    fleet,
    runnerStore,
    sandboxStore,
    channel,
    generateId,
    now,
    setNow(next) {
      clock = next;
    },
    async registerEnvironment(spec = CUSTOMER_RUNNER_SPEC, slug = "runner-env") {
      const record = await catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug,
          name: slug,
          spec,
        },
        `env-${generateId()}`,
        actor(),
      );
      return record.id;
    },
    async seedSandbox(environmentId, status = "dispatching") {
      const executionId = generateId();
      const sandboxId = generateId();
      const claim = await sandboxStore.insertSandbox({
        id: sandboxId,
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        executionId,
        sandboxKey: `sandbox-${sandboxId}`,
        requestFingerprint: `fp-${sandboxId}`,
        environmentId,
        kind: "customer-runner",
        status: status === "dispatching" ? "admitted" : (status as "admitted"),
        runtimeMetadata: {
          kind: "customer-runner",
          environmentId,
          environmentDigest: "digest-1",
          task: { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } },
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
        createdAt: now().toISOString(),
      });
      if (status === "dispatching" && claim.claimed) {
        await sandboxStore.claimDispatching(APPLICATION_ID, `sandbox-${sandboxId}`);
      }
      return { sandboxId, executionId };
    },
    async registerRunner(environmentId, registrationOptions = {}) {
      const runner = await fleet.registerRunner(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
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
          { applicationId: APPLICATION_ID, runnerId: runner.id },
          `authorize-${generateId()}`,
          actor(),
        );
      }
      if (registrationOptions.heartbeat !== false) {
        await fleet.observeHeartbeat(
          { applicationId: APPLICATION_ID, runnerId: runner.id },
          actor(),
        );
      }
      return runner.id;
    },
    actor,
  };
  return world;
}

/** Wire a simulated external runner endpoint behind the real channel. */
export function attachEndpoint(
  world: RunnerFleetWorld,
  runnerId: string,
  observation: RunnerResultReport = SUCCESS_REPORT,
): InMemoryCustomerRunnerEndpoint {
  const endpoint = new InMemoryCustomerRunnerEndpoint({
    endpointRef: `endpoint-${runnerId.slice(-6)}`,
    observation,
  });
  world.channel.attachEndpoint(runnerId, endpoint);
  return endpoint;
}
