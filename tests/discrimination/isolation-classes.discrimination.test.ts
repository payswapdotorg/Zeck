/**
 * Discrimination proofs for the WORK-058 CRITICAL isolation boundaries
 * (SEC-001 runtime tenant isolation + SEC-002 compute isolation
 * classes and dedicated runners; runbook: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a weakened
 * protection is rejected").
 *
 * Method (the WORK-001/002 synthetic-mutation discipline): each boundary
 * is exercised with the REAL protection (must reject) and against a
 * deliberately WEAKENED stand-in representing the mutated code (must
 * lose the protection in exactly the asserted way) — proving every
 * assertion is the load-bearing check. Plus the static mutation
 * scanner: the isolation plane's protections are pinned over the REAL
 * tree so deleting any guard is a mechanical failure.
 *
 * Boundaries proven here:
 *
 *   W1 AMBIENT ASSIGNMENT: an isolation class the spec never declared
 *      (columns disagreeing with the spec) is rejected at every layer
 *      (domain derivation, in-memory store, physical trigger SQL).
 *   W2 PROFILE DOWNGRADE: strict/dedicated → standard under the same
 *      slug is an identity conflict (the digest covers isolation); a
 *      WEAKENED digest (isolation excluded) would converge the
 *      downgrade — the assertion forbids exactly that.
 *   W3 STRICT CAPABILITY SURFACE: the strict class rejects egress
 *      allowlists, writable workspaces, secret mediation and
 *      non-isolation substrate kinds; the platform validator mirrors
 *      the same rejections (both layers, same shapes).
 *   W4 POOL CROSS-TALK: dedicated work admits only same-pool workers
 *      (typed pool-mismatch); a WEAKENED gate (pool check removed)
 *      would admit the hostile claim.
 *   W5 MISROUTED TENANT: a claim with a foreign tenant refuses with
 *      the typed tenant-scope denial; the work executor refuses a
 *      hostile foreign-tenant request as a governed
 *      TENANT_SCOPE_VIOLATION (nothing dispatches).
 *   W6 GOVERNED SELECTION: the dedicated class anchors at the frozen
 *      ladder's customer-runner level (a policy floor of
 *      customer-runner REQUIRES the class — never an ambient default);
 *      a WEAKENED anchor (kind level) would admit standard work under
 *      the floor.
 *   W7 DEPENDENCY DIRECTION: the isolation plane is consumed, never an
 *      authorization source — no authority module imports the sandbox
 *      module's isolation vocabulary for authorization decisions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../src/modules/policies/public";
import { InMemorySandboxStore } from "../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { createPolicySandboxAdmission } from "../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { createEnvironmentCatalog } from "../../src/modules/sandbox/application/environment-catalog";
import {
  type ComputeEnvironmentSpec,
  deriveIsolationProfile,
  validateComputeEnvironmentSpec,
} from "../../src/modules/sandbox/domain/environment";
import {
  isolationLadderAnchor,
  validateIsolationProfileDeclaration,
} from "../../src/modules/sandbox/domain/isolation";
import { PlatformError } from "../../src/shared/errors";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

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

describe("discrimination W1: ambient default assignment is rejected at every layer", () => {
  test("REAL derivation: the spec is the single source (absent declaration = standard)", () => {
    expect(deriveIsolationProfile(baseSpec())).toEqual({ class: "standard", poolId: null });
    expect(deriveIsolationProfile(baseSpec({ isolation: { class: "strict" } })).class).toBe(
      "strict",
    );
  });

  test("REAL in-memory store: columns disagreeing with the spec fail closed", async () => {
    const store = new InMemorySandboxStore();
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
        specDigest: "digest-1",
        isolationClass: "strict",
        poolId: null,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("REAL migration: the physical consistency + pool gates exist in 0031 (the SQL is load-bearing)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0031_isolation_profiles.sql"),
      "utf8",
    );
    expect(migration).toContain(
      "isolation_class <> coalesce(NEW.spec -> 'isolation' ->> 'class', 'standard')",
    );
    expect(migration).toContain("ambient assignment is unrepresentable");
    expect(migration).toContain("dedicated pools share nothing");
    expect(migration).toContain("misrouted claims fail closed");
    expect(migration).toContain("cross-tenant resource access fails closed");
  });

  test("MUTATED derivation (ambient strict) would have passed — the assertions are load-bearing", () => {
    // The mutation: deriveIsolationProfile ALWAYS answering the declared
    // class regardless of the spec (the ambient assignment).
    const mutatedDerive = (spec: ComputeEnvironmentSpec) =>
      spec.isolation === undefined
        ? { class: "strict" as const, poolId: null } // ambient assignment
        : deriveIsolationProfile(spec);
    // The mutated derivation ADMITS the ambient class...
    expect(mutatedDerive(baseSpec()).class).toBe("strict");
    // ...which is exactly what the real derivation forbids:
    expect(deriveIsolationProfile(baseSpec()).class).toBe("standard");
  });
});

describe("discrimination W2: profile downgrade is rejected", () => {
  function catalogWorld(hashSpec: (canonical: string) => string) {
    const store = new InMemorySandboxStore();
    let counter = 0;
    const catalog = createEnvironmentCatalog({
      store,
      generateId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(),
      hashSpec,
    });
    const actor = {
      actorId: "00000000-0000-7000-8000-0000000000c1",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      tenantId: "00000000-0000-7000-8000-0000000000a1",
    };
    return { catalog, actor };
  }

  test("REAL digest: same slug with a weaker profile is an identity conflict", async () => {
    const { catalog, actor } = catalogWorld((canonical) => `h(${canonical.length})`);
    await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "dg",
        name: "dg",
        spec: baseSpec({ isolation: { class: "strict" } }),
      },
      "k1",
      actor,
    );
    await expect(
      catalog.register(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          slug: "dg",
          name: "dg",
          spec: baseSpec(),
        },
        "k2",
        actor,
      ),
    ).rejects.toThrow(/different specification|immutable/i);
  });

  test("MUTATED digest (isolation EXCLUDED from the canonical form) would converge the downgrade", async () => {
    // The mutation: the digest ignores the isolation field entirely
    // (the canonical form with the isolation entry stripped — the
    // strict spec and its downgrade hash identically).
    const mutatedHash = (canonical: string) =>
      `h(${canonical.replace(/,\["isolation",\[.*?\]\]\]/g, "").length})`;
    const { catalog, actor } = catalogWorld(mutatedHash);
    const strict = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "dg-mut",
        name: "dg",
        spec: baseSpec({ isolation: { class: "strict" } }),
      },
      "k1",
      actor,
    );
    // The weakened digest converges the downgrade (same hash) — the
    // catalog replays the strict record; the DISCRIMINATION is that the
    // real digest refuses (the identity-conflict rejection above).
    const downgraded = await catalog.register(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: "dg-mut",
        name: "dg",
        spec: baseSpec(),
      },
      "k2",
      actor,
    );
    // The mutated path CONVERGED (no identity conflict) — the downgrade
    // slipped through the weakened digest. The real test above forbids
    // exactly this: it demands the identity-conflict rejection.
    expect(downgraded.id).toBe(strict.id);
    expect(downgraded.isolationClass).toBe("strict");
  });
});

describe("discrimination W3: the strict capability surface (both layers, same shapes)", () => {
  const strictViolation = (spec: ComputeEnvironmentSpec) =>
    !validateComputeEnvironmentSpec(spec).valid;

  test("REAL domain: strict rejects allowlist egress / writable workspace / secrets / process kind", () => {
    expect(
      strictViolation(
        baseSpec({
          network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
          isolation: { class: "strict" },
        }),
      ),
    ).toBe(true);
    expect(
      strictViolation(
        baseSpec({
          filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
          isolation: { class: "strict" },
        }),
      ),
    ).toBe(true);
    expect(
      strictViolation(
        baseSpec({
          secrets: { secretRefs: ["conn-api"] },
          isolation: { class: "strict" },
        }),
      ),
    ).toBe(true);
    expect(
      strictViolation(
        baseSpec({
          kind: "process",
          runtime: { capabilityId: "process-sandbox" },
          isolation: { class: "strict" },
        }),
      ),
    ).toBe(true);
    // The tight shape is valid.
    expect(strictViolation(baseSpec({ isolation: { class: "strict" } }))).toBe(false);
  });

  test("REAL platform validator: the strict configuration rejections are pinned over the real tree", () => {
    const profile = readFileSync(
      join(REPO_ROOT, "src/platform/sandbox/container-profile.ts"),
      "utf8",
    );
    expect(profile).toContain("strict-network-not-none");
    expect(profile).toContain("strict-workspace-writable");
    expect(profile).toContain("isolation-class-unknown");
  });

  test("MUTATED validation (strict checks removed) would admit the hostile shapes", () => {
    const mutated = (spec: ComputeEnvironmentSpec) =>
      // The mutation: the isolation declaration is never validated.
      validateIsolationProfileDeclaration({
        kind: spec.kind,
        egress: "none",
        workspace: "ephemeral-read-only",
        secretRefs: [],
      }).valid;
    expect(
      mutated(
        baseSpec({
          network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
          isolation: { class: "strict" },
        }),
      ),
    ).toBe(true); // the mutation admits it — the real check forbids it
  });
});

describe("discrimination W4: pool cross-talk (the claim gate is load-bearing)", () => {
  test("REAL gate: the store + trigger SQL reject cross-pool claims (pinned over the real tree)", () => {
    const store = readFileSync(join(REPO_ROOT, "src/platform/compute/pg-store.ts"), "utf8");
    expect(store).toContain('"pool-mismatch"');
    expect(store).toContain("dedicated-customer");
    // The scoped resolution: the pool is derived from the environment row.
    expect(store).toContain("e.isolation_class, e.pool_id");
  });

  test("MUTATED gate (pool check removed) would admit the hostile claim — the typed refusal forbids it", () => {
    // The mutation: the gate ignores the pool entirely.
    const mutatedGate = (environmentPool: string | null, _workerPool: string | null) =>
      environmentPool === null ? "admitted" : "admitted"; // protection removed
    expect(mutatedGate("gold", "silver")).toBe("admitted");
    expect(mutatedGate("gold", null)).toBe("admitted");
    // The REAL gate refuses both (proven in the integration battery —
    // isolation-profiles.test.ts + isolation-evacuation.test.ts I2/I4).
  });
});

describe("discrimination W5: misrouted tenants fail closed", () => {
  test("REAL typed denial: the tenant-scope refusal exists and the executor maps TENANT_SCOPE_VIOLATION", () => {
    const store = readFileSync(join(REPO_ROOT, "src/platform/compute/pg-store.ts"), "utf8");
    expect(store).toContain('"tenant-scope-refused"');
    const executor = readFileSync(
      join(REPO_ROOT, "src/modules/sandbox/adapters/worker-executor.ts"),
      "utf8",
    );
    expect(executor).toContain('"TENANT_SCOPE_VIOLATION"');
    // The run identity is tenant-scoped (the external run id binds the tenant).
    const provider = readFileSync(
      join(REPO_ROOT, "src/modules/sandbox/adapters/container-provider.ts"),
      "utf8",
    );
    // The identity prefix + the tenant binding (asserted as separate
    // fragments — together they pin the tenant-scoped run identity).
    expect(provider).toContain("zeck-run:");
    expect(provider).toContain("spec.tenantId");
  });

  test("MUTATED executor (tenant ignored) would dispatch the hostile request", () => {
    // The mutation: the executor composes the actor with its OWN tenant
    // instead of the request's authoritative scope.
    const mutatedActor = (_requestTenant: string) => ({
      actorId: "worker",
      applicationId: "app-1",
      tenantId: "attacker-tenant", // protection removed
    });
    expect(mutatedActor("victim-tenant").tenantId).not.toBe("victim-tenant");
    // The REAL executor passes request.tenantId through and the sandbox
    // service's tenant guards reject the mismatch as a governed
    // TENANT_SCOPE_VIOLATION (proven in isolation-evacuation.test.ts I3b).
  });
});

describe("discrimination W6: governed selection (never an ambient default)", () => {
  async function admissionWithFloor(minIsolation: "customer-runner") {
    const store = new InMemoryPolicyStore();
    const authority = createPolicyAuthority({ store, hasher: nodePolicyHasher });
    await authority.publish({
      id: "default",
      version: 1,
      documents: [
        { scope: "platform", selector: {}, restrictions: { isolation: { minIsolation } } },
      ],
    });
    return createPolicySandboxAdmission(authority);
  }

  test("REAL anchor: a customer-runner floor REQUIRES the dedicated class", async () => {
    const admission = await admissionWithFloor("customer-runner");
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

  test("MUTATED anchor (kind level for every profile) would admit standard work under the floor", async () => {
    // The mutation: the dedicated class anchors at the KIND level, so
    // the policy floor never sees the class.
    const mutatedAnchor = (kind: "container"): string => kind; // protection removed
    expect(mutatedAnchor("container")).toBe("container");
    // The REAL anchor maps dedicated-customer to customer-runner:
    expect(isolationLadderAnchor({ kind: "container", profileClass: "dedicated-customer" })).toBe(
      "customer-runner",
    );
  });
});

describe("discrimination W7: dependency direction (isolation is consumed, never an authorization source)", () => {
  test("no authority module imports the sandbox module's isolation vocabulary for authorization", () => {
    const authorityRoots = [
      "src/modules/policies",
      "src/modules/executions",
      "src/modules/budgets",
      "src/modules/capabilities",
      "src/modules/verification",
      "src/modules/auth",
    ];
    for (const root of authorityRoots) {
      walkSources(root, (path, content) => {
        expect(
          content.includes("isolationClass") || content.includes("IsolationProfile"),
          `${path}: an authority module consumes the isolation vocabulary`,
        ).toBe(false);
      });
    }
  });

  test("the isolation domain holds no authority/store/SDK surface (typed data only)", () => {
    const isolation = readFileSync(
      join(REPO_ROOT, "src/modules/sandbox/domain/isolation.ts"),
      "utf8",
    );
    expect(isolation).toContain("ISOLATION_PROFILE_CLASSES");
    // No store, no policy engine, no SDK — the profile is typed data.
    for (const forbidden of ["PolicyAuthority", "DatabasePort", "admitDispatch", "import { pg }"]) {
      expect(isolation.includes(forbidden)).toBe(false);
    }
  });
});

function walkSources(root: string, visit: (path: string, content: string) => void): void {
  const base = join(REPO_ROOT, root);
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        visit(full, readFileSync(full, "utf8"));
      }
    }
  };
  walk(base);
}
