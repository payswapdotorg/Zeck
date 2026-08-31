/**
 * Real-PostgreSQL integration — the substrate federation end-to-end
 * (WORK-031, CSX-001..004; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * SELF-HOSTING-BOUNDARY).
 *
 * Proves against real PostgreSQL (migrations 0001..0010 + 0013) with
 * the REAL capability registry (in-memory catalog, the WORK-002/010
 * test pattern) and the REAL substrate SQL store:
 *
 *   - migration 0013: the substrates table + physical guards (core
 *     immutability, frozen lifecycle, no delete, identity UNIQUE);
 *   - publication: durable records, claim publication through the
 *     existing registry, convergence vs. conflict on real SQL
 *     arbitration;
 *   - lifecycle: suspend/resume/retire guarded; retired terminal
 *     (physical);
 *   - workload-class listing on real rows;
 *   - the planning decision with the substrateSelection capture rides
 *     the REAL executions ledger (execution evidence — criterion 6);
 *   - tenant isolation on real rows.
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import type { InMemorySubstrateFederationWorld } from "./substrates-world";
import { seedSubstrateWorld } from "./substrates-world";

definePgSuite("substrate federation (WORK-031) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<InMemorySubstrateFederationWorld> {
    return seedSubstrateWorld(ctx.port);
  }

  describe("schema (migration 0013)", () => {
    test("the substrates table + physical guards exist", async () => {
      const world = await freshWorld();
      const columns = await world.db.execute({
        sql: `SELECT column_name FROM information_schema.columns
WHERE table_schema = 'capabilities' AND table_name = 'substrates'`,
        parameters: [],
      });
      const names = columns.rows.map((row) => String(row.column_name));
      for (const expected of [
        "substrate_id",
        "version",
        "workload_classes",
        "resource",
        "isolation",
        "adapter_ref",
        "status",
      ]) {
        expect(names).toContain(expected);
      }
      const triggers = await world.db.execute<{ trigger_name: string }>({
        sql: `SELECT trigger_name FROM information_schema.triggers
WHERE event_object_schema = 'capabilities' AND event_object_table = 'substrates'`,
        parameters: [],
      });
      const triggerNames = new Set(triggers.rows.map((row) => String(row.trigger_name)));
      for (const expected of [
        "substrates_core_guard",
        "substrates_lifecycle_guard",
        "substrates_no_delete_guard",
      ]) {
        expect(triggerNames.has(expected), `trigger ${expected}`).toBe(true);
      }
    });
  });

  describe("publication (CSX-001/CSX-004)", () => {
    test("publishing records the substrate AND the claim resolves through the existing registry", async () => {
      const world = await freshWorld();
      const outcome = await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      expect(outcome.status).toBe("published");
      expect(outcome.record.status).toBe("available");
      const claims = await world.registry.listClaims();
      expect(claims.some((claim) => claim.claim.id === "batch-execution")).toBe(true);
      // Identical republish converges on the SQL UNIQUE arbitration.
      const again = await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      expect(again.status).toBe("converged");
    });

    test("a different body under the same identity+version fails closed (physical immutability)", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      await expect(
        world.substrateRegistry.publish(
          { ...world.substrateInput(), adapterRef: "other-adapter" },
          world.actor(),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      // Physical: the metadata core is immutable.
      await expect(
        world.db.execute({
          sql: `UPDATE capabilities.substrates SET adapter_ref = 'hacked'
WHERE application_id = $1 AND substrate_id = 'gpu-fleet-a'`,
          parameters: [world.applicationId],
        }),
      ).rejects.toThrowError(/immutable/);
      // Physical: rows are never deleted.
      await expect(
        world.db.execute({
          sql: `DELETE FROM capabilities.substrates WHERE application_id = $1`,
          parameters: [world.applicationId],
        }),
      ).rejects.toThrowError(/never deleted/);
    });
  });

  describe("lifecycle + listing (CSX-004)", () => {
    test("suspend/resume round-trip; retirement is terminal (physical)", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      const target = {
        applicationId: world.applicationId,
        substrateId: "gpu-fleet-a",
        version: "1.0.0",
        actor: world.actor(),
      };
      const suspended = await world.substrateRegistry.suspend(target);
      expect(suspended.status).toBe("suspended");
      // Suspended substrates leave the available listing.
      expect(
        await world.substrateRegistry.listAvailableByWorkloadClass(world.applicationId, "batch"),
      ).toHaveLength(0);
      const resumed = await world.substrateRegistry.resume(target);
      expect(resumed.status).toBe("available");
      expect(
        await world.substrateRegistry.listAvailableByWorkloadClass(world.applicationId, "batch"),
      ).toHaveLength(1);
      await world.substrateRegistry.retire(target);
      // Terminal: physical immutability.
      await expect(
        world.db.execute({
          sql: `UPDATE capabilities.substrates SET status = 'available'
WHERE application_id = $1 AND substrate_id = 'gpu-fleet-a'`,
          parameters: [world.applicationId],
        }),
      ).rejects.toThrowError(/terminal-immutable/);
      // And the service fails closed.
      await expect(world.substrateRegistry.resume(target)).rejects.toMatchObject({
        code: "INVALID_STATE_TRANSITION",
      });
    });

    test("workload-class listing filters on real rows", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      await world.substrateRegistry.publish(
        {
          ...world.substrateInput(),
          substrateId: "edge-fabric-b",
          workloadClasses: ["edge", "interactive"],
          latencyClass: "interactive",
          executionCapability: { id: "edge-execution", minVersion: "1.0.0" },
        },
        world.actor(),
      );
      expect(
        await world.substrateRegistry.listAvailableByWorkloadClass(world.applicationId, "edge"),
      ).toHaveLength(1);
      expect(
        await world.substrateRegistry.listAvailableByWorkloadClass(world.applicationId, "embodied"),
      ).toHaveLength(0);
    });
  });

  describe("planning evidence (CSX-003, criterion 6)", () => {
    test("the substrateSelection capture rides the REAL executions ledger", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      const outcome = await world.planWithSubstrate("batch");
      expect(outcome.decision.substrateSelection?.outcome).toBe("selected");
      expect(outcome.decision.substrateSelection?.selected?.substrateId).toBe("gpu-fleet-a");
      // The decision is DURABLE on the executions ledger with the
      // substrate-selection evidence in the payload.
      const events = await world.executionService.listEvents(
        world.applicationId,
        world.executionId,
      );
      const decisionEvent = events.find(
        (event: { type: string }) => event.type === "planning.decision-recorded",
      );
      expect(decisionEvent).toBeDefined();
      const payload = JSON.stringify(decisionEvent?.payload ?? {});
      expect(payload).toContain("substrateSelection");
      expect(payload).toContain("gpu-fleet-a");
    });

    test("deterministic-first: a sufficient task records no-substrate-required on the ledger", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      const outcome = await world.planWithSubstrate("batch", "arithmetic");
      expect(outcome.decision.substrateSelection?.outcome).toBe("no-substrate-required");
      const events = await world.executionService.listEvents(
        world.applicationId,
        world.executionId,
      );
      const decisionEvent = events.find(
        (event: { type: string }) => event.type === "planning.decision-recorded",
      );
      const payload = JSON.stringify(decisionEvent?.payload ?? {});
      expect(payload).toContain("no-substrate-required");
    });
  });

  describe("tenant isolation", () => {
    test("cross-tenant lifecycle fails closed; scope-filtered reads are empty", async () => {
      const world = await freshWorld();
      await world.substrateRegistry.publish(world.substrateInput(), world.actor());
      const cross = {
        applicationId: world.applicationId,
        substrateId: "gpu-fleet-a",
        version: "1.0.0",
        actor: { ...world.actor(), tenantId: "00000000-0000-7000-8000-0000000000ff" },
      };
      await expect(world.substrateRegistry.suspend(cross)).rejects.toMatchObject({
        code: "TENANT_SCOPE_VIOLATION",
      });
      const otherApp = "00000000-0000-7000-8000-0000000000ab";
      expect(await world.substrateRegistry.get(otherApp, "gpu-fleet-a", "1.0.0")).toBeNull();
      expect(await world.substrateRegistry.list(otherApp)).toHaveLength(0);
    });
  });
});
