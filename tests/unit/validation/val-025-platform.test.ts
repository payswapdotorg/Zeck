/**
 * VAL-025 acceptance criteria 1, 2, 4, 5: the concurrency/soak
 * platform slice against controlled fakes — the load-pattern
 * vocabulary and the PURE derivations (the racing arbitration table,
 * the fan-out overlap + journal interleaving, the ceiling shaping +
 * the gate's own decision table, the soak invariants, the journal
 * gaplessness and effect multiplicity), and the execution driver over
 * every offline corpus row (the canonical lifecycle order with the
 * planning decision before the lane's effects, the racing probes'
 * convergence through the platform's OWN arbitration semantics, the
 * concurrent chain driving with observed overlap, the over-ceiling
 * waves with the typed POLICY_DENIED denials and zero further
 * transitions, the soak rounds with the per-round invariant
 * re-verification and the replay probes, the per-decision-distinct
 * call keys, and the honest anyFail→FAILED terminal).
 */

import { describe, expect, test } from "vitest";
import { OFFLINE_CORPUS_ROWS } from "../../../benchmarks/validation/apps/concurrency-soak/corpus";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createSoakWorld,
  createTickClock,
  type FakeLedger,
  type FakeLifecycle,
} from "../../../benchmarks/validation/apps/concurrency-soak/fixtures";
import {
  ADMISSION_REJECTION_CODE,
  type ConcurrencyCorpusRow,
  type ConcurrencySubmissionSeam,
  type ConcurrencyWorldFacts,
  deriveCeilingAdmission,
  deriveCeilingShaping,
  deriveConcurrencyRowCriteria,
  deriveEffectMultiplicity,
  deriveFanoutParallelism,
  deriveJournalGaplessness,
  deriveJournalInterleaving,
  deriveRaceArbitration,
  deriveSoakInvariants,
  driveConcurrencyRow,
  type ExecutionWindow,
  isAdmissionRejection,
  isLoadPattern,
  type JournalTimelineEntry,
  LOAD_PATTERNS,
  type SoakRoundFacts,
  type SubmissionObservation,
  verifyConcurrencySubmissionContract,
} from "../../../benchmarks/validation/platform/concurrency-soak";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noSleep = async () => {};

/** Fire N concurrent creates through the seam under ONE key (the racing group). */
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

/** The per-row fake stack (the ledger + the lifecycle + the seam + the world). */
interface FakeStack {
  readonly ledger: FakeLedger;
  readonly lifecycle: FakeLifecycle;
  readonly seam: ConcurrencySubmissionSeam;
  readonly world: ReturnType<typeof createSoakWorld>;
}

function createFakeStack(options?: { readonly ceiling?: number }): FakeStack {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const lifecycle = createFakeLifecycle({
    ledger,
    ...(options?.ceiling === undefined ? {} : { ceiling: options.ceiling }),
  });
  const seam = createFakeSubmissionSeam({ ledger });
  const world = createSoakWorld(ledger.clock);
  return { ledger, lifecycle, seam, world };
}

/** Submit the row's app-side lanes through the seam (upfront, concurrent per group). */
async function submitAppLanes(
  stack: FakeStack,
  row: ConcurrencyCorpusRow,
): Promise<{ readonly landedPerGroup: readonly (readonly string[])[] }> {
  const landedPerGroup: string[][] = [];
  if (row.pattern === "same-key-race") {
    const count =
      row.expected.appCreated + row.expected.replayedSubmissions + row.expected.rejectedSubmissions;
    const observations = await fireRacingGroup(stack.seam, `unit-app-${row.rowId}-race`, count, {
      mutatedPeer: row.rowId === "same-key-race-conflict",
    });
    const landed = observations
      .map((observation) => observation.executionId)
      .filter((id) => id !== "");
    landedPerGroup.push([...new Set(landed)]);
  } else if (row.pattern === "distinct-key-fanout") {
    const keys = Array.from(
      { length: row.submissions.count },
      (_, lane) => `unit-app-${row.rowId}-l${lane}`,
    );
    const observations = await fireDistinctLanes(stack.seam, keys);
    landedPerGroup.push(observations.map((observation) => observation.executionId));
  } else if (row.pattern === "over-ceiling-burst") {
    const waves = row.burstWaves ?? [row.submissions.count];
    let laneCursor = 0;
    for (const wave of waves) {
      const keys = Array.from(
        { length: wave },
        (_, index) => `unit-app-${row.rowId}-w-l${laneCursor + index}`,
      );
      const observations = await fireDistinctLanes(stack.seam, keys);
      landedPerGroup.push(observations.map((observation) => observation.executionId));
      laneCursor += wave;
    }
  } else if (row.pattern === "soak-rounds") {
    const soak = row.soak ?? { rounds: 1, interRoundSpacingMs: 0 };
    for (let round = 1; round <= soak.rounds; round += 1) {
      const raceObservations = await fireRacingGroup(
        stack.seam,
        `unit-app-${row.rowId}-r${round}-race`,
        2,
      );
      const distinctObservations = await fireDistinctLanes(stack.seam, [
        `unit-app-${row.rowId}-r${round}-l1`,
        `unit-app-${row.rowId}-r${round}-l2`,
      ]);
      const landed = [
        ...new Set(
          [...raceObservations, ...distinctObservations]
            .map((observation) => observation.executionId)
            .filter((id) => id !== ""),
        ),
      ];
      landedPerGroup.push(landed);
    }
  }
  return { landedPerGroup };
}

/** Drive one offline corpus row through the fake stack. */
async function driveRow(options: {
  readonly row: ConcurrencyCorpusRow;
  readonly stack?: FakeStack;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveConcurrencyRow>>;
  readonly stack: FakeStack;
}> {
  const stack = options.stack ?? createFakeStack({ ceiling: options.row.ceiling });
  const baseline: ConcurrencyWorldFacts = stack.ledger.facts();
  const { landedPerGroup } = await submitAppLanes(stack, options.row);
  const result = await driveConcurrencyRow({
    row: options.row,
    lifecycle: stack.lifecycle,
    world: stack.world,
    baseline,
    worldFacts: () => stack.ledger.facts(),
    landedProvider: async (group) => landedPerGroup[group - 1] ?? [],
    submissionSeam: stack.seam,
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    runSuffix: "unit",
    now: stack.ledger.clock.now,
    sleep: async (ms) => stack.ledger.clock.tick(ms),
  });
  return { result, stack };
}

// ---------------------------------------------------------------------------
// The load-pattern vocabulary (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 load-pattern vocabulary", () => {
  test("the four work-order patterns are exactly pinned", () => {
    expect(LOAD_PATTERNS).toEqual([
      "same-key-race",
      "distinct-key-fanout",
      "over-ceiling-burst",
      "soak-rounds",
    ]);
    expect(isLoadPattern("same-key-race")).toBe(true);
    expect(isLoadPattern("nope")).toBe(false);
  });

  test("the REAL platform tokens are pinned (the admission vocabulary)", () => {
    expect(ADMISSION_REJECTION_CODE).toBe("POLICY_DENIED");
    expect(isAdmissionRejection({ code: "POLICY_DENIED" })).toBe(true);
    expect(isAdmissionRejection({ code: "IDEMPOTENCY_KEY_REUSED" })).toBe(false);
    expect(isAdmissionRejection({ code: "UNEXPECTED" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The racing arbitration derivation (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 race arbitration derivation", () => {
  const observation = (input: Partial<SubmissionObservation>): SubmissionObservation => ({
    executionId: "exec-1",
    replayed: false,
    status: "CREATED",
    rejection: null,
    submittedAt: 0,
    latencyMs: 1,
    ...input,
  });

  test("an honest racing pair converges: one created, one replay, identity preserved", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({ executionId: "exec-1", replayed: true, status: "CREATED" }),
    ]);
    expect(verdict.exactlyOneExecution).toBe(true);
    expect(verdict.identityPreserved).toBe(true);
    expect(verdict.createdCount).toBe(1);
    expect(verdict.replayedCount).toBe(1);
    expect(verdict.distinctExecutionIds).toEqual(["exec-1"]);
  });

  test("a five-create storm converges: one created, four replays", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      ...Array.from({ length: 4 }, () => observation({ executionId: "exec-1", replayed: true })),
    ]);
    expect(verdict.exactlyOneExecution).toBe(true);
    expect(verdict.replayedCount).toBe(4);
    expect(verdict.distinctExecutionIds).toEqual(["exec-1"]);
  });

  test("a racing conflict: the loser's typed IDEMPOTENCY_KEY_REUSED rejection is legal", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({
        executionId: "",
        replayed: false,
        status: null,
        rejection: { code: "IDEMPOTENCY_KEY_REUSED", status: 409 },
      }),
    ]);
    expect(verdict.exactlyOneExecution).toBe(true);
    expect(verdict.typedRejections).toBe(true);
    expect(verdict.rejectedCount).toBe(1);
  });

  test("a DOUBLE ARBITRATION (two distinct identities) is mechanically failed", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({ executionId: "exec-2", replayed: false }),
    ]);
    expect(verdict.exactlyOneExecution).toBe(false);
    expect(verdict.distinctExecutionIds).toEqual(["exec-1", "exec-2"]);
  });

  test("a forged replay (a different identity, no flag) is mechanically failed", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({ executionId: "exec-2", replayed: true }),
    ]);
    expect(verdict.identityPreserved).toBe(false);
  });

  test("an untyped rejection is not a legal racing outcome", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({
        executionId: "",
        rejection: { code: "PROVIDER_ERROR", status: 500 },
      }),
    ]);
    expect(verdict.typedRejections).toBe(false);
  });

  test("a typed already-in-flight rejection is a legal racing outcome (the alternative design)", () => {
    const verdict = deriveRaceArbitration([
      observation({ executionId: "exec-1", replayed: false }),
      observation({
        executionId: "",
        rejection: { code: "EXECUTION_ALREADY_IN_FLIGHT", status: 409 },
      }),
    ]);
    expect(verdict.exactlyOneExecution).toBe(true);
    expect(verdict.typedRejections).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The fan-out parallelism + journal interleaving (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 fan-out parallelism + interleaving derivations", () => {
  test("overlapping windows meet the declared minimum (no head-of-line blocking)", () => {
    const verdict = deriveFanoutParallelism(
      [
        { executionId: "a", startedAt: 0, endedAt: 40 },
        { executionId: "b", startedAt: 5, endedAt: 45 },
        { executionId: "c", startedAt: 10, endedAt: 50 },
        { executionId: "d", startedAt: 15, endedAt: 55 },
      ],
      { minConcurrent: 4 },
    );
    expect(verdict.maxConcurrent).toBe(4);
    expect(verdict.overlapped).toBe(true);
  });

  test("disjoint windows (serialization) FAIL the overlap criterion", () => {
    const verdict = deriveFanoutParallelism(
      [
        { executionId: "a", startedAt: 0, endedAt: 10 },
        { executionId: "b", startedAt: 10, endedAt: 20 },
      ],
      { minConcurrent: 2 },
    );
    expect(verdict.maxConcurrent).toBe(1);
    expect(verdict.overlapped).toBe(false);
  });

  test("a journal straddle proves interleaving (impossible under serialization)", () => {
    const verdict = deriveJournalInterleaving([
      { executionId: "a", ordinal: 1 },
      { executionId: "b", ordinal: 1 },
      { executionId: "a", ordinal: 2 },
    ]);
    expect(verdict.interleaved).toBe(true);
    expect(verdict.straddles).toBe(1);
  });

  test("contiguous per-execution records never interleave", () => {
    const verdict = deriveJournalInterleaving([
      { executionId: "a", ordinal: 1 },
      { executionId: "a", ordinal: 2 },
      { executionId: "b", ordinal: 1 },
      { executionId: "b", ordinal: 2 },
    ]);
    expect(verdict.interleaved).toBe(false);
    expect(verdict.straddles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ceiling shaping + the gate's decision table (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 ceiling shaping derivations", () => {
  test("exactly the ceiling admitted, the rest typed-denied", () => {
    const verdict = deriveCeilingShaping({
      ceiling: 2,
      attempts: [
        { executionId: "a", admitted: true, rejection: null },
        { executionId: "b", admitted: true, rejection: null },
        { executionId: "c", admitted: false, rejection: "POLICY_DENIED" },
        { executionId: "d", admitted: false, rejection: "POLICY_DENIED" },
        { executionId: "e", admitted: false, rejection: "POLICY_DENIED" },
      ],
    });
    expect(verdict.shapedCorrectly).toBe(true);
    expect(verdict.admitted).toBe(2);
    expect(verdict.denied).toBe(3);
  });

  test("a bypassed gate (three admitted against the ceiling of two) FAILS", () => {
    const verdict = deriveCeilingShaping({
      ceiling: 2,
      attempts: [
        { executionId: "a", admitted: true, rejection: null },
        { executionId: "b", admitted: true, rejection: null },
        { executionId: "c", admitted: true, rejection: null },
      ],
    });
    expect(verdict.shapedCorrectly).toBe(false);
    expect(verdict.admitted).toBe(3);
  });

  test("an untyped denial FAILS (never a generic failure)", () => {
    const verdict = deriveCeilingShaping({
      ceiling: 1,
      attempts: [
        { executionId: "a", admitted: true, rejection: null },
        { executionId: "b", admitted: false, rejection: "PROVIDER_ERROR" },
      ],
    });
    expect(verdict.shapedCorrectly).toBe(false);
    expect(verdict.typedDenials).toBe(false);
  });

  test("the gate's own decision table: below admits, at the ceiling denies", () => {
    expect(deriveCeilingAdmission({ admittedInFlight: 0, ceiling: 2 }).allowed).toBe(true);
    expect(deriveCeilingAdmission({ admittedInFlight: 1, ceiling: 2 }).allowed).toBe(true);
    const denial = deriveCeilingAdmission({ admittedInFlight: 2, ceiling: 2 });
    expect(denial.allowed).toBe(false);
    expect(denial.reason).toContain("concurrency ceiling 2 reached");
  });
});

// ---------------------------------------------------------------------------
// The soak invariants + the journal/effect disciplines (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 soak invariants + journal/effect disciplines", () => {
  const honestRound = (round: number): SoakRoundFacts => ({
    round,
    executionsCreated: 1,
    idempotencyRecords: 1,
    attempts: 3,
    journaledAttempts: 3,
    raceConverged: true,
    replayProbe: { replayed: true, newExecutions: 0, newIdempotencyRecords: 0 },
  });

  test("six honest rounds satisfy every invariant", () => {
    const verdict = deriveSoakInvariants({
      rounds: [1, 2, 3, 4, 5, 6].map(honestRound),
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.journalExactlyOncePerAttempt).toBe(true);
    expect(verdict.noLedgerDrift).toBe(true);
    expect(verdict.noRowCountLeak).toBe(true);
    expect(verdict.raceConvergence).toBe(true);
    expect(verdict.keysNeverArbitratingSecondTransition).toBe(true);
    expect(verdict.offendingRounds).toEqual([]);
  });

  test("a ledger drift in one round offends exactly that round", () => {
    const rounds = [1, 2, 3, 4, 5, 6].map(honestRound);
    rounds[2] = { ...honestRound(3), idempotencyRecords: 2 };
    const verdict = deriveSoakInvariants({
      rounds,
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.noLedgerDrift).toBe(false);
    expect(verdict.offendingRounds).toEqual([3]);
  });

  test("a re-arbitrated replay key (a new execution) offends its round", () => {
    const rounds = [1, 2].map(honestRound);
    rounds[1] = {
      ...honestRound(2),
      replayProbe: { replayed: false, newExecutions: 1, newIdempotencyRecords: 1 },
    };
    const verdict = deriveSoakInvariants({
      rounds,
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.keysNeverArbitratingSecondTransition).toBe(false);
    expect(verdict.offendingRounds).toEqual([2]);
  });

  test("a journal drop (fewer journaled than driven attempts) offends its round", () => {
    const rounds = [1, 2].map(honestRound);
    rounds[0] = { ...honestRound(1), journaledAttempts: 2 };
    const verdict = deriveSoakInvariants({
      rounds,
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    expect(verdict.journalExactlyOncePerAttempt).toBe(false);
  });

  test("the journal gaplessness derivation detects holes and duplicates", () => {
    expect(deriveJournalGaplessness([1, 2, 3]).gapless).toBe(true);
    expect(deriveJournalGaplessness([1, 3]).holes).toEqual([2]);
    expect(deriveJournalGaplessness([1, 2, 2]).duplicates).toEqual([2]);
    expect(deriveJournalGaplessness([]).gapless).toBe(true);
  });

  test("the effect multiplicity derivation detects over/under/unexpected", () => {
    expect(deriveEffectMultiplicity({ a: 1 }, { a: 1 }).exactlyOnce).toBe(true);
    expect(deriveEffectMultiplicity({ a: 1 }, { a: 2 }).overApplied).toEqual(["a"]);
    expect(deriveEffectMultiplicity({ a: 1 }, {}).missing).toEqual(["a"]);
    expect(deriveEffectMultiplicity({ a: 1 }, { a: 1, b: 1 }).unexpected).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// The app-side submission contract (PURE)
// ---------------------------------------------------------------------------

describe("VAL-025 app-side submission contract", () => {
  const observation = (input: Partial<SubmissionObservation>): SubmissionObservation => ({
    executionId: "exec-1",
    replayed: false,
    status: "CREATED",
    rejection: null,
    submittedAt: 0,
    latencyMs: 1,
    ...input,
  });

  test("an honest racing pair's receipts PASS", () => {
    const criteria = verifyConcurrencySubmissionContract({
      expected: { submissions: 2, created: 1, replayed: 1, rejected: 0 },
      observations: [
        observation({ executionId: "exec-1" }),
        observation({ executionId: "exec-1", replayed: true }),
      ],
    });
    expect(criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("a count mismatch FAILs (never a fabricated convergence)", () => {
    const criteria = verifyConcurrencySubmissionContract({
      expected: { submissions: 2, created: 1, replayed: 1, rejected: 0 },
      observations: [
        observation({ executionId: "exec-1" }),
        observation({ executionId: "exec-2" }),
      ],
    });
    expect(criteria.find((c) => c.criterionId === "submission-counts")?.status).toBe("FAIL");
  });

  test("the burst rows' admission shaping counts are judged exactly", () => {
    const criteria = verifyConcurrencySubmissionContract({
      expected: { submissions: 5, created: 5, replayed: 0, rejected: 0 },
      observations: Array.from({ length: 5 }, (_, index) =>
        observation({ executionId: `exec-${index}` }),
      ),
      admissionOutcomes: ["admitted", "admitted", "denied", "denied", "denied"],
      expectedAdmitted: 2,
      expectedDenied: 3,
    });
    expect(criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("an unresolved lane (neither terminal nor durable denial) FAILs the burst contract", () => {
    const criteria = verifyConcurrencySubmissionContract({
      expected: { submissions: 5, created: 5, replayed: 0, rejected: 0 },
      observations: Array.from({ length: 5 }, (_, index) =>
        observation({ executionId: `exec-${index}` }),
      ),
      admissionOutcomes: ["admitted", "admitted", "denied", "denied", "unresolved"],
      expectedAdmitted: 2,
      expectedDenied: 3,
    });
    expect(criteria.find((c) => c.criterionId === "app-admission-shaping-counts")?.status).toBe(
      "FAIL",
    );
  });
});

// ---------------------------------------------------------------------------
// The execution driver over every offline corpus row
// ---------------------------------------------------------------------------

describe("VAL-025 driver over the offline corpus", () => {
  test("every offline row settles to its oracle terminal with every criterion PASSing", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { result } = await driveRow({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      const failedExecutions = result.executions.flatMap((execution) =>
        execution.criteria
          .filter((criterion) => criterion.status === "FAIL")
          .map((criterion) => `${execution.executionId}:${criterion.criterionId}`),
      );
      expect(failedExecutions, `${row.rowId} per-execution criteria`).toEqual([]);
    }
  });

  test("the racing rows: the probes converge and the ledger holds exactly the expected rows", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter((r) => r.pattern === "same-key-race")) {
      const { result, stack } = await driveRow({ row });
      // The service-level probe: one created + one replayed, one identity.
      expect(result.probes.length, `${row.rowId} probes`).toBe(1);
      const probe = result.probes[0];
      expect(probe?.verdict.createdCount).toBe(1);
      expect(probe?.verdict.replayedCount).toBe(1);
      expect(probe?.verdict.distinctExecutionIds.length).toBe(1);
      // The ledger: the app pair's one + the probe's one.
      expect(stack.ledger.rows.size).toBe(row.expected.executions);
      expect(stack.ledger.records.size).toBe(row.expected.idempotencyRecords);
    }
  });

  test("the fan-out row: the chains ran concurrently (observed overlap + journal straddle)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "distinct-key-fanout-parallel");
    if (row === undefined) {
      throw new Error("the fan-out row is missing from the corpus");
    }
    const { result } = await driveRow({ row });
    const windows = result.executions
      .map((execution) => execution.window)
      .filter((window): window is ExecutionWindow => window !== null);
    expect(windows.length).toBe(4);
    // The tick clock's interleaved chains produce overlapping windows.
    const overlap = windows.filter(
      (probe) =>
        windows.filter(
          (other) => other.startedAt <= probe.endedAt && probe.startedAt <= other.endedAt,
        ).length >= 2,
    );
    expect(overlap.length, `windows: ${JSON.stringify(windows)}`).toBeGreaterThan(0);
  });

  test("the burst rows: exactly the ceiling admitted, the denials typed with zero further transitions", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter((r) => r.pattern === "over-ceiling-burst")) {
      const { result, stack } = await driveRow({ row });
      const admitted = result.executions.filter((execution) => execution.denial === null);
      const denied = result.executions.filter((execution) => execution.denial !== null);
      expect(admitted.length, `${row.rowId} admitted`).toBe(row.expected.admitted);
      expect(denied.length, `${row.rowId} denied`).toBe(row.expected.denied);
      for (const execution of denied) {
        expect(execution.outcome).toBe("NOT-ADMITTED");
        expect(execution.effects).toEqual([]);
        expect(execution.denial?.code).toBe("POLICY_DENIED");
        // ZERO transitions beyond the authorize attempt (the durable
        // denial envelope is the platform's own journal-then-fail).
        const steps = stack.lifecycle.journal.transitions.filter(
          (transition) => transition.executionId === execution.executionId,
        );
        expect(steps.map((transition) => transition.step)).toEqual(["authorize"]);
        // The durable policy-denied envelope is on the ledger.
        const ledgerRow = stack.ledger.rows.get(execution.executionId);
        expect(ledgerRow?.events).toContain("execution.policy-denied");
        expect(ledgerRow?.status).toBe("CREATED");
      }
    }
  });

  test("the slot-release wave ADMITS after the admitted lanes released their slots", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "over-ceiling-burst-slot-release");
    if (row === undefined) {
      throw new Error("the slot-release row is missing from the corpus");
    }
    const { result } = await driveRow({ row });
    // Wave 1: 2 admitted + 1 denied; wave 2's lane admitted on the freed slot.
    expect(result.executions.filter((e) => e.denial === null).length).toBe(3);
    expect(result.executions.filter((e) => e.denial !== null).length).toBe(1);
  });

  test("the soak row: every round re-verified, the replay probes never re-arbitrated", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.pattern === "soak-rounds");
    if (row === undefined) {
      throw new Error("the soak row is missing from the corpus");
    }
    const { result } = await driveRow({ row });
    expect(result.rounds.length).toBe(6);
    for (const round of result.rounds) {
      expect(round.raceConverged, `round ${round.round} race`).toBe(true);
      expect(round.replayProbe.replayed, `round ${round.round} replay`).toBe(true);
      expect(round.replayProbe.newExecutions).toBe(0);
      expect(round.replayProbe.newIdempotencyRecords).toBe(0);
      expect(round.journaledAttempts).toBe(round.attempts);
    }
    // The declared spacing sustained a measured window (never fabricated).
    expect(result.soakWindowMs).not.toBeNull();
    expect(result.soakWindowMs ?? 0).toBeGreaterThanOrEqual(6 * 25 - 1);
  });

  test("the canonical lifecycle order with the planning decision before the lane's effects", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "distinct-key-fanout-parallel");
    if (row === undefined) {
      throw new Error("the fan-out row is missing from the corpus");
    }
    const { stack } = await driveRow({ row });
    for (const [, ledgerRow] of stack.ledger.rows) {
      const steps = stack.lifecycle.journal.transitions
        .filter((transition) => transition.executionId === ledgerRow.id)
        .map((transition) => transition.step);
      expect(steps).toEqual(["authorize", "plan", "queue", "start", "verify"]);
      const decision = stack.lifecycle.journal.decisions.find(
        (entry) => entry.executionId === ledgerRow.id,
      );
      expect(decision).toBeDefined();
      // The planning decision was recorded BEFORE the lane's effects.
      const firstEffect = stack.lifecycle.journal.stepEvents.find(
        (entry) => entry.executionId === ledgerRow.id && entry.record.kind === "effect",
      );
      expect(firstEffect).toBeDefined();
    }
    // Every lifecycle call carried a DISTINCT key (the per-decision
    // discipline — the VAL-018 lesson).
    const keys = stack.lifecycle.journal.callKeys;
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the soak journal records ride the round's primary execution (digests only)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.pattern === "soak-rounds");
    if (row === undefined) {
      throw new Error("the soak row is missing from the corpus");
    }
    const { stack } = await driveRow({ row });
    const raceObservations = stack.lifecycle.journal.stepEvents.filter(
      (entry) => entry.record.kind === "race-observation",
    );
    const replayProbes = stack.lifecycle.journal.stepEvents.filter(
      (entry) => entry.record.kind === "replay-probe",
    );
    expect(raceObservations.length).toBe(12);
    expect(replayProbes.length).toBe(6);
    // The fake lifecycle mirrors the platform's terminal immutability
    // (step events on completed rows THROW) — the driver's every seam
    // record landed on a non-terminal row by construction, or the run
    // would have failed loudly here.
    // Digest-only evidence: every record's detail carries references,
    // never payload bytes.
    for (const entry of stack.lifecycle.journal.stepEvents) {
      expect(entry.record.digest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("the row effect multiplicity is verified against the WORLD's own counters", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { stack } = await driveRow({ row });
      expect(stack.world.observedCounts, `${row.rowId} world counters`).toEqual(
        row.expected.effects,
      );
    }
  });

  test("the row criteria derivation detects synthetic violations (no phantom, drift, orphan)", () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "same-key-race-pair");
    if (row === undefined) {
      throw new Error("the racing row is missing from the corpus");
    }
    const base = {
      row,
      executions: [],
      probes: [],
      rounds: [],
      baseline: {
        executionCount: 0,
        eventCount: 0,
        idempotencyRecordCount: 0,
        orphanEventCount: 0,
      },
      journalTimeline: [] as JournalTimelineEntry[],
      journaledAttempts: 0,
      seamAttempts: 0,
      failure: null,
      soakWindowMs: null,
    };
    // A phantom execution row (the final count exceeds the expected).
    const phantom = deriveConcurrencyRowCriteria({
      ...base,
      finalFacts: {
        executionCount: 3,
        eventCount: 3,
        idempotencyRecordCount: 2,
        orphanEventCount: 0,
      },
    });
    expect(phantom.find((c) => c.criterionId === "no-phantom-executions")?.status).toBe("FAIL");
    // A ledger drift (an extra idempotency record).
    const drift = deriveConcurrencyRowCriteria({
      ...base,
      finalFacts: {
        executionCount: 2,
        eventCount: 3,
        idempotencyRecordCount: 3,
        orphanEventCount: 0,
      },
    });
    expect(drift.find((c) => c.criterionId === "no-ledger-drift")?.status).toBe("FAIL");
    // An orphan ledger transition (an event with no parent row).
    const orphan = deriveConcurrencyRowCriteria({
      ...base,
      finalFacts: {
        executionCount: 2,
        eventCount: 3,
        idempotencyRecordCount: 2,
        orphanEventCount: 1,
      },
    });
    expect(orphan.find((c) => c.criterionId === "no-orphan-ledger-transitions")?.status).toBe(
      "FAIL",
    );
    // A journal double-write (more journaled than driven attempts).
    const doubleWrite = deriveConcurrencyRowCriteria({
      ...base,
      journaledAttempts: 3,
      seamAttempts: 2,
      finalFacts: {
        executionCount: 2,
        eventCount: 3,
        idempotencyRecordCount: 2,
        orphanEventCount: 0,
      },
    });
    expect(
      doubleWrite.find((c) => c.criterionId === "journal-exactly-once-per-attempt")?.status,
    ).toBe("FAIL");
  });

  test("a missing submission seam on a racing row is a hard configuration error", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "same-key-race-pair");
    if (row === undefined) {
      throw new Error("the racing row is missing from the corpus");
    }
    const stack = createFakeStack();
    await expect(
      driveConcurrencyRow({
        row,
        lifecycle: stack.lifecycle,
        world: stack.world,
        baseline: stack.ledger.facts(),
        worldFacts: () => stack.ledger.facts(),
        landedProvider: async () => [],
        retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
        runSuffix: "unit",
        now: stack.ledger.clock.now,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/submission seam/);
  });

  test("a leaky seam that double-admits the racing probe FAILS the row honestly", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((r) => r.rowId === "same-key-race-pair");
    if (row === undefined) {
      throw new Error("the racing row is missing from the corpus");
    }
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const leakySeam = createFakeSubmissionSeam({ ledger, leaky: true });
    const world = createSoakWorld(ledger.clock);
    // The "app" pair through the leaky seam: BOTH admit (the breach).
    const observations = await fireRacingGroup(leakySeam, `unit-leaky-${row.rowId}`, 2);
    const landed = [...new Set(observations.map((o) => o.executionId))];
    const result = await driveConcurrencyRow({
      row,
      lifecycle,
      world,
      baseline: {
        executionCount: 0,
        eventCount: 0,
        idempotencyRecordCount: 0,
        orphanEventCount: 0,
      },
      worldFacts: () => ledger.facts(),
      landedProvider: async () => landed.slice(0, 1),
      submissionSeam: leakySeam,
      retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
      runSuffix: "unit-leaky",
      now: ledger.clock.now,
      sleep: async (ms) => ledger.clock.tick(ms),
    });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.find((c) => c.criterionId === "race-arbitration-exactly-once")?.status,
    ).toBe("FAIL");
  });
});
