/**
 * VAL-031 acceptance criterion 6 — discrimination tests proving the
 * repeated-replay trajectory analysis against controlled fakes (the
 * five AC6 families):
 *
 *   * the DUPLICATE REPLAY — a LEAKY ledger that lets one replay
 *     shoulder INTO the first replay's trajectory identity (a duplicate
 *     ledger identity for one workload's replay population) FAILS the
 *     population completeness, including the shoulder-in surfaced
 *     through the PUBLIC wire at the customer boundary (the k-th
 *     submission key binding the FIRST replay's durable execution) and
 *     the fabricated minted shape (one identity shared by two replays)
 *     — while the honest N-replay population never duplicates (exactly
 *     N immutable identities, none shouldered);
 *
 *   * the DROPPED REPLAY — a DROPPED ledger observation (the population
 *     has a gap: the k-th replay's immutable identity never lands)
 *     FAILS, an N-1 population (a missing ordinal) FAILS exactly the
 *     same way, and a dropped trajectory read at the customer boundary
 *     (a 404 events read) FAILS the stability evidence — while the
 *     honest population's every identity lands;
 *
 *   * the DRIFTED TRAJECTORY — a replay whose captured trajectory
 *     drifts OUT of the row's pinned VAL-030 equivalence class FAILS
 *     the trajectory-class membership with the drifted ordinal named
 *     (through the recorder fake, through the derivation over a
 *     fabricated drifted digest, and through the drifting events read
 *     surfaced at the customer boundary) — while the honest population
 *     stays in-class on every replay;
 *
 *   * the PARTIAL POPULATION — a stability claim asserted from a
 *     partial replay set (fewer than N observations, or a null digest
 *     among them) FAILS mechanically — the full population's evidence
 *     is required — while the full population's honest claim passes;
 *
 *   * the FABRICATED DETERMINISM — an analysis that claims determinism
 *     over an observed variance (a smoothed variance) FAILS, and so
 *     does a world that smooths the variance away (the observed
 *     distribution mismatches the pin) — while the honest analysis
 *     REPORTS the varying population with its observed distribution,
 *     never smoothing it.
 */

import { describe, expect, test } from "vitest";
import { runWorkloadReplayApp } from "../../benchmarks/validation/apps/workload-replay/application";
import {
  OFFLINE_CORPUS_ROWS,
  WORKLOAD_REPLAY_CORPUS,
} from "../../benchmarks/validation/apps/workload-replay/corpus";
import {
  createDefaultReplayBaselineRegistry,
  createInertReplayLearning,
  createReplayLedger,
  createReplayRecorder,
  createTickClock,
  createWorkloadReplayFakeApiWorld,
} from "../../benchmarks/validation/apps/workload-replay/fixtures";
import {
  controlTrajectoryStepsOf,
  trajectoryDigestOf,
} from "../../benchmarks/validation/platform/longitudinal-baseline";
import type { WorkloadReplayCorpusRow } from "../../benchmarks/validation/platform/workload-replay";
import {
  derivePopulationCompleteness,
  deriveStabilityHonesty,
  deriveStabilityReportOf,
  deriveTrajectoryClassMembership,
  driveWorkloadReplay,
  replayIdentityIdOf,
  replayKeyOf,
} from "../../benchmarks/validation/platform/workload-replay";

const REVISION = "4d4ab310d066a775e3d47f40e8f0b4cd02073371";

const rowById = (rowId: string): WorkloadReplayCorpusRow => {
  const row = WORKLOAD_REPLAY_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = WORKLOAD_REPLAY_CORPUS.findIndex((candidate) => candidate.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/**
 * The honest per-replay schedule digests of one row's population (the
 * world's per-replay effect-ordering schedule: varying rows cycle the
 * declared equivalent orderings; deterministic rows schedule the
 * declaration order for every replay).
 */
function scheduledDigestsOf(row: WorkloadReplayCorpusRow): string[] {
  return Array.from({ length: row.replayCount }, (_, index) => {
    const declarationOrder = row.workload.effects.map((_, effectIndex) => effectIndex);
    const order =
      row.replayOrderings === undefined || row.replayOrderings.length === 0
        ? (row.effectOrderings?.[0] ?? declarationOrder)
        : (row.replayOrderings[index % row.replayOrderings.length] ?? declarationOrder);
    return trajectoryDigestOf(
      controlTrajectoryStepsOf({ workload: row.workload, effectOrder: order }),
    );
  });
}

/** Drive one offline row over a purpose-built fake stack (the adversarial variants). */
async function driveRowOverStack(options: {
  readonly row: WorkloadReplayCorpusRow;
  readonly driftOrdinal?: number;
  readonly shoulderOrdinal?: number;
  readonly dropOrdinal?: number;
  readonly contaminate?: "trajectory-reuse";
}): Promise<Awaited<ReturnType<typeof driveWorkloadReplay>>> {
  const { row } = options;
  const clock = createTickClock();
  const registry = createDefaultReplayBaselineRegistry();
  const ledger = createReplayLedger({
    ...(options.shoulderOrdinal === undefined ? {} : { shoulderOrdinal: options.shoulderOrdinal }),
    ...(options.dropOrdinal === undefined ? {} : { dropOrdinal: options.dropOrdinal }),
  });
  const recorder = createReplayRecorder({
    ...(options.driftOrdinal === undefined ? {} : { driftOrdinal: options.driftOrdinal }),
    ...(row.replayOrderings === undefined ? {} : { replayOrderPlan: row.replayOrderings }),
  });
  const learning = createInertReplayLearning({
    ...(options.contaminate === undefined ? {} : { contaminate: options.contaminate }),
  });
  return driveWorkloadReplay({
    row,
    populationId: `pop-disc-${row.rowId}`,
    registry,
    ledger,
    recorder,
    learning,
    now: clock.now,
  });
}

/** Run one app row over the fake API world (the customer-boundary catch). */
async function runAppOverFakeWorld(options: {
  readonly rowId: string;
  readonly driftOrdinal?: number;
  readonly dropOrdinal?: number;
  readonly leakyOrdinal?: number;
  readonly smoothedVariance?: boolean;
}): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runWorkloadReplayApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createWorkloadReplayFakeApiWorld({
    clock,
    ...(options.driftOrdinal === undefined ? {} : { driftOrdinal: options.driftOrdinal }),
    ...(options.dropOrdinal === undefined ? {} : { dropOrdinal: options.dropOrdinal }),
    ...(options.leakyOrdinal === undefined ? {} : { leakyOrdinal: options.leakyOrdinal }),
    ...(options.smoothedVariance === undefined
      ? {}
      : { smoothedVariance: options.smoothedVariance }),
  });
  const outcome = await runWorkloadReplayApp({
    config: {
      applicationId: "app-1",
      baseUrl: "http://fake-zeck.local",
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 1,
      completionTimeoutMs: 5_000,
    },
    token: "zeck-token-fake",
    transport: world.transport,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-031-discrimination" },
    },
    runSuffix: "disc",
    taskIndex: taskIndexOf(options.rowId),
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

/** The derived stable identity for one replay of one population. */
const identityOf = (row: WorkloadReplayCorpusRow, ordinal: number): string =>
  replayIdentityIdOf(
    replayKeyOf({
      populationId: `pop-disc-${row.rowId}`,
      manifest: row.manifest,
      replayOrdinal: ordinal,
    }),
  );

// ---------------------------------------------------------------------------
// Family 1: the duplicate replay (the population-completeness catch)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the duplicate replay", () => {
  test("a LEAKY ledger that lets one replay SHOULDER INTO the first identity FAILs the population", async () => {
    const row = rowById("probe-duplicate-replay");
    const result = await driveRowOverStack({ row, shoulderOrdinal: 2 });
    // The shoulder-in failed the row honestly — never a fabricated completion.
    expect(result.terminal).toBe("FAILED");
    expect(result.population.complete).toBe(false);
    expect(result.population.duplicateIdentityIds).toEqual([identityOf(row, 1)]);
    expect(result.population.replayedOrdinals).toEqual([2]);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "population-no-duplicate-replays",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find(
          (criterion) => criterion.criterionId === "population-no-duplicate-replays",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DUPLICATED-REPLAY");
    // The ledger recorded only TWO identities for a three-replay population
    // (the shouldered replay landed nothing of its own).
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("the shoulder-in surfaced through the PUBLIC wire FAILs the app's replay contract", async () => {
    const row = rowById("probe-duplicate-replay");
    const { outcome, createdExecutions } = await runAppOverFakeWorld({
      rowId: row.rowId,
      leakyOrdinal: 2,
    });
    expect(outcome.passed).toBe(false);
    // The second replay's submission key bound the FIRST replay's durable
    // execution — a duplicate replay identity at the customer boundary.
    expect(outcome.submissions[1]?.replayed).toBe(true);
    expect(outcome.submissions[1]?.executionId).toBe(outcome.submissions[0]?.executionId);
    expect(createdExecutions).toBe(row.replayCount - 1);
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-population-no-duplicate-replays",
      )?.status,
    ).toBe("FAIL");
  });

  test("a ledger that MINTS one identity for TWO replays FAILs (the fabricated duplicate shape)", () => {
    // The fabricated minted shape: the ledger hands the SAME identity to
    // two different replays — a duplicate ledger identity for one
    // workload's replay population.
    const verdict = derivePopulationCompleteness({
      replayCount: 3,
      replays: [
        { replayOrdinal: 1, identityId: "exp-workload-replay-minted", replayed: false },
        { replayOrdinal: 2, identityId: "exp-workload-replay-minted", replayed: false },
        { replayOrdinal: 3, identityId: "exp-workload-replay-honest", replayed: false },
      ],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.duplicateIdentityIds).toEqual(["exp-workload-replay-minted"]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(false);
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "population-no-duplicate-replays",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DUPLICATED-REPLAY");
  });

  test("the honest N-replay population never duplicates (exactly N immutable identities)", async () => {
    const row = rowById("probe-duplicate-replay");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.population.complete).toBe(true);
    expect(result.population.duplicateIdentityIds).toEqual([]);
    expect(result.population.replayedOrdinals).toEqual([]);
    // Every replay landed its OWN identity in the derived stable form.
    const identities = result.replays.map((replay) => replay.identityId);
    expect(identities).toEqual(
      Array.from({ length: row.replayCount }, (_, index) => identityOf(row, index + 1)),
    );
    expect(new Set(identities).size).toBe(row.replayCount);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 2: the dropped replay (the population-gap catch)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the dropped replay", () => {
  test("a DROPPED ledger observation (the population has a gap) FAILs", async () => {
    const row = rowById("probe-dropped-replay");
    const result = await driveRowOverStack({ row, dropOrdinal: 3 });
    expect(result.terminal).toBe("FAILED");
    expect(result.population.complete).toBe(false);
    expect(result.population.droppedOrdinals).toEqual([3]);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "population-no-gaps")?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find((criterion) => criterion.criterionId === "population-no-gaps")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("GAP");
    // The ledger holds only the two identities that landed.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("an N-1 population (a missing ordinal) FAILs exactly like a dropped observation", () => {
    // The submitted population was one replay short: four replays were
    // declared, only three observations exist.
    const verdict = derivePopulationCompleteness({
      replayCount: 4,
      replays: [1, 2, 3].map((ordinal) => ({
        replayOrdinal: ordinal,
        identityId: `exp-workload-replay-${ordinal.toString(16)}`,
        replayed: false,
      })),
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingOrdinals).toEqual([4]);
    expect(verdict.observedCount).toBe(3);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "population-exactly-n")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find((criterion) => criterion.criterionId === "population-exactly-n")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("WRONG-COUNT");
  });

  test("a dropped trajectory read at the customer boundary FAILs the stability evidence", async () => {
    const { outcome } = await runAppOverFakeWorld({
      rowId: "probe-partial-population",
      dropOrdinal: 3,
    });
    expect(outcome.passed).toBe(false);
    // The third replay's events read was lost — its digest is null, so the
    // app's stability claim rests on a PARTIAL population.
    expect(outcome.trajectoryDigests[2]).toBeNull();
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-stability-full-population",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        outcome.appCriteria.find(
          (criterion) => criterion.criterionId === "app-stability-full-population",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("PARTIAL-POPULATION");
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-3-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
  });

  test("the honest population's every identity lands (the control)", async () => {
    const row = rowById("probe-dropped-replay");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.population.complete).toBe(true);
    expect(result.population.droppedOrdinals).toEqual([]);
    expect(result.population.missingOrdinals).toEqual([]);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("PASS");
    expect(result.criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family 3: the drifted trajectory (the pinned-class catch)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the drifted trajectory", () => {
  test("a DRIFT recorder that mutates one replay's capture FAILs the class membership (the ordinal named)", async () => {
    const row = rowById("probe-drifted-trajectory");
    const result = await driveRowOverStack({ row, driftOrdinal: 2 });
    expect(result.terminal).toBe("FAILED");
    expect(result.membership.allInClass).toBe(false);
    // The drifted replay's digest is OUT of the pinned class; the honest
    // replays stay in.
    expect(row.expectedTrajectoryClass).not.toContain(result.replays[1]?.trajectoryDigest ?? "");
    expect(row.expectedTrajectoryClass).toContain(result.replays[0]?.trajectoryDigest ?? "");
    expect(row.expectedTrajectoryClass).toContain(result.replays[2]?.trajectoryDigest ?? "");
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "trajectory-class-membership-replay-2",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find(
          (criterion) => criterion.criterionId === "trajectory-class-membership-replay-2",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DRIFTED");
    // The drifted replay also corrupts the population statistics — the
    // observed distribution no longer reproduces the pin.
    expect(result.stability.honest).toBe(false);
  });

  test("a fabricated drifted digest FAILs the membership derivation (the honest members pass)", () => {
    const row = rowById("probe-drifted-trajectory");
    // Every honest member of the pinned class reproduces.
    for (const member of row.expectedTrajectoryClass) {
      expect(
        deriveTrajectoryClassMembership({
          expectedClass: row.expectedTrajectoryClass,
          observed: [{ replayOrdinal: 1, digest: member }],
        }).allInClass,
      ).toBe(true);
    }
    // The drifted digest is outside the class — mechanically FAILed.
    const canonical = controlTrajectoryStepsOf({ workload: row.workload });
    const drifted = trajectoryDigestOf(
      canonical.map((step, index) =>
        index === canonical.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
      ),
    );
    const verdict = deriveTrajectoryClassMembership({
      expectedClass: row.expectedTrajectoryClass,
      observed: [{ replayOrdinal: 1, digest: drifted }],
    });
    expect(verdict.allInClass).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "trajectory-class-membership")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "trajectory-class-membership",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("OUT-OF-CLASS");
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "trajectory-class-membership-replay-1",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "trajectory-class-membership-replay-1",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DRIFTED");
  });

  test("a drifting events read surfaced through the PUBLIC wire FAILs the drifted replay's membership", async () => {
    const row = rowById("probe-drifted-trajectory");
    const { outcome } = await runAppOverFakeWorld({ rowId: row.rowId, driftOrdinal: 2 });
    expect(outcome.passed).toBe(false);
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-2-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        outcome.appCriteria.find(
          (criterion) => criterion.criterionId === "app-replay-2-trajectory-class-membership",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("OUT-OF-CLASS");
    // The honest replays stay in class at the customer boundary.
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-1-trajectory-class-membership",
      )?.status,
    ).toBe("PASS");
  });

  test("the honest population stays in-class on every replay (the control)", async () => {
    const row = rowById("probe-drifted-trajectory");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.membership.allInClass).toBe(true);
    for (const replay of result.replays) {
      expect(row.expectedTrajectoryClass).toContain(replay.trajectoryDigest ?? "");
    }
    expect(result.criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family 4: the partial population (the full-evidence catch)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the partial population", () => {
  const row = rowById("probe-partial-population");

  test("a stability claim asserted from a PARTIAL replay set (3 of 4 observations) FAILs", () => {
    const scheduled = scheduledDigestsOf(row);
    const verdict = deriveStabilityHonesty({
      expected: row.expectedStability,
      claimed: deriveStabilityReportOf(scheduled.slice(0, 3)),
      observedDigests: scheduled.slice(0, 3),
      expectedReplayCount: row.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a NULL digest among the observations is not evidence (the claim FAILs)", () => {
    const scheduled = scheduledDigestsOf(row);
    const withNull = [...scheduled.slice(0, 3), null];
    const verdict = deriveStabilityHonesty({
      expected: row.expectedStability,
      claimed: deriveStabilityReportOf(withNull),
      observedDigests: withNull,
      expectedReplayCount: row.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
        ?.status,
    ).toBe("FAIL");
  });

  test("the full population's stability claim passes (the honest four-replay analysis)", async () => {
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.stability.honest).toBe(true);
    expect(result.stability.observedKind).toBe("deterministic");
    expect(result.stability.observedDistribution).toEqual([
      { digest: scheduledDigestsOf(row)[0] ?? "", count: row.replayCount },
    ]);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
        ?.status,
    ).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the fabricated determinism (the variance-honesty catch)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the fabricated determinism", () => {
  const row = rowById("probe-fabricated-determinism");

  test("a SMOOTHED variance claimed deterministic FAILs (FABRICATED DETERMINISM)", () => {
    const scheduled = scheduledDigestsOf(row);
    expect(row.expectedStability.kind).toBe("varying");
    // The smoothed claim: the observed variance was flattened into a fake
    // determinism claim (one digest at count N).
    const smoothedClaim = {
      kind: "deterministic" as const,
      distribution: [{ digest: scheduled[0] ?? "", count: row.replayCount }],
    };
    const verdict = deriveStabilityHonesty({
      expected: row.expectedStability,
      claimed: smoothedClaim,
      observedDigests: scheduled,
      expectedReplayCount: row.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.observedKind).toBe("varying");
    expect(verdict.claimedKind).toBe("deterministic");
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "stability-claim-matches-observation",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "stability-claim-matches-observation",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("FABRICATED-DETERMINISM");
  });

  test("a world that SMOOTHS the variance away FAILs the app contract (the distribution mismatches the pin)", async () => {
    const { outcome } = await runAppOverFakeWorld({
      rowId: row.rowId,
      smoothedVariance: true,
    });
    expect(outcome.passed).toBe(false);
    // The smoothed world scheduled every replay identically — the app's
    // own honest report of that world is (fake) determinism over what the
    // pin declares varying.
    expect(outcome.population.stability.kind).toBe("deterministic");
    expect(row.expectedStability.kind).toBe("varying");
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-stability-claim-matches-pin",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        outcome.appCriteria.find(
          (criterion) => criterion.criterionId === "app-stability-claim-matches-pin",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DISTRIBUTION-MISMATCH");
  });

  test("the honest reported-varying analysis passes (variance REPORTED, never smoothed)", async () => {
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.stability.honest).toBe(true);
    expect(result.stability.observedKind).toBe("varying");
    expect(result.stability.observedDistribution).toHaveLength(2);
    // The observed distribution is the pinned one: two replays per class
    // member, REPORTED — never smoothed into a determinism claim.
    for (const entry of result.stability.observedDistribution) {
      expect(row.expectedTrajectoryClass).toContain(entry.digest);
      expect(entry.count).toBe(row.replayCount / 2);
    }
    expect(result.stability.observedKind).toBe(row.expectedStability.kind);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "stability-honesty-summary")
        ?.status,
    ).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The battery-level honest control (every offline population analysis)
// ---------------------------------------------------------------------------

describe("VAL-031 discrimination: the honest population analyses (the control)", () => {
  test("every offline row's population analysis passes honestly over the fixture stack", async () => {
    for (const offlineRow of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row: offlineRow });
      expect(result.terminal, `${offlineRow.rowId} terminal`).toBe(offlineRow.expected.terminal);
      expect(result.population.complete, `${offlineRow.rowId} complete`).toBe(true);
      expect(result.membership.allInClass, `${offlineRow.rowId} in class`).toBe(true);
      expect(result.stability.honest, `${offlineRow.rowId} stability honest`).toBe(true);
      expect(result.accounting.honest, `${offlineRow.rowId} accounting honest`).toBe(true);
      expect(result.latency.measured, `${offlineRow.rowId} latency measured`).toBe(true);
      expect(result.latency.count, `${offlineRow.rowId} latency count`).toBe(
        offlineRow.replayCount,
      );
      expect(result.observedModelCalls, `${offlineRow.rowId} population dispatches`).toBe(
        offlineRow.expectedModelCallsPerReplay * offlineRow.replayCount,
      );
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${offlineRow.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
});
