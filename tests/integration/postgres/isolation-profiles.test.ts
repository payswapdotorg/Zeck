/**
 * WORK-058 / D-08 (SEC-001 + SEC-002) — the compute-isolation profile
 * battery over REAL PostgreSQL: the durable projection, the physical
 * gates (by construction), the claim-admission pool semantics, quota
 * isolation and the misrouted-claim typed denials.
 *
 * The fabric-level evacuation/reassignment battery lives in
 * isolation-evacuation.test.ts; the mutation proofs live in
 * tests/discrimination/isolation-classes.discrimination.test.ts.
 */

import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "vitest";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import { createExecutionService } from "../../../src/modules/executions/application/execution-service";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import { SqlComputeWorkerStore } from "../../../src/platform/compute/pg-store";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

const generateId = createUuidv7Generator();
const ACTOR_ID = "00000000-0000-7000-8000-0000000000d8";

const CONTAINER_BASE: ComputeEnvironmentSpec = {
  kind: "container",
  limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-read-only", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "container-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

interface Scope {
  readonly tenantId: string;
  readonly applicationId: string;
}

definePgSuite("isolation profiles and runner pools (real PostgreSQL; WORK-058)", (ctx) => {
  let db: DatabasePort;
  let scopeA: Scope;
  let scopeB: Scope;
  let catalog: ReturnType<typeof createEnvironmentCatalog>;
  let compute: SqlComputeWorkerStore;
  let executionService: ReturnType<typeof createExecutionService>;
  let sandboxStore: SqlSandboxStore;

  const actorOf = (scope: Scope) => ({
    actorId: ACTOR_ID,
    applicationId: scope.applicationId,
    tenantId: scope.tenantId,
  });

  const registerEnv = async (
    scope: Scope,
    slug: string,
    spec: ComputeEnvironmentSpec,
  ): Promise<string> => {
    const record = await catalog.register(
      { applicationId: scope.applicationId, tenantId: scope.tenantId, slug, name: slug, spec },
      `env-${slug}-${scope.applicationId}`,
      actorOf(scope),
    );
    return record.id;
  };

  const seedExecution = async (scope: Scope): Promise<string> => {
    const receipt = await executionService.createExecution(
      { applicationId: scope.applicationId, task: { kind: "run-program", input: "artifact-1" } },
      `create-${generateId()}`,
      { actorId: ACTOR_ID, tenantId: scope.tenantId },
    );
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", `auth-${executionId}`],
      ["plan", `plan-${executionId}`],
      ["queue", `queue-${executionId}`],
      ["start", `start-${executionId}`],
    ] as const) {
      await executionService.transition(
        {
          actorId: ACTOR_ID,
          applicationId: scope.applicationId,
          tenantId: scope.tenantId,
          executionId,
          command,
        },
        key,
      );
    }
    return executionId;
  };

  const seedRunner = async (scope: Scope): Promise<string> => {
    const runnerId = generateId();
    await compute.registerRunner(
      {
        runnerId,
        applicationId: scope.applicationId,
        tenantId: scope.tenantId,
        endpointUrl: `https://runner-${runnerId.slice(-6)}.example`,
        tokenSecretRef: `zeck-secret://local/runner-${runnerId.slice(-6)}`,
        registeredBy: ACTOR_ID,
      },
      new Date().toISOString(),
    );
    await compute.transitionRunner(runnerId, "active", {
      actorId: ACTOR_ID,
      now: new Date().toISOString(),
    });
    return runnerId;
  };

  const registerPoolWorker = async (scope: Scope, poolId: string | null): Promise<string> => {
    const workerId = generateId();
    const runnerId = await seedRunner(scope);
    await compute.registerWorker(
      {
        workerId,
        applicationId: scope.applicationId,
        kind: "customer-runner",
        runnerId,
        ...(poolId === null ? {} : { poolId }),
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );
    return workerId;
  };

  const registerFirstPartyWorker = async (scope: Scope): Promise<string> => {
    const workerId = generateId();
    await compute.registerWorker(
      {
        workerId,
        applicationId: scope.applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );
    return workerId;
  };

  beforeAll(async () => {
    db = ctx.port;
    const seedScope = async (): Promise<Scope> => {
      const tenantId = generateId();
      const applicationId = generateId();
      await db.execute({
        sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
        parameters: [tenantId, `t-${tenantId.slice(-6)}`, `tenant ${tenantId.slice(-6)}`],
      });
      await db.execute({
        sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
        parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "app"],
      });
      return { tenantId, applicationId };
    };
    scopeA = await seedScope();
    scopeB = await seedScope();

    const policyStore = new InMemoryPolicyStore();
    const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
    await authority.publish({
      id: "default",
      version: 1,
      documents: [{ scope: "platform", selector: {}, restrictions: {} }],
    });

    executionService = createExecutionService({
      store: new SqlExecutionStore(db),
      idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
      authorization: createExecutionAuthorization(authority),
      generateId,
      now: () => new Date(),
    });

    sandboxStore = new SqlSandboxStore(db);
    catalog = createEnvironmentCatalog({
      store: sandboxStore,
      generateId,
      now: () => new Date(),
      hashSpec: (canonical) => createHash("sha256").update(canonical, "utf8").digest("hex"),
    });
    compute = new SqlComputeWorkerStore({
      db,
      maxClaimAttempts: 3,
      defaultEnvironmentQuota: 8,
      claimRetentionMs: 604_800_000,
      generateId,
    });
  });

  // ---------------------------------------------------------------- catalog

  test("registration projects the declared isolation class/pool onto durable columns", async () => {
    const dedicatedId = await registerEnv(scopeA, "ded-gold", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "gold" },
    });
    const strictId = await registerEnv(scopeA, "strict-1", {
      ...CONTAINER_BASE,
      isolation: { class: "strict" },
    });
    const legacyId = await registerEnv(scopeA, "legacy-1", CONTAINER_BASE);

    const dedicated = await catalog.get(scopeA.applicationId, dedicatedId);
    expect(dedicated?.isolationClass).toBe("dedicated-customer");
    expect(dedicated?.poolId).toBe("gold");
    const strict = await catalog.get(scopeA.applicationId, strictId);
    expect(strict?.isolationClass).toBe("strict");
    expect(strict?.poolId).toBe(null);
    const legacy = await catalog.get(scopeA.applicationId, legacyId);
    expect(legacy?.isolationClass).toBe("standard");
    expect(legacy?.poolId).toBe(null);
  });

  test("a strict registration with an allowlist egress FAILS CLOSED at the catalog", async () => {
    await expect(
      registerEnv(scopeA, "strict-bad", {
        ...CONTAINER_BASE,
        network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
        isolation: { class: "strict" },
      }),
    ).rejects.toThrow(/isolation/i);
  });

  test("PROFILE DOWNGRADE rejected: same slug, weaker profile is an identity conflict", async () => {
    await registerEnv(scopeA, "dg-target", { ...CONTAINER_BASE, isolation: { class: "strict" } });
    await expect(registerEnv(scopeA, "dg-target", CONTAINER_BASE)).rejects.toThrow(
      /different specification|immutable/i,
    );
  });

  test("cross-tenant registration stays rejected (the catalog guard)", async () => {
    const envId = await registerEnv(scopeA, "cross-1", CONTAINER_BASE);
    // scopeB's actor cannot even see scopeA's environment.
    const foreign = await catalog.get(scopeB.applicationId, envId);
    expect(foreign).toBe(null);
  });

  // -------------------------------------------------------- physical gates

  test("PHYSICAL: an ambient assignment (columns disagreeing with the spec) is unrepresentable", async () => {
    const id = generateId();
    await expect(
      db.execute({
        sql: `INSERT INTO sandbox.compute_environments (id, application_id, tenant_id, slug, name, kind, spec, spec_digest, status, isolation_class, pool_id, created_at, updated_at)
VALUES ($1, $2, $3, 'ambient-strict', 'Ambient', 'container', $4::jsonb, 'digest-x', 'available', 'strict', NULL, now(), now())`,
        parameters: [id, scopeA.applicationId, scopeA.tenantId, JSON.stringify(CONTAINER_BASE)],
      }),
    ).rejects.toThrow(/ambient assignment|disagrees/i);
  });

  test("PHYSICAL: the isolation projection is immutable (in-place downgrade unrepresentable)", async () => {
    const envId = await registerEnv(scopeA, "immutable-iso", {
      ...CONTAINER_BASE,
      isolation: { class: "strict" },
    });
    // An in-place downgrade is physically unrepresentable: whichever
    // guard fires first (consistency or immutability), the UPDATE fails.
    await expect(
      db.execute({
        sql: "UPDATE sandbox.compute_environments SET isolation_class = 'standard' WHERE id = $1",
        parameters: [envId],
      }),
    ).rejects.toThrow(/immutable|disagrees|unrepresentable/i);
  });

  test("PHYSICAL: a cross-tenant claim row is unrepresentable (misrouted claims fail closed)", async () => {
    const envId = await registerEnv(scopeA, "std-1", CONTAINER_BASE);
    const workerId = await registerFirstPartyWorker(scopeA);
    const executionId = await seedExecution(scopeA);
    await expect(
      db.execute({
        sql: `INSERT INTO compute_plane.worker_claims (id, execution_id, application_id, tenant_id, compute_environment_id, worker_id, claim_epoch, status, claimed_at, last_heartbeat_at)
VALUES ($1, $2, $3, $4, $5, $6, 1, 'claimed', now(), now())`,
        parameters: [
          generateId(),
          executionId,
          scopeA.applicationId,
          scopeB.tenantId,
          envId,
          workerId,
        ],
      }),
    ).rejects.toThrow(/misrouted claims fail closed|cross-tenant resource access/i);
  });

  test("PHYSICAL: pool cross-talk is unrepresentable (dedicated pools share nothing)", async () => {
    const goldId = await registerEnv(scopeA, "ded-gold-2", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "gold" },
    });
    const silverWorker = await registerPoolWorker(scopeA, "silver");
    const executionId = await seedExecution(scopeA);
    await expect(
      db.execute({
        sql: `INSERT INTO compute_plane.worker_claims (id, execution_id, application_id, tenant_id, compute_environment_id, worker_id, claim_epoch, status, claimed_at, last_heartbeat_at)
VALUES ($1, $2, $3, $4, $5, $6, 1, 'claimed', now(), now())`,
        parameters: [
          generateId(),
          executionId,
          scopeA.applicationId,
          scopeA.tenantId,
          goldId,
          silverWorker,
        ],
      }),
    ).rejects.toThrow(/dedicated pools share nothing/i);
  });

  test("PHYSICAL: the worker pool binding is immutable (a worker never changes pools)", async () => {
    const workerId = await registerPoolWorker(scopeA, "gold");
    await expect(
      db.execute({
        sql: "UPDATE compute_plane.worker_registrations SET pool_id = 'silver' WHERE worker_id = $1",
        parameters: [workerId],
      }),
    ).rejects.toThrow(/pool binding is immutable/i);
  });

  test("PHYSICAL: a first-party worker with a pool is unrepresentable", async () => {
    const workerId = generateId();
    await expect(
      db.execute({
        sql: `INSERT INTO compute_plane.worker_registrations (worker_id, application_id, kind, pool_id, status, declared_concurrency, registered_at, last_heartbeat_at)
VALUES ($1, $2, 'first-party', 'gold', 'active', 4, now(), now())`,
        parameters: [workerId, scopeA.applicationId],
      }),
    ).rejects.toThrow(/worker_pool_shape/i);
  });

  // ------------------------------------------------- claim admission (typed)

  test("a pool-matching worker claims dedicated work; the claim derives the pool (scoped resolution)", async () => {
    const goldId = await registerEnv(scopeA, "ded-gold-3", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "gold" },
    });
    const workerId = await registerPoolWorker(scopeA, "gold");
    const executionId = await seedExecution(scopeA);
    const outcome = await compute.acquireClaim(
      {
        workerId,
        executionId,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: goldId,
      },
      new Date().toISOString(),
    );
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome === "admitted") {
      expect(outcome.claim.poolId).toBe("gold");
    }
  });

  test("a wrong-pool or unbound worker claiming dedicated work refuses with the TYPED pool-mismatch denial", async () => {
    const goldId = await registerEnv(scopeA, "ded-gold-4", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "gold" },
    });
    const executionId = await seedExecution(scopeA);

    const silverWorker = await registerPoolWorker(scopeA, "silver");
    const silver = await compute.acquireClaim(
      {
        workerId: silverWorker,
        executionId,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: goldId,
      },
      new Date().toISOString(),
    );
    expect(silver.outcome).toBe("refused");
    if (silver.outcome === "refused") {
      expect(silver.reason.kind).toBe("pool-mismatch");
      if (silver.reason.kind === "pool-mismatch") {
        expect(silver.reason.environmentPool).toBe("gold");
        expect(silver.reason.workerPool).toBe("silver");
      }
    }

    const firstParty = await registerFirstPartyWorker(scopeA);
    const unbound = await compute.acquireClaim(
      {
        workerId: firstParty,
        executionId,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: goldId,
      },
      new Date().toISOString(),
    );
    expect(unbound.outcome).toBe("refused");
    expect(unbound.outcome === "refused" && unbound.reason.kind).toBe("pool-mismatch");
  });

  test("a misrouted claim (tenant disagreeing with the environment's authoritative tenant) refuses with the TYPED tenant-scope denial", async () => {
    const envId = await registerEnv(scopeA, "std-2", CONTAINER_BASE);
    const workerId = await registerFirstPartyWorker(scopeA);
    const executionId = await seedExecution(scopeA);
    const outcome = await compute.acquireClaim(
      {
        workerId,
        executionId,
        applicationId: scopeA.applicationId,
        tenantId: scopeB.tenantId, // hostile/misrouted tenant
        environmentId: "",
        computeEnvironmentId: envId,
      },
      new Date().toISOString(),
    );
    expect(outcome.outcome).toBe("refused");
    expect(outcome.outcome === "refused" && outcome.reason.kind).toBe("tenant-scope-refused");
  });

  test("standard environments remain claimable by unbound workers (legacy compatibility)", async () => {
    const envId = await registerEnv(scopeA, "std-3", CONTAINER_BASE);
    const workerId = await registerFirstPartyWorker(scopeA);
    const executionId = await seedExecution(scopeA);
    const outcome = await compute.acquireClaim(
      {
        workerId,
        executionId,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: envId,
      },
      new Date().toISOString(),
    );
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome === "admitted") {
      expect(outcome.claim.poolId).toBe(null);
    }
  });

  test("dedicated pools have INDEPENDENT quota accounting (zero shared pool state)", async () => {
    const goldId = await registerEnv(scopeA, "ded-gold-q", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "gold" },
    });
    const silverId = await registerEnv(scopeA, "ded-silver-q", {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "silver" },
    });
    await compute.setEnvironmentQuota(goldId, 1);
    await compute.setEnvironmentQuota(silverId, 1);

    const goldWorker = await registerPoolWorker(scopeA, "gold");
    const silverWorker = await registerPoolWorker(scopeA, "silver");
    const execution1 = await seedExecution(scopeA);
    const execution2 = await seedExecution(scopeA);

    const goldFirst = await compute.acquireClaim(
      {
        workerId: goldWorker,
        executionId: execution1,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: goldId,
      },
      new Date().toISOString(),
    );
    expect(goldFirst.outcome).toBe("admitted");

    // Gold's quota (1) is saturated for gold work…
    const goldSecond = await compute.acquireClaim(
      {
        workerId: goldWorker,
        executionId: execution2,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: goldId,
      },
      new Date().toISOString(),
    );
    expect(goldSecond.outcome).toBe("refused");
    expect(goldSecond.outcome === "refused" && goldSecond.reason.kind).toBe("quota-saturated");

    // …while silver's quota is UNTOUCHED (no shared quota state).
    const silverFirst = await compute.acquireClaim(
      {
        workerId: silverWorker,
        executionId: execution2,
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        environmentId: "",
        computeEnvironmentId: silverId,
      },
      new Date().toISOString(),
    );
    expect(silverFirst.outcome).toBe("admitted");
    if (silverFirst.outcome === "admitted") {
      expect(silverFirst.claim.poolId).toBe("silver");
    }
  });

  test("worker registration validates the pool binding (customer-runner only, bounded shape)", async () => {
    const runnerId = await seedRunner(scopeA);
    await expect(
      compute.registerWorker(
        {
          workerId: generateId(),
          applicationId: scopeA.applicationId,
          kind: "first-party",
          poolId: "gold",
          declaredConcurrency: 4,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/first-party workers never bind/i);
    await expect(
      compute.registerWorker(
        {
          workerId: generateId(),
          applicationId: scopeA.applicationId,
          kind: "customer-runner",
          runnerId,
          poolId: "NOT VALID",
          declaredConcurrency: 4,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/poolId/i);
  });

  test("IDENTITY-IDEMPOTENCY: re-registering the identical profile spec converges", async () => {
    const spec: ComputeEnvironmentSpec = {
      ...CONTAINER_BASE,
      isolation: { class: "dedicated-customer", poolId: "platinum" },
    };
    const first = await catalog.register(
      {
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        slug: "conv-1",
        name: "c",
        spec,
      },
      "conv-1-a",
      actorOf(scopeA),
    );
    const second = await catalog.register(
      {
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        slug: "conv-1",
        name: "c",
        spec,
      },
      "conv-1-b",
      actorOf(scopeA),
    );
    expect(second.id).toBe(first.id);
    expect(second.isolationClass).toBe("dedicated-customer");
    expect(second.poolId).toBe("platinum");
  });
});
