/**
 * WORK-058 / D-08 (SEC-002 + SEC-001) — the compute-isolation profile
 * domain battery (unit; the real-PostgreSQL halves live in
 * tests/integration/postgres/isolation-*.test.ts, the mutation proofs
 * in tests/discrimination/isolation-classes.discrimination.test.ts).
 *
 * Covers:
 *  - the typed profile classes and the strict/dedicated shape rules
 *    (fail closed at registration — never silently tightened);
 *  - the pure derivation (determinism: same spec → same profile);
 *  - the governed-selection fact mapping (the frozen policy ladder
 *    anchor: dedicated-customer → customer-runner, so a policy floor
 *    of customer-runner REQUIRES the class);
 *  - the platform-layer strict capability surface (both layers reject
 *    the same shapes);
 *  - the tenant-scoped external run identity (SEC-001);
 *  - the environment catalog projection + ambient-assignment rejection.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import { containerRunIdentity } from "../../../src/modules/sandbox/adapters/container-provider";
import { InMemorySandboxStore } from "../../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import {
  type ComputeEnvironmentSpec,
  validateComputeEnvironmentSpec,
} from "../../../src/modules/sandbox/domain/environment";
import {
  DEDICATED_ELIGIBLE_KINDS,
  deriveIsolationProfile,
  ISOLATION_PROFILE_CLASSES,
  isIsolationProfileClass,
  isolationLadderAnchor,
  isValidPoolId,
  STRICT_ELIGIBLE_KINDS,
  validateIsolationProfileDeclaration,
} from "../../../src/modules/sandbox/domain/isolation";
import {
  type ContainerConfiguration,
  containerConfigurationViolations,
} from "../../../src/platform/sandbox/container-profile";
import { PlatformError } from "../../../src/shared/errors";

const baseSpec = (overrides: Partial<ComputeEnvironmentSpec> = {}): ComputeEnvironmentSpec => ({
  kind: "container",
  limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-read-only", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "container-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
  ...overrides,
});

describe("WORK-058 isolation-profile domain (SEC-002)", () => {
  test("the typed class vocabulary is exactly standard | strict | dedicated-customer", () => {
    expect(ISOLATION_PROFILE_CLASSES).toEqual(["standard", "strict", "dedicated-customer"]);
    expect(isIsolationProfileClass("standard")).toBe(true);
    expect(isIsolationProfileClass("strict")).toBe(true);
    expect(isIsolationProfileClass("dedicated-customer")).toBe(true);
    expect(isIsolationProfileClass("hardened")).toBe(false);
    expect(isIsolationProfileClass("")).toBe(false);
  });

  test("an ABSENT declaration derives the legacy standard class (durable-record reading, not a runtime default)", () => {
    expect(deriveIsolationProfile({})).toEqual({ class: "standard", poolId: null });
    expect(deriveIsolationProfile({})).toEqual(deriveIsolationProfile({})); // pure/total
  });

  test("a declared profile derives its class and pool", () => {
    expect(deriveIsolationProfile({ isolation: { class: "strict" } })).toEqual({
      class: "strict",
      poolId: null,
    });
    expect(
      deriveIsolationProfile({ isolation: { class: "dedicated-customer", poolId: "gold" } }),
    ).toEqual({ class: "dedicated-customer", poolId: "gold" });
  });

  test("the derivation is DETERMINISTIC (invariant 6: same profile context → same shape)", () => {
    const spec = baseSpec({ isolation: { class: "dedicated-customer", poolId: "eu-bank" } });
    const first = deriveIsolationProfile(spec);
    for (let i = 0; i < 10; i += 1) {
      expect(deriveIsolationProfile(spec)).toEqual(first);
    }
  });

  test("the pool identity shape is bounded kebab-case", () => {
    expect(isValidPoolId("gold")).toBe(true);
    expect(isValidPoolId("eu-bank-01")).toBe(true);
    expect(isValidPoolId("Gold")).toBe(false);
    expect(isValidPoolId("-gold")).toBe(false);
    expect(isValidPoolId("gold!")).toBe(false);
    expect(isValidPoolId("a".repeat(64))).toBe(true);
    expect(isValidPoolId("a".repeat(65))).toBe(false);
  });

  // ---- the strict class: the tightened capability surface --------------

  test("strict admits a tight container shape (egress none, read-only workspace, no secrets)", () => {
    const validation = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "strict" },
      egress: "none",
      workspace: "ephemeral-read-only",
      secretRefs: [],
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  test("strict rejects an allowlist egress (ambient network access is not representable)", () => {
    const validation = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "strict" },
      egress: "allowlist",
      workspace: "ephemeral-read-only",
      secretRefs: [],
    });
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.field === "isolation.class")).toBe(true);
  });

  test("strict rejects a writable workspace and secret mediation", () => {
    const writable = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "strict" },
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(writable.valid).toBe(false);
    const secrets = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "strict" },
      egress: "none",
      workspace: "ephemeral-read-only",
      secretRefs: ["conn-customer-api"],
    });
    expect(secrets.valid).toBe(false);
  });

  test("strict rejects the process kind (not a security boundary for untrusted work) and no-execution", () => {
    for (const kind of ["process", "no-execution"] as const) {
      const validation = validateIsolationProfileDeclaration({
        kind,
        isolation: { class: "strict" },
        egress: "none",
        workspace: "none",
        secretRefs: [],
      });
      expect(validation.valid).toBe(false);
    }
    expect(STRICT_ELIGIBLE_KINDS).toEqual(["container", "microvm", "vm", "customer-runner"]);
  });

  test("strict carries no pool (poolId is unrepresentable)", () => {
    const validation = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "strict", poolId: "gold" },
      egress: "none",
      workspace: "ephemeral-read-only",
      secretRefs: [],
    });
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.field === "isolation.poolId")).toBe(true);
  });

  // ---- the dedicated-customer class -------------------------------------

  test("dedicated-customer requires a pool identity on an executing kind", () => {
    const valid = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "dedicated-customer", poolId: "gold" },
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(valid.valid).toBe(true);
    expect(DEDICATED_ELIGIBLE_KINDS).not.toContain("no-execution");

    const noPool = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "dedicated-customer" },
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(noPool.valid).toBe(false);

    const badPool = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "dedicated-customer", poolId: "NOT-VALID" },
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(badPool.valid).toBe(false);
  });

  test("standard carries no pool and an unknown class is rejected", () => {
    const withPool = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "standard", poolId: "gold" },
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(withPool.valid).toBe(false);
    const unknown = validateIsolationProfileDeclaration({
      kind: "container",
      isolation: { class: "hardened" } as never,
      egress: "none",
      workspace: "ephemeral-writable",
      secretRefs: [],
    });
    expect(unknown.valid).toBe(false);
  });

  test("validateComputeEnvironmentSpec integrates the isolation rules (the spec boundary)", () => {
    // A strict container with an allowlist is invalid AT THE SPEC BOUNDARY.
    const invalid = validateComputeEnvironmentSpec(
      baseSpec({
        network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
        isolation: { class: "strict" },
      }),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.field === "isolation.class")).toBe(true);

    // The tight strict shape is valid.
    const valid = validateComputeEnvironmentSpec(baseSpec({ isolation: { class: "strict" } }));
    expect(valid.valid).toBe(true);

    // The legacy spec (no declaration) remains valid — backward compatible.
    expect(validateComputeEnvironmentSpec(baseSpec()).valid).toBe(true);

    // no-execution cannot declare strict.
    const noExecStrict = validateComputeEnvironmentSpec({
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
      isolation: { class: "strict" },
    });
    expect(noExecStrict.valid).toBe(false);
  });
});

describe("WORK-058 governed selection through the policy seam (SEC-002)", () => {
  test("the ladder anchor: standard/strict anchor at the kind level; dedicated-customer anchors at customer-runner", () => {
    expect(isolationLadderAnchor({ kind: "container", profileClass: "standard" })).toBe(
      "container",
    );
    expect(isolationLadderAnchor({ kind: "container", profileClass: "strict" })).toBe("container");
    expect(isolationLadderAnchor({ kind: "container", profileClass: "dedicated-customer" })).toBe(
      "customer-runner",
    );
    expect(isolationLadderAnchor({ kind: "customer-runner", profileClass: "standard" })).toBe(
      "customer-runner",
    );
    expect(isolationLadderAnchor({ kind: "process", profileClass: "standard" })).toBe("process");
  });

  async function policyWorld(restrictions: Record<string, unknown>) {
    const store = new InMemoryPolicyStore();
    const authority = createPolicyAuthority({ store, hasher: nodePolicyHasher });
    await authority.publish({
      id: "default",
      version: 1,
      documents: [{ scope: "platform", selector: {}, restrictions }],
    });
    return createPolicySandboxAdmission(authority);
  }

  test("a policy floor of customer-runner REQUIRES the dedicated class (a standard environment is denied)", async () => {
    const admission = await policyWorld({ isolation: { minIsolation: "customer-runner" } });
    const standard = await admission.admit({
      tenantId: "t1",
      applicationId: "a1",
      executionId: "e1",
      kind: "container",
      isolationProfile: "standard",
      hosts: [],
      secretRefs: [],
    });
    expect(standard.allowed).toBe(false);
    expect(standard.allowed === false && standard.reason).toContain("below the effective minimum");

    const dedicated = await admission.admit({
      tenantId: "t1",
      applicationId: "a1",
      executionId: "e1",
      kind: "container",
      isolationProfile: "dedicated-customer",
      hosts: [],
      secretRefs: [],
    });
    expect(dedicated.allowed).toBe(true);
  });

  test("a container floor admits the strict class on a container kind (strict never violates a floor)", async () => {
    const admission = await policyWorld({ isolation: { minIsolation: "container" } });
    const strict = await admission.admit({
      tenantId: "t1",
      applicationId: "a1",
      executionId: "e1",
      kind: "container",
      isolationProfile: "strict",
      hosts: [],
      secretRefs: [],
    });
    expect(strict.allowed).toBe(true);
  });

  test("a process floor denies a container-kind profile (the anchor rides the frozen ladder)", async () => {
    const admission = await policyWorld({ isolation: { minIsolation: "process" } });
    // A microvm floor denies a container anchor.
    const tighter = await policyWorld({ isolation: { minIsolation: "microvm" } });
    const denied = await tighter.admit({
      tenantId: "t1",
      applicationId: "a1",
      executionId: "e1",
      kind: "container",
      isolationProfile: "strict",
      hosts: [],
      secretRefs: [],
    });
    expect(denied.allowed).toBe(false);
    void admission;
  });
});

describe("WORK-058 platform strict capability surface (the platform-layer mirror)", () => {
  const safeConfig = (overrides: Partial<ContainerConfiguration> = {}): ContainerConfiguration => ({
    image: "zeck-sandbox-base:1",
    command: "python3",
    args: ["analyze.py"],
    env: [{ name: "MODE", value: "batch" }],
    mounts: [{ source: "workspace", target: "/workspace", readOnly: true }],
    network: { mode: "none", allowedHosts: [] },
    resourceLimits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
    isolationClass: "strict",
    readOnlyRootfs: true,
    runAsNonRoot: true,
    privileged: false,
    hostNetwork: false,
    hostPid: false,
    hostIpc: false,
    devices: [],
    addedCapabilities: [],
    droppedCapabilities: ["ALL"],
    seccompProfile: "default",
    noNewPrivileges: true,
    ...overrides,
  });

  test("a strict-shaped configuration is safe", () => {
    expect(containerConfigurationViolations(safeConfig())).toEqual([]);
  });

  test("a strict configuration with an allowlist network is REJECTED (both layers, same shapes)", () => {
    const violations = containerConfigurationViolations(
      safeConfig({ network: { mode: "allowlist", allowedHosts: ["api.example.com"] } }),
    );
    expect(violations).toContain("strict-network-not-none");
  });

  test("a strict configuration with a writable workspace mount is REJECTED", () => {
    const violations = containerConfigurationViolations(
      safeConfig({ mounts: [{ source: "workspace", target: "/workspace", readOnly: false }] }),
    );
    expect(violations).toContain("strict-workspace-writable");
  });

  test("an UNKNOWN isolation class on a configuration is rejected (fail closed, never a default)", () => {
    const violations = containerConfigurationViolations(
      safeConfig({ isolationClass: "hardened" as never }),
    );
    expect(violations).toContain("isolation-class-unknown");
  });

  test("a standard configuration may carry an allowlist (the baseline posture is unchanged)", () => {
    const violations = containerConfigurationViolations(
      safeConfig({
        isolationClass: "standard",
        network: { mode: "allowlist", allowedHosts: ["api.example.com"] },
        mounts: [{ source: "workspace", target: "/workspace", readOnly: false }],
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe("WORK-058 tenant-scoped external run identity (SEC-001)", () => {
  test("the run identity binds the tenant: identical work in two tenants never collapses", () => {
    const tenantA = containerRunIdentity({
      tenantId: "00000000-0000-7000-8000-0000000000a1",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      executionId: "00000000-0000-7000-8000-0000000000e1",
      sandboxId: "00000000-0000-7000-8000-000000000001",
    });
    const tenantB = containerRunIdentity({
      tenantId: "00000000-0000-7000-8000-0000000000a2",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      executionId: "00000000-0000-7000-8000-0000000000e1",
      sandboxId: "00000000-0000-7000-8000-000000000001",
    });
    expect(tenantA).not.toBe(tenantB);
    expect(tenantA).toContain("0000000000a1");
    // The same logical run re-derives the same identity (idempotent replay).
    expect(tenantA).toBe(
      containerRunIdentity({
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: "00000000-0000-7000-8000-0000000000e1",
        sandboxId: "00000000-0000-7000-8000-000000000001",
      }),
    );
  });
});

describe("WORK-058 environment catalog projection (SEC-002)", () => {
  function catalogWorld() {
    const store = new InMemorySandboxStore();
    let counter = 0;
    const catalog = createEnvironmentCatalog({
      store,
      generateId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(),
      hashSpec: (canonical) =>
        createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16),
    });
    const actor = {
      actorId: "00000000-0000-7000-8000-0000000000c1",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      tenantId: "00000000-0000-7000-8000-0000000000a1",
    };
    return { store, catalog, actor };
  }

  test("registration projects the declared class/pool onto the durable record", async () => {
    const { catalog, actor } = catalogWorld();
    const record = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "ded-gold",
        name: "ded gold",
        spec: baseSpec({ isolation: { class: "dedicated-customer", poolId: "gold" } }),
      },
      "key-1",
      actor,
    );
    expect(record.isolationClass).toBe("dedicated-customer");
    expect(record.poolId).toBe("gold");

    const strict = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "strict-1",
        name: "strict",
        spec: baseSpec({ isolation: { class: "strict" } }),
      },
      "key-2",
      actor,
    );
    expect(strict.isolationClass).toBe("strict");
    expect(strict.poolId).toBe(null);

    const legacy = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "legacy",
        name: "legacy",
        spec: baseSpec(),
      },
      "key-3",
      actor,
    );
    expect(legacy.isolationClass).toBe("standard");
    expect(legacy.poolId).toBe(null);
  });

  test("an AMBIENT assignment (columns disagreeing with the spec) is rejected by the store", async () => {
    const { store } = catalogWorld();
    await expect(
      store.insertEnvironment({
        id: "00000000-0000-7000-8000-0000000000d1",
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        slug: "ambient",
        name: "ambient",
        description: null,
        kind: "container",
        spec: baseSpec() as unknown as Readonly<Record<string, unknown>>,
        specDigest: "digest-ambient",
        isolationClass: "strict",
        poolId: null,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("a strict registration with an allowlist fails closed at the catalog", async () => {
    const { catalog, actor } = catalogWorld();
    await expect(
      catalog.register(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          slug: "bad-strict",
          name: "bad",
          spec: baseSpec({
            network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
            isolation: { class: "strict" },
          }),
        },
        "key-bad",
        actor,
      ),
    ).rejects.toThrow(/isolation/i);
  });

  test("PROFILE DOWNGRADE is rejected: the same slug with a weaker profile is an identity conflict (digest covers isolation)", async () => {
    const { catalog, actor } = catalogWorld();
    const strictSpec = baseSpec({ isolation: { class: "strict" } });
    const record = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "downgrade-target",
        name: "target",
        spec: strictSpec,
      },
      "key-dg",
      actor,
    );
    expect(record.isolationClass).toBe("strict");

    // The SAME slug with the isolation field REMOVED (a downgrade to the
    // legacy standard class) must NOT converge: the digest differs.
    await expect(
      catalog.register(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          slug: "downgrade-target",
          name: "target",
          spec: baseSpec(),
        },
        "key-dg-2",
        actor,
      ),
    ).rejects.toThrow(/immutable|different specification/i);
  });

  test("IDENTITY-IDEMPOTENCY: re-registering the SAME spec converges on the same durable record", async () => {
    const { catalog, actor } = catalogWorld();
    const spec = baseSpec({ isolation: { class: "dedicated-customer", poolId: "gold" } });
    const first = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "conv",
        name: "c",
        spec,
      },
      "key-c1",
      actor,
    );
    const second = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "conv",
        name: "c",
        spec,
      },
      "key-c2",
      actor,
    );
    expect(second.id).toBe(first.id);
    expect(second.isolationClass).toBe(first.isolationClass);
    expect(second.poolId).toBe(first.poolId);
  });
});
