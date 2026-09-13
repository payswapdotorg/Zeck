/**
 * VAL-025 acceptance criterion 6 — discrimination tests proving the
 * concurrency invariants against controlled fakes:
 *
 *   * double-arbitration — a leaky submission seam that admits BOTH
 *     racers under one key is mechanically failed (the race verdict's
 *     distinct-identity count; the ledger's row-count delta);
 *   * journal double-write — more journaled records than driven
 *     submission attempts FAILS the journal-exactly-once-per-attempt
 *     criterion (and a drop fails it symmetrically);
 *   * phantom execution — an extra durable execution row without a
 *     submission key FAILS the no-phantom criterion;
 *   * orphan transition — an event with no parent execution row
 *     FAILS the no-orphan criterion;
 *   * ceiling bypass — a gate that admits beyond the declared ceiling
 *     FAILS the shaping criterion (and the driver's row honestly);
 *   * the over-denying gate — a gate that never releases freed slots
 *     FAILS the slot-release shape (the later wave's admission);
 *   * serialized fan-out — disjoint windows (head-of-line blocking)
 *     FAIL the overlap criterion and contiguous journals never
 *     interleave;
 *   * the re-arbitrated replay key — a soak round whose replay probe
 *     created a second execution FAILS the soak invariants.
 */

import { describe, expect, test } from "vitest";
import { OFFLINE_CORPUS_ROWS } from "../../benchmarks/validation/apps/concurrency-soak/corpus";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createSoakWorld,
  createTickClock,
  type FakeLedger,
} from "../../benchmarks/validation/apps/concurrency-soak/fixtures";
import {
  type ConcurrencyCorpusRow,
  type ConcurrencyLifecyclePort,
  type ConcurrencySubmissionSeam,
  type ConcurrencyWorldFacts,
  deriveCeilingShaping,
  deriveConcurrencyRowCriteria,
  deriveFanoutParallelism,
  deriveJournalInterleaving,
  deriveRaceArbitration,
  deriveSoakInvariants,
  driveConcurrencyRow,
  type JournalTimelineEntry,
  type SubmissionObservation,
} from "../../benchmarks/validation/platform/concurrency-soak";

const noSleep = async () => {};

const rowById = (rowId: string): ConcurrencyCorpusRow => {
  const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Fire N concurrent creates through the seam under ONE key. */
async function fireRacingGroup(
  seam: ConcurrencySubmissionSeam,
  key: string,
  count: number,
  options?: { readonly mutatedPeer?: boolean },
): Promise<readonly SubmissionObservation[]> {
  const bodies = Array.from({ length: count }, (_, index) => ({
    kind: "concurrency-soak.settlement.v1",
    lane: index === 1 && options?.mutatedPeer === true ? "mutated" : 0,
  }));
  return Promise.all(bodies.map((body) => seam({ key, body })));
}

/** Fire N concurrent creates through the seam under distinct keys. */
async function fireDistinctLanes(
  seam: ConcurrencySubmissionSeam,
  keys: readonly string[],
): Promise<readonly SubmissionObservation[]> {
  return Promise.all(
    keys.map((key) => seam({ key, body: { kind: "concurrency-soak.settlement.v1", lane: key } })),
  );
}

/** Submit the row's app-side lanes through the seam (upfront, concurrent per group). */
async function submitAppLanes(
  seam: ConcurrencySubmissionSeam,
  row: ConcurrencyCorpusRow,
): Promise<readonly (readonly string[])[]> {
  const landedPerGroup: string[][] = [];
  if (row.pattern === "same-key-race") {
    const count =
      row.expected.appCreated + row.expected.replayedSubmissions + row.expected.rejectedSubmissions;
    const observations = await fireRacingGroup(seam, `disc-app-${row.rowId}-race`, count, {
      mutatedPeer: row.rowId === "same-key-race-conflict",
    });
    landedPerGroup.push([
      ...new Set(observations.map((o) => o.executionId).filter((id) => id !== "")),
    ]);
  } else if (row.pattern === "distinct-key-fanout") {
    const keys = Array.from(
      { length: row.submissions.count },
      (_, lane) => `disc-app-${row.rowId}-l${lane}`,
    );
    const observations = await fireDistinctLanes(seam, keys);
    landedPerGroup.push(observations.map((o) => o.executionId));
  } else if (row.pattern === "over-ceiling-burst") {
    const waves = row.burstWaves ?? [row.submissions.count];
    let laneCursor = 0;
    for (const wave of waves) {
      const keys = Array.from(
        { length: wave },
        (_, index) => `disc-app-${row.rowId}-w-l${laneCursor + index}`,
      );
      const observations = await fireDistinctLanes(seam, keys);
      landedPerGroup.push(observations.map((o) => o.executionId));
      laneCursor += wave;
    }
  } else if (row.pattern === "soak-rounds") {
    const soak = row.soak ?? { rounds: 1, interRoundSpacingMs: 0 };
    for (let round = 1; round <= soak.rounds; round += 1) {
      const raceObservations = await fireRacingGroup(
        seam,
        `disc-app-${row.rowId}-r${round}-race`,
        2,
      );
      const distinctObservations = await fireDistinctLanes(seam, [
        `disc-app-${row.rowId}-r${round}-l1`,
        `disc-app-${row.rowId}-r${round}-l2`,
      ]);
      landedPerGroup.push([
        ...new Set(
          [...raceObservations, ...distinctObservations]
            .map((o) => o.executionId)
            .filter((id) => id !== ""),
        ),
      ]);
    }
  }
  return landedPerGroup;
}

/** Drive one row over a purpose-built fake stack (the leaky variants). */
async function driveRowOverStack(options: {
  readonly row: ConcurrencyCorpusRow;
  readonly lifecycle: ConcurrencyLifecyclePort;
  readonly seam: ConcurrencySubmissionSeam;
  readonly ledger: FakeLedger;
}): Promise<Awaited<ReturnType<typeof driveConcurrencyRow>>> {
  const { row, lifecycle, seam, ledger } = options;
  const baseline: ConcurrencyWorldFacts = ledger.facts();
  const landedPerGroup = await submitAppLanes(seam, row);
  return driveConcurrencyRow({
    row,
    lifecycle,
    world: createSoakWorld(ledger.clock),
    baseline,
    worldFacts: () => ledger.facts(),
    landedProvider: async (group) => landedPerGroup[group - 1] ?? [],
    submissionSeam: seam,
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    runSuffix: "disc",
    now: ledger.clock.now,
    sleep: async (ms) => ledger.clock.tick(ms),
  });
}

// ---------------------------------------------------------------------------
// Double arbitration (the leaky racing seam)
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: double arbitration", () => {
  test("a leaky seam admitting BOTH racers FAILS the race verdict mechanically", () => {
    const verdict = deriveRaceArbitration([
      {
        executionId: "exec-1",
        replayed: false,
        status: "CREATED",
        rejection: null,
        submittedAt: 0,
        latencyMs: 1,
      },
      {
        executionId: "exec-2",
        replayed: false,
        status: "CREATED",
        rejection: null,
        submittedAt: 0,
        latencyMs: 1,
      },
    ]);
    expect(verdict.exactlyOneExecution).toBe(false);
    expect(verdict.distinctExecutionIds).toEqual(["exec-1", "exec-2"]);
  });

  test("a leaky seam FAILS the racing row honestly (the criteria, not a tolerance)", async () => {
    const row = rowById("same-key-race-pair");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const leakySeam = createFakeSubmissionSeam({ ledger, leaky: true });
    const result = await driveRowOverStack({ row, lifecycle, seam: leakySeam, ledger });
    expect(result.terminal).toBe("FAILED");
    // The double admission surfaced TWO durable rows for the racing
    // lane's ONE expected landed execution — the driver's landed-count
    // discipline catches it (and the probe verdict criterion FAILs on
    // the aborted probe battery).
    expect(result.failure?.category).toBe("landed-count-mismatch");
    expect(
      result.criteria.find((c) => c.criterionId === "race-arbitration-exactly-once")?.status,
    ).toBe("FAIL");
  });

  test("an honest seam never double-admits (the control)", async () => {
    const row = rowById("same-key-race-pair");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    expect(result.terminal).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Journal double-write / drop (the exactly-once-per-attempt discipline)
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: journal double-write and drop", () => {
  const baseInput = {
    row: rowById("same-key-race-pair"),
    executions: [],
    probes: [],
    rounds: [],
    baseline: { executionCount: 0, eventCount: 0, idempotencyRecordCount: 0, orphanEventCount: 0 },
    journalTimeline: [] as JournalTimelineEntry[],
    failure: null,
    soakWindowMs: null,
  };

  test("a journal double-write (more journaled than driven attempts) FAILS", () => {
    const criteria = deriveConcurrencyRowCriteria({
      ...baseInput,
      journaledAttempts: 3,
      seamAttempts: 2,
      finalFacts: {
        executionCount: 2,
        eventCount: 5,
        idempotencyRecordCount: 2,
        orphanEventCount: 0,
      },
    });
    expect(criteria.find((c) => c.criterionId === "journal-exactly-once-per-attempt")?.status).toBe(
      "FAIL",
    );
  });

  test("a journal drop (fewer journaled than driven attempts) FAILS symmetrically", () => {
    const criteria = deriveConcurrencyRowCriteria({
      ...baseInput,
      journaledAttempts: 1,
      seamAttempts: 2,
      finalFacts: {
        executionCount: 2,
        eventCount: 5,
        idempotencyRecordCount: 2,
        orphanEventCount: 0,
      },
    });
    expect(criteria.find((c) => c.criterionId === "journal-exactly-once-per-attempt")?.status).toBe(
      "FAIL",
    );
  });

  test("the honest driver journals exactly once per attempt (the control)", async () => {
    const row = rowById("same-key-race-pair");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    const journal = result.criteria.find(
      (c) => c.criterionId === "journal-exactly-once-per-attempt",
    );
    expect(journal?.status).toBe("PASS");
    // The fake lifecycle's own step-event journal holds EXACTLY the
    // driver's records (a ledger-side double-write would diverge).
    const seamRecords = lifecycle.journal.stepEvents.filter(
      (entry) => entry.record.kind === "race-observation",
    );
    expect(seamRecords.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phantom executions + orphan ledger transitions
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: phantom executions and orphan transitions", () => {
  const baseInput = {
    row: rowById("distinct-key-fanout-parallel"),
    executions: [],
    probes: [],
    rounds: [],
    baseline: { executionCount: 0, eventCount: 0, idempotencyRecordCount: 0, orphanEventCount: 0 },
    journalTimeline: [] as JournalTimelineEntry[],
    journaledAttempts: 0,
    seamAttempts: 0,
    failure: null,
    soakWindowMs: null,
  };

  test("a phantom execution row (an extra durable row) FAILS", () => {
    const criteria = deriveConcurrencyRowCriteria({
      ...baseInput,
      finalFacts: {
        executionCount: 5,
        eventCount: 9,
        idempotencyRecordCount: 4,
        orphanEventCount: 0,
      },
    });
    expect(criteria.find((c) => c.criterionId === "no-phantom-executions")?.status).toBe("FAIL");
    // The drift criterion catches the matching ledger shape.
    expect(criteria.find((c) => c.criterionId === "no-ledger-drift")?.status).toBe("PASS");
  });

  test("an orphan ledger transition (an event with no parent row) FAILS", () => {
    const criteria = deriveConcurrencyRowCriteria({
      ...baseInput,
      finalFacts: {
        executionCount: 4,
        eventCount: 9,
        idempotencyRecordCount: 4,
        orphanEventCount: 1,
      },
    });
    expect(criteria.find((c) => c.criterionId === "no-orphan-ledger-transitions")?.status).toBe(
      "FAIL",
    );
  });

  test("the honest rows hold zero phantoms and zero orphans (the control)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const clock = createTickClock();
      const ledger = createFakeLedger(clock);
      const lifecycle = createFakeLifecycle({
        ledger,
        ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
      });
      const seam = createFakeSubmissionSeam({ ledger });
      const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
      expect(result.terminal, `${row.rowId}`).toBe("COMPLETED");
      expect(ledger.facts().orphanEventCount).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Ceiling bypass + the over-denying gate
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: ceiling bypass and over-denial", () => {
  test("a bypassed gate (three admitted against the ceiling of two) FAILS the shaping", () => {
    const verdict = deriveCeilingShaping({
      ceiling: 2,
      attempts: [
        { executionId: "a", admitted: true, rejection: null },
        { executionId: "b", admitted: true, rejection: null },
        { executionId: "c", admitted: true, rejection: null },
      ],
    });
    expect(verdict.shapedCorrectly).toBe(false);
  });

  test("an unbounded gate driving the burst row FAILS the shaping criterion honestly", async () => {
    const row = rowById("over-ceiling-burst-shaped");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    // NO ceiling bound on the lifecycle: every lane admits (the bypass).
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria.find((c) => c.criterionId === "ceiling-shaped-admission")?.status).toBe(
      "FAIL",
    );
    // The effect multiplicity catches the over-admission too (three
    // settlements against the expected two).
    expect(
      result.criteria.find((c) => c.criterionId === "row-effect-multiplicity-exactly-once")?.status,
    ).toBe("FAIL");
  });

  test("an over-denying gate (slots never release) FAILS the slot-release shape", async () => {
    const row = rowById("over-ceiling-burst-slot-release");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger, ceiling: row.ceiling, neverRelease: true });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    expect(result.terminal).toBe("FAILED");
    // Wave 2's lane was wrongly denied (the freed slot never admitted it).
    expect(result.executions.filter((e) => e.denial !== null).length).toBe(2);
    expect(result.criteria.find((c) => c.criterionId === "ceiling-shaped-admission")?.status).toBe(
      "FAIL",
    );
  });

  test("an untyped denial never passes the shaping (a generic failure is not load shaping)", () => {
    const verdict = deriveCeilingShaping({
      ceiling: 1,
      attempts: [
        { executionId: "a", admitted: true, rejection: null },
        { executionId: "b", admitted: false, rejection: "PROVIDER_ERROR" },
      ],
    });
    expect(verdict.typedDenials).toBe(false);
    expect(verdict.shapedCorrectly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialized fan-out (head-of-line blocking)
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: serialized fan-out", () => {
  test("disjoint windows (strictly sequential driving) FAIL the overlap criterion", () => {
    const verdict = deriveFanoutParallelism(
      [
        { executionId: "a", startedAt: 0, endedAt: 10 },
        { executionId: "b", startedAt: 10, endedAt: 20 },
        { executionId: "c", startedAt: 20, endedAt: 30 },
      ],
      { minConcurrent: 2 },
    );
    expect(verdict.maxConcurrent).toBe(1);
    expect(verdict.overlapped).toBe(false);
  });

  test("a boundary-touching handoff is SEQUENTIAL, not concurrent", () => {
    const verdict = deriveFanoutParallelism(
      [
        { executionId: "a", startedAt: 0, endedAt: 10 },
        { executionId: "b", startedAt: 10, endedAt: 20 },
      ],
      { minConcurrent: 2 },
    );
    expect(verdict.overlapped).toBe(false);
  });

  test("contiguous per-execution journals never interleave (the serialized shape)", () => {
    const verdict = deriveJournalInterleaving([
      { executionId: "a", ordinal: 1 },
      { executionId: "a", ordinal: 2 },
      { executionId: "a", ordinal: 3 },
      { executionId: "b", ordinal: 1 },
      { executionId: "b", ordinal: 2 },
    ]);
    expect(verdict.interleaved).toBe(false);
    expect(verdict.straddles).toBe(0);
  });

  test("the honest concurrent driver produces overlap AND straddles (the control)", async () => {
    const row = rowById("distinct-key-fanout-parallel");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    expect(result.terminal).toBe("COMPLETED");
    expect(
      result.criteria.find((c) => c.criterionId === "fanout-no-head-of-line-blocking")?.status,
    ).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The re-arbitrated replay key (the soak discipline)
// ---------------------------------------------------------------------------

describe("VAL-025 discrimination: the re-arbitrated replay key", () => {
  test("a soak round whose replay probe created a second execution FAILS the invariants", () => {
    const verdict = deriveSoakInvariants({
      rounds: [
        {
          round: 1,
          executionsCreated: 2,
          idempotencyRecords: 2,
          attempts: 3,
          journaledAttempts: 3,
          raceConverged: true,
          replayProbe: { replayed: false, newExecutions: 1, newIdempotencyRecords: 1 },
        },
      ],
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.keysNeverArbitratingSecondTransition).toBe(false);
    expect(verdict.offendingRounds).toEqual([1]);
  });

  test("a non-replayed probe (a typed rejection instead of the replay) FAILS too", () => {
    const verdict = deriveSoakInvariants({
      rounds: [
        {
          round: 1,
          executionsCreated: 1,
          idempotencyRecords: 1,
          attempts: 3,
          journaledAttempts: 3,
          raceConverged: true,
          replayProbe: { replayed: false, newExecutions: 0, newIdempotencyRecords: 0 },
        },
      ],
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.keysNeverArbitratingSecondTransition).toBe(false);
  });

  test("the honest soak rounds never re-arbitrate (the control)", async () => {
    const row = rowById("soak-rounds-invariants");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const result = await driveRowOverStack({ row, lifecycle, seam, ledger });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "soak-invariants-per-round")?.status).toBe(
      "PASS",
    );
  });
});
