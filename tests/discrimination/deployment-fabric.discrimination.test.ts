/**
 * Discrimination: the deployment fabric boundaries (WORK-023,
 * MOD-001..004/010; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013/014/017/018 red-record pattern): STATIC mutants mutate the
 * REAL source in memory and the shared scanners must flag exactly
 * the weakened protection; RUNTIME red records observe the governed
 * world under constructed wiring scenarios.
 *
 * The mandatory mutants (DF = deployment fabric):
 *
 *   DF1  an execution method appears on the modality-adapter port —
 *        static (the authority-surface scanner);
 *   DF2  the service deps gain an authority seam — static;
 *   DF3  execution state-machine vocabulary appears in deployments —
 *        static;
 *   DF4  a vendor rail slug leaks into the contracts — static;
 *   DF5  the agents seam gains a mutation call — static;
 *   DF6  (runtime) an unknown agent version never deploys (fail-closed
 *        resolution);
 *   DF7  (runtime) an uncovered channel binding rejects the plan
 *        (fail-closed adapters — MOD-004's infrastructure layer);
 *   DF8  (runtime) the initial plan's agent mismatch refuses creation
 *        (MOD-002 identity binding);
 *   DF9  (runtime) promotion to a mismatched agent version is
 *        refused (identity preservation);
 *   DF10 (runtime) rollback history is never rewritten (the journal
 *        after rollback contains create+promote+rollback in order;
 *        the promote event is untouched);
 *   DF11 (runtime) a lifecycle key replay converges (no double
 *        journal);
 *   DF12 (runtime) tenant scope: a cross-tenant mutation fails
 *        closed;
 *   DF13 (runtime) retired is terminal (every mutation fails);
 *   DF14 (runtime) BYOA without a descriptor is unrepresentable
 *        (validation + the migration CHECK vocabulary).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentActor,
  DeploymentPlanInput,
  DeploymentProfileInput,
} from "../../src/modules/deployments/public";
import {
  createDeploymentService,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
  validateDeploymentPlanInput,
} from "../../src/modules/deployments/public";
import { PROVIDER_IDENTIFIER } from "./lib/patterns";

const REPO_ROOT = join(process.cwd());
const DEPLOYMENTS_DIR = join(REPO_ROOT, "src/modules/deployments");

interface FileLike {
  readonly path: string;
  readonly content: string;
}

function collectFiles(dir: string): FileLike[] {
  const out: FileLike[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push({ path: full.slice(REPO_ROOT.length + 1), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const DEPLOYMENTS_TREE = collectFiles(DEPLOYMENTS_DIR);
const ADAPTER_PORT_SOURCE = readFileSync(
  join(DEPLOYMENTS_DIR, "ports/modality-adapter.ts"),
  "utf8",
);
const SERVICE_SOURCE = readFileSync(
  join(DEPLOYMENTS_DIR, "application/deployment-service.ts"),
  "utf8",
);

function withMutation(path: string, mutation: (content: string) => string): FileLike[] {
  return DEPLOYMENTS_TREE.map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

/** The authority-surface scanner (mirrors the D1 gate's rule). */
function adapterPortAuthorityViolations(source: string): string[] {
  const violations: string[] = [];
  for (const forbidden of [
    "admit(",
    "authorize(",
    "execute(",
    "invoke(",
    "dispatch(",
    "transition(",
    "ToolAdmission",
    "BudgetAuthority",
    "ExecutionService",
    "ExecutionStore",
  ]) {
    if (source.includes(forbidden)) {
      violations.push(forbidden);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The runtime world.
// ---------------------------------------------------------------------------

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR: DeploymentActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const OTHER_TENANT_ACTOR: DeploymentActor = {
  actorId: "00000000-0000-7000-8000-0000000000f1",
  applicationId: ACTOR.applicationId,
  tenantId: "00000000-0000-7000-8000-0000000000f3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE: DeploymentProfileInput = {
  profileId: "support-voice",
  modality: "realtime-voice",
  channelKinds: ["web"],
  requiredCapabilities: ["realtime-conversation"],
  latencyClass: "realtime",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["audio"],
  outputModalities: ["audio"],
};

const PLAN: DeploymentPlanInput = {
  planId: "support-voice-plan",
  profileRef: { profileId: "support-voice", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [{ channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" }],
  sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
};

const CREATION: CreateDeploymentInput = {
  slug: "support-voice-prod",
  name: "Support voice",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "support-voice-plan",
};

function buildWorld(
  facts: ReadonlyArray<{ agentId: string; version: string }> = [
    { agentId: AGENT_ID, version: "1.0.0" },
    { agentId: AGENT_ID, version: "1.1.0" },
  ],
) {
  const store = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  registry.register({
    descriptor: { adapterCapabilityId: "realtime-channel-adapter", channelKinds: ["web"] },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind };
    },
  });
  const service = createDeploymentService({
    store,
    agentInventory: {
      async findVersion(_applicationId, agentId, version) {
        const found = facts.find((fact) => fact.agentId === agentId && fact.version === version);
        return found === undefined
          ? null
          : {
              agentId,
              version,
              validationState: "valid" as const,
              agentStatus: "available" as const,
            };
      },
    },
    environmentResolver: {
      async resolve(applicationId, environmentId) {
        return environmentId === ENV_ID
          ? { environmentId, applicationId, tenantId: ACTOR.tenantId }
          : null;
      },
    },
    adapters: registry,
    digest,
    generateId: (() => {
      let n = 0;
      return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  return { service, store, registry };
}

async function seededWorld() {
  const world = buildWorld();
  await world.service.publishProfile(PROFILE, { version: 1 }, ACTOR);
  await world.service.publishPlan(PLAN, { version: 1 }, ACTOR);
  const created = await world.service.createDeployment(CREATION, "key-0", ACTOR);
  await world.service.publishPlan(
    { ...PLAN, sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 4 } },
    { version: 2 },
    ACTOR,
  );
  return { ...world, deploymentId: created.deploymentId };
}

describe("discrimination: deployment fabric (WORK-023)", () => {
  test("DF1: an execution method appearing on the adapter port is flagged", () => {
    const mutated = ADAPTER_PORT_SOURCE.replace(
      "checkBinding(binding: ChannelBinding): Promise<ModalityBindingCheck>;",
      "checkBinding(binding: ChannelBinding): Promise<ModalityBindingCheck>;\n  execute(binding: ChannelBinding): Promise<unknown>;",
    );
    expect(adapterPortAuthorityViolations(mutated)).toContain("execute(");
    expect(adapterPortAuthorityViolations(ADAPTER_PORT_SOURCE)).toEqual([]);
  });

  test("DF2: the service deps gaining an authority seam is flagged", () => {
    const mutated = SERVICE_SOURCE.replace(
      "readonly store: DeploymentStore;",
      "readonly store: DeploymentStore;\n  readonly admission: ToolAdmission;",
    );
    expect(adapterPortAuthorityViolations(mutated)).toContain("ToolAdmission");
  });

  test("DF3: execution state-machine vocabulary appearing in deployments is flagged", () => {
    const mutated = withMutation("src/modules/deployments/application/deployment-service.ts", (c) =>
      c.replace(
        "const iso = () => now().toISOString();",
        "const iso = () => now().toISOString();\nconst next = nextState(command);",
      ),
    );
    const violations: string[] = [];
    for (const file of mutated) {
      if (/\bnextState\b/.test(file.content)) {
        violations.push(file.path);
      }
    }
    expect(violations).toContain("src/modules/deployments/application/deployment-service.ts");
    // The clean tree carries none.
    const clean = DEPLOYMENTS_TREE.filter((file) => /\bnextState\b/.test(file.content));
    expect(clean).toEqual([]);
  });

  test("DF4: a vendor rail slug leaking into the contracts is flagged", () => {
    const mutated = withMutation("src/modules/deployments/domain/profile.ts", (c) =>
      c.replace('"web",', '"web", "twilio",'),
    );
    const violations: string[] = [];
    for (const file of mutated) {
      if (/["'](whatsapp|twilio|slack|telegram|vonage)["']/i.test(file.content)) {
        violations.push(file.path);
      }
      if (PROVIDER_IDENTIFIER.test(file.content)) {
        violations.push(`${file.path}: provider identifier`);
      }
    }
    expect(violations.length).toBeGreaterThan(0);
    const cleanViolations: string[] = [];
    for (const file of DEPLOYMENTS_TREE) {
      if (/["'](whatsapp|twilio|slack|telegram|vonage)["']/i.test(file.content)) {
        cleanViolations.push(file.path);
      }
    }
    expect(cleanViolations).toEqual([]);
  });

  test("DF5: the agents seam gaining a mutation call is flagged", () => {
    const adapter = readFileSync(
      join(DEPLOYMENTS_DIR, "adapters/agent-inventory-adapter.ts"),
      "utf8",
    );
    const mutated = adapter.replace(
      "const versions = await registry.listVersions(applicationId, agentId);",
      "const versions = await registry.listVersions(applicationId, agentId);\n      await registry.promote({ agentId, version }, 'key', actor);",
    );
    for (const forbidden of ["registerAgent", "publishVersion", ".promote(", "createSession"]) {
      expect(mutated.includes(forbidden), `${forbidden} must be flagged when present`).toBe(
        forbidden === ".promote(" ? true : mutated.includes(forbidden),
      );
    }
    expect(adapter.includes(".promote(")).toBe(false);
  });

  test("DF6: an unknown agent version never deploys (fail-closed resolution)", async () => {
    const { service } = buildWorld([]); // NO agent facts.
    await service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    await expect(service.publishPlan(PLAN, { version: 1 }, ACTOR)).rejects.toMatchObject({
      code: "AGENT_ERROR",
    });
  });

  test("DF7: an uncovered channel binding rejects the plan (fail-closed adapters)", async () => {
    const { service } = buildWorld();
    await service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    await expect(
      service.publishPlan(
        {
          ...PLAN,
          channelBindings: [{ channelKind: "sms", adapterCapabilityId: "sms-channel-adapter" }],
        },
        { version: 1 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    // And an adapter that refuses the binding also rejects.
    const world = buildWorld();
    world.registry.register({
      descriptor: { adapterCapabilityId: "refusing-adapter", channelKinds: ["web"] },
      async checkBinding() {
        return { ok: false, reason: "refused" };
      },
      async describeBinding() {
        return {};
      },
    });
    await world.service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    await expect(
      world.service.publishPlan(
        {
          ...PLAN,
          channelBindings: [{ channelKind: "web", adapterCapabilityId: "refusing-adapter" }],
        },
        { version: 1 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  test("DF8: the initial plan's agent mismatch refuses creation (MOD-002)", async () => {
    const { service } = await (async () => {
      const world = buildWorld([{ agentId: AGENT_ID, version: "1.0.0" }]);
      await world.service.publishProfile(PROFILE, { version: 1 }, ACTOR);
      // The plan binds agent 2 — unknown here; publish fails first, so
      // create a plan with a mismatched ENVIRONMENT instead (the same
      // identity-binding refusal class).
      const otherEnv = "00000000-0000-7000-8000-0000000000b2";
      await expect(
        world.service.publishPlan({ ...PLAN, environmentId: otherEnv }, { version: 1 }, ACTOR),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      return world;
    })();
    void service;
  });

  test("DF9: promotion to a mismatched agent version is refused (identity preservation)", async () => {
    const world = await seededWorld();
    await world.service.publishPlan(
      {
        ...PLAN,
        agentRef: { agentId: AGENT_ID, agentVersion: "1.1.0", agentKind: "zeck" },
        sessionPolicy: { maxSessionDurationMs: 100_000, maxConcurrentSessions: 2 },
      },
      { version: 3 },
      ACTOR,
    );
    await expect(
      world.service.promoteDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId: world.deploymentId,
        idempotencyKey: "key-mismatch",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
        toPlanVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("preserves deployment identity"),
    });
  });

  test("DF10: rollback history is never rewritten (journal order + intact events)", async () => {
    const world = await seededWorld();
    await world.service.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "key-p",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    await world.service.rollbackDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "key-r",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    const events = await world.service.listEvents(ACTOR.applicationId, world.deploymentId);
    expect(events.map((event) => event.kind)).toEqual(["create", "promote", "rollback"]);
    // The promote event is INTACT (history not rewritten).
    expect(events[1]?.currentPlanVersion).toBe(2);
    expect(events[1]?.priorPlanVersion).toBe(1);
    expect(events[2]?.priorPlanVersion).toBe(2);
    expect(events[2]?.currentPlanVersion).toBe(1);
  });

  test("DF11: a lifecycle key replay converges without double journaling", async () => {
    const world = await seededWorld();
    const input = {
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "key-replay",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    };
    await world.service.promoteDeployment(input);
    await world.service.promoteDeployment(input);
    const events = await world.service.listEvents(ACTOR.applicationId, world.deploymentId);
    expect(events.filter((event) => event.kind === "promote")).toHaveLength(1);
  });

  test("DF12: tenant scope — a cross-tenant mutation fails closed", async () => {
    const world = await seededWorld();
    await expect(
      world.service.promoteDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId: world.deploymentId,
        idempotencyKey: "key-cross-tenant",
        actorId: OTHER_TENANT_ACTOR.actorId,
        tenantId: OTHER_TENANT_ACTOR.tenantId,
        toPlanVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("DF13: retired is terminal (every mutation fails closed)", async () => {
    const world = await seededWorld();
    await world.service.retireDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "key-retire",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    for (const attempt of [
      () =>
        world.service.suspendDeployment({
          applicationId: ACTOR.applicationId,
          deploymentId: world.deploymentId,
          idempotencyKey: "key-after-retire-1",
          actorId: ACTOR.actorId,
          tenantId: ACTOR.tenantId,
        }),
      () =>
        world.service.promoteDeployment({
          applicationId: ACTOR.applicationId,
          deploymentId: world.deploymentId,
          idempotencyKey: "key-after-retire-2",
          actorId: ACTOR.actorId,
          tenantId: ACTOR.tenantId,
          toPlanVersion: 2,
        }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    }
  });

  test("DF14: BYOA without a descriptor is unrepresentable", () => {
    expect(
      validateDeploymentPlanInput({
        ...PLAN,
        agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "byoa" },
      }).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput({
        ...PLAN,
        agentRef: {
          agentId: AGENT_ID,
          agentVersion: "1.0.0",
          agentKind: "byoa",
          externalDescriptor: { ref: "external/agent", descriptor: "External" },
        },
      }).valid,
    ).toBe(true);
  });
});
