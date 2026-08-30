/**
 * Real-PostgreSQL: policy admission durability through the REAL executions
 * ledger (WORK-007 acceptance criterion 5; checkpoint contract
 * POLICY-BEFORE-DISPATCH proof class "dynamic"; POL-001/002/003 on the
 * physical fabric).
 *
 * The REAL policy authority (in-memory store + node hasher — the
 * configuration-resident definition seam) is wired behind the executions
 * authorize seam through the policies module's adapter — exactly the
 * production composition:
 *
 *   * ALLOW: the authorize envelope carries the durable admission evidence
 *     (effective policy set version + content hash + resolved
 *     restriction-set digest) — persisted, re-readable, provenance-bound;
 *   * DENY: typed `POLICY_DENIED`; the execution cannot pass CREATED; the
 *     `execution.policy-denied` envelope (with evidence + reason) is
 *     persisted and PHYSICALLY append-only (UPDATE rejected by migration
 *     0004's trigger); same-key retry replays the denial without a second
 *     envelope;
 *   * version change: a later authorize on a different execution binds the
 *     NEW set identity (evidence follows the CURRENT effective set);
 *   * after a denial, authorizing again once policy allows succeeds — the
 *     denial does not wedge the state machine.
 */

import { expect, test } from "vitest";
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
  type PolicyDocument,
  type PolicySet,
} from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";
import { generateId } from "./executions-world";
import { definePgSuite } from "./harness";

definePgSuite("policy admission evidence (real PG)", (ctx) => {
  interface World {
    readonly service: ExecutionService;
    readonly store: InMemoryPolicyStore;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly executionServiceStore: SqlExecutionStore;
  }

  async function seedWorld(set?: PolicySet): Promise<World> {
    const tenantId = generateId();
    const applicationId = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `t-${tenantId.slice(-6)}`, "policy tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "policy app"],
    });
    const store = new InMemoryPolicyStore();
    const authority = createPolicyAuthority({ store, hasher: nodePolicyHasher });
    if (set !== undefined) {
      await authority.publish(set);
    }
    const executionServiceStore = new SqlExecutionStore(ctx.port);
    const idempotency = new SqlExecutionsIdempotency(
      ctx.port,
      (tx) => new SqlExecutionStore(tx),
      generateId,
    );
    const service = createExecutionService({
      store: executionServiceStore,
      idempotency,
      authorization: createExecutionAuthorization(authority),
      generateId,
      now: () => new Date(),
    });
    return { service, store, tenantId, applicationId, executionServiceStore };
  }

  const setV1: PolicySet = {
    id: "default",
    version: 1,
    documents: [
      {
        scope: "platform",
        selector: {},
        restrictions: { cost: { maxCostMicroUsd: "1000" } },
      },
      {
        scope: "application",
        selector: { tenantId: "BOUND-IN-TEST", applicationId: "BOUND-IN-TEST" },
        restrictions: { tool: { deniedTools: ["terminal"] } },
      },
    ],
  };

  const allowSetFor = (world: { tenantId: string; applicationId: string }): PolicySet => ({
    ...setV1,
    documents: [
      setV1.documents[0] as PolicyDocument,
      {
        scope: "application",
        selector: { tenantId: world.tenantId, applicationId: world.applicationId },
        restrictions: { tool: { deniedTools: ["terminal"] } },
      },
    ],
  });

  const denySetFor = (world: { tenantId: string; applicationId: string }): PolicySet => ({
    id: "default",
    version: 1,
    documents: [
      {
        scope: "application",
        selector: { tenantId: world.tenantId, applicationId: world.applicationId },
        deny: { reason: "application suspended" },
      },
    ],
  });

  const actorOf = (world: World) => ({
    actorId: "00000000-0000-7000-8000-0000000000aa",
    tenantId: world.tenantId,
  });

  async function createExecution(world: World, key: string) {
    return world.service.createExecution(
      { applicationId: world.applicationId, task: { kind: "summarize", input: "a1" } },
      key,
      actorOf(world),
    );
  }

  test("allow: the authorize envelope persists the effective-policy admission evidence", async () => {
    const world = await seedWorld();
    await (await createPolicyAuthority({ store: world.store, hasher: nodePolicyHasher })).publish(
      allowSetFor(world),
    );
    const receipt = await createExecution(world, "c-allow");
    const outcome = await world.service.transition(
      {
        ...actorOf(world),
        applicationId: world.applicationId,
        executionId: receipt.executionId,
        command: "authorize",
      },
      "a-allow",
    );
    expect(outcome.execution.status).toBe("AUTHORIZED");

    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    const authorizeEvent = events.find((event) => event.type === "execution.authorize");
    expect(authorizeEvent).toBeDefined();
    const policy = authorizeEvent?.reference.policy as Record<string, unknown> | undefined;
    expect(policy).toBeDefined();
    expect(policy?.policySetId).toBe("default");
    expect(policy?.policySetVersion).toBe(1);
    expect(String(policy?.policyContentHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(policy?.restrictionSetDigest)).toMatch(/^[0-9a-f]{64}$/);

    // The recorded evidence is exactly the authority's current identity.
    const record = await world.store.load();
    expect(policy?.policyContentHash).toBe(record?.contentHash);
  });

  test("deny: typed POLICY_DENIED, blocked at CREATED, durable denial envelope (append-only)", async () => {
    const world = await seedWorld();
    await (await createPolicyAuthority({ store: world.store, hasher: nodePolicyHasher })).publish(
      denySetFor(world),
    );
    const receipt = await createExecution(world, "c-deny");
    const actor = actorOf(world);
    const error = await world.service
      .transition(
        {
          ...actor,
          applicationId: world.applicationId,
          executionId: receipt.executionId,
          command: "authorize",
        },
        "a-deny",
      )
      .catch((e: unknown) => e as PlatformError);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("POLICY_DENIED");
    expect(String((error as PlatformError).details?.reason)).toContain("application suspended");

    // Row cannot pass CREATED — no dispatch is possible.
    const row = await world.service.getExecution(world.applicationId, receipt.executionId);
    expect(row?.status).toBe("CREATED");

    // The denial evidence is DURABLE on the real ledger.
    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    expect(events.map((event) => event.type)).toEqual([
      "execution.created",
      "execution.policy-denied",
    ]);
    const denial = events[1];
    expect(denial?.command).toBe("authorize");
    expect(denial?.reference).toMatchObject({ denied: true });
    expect(String(denial?.reference.reason)).toContain("application suspended");
    expect(denial?.reference.policy).toMatchObject({ policySetId: "default", policySetVersion: 1 });

    // PHYSICALLY append-only: mutating the denial envelope is rejected by
    // the migration 0004 trigger.
    const mutation = await ctx.port
      .execute({
        sql: "UPDATE executions.execution_events SET payload = '{}'::jsonb WHERE id = $1",
        parameters: [denial?.eventId],
      })
      .then(() => "mutated")
      .catch(() => "rejected");
    expect(mutation).toBe("rejected");

    // Same-key retry replays the SAME durable denial — no second envelope.
    const replayError = await world.service
      .transition(
        {
          ...actor,
          applicationId: world.applicationId,
          executionId: receipt.executionId,
          command: "authorize",
        },
        "a-deny",
      )
      .catch((e: unknown) => e as PlatformError);
    expect((replayError as PlatformError).code).toBe("POLICY_DENIED");
    const eventsAfterReplay = await world.service.listEvents(
      world.applicationId,
      receipt.executionId,
    );
    expect(eventsAfterReplay).toHaveLength(2);
    expect(
      (await world.service.getExecution(world.applicationId, receipt.executionId))?.status,
    ).toBe("CREATED");
  });

  test("after a denial, publishing an allowing set lets the SAME execution authorize", async () => {
    const world = await seedWorld();
    const authority = createPolicyAuthority({ store: world.store, hasher: nodePolicyHasher });
    await authority.publish(denySetFor(world));
    const receipt = await createExecution(world, "c-recover");
    const actor = actorOf(world);
    await expect(
      world.service.transition(
        {
          ...actor,
          applicationId: world.applicationId,
          executionId: receipt.executionId,
          command: "authorize",
        },
        "a-recover-1",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // Policy changes to allow (version 2): the retry authorizes cleanly and
    // the authorize envelope binds the NEW set identity.
    await authority.publish({ ...allowSetFor(world), version: 2 });
    const outcome = await world.service.transition(
      {
        ...actor,
        applicationId: world.applicationId,
        executionId: receipt.executionId,
        command: "authorize",
      },
      "a-recover-2",
    );
    expect(outcome.execution.status).toBe("AUTHORIZED");
    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    const authorizeEvent = events.find((event) => event.type === "execution.authorize");
    expect((authorizeEvent?.reference.policy as Record<string, unknown>)?.policySetVersion).toBe(2);
    // Gapless sequence preserved across the denial record: 1 create, 2 denial, 3 authorize.
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  test("a request constraint exceeding the effective ceiling denies with the cost dimension", async () => {
    const world = await seedWorld();
    await (await createPolicyAuthority({ store: world.store, hasher: nodePolicyHasher })).publish(
      allowSetFor(world),
    );
    const receipt = await world.service.createExecution(
      {
        applicationId: world.applicationId,
        task: { kind: "summarize", input: "a1" },
        constraints: { maxCostMicroUsd: "5000" }, // platform ceiling is 1000
      },
      "c-cost",
      actorOf(world),
    );
    await expect(
      world.service.transition(
        {
          ...actorOf(world),
          applicationId: world.applicationId,
          executionId: receipt.executionId,
          command: "authorize",
        },
        "a-cost",
      ),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: { reason: expect.stringContaining("cost") },
    });
    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    expect(events[1]?.type).toBe("execution.policy-denied");
    expect(String(events[1]?.reference.reason)).toContain("exceeds the effective policy ceiling");
  });

  test("concurrent same-key authorize denials converge to one durable denial record", async () => {
    const world = await seedWorld();
    await (await createPolicyAuthority({ store: world.store, hasher: nodePolicyHasher })).publish(
      denySetFor(world),
    );
    const receipt = await createExecution(world, "c-concurrent");
    const actor = actorOf(world);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        world.service.transition(
          {
            ...actor,
            applicationId: world.applicationId,
            executionId: receipt.executionId,
            command: "authorize",
          },
          "a-concurrent",
        ),
      ),
    );
    const codes = results.map((result) =>
      result.status === "fulfilled" ? "none" : String((result.reason as PlatformError).code),
    );
    expect(new Set(codes)).toEqual(new Set(["POLICY_DENIED"]));
    const events = await world.service.listEvents(world.applicationId, receipt.executionId);
    expect(events.filter((event) => event.type === "execution.policy-denied")).toHaveLength(1);
    expect(
      (await world.service.getExecution(world.applicationId, receipt.executionId))?.status,
    ).toBe("CREATED");
  });
});
