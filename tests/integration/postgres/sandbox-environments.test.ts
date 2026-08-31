/**
 * Real-PostgreSQL — the environment catalog (WORK-012, ENV-001): durable
 * identity convergence (including the CONCURRENT race on the unique
 * index), content-addressed write-once specifications, and the guarded
 * lifecycle.
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { PROCESS_SPEC, seedSandboxWorld } from "./sandbox-world";

definePgSuite("sandbox environments (real PG)", (ctx) => {
  test("registers with stable identity; identical re-registration converges on the durable record", async () => {
    const world = await seedSandboxWorld(ctx.port);
    const first = await world.catalog.register(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        slug: "analysis",
        name: "Analysis",
        spec: PROCESS_SPEC,
      },
      "env-key-1",
      world.actor(),
    );
    const second = await world.catalog.register(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        slug: "analysis",
        name: "Analysis",
        spec: PROCESS_SPEC,
      },
      "env-key-2",
      world.actor(),
    );
    expect(second.id).toBe(first.id);
    expect(second.specDigest).toBe(first.specDigest);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.compute_environments WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("CONCURRENT duplicate registration converges on ONE identity (unique-index arbitration)", async () => {
    const world = await seedSandboxWorld(ctx.port);
    const input = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      slug: "race",
      name: "Race",
      spec: PROCESS_SPEC,
    };
    const actor = world.actor();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => world.catalog.register(input, `race-key-${i}`, actor)),
    );
    expect(new Set(results.map((record) => record.id)).size).toBe(1);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.compute_environments WHERE application_id = $1 AND slug = 'race'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("a different specification under the same slug is an identity conflict (write-once)", async () => {
    const world = await seedSandboxWorld(ctx.port);
    await world.catalog.register(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        slug: "analysis",
        name: "Analysis",
        spec: PROCESS_SPEC,
      },
      "env-key-1",
      world.actor(),
    );
    await expect(
      world.catalog.register(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          slug: "analysis",
          name: "Analysis",
          spec: {
            ...PROCESS_SPEC,
            limits: {
              ...(PROCESS_SPEC.limits as typeof PROCESS_SPEC.limits & object),
              cpuMilliCores: 1000,
            },
          },
        },
        "env-key-2",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
  });

  test("the lifecycle is guarded: suspend/resume/retire with retired terminal-immutable", async () => {
    const world = await seedSandboxWorld(ctx.port);
    const environmentId = await world.registerEnvironment("analysis", PROCESS_SPEC);
    expect(
      (await world.catalog.suspend(world.applicationId, environmentId, "s-1", world.actor()))
        .status,
    ).toBe("suspended");
    expect(
      (await world.catalog.resume(world.applicationId, environmentId, "r-1", world.actor())).status,
    ).toBe("available");
    expect(
      (await world.catalog.retire(world.applicationId, environmentId, "t-1", world.actor())).status,
    ).toBe("retired");
    await expect(
      world.catalog.resume(world.applicationId, environmentId, "r-2", world.actor()),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // physical immutability of the retired row:
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.compute_environments SET status = 'available' WHERE id = $1",
        parameters: [environmentId],
      }),
    ).rejects.toThrow(/terminal-immutable/i);
  });

  test("cross-scope registration is rejected (M9/M10 discipline)", async () => {
    const world = await seedSandboxWorld(ctx.port);
    await expect(
      world.catalog.register(
        {
          applicationId: "00000000-0000-7000-8000-00000000dead",
          tenantId: world.tenantId,
          slug: "foreign",
          name: "Foreign",
          spec: PROCESS_SPEC,
        },
        "k",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});
