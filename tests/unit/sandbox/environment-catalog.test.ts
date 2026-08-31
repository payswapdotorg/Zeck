/**
 * Unit — the environment catalog (WORK-012, ENV-001): stable per-application
 * identity, content-addressed WRITE-ONCE specifications (identical
 * re-registration converges; a different spec under the same slug is an
 * identity conflict), and the guarded lifecycle.
 */

import { describe, expect, test } from "vitest";
import { InMemorySandboxStore } from "../../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR_ID, APPLICATION_ID, TENANT_ID } from "./fakes";

const spec: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

function world() {
  const store = new InMemorySandboxStore();
  let counter = 0;
  const catalog = createEnvironmentCatalog({
    store,
    generateId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date("2026-01-01T00:00:00Z"),
    hashSpec: (canonical) => `digest:${canonical.length}`,
  });
  return { store, catalog };
}

const actor = { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID };

describe("environment catalog", () => {
  test("registers an environment with stable identity and digest", async () => {
    const { catalog } = world();
    const record = await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "key-1",
      actor,
    );
    expect(record.id).toBeTruthy();
    expect(record.slug).toBe("analysis");
    expect(record.status).toBe("available");
    expect(record.specDigest).toBeTruthy();
    expect(record.kind).toBe("process");
  });

  test("identical re-registration converges on the durable record", async () => {
    const { catalog } = world();
    const first = await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "key-1",
      actor,
    );
    const second = await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "key-2",
      actor,
    );
    expect(second.id).toBe(first.id);
  });

  test("a DIFFERENT spec under the same slug is an identity conflict (write-once)", async () => {
    const { catalog } = world();
    await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "key-1",
      actor,
    );
    const different: ComputeEnvironmentSpec = {
      ...spec,
      limits: { ...(spec.limits as typeof spec.limits & object), cpuMilliCores: 1000 },
    };
    await expect(
      catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "analysis",
          name: "Analysis",
          spec: different,
        },
        "key-2",
        actor,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
  });

  test("invalid specifications are rejected (nothing durable)", async () => {
    const { catalog } = world();
    await expect(
      catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "bad",
          name: "Bad",
          spec: { ...spec, limits: null } as ComputeEnvironmentSpec,
        },
        "key-1",
        actor,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
    expect(await catalog.list(APPLICATION_ID)).toHaveLength(0);
  });

  test("cross-scope registration is rejected (M9/M10 discipline)", async () => {
    const { catalog } = world();
    await expect(
      catalog.register(
        { applicationId: "other-app", tenantId: TENANT_ID, slug: "x", name: "X", spec },
        "key-1",
        actor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("the lifecycle is guarded: suspend/resume/retire with retired terminal", async () => {
    const { catalog } = world();
    const record = await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "key-1",
      actor,
    );
    const suspended = await catalog.suspend(APPLICATION_ID, record.id, "s-1", actor);
    expect(suspended.status).toBe("suspended");
    // idempotent convergence
    const again = await catalog.suspend(APPLICATION_ID, record.id, "s-2", actor);
    expect(again.status).toBe("suspended");
    const resumed = await catalog.resume(APPLICATION_ID, record.id, "r-1", actor);
    expect(resumed.status).toBe("available");
    const retired = await catalog.retire(APPLICATION_ID, record.id, "t-1", actor);
    expect(retired.status).toBe("retired");
    await expect(catalog.resume(APPLICATION_ID, record.id, "r-2", actor)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("a suspended environment cannot be resumed into an illegal state (transition table)", async () => {
    const { catalog } = world();
    const record = await catalog.register(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        slug: "analysis",
        name: "Analysis",
        spec,
      },
      "k",
      actor,
    );
    await catalog.retire(APPLICATION_ID, record.id, "t-1", actor);
    await expect(catalog.suspend(APPLICATION_ID, record.id, "t-2", actor)).rejects.toBeInstanceOf(
      PlatformError,
    );
  });
});
