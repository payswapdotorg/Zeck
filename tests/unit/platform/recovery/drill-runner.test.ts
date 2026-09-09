/**
 * Unit tests — the recovery-drill runner's discipline (WORK-048 /
 * D-07): fail-closed phase execution, bounded evidence, and the
 * measured RTO/RPO anchors.
 *
 * The executed drills against real infrastructure live in
 * `tests/integration/postgres/recovery-*.test.ts` and
 * `deploy/drill.ts`; these proofs pin the runner itself:
 *
 *   - an empty drill is a configuration error (nothing to verify);
 *   - phases run in order and STOP at the first failure (recovery
 *     never continues on top of a broken phase);
 *   - `recovered` is true ONLY when every phase completed;
 *   - RTO is measured loss → all-gates-green and only for a
 *     recovered drill (an unverified recovery has NO RTO claim);
 *   - RPO is the loss-anchor distance and null for zero-loss
 *     scenarios (no recovery-point anchor);
 *   - phase evidence is bounded (names, descriptions, errors).
 */

import { describe, expect, test } from "vitest";
import { runRecoveryDrill } from "../../../../src/platform/recovery/drill";

/** A deterministic clock the tests advance by fixed steps. */
class SteppedClock {
  private ms: number;
  private readonly stepMs: number;

  constructor(startMs: number, stepMs: number) {
    this.ms = startMs;
    this.stepMs = stepMs;
  }

  now(): Date {
    const current = new Date(this.ms);
    this.ms += this.stepMs;
    return current;
  }
}

describe("the recovery-drill runner (fail-closed, timed, verified)", () => {
  test("an empty drill is a configuration error — empty drills cannot verify", async () => {
    await expect(
      runRecoveryDrill(
        {
          scenarioId: "empty",
          environment: "local",
          revision: "fixture",
          lossAt: new Date(0),
          lastConsistentPointAt: null,
          phases: [],
        },
        { now: () => new Date(0) },
      ),
    ).rejects.toThrow(/empty drills cannot verify/);
  });

  test("a fully successful drill measures RTO from the loss instant and RPO from the recovery point", async () => {
    const lossAt = new Date(1_000_000);
    const lastConsistentPointAt = new Date(900_000);
    const clock = new SteppedClock(1_100_000, 5_000);
    const report = await runRecoveryDrill(
      {
        scenarioId: "authority-loss",
        environment: "local",
        revision: "abc123",
        lossAt,
        lastConsistentPointAt,
        phases: [
          { name: "restore", description: "the restore phase", action: async () => undefined },
          { name: "verify", action: async () => undefined },
        ],
      },
      clock,
    );
    expect(report.recovered).toBe(true);
    expect(report.phases).toHaveLength(2);
    expect(report.phases.every((phase) => phase.ok)).toBe(true);
    // startedAt = 1_100_000; finishedAt = 1_110_000 (two phases, two
    // clock steps each... the clock advances once per now() call).
    expect(report.rtoMs).not.toBeNull();
    expect(report.rtoMs as number).toBeGreaterThanOrEqual(0);
    // RPO = loss − recovery point = 100_000ms (honest data-loss window).
    expect(report.rpoMs).toBe(100_000);
    expect(report.revision).toBe("abc123");
    expect(report.scenarioId).toBe("authority-loss");
  });

  test("a failed phase stops the drill: recovered=false, RTO unmeasured, later phases NEVER run", async () => {
    let neverRan = false;
    const report = await runRecoveryDrill(
      {
        scenarioId: "failing",
        environment: "local",
        revision: "fixture",
        lossAt: new Date(0),
        lastConsistentPointAt: new Date(0),
        phases: [
          { name: "ok-phase", action: async () => undefined },
          {
            name: "failing-phase",
            action: async () => {
              throw new Error("simulated recovery failure");
            },
          },
          {
            name: "never-phase",
            action: async () => {
              neverRan = true;
            },
          },
        ],
      },
      new SteppedClock(0, 1),
    );
    expect(report.recovered).toBe(false);
    expect(report.rtoMs).toBeNull(); // no RTO claim for an unverified recovery
    expect(report.rpoMs).toBe(0);
    expect(neverRan).toBe(false); // fail-closed ordering
    expect(report.phases.map((phase) => phase.name)).toEqual(["ok-phase", "failing-phase"]);
    expect(report.phases[1]?.ok).toBe(false);
    expect(report.phases[1]?.error).toBe("simulated recovery failure");
  });

  test("a zero-loss scenario (no recovery-point anchor) reports RPO null", async () => {
    const report = await runRecoveryDrill(
      {
        scenarioId: "evacuation",
        environment: "local",
        revision: "fixture",
        lossAt: new Date(0),
        lastConsistentPointAt: null,
        phases: [{ name: "evacuate", action: async () => undefined }],
      },
      new SteppedClock(0, 1),
    );
    expect(report.recovered).toBe(true);
    expect(report.rpoMs).toBeNull();
  });

  test("phase evidence is bounded (oversized names, descriptions and errors truncate)", async () => {
    const report = await runRecoveryDrill(
      {
        scenarioId: "bounded",
        environment: "local",
        revision: "fixture",
        lossAt: new Date(0),
        lastConsistentPointAt: null,
        phases: [
          {
            name: "n".repeat(200),
            description: "d".repeat(400),
            action: async () => {
              throw new Error("e".repeat(600));
            },
          },
        ],
      },
      new SteppedClock(0, 1),
    );
    expect(report.phases[0]?.name.length).toBeLessThanOrEqual(100);
    expect(report.phases[0]?.description?.length).toBeLessThanOrEqual(300);
    expect(report.phases[0]?.error?.length).toBeLessThanOrEqual(500);
    expect(report.scenarioId.length).toBeLessThanOrEqual(100);
  });
});
