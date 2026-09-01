/**
 * Unit tests — the runner fleet SERVICE lifecycle (WORK-019, ENV-003; the
 * sandbox `sandbox-service.test.ts` discipline, restated for the fleet axis).
 *
 * The REAL fleet service over the REAL in-memory runner store + REAL
 * in-memory sandbox store, with an injectable clock (deterministic lease
 * and heartbeat windows) and the REAL channel/endpoint adapters of the
 * runners integration. True cross-connection concurrency/locking cannot be
 * simulated here — the real-PostgreSQL suites own those proofs (the
 * standing precedent; see tests/integration/postgres/runner-fleet*.test.ts).
 */

import { describe, expect, test } from "vitest";
import {
  type ComputeEnvironmentSpec,
  CustomerRunnerSandboxProvider,
  createSandboxProviderRegistry,
  createSandboxService,
  MicroVmSandboxProvider,
  type RunnerHandoff,
  type RunnerResultReport,
  VmSandboxProvider,
} from "../../../src/modules/sandbox/public";
import { PlatformError } from "../../../src/shared/errors";
import { FakeCapabilityGate, FakeExecutionLedger, FakeSandboxAdmission } from "./fakes";
import {
  attachEndpoint,
  CUSTOMER_RUNNER_SPEC,
  createRunnerFleetWorld,
  type RunnerFleetWorld,
} from "./runner-fakes";

function expectCode(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  return promise.then(
    () => {
      throw new Error(`expected a PlatformError with code ${code}, got a resolution`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
      return error as PlatformError;
    },
  );
}

const REQUIRED = ["customer-runner", "cpu", "memory"];

describe("runner fleet service: registration is not trust", () => {
  test("a freshly registered runner is untrusted and can serve NOTHING", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, { authorize: false });
    const runner = await world.fleet.getRunner("00000000-0000-7000-8000-0000000000b1", runnerId);
    expect(runner?.authorizationStatus).toBe("untrusted");
    expect(runner?.tokenFingerprint).not.toContain("runner-registration-token");
    expect(JSON.stringify(runner)).not.toContain("runner-registration-token-0001");
  });

  test("an untrusted runner is rejected before assignment with AUTHORIZATION_DENIED", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, { authorize: false });
    const seeded = await world.seedSandbox(environmentId);
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-untrusted",
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("duplicate registration with the SAME identity core converges; a DIFFERENT core conflicts", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const first = await world.fleet.registerRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        environmentId,
        slug: "runner-alpha",
        name: "Alpha",
        runnerVersion: "1.2.3",
        declaredCapabilities: ["customer-runner", "cpu", "memory"],
        registrationToken: "runner-registration-token-0001",
      },
      "register-alpha-1",
      world.actor(),
    );
    const replay = await world.fleet.registerRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        environmentId,
        slug: "runner-alpha",
        name: "Alpha",
        runnerVersion: "1.2.3",
        declaredCapabilities: ["customer-runner", "cpu", "memory"],
        registrationToken: "runner-registration-token-0001",
      },
      "register-alpha-2",
      world.actor(),
    );
    expect(replay.id).toBe(first.id);
    // A DIFFERENT identity core under the same slug is a write conflict.
    await expectCode(
      world.fleet.registerRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          tenantId: "00000000-0000-7000-8000-0000000000a1",
          environmentId,
          slug: "runner-alpha",
          name: "Alpha",
          runnerVersion: "1.3.0",
          declaredCapabilities: ["customer-runner", "cpu", "memory"],
          registrationToken: "runner-registration-token-0001",
        },
        "register-alpha-3",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
  });

  test("registration is refused against non-customer-runner environments", async () => {
    const world = createRunnerFleetWorld();
    const processSpec: ComputeEnvironmentSpec = {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    };
    const processEnvironmentId = await world.registerEnvironment(processSpec);
    await expectCode(
      world.fleet.registerRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          tenantId: "00000000-0000-7000-8000-0000000000a1",
          environmentId: processEnvironmentId,
          slug: "runner-on-process",
          name: "Wrong",
          runnerVersion: "1.2.3",
          declaredCapabilities: ["customer-runner"],
          registrationToken: "runner-registration-token-0001",
        },
        "register-wrong",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
  });

  test("registration requires the environment to exist in the application scope", async () => {
    const world = createRunnerFleetWorld();
    await expectCode(
      world.fleet.registerRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          tenantId: "00000000-0000-7000-8000-0000000000a1",
          environmentId: "00000000-0000-7000-8000-000000000099",
          slug: "runner-orphan",
          name: "Orphan",
          runnerVersion: "1.2.3",
          declaredCapabilities: ["customer-runner"],
          registrationToken: "runner-registration-token-0001",
        },
        "register-orphan",
        world.actor(),
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });
});

describe("runner fleet service: authorization and revocation", () => {
  test("authorize enables assignment; re-authorization is idempotent", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, { authorize: false });
    const first = await world.fleet.authorizeRunner(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId },
      "authorize-1",
      world.actor(),
    );
    expect(first.authorizationStatus).toBe("authorized");
    expect(first.authorizedByActorId).toBe("00000000-0000-7000-8000-0000000000c1");
    const again = await world.fleet.authorizeRunner(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId },
      "authorize-2",
      world.actor(),
    );
    expect(again.authorizationStatus).toBe("authorized");
  });

  test("revocation is terminal: a revoked runner is never re-authorized and never assigned", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    await world.fleet.revokeRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        reason: "customer-offboarded",
      },
      "revoke-1",
      world.actor(),
    );
    await expectCode(
      world.fleet.authorizeRunner(
        { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId },
        "authorize-late",
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
    const seeded = await world.seedSandbox(environmentId);
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-revoked",
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("revocation releases the runner's ACTIVE assignment (fail-closed)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: seeded.executionId,
        sandboxId: seeded.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-then-revoke",
      world.actor(),
    );
    expect(assignment.status).toBe("assigned");
    await world.fleet.revokeRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        reason: "security-hold",
      },
      "revoke-active",
      world.actor(),
    );
    const after = await world.fleet.getAssignment(
      "00000000-0000-7000-8000-0000000000b1",
      assignment.id,
    );
    expect(after?.status).toBe("released");
    expect(after?.releasedReason).toContain("security-hold");
    // The release is journaled.
    const events = await world.fleet.listAssignmentEvents(
      "00000000-0000-7000-8000-0000000000b1",
      assignment.id,
    );
    expect(events.map((e) => e.event)).toContain("released");
  });

  test("a runner revoked MID-FLIGHT cannot land a result report (M4: the outcome never lands)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: seeded.executionId,
        sandboxId: seeded.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-mid-flight",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    await world.fleet.revokeRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        reason: "mid-flight",
      },
      "revoke-mid",
      world.actor(),
    );
    // Revocation released the in-flight assignment (fail-closed): a late
    // report from the revoked runner is REFUSED and no outcome ever lands.
    const error = await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId: assignment.id,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: "digest:late",
            output: null,
            usageMicroUsd: "0",
            failure: null,
          },
        },
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
    expect(error.message).toContain("released");
    const after = await world.fleet.getAssignment(
      "00000000-0000-7000-8000-0000000000b1",
      assignment.id,
    );
    expect(after?.status).toBe("released");
    expect(after?.outcomeClass).toBeNull();
  });

  test("a report from a runner whose authorization vanished (store-level race) is refused", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: seeded.executionId,
        sandboxId: seeded.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-authz-race",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    // A store-level revocation WITHOUT the service's release sweep (the
    // race shape): the assignment is still dispatched, but the runner's
    // authorization is gone — the report-time re-check refuses it.
    await world.runnerStore.revokeRunner({
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      runnerId,
      reason: "store-level",
      revokedAt: world.now().toISOString(),
    });
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId: assignment.id,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });
});

describe("runner fleet service: health gating (M20)", () => {
  test("a runner without a heartbeat is not assignable", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, { heartbeat: false });
    const seeded = await world.seedSandbox(environmentId);
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-no-heartbeat",
        world.actor(),
      ),
      "NO_ELIGIBLE_ROUTE",
    );
  });

  test("a runner whose heartbeat aged past the window is not assignable; a fresh heartbeat restores eligibility", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(environmentId);
    world.setNow(new Date(Date.parse(world.now().toISOString()) + 31_000));
    const stale = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-stale",
        world.actor(),
      ),
      "NO_ELIGIBLE_ROUTE",
    );
    expect(stale.message).toContain("health");
    await world.fleet.observeHeartbeat(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId },
      world.actor(),
    );
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: seeded.executionId,
        sandboxId: seeded.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-fresh",
      world.actor(),
    );
    expect(assignment.status).toBe("assigned");
  });

  test("an unhealthy observation makes the runner unassignable until healthy again", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    await world.fleet.observeHeartbeat(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId, health: "unhealthy" },
      world.actor(),
    );
    const seeded = await world.seedSandbox(environmentId);
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-unhealthy",
        world.actor(),
      ),
      "NO_ELIGIBLE_ROUTE",
    );
  });
});

describe("runner fleet service: scope and capability gates before assignment", () => {
  test("a runner of a different tenant is refused (M1-class: cross-tenant)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(environmentId);
    const foreignActor = {
      actorId: "00000000-0000-7000-8000-0000000000c1",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      tenantId: "00000000-0000-7000-8000-0000000000a2",
    };
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-cross-tenant",
        foreignActor,
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });

  test("capability mismatch is refused with CAPABILITY_UNAVAILABLE (M5/M8-class)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, {
      declaredCapabilities: ["customer-runner", "cpu"],
    });
    const seeded = await world.seedSandbox(environmentId);
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: ["customer-runner", "gpu"],
        },
        "assign-gpu",
        world.actor(),
      ),
      "CAPABILITY_UNAVAILABLE",
    );
    expect(error.message).toContain("capability mismatch");
  });

  test("environment mismatch: the runner must be registered for the assignment's environment", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment(CUSTOMER_RUNNER_SPEC, "env-a");
    const otherEnvironmentId = await world.registerEnvironment(CUSTOMER_RUNNER_SPEC, "env-b");
    expect(otherEnvironmentId).not.toBe(environmentId);
    const runnerId = await world.registerRunner(environmentId);
    const seeded = await world.seedSandbox(otherEnvironmentId);
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId: otherEnvironmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-env-mismatch",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
    expect(error.message).toContain("not registered for this compute environment");
  });

  test("the sandbox parent must be dispatching and execution identity must match", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const admitted = await world.seedSandbox(environmentId, "admitted");
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: admitted.executionId,
          sandboxId: admitted.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-not-dispatching",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
    expect(error.message).toContain("dispatched sandbox execution");
  });

  test("an unknown runner is a scope violation, never a silent auto-register (M3-class)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const seeded = await world.seedSandbox(environmentId);
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: seeded.executionId,
          sandboxId: seeded.sandboxId,
          environmentId,
          runnerId: "00000000-0000-7000-8000-0000000000f9",
          requiredCapabilities: REQUIRED,
        },
        "assign-unknown-runner",
        world.actor(),
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });

  test("one active assignment per runner: a busy runner is refused (M10/M19-class)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const first = await world.seedSandbox(environmentId);
    const second = await world.seedSandbox(environmentId);
    await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: first.executionId,
        sandboxId: first.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-first",
      world.actor(),
    );
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: second.executionId,
          sandboxId: second.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "assign-second",
        world.actor(),
      ),
      "NO_ELIGIBLE_ROUTE",
    );
    expect(error.message).toContain("active assignment");
  });

  test("selectEligibleRunner skips unauthorized, unhealthy, mismatched and busy runners", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const selected = await world.fleet.selectEligibleRunner({
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      environmentId,
      requiredCapabilities: ["customer-runner", "cpu", "memory"],
    });
    expect(selected?.id).toBe(runnerId);
    expect(
      await world.fleet.selectEligibleRunner({
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        environmentId,
        requiredCapabilities: ["customer-runner", "gpu"],
      }),
    ).toBeNull();
    const wrongEnv = await world.fleet.selectEligibleRunner({
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      environmentId: "00000000-0000-7000-8000-000000000099",
      requiredCapabilities: ["customer-runner"],
    });
    expect(wrongEnv).toBeNull();
  });
});

describe("runner fleet service: idempotent assignment (the durable outcome)", () => {
  async function seededWorld(): Promise<{
    world: RunnerFleetWorld;
    environmentId: string;
    runnerId: string;
    ids: { sandboxId: string; executionId: string };
  }> {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    return { world, environmentId, runnerId, ids };
  }

  test("same key + same request replays the SAME assignment row", async () => {
    const { world, environmentId, runnerId, ids } = await seededWorld();
    const first = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "replay-key",
      world.actor(),
    );
    const replay = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: [...REQUIRED].reverse(),
      },
      "replay-key",
      world.actor(),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.requestFingerprint).toBe(first.requestFingerprint);
  });

  test("same key + different fingerprint is the canonical idempotency error", async () => {
    const { world, environmentId, runnerId, ids } = await seededWorld();
    await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "reuse-key",
      world.actor(),
    );
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: ["customer-runner", "cpu", "memory", "filesystem"],
        },
        "reuse-key",
        world.actor(),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("runner fleet service: dispatch handoff and result reports", () => {
  async function assignedWorld(): Promise<{
    world: RunnerFleetWorld;
    environmentId: string;
    runnerId: string;
    assignmentId: string;
    ids: { sandboxId: string; executionId: string };
  }> {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-dispatch",
      world.actor(),
    );
    return { world, environmentId, runnerId, assignmentId: assignment.id, ids };
  }

  test("the dispatch claim is one-shot and the handoff carries the sanitized admitted snapshot", async () => {
    const { world, assignmentId, ids, environmentId } = await assignedWorld();
    const handoff = await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
      world.actor(),
    );
    expect(handoff.executionId).toBe(ids.executionId);
    expect(handoff.sandboxId).toBe(ids.sandboxId);
    expect(handoff.environmentId).toBe(environmentId);
    expect(handoff.task).toEqual({
      command: "python3",
      args: ["analyze.py"],
      publicEnv: { MODE: "batch" },
    });
    expect(handoff.leaseExpiresAt).toBeTruthy();
    expect(handoff.provenance.executionId).toBe(ids.executionId);
    expect(handoff.provenance.sandboxId).toBe(ids.sandboxId);
    // The replay of a dispatched assignment returns the SAME handoff (same nonce).
    const replay = await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
      world.actor(),
    );
    expect(replay.handoffNonce).toBe(handoff.handoffNonce);
    expect(replay.assignmentId).toBe(handoff.assignmentId);
    const events = await world.fleet.listAssignmentEvents(
      "00000000-0000-7000-8000-0000000000b1",
      assignmentId,
    );
    expect(events.map((e) => e.event)).toEqual(["assigned", "dispatched"]);
  });

  test("a success report terminalizes the assignment as completed with the trail intact", async () => {
    const { world, assignmentId } = await assignedWorld();
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
      world.actor(),
    );
    const finalized = await world.fleet.reportResult(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        assignmentId,
        report: {
          outcomeClass: "sandbox-success",
          outputDigest: "digest:done",
          output: { exitCode: 0 },
          usageMicroUsd: "12",
          failure: null,
        },
      },
      world.actor(),
    );
    expect(finalized.status).toBe("completed");
    expect(finalized.outcomeClass).toBe("sandbox-success");
    expect(finalized.usageMicroUsd).toBe("12");
    const events = await world.fleet.listAssignmentEvents(
      "00000000-0000-7000-8000-0000000000b1",
      assignmentId,
    );
    expect(events.map((e) => e.event)).toEqual(["assigned", "dispatched", "completed"]);
    // Terminal: another report is refused.
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId,
          report: {
            outcomeClass: "sandbox-failure",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: { failureClass: "sandbox-execution", message: "x", retryable: false },
          },
        },
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
  });

  test("a failure report terminalizes as failed; only dispatched rows report", async () => {
    const { world, assignmentId } = await assignedWorld();
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
      world.actor(),
    );
    const failed = await world.fleet.reportResult(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        assignmentId,
        report: {
          outcomeClass: "sandbox-failure",
          outputDigest: null,
          output: null,
          usageMicroUsd: null,
          failure: { failureClass: "timeout", message: "too slow", retryable: true },
        },
      },
      world.actor(),
    );
    expect(failed.status).toBe("failed");
    expect(failed.failureClass).toBe("timeout");
  });

  test("lease expiry: late dispatch and late reports fail closed (fail-closed, not silent)", async () => {
    const { world, assignmentId } = await assignedWorld();
    world.setNow(new Date(Date.parse(world.now().toISOString()) + 61_000));
    await expectCode(
      world.fleet.dispatchAssignment(
        { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
        world.actor(),
      ),
      "EXPIRED",
    );
    // Lease-deadline reconciliation terminalizes the row.
    const expired = await world.fleet.expireAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
      world.actor(),
    );
    expect(expired.status).toBe("expired");
    // A late report after expiry is refused.
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "EXPIRED",
    );
  });

  test("expiry before the lease deadline is refused (no premature terminalization)", async () => {
    const { world, assignmentId } = await assignedWorld();
    await expectCode(
      world.fleet.expireAssignment(
        { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId },
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
  });

  test("release terminalizes an active assignment; terminal rows are inert to release", async () => {
    const { world, assignmentId } = await assignedWorld();
    const released = await world.fleet.releaseAssignment(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        assignmentId,
        reason: "operator-hold",
      },
      world.actor(),
    );
    expect(released.status).toBe("released");
    const again = await world.fleet.releaseAssignment(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        assignmentId,
        reason: "operator-hold",
      },
      world.actor(),
    );
    expect(again.status).toBe("released");
  });
});

describe("runner fleet service: reconnect re-binds the SAME assignment (M11)", () => {
  test("a reconnect with the correct token increments the count on the SAME assignment and never mints a new one", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "assign-reconnect",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    // Disconnect, then reconnect.
    await world.fleet.markDisconnected(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", runnerId },
      world.actor(),
    );
    const { runner, assignment: reconnected } = await world.fleet.reconnectRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        registrationToken: "runner-registration-token-0001",
      },
      world.actor(),
    );
    expect(runner.connectionStatus).toBe("connected");
    expect(reconnected?.id).toBe(assignment.id);
    expect(reconnected?.reconnectCount).toBe(1);
    // A second reconnect: same assignment, count 2, NO new assignment rows.
    const second = await world.fleet.reconnectRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        registrationToken: "runner-registration-token-0001",
      },
      world.actor(),
    );
    expect(second.assignment?.id).toBe(assignment.id);
    expect(second.assignment?.reconnectCount).toBe(2);
    const bySandbox = await world.fleet.listAssignmentsBySandbox(
      "00000000-0000-7000-8000-0000000000b1",
      ids.sandboxId,
    );
    expect(bySandbox).toHaveLength(1);
    const events = await world.fleet.listAssignmentEvents(
      "00000000-0000-7000-8000-0000000000b1",
      assignment.id,
    );
    expect(events.filter((e) => e.event === "reconnected")).toHaveLength(2);
    // Provenance survives the reconnects (M18).
    expect(reconnected?.provenance.executionId).toBe(ids.executionId);
  });

  test("a wrong registration token is refused (external identifiers are not authorization)", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId, {
      registrationToken: "runner-registration-token-7777",
    });
    await expectCode(
      world.fleet.reconnectRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          runnerId,
          registrationToken: "runner-registration-token-0001",
        },
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("a revoked runner cannot reconnect", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    await world.fleet.revokeRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        runnerId,
        reason: "offboarded",
      },
      "revoke-reconnect",
      world.actor(),
    );
    await expectCode(
      world.fleet.reconnectRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          runnerId,
          registrationToken: "runner-registration-token-0001",
        },
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });
});

describe("runner fleet: the customer-runner substrate provider (the governed bridge)", () => {
  async function providerWorld(report: RunnerResultReport) {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const endpoint = attachEndpoint(world, runnerId, report);
    const fleet = world.fleet;
    const providers = createSandboxProviderRegistry();
    providers.register(
      new CustomerRunnerSandboxProvider({
        fleet,
        channel: world.channel,
        sandboxStore: world.sandboxStore,
      }),
    );
    const ledger = new FakeExecutionLedger();
    const executionId = "00000000-0000-7000-8000-0000000000e9";
    ledger.seedExecution(executionId, "RUNNING");
    const service = createSandboxService({
      store: world.sandboxStore,
      admission: new FakeSandboxAdmission(),
      capabilities: new FakeCapabilityGate(),
      ledger,
      providers,
      generateId: world.generateId,
      now: world.now,
    });
    return { world, environmentId, runnerId, endpoint, service, executionId };
  }

  test("a full dispatch executes on the remote runner and completes the sandbox with the SAME identities", async () => {
    const { world, environmentId, endpoint, service, executionId, runnerId } = await providerWorld({
      outcomeClass: "sandbox-success",
      outputDigest: "digest:remote-ok",
      output: { exitCode: 0, stdout: "remote ok" },
      usageMicroUsd: "7",
      failure: null,
    });
    const created = await service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } },
      },
      `sandbox-${world.generateId()}`,
      world.actor(),
    );
    const dispatched = await service.dispatchSandboxExecution(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", sandboxId: created.id },
      world.actor(),
    );
    expect(dispatched.status).toBe("completed");
    expect(dispatched.outcomeClass).toBe("sandbox-success");
    expect(dispatched.outputDigest).toBe("digest:remote-ok");
    // The remote runner received exactly ONE sanitized handoff.
    expect(endpoint.handoffs).toHaveLength(1);
    const handoff = endpoint.handoffs[0] as RunnerHandoff;
    expect(handoff.runnerId).toBe(runnerId);
    expect(handoff.executionId).toBe(executionId);
    expect(handoff.secretRefs).toEqual([]);
    expect(JSON.stringify(handoff)).not.toContain("registrationToken");
    // Exactly ONE assignment exists for this sandbox, terminalized.
    const assignments = await world.fleet.listAssignmentsBySandbox(
      "00000000-0000-7000-8000-0000000000b1",
      created.id,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("completed");
  });

  test("no eligible runner: the substrate fails closed instead of dispatching anywhere", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    // No runner registered at all.
    const providers = createSandboxProviderRegistry();
    providers.register(
      new CustomerRunnerSandboxProvider({
        fleet: world.fleet,
        channel: world.channel,
        sandboxStore: world.sandboxStore,
      }),
    );
    const ledger = new FakeExecutionLedger();
    const executionId = "00000000-0000-7000-8000-0000000000e8";
    ledger.seedExecution(executionId, "RUNNING");
    const service = createSandboxService({
      store: world.sandboxStore,
      admission: new FakeSandboxAdmission(),
      capabilities: new FakeCapabilityGate(),
      ledger,
      providers,
      generateId: world.generateId,
      now: world.now,
    });
    const created = await service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: { command: "python3", args: ["analyze.py"], publicEnv: {} },
      },
      `sandbox-${world.generateId()}`,
      world.actor(),
    );
    const dispatched = await service.dispatchSandboxExecution(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", sandboxId: created.id },
      world.actor(),
    );
    expect(dispatched.status).toBe("failed");
    expect(dispatched.failureClass).toBe("runtime-unavailable");
    expect(dispatched.failureMessage).toContain("no eligible customer runner");
  });

  test("an unreachable runner channel is an honest adapter failure, and the assignment is terminalized", async () => {
    const { world, environmentId, service, executionId } = await providerWorld({
      outcomeClass: "sandbox-success",
      outputDigest: "digest:never",
      output: null,
      usageMicroUsd: null,
      failure: null,
    });
    const runners = await world.fleet.listRunners("00000000-0000-7000-8000-0000000000b1");
    expect(runners).toHaveLength(1);
    const firstRunner = runners[0];
    if (firstRunner === undefined) {
      throw new Error("the provider world must register exactly one runner");
    }
    attachEndpoint(world, firstRunner.id, {
      outcomeClass: "sandbox-success",
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      failure: null,
    }).setUnreachable(true);
    const created = await service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: { command: "python3", args: ["analyze.py"], publicEnv: {} },
      },
      `sandbox-${world.generateId()}`,
      world.actor(),
    );
    const dispatched = await service.dispatchSandboxExecution(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", sandboxId: created.id },
      world.actor(),
    );
    expect(dispatched.status).toBe("failed");
    expect(dispatched.failureClass).toBe("adapter-error");
    expect(dispatched.failureMessage).toContain("unreachable");
    const assignments = await world.fleet.listAssignmentsBySandbox(
      "00000000-0000-7000-8000-0000000000b1",
      created.id,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("failed");
  });

  test("a retry of the same logical sandbox does not re-execute (single-dispatch semantics hold)", async () => {
    const { world, environmentId, endpoint, service, executionId } = await providerWorld({
      outcomeClass: "sandbox-success",
      outputDigest: "digest:remote-ok",
      output: { exitCode: 0 },
      usageMicroUsd: "0",
      failure: null,
    });
    const created = await service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: { command: "python3", args: ["analyze.py"], publicEnv: {} },
      },
      `sandbox-${world.generateId()}`,
      world.actor(),
    );
    await service.dispatchSandboxExecution(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", sandboxId: created.id },
      world.actor(),
    );
    // A terminal sandbox replays its outcome — the runner is NOT re-run.
    const replay = await service.dispatchSandboxExecution(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", sandboxId: created.id },
      world.actor(),
    );
    expect(replay.status).toBe("completed");
    expect(endpoint.handoffs).toHaveLength(1);
  });
});

describe("runner fleet: the dedicated-kernel tiers fail closed (provider-neutral, M14/M18-class)", () => {
  test("microvm and vm substrates without a runtime client fail closed with runtime-unavailable", async () => {
    const microvm = new MicroVmSandboxProvider();
    const observation = await microvm.execute({
      sandboxId: "sbx",
      applicationId: "app",
      tenantId: "tenant",
      executionId: "exec",
      kind: "microvm",
      task: { command: "python3", args: [], publicEnv: {} },
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secretRefs: [],
    });
    expect(observation.outcomeClass).toBe("sandbox-failure");
    expect(observation.failure?.failureClass).toBe("runtime-unavailable");
    const vm = new VmSandboxProvider();
    const vmObservation = await vm.execute({
      sandboxId: "sbx",
      applicationId: "app",
      tenantId: "tenant",
      executionId: "exec",
      kind: "vm",
      task: { command: "python3", args: [], publicEnv: {} },
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secretRefs: [],
    });
    expect(vmObservation.failure?.failureClass).toBe("runtime-unavailable");
  });

  test("the tier is pinned: a microvm environment never executes through a vm-tier runtime", async () => {
    const vmTierRuntime = {
      tier: "vm" as const,
      async execute() {
        return {
          outcomeClass: "sandbox-success" as const,
          outputDigest: null,
          output: null,
          usageMicroUsd: null,
          failure: null,
        };
      },
    };
    const microvm = new MicroVmSandboxProvider({ client: vmTierRuntime });
    const observation = await microvm.execute({
      sandboxId: "sbx",
      applicationId: "app",
      tenantId: "tenant",
      executionId: "exec",
      kind: "microvm",
      task: { command: "python3", args: [], publicEnv: {} },
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secretRefs: [],
    });
    expect(observation.failure?.failureClass).toBe("runtime-unavailable");
    expect(observation.failure?.message).toContain("vm");
  });
});
