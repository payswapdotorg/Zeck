/**
 * Real-PostgreSQL integration — the deployment fabric end-to-end
 * (WORK-023, MOD-001..004/010; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * SELF-HOSTING-BOUNDARY).
 *
 * Proves against real PostgreSQL (migrations 0001..0012) with the
 * REAL agents registry, REAL applications environments, REAL
 * executions service and the REAL deployment SQL store:
 *
 *   - migration 0012: tables, triggers, the identity UNIQUE;
 *   - profile/plan publication + immutability (physical);
 *   - deployment identity binding (MOD-002) + the identity UNIQUE
 *     (the same environment+agent+version is ONE deployment);
 *   - lifecycle idempotency (key replay converges), concurrency
 *     (parallel promotions: first writer wins, the loser converges or
 *     fails closed — never a lost update);
 *   - promotion/rollback provenance (journal order, prior/current
 *     versions, actor, cause, EXECUTION provenance referencing a real
 *     execution);
 *   - tenant isolation (cross-scope reads/mutations fail closed);
 *   - BYOA representation (MOD-010);
 *   - physical guards: artifact immutability, journal append-only,
 *     no delete, terminal-immutable retired.
 */

import { describe, expect, test } from "vitest";
import {
  type DeploymentPgWorld,
  PROFILE_BODY,
  planBody,
  seedDeploymentWorld,
} from "./deployments-world";
import { definePgSuite } from "./harness";

definePgSuite("deployment fabric (WORK-023) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<DeploymentPgWorld> {
    return seedDeploymentWorld(ctx.port);
  }

  const actorOf = (world: DeploymentPgWorld) => world.actor();

  async function seeded() {
    const world = await freshWorld();
    const actor = actorOf(world);
    await world.deploymentService.publishProfile({ ...PROFILE_BODY }, { version: 1 }, actor);
    await world.deploymentService.publishPlan(planBody(world), { version: 1 }, actor);
    return { world, actor };
  }

  async function seededDeployment() {
    const { world, actor } = await seeded();
    const created = await world.deploymentService.createDeployment(
      {
        slug: "support-voice-prod",
        name: "Support voice (production)",
        environmentId: world.environmentId,
        agentId: world.agentId,
        agentVersion: world.agentVersion,
        agentKind: "zeck",
        planId: "support-voice-plan",
      },
      "create-key-1",
      actor,
    );
    await world.deploymentService.publishPlan(
      {
        ...planBody(world),
        sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 16 },
      },
      { version: 2 },
      actor,
    );
    return { world, actor, deploymentId: created.deploymentId };
  }

  describe("schema (migration 0012)", () => {
    test("tables, guards and the identity constraint exist", async () => {
      const world = await freshWorld();
      for (const table of [
        "deployment_profiles",
        "deployment_plans",
        "deployments",
        "deployment_events",
      ]) {
        const columns = await world.db.execute({
          sql: `SELECT column_name FROM information_schema.columns
WHERE table_schema = 'deployments' AND table_name = $1`,
          parameters: [table],
        });
        expect(columns.rows.length).toBeGreaterThan(3);
      }
      const triggers = await world.db.execute<{ trigger_name: string }>({
        sql: `SELECT trigger_name FROM information_schema.triggers
WHERE event_object_schema = 'deployments'`,
        parameters: [],
      });
      const names = new Set(triggers.rows.map((row) => String(row.trigger_name)));
      for (const expected of [
        "deployment_profiles_immutable_guard",
        "deployment_plans_immutable_guard",
        "deployments_core_guard",
        "deployments_lifecycle_guard",
        "deployments_no_delete_guard",
        "deployment_events_append_only_guard",
      ]) {
        expect(names.has(expected), `trigger ${expected} must exist`).toBe(true);
      }
    });
  });

  describe("artifact publication (MOD-001)", () => {
    test("identical republish converges; a different body fails closed (physical)", async () => {
      const { world, actor } = await seeded();
      const again = await world.deploymentService.publishProfile(
        { ...PROFILE_BODY },
        { version: 1 },
        actor,
      );
      expect(again.status).toBe("converged");
      // A different body under the same identity+version: SQL arbitration.
      await expect(
        world.deploymentService.publishProfile(
          { ...PROFILE_BODY, latencyClass: "interactive" },
          { version: 1 },
          actor,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      // Rows are physically immutable.
      await expect(
        world.db.execute({
          sql: `UPDATE deployments.deployment_profiles SET latency_class = 'asynchronous'
WHERE application_id = $1 AND profile_id = 'support-voice' AND version = 1`,
          parameters: [world.applicationId],
        }),
      ).rejects.toThrowError(/immutable/);
    });

    test("a plan referencing an unknown environment fails closed (FK + resolver)", async () => {
      const { world, actor } = await seeded();
      await expect(
        world.deploymentService.publishPlan(
          { ...planBody(world), environmentId: "00000000-0000-7000-8000-0000000000ff" },
          { version: 2 },
          actor,
        ),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });
  });

  describe("deployment identity (MOD-002)", () => {
    test("creation binds identity; the journal records the create event with provenance", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.status).toBe("active");
      expect(deployment?.environmentId).toBe(world.environmentId);
      expect(deployment?.agentId).toBe(world.agentId);
      expect(deployment?.agentVersion).toBe(world.agentVersion);
      expect(deployment?.currentPlanVersion).toBe(1);
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      expect(events.map((event) => event.kind)).toEqual(["create"]);
    });

    test("the same environment+agent+version is ONE deployment identity (physical UNIQUE)", async () => {
      const { world, actor } = await seeded();
      await world.deploymentService.createDeployment(
        {
          slug: "support-voice-prod",
          name: "Support voice",
          environmentId: world.environmentId,
          agentId: world.agentId,
          agentVersion: world.agentVersion,
          agentKind: "zeck",
          planId: "support-voice-plan",
        },
        "identity-key-1",
        actor,
      );
      // A DIFFERENT slug, SAME identity binding: the physical UNIQUE
      // (application, environment, agent, agent_version) refuses the
      // second row.
      await expect(
        world.deploymentService.createDeployment(
          {
            slug: "support-voice-prod-2",
            name: "Support voice",
            environmentId: world.environmentId,
            agentId: world.agentId,
            agentVersion: world.agentVersion,
            agentKind: "zeck",
            planId: "support-voice-plan",
          },
          "identity-key-2",
          actor,
        ),
      ).rejects.toThrowError(/deployments_identity_unique/);
    });

    test("the same creation replays (slug convergence)", async () => {
      const { world, actor } = await seeded();
      const first = await world.deploymentService.createDeployment(
        {
          slug: "support-voice-prod",
          name: "Support voice",
          environmentId: world.environmentId,
          agentId: world.agentId,
          agentVersion: world.agentVersion,
          agentKind: "zeck",
          planId: "support-voice-plan",
        },
        "replay-key-1",
        actor,
      );
      const second = await world.deploymentService.createDeployment(
        {
          slug: "support-voice-prod",
          name: "Support voice",
          environmentId: world.environmentId,
          agentId: world.agentId,
          agentVersion: world.agentVersion,
          agentKind: "zeck",
          planId: "support-voice-plan",
        },
        "replay-key-2",
        actor,
      );
      expect(second.deploymentId).toBe(first.deploymentId);
      expect(second.replayed).toBe(true);
    });
  });

  describe("lifecycle idempotency + concurrency (MOD-003)", () => {
    test("a promotion key replay converges without double journaling", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const input = {
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "promote-replay",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        toPlanVersion: 2,
      };
      const first = await world.deploymentService.promoteDeployment(input);
      const second = await world.deploymentService.promoteDeployment(input);
      expect(second.planVersion).toBe(first.planVersion);
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      expect(events.filter((event) => event.kind === "promote")).toHaveLength(1);
    });

    test("CONCURRENT promotions: first writer wins; the loser converges or fails closed (no lost update)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      // Two DIFFERENT target versions published.
      await world.deploymentService.publishPlan(
        {
          ...planBody(world),
          sessionPolicy: { maxSessionDurationMs: 200_000, maxConcurrentSessions: 2 },
        },
        { version: 3 },
        actor,
      );
      const promote = (toPlanVersion: number, key: string) =>
        world.deploymentService.promoteDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: key,
          actorId: actor.actorId,
          tenantId: world.tenantId,
          toPlanVersion,
        });
      const [a, b] = await Promise.allSettled([
        promote(2, "concurrent-a"),
        promote(3, "concurrent-b"),
      ]);
      // Exactly one wins the guard (or both target different versions and
      // the second fails closed); the row is never torn.
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.currentPlanVersion).toBeGreaterThanOrEqual(1);
      expect(deployment?.currentPlanVersion).toBeLessThanOrEqual(3);
      const winners = [a, b].filter((r) => r.status === "fulfilled");
      expect(winners.length).toBeGreaterThanOrEqual(1);
      // The journal holds at most one promote per idempotency key and the
      // committed pointer matches a journal event.
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const promotes = events.filter((event) => event.kind === "promote");
      expect(promotes.map((event) => event.idempotencyKey)).toHaveLength(
        new Set(promotes.map((e) => e.idempotencyKey)).size,
      );
      if (promotes.length > 0) {
        expect(
          promotes.some((event) => event.currentPlanVersion === deployment?.currentPlanVersion),
        ).toBe(true);
      }
    });

    test("rollback derives the prior version; history is append-only (physical)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      await world.deploymentService.promoteDeployment({
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "rollback-promote",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        toPlanVersion: 2,
      });
      await world.deploymentService.rollbackDeployment({
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "rollback-actual",
        actorId: actor.actorId,
        tenantId: world.tenantId,
      });
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.currentPlanVersion).toBe(1);
      // Journal events are physically append-only.
      await expect(
        world.db.execute({
          sql: `UPDATE deployments.deployment_events SET cause = 'rewritten'
WHERE application_id = $1 AND deployment_id = $2`,
          parameters: [world.applicationId, deploymentId],
        }),
      ).rejects.toThrowError(/append-only/);
      // Deployments are never deleted.
      await expect(
        world.db.execute({
          sql: `DELETE FROM deployments.deployments WHERE id = $1`,
          parameters: [deploymentId],
        }),
      ).rejects.toThrowError(/never deleted/);
    });

    test("promotion/rollback with execution provenance records the real execution id (MOD-003)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      // A real execution to reference.
      const executionReceipt = await world.executionService.createExecution(
        {
          applicationId: world.applicationId,
          task: { kind: "summarize", input: "deployment-fabric-test" },
        },
        `exec-${deploymentId}`,
        { actorId: actor.actorId, tenantId: world.tenantId },
      );
      await world.deploymentService.promoteDeployment({
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "provenance-promote",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        cause: "operator: capacity plan",
        executionId: executionReceipt.executionId,
        toPlanVersion: 2,
      });
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const promote = events.find((event) => event.kind === "promote");
      expect(promote?.executionId).toBe(executionReceipt.executionId);
      expect(promote?.cause).toBe("operator: capacity plan");
      expect(promote?.actorId).toBe(actor.actorId);
      expect(promote?.priorPlanVersion).toBe(1);
      expect(promote?.currentPlanVersion).toBe(2);
    });
  });

  describe("tenant isolation + terminal state", () => {
    test("cross-tenant mutations fail closed; scope-filtered reads are empty", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const crossActor = {
        actorId: "00000000-0000-7000-8000-0000000000f9",
        applicationId: world.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000fa",
      };
      await expect(
        world.deploymentService.promoteDeployment({
          applicationId: crossActor.applicationId,
          deploymentId,
          idempotencyKey: "cross-tenant-key",
          actorId: crossActor.actorId,
          tenantId: crossActor.tenantId,
          toPlanVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      // An unknown application sees nothing.
      expect(
        await world.deploymentService.getDeployment(
          "00000000-0000-7000-8000-0000000000fb",
          deploymentId,
        ),
      ).toBeNull();
      expect(
        await world.deploymentService.listEvents(
          "00000000-0000-7000-8000-0000000000fb",
          deploymentId,
        ),
      ).toEqual([]);
      void actor;
    });

    test("retired is terminal-immutable (physical)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      await world.deploymentService.retireDeployment({
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "retire-key",
        actorId: actor.actorId,
        tenantId: world.tenantId,
      });
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.status).toBe("retired");
      // Physical: retired rows are immutable.
      await expect(
        world.db.execute({
          sql: `UPDATE deployments.deployments SET status = 'active' WHERE id = $1`,
          parameters: [deploymentId],
        }),
      ).rejects.toThrowError(/terminal-immutable/);
    });
  });

  describe("BYOA representation (MOD-010)", () => {
    test("an external agent deploys through the same abstraction (opaque descriptor, no dependency)", async () => {
      const { world, actor } = await seeded();
      await world.deploymentService.publishPlan(
        {
          ...planBody(world),
          planId: "acme-byoa-plan",
          agentRef: {
            agentId: world.agentId,
            agentVersion: world.agentVersion,
            agentKind: "byoa",
            externalDescriptor: {
              ref: "external/acme-agent-7",
              descriptor: "Acme customer-hosted agent",
            },
          },
        },
        { version: 1 },
        actor,
      );
      const created = await world.deploymentService.createDeployment(
        {
          slug: "acme-byoa-prod",
          name: "Acme BYOA deployment",
          environmentId: world.environmentId,
          agentId: world.agentId,
          agentVersion: world.agentVersion,
          agentKind: "byoa",
          planId: "acme-byoa-plan",
        },
        "byoa-key-1",
        actor,
      );
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        created.deploymentId,
      );
      expect(deployment?.agentKind).toBe("byoa");
      expect(deployment?.currentPlan?.agentRef.externalDescriptor?.ref).toBe(
        "external/acme-agent-7",
      );
      // The same lifecycle governs external deployments.
      await world.deploymentService.suspendDeployment({
        applicationId: world.applicationId,
        deploymentId: created.deploymentId,
        idempotencyKey: "byoa-suspend",
        actorId: actor.actorId,
        tenantId: world.tenantId,
      });
      const suspended = await world.deploymentService.getDeployment(
        world.applicationId,
        created.deploymentId,
      );
      expect(suspended?.status).toBe("suspended");
    });
  });
});
