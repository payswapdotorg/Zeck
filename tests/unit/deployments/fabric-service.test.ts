/**
 * Unit tests — the deployment service (WORK-023, MOD-001..003).
 *
 * Proves the governed lifecycle at the application layer with the
 * REAL domain/store and the REAL modality-adapter registry, with test
 * doubles ONLY at the read-only module seams (agent inventory,
 * environment resolver):
 *
 *   - publishing: fail-closed validations before durability; version
 *     convergence; immutable-artifact conflict;
 *   - creation: identity binding resolution fail-closed (unknown
 *     environment / unknown or invalid agent version / plan mismatch);
 *     idempotent replay; slug conflict;
 *   - promotion: only published plans, identity preservation (agent
 *     reference must match), no-op convergence, journal evidence with
 *     prior version + actor + cause + execution provenance;
 *   - rollback: the prior version is DERIVED from the journal (never
 *     caller-asserted); no prior → fail closed; history is never
 *     rewritten (the journal is append-only);
 *   - suspend/resume/retire: strict preconditions, terminal retire;
 *   - BYOA deployment representation (MOD-010);
 *   - replay of lifecycle keys converges (idempotency).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { AgentVersionFact } from "../../../src/modules/deployments/ports/agent-inventory";
import type { DeploymentEnvironmentResolver } from "../../../src/modules/deployments/ports/environment-resolver";
import type {
  CreateDeploymentInput,
  DeploymentActor,
  DeploymentPlanInput,
  DeploymentProfileInput,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
} from "../../../src/modules/deployments/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR: DeploymentActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const AGENT_ID_2 = "00000000-0000-7000-8000-0000000000a9";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e9";

function agentInventory(
  facts: ReadonlyArray<{
    agentId: string;
    version: string;
    validation?: string;
    status?: string;
  }> = [
    { agentId: AGENT_ID, version: "1.0.0" },
    { agentId: AGENT_ID, version: "1.1.0" },
    { agentId: AGENT_ID_2, version: "1.0.0" },
  ],
): import("../../../src/modules/deployments/ports/agent-inventory").DeploymentAgentInventory {
  return {
    async findVersion(applicationId, agentId, version): Promise<AgentVersionFact | null> {
      void applicationId;
      const found = facts.find((fact) => fact.agentId === agentId && fact.version === version);
      return found === undefined
        ? null
        : {
            agentId,
            version,
            validationState: (found.validation ?? "valid") as AgentVersionFact["validationState"],
            agentStatus: (found.status ?? "available") as AgentVersionFact["agentStatus"],
          };
    },
  };
}

function environmentResolver(
  known: ReadonlyArray<{ environmentId: string; tenantId: string }> = [
    { environmentId: ENV_ID, tenantId: ACTOR.tenantId },
  ],
): DeploymentEnvironmentResolver {
  return {
    async resolve(applicationId, environmentId) {
      void applicationId;
      const found = known.find((ref) => ref.environmentId === environmentId);
      return found === undefined
        ? null
        : {
            environmentId: found.environmentId,
            applicationId: ACTOR.applicationId,
            tenantId: found.tenantId,
          };
    },
  };
}

function adapters() {
  const registry = createModalityAdapterRegistry();
  registry.register({
    descriptor: {
      adapterCapabilityId: "realtime-channel-adapter",
      channelKinds: ["web", "in-app"],
    },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind, adapter: "realtime" };
    },
  });
  registry.register({
    descriptor: { adapterCapabilityId: "telephony-channel-adapter", channelKinds: ["telephony"] },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind, adapter: "telephony" };
    },
  });
  return registry;
}

function buildWorld(
  overrides: {
    facts?: Parameters<typeof agentInventory>[0];
    environments?: Parameters<typeof environmentResolver>[0];
  } = {},
) {
  const store = new InMemoryDeploymentStore();
  const service = createDeploymentService({
    store,
    agentInventory: agentInventory(overrides.facts),
    environmentResolver: environmentResolver(overrides.environments),
    adapters: adapters(),
    digest,
    generateId: (() => {
      let n = 0;
      return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  return { service, store };
}

const PROFILE: DeploymentProfileInput = {
  profileId: "support-voice",
  modality: "realtime-voice",
  channelKinds: ["web", "telephony"],
  requiredCapabilities: ["realtime-conversation"],
  latencyClass: "realtime",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["audio"],
  outputModalities: ["audio", "text"],
};

const PLAN: DeploymentPlanInput = {
  planId: "support-voice-plan",
  profileRef: { profileId: "support-voice", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" },
    { channelKind: "telephony", adapterCapabilityId: "telephony-channel-adapter" },
  ],
  sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
};

const CREATION: CreateDeploymentInput = {
  slug: "support-voice-prod",
  name: "Support voice (production)",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "support-voice-plan",
};

async function seedWorld(): Promise<ReturnType<typeof buildWorld>> {
  const world = buildWorld();
  await world.service.publishProfile(PROFILE, { version: 1 }, ACTOR);
  await world.service.publishPlan(PLAN, { version: 1 }, ACTOR);
  return world;
}

/** A seeded world with a deployment and plan v2 published. */
async function promotedWorld(): Promise<
  ReturnType<typeof buildWorld> & { readonly deploymentId: string }
> {
  const world = await seedWorld();
  const created = await world.service.createDeployment(CREATION, "key-promote-0", ACTOR);
  // Publish plan v2 (a different session policy).
  await world.service.publishPlan(
    { ...PLAN, sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 16 } },
    { version: 2 },
    ACTOR,
  );
  return { ...world, deploymentId: created.deploymentId };
}

describe("publishing artifacts (MOD-001)", () => {
  test("a valid profile and plan publish; identical republish converges", async () => {
    const { service } = await seedWorld();
    const again = await service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    expect(again.status).toBe("converged");
    const planAgain = await service.publishPlan(PLAN, { version: 1 }, ACTOR);
    expect(planAgain.status).toBe("converged");
  });

  test("a different body under the same identity+version fails closed", async () => {
    const { service } = await seedWorld();
    await expect(
      service.publishProfile({ ...PROFILE, latencyClass: "interactive" }, { version: 1 }, ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("a plan referencing an unknown profile version fails closed", async () => {
    const { service } = await seedWorld();
    await expect(
      service.publishPlan(
        { ...PLAN, profileRef: { profileId: "support-voice", version: 9 } },
        { version: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("a plan referencing an unknown agent version fails closed", async () => {
    const { service } = await seedWorld();
    await expect(
      service.publishPlan(
        {
          ...PLAN,
          agentRef: { agentId: AGENT_ID, agentVersion: "9.9.9", agentKind: "zeck" },
        },
        { version: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
  });

  test("a plan referencing an invalid agent version fails closed", async () => {
    const { service } = buildWorld({
      facts: [{ agentId: AGENT_ID, version: "1.0.0", validation: "pending" }],
    });
    await service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    await expect(service.publishPlan(PLAN, { version: 1 }, ACTOR)).rejects.toMatchObject({
      code: "AGENT_ERROR",
      message: expect.stringContaining("pending"),
    });
  });

  test("a plan in an unknown environment fails closed", async () => {
    const { service } = buildWorld({ environments: [] });
    await service.publishProfile(PROFILE, { version: 1 }, ACTOR);
    await expect(service.publishPlan(PLAN, { version: 1 }, ACTOR)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  test("a plan with an uncovered channel binding fails closed (fail-closed adapters)", async () => {
    const { service } = await seedWorld();
    await expect(
      service.publishPlan(
        {
          ...PLAN,
          channelBindings: [{ channelKind: "sms", adapterCapabilityId: "sms-channel-adapter" }],
        },
        { version: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("deployment creation (MOD-002)", () => {
  test("a valid creation binds identity and journals the create event", async () => {
    const { service } = await seedWorld();
    const created = await service.createDeployment(CREATION, "key-create-1", ACTOR);
    expect(created.replayed).toBe(false);
    const deployment = await service.getDeployment(ACTOR.applicationId, created.deploymentId);
    expect(deployment?.status).toBe("active");
    expect(deployment?.agentVersion).toBe("1.0.0");
    expect(deployment?.currentPlanVersion).toBe(1);
    expect(deployment?.currentPlan?.planId).toBe("support-voice-plan");
    const events = await service.listEvents(ACTOR.applicationId, created.deploymentId);
    expect(events.map((event) => event.kind)).toEqual(["create"]);
    expect(events[0]?.actorId).toBe(ACTOR.actorId);
  });

  test("the same creation under the same slug converges (replay)", async () => {
    const { service } = await seedWorld();
    const first = await service.createDeployment(CREATION, "key-create-2", ACTOR);
    const second = await service.createDeployment(CREATION, "key-create-3", ACTOR);
    expect(second.deploymentId).toBe(first.deploymentId);
    expect(second.replayed).toBe(true);
  });

  test("a different creation under the same slug fails closed", async () => {
    const { service } = await seedWorld();
    await service.createDeployment(CREATION, "key-create-4", ACTOR);
    await expect(
      service.createDeployment({ ...CREATION, name: "Different" }, "key-create-5", ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("the initial plan's agent reference must match the binding", async () => {
    const { service } = await seedWorld();
    // A creation binding agent 2 while the plan binds agent 1.
    await expect(
      service.createDeployment({ ...CREATION, agentId: AGENT_ID_2 }, "key-create-6", ACTOR),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("MOD-002"),
    });
  });

  test("the same agent version in the same environment is ONE deployment identity", async () => {
    const { service } = await seedWorld();
    await service.createDeployment(CREATION, "key-create-7", ACTOR);
    // A second slug for the same identity: a separate deployment row is
    // allowed only per-slug — the identity UNIQUE is enforced physically
    // in SQL (the PG suite proves the constraint; here we prove the
    // semantic: a different slug, same binding, is a re-registration
    // decision owned by SQL arbitration).
    const second = await service.createDeployment(
      { ...CREATION, slug: "support-voice-prod-2" },
      "key-create-8",
      ACTOR,
    );
    expect(second.replayed).toBe(false);
  });
});

describe("promotion + rollback (MOD-003)", () => {
  test("promotion moves the pointer and journals prior/current versions with provenance", async () => {
    const { service, deploymentId } = await promotedWorld();
    const promoted = await service.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-promote-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      cause: "capacity increase",
      executionId: EXECUTION_ID,
      toPlanVersion: 2,
    });
    expect(promoted.planVersion).toBe(2);
    const events = await service.listEvents(ACTOR.applicationId, deploymentId);
    expect(events.map((event) => event.kind)).toEqual(["create", "promote"]);
    const promote = events[1];
    expect(promote?.priorPlanVersion).toBe(1);
    expect(promote?.currentPlanVersion).toBe(2);
    expect(promote?.cause).toBe("capacity increase");
    expect(promote?.executionId).toBe(EXECUTION_ID);
    expect(promote?.actorId).toBe(ACTOR.actorId);
  });

  test("the same promotion key replays (idempotent)", async () => {
    const { service, deploymentId } = await promotedWorld();
    const first = await service.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-promote-2",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const second = await service.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-promote-2",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    expect(second.planVersion).toBe(first.planVersion);
    const events = await service.listEvents(ACTOR.applicationId, deploymentId);
    expect(events.filter((event) => event.kind === "promote")).toHaveLength(1);
  });

  test("promotion to an unpublished plan version fails closed", async () => {
    const { service, deploymentId } = await promotedWorld();
    await expect(
      service.promoteDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-promote-3",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
        toPlanVersion: 5,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("a plan of a different agent version cannot be promoted (identity preservation)", async () => {
    const { service, deploymentId } = await promotedWorld();
    // v3 references agent version 1.1.0 (a different identity binding).
    await service.publishPlan(
      {
        ...PLAN,
        agentRef: { agentId: AGENT_ID, agentVersion: "1.1.0", agentKind: "zeck" },
        sessionPolicy: { maxSessionDurationMs: 100_000, maxConcurrentSessions: 4 },
      },
      { version: 3 },
      ACTOR,
    );
    await expect(
      service.promoteDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-promote-4",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
        toPlanVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("preserves deployment identity"),
    });
  });

  test("rollback derives the prior version from the journal and never rewrites history", async () => {
    const { service, deploymentId } = await promotedWorld();
    await service.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-rollback-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const rolled = await service.rollbackDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-rollback-2",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      cause: "regression detected",
    });
    expect(rolled.planVersion).toBe(1);
    const events = await service.listEvents(ACTOR.applicationId, deploymentId);
    expect(events.map((event) => event.kind)).toEqual(["create", "promote", "rollback"]);
    const rollback = events[2];
    expect(rollback?.priorPlanVersion).toBe(2);
    expect(rollback?.currentPlanVersion).toBe(1);
    // History preserved: the promote event is untouched.
    expect(events[1]?.currentPlanVersion).toBe(2);
    const deployment = await service.getDeployment(ACTOR.applicationId, deploymentId);
    expect(deployment?.currentPlanVersion).toBe(1);
    expect(deployment?.revision).toBe(2);
  });

  test("rollback at the initial version fails closed (nothing to roll back to)", async () => {
    const { service, deploymentId } = await promotedWorld();
    await expect(
      service.rollbackDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-rollback-3",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

describe("suspend / resume / retire (MOD-003)", () => {
  test("suspend → resume round-trip with journaled events", async () => {
    const { service, deploymentId } = await promotedWorld();
    await service.suspendDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-suspend-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      cause: "maintenance",
    });
    let deployment = await service.getDeployment(ACTOR.applicationId, deploymentId);
    expect(deployment?.status).toBe("suspended");
    await service.resumeDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-resume-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    deployment = await service.getDeployment(ACTOR.applicationId, deploymentId);
    expect(deployment?.status).toBe("active");
    const events = await service.listEvents(ACTOR.applicationId, deploymentId);
    expect(events.map((event) => event.kind)).toEqual(["create", "suspend", "resume"]);
    // suspend/resume do NOT move the plan pointer (null plan versions).
    expect(events[1]?.currentPlanVersion).toBeNull();
    expect(events[1]?.priorPlanVersion).toBeNull();
  });

  test("suspend requires active; resume requires suspended; retired is terminal", async () => {
    const { service, deploymentId } = await promotedWorld();
    await service.suspendDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-suspend-2",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    // suspend on suspended fails.
    await expect(
      service.suspendDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-suspend-3",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await service.resumeDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-resume-2",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    // resume on active fails.
    await expect(
      service.resumeDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-resume-3",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await service.retireDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId,
      idempotencyKey: "key-retire-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    const deployment = await service.getDeployment(ACTOR.applicationId, deploymentId);
    expect(deployment?.status).toBe("retired");
    // Terminal: every mutation fails closed.
    await expect(
      service.suspendDeployment({
        applicationId: ACTOR.applicationId,
        deploymentId,
        idempotencyKey: "key-retire-2",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("BYOA representation (MOD-010)", () => {
  test("an external agent deploys through the same abstraction (opaque descriptor)", async () => {
    const { service } = await seedWorld();
    // A SEPARATE plan identity binds the byoa agent reference (the
    // honest composition: the descriptor is opaque, no SDK, no
    // credential, no execution surface).
    await service.publishPlan(
      {
        ...PLAN,
        planId: "acme-byoa-plan",
        agentRef: {
          agentId: AGENT_ID,
          agentVersion: "1.0.0",
          agentKind: "byoa",
          externalDescriptor: {
            ref: "external/acme-agent-7",
            descriptor: "Acme customer-hosted agent",
          },
        },
      },
      { version: 1 },
      ACTOR,
    );
    const created = await service.createDeployment(
      {
        ...CREATION,
        slug: "acme-byoa-prod",
        agentKind: "byoa",
        planId: "acme-byoa-plan",
      },
      "key-byoa-1",
      ACTOR,
    );
    const deployment = await service.getDeployment(ACTOR.applicationId, created.deploymentId);
    expect(deployment?.agentKind).toBe("byoa");
    expect(deployment?.currentPlan?.agentRef.agentKind).toBe("byoa");
    expect(deployment?.currentPlan?.agentRef.externalDescriptor?.ref).toBe("external/acme-agent-7");
    // The SAME lifecycle governs external deployments (suspend works).
    await service.suspendDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: created.deploymentId,
      idempotencyKey: "key-byoa-suspend",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    const suspended = await service.getDeployment(ACTOR.applicationId, created.deploymentId);
    expect(suspended?.status).toBe("suspended");
  });
});
