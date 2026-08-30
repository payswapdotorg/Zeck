/**
 * Real-PostgreSQL — the agent registry over the SQL store (WORK-011;
 * AGT-003/AGT-004/ACP-001/ACP-002; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY).
 *
 * Proves against real PostgreSQL:
 *   - agent identity uniqueness + duplicate-registration convergence (M17,
 *     including CONCURRENT duplicates racing on the unique index);
 *   - immutable versions through the real adapter (no update path exists;
 *     the same version + same digest converges; a different digest fails);
 *   - promotion/rollback as append-only selections that never touch the
 *     artifacts (M16) — rollback selects a previously valid version;
 *   - terminal agent lifecycle (retired is terminal).
 */

import { expect, test } from "vitest";
import type { AgentDefinition } from "../../../src/modules/agents/public";
import { type AgentsPgWorld, BASELINE_DEFINITION, seedAgentsWorld } from "./agents-world";
import { definePgSuite } from "./harness";

const DEFINITION: AgentDefinition = {
  instructions: "Triage the inbox.",
  requestedPermissions: { tools: ["search-web"], secretRefs: [] },
  approvalRequiredActions: ["external-send"],
  isolation: "container",
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

definePgSuite("agents registry (real PG)", (ctx) => {
  interface Seeded {
    readonly world: AgentsPgWorld;
    readonly agentId: string;
  }

  async function seed(): Promise<Seeded> {
    const world = await seedAgentsWorld(ctx.port);
    const agentId = await world.registerBaselineAgent("triage");
    return { world, agentId };
  }

  test("duplicate agent registration converges on ONE identity (M17)", async () => {
    const { world } = await seed();
    const first = await world.registry.registerAgent(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        slug: "triage",
        name: "Triage Agent",
      },
      "register-triage",
      world.actor(),
    );
    const second = await world.registry.registerAgent(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        slug: "triage",
        name: "Whatever",
      },
      "register-triage-2",
      world.actor(),
    );
    expect(second.id).toBe(first.id);
  });

  test("CONCURRENT duplicate registration converges on one durable identity (M17 race)", async () => {
    const { world } = await seed();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        world.registry.registerAgent(
          {
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            slug: "racer",
            name: `Racer ${index}`,
          },
          `register-racer-${index}`,
          world.actor(),
        ),
      ),
    );
    const ids = new Set(results.map((agent) => agent.id));
    expect(ids.size).toBe(1);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM agents.agents WHERE application_id = $1 AND slug = 'racer'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("versions are immutable through the adapter: same version converges, different digest fails (M15)", async () => {
    const { world, agentId } = await seed();
    const versions = await world.registry.listVersions(world.applicationId, agentId);
    expect(versions).toHaveLength(1);
    const original = versions.find((v) => v.version === "1.0.0");
    expect(original).toBeDefined();
    if (original === undefined) return;

    // Same version + same definition → converge on the SAME artifact.
    const replay = await world.registry.publishVersion(
      { agentId, version: "1.0.0", definition: BASELINE_DEFINITION },
      "publish-replay",
      world.actor(),
    );
    expect(replay.id).toBe(original.id);
    expect(replay.definitionDigest).toBe(original.definitionDigest);

    // Same version + DIFFERENT definition → typed rejection.
    await expect(
      world.registry.publishVersion(
        { agentId, version: "1.0.0", definition: { ...DEFINITION, instructions: "Different." } },
        "publish-conflict",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    // Exactly one version row exists.
    const after = await world.registry.listVersions(world.applicationId, agentId);
    expect(after).toHaveLength(1);
  });

  test("rollback selects a previously valid version WITHOUT mutating artifacts (M16)", async () => {
    const { world, agentId } = await seed();
    const versions1 = await world.registry.listVersions(world.applicationId, agentId);
    const v1 = versions1.find((v) => v.version === "1.0.0");
    expect(v1).toBeDefined();
    if (v1 === undefined) return;
    const v2 = await world.registry.publishVersion(
      {
        agentId,
        version: "2.0.0",
        definition: { ...DEFINITION, instructions: "V2 — riskier autonomy." },
      },
      "publish-2",
      world.actor(),
    );
    await world.registry.promote({ agentId, targetVersionId: v2.id }, "promote-2", world.actor());

    // Roll back to v1.
    const rollback = await world.registry.rollback(
      { agentId, targetVersionId: v1.id, reason: "v2 regression" },
      "rollback-1",
      world.actor(),
    );
    expect(rollback.kind).toBe("rollback");
    expect(rollback.selectedVersionId).toBe(v1.id);
    expect(rollback.rollbackOf).not.toBeNull();

    // The current selection points at v1.
    const current = await world.registry.currentSelection(world.applicationId, agentId);
    expect(current?.selectedVersionId).toBe(v1.id);

    // Artifacts are byte-identical to their creation state.
    const versions = await world.registry.listVersions(world.applicationId, agentId);
    const v1After = versions.find((v) => v.version === "1.0.0");
    const v2After = versions.find((v) => v.version === "2.0.0");
    expect(v1After?.definitionDigest).toBe(v1.definitionDigest);
    expect(v1After?.createdAt).toBe(v1.createdAt);
    expect(v2After?.definitionDigest).toBe(v2.definitionDigest);
    expect(v2After?.createdAt).toBe(v2.createdAt);

    // The selection journal is append-only and complete.
    const selections = await world.registry.listSelections(world.applicationId, agentId);
    expect(selections.map((s) => s.kind)).toEqual(["promotion", "promotion", "rollback"]);
    // Physical: selections cannot be updated or deleted.
    await expect(
      ctx.port.execute({
        sql: "UPDATE agents.agent_selections SET selected_version_id = $1 WHERE id = $2",
        parameters: [v2.id, selections[0]?.id],
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM agents.agent_selections WHERE id = $1",
        parameters: [selections[0]?.id],
      }),
    ).rejects.toThrow(/append-only/);
  });

  test("retired agents are terminal and publish nothing further", async () => {
    const { world, agentId } = await seed();
    const retired = await world.registry.retire(agentId, "retire-1", world.actor());
    expect(retired.status).toBe("retired");
    await expect(
      world.registry.publishVersion(
        { agentId, version: "3.0.0", definition: DEFINITION },
        "publish-post-retire",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
    await expect(
      world.registry.resume(agentId, "resume-post-retire", world.actor()),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});
