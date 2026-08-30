/**
 * Unit — the agent registry (WORK-011; AGT-003/AGT-004/ACP-001/ACP-002).
 *
 * Identity convergence on duplicate registration (M17), immutable
 * version publication with digest conflicts, promotion/rollback as
 * append-only selections that never mutate artifacts (M15/M16), and the
 * agent identity lifecycle (registered → validated → available ⇄
 * suspended → retired).
 */

import { describe, expect, test } from "vitest";
import type { AgentDefinition } from "../../../src/modules/agents/public";
import {
  canonicalDefinitionJson,
  createAgentRegistry,
  InMemoryAgentStore,
  validateAgentDefinition,
} from "../../../src/modules/agents/public";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR_ID, APPLICATION_ID, TENANT_ID } from "./fakes";

const generateId = (() => {
  let counter = 0;
  return () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
})();

let clock = 0;
const now = () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + clock++ * 1000);

const hashDefinition = (canonical: string) => `sha256:${canonical.length}:${canonical.slice(-12)}`;

const DEFINITION: AgentDefinition = {
  instructions: "Classify support tickets.",
  requestedPermissions: { tools: ["search-web"], secretRefs: [] },
  approvalRequiredActions: ["external-write"],
  isolation: "container",
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

const actor = () => ({ actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID });

function makeRegistry() {
  const store = new InMemoryAgentStore();
  const registry = createAgentRegistry({ store, generateId, now, hashDefinition });
  return { store, registry };
}

async function registeredAgent(registry: ReturnType<typeof createAgentRegistry>) {
  const agent = await registry.registerAgent(
    { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "support", name: "Support" },
    "key-register-1",
    actor(),
  );
  const version = await registry.publishVersion(
    { agentId: agent.id, version: "1.0.0", definition: DEFINITION },
    "key-version-1",
    actor(),
  );
  return { agent, version };
}

describe("agent registration (ACP-001)", () => {
  test("registers a stable identity with catalog fields", async () => {
    const { registry } = makeRegistry();
    const agent = await registry.registerAgent(
      { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "support", name: "Support" },
      "k1",
      actor(),
    );
    expect(agent.status).toBe("registered");
    expect(agent.slug).toBe("support");
    expect(await registry.getAgentBySlug(APPLICATION_ID, "support")).toMatchObject({
      id: agent.id,
    });
  });

  test("duplicate registration converges on the SAME durable identity (M17)", async () => {
    const { registry } = makeRegistry();
    const first = await registry.registerAgent(
      { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "support", name: "Support" },
      "k1",
      actor(),
    );
    const second = await registry.registerAgent(
      { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "support", name: "Renamed" },
      "k2",
      actor(),
    );
    expect(second.id).toBe(first.id);
    const all = await registry.listVersions(APPLICATION_ID, first.id);
    expect(all).toEqual([]);
  });

  test("scope mismatch between input and actor fails closed", async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.registerAgent(
        {
          applicationId: APPLICATION_ID,
          tenantId: "00000000-0000-7000-8000-0000000000ff",
          slug: "support",
          name: "Support",
        },
        "k1",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});

describe("version publication (ACP-002)", () => {
  test("publishes a validated immutable artifact and advances the lifecycle", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    expect(version.validationState).toBe("valid");
    expect(version.definitionDigest).toBe(hashDefinition(canonicalDefinitionJson(DEFINITION)));
    expect((await registry.getAgent(APPLICATION_ID, agent.id))?.status).toBe("validated");
  });

  test("same version + same definition converges; same version + different definition fails (M15)", async () => {
    const { registry } = makeRegistry();
    const { agent } = await registeredAgent(registry);
    const replay = await registry.publishVersion(
      { agentId: agent.id, version: "1.0.0", definition: DEFINITION },
      "key-version-1",
      actor(),
    );
    expect(replay.validationState).toBe("valid");
    await expect(
      registry.publishVersion(
        {
          agentId: agent.id,
          version: "1.0.0",
          definition: { ...DEFINITION, instructions: "Different." },
        },
        "key-version-2",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("invalid definitions (including raw secrets) never become artifacts (M6)", async () => {
    const { registry } = makeRegistry();
    const agent = await registry.registerAgent(
      { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "support", name: "Support" },
      "k1",
      actor(),
    );
    const badDefinition = { ...DEFINITION, instructions: "use sk-abcdefghij0123456789" };
    expect(validateAgentDefinition(badDefinition).valid).toBe(false);
    await expect(
      registry.publishVersion(
        { agentId: agent.id, version: "1.0.0", definition: badDefinition },
        "kv",
        actor(),
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});

describe("promotion and rollback (ACP-002)", () => {
  test("promotion selects a validated version and makes the agent available", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    const selection = await registry.promote(
      { agentId: agent.id, targetVersionId: version.id },
      "key-promote-1",
      actor(),
    );
    expect(selection.kind).toBe("promotion");
    expect(selection.selectedVersionId).toBe(version.id);
    expect((await registry.getAgent(APPLICATION_ID, agent.id))?.status).toBe("available");
    expect((await registry.currentSelection(APPLICATION_ID, agent.id))?.selectedVersionId).toBe(
      version.id,
    );
  });

  test("rollback selects a previously valid version WITHOUT mutating artifacts (M16)", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    await registry.promote({ agentId: agent.id, targetVersionId: version.id }, "kp1", actor());
    const v2 = await registry.publishVersion(
      {
        agentId: agent.id,
        version: "2.0.0",
        definition: { ...DEFINITION, instructions: "V2 instructions." },
      },
      "kv2",
      actor(),
    );
    await registry.promote({ agentId: agent.id, targetVersionId: v2.id }, "kp2", actor());

    // Roll back to 1.0.0.
    const rollback = await registry.rollback(
      { agentId: agent.id, targetVersionId: version.id, reason: "v2 regression" },
      "krollback",
      actor(),
    );
    expect(rollback.kind).toBe("rollback");
    expect(rollback.rollbackOf).not.toBeNull();
    expect((await registry.currentSelection(APPLICATION_ID, agent.id))?.selectedVersionId).toBe(
      version.id,
    );

    // Artifacts are untouched: same identity, same digest, same content.
    const versions = await registry.listVersions(APPLICATION_ID, agent.id);
    expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    const v1After = versions.find((v) => v.version === "1.0.0");
    const v2After = versions.find((v) => v.version === "2.0.0");
    expect(v1After?.definitionDigest).toBe(version.definitionDigest);
    expect(v1After?.createdAt).toBe(version.createdAt);
    expect(v2After?.createdAt).toBe(v2.createdAt);

    // The selection journal records the full history.
    const selections = await registry.listSelections(APPLICATION_ID, agent.id);
    expect(selections.map((s) => s.kind)).toEqual(["promotion", "promotion", "rollback"]);
  });

  test("rollback to the already-selected version converges", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    await registry.promote({ agentId: agent.id, targetVersionId: version.id }, "kp1", actor());
    const rollback = await registry.rollback(
      { agentId: agent.id, targetVersionId: version.id },
      "kr-same",
      actor(),
    );
    expect(rollback.selectedVersionId).toBe(version.id);
    expect(rollback.kind).toBe("promotion"); // converged on the existing selection
  });

  test("the same selection key with a different target fails", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    const v2 = await registry.publishVersion(
      { agentId: agent.id, version: "2.0.0", definition: DEFINITION },
      "kv2",
      actor(),
    );
    await registry.promote({ agentId: agent.id, targetVersionId: version.id }, "same-key", actor());
    await expect(
      registry.promote({ agentId: agent.id, targetVersionId: v2.id }, "same-key", actor()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

describe("agent lifecycle", () => {
  test("suspend/resume/retire follow the explicit transitions", async () => {
    const { registry } = makeRegistry();
    const { agent, version } = await registeredAgent(registry);
    await registry.promote({ agentId: agent.id, targetVersionId: version.id }, "kp", actor());
    const suspended = await registry.suspend(agent.id, "ks", actor());
    expect(suspended.status).toBe("suspended");
    const resumed = await registry.resume(agent.id, "kr", actor());
    expect(resumed.status).toBe("available");
    const retired = await registry.retire(agent.id, "kret", actor());
    expect(retired.status).toBe("retired");
    // Retired is terminal: no further transitions.
    await expect(registry.resume(agent.id, "kr2", actor())).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("an unregistered agent cannot be operated on (tenant scope holds)", async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.promote(
        { agentId: "00000000-0000-7000-8000-00000000dead", targetVersionId: "x" },
        "k",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
  });
});
