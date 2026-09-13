/**
 * VAL-031 acceptance criteria 1, 2, 4, 5: the workload-replay platform
 * slice against controlled fakes — the replay-population vocabulary
 * (the inert learning mode, the workload-replay experiment kind, the
 * population-probe and stability kinds), the PURE derivations that
 * make the population analysis trustworthy (the population
 * completeness matrix — honest N, a duplicated ordinal / duplicated
 * identity / dropped replay / gap / oversized population each FAILING;
 * the trajectory-class membership — every replay in the pinned
 * VAL-030 class, a drifted or never-captured trajectory FAILING with
 * the ordinal named; the stability honesty — deterministic rows
 * identical, varying rows reported varying with their observed
 * distribution, a fabricated determinism / misreported varying /
 * partial population / distribution mismatch each FAILING; the
 * accounting honesty — per-replay usage measured or honestly none,
 * population totals summed from measured values; the latency
 * distribution — measured min/max/median, never estimated), the digest
 * discipline (deterministic and payload-free), the replay identity
 * derivations (one immutable identity per replay, the VAL-007/030
 * ledger discipline), and the replay driver over every offline corpus
 * row — including the ADVERSARIAL worlds: the LEAKY ledger's
 * shoulder-in duplicate, the DROPPED ledger observation, the DRIFT
 * recorder's mutated capture, the trajectory-reuse contamination and
 * the uncommitted baseline pin.
 */

import { describe, expect, test } from "vitest";
import {
  OFFLINE_CORPUS_ROWS,
  WORKLOAD_REPLAY_CORPUS,
} from "../../../benchmarks/validation/apps/workload-replay/corpus";
import {
  createDefaultReplayBaselineRegistry,
  createInertReplayLearning,
  createReplayBaselineRegistry,
  createReplayLedger,
  createReplayRecorder,
  createTickClock,
} from "../../../benchmarks/validation/apps/workload-replay/fixtures";
import {
  controlTrajectoryStepsOf,
  identityContentDigestOf,
  longitudinalDigestOf,
  trajectoryClassOf,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import type {
  DigestDistributionEntry,
  ReplayStabilityPin,
  WorkloadReplayCorpusRow,
  WorkloadReplayResult,
} from "../../../benchmarks/validation/platform/workload-replay";
import {
  canonicalDigestDistributionOf,
  deriveLatencyDistribution,
  derivePopulationCompleteness,
  deriveReplayAccountingHonesty,
  deriveStabilityHonesty,
  deriveStabilityReportOf,
  deriveTrajectoryClassMembership,
  driveWorkloadReplay,
  isPopulationProbeKind,
  isStabilityKind,
  POPULATION_PROBE_KINDS,
  REPLAY_EXPERIMENT_KIND,
  REPLAY_LEARNING_MODE,
  replayIdentityIdOf,
  replayKeyOf,
  STABILITY_KINDS,
} from "../../../benchmarks/validation/platform/workload-replay";

const rowById = (rowId: string): WorkloadReplayCorpusRow => {
  const row = WORKLOAD_REPLAY_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: WorkloadReplayCorpusRow;
  readonly populationId?: string;
  readonly driftOrdinal?: number;
  readonly shoulderOrdinal?: number;
  readonly dropOrdinal?: number;
  readonly contaminate?: "trajectory-reuse";
  readonly committedRegistry?: boolean;
}): Promise<WorkloadReplayResult> {
  const { row } = options;
  const clock = createTickClock();
  const registry =
    options.committedRegistry === false
      ? createReplayBaselineRegistry()
      : createDefaultReplayBaselineRegistry();
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
    populationId: options.populationId ?? `pop-unit-${row.rowId}`,
    registry,
    ledger,
    recorder,
    learning,
    now: clock.now,
  });
}

/** The per-replay digests of one row's honest canonical schedule. */
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

// ---------------------------------------------------------------------------
// The vocabulary + the identity derivations
// ---------------------------------------------------------------------------

describe("VAL-031 platform vocabulary", () => {
  test("the replay-population vocabulary is pinned (inert learning, workload-replay)", () => {
    expect(REPLAY_LEARNING_MODE).toBe("inert");
    expect(REPLAY_EXPERIMENT_KIND).toBe("workload-replay");
  });

  test("the population-probe vocabulary is pinned (five discriminations)", () => {
    expect(POPULATION_PROBE_KINDS).toEqual([
      "duplicate-replay",
      "dropped-replay",
      "drifted-trajectory",
      "partial-population",
      "fabricated-determinism",
    ]);
    for (const kind of POPULATION_PROBE_KINDS) {
      expect(isPopulationProbeKind(kind)).toBe(true);
    }
    expect(isPopulationProbeKind("smoothed-variance")).toBe(false);
  });

  test("the stability vocabulary is pinned (deterministic, varying)", () => {
    expect(STABILITY_KINDS).toEqual(["deterministic", "varying"]);
    expect(isStabilityKind("deterministic")).toBe(true);
    expect(isStabilityKind("varying")).toBe(true);
    expect(isStabilityKind("sometimes")).toBe(false);
  });

  test("the replay key separates the N replays of one population (the identity basis)", () => {
    const row = rowById("text-summarize-replay-population");
    const populationId = "pop-key-unit";
    const keys = Array.from({ length: row.replayCount }, (_, index) =>
      replayKeyOf({ populationId, manifest: row.manifest, replayOrdinal: index + 1 }),
    );
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(keys[0]).toBe(
      [
        "replay",
        row.manifest.appId,
        row.manifest.workloadId,
        `r${row.manifest.workloadRevision}`,
        populationId,
        "replay-1",
      ].join(":"),
    );
    // The identity ids are the stable VAL-007 exp-<kind>-<digest> form.
    for (const key of keys) {
      expect(replayIdentityIdOf(key)).toBe(
        `exp-${REPLAY_EXPERIMENT_KIND}-${longitudinalDigestOf(key)}`,
      );
    }
    expect(new Set(keys.map((key) => replayIdentityIdOf(key))).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Population completeness (exactly N replays — no duplicates, no gaps)
// ---------------------------------------------------------------------------

describe("VAL-031 derivePopulationCompleteness", () => {
  const identity = (ordinal: number): string => `exp-workload-replay-${ordinal.toString(16)}`;

  test("the honest N-replay population is complete", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 4,
      replays: [1, 2, 3, 4].map((ordinal) => ({
        replayOrdinal: ordinal,
        identityId: identity(ordinal),
        replayed: false,
      })),
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.observedCount).toBe(4);
    expect(verdict.duplicateOrdinals).toEqual([]);
    expect(verdict.missingOrdinals).toEqual([]);
    expect(verdict.droppedOrdinals).toEqual([]);
    expect(verdict.duplicateIdentityIds).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DUPLICATED ordinal FAILS (the same replay counted twice)", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 3,
      replays: [
        { replayOrdinal: 1, identityId: identity(1), replayed: false },
        { replayOrdinal: 2, identityId: identity(2), replayed: false },
        { replayOrdinal: 2, identityId: identity(2), replayed: false },
      ],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.duplicateOrdinals).toEqual([2]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "population-no-duplicate-replays",
      )?.status,
    ).toBe("FAIL");
  });

  test("a MISSING ordinal (a gap in the population) FAILS", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 3,
      replays: [
        { replayOrdinal: 1, identityId: identity(1), replayed: false },
        { replayOrdinal: 3, identityId: identity(3), replayed: false },
      ],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingOrdinals).toEqual([2]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "population-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("a DUPLICATED identity (a replay that shouldered INTO an existing one) FAILS", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 3,
      replays: [
        { replayOrdinal: 1, identityId: identity(1), replayed: false },
        { replayOrdinal: 2, identityId: identity(1), replayed: true },
        { replayOrdinal: 3, identityId: identity(3), replayed: false },
      ],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.duplicateIdentityIds).toEqual([identity(1)]);
    expect(verdict.replayedOrdinals).toEqual([2]);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "population-no-duplicate-replays")
        ?.evidence.join(" "),
    ).toContain("DUPLICATED-REPLAY");
  });

  test("a DROPPED replay (a null identity observation) FAILS", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 3,
      replays: [
        { replayOrdinal: 1, identityId: identity(1), replayed: false },
        { replayOrdinal: 2, identityId: identity(2), replayed: false },
        { replayOrdinal: 3, identityId: null, replayed: false },
      ],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.droppedOrdinals).toEqual([3]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "population-no-gaps")?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "population-no-gaps")
        ?.evidence.join(" "),
    ).toContain("GAP");
  });

  test("an OVERSIZED population (N+1 replays) FAILS just as a partial one does", () => {
    const verdict = derivePopulationCompleteness({
      replayCount: 2,
      replays: [1, 2, 3].map((ordinal) => ({
        replayOrdinal: ordinal,
        identityId: identity(ordinal),
        replayed: false,
      })),
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.observedCount).toBe(3);
    expect(verdict.expectedCount).toBe(2);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "population-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("a non-positive replay count is not a population (an out-of-range ordinal FAILS too)", () => {
    expect(derivePopulationCompleteness({ replayCount: 0, replays: [] }).complete).toBe(false);
    const outOfRange = derivePopulationCompleteness({
      replayCount: 1,
      replays: [{ replayOrdinal: 2, identityId: identity(2), replayed: false }],
    });
    expect(outOfRange.complete).toBe(false);
    expect(outOfRange.missingOrdinals).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Trajectory-class membership (every replay in the pinned class)
// ---------------------------------------------------------------------------

describe("VAL-031 deriveTrajectoryClassMembership", () => {
  test("every member of a multi-member class is honest (all replays in-class PASS)", () => {
    const row = rowById("order-settlement-varying-replay-population");
    expect(row.expectedTrajectoryClass).toHaveLength(2);
    const verdict = deriveTrajectoryClassMembership({
      expectedClass: row.expectedTrajectoryClass,
      observed: [1, 2, 3, 4].map((ordinal) => ({
        replayOrdinal: ordinal,
        digest: row.expectedTrajectoryClass[(ordinal - 1) % 2] ?? null,
      })),
    });
    expect(verdict.allInClass).toBe(true);
    expect(verdict.classSize).toBe(2);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an OUT-OF-CLASS digest FAILS with the drifted ordinal named", () => {
    const row = rowById("text-summarize-replay-population");
    const verdict = deriveTrajectoryClassMembership({
      expectedClass: row.expectedTrajectoryClass,
      observed: [
        { replayOrdinal: 1, digest: row.expectedTrajectoryClass[0] ?? "" },
        { replayOrdinal: 2, digest: longitudinalDigestOf("drifted") },
        { replayOrdinal: 3, digest: row.expectedTrajectoryClass[0] ?? "" },
      ],
    });
    expect(verdict.allInClass).toBe(false);
    const outOfClass = verdict.criteria.find(
      (criterion) => criterion.criterionId === "trajectory-class-membership-replay-2",
    );
    expect(outOfClass?.status).toBe("FAIL");
    expect(outOfClass?.evidence.join(" ")).toContain("DRIFTED");
  });

  test("a NULL digest (a trajectory never captured) FAILS its membership leg", () => {
    const row = rowById("rag-retrieval-replay-population");
    const verdict = deriveTrajectoryClassMembership({
      expectedClass: row.expectedTrajectoryClass,
      observed: [
        { replayOrdinal: 1, digest: row.expectedTrajectoryClass[0] ?? "" },
        { replayOrdinal: 2, digest: null },
      ],
    });
    expect(verdict.allInClass).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "trajectory-class-membership-replay-2")
        ?.evidence.join(" "),
    ).toContain("NOT-CAPTURED");
  });

  test("a degenerate class (no pinned members) never passes", () => {
    const verdict = deriveTrajectoryClassMembership({
      expectedClass: [],
      observed: [{ replayOrdinal: 1, digest: "00000000" }],
    });
    expect(verdict.allInClass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stability honesty (variance is REPORTED, never smoothed)
// ---------------------------------------------------------------------------

describe("VAL-031 deriveStabilityHonesty", () => {
  const deterministicRow = rowById("text-summarize-replay-population");
  const varyingRow = rowById("order-settlement-varying-replay-population");

  const digestAt = (row: WorkloadReplayCorpusRow, index: number): string =>
    scheduledDigestsOf(row)[index] ?? "";

  test("a deterministic population with identical digests is honest", () => {
    const observedDigests = scheduledDigestsOf(deterministicRow);
    const verdict = deriveStabilityHonesty({
      expected: deterministicRow.expectedStability,
      claimed: deriveStabilityReportOf(observedDigests),
      observedDigests,
      expectedReplayCount: deterministicRow.replayCount,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.observedKind).toBe("deterministic");
    expect(verdict.observedDistribution).toHaveLength(1);
    expect(verdict.observedDistribution[0]?.count).toBe(5);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a varying population REPORTED varying with its observed distribution is honest", () => {
    const observedDigests = scheduledDigestsOf(varyingRow);
    expect(new Set(observedDigests).size).toBe(2);
    const verdict = deriveStabilityHonesty({
      expected: varyingRow.expectedStability,
      claimed: deriveStabilityReportOf(observedDigests),
      observedDigests,
      expectedReplayCount: varyingRow.replayCount,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.observedKind).toBe("varying");
    expect(verdict.observedDistribution).toEqual([
      { digest: digestAt(varyingRow, 0), count: 2 },
      { digest: digestAt(varyingRow, 1), count: 2 },
    ]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("FABRICATED DETERMINISM (a deterministic claim over an observed variance) FAILS", () => {
    const observedDigests = scheduledDigestsOf(varyingRow);
    // The smoothed claim: one digest at count N over a population that
    // honestly varies — the fake determinism the derivation must catch.
    const smoothed: ReplayStabilityPin = {
      kind: "deterministic",
      distribution: [{ digest: observedDigests[0] ?? "", count: varyingRow.replayCount }],
    };
    const verdict = deriveStabilityHonesty({
      expected: varyingRow.expectedStability,
      claimed: smoothed,
      observedDigests,
      expectedReplayCount: varyingRow.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "stability-claim-matches-observation")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-DETERMINISM");
  });

  test("MISREPORTED VARYING (a varying claim over a deterministic population) FAILS", () => {
    const observedDigests = scheduledDigestsOf(deterministicRow);
    const misreported: ReplayStabilityPin = {
      kind: "varying",
      distribution: [
        { digest: observedDigests[0] ?? "", count: 3 },
        { digest: longitudinalDigestOf("phantom"), count: 2 },
      ],
    };
    const verdict = deriveStabilityHonesty({
      expected: deterministicRow.expectedStability,
      claimed: misreported,
      observedDigests,
      expectedReplayCount: deterministicRow.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.observedKind).toBe("deterministic");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "stability-claim-matches-observation")
        ?.evidence.join(" "),
    ).toContain("MISREPORTED-VARYING");
  });

  test("a PARTIAL population (a stability claim from N-1 observations) FAILS", () => {
    const observedDigests = scheduledDigestsOf(deterministicRow).slice(0, 4);
    const verdict = deriveStabilityHonesty({
      expected: deterministicRow.expectedStability,
      claimed: deriveStabilityReportOf(observedDigests),
      observedDigests,
      expectedReplayCount: deterministicRow.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "stability-full-population")
        ?.evidence.join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a NULL digest among the observations FAILS (missing evidence)", () => {
    const observedDigests: (string | null)[] = [...scheduledDigestsOf(deterministicRow)];
    observedDigests[2] = null;
    const verdict = deriveStabilityHonesty({
      expected: deterministicRow.expectedStability,
      claimed: deriveStabilityReportOf(observedDigests),
      observedDigests,
      expectedReplayCount: deterministicRow.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stability-full-population")
        ?.status,
    ).toBe("FAIL");
  });

  test("a DISTRIBUTION MISMATCH against the pin FAILS (a drifted replay changes the statistics)", () => {
    const observedDigests: (string | null)[] = [...scheduledDigestsOf(deterministicRow)];
    observedDigests[4] = longitudinalDigestOf("drifted");
    const verdict = deriveStabilityHonesty({
      expected: deterministicRow.expectedStability,
      claimed: deriveStabilityReportOf(observedDigests),
      observedDigests,
      expectedReplayCount: deterministicRow.replayCount,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.observedKind).toBe("varying");
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stability-claim-matches-pin")
        ?.status,
    ).toBe("FAIL");
  });

  test("the honest report derivation REPORTS variance, never smooths it", () => {
    // A deterministic population reports one digest at count N.
    const deterministic = deriveStabilityReportOf(scheduledDigestsOf(deterministicRow));
    expect(deterministic.kind).toBe("deterministic");
    expect(deterministic.distribution).toHaveLength(1);
    // A varying population reports BOTH digests at their honest counts.
    const varying = deriveStabilityReportOf(scheduledDigestsOf(varyingRow));
    expect(varying.kind).toBe("varying");
    expect(canonicalDigestDistributionOf(scheduledDigestsOf(varyingRow))).toEqual(
      varying.distribution,
    );
    // Nulls never enter the distribution (they are missing evidence).
    expect(
      deriveStabilityReportOf([null, scheduledDigestsOf(deterministicRow)[0] ?? "", null])
        .distribution,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Latency distribution (measured, never estimated)
// ---------------------------------------------------------------------------

describe("VAL-031 deriveLatencyDistribution", () => {
  test("the measured min/max/median over an odd population", () => {
    const verdict = deriveLatencyDistribution({
      perReplayLatencyMs: [12, 5, 30, 7, 20],
      expectedReplayCount: 5,
    });
    expect(verdict.measured).toBe(true);
    expect(verdict.count).toBe(5);
    expect(verdict.minMs).toBe(5);
    expect(verdict.maxMs).toBe(30);
    expect(verdict.medianMs).toBe(12);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the even population's median is the mean of the two middles", () => {
    const verdict = deriveLatencyDistribution({
      perReplayLatencyMs: [4, 1, 10, 5],
      expectedReplayCount: 4,
    });
    expect(verdict.medianMs).toBe(4.5);
    expect(verdict.minMs).toBe(1);
    expect(verdict.maxMs).toBe(10);
  });

  test("a NULL latency FAILS (latency is never estimated); a negative FAILS too", () => {
    expect(
      deriveLatencyDistribution({ perReplayLatencyMs: [1, null, 3], expectedReplayCount: 3 })
        .measured,
    ).toBe(false);
    expect(
      deriveLatencyDistribution({ perReplayLatencyMs: [1, -5, 3], expectedReplayCount: 3 })
        .measured,
    ).toBe(false);
    expect(
      deriveLatencyDistribution({ perReplayLatencyMs: [1, 0, 3], expectedReplayCount: 3 }).measured,
    ).toBe(true);
  });

  test("a partial latency population FAILS; a single replay's min=max=median", () => {
    expect(
      deriveLatencyDistribution({ perReplayLatencyMs: [1, 2], expectedReplayCount: 3 }).measured,
    ).toBe(false);
    const single = deriveLatencyDistribution({ perReplayLatencyMs: [9], expectedReplayCount: 1 });
    expect(single.measured).toBe(true);
    expect(single.minMs).toBe(9);
    expect(single.maxMs).toBe(9);
    expect(single.medianMs).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Accounting honesty over the replay population (VAL-006 discipline)
// ---------------------------------------------------------------------------

describe("VAL-031 deriveReplayAccountingHonesty", () => {
  test("an offline population reports NO usage honestly, with measured totals", () => {
    const verdict = deriveReplayAccountingHonesty({
      needsDispatch: false,
      perReplayUsage: [null, null, null],
      perReplayLatencyMs: [4, 6, 5],
      expectedReplayCount: 3,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.totals).not.toBeNull();
    expect(verdict.totals?.totalInputTokens).toBe(0);
    expect(verdict.totals?.totalOutputTokens).toBe(0);
    expect(verdict.totals?.totalCostUsd).toBeNull();
    expect(verdict.totals?.totalLatencyMs).toBe(15);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an offline population that FABRICATES usage FAILs (no model was dispatched)", () => {
    const verdict = deriveReplayAccountingHonesty({
      needsDispatch: false,
      perReplayUsage: [null, { inputTokens: 1, outputTokens: 1 }, null],
      perReplayLatencyMs: [4, 6, 5],
      expectedReplayCount: 3,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.totals).toBeNull();
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "replay-usage-honest")
        ?.evidence.join(" "),
    ).toContain("FABRICATED");
  });

  test("a live population demands MEASURED usage per replay (its absence FAILs)", () => {
    const measured = deriveReplayAccountingHonesty({
      needsDispatch: true,
      perReplayUsage: [
        { inputTokens: 30, outputTokens: 6, costUsd: 0.001 },
        { inputTokens: 30, outputTokens: 6, costUsd: 0.001 },
      ],
      perReplayLatencyMs: [40, 44],
      expectedReplayCount: 2,
    });
    expect(measured.honest).toBe(true);
    expect(measured.totals?.totalInputTokens).toBe(60);
    expect(measured.totals?.totalOutputTokens).toBe(12);
    expect(measured.totals?.totalCostUsd).toBeCloseTo(0.002);
    expect(measured.totals?.totalLatencyMs).toBe(84);
    const missing = deriveReplayAccountingHonesty({
      needsDispatch: true,
      perReplayUsage: [{ inputTokens: 30, outputTokens: 6 }, null],
      perReplayLatencyMs: [40, 44],
      expectedReplayCount: 2,
    });
    expect(missing.honest).toBe(false);
  });

  test("per-replay latencies must be measured and complete (counts mismatch FAILs)", () => {
    expect(
      deriveReplayAccountingHonesty({
        needsDispatch: false,
        perReplayUsage: [null, null],
        perReplayLatencyMs: [1, 2, 3],
        expectedReplayCount: 2,
      }).honest,
    ).toBe(false);
    expect(
      deriveReplayAccountingHonesty({
        needsDispatch: false,
        perReplayUsage: [null, null, null],
        perReplayLatencyMs: [1, 2, null],
        expectedReplayCount: 3,
      }).honest,
    ).toBe(false);
    expect(
      deriveReplayAccountingHonesty({
        needsDispatch: false,
        perReplayUsage: [],
        perReplayLatencyMs: [],
        expectedReplayCount: 0,
      }).honest,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + the corpus pins
// ---------------------------------------------------------------------------

describe("VAL-031 digest discipline + the corpus pins", () => {
  test("the corpus pins are internally consistent (class, distribution, counts)", () => {
    for (const row of WORKLOAD_REPLAY_CORPUS) {
      // The pinned class is the baseline's VAL-030 class.
      const klass = trajectoryClassOf({
        workload: row.workload,
        ...(row.effectOrderings === undefined ? {} : { equivalentOrderings: row.effectOrderings }),
      });
      expect(row.expectedTrajectoryClass).toEqual(klass);
      // The pinned stability distribution is the honest schedule report.
      const digests = scheduledDigestsOf(row);
      expect(row.expectedStability).toEqual(deriveStabilityReportOf(digests));
      // Every distribution digest is a member of the pinned class, and
      // the counts sum to N (the full population's evidence).
      const total = row.expectedStability.distribution.reduce((sum, entry) => sum + entry.count, 0);
      expect(total).toBe(row.replayCount);
      for (const entry of row.expectedStability.distribution) {
        expect(row.expectedTrajectoryClass).toContain(entry.digest);
      }
      // The identity expectations: one immutable identity per replay.
      expect(row.expected.ledgerIdentities).toBe(row.replayCount);
      expect(row.expected.appCreated).toBe(row.replayCount);
      expect(row.expected.replayedSubmissions).toBe(0);
    }
  });

  test("the replay digests are deterministic, distinct and payload-free", () => {
    const row = rowById("rag-retrieval-replay-population");
    const digests = scheduledDigestsOf(row);
    // Deterministic and well-shaped.
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(digests[0]).toBe(digests[0]);
    // Distinct schedules, distinct digests.
    const other = scheduledDigestsOf(rowById("order-settlement-varying-replay-population"));
    expect(new Set(other).size).toBe(2);
    // The digests never leak the payload bytes.
    for (const digest of [...digests, ...other]) {
      expect(digest).not.toContain("CIT-201");
      expect(digest).not.toContain("ORD-501");
      expect(digest).not.toContain("notify");
    }
    expect(longitudinalDigestOf("a")).not.toBe(longitudinalDigestOf("b"));
  });

  test("the replay identity content digest binds the manifest + trajectory digests", () => {
    const first = identityContentDigestOf({
      manifestDigest: "aaaaaaaa",
      trajectoryDigest: "bbbbbbbb",
    });
    expect(first).toBe(
      identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "bbbbbbbb" }),
    );
    expect(first).not.toBe(
      identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "cccccccc" }),
    );
    expect(first).not.toBe(
      identityContentDigestOf({ manifestDigest: "dddddddd", trajectoryDigest: "bbbbbbbb" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest stack)
// ---------------------------------------------------------------------------

describe("VAL-031 driver over the honest offline corpus", () => {
  test("every offline row reaches its oracle terminal with every criterion PASS", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // The population is complete: exactly N replays, N identities.
      expect(result.population.complete).toBe(true);
      expect(result.replays).toHaveLength(row.replayCount);
      expect(result.population.observedCount).toBe(row.replayCount);
      // Every replay's digest is in the pinned class.
      expect(result.membership.allInClass).toBe(true);
      // The stability report reproduces the pin.
      expect(result.stability.honest).toBe(true);
      expect(result.stability.observedDistribution).toEqual(row.expectedStability.distribution);
      // Accounting + latency honest; the pin committed.
      expect(result.accounting.honest).toBe(true);
      expect(result.latency.measured).toBe(true);
      // The population made its own dispatches (N × per-replay demand).
      expect(result.observedModelCalls).toBe(row.expectedModelCallsPerReplay * row.replayCount);
    }
  });

  test("the deterministic rows observe IDENTICAL digests across the N replays", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expectedStability.kind === "deterministic",
    )) {
      const result = await driveRowOverStack({ row });
      const digests = result.replays.map((replay) => replay.trajectoryDigest);
      expect(new Set(digests).size, `${row.rowId} distinct digests`).toBe(1);
      expect(digests[0]).toBe(row.expectedStability.distribution[0]?.digest);
    }
  });

  test("the varying row observes the pinned distribution (REPORTED varying)", async () => {
    const row = rowById("order-settlement-varying-replay-population");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.stability.observedKind).toBe("varying");
    expect(result.stability.observedDistribution).toEqual([
      { digest: row.expectedTrajectoryClass[0], count: 2 },
      { digest: row.expectedTrajectoryClass[1], count: 2 },
    ]);
    // Every replay's digest is still a member of the pinned class.
    for (const replay of result.replays) {
      expect(row.expectedTrajectoryClass).toContain(replay.trajectoryDigest);
    }
  });

  test("the guard population FAILS honestly every replay (zero dispatches, identical guard digests)", async () => {
    const row = rowById("oversized-batch-guard-replay-population");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("FAILED");
    expect(result.replays).toHaveLength(3);
    for (const replay of result.replays) {
      expect(replay.outcome).toBe("FAILED");
      expect(replay.failure?.category).toBe("precondition-rejected");
      expect(replay.modelCalls).toBe(0);
      expect(replay.usage).toBeNull();
    }
    const digests = result.replays.map((replay) => replay.trajectoryDigest);
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toBe(row.expectedTrajectoryClass[0]);
    expect(result.observedModelCalls).toBe(0);
  });

  test("every replay's ledger identity is the derived stable form; latencies are measured", async () => {
    const row = rowById("tool-agent-loop-replay-population");
    const populationId = "pop-identity-unit";
    const result = await driveRowOverStack({ row, populationId });
    for (const replay of result.replays) {
      expect(replay.identityId).toBe(
        replayIdentityIdOf(
          replayKeyOf({
            populationId,
            manifest: row.manifest,
            replayOrdinal: replay.replayOrdinal,
          }),
        ),
      );
      expect(replay.replayed).toBe(false);
      expect(replay.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.latency.count).toBe(row.replayCount);
    expect(result.latency.measured).toBe(true);
    // The offline population reports NO usage honestly.
    expect(result.usage).toBeNull();
    expect(result.accounting.totals?.totalLatencyMs).toBe(
      result.replays.reduce((sum, replay) => sum + replay.latencyMs, 0),
    );
  });

  test("a live row without a dispatch seam is a configuration error", async () => {
    const row = WORKLOAD_REPLAY_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const clock = createTickClock();
    await expect(
      driveWorkloadReplay({
        row: row as WorkloadReplayCorpusRow,
        populationId: "pop-live",
        registry: createDefaultReplayBaselineRegistry(),
        ledger: createReplayLedger(),
        recorder: createReplayRecorder(),
        learning: createInertReplayLearning(),
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the leak / drop / drift / reuse catches)
// ---------------------------------------------------------------------------

describe("VAL-031 adversarial replay-population worlds", () => {
  test("a LEAKY ledger (a shoulder-in duplicate identity) FAILS the population", async () => {
    const row = rowById("probe-duplicate-replay");
    const result = await driveRowOverStack({ row, shoulderOrdinal: 2 });
    expect(result.terminal).toBe("FAILED");
    expect(result.population.complete).toBe(false);
    expect(result.population.duplicateIdentityIds).toHaveLength(1);
    expect(result.population.replayedOrdinals).toEqual([2]);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "population-no-duplicate-replays",
      )?.status,
    ).toBe("FAIL");
    // The shoulder-in left only TWO identities for THREE replays.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("a DROPPED ledger observation FAILS the population (a gap)", async () => {
    const row = rowById("probe-dropped-replay");
    const result = await driveRowOverStack({ row, dropOrdinal: 3 });
    expect(result.terminal).toBe("FAILED");
    expect(result.population.complete).toBe(false);
    expect(result.population.droppedOrdinals).toEqual([3]);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "population-no-gaps")?.status,
    ).toBe("FAIL");
    expect(result.replays[2]?.identityId).toBeNull();
    // The dropped observation left only TWO identities for THREE replays.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-identities-exactly-n")
        ?.status,
    ).toBe("FAIL");
  });

  test("a DRIFT recorder FAILS the class membership (the drifted ordinal named)", async () => {
    const row = rowById("probe-drifted-trajectory");
    const result = await driveRowOverStack({ row, driftOrdinal: 2 });
    expect(result.terminal).toBe("FAILED");
    expect(result.membership.allInClass).toBe(false);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "trajectory-class-membership-replay-2",
      )?.status,
    ).toBe("FAIL");
    // The deterministic population lost its stability too: one drifted
    // digest makes the observed distribution mismatch the pin.
    expect(result.stability.honest).toBe(false);
    expect(result.stability.observedKind).toBe("varying");
  });

  test("a drift on the VARYING row still FAILs (out of class + distribution mismatch)", async () => {
    const row = rowById("order-settlement-varying-replay-population");
    const result = await driveRowOverStack({ row, driftOrdinal: 2 });
    expect(result.terminal).toBe("FAILED");
    expect(result.membership.allInClass).toBe(false);
    expect(result.stability.honest).toBe(false);
    const distribution: readonly DigestDistributionEntry[] = result.stability.observedDistribution;
    expect(distribution).toHaveLength(3);
  });

  test("a trajectory-REUSE contaminated population under-dispatches and FAILs", async () => {
    const row = rowById("tool-agent-loop-replay-population");
    const result = await driveRowOverStack({ row, contaminate: "trajectory-reuse" });
    expect(result.terminal).toBe("FAILED");
    expect(result.observedModelCalls).toBe(0);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "population-own-dispatch-total")
        ?.status,
    ).toBe("FAIL");
    // The reused rounds recorded NO dispatch steps — every replay's
    // trajectory is mechanically out of the recorded class.
    expect(result.membership.allInClass).toBe(false);
    expect(result.stability.honest).toBe(false);
  });

  test("an UNCOMMITTED baseline pin FAILs the row (the registry is the read-only input)", async () => {
    const row = rowById("text-summarize-replay-population");
    const result = await driveRowOverStack({ row, committedRegistry: false });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "baseline-pin-committed")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "baseline-pin-committed")
        ?.evidence.join(" "),
    ).toContain("UNCOMMITTED");
  });
});
