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
      const { world, deploymentId } = await seededDeployment();
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

  describe("the §9 concurrency completion: rollback, suspension and creation races (M5/M6/M7)", () => {
    async function promotedToV2() {
      const { world, actor, deploymentId } = await seededDeployment();
      await world.deploymentService.promoteDeployment({
        applicationId: world.applicationId,
        deploymentId,
        idempotencyKey: "race-setup-promote",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        toPlanVersion: 2,
      });
      return { world, actor, deploymentId };
    }

    test("CONCURRENT rollbacks are safe under any interleaving: never torn, per-key exact-once, the journal matches the pointer (M6)", async () => {
      const { world, actor, deploymentId } = await promotedToV2();
      const rollback = (key: string) =>
        world.deploymentService.rollbackDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: key,
          actorId: actor.actorId,
          tenantId: world.tenantId,
        });
      // Two DISTINCT concurrent rollbacks (different keys) of the same
      // move. INTERLEAVING NOTE (reconciliation disclosure): both callers
      // derive the prior version (v1) from the journal only when both
      // read the journal before either appends — then the guarded
      // single-row UPDATE admits exactly one writer and the loser
      // converges WITHOUT double-journaling (pointer v1, one event). If
      // the second caller's reads land AFTER the first's commit, it
      // observes the first rollback's journal event, derives prior = v2
      // (the version the first rollback left) and applies as a
      // sequential-equivalent rollback-of-rollback (pointer v2, two
      // events) — the same semantics as two sequential rollbacks. Both
      // interleavings are legal; the INVARIANTS under test are the ones
      // that hold under every interleaving: the pointer is never torn,
      // every key journals at most once, and the committed pointer
      // always matches the last journaled move.
      const outcomes = await Promise.allSettled([
        rollback("race-rollback-a"),
        rollback("race-rollback-b"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect([1, 2]).toContain(deployment?.currentPlanVersion);
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const rollbacks = events.filter((event) => event.kind === "rollback");
      // Per-key exact-once: each caller's key journals at most one event.
      expect(rollbacks.map((event) => event.idempotencyKey)).toHaveLength(
        new Set(rollbacks.map((event) => event.idempotencyKey)).size,
      );
      expect(rollbacks.length).toBeGreaterThanOrEqual(1);
      expect(rollbacks.length).toBeLessThanOrEqual(2);
      // The committed pointer always matches the LAST journaled move —
      // never torn, never lost (v1 in the converged interleave, v2 in the
      // sequential-equivalent one).
      const moves = events.filter((event) => event.kind === "promote" || event.kind === "rollback");
      expect(moves[moves.length - 1]?.currentPlanVersion).toBe(deployment?.currentPlanVersion);
      // In the converged interleave the winner's rollback is the only
      // event and it moves v2 -> v1.
      if (rollbacks.length === 1) {
        expect(deployment?.currentPlanVersion).toBe(1);
        expect(rollbacks[0]?.priorPlanVersion).toBe(2);
        expect(rollbacks[0]?.currentPlanVersion).toBe(1);
      }
    });

    test("CONCURRENT rollback vs promotion: the pointer is never torn (first writer wins, M6)", async () => {
      const { world, actor, deploymentId } = await promotedToV2();
      await world.deploymentService.publishPlan(
        {
          ...planBody(world),
          sessionPolicy: { maxSessionDurationMs: 200_000, maxConcurrentSessions: 2 },
        },
        { version: 3 },
        actor,
      );
      const movesBefore = (
        await world.deploymentService.listEvents(world.applicationId, deploymentId)
      ).filter((event) => event.kind === "promote" || event.kind === "rollback");
      const outcomes = await Promise.allSettled([
        world.deploymentService.rollbackDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: "race-rb-vs-promote-rb",
          actorId: actor.actorId,
          tenantId: world.tenantId,
        }),
        world.deploymentService.promoteDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: "race-rb-vs-promote-p",
          actorId: actor.actorId,
          tenantId: world.tenantId,
          toPlanVersion: 3,
        }),
      ]);
      // One of the two legal outcome classes (interleaving note, see the
      // M6 rollback test above): (i) both callers read before either
      // commit — exactly one writer wins the guard and the loser fails
      // closed (INVALID_STATE_TRANSITION — its expected version no longer
      // matches the committed row; pointer v1 or v3); or (ii) the second
      // caller's reads land after the first's commit and it applies
      // sequentially — rollback-then-promote lands on v3, promote-then-
      // rollback re-derives the prior version from the journal and lands
      // on v2 (both legal moves, both journaled). The INVARIANTS under
      // test hold under all interleavings: the pointer is never torn,
      // every key journals at most once, and the committed pointer
      // matches the last journaled move.
      const winners = outcomes.filter((r) => r.status === "fulfilled");
      expect(winners.length).toBeGreaterThanOrEqual(1);
      expect(winners.length).toBeLessThanOrEqual(2);
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect([1, 2, 3]).toContain(deployment?.currentPlanVersion);
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const moves = events.filter((event) => event.kind === "promote" || event.kind === "rollback");
      // One new move (single-writer interleave) or two (sequential-
      // equivalent interleave) — never zero, never per-key duplication.
      expect(moves.length).toBeGreaterThanOrEqual(movesBefore.length + 1);
      expect(moves.length).toBeLessThanOrEqual(movesBefore.length + 2);
      expect(moves.map((event) => event.idempotencyKey)).toHaveLength(
        new Set(moves.map((event) => event.idempotencyKey)).size,
      );
      // The committed pointer matches the LAST journaled move (never
      // torn, never lost).
      const lastMove = moves[moves.length - 1];
      expect(lastMove?.currentPlanVersion).toBe(deployment?.currentPlanVersion);
    });

    test("CONCURRENT suspensions converge: exactly one suspend event (M7)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const suspend = (key: string) =>
        world.deploymentService.suspendDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: key,
          actorId: actor.actorId,
          tenantId: world.tenantId,
        });
      const outcomes = await Promise.allSettled([
        suspend("race-suspend-a"),
        suspend("race-suspend-b"),
      ]);
      // Both callers fulfill in the pre-commit interleave (the loser's
      // guarded UPDATE finds the row already suspended and converges
      // without journaling); in the post-commit interleave the loser's
      // status read sees `suspended` and the suspend precondition fails
      // closed (INVALID_STATE_TRANSITION). Either way exactly ONE
      // suspend event is journaled and the row is suspended — a
      // sequential second suspend is unrepresentable (precondition).
      expect(outcomes.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.status).toBe("suspended");
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      expect(events.filter((event) => event.kind === "suspend")).toHaveLength(1);
    });

    test("CONCURRENT suspend vs retire: the final status is unambiguous and journaled consistently (M7)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const outcomes = await Promise.allSettled([
        world.deploymentService.suspendDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: "race-suspend-vs-retire-s",
          actorId: actor.actorId,
          tenantId: world.tenantId,
        }),
        world.deploymentService.retireDeployment({
          applicationId: world.applicationId,
          deploymentId,
          idempotencyKey: "race-suspend-vs-retire-r",
          actorId: actor.actorId,
          tenantId: world.tenantId,
        }),
      ]);
      // One of the two legal outcomes (interleaving note, see the M6
      // tests above): (i) both callers read the row `active` — one
      // writer wins, the loser's guard disagrees and fails closed; or
      // (ii) the retire's reads land after the suspend's commit — the
      // suspended->retired transition is legal, so it applies
      // sequentially (both fulfilled, two events, final `retired`). The
      // row's final status always matches the LAST journaled status
      // event.
      expect(outcomes.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      expect(outcomes.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(2);
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(["suspended", "retired"]).toContain(deployment?.status);
      const events = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const statusEvents = events.filter(
        (event) => event.kind === "suspend" || event.kind === "retire",
      );
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      expect(statusEvents.length).toBeLessThanOrEqual(2);
      expect(statusEvents.map((event) => event.idempotencyKey)).toHaveLength(
        new Set(statusEvents.map((event) => event.idempotencyKey)).size,
      );
      // The LAST journaled status change matches the committed row.
      const lastStatus = statusEvents[statusEvents.length - 1];
      expect(lastStatus?.kind === "retire" ? "retired" : "suspended").toBe(deployment?.status);
    });

    test("CONCURRENT duplicate creations converge: one row, one create event (the winner journals — §10)", async () => {
      const { world, actor } = await seeded();
      const create = (key: string) =>
        world.deploymentService.createDeployment(
          {
            slug: "race-create-prod",
            name: "Race create",
            environmentId: world.environmentId,
            agentId: world.agentId,
            agentVersion: world.agentVersion,
            agentKind: "zeck",
            planId: "support-voice-plan",
          },
          key,
          actor,
        );
      // Two concurrent duplicates (different keys, same creation): the
      // slug UNIQUE + fingerprint arbitration yield a SINGLE durable
      // result — one row, one journal event, both callers agree on the
      // deployment id.
      const outcomes = await Promise.allSettled([create("race-create-a"), create("race-create-b")]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const ids = outcomes
        .filter(
          (r): r is PromiseFulfilledResult<{ deploymentId: string; replayed: boolean }> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value.deploymentId);
      expect(new Set(ids).size).toBe(1);
      const rows = await world.db.execute<{ id: string }>({
        sql: `SELECT id FROM deployments.deployments WHERE application_id = $1 AND slug = 'race-create-prod'`,
        parameters: [world.applicationId],
      });
      expect(rows.rows).toHaveLength(1);
      const events = await world.deploymentService.listEvents(
        world.applicationId,
        rows.rows[0]?.id ?? "",
      );
      expect(events.filter((event) => event.kind === "create")).toHaveLength(1);
    });

    test("CONCURRENT identity collisions: the physical UNIQUE refuses the second deployment (M1)", async () => {
      const { world, actor } = await seeded();
      const create = (slug: string, key: string) =>
        world.deploymentService.createDeployment(
          {
            slug,
            name: "Identity race",
            environmentId: world.environmentId,
            agentId: world.agentId,
            agentVersion: world.agentVersion,
            agentKind: "zeck",
            planId: "support-voice-plan",
          },
          key,
          actor,
        );
      // Same (environment, agent, agent-version) binding under two
      // different slugs, concurrently: the identity UNIQUE admits
      // exactly one row.
      const outcomes = await Promise.allSettled([
        create("identity-race-a", "identity-race-key-a"),
        create("identity-race-b", "identity-race-key-b"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((r) => r.status === "rejected");
      expect((rejected as PromiseRejectedResult | undefined)?.reason).toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
      });
      const rows = await world.db.execute<{ id: string }>({
        sql: `SELECT id FROM deployments.deployments WHERE application_id = $1 AND slug LIKE 'identity-race-%'`,
        parameters: [world.applicationId],
      });
      expect(rows.rows).toHaveLength(1);
    });

    test("cross-APPLICATION mutation fails closed before side effects (M3)", async () => {
      const { world, actor, deploymentId } = await seededDeployment();
      const before = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      const otherApplication = "00000000-0000-7000-8000-0000000000fc";
      await expect(
        world.deploymentService.promoteDeployment({
          applicationId: otherApplication,
          deploymentId,
          idempotencyKey: "cross-app-key",
          actorId: actor.actorId,
          tenantId: world.tenantId,
          toPlanVersion: 2,
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        message: expect.stringContaining("not found in this application"),
      });
      // Fail BEFORE side effects: the row and the journal are unchanged.
      const deployment = await world.deploymentService.getDeployment(
        world.applicationId,
        deploymentId,
      );
      expect(deployment?.currentPlanVersion).toBe(1);
      expect(deployment?.status).toBe("active");
      const after = await world.deploymentService.listEvents(world.applicationId, deploymentId);
      expect(after).toEqual(before);
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
