/**
 * VAL-026 acceptance criteria 1, 2, 4, 5: the outcome-correctness
 * platform slice against controlled fakes — the outcome vocabulary and
 * the PURE derivations (the budget-guard admission table, the
 * terminal↔criteria agreement — the anyFail→FAILED invariant probed in
 * BOTH directions, the outcome reconciliation chain with every leg,
 * the effect multiplicity and the journal gaplessness, the digest
 * discipline and the fixture-delta diff), and the execution driver
 * over every offline corpus row (the canonical lifecycle order with
 * the planning decision before the effects, the guard preceding any
 * staging, the ATOMIC commit/discard boundary — a FAILED execution
 * commits ZERO effects, the replay probes' zero-new-everything, the
 * per-decision-distinct call keys, and the honest anyFail→FAILED
 * terminal — including the ADVERSARIAL fabricating lifecycle whose
 * pass-with-fail the driver must catch honestly).
 */

import { describe, expect, test } from "vitest";
import {
  OFFLINE_CORPUS_ROWS,
  OUTCOME_CORPUS,
  submissionKey,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/outcome-correctness/corpus";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createOutcomeFixtureWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/outcome-correctness/fixtures";
import {
  declaredFixtureDigestOf,
  deriveEffectMultiplicity,
  deriveGuardAdmission,
  deriveJournalGaplessness,
  deriveOutcomeReconciliation,
  deriveOutcomeRowCriteria,
  deriveTerminalCriteriaAgreement,
  driveOutcomeRow,
  FAILURE_KINDS,
  fixtureDeltaOf,
  isFailureKind,
  isReplayProbe,
  isRetryableDispatchCategory,
  type OutcomeCorpusRow,
  type OutcomeExecutionFacts,
  type OutcomeExecutionResult,
  observedFixtureDigestOf,
  outcomeDigestOf,
  REPLAY_PROBES,
} from "../../../benchmarks/validation/platform/outcome-correctness";

const noSleep = async () => {};

const rowById = (rowId: string): OutcomeCorpusRow => {
  const row = OUTCOME_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = OUTCOME_CORPUS.findIndex((candidate) => candidate.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** Drive one row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: OutcomeCorpusRow;
  readonly taskIndex: number;
  readonly fabricatePassWithFail?: boolean;
  readonly leakyReplay?: boolean;
  readonly dropStaged?: string;
  readonly phantom?: string;
}): Promise<ReturnType<typeof driveOutcomeRow>> {
  const { row } = options;
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const lifecycle = createFakeLifecycle({
    ledger,
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const seam = createFakeSubmissionSeam({
    ledger,
    ...(options.leakyReplay === undefined ? {} : { leakyReplay: options.leakyReplay }),
  });
  const world = createOutcomeFixtureWorld({
    clock,
    ...(row.failure?.atEffect === undefined ? {} : { frozenEffects: [row.failure.atEffect] }),
    ...(options.dropStaged === undefined ? {} : { dropStaged: options.dropStaged }),
    ...(options.phantom === undefined ? {} : { phantom: options.phantom }),
  });
  const appKey = submissionKey({ runSuffix: "unit", taskIndex: options.taskIndex });
  const appBody = taskBodyFor({ rowId: row.rowId, quotaMicro: row.quotaMicro });
  const baseline = ledger.facts();
  const submitted = await seam({ key: appKey, body: appBody });
  const landed = submitted.rejection === null ? [submitted.executionId] : [];
  return driveOutcomeRow({
    row,
    lifecycle,
    world,
    baseline,
    worldFacts: () => ledger.facts(),
    landedProvider: async () => landed,
    submissionSeam: seam,
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    appKey,
    appBody,
    now: clock.now,
  });
}

// ---------------------------------------------------------------------------
// The vocabulary + the tokens
// ---------------------------------------------------------------------------

describe("VAL-026 platform vocabulary", () => {
  test("the failure vocabulary is pinned (three deterministic shapes)", () => {
    expect(FAILURE_KINDS).toEqual([
      "pre-effect-guard",
      "mid-work-effect-rejection",
      "verification-criterion-fail",
    ]);
    for (const kind of FAILURE_KINDS) {
      expect(isFailureKind(kind)).toBe(true);
    }
    expect(isFailureKind("fabricated")).toBe(false);
  });

  test("the replay vocabulary is pinned (after completion / after failure)", () => {
    expect(REPLAY_PROBES).toEqual(["after-completion", "after-failure"]);
    expect(isReplayProbe("after-completion")).toBe(true);
    expect(isReplayProbe("after-failure")).toBe(true);
    expect(isReplayProbe("after-lunch")).toBe(false);
  });

  test("the retry taxonomy is honest (only the declared categories retry)", () => {
    expect(isRetryableDispatchCategory("transport-failure")).toBe(true);
    expect(isRetryableDispatchCategory("rate-limit")).toBe(true);
    expect(isRetryableDispatchCategory("provider-unavailable")).toBe(true);
    expect(isRetryableDispatchCategory("supervisor-halt")).toBe(false);
    expect(isRetryableDispatchCategory("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The budget-guard admission (PURE)
// ---------------------------------------------------------------------------

describe("VAL-026 deriveGuardAdmission", () => {
  test("a covering quota admits the declared demand", () => {
    const verdict = deriveGuardAdmission({
      quotaMicro: 10_000,
      effects: [
        { effect: "workspace:create-dir", kind: "workspace", key: "WS", amountMicro: 4_000 },
      ],
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.demandedMicro).toBe(4_000);
  });

  test("an insufficient quota rejects BEFORE any effect stages", () => {
    const verdict = deriveGuardAdmission({
      quotaMicro: 4_400,
      effects: [
        { effect: "order:reserve", kind: "order", key: "ORD", amountMicro: 8_800 },
        { effect: "order:charge", kind: "order", key: "ORD", amountMicro: 8_800 },
      ],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("quota guard rejected");
    expect(verdict.demandedMicro).toBe(17_600);
  });

  test("an exactly-covering quota admits (the boundary is inclusive)", () => {
    const verdict = deriveGuardAdmission({
      quotaMicro: 4_000,
      effects: [{ effect: "ticket:route", kind: "ticket", key: "TCK", amountMicro: 4_000 }],
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The terminal↔criteria agreement (the anyFail→FAILED invariant)
// ---------------------------------------------------------------------------

describe("VAL-026 deriveTerminalCriteriaAgreement (the anyFail→FAILED invariant)", () => {
  test("an honest COMPLETED (all criteria PASS) agrees", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS", "PASS"],
    });
    expect(verdict.agreement).toBe(true);
  });

  test("an honest FAILED (the failure criterion FAILs visibly) agrees", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "FAILED",
      verificationStatuses: ["FAIL", "PASS"],
    });
    expect(verdict.agreement).toBe(true);
  });

  test("a FABRICATED pass-with-fail (COMPLETED + a FAIL criterion) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "FAIL", "PASS"],
    });
    expect(verdict.agreement).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("fabricated");
  });

  test("a FABRICATED fail-with-all-pass (FAILED + no FAIL criterion) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(verdict.agreement).toBe(false);
  });

  test("a missing terminal (a run that never settled) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: null,
      verificationStatuses: ["PASS"],
    });
    expect(verdict.agreement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The outcome reconciliation (the full chain, every leg)
// ---------------------------------------------------------------------------

describe("VAL-026 deriveOutcomeReconciliation", () => {
  const declared = ["workspace:create-dir", "workspace:write-file"];

  const honestFacts = (overrides?: Partial<OutcomeExecutionFacts>): OutcomeExecutionFacts => ({
    executionId: "exec-1",
    terminal: "COMPLETED",
    verificationStatuses: ["PASS", "PASS", "PASS"],
    journalEffects: declared,
    fixtureDelta: { "workspace:create-dir": 1, "workspace:write-file": 1 },
    declaredEffects: declared,
    expectedTerminal: "COMPLETED",
    expectedFixtureDelta: { "workspace:create-dir": 1, "workspace:write-file": 1 },
    ...overrides,
  });

  test("an honest COMPLETED row agrees on EVERY leg", () => {
    const verdict = deriveOutcomeReconciliation(honestFacts());
    expect(verdict.agreed).toBe(true);
    expect(verdict.terminalCriteriaAgreement).toBe(true);
    expect(verdict.journalFixtureAgreement).toBe(true);
    expect(verdict.declaredJournalAgreement).toBe(true);
    expect(verdict.fixtureDeltaAgreement).toBe(true);
    expect(verdict.terminalAgreement).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an honest FAILED row agrees on every leg (EMPTY delta, EMPTY journal)", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        terminal: "FAILED",
        verificationStatuses: ["FAIL", "PASS"],
        journalEffects: [],
        fixtureDelta: {},
        expectedTerminal: "FAILED",
        expectedFixtureDelta: {},
      }),
    );
    expect(verdict.agreed).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the adversarial pass-with-fail FAILs the terminal↔criteria leg (unrepresentable)", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({ verificationStatuses: ["PASS", "FAIL", "PASS"] }),
    );
    expect(verdict.terminalCriteriaAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("a journal disagreement (an effect the fixture never landed) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [...declared, "order:charge"],
      }),
    );
    expect(verdict.journalFixtureAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a journal disagreement (a fixture effect the journal never recorded) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [declared[0] ?? ""],
      }),
    );
    expect(verdict.journalFixtureAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("an effect-set mismatch (the declared set ≠ the journal) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        declaredEffects: ["workspace:create-dir", "workspace:write-file", "workspace:set-perm"],
      }),
    );
    expect(verdict.declaredJournalAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a MISSING effect (the delta under-counts) FAILs the fixture oracle", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [declared[0] ?? ""],
        fixtureDelta: { "workspace:create-dir": 1 },
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
  });

  test("a PHANTOM effect (the delta over-counts an undeclared effect) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [...declared, "order:notify"],
        fixtureDelta: { "workspace:create-dir": 1, "workspace:write-file": 1, "order:notify": 1 },
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
    expect(verdict.declaredJournalAgreement).toBe(false);
  });

  test("an OVER-APPLIED effect (double application) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [...declared, declared[0] ?? ""],
        fixtureDelta: { "workspace:create-dir": 2, "workspace:write-file": 1 },
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
    expect(verdict.journalFixtureAgreement).toBe(true);
  });

  test("a FAILED row whose delta is NOT empty FAILs (the atomicity oracle)", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        terminal: "FAILED",
        verificationStatuses: ["FAIL", "PASS"],
        journalEffects: declared,
        fixtureDelta: { "workspace:create-dir": 1, "workspace:write-file": 1 },
        expectedTerminal: "FAILED",
        expectedFixtureDelta: {},
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("an unexpected terminal (COMPLETED observed, FAILED expected) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(honestFacts({ terminal: "FAILED" }));
    expect(verdict.terminalAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The multiplicity / gaplessness / digest derivations
// ---------------------------------------------------------------------------

describe("VAL-026 multiplicity, gaplessness and digests", () => {
  test("the effect multiplicity catches over, under and unexpected", () => {
    expect(deriveEffectMultiplicity({ a: 1 }, { a: 1 }).exactlyOnce).toBe(true);
    expect(deriveEffectMultiplicity({ a: 1 }, { a: 2 }).overApplied).toEqual(["a"]);
    expect(deriveEffectMultiplicity({ a: 1 }, {}).missing).toEqual(["a"]);
    expect(deriveEffectMultiplicity({ a: 1 }, { b: 1 }).unexpected).toEqual(["b"]);
  });

  test("the journal gaplessness catches holes and duplicates", () => {
    expect(deriveJournalGaplessness([1, 2, 3]).gapless).toBe(true);
    expect(deriveJournalGaplessness([1, 3]).holes).toEqual([2]);
    expect(deriveJournalGaplessness([1, 2, 2]).duplicates).toEqual([2]);
    expect(deriveJournalGaplessness([]).gapless).toBe(true);
  });

  test("the digest discipline is deterministic and payload-free", () => {
    const effects = [
      { effect: "order:charge", kind: "order" as const, key: "ORD-201", amountMicro: 12_500 },
    ];
    expect(outcomeDigestOf(effects)).toBe(outcomeDigestOf(effects));
    expect(outcomeDigestOf(effects)).not.toBe(outcomeDigestOf([]));
    expect(outcomeDigestOf(effects)).toMatch(/^[0-9a-f]{8}$/);
    expect(declaredFixtureDigestOf(effects)).toBe(observedFixtureDigestOf(effects));
    // The digest never leaks the payload bytes.
    expect(outcomeDigestOf(effects)).not.toContain("ORD-201");
  });

  test("the fixture-delta diff is exact (additions, removals, no zero noise)", () => {
    expect(fixtureDeltaOf({}, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(fixtureDeltaOf({ a: 1 }, { a: 1 })).toEqual({});
    expect(fixtureDeltaOf({ a: 1 }, {})).toEqual({ a: -1 });
    expect(fixtureDeltaOf({ a: 2 }, { a: 3 })).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row
// ---------------------------------------------------------------------------

describe("VAL-026 driver over the honest offline corpus", () => {
  test("every offline row reaches its oracle terminal with every row criterion PASS", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const result = await driveRowOverStack({ row, taskIndex });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.execution?.observedTerminal).toBe(row.expected.terminal);
    }
  });

  test("COMPLETED rows commit EXACTLY the declared effect set (the fixture oracle)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      if (row.expected.terminal !== "COMPLETED") {
        continue;
      }
      const result = await driveRowOverStack({ row, taskIndex });
      expect(result.fixtureDelta).toEqual(row.expected.fixtureDelta);
      expect(result.execution?.committedEffects.map((effect) => effect.effect)).toEqual(
        row.declaredEffects.map((effect) => effect.effect),
      );
    }
  });

  test("FAILED rows land ZERO effects (the EMPTY fixture delta — the atomicity)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      if (row.expected.terminal !== "FAILED") {
        continue;
      }
      const result = await driveRowOverStack({ row, taskIndex });
      expect(result.fixtureDelta, `${row.rowId} delta`).toEqual({});
      expect(result.execution?.committedEffects).toEqual([]);
    }
  });

  test("the guard-rejected row fails BEFORE any staging (zero discarded effects)", async () => {
    const result = await driveRowOverStack({
      row: rowById("guard-rejected-zero-effects"),
      taskIndex: taskIndexOf("guard-rejected-zero-effects"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.execution?.discardedEffects).toEqual([]);
    expect(
      result.execution?.criteria.find((criterion) => criterion.criterionId === "guard-admission")
        ?.status,
    ).toBe("FAIL");
  });

  test("the mid-work row stages-then-DISCARDS (the atomicity evidence)", async () => {
    const result = await driveRowOverStack({
      row: rowById("mid-work-rollback-zero-effects"),
      taskIndex: taskIndexOf("mid-work-rollback-zero-effects"),
    });
    expect(result.terminal).toBe("FAILED");
    // The first effect staged, then the frozen second rejected — the
    // staged set was discarded atomically (never a partial commit).
    expect(result.execution?.discardedEffects.map((effect) => effect.effect)).toEqual([
      "order:reserve",
    ]);
    expect(result.fixtureDelta).toEqual({});
  });

  test("the criterion-fail row: ONE failed criterion forces FAILED and zero committed effects", async () => {
    const result = await driveRowOverStack({
      row: rowById("criterion-fail-any-fail-failed"),
      taskIndex: taskIndexOf("criterion-fail-any-fail-failed"),
    });
    expect(result.terminal).toBe("FAILED");
    // The declared-digest criterion is the one that FAILs (the mutated
    // expectation) — everything else staged cleanly.
    const digest = result.execution?.criteria.find(
      (criterion) => criterion.criterionId === "declared-digest-agreement",
    );
    expect(digest?.status).toBe("FAIL");
    expect(
      result.execution?.criteria.find((c) => c.criterionId === "guard-admission")?.status,
    ).toBe("PASS");
    expect(
      result.execution?.criteria.find((c) => c.criterionId === "declared-effects-staged")?.status,
    ).toBe("PASS");
    // The staged effects were discarded — the atomicity of the
    // verification boundary.
    expect(result.fixtureDelta).toEqual({});
    expect(result.execution?.discardedEffects.length).toBe(2);
  });

  test("the replay rows: replayed, identity preserved, ZERO new everything", async () => {
    for (const rowId of [
      "replay-idempotent-zero-new-effects",
      "replay-after-failure-zero-new-effects",
    ]) {
      const result = await driveRowOverStack({
        row: rowById(rowId),
        taskIndex: taskIndexOf(rowId),
      });
      expect(result.terminal, `${rowId} terminal`).toBe(rowById(rowId).expected.terminal);
      expect(result.replayProbe?.replayed).toBe(true);
      expect(result.replayProbe?.sameIdentity).toBe(true);
      expect(result.replayProbe?.newExecutions).toBe(0);
      expect(result.replayProbe?.newIdempotencyRecords).toBe(0);
      expect(result.replayProbe?.newEffects).toBe(0);
    }
  });

  test("the per-decision-distinct call-key discipline holds (canonical order, planning before effects)", async () => {
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const seam = createFakeSubmissionSeam({ ledger });
    const world = createOutcomeFixtureWorld({ clock });
    const row = rowById("workspace-tree-completed");
    const appKey = submissionKey({ runSuffix: "keys", taskIndex: 0 });
    const appBody = taskBodyFor({ rowId: row.rowId, quotaMicro: row.quotaMicro });
    const submitted = await seam({ key: appKey, body: appBody });
    await driveOutcomeRow({
      row,
      lifecycle,
      world,
      baseline: ledger.facts(),
      worldFacts: () => ledger.facts(),
      landedProvider: async () => [submitted.executionId],
      submissionSeam: seam,
      retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
      appKey,
      appBody,
      now: clock.now,
    });
    const callKeys = lifecycle.journal.callKeys;
    expect(new Set(callKeys).size).toBe(callKeys.length);
    // The canonical order: authorize, plan, queue, start, verify (the
    // planning decision recorded between plan and the effects).
    expect(lifecycle.journal.transitions.map((entry) => entry.step)).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
    ]);
    // The planning decision was recorded BEFORE the first effect
    // record (the driver's own discipline).
    const decisionIndex = lifecycle.journal.decisions.length;
    expect(decisionIndex).toBe(1);
    const effectRecords = lifecycle.journal.stepEvents.filter(
      (entry) => entry.record.kind === "effect",
    );
    expect(effectRecords.length).toBe(3);
  });

  test("the journaled effect records carry DIGESTS only (never payload bytes)", async () => {
    const result = await driveRowOverStack({
      row: rowById("order-placement-completed"),
      taskIndex: taskIndexOf("order-placement-completed"),
    });
    for (const record of result.execution?.journal ?? []) {
      expect(record.digest).toMatch(/^[0-9a-f]{8}$/);
      expect(record.detail).not.toContain("12_500");
    }
    // The COMPLETED row journals EXACTLY the committed effects; the
    // FAILED row journals ONE failure record.
    expect(result.execution?.journal.filter((record) => record.kind === "effect").length).toBe(3);
  });

  test("the FAILED rows journal ONE honest failure record and ZERO effect records", async () => {
    for (const rowId of [
      "guard-rejected-zero-effects",
      "mid-work-rollback-zero-effects",
      "criterion-fail-any-fail-failed",
    ]) {
      const result = await driveRowOverStack({
        row: rowById(rowId),
        taskIndex: taskIndexOf(rowId),
      });
      expect(result.execution?.journal.filter((record) => record.kind === "effect")).toEqual([]);
      expect(result.execution?.journal.filter((record) => record.kind === "failure").length).toBe(
        1,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The configuration guards
// ---------------------------------------------------------------------------

describe("VAL-026 driver configuration guards", () => {
  test("a replay row without a submission seam is a configuration error", async () => {
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const world = createOutcomeFixtureWorld({ clock });
    const row = rowById("replay-idempotent-zero-new-effects");
    await expect(
      driveOutcomeRow({
        row,
        lifecycle,
        world,
        baseline: ledger.facts(),
        worldFacts: () => ledger.facts(),
        landedProvider: async () => [],
        retry: { maxExtraAttempts: 0, backoffMs: 1, sleep: noSleep },
        appKey: "k",
        appBody: {},
        now: clock.now,
      }),
    ).rejects.toThrow("demands a submission seam");
  });

  test("a dispatch row without a dispatch seam is a configuration error", async () => {
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const world = createOutcomeFixtureWorld({ clock });
    const row = OUTCOME_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    await expect(
      driveOutcomeRow({
        row: row as OutcomeCorpusRow,
        lifecycle,
        world,
        baseline: ledger.facts(),
        worldFacts: () => ledger.facts(),
        landedProvider: async () => [],
        submissionSeam: createFakeSubmissionSeam({ ledger }),
        retry: { maxExtraAttempts: 0, backoffMs: 1, sleep: noSleep },
        appKey: "k",
        appBody: {},
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
  });

  test("a landed-count mismatch is an honest row failure (never a silent pass)", async () => {
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const world = createOutcomeFixtureWorld({ clock });
    const row = rowById("workspace-tree-completed");
    const result = await driveOutcomeRow({
      row,
      lifecycle,
      world,
      baseline: ledger.facts(),
      worldFacts: () => ledger.facts(),
      landedProvider: async () => [],
      submissionSeam: createFakeSubmissionSeam({ ledger }),
      retry: { maxExtraAttempts: 0, backoffMs: 1, sleep: noSleep },
      appKey: "k",
      appBody: {},
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("landed-count-mismatch");
  });
});

// ---------------------------------------------------------------------------
// The adversarial anyFail→FAILED probe (the fabricating lifecycle)
// ---------------------------------------------------------------------------

describe("VAL-026 adversarial anyFail→FAILED probe (the fabricating lifecycle)", () => {
  test("a FABRICATED pass-with-fail (the lifecycle flips fail→COMPLETED) FAILs the row honestly", async () => {
    const row = rowById("criterion-fail-any-fail-failed");
    const result = await driveRowOverStack({
      row,
      taskIndex: taskIndexOf(row.rowId),
      fabricatePassWithFail: true,
    });
    // The fabricated platform claims COMPLETED; the criteria hold a
    // FAIL — the reconciliation catches the disagreement and the row's
    // honest terminal is FAILED (never a fabricated pass).
    expect(result.execution?.observedTerminal).toBe("COMPLETED");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the guard-rejected row under the fabricating lifecycle is caught the same way", async () => {
    const row = rowById("guard-rejected-zero-effects");
    const result = await driveRowOverStack({
      row,
      taskIndex: taskIndexOf(row.rowId),
      fabricatePassWithFail: true,
    });
    expect(result.execution?.observedTerminal).toBe("COMPLETED");
    expect(result.terminal).toBe("FAILED");
    // The fabrication surfaces as BOTH a terminal↔criteria disagreement
    // AND an observed-terminal oracle disagreement.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "terminal-oracle-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("an honest COMPLETED row under the fabricating lifecycle is unaffected (the control)", async () => {
    const row = rowById("workspace-tree-completed");
    const result = await driveRowOverStack({
      row,
      taskIndex: taskIndexOf(row.rowId),
      fabricatePassWithFail: true,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The synthetic-violation derivation (fabricated facts through the
// row-level criteria)
// ---------------------------------------------------------------------------

describe("VAL-026 synthetic violations through deriveOutcomeRowCriteria", () => {
  const row = rowById("workspace-tree-completed");

  const baseExecution = (): OutcomeExecutionResult => ({
    executionId: "exec-1",
    outcome: "COMPLETED",
    observedTerminal: "COMPLETED",
    criteria: [
      { criterionId: "guard-admission", strategy: "deterministic", status: "PASS", evidence: [] },
      {
        criterionId: "declared-effects-staged",
        strategy: "deterministic",
        status: "PASS",
        evidence: [],
      },
      {
        criterionId: "declared-digest-agreement",
        strategy: "deterministic",
        status: "PASS",
        evidence: [],
      },
      { criterionId: "outcome-contract", strategy: "deterministic", status: "PASS", evidence: [] },
      {
        criterionId: "atomicity-of-effects",
        strategy: "deterministic",
        status: "PASS",
        evidence: [],
      },
      { criterionId: "journal-gapless", strategy: "deterministic", status: "PASS", evidence: [] },
    ],
    journalEffects: row.declaredEffects.map((effect) => effect.effect),
    journal: [],
    committedEffects: row.declaredEffects,
    discardedEffects: [],
    usage: null,
  });

  const baseInput = (execution: OutcomeExecutionResult) => ({
    row,
    execution,
    replayProbe: null,
    baseline: { executionCount: 0, eventCount: 0, idempotencyRecordCount: 0, orphanEventCount: 0 },
    finalFacts: {
      executionCount: 1,
      eventCount: 7,
      idempotencyRecordCount: 1,
      orphanEventCount: 0,
    },
    fixtureDelta: Object.fromEntries(row.declaredEffects.map((effect) => [effect.effect, 1])),
    failure: null,
  });

  test("the honest shape passes every row criterion", () => {
    const criteria = deriveOutcomeRowCriteria(baseInput(baseExecution()));
    expect(criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("a fabricated pass-with-fail execution FAILs the row criteria", () => {
    const execution = baseExecution();
    const fabricated = {
      ...execution,
      criteria: execution.criteria.map((criterion, index) =>
        index === 0 ? { ...criterion, status: "FAIL" as const } : criterion,
      ),
    };
    const criteria = deriveOutcomeRowCriteria(baseInput(fabricated));
    expect(
      criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")?.status,
    ).toBe("FAIL");
    expect(
      criteria.find((criterion) => criterion.criterionId === "outcome-reconciliation-summary")
        ?.status,
    ).toBe("FAIL");
  });

  test("a phantom execution row (an extra durable row) FAILs", () => {
    const criteria = deriveOutcomeRowCriteria({
      ...baseInput(baseExecution()),
      finalFacts: {
        executionCount: 2,
        eventCount: 7,
        idempotencyRecordCount: 1,
        orphanEventCount: 0,
      },
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "no-phantom-executions")?.status,
    ).toBe("FAIL");
  });

  test("an orphan ledger transition FAILs", () => {
    const criteria = deriveOutcomeRowCriteria({
      ...baseInput(baseExecution()),
      finalFacts: {
        executionCount: 1,
        eventCount: 7,
        idempotencyRecordCount: 1,
        orphanEventCount: 1,
      },
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "no-orphan-ledger-transitions")
        ?.status,
    ).toBe("FAIL");
  });

  test("ledger drift (an extra key) FAILs", () => {
    const criteria = deriveOutcomeRowCriteria({
      ...baseInput(baseExecution()),
      finalFacts: {
        executionCount: 1,
        eventCount: 7,
        idempotencyRecordCount: 2,
        orphanEventCount: 0,
      },
    });
    expect(criteria.find((criterion) => criterion.criterionId === "no-ledger-drift")?.status).toBe(
      "FAIL",
    );
  });

  test("a replay probe that re-arbitrated the key FAILs", () => {
    const criteria = deriveOutcomeRowCriteria({
      ...baseInput(baseExecution()),
      row: rowById("replay-idempotent-zero-new-effects"),
      replayProbe: {
        replayed: true,
        sameIdentity: false,
        newExecutions: 1,
        newIdempotencyRecords: 0,
        newEffects: 0,
        keyDigest: "00000000",
      },
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "replay-zero-new-effects")?.status,
    ).toBe("FAIL");
  });
});
