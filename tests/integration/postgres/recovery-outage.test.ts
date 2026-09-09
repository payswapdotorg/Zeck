/**
 * Integration — THE PROVIDER-OUTAGE FAIL-CLOSED DRILL (WORK-048 /
 * D-07, acceptance criterion 6: "Provider outage simulation fails
 * closed and recovery remains governed by Zeck's authoritative
 * state").
 *
 * The queue-transport and object-store outage classes are proven
 * inside the replay/artifact suites (R2/A2). This suite completes
 * the outage matrix with the AUTHORITY-side class and the drill-level
 * fail-closed contract:
 *
 *   O1 DATABASE OUTAGE: while the authority is unavailable, every
 *      port operation (query AND transaction) fails with the typed
 *      `DatabaseUnavailableError` — the authority-unavailable class.
 *      Nothing is promoted, nothing silently succeeds: the executions
 *      service REFUSES transitions during the outage (the frozen
 *      semantics never run against a dead authority).
 *   O2 OUTAGE OBSERVATION: every refused operation is counted (the
 *      bounded drill evidence); recovery after `end()` resumes
 *      through the SAME authority (a subsequent governed transition
 *      succeeds — the outage was a pause, never a state change).
 *   O3 DRILL FAIL-CLOSED: a recovery drill whose phase hits the
 *      outage records the failure, stops (later phases never run),
 *      and declares `recovered: false` with NO RTO claim — an outage
 *      during recovery is a failed recovery, never a partial pass.
 */
import { expect, test } from "vitest";
import { DatabaseUnavailableError } from "../../../src/platform/db/errors";
import { runRecoveryDrill } from "../../../src/platform/recovery/drill";
import { OutageSimulatedDatabase } from "../../../src/platform/recovery/outage";
import { definePgSuite } from "./harness";
import { seedWorkerFabricWorld } from "./worker-world";

definePgSuite("provider-outage fail-closed drills (WORK-048 D-07 AC6)", (ctx) => {
  const world = (port?: typeof ctx.port) => seedWorkerFabricWorld(port ?? ctx.port);

  test("O1+O2 database outage: typed authority-unavailable failures; nothing promotes; recovery resumes through the same authority", async () => {
    // The outage wrapper sits UNDER the world: every service,
    // store and seam is composed over the wrapped port (the drill
    // composition — the authority endpoint is dead for everyone).
    const outage = new OutageSimulatedDatabase(ctx.port);
    const w = await world(outage);
    const executionId = await w.createDispatchedExecution("outage-db");

    outage.begin();

    // Every port operation fails with the AUTHORITY-UNAVAILABLE class
    // (queries AND transactions — no silent fallback, no local
    // promotion).
    await expect(w.service.getExecution(w.applicationId, executionId)).rejects.toThrow(
      DatabaseUnavailableError,
    );
    await expect(w.db.execute({ sql: "SELECT 1", parameters: [] })).rejects.toThrow(
      DatabaseUnavailableError,
    );
    await expect(
      w.db.transaction(async (tx) => {
        await tx.execute({ sql: "SELECT 1", parameters: [] });
      }),
    ).rejects.toThrow(DatabaseUnavailableError);

    // The frozen transition semantics REFUSE to run against the dead
    // authority (the governed lifecycle is unavailable, not degraded).
    await expect(
      w.service.transition(
        { ...w.scopeOf(executionId), command: "authorize", reason: "outage-drill" },
        "outage-authorize",
      ),
    ).rejects.toThrow(DatabaseUnavailableError);
    expect(outage.failedOperations).toBeGreaterThanOrEqual(4);

    // THE OUTAGE ENDS: the SAME authority serves the governed path
    // again (the outage was a pause — no state changed anywhere).
    outage.end();
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED"); // exactly where it was
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start", reason: "outage-recovered" },
      "queue-consume:execution-dispatch:outage-recovered",
    );
    const after = await w.service.getExecution(w.applicationId, executionId);
    expect(after?.status).toBe("RUNNING");
  });

  test("O3 drill fail-closed: an outage during a recovery phase is a failed recovery — no RTO claim, later phases never run", async () => {
    const outage = new OutageSimulatedDatabase(ctx.port);
    const w = await world(outage);
    const executionId = await w.createDispatchedExecution("outage-drill");

    outage.begin();
    const drill = await runRecoveryDrill(
      {
        scenarioId: "outage-during-recovery",
        environment: "local",
        revision: "work048-integration",
        lossAt: new Date(),
        lastConsistentPointAt: new Date(),
        phases: [
          {
            name: "probe",
            action: async () => undefined,
          },
          {
            name: "authority-read",
            description: "the phase that hits the outage",
            action: async () => {
              await w.service.getExecution(w.applicationId, executionId);
            },
          },
          {
            name: "never-runs-after-outage",
            action: async () => {
              throw new Error("this phase must never run (fail-closed ordering)");
            },
          },
        ],
      },
      { now: () => new Date() },
    );
    outage.end();

    // Fail-closed: the outage phase records its typed error, the
    // drill stops, recovery is REFUSED and no RTO is claimed.
    expect(drill.recovered).toBe(false);
    expect(drill.rtoMs).toBeNull();
    expect(drill.phases.map((phase) => phase.name)).toEqual(["probe", "authority-read"]);
    expect(drill.phases[1]?.ok).toBe(false);
    expect(drill.phases[1]?.error).toContain("simulated provider outage");
    expect(outage.failedOperations).toBeGreaterThanOrEqual(1);

    // The durable state is UNCHANGED by the failed drill (the
    // authority was never touched mid-outage).
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED");
  });
});
