/**
 * VAL-026 acceptance criterion 6 — discrimination tests proving the
 * outcome-state reconciliation against controlled fakes:
 *
 *   * effect-set mismatch — a declared effect set that disagrees with
 *     what the journal recorded FAILs the declared↔journal leg;
 *   * phantom effects — an undeclared effect landing in the fixture
 *     state FAILs the fixture↔oracle leg (and the multiplicity);
 *   * missing effects — a declared effect that never lands FAILs the
 *     same oracle family symmetrically (the sloppy world);
 *   * journal disagreement — a journal that records an effect the
 *     fixture never landed (or a fixture effect the journal never
 *     recorded) FAILs the journal↔fixture leg, both directions;
 *   * the fabricated pass-with-fail — a controlled lifecycle that
 *     flips a fail verdict into a COMPLETED terminal is mechanically
 *     caught by the terminal↔criteria agreement (the anyFail→FAILED
 *     invariant: a pass-with-fail is unrepresentable), at the
 *     derivation level, at the driver level AND at the app level;
 *   * the re-arbitrated replay key — a leaky seam that mints a second
 *     execution on the replayed key FAILs the replay criterion;
 *   * the honest controls for every family.
 */

import { describe, expect, test } from "vitest";
import {
  OFFLINE_CORPUS_ROWS,
  OUTCOME_CORPUS,
  submissionKey,
  taskBodyFor,
} from "../../benchmarks/validation/apps/outcome-correctness/corpus";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createOutcomeFakeApiWorld,
  createOutcomeFixtureWorld,
  createTickClock,
} from "../../benchmarks/validation/apps/outcome-correctness/fixtures";
import {
  deriveOutcomeReconciliation,
  deriveOutcomeRowCriteria,
  deriveTerminalCriteriaAgreement,
  driveOutcomeRow,
  type OutcomeCorpusRow,
  type OutcomeExecutionFacts,
} from "../../benchmarks/validation/platform/outcome-correctness";

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

/** Drive one row over a purpose-built fake stack (the leaky variants). */
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
  const appKey = submissionKey({ runSuffix: "disc", taskIndex: options.taskIndex });
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
// The honest facts fixture (the reconciliation's control shape)
// ---------------------------------------------------------------------------

const WORKSPACE_ROW = rowById("workspace-tree-completed");

const honestFacts = (overrides?: Partial<OutcomeExecutionFacts>): OutcomeExecutionFacts => ({
  executionId: "exec-1",
  terminal: "COMPLETED",
  verificationStatuses: ["PASS", "PASS", "PASS"],
  journalEffects: WORKSPACE_ROW.declaredEffects.map((effect) => effect.effect),
  fixtureDelta: Object.fromEntries(
    WORKSPACE_ROW.declaredEffects.map((effect) => [effect.effect, 1]),
  ),
  declaredEffects: WORKSPACE_ROW.declaredEffects.map((effect) => effect.effect),
  expectedTerminal: "COMPLETED",
  expectedFixtureDelta: Object.fromEntries(
    WORKSPACE_ROW.declaredEffects.map((effect) => [effect.effect, 1]),
  ),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Effect-set mismatch, phantom effects, missing effects
// ---------------------------------------------------------------------------

describe("VAL-026 discrimination: effect-set mismatch and phantom/missing effects", () => {
  test("a declared effect set mismatch (the journal holds a different set) FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        declaredEffects: [
          "workspace:create-dir",
          "workspace:write-file",
          "workspace:set-perm",
          "workspace:extra-step",
        ],
      }),
    );
    expect(verdict.declaredJournalAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "declared-journal-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("a PHANTOM effect (an undeclared effect lands) FAILs the oracle and the multiplicity", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [...honestFacts().journalEffects, "order:notify"],
        fixtureDelta: {
          ...honestFacts().fixtureDelta,
          "order:notify": 1,
        },
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a MISSING effect (a declared effect never lands) FAILs symmetrically", () => {
    const facts = honestFacts();
    const missing = facts.journalEffects[0] ?? "";
    const remaining = facts.journalEffects.filter((effect) => effect !== missing);
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: remaining,
        fixtureDelta: Object.fromEntries(remaining.map((effect) => [effect, 1])),
      }),
    );
    expect(verdict.fixtureDeltaAgreement).toBe(false);
    expect(verdict.declaredJournalAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a PHANTOM effect driven through the sloppy world FAILs the row honestly", async () => {
    const result = await driveRowOverStack({
      row: WORKSPACE_ROW,
      taskIndex: taskIndexOf(WORKSPACE_ROW.rowId),
      phantom: "order:notify",
    });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "fixture-delta-oracle")?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "journal-fixture-agreement")
        ?.status,
    ).toBe("FAIL");
    // The phantom effect is visible in the observed delta.
    expect(result.fixtureDelta["order:notify"]).toBe(1);
  });

  test("a MISSING effect driven through the sloppy world FAILs the row honestly", async () => {
    const result = await driveRowOverStack({
      row: WORKSPACE_ROW,
      taskIndex: taskIndexOf(WORKSPACE_ROW.rowId),
      dropStaged: "workspace:write-file",
    });
    expect(result.terminal).toBe("FAILED");
    // The declared effect never landed: the fixture↔oracle leg, the
    // declared↔journal leg and the multiplicity all catch it (the
    // sloppy world is honest about WHAT it committed — the journal
    // and the fixture agree with each other, but not with the oracle).
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "fixture-delta-oracle")?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "declared-journal-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "effect-multiplicity-exactly-once",
      )?.status,
    ).toBe("FAIL");
    expect(result.fixtureDelta["workspace:write-file"]).toBeUndefined();
  });

  test("the honest rows hold the exact declared deltas (the control)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const result = await driveRowOverStack({ row, taskIndex });
      expect(result.terminal, `${row.rowId}`).toBe(row.expected.terminal);
      expect(result.fixtureDelta).toEqual(row.expected.fixtureDelta);
    }
  });
});

// ---------------------------------------------------------------------------
// Journal disagreement (the journal ↔ fixture leg, both directions)
// ---------------------------------------------------------------------------

describe("VAL-026 discrimination: journal disagreement", () => {
  test("a journal record for an effect that never landed FAILs", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: [...honestFacts().journalEffects, "workspace:write-file"],
      }),
    );
    expect(verdict.journalFixtureAgreement).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "journal-fixture-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("a fixture effect the journal never recorded FAILs", () => {
    const facts = honestFacts();
    const unjournaled = facts.journalEffects[1] ?? "";
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        journalEffects: facts.journalEffects.filter((effect) => effect !== unjournaled),
      }),
    );
    expect(verdict.journalFixtureAgreement).toBe(false);
  });

  test("a FAILED row whose journal records effects FAILs (the empty-journal oracle)", () => {
    const verdict = deriveOutcomeReconciliation(
      honestFacts({
        terminal: "FAILED",
        verificationStatuses: ["FAIL", "PASS"],
        fixtureDelta: {},
        expectedTerminal: "FAILED",
        expectedFixtureDelta: {},
      }),
    );
    // The journal still holds the effects while the fixture delta is
    // empty and the terminal is FAILED — the journal tells a story the
    // world contradicts (the journal↔fixture and declared↔journal legs
    // both FAIL; the empty delta itself satisfies the oracle).
    expect(verdict.journalFixtureAgreement).toBe(false);
    expect(verdict.declaredJournalAgreement).toBe(false);
    expect(verdict.fixtureDeltaAgreement).toBe(true);
    expect(verdict.agreed).toBe(false);
  });

  test("the honest journals match the fixture exactly (the control)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const result = await driveRowOverStack({ row, taskIndex });
      expect(
        result.criteria.find((criterion) => criterion.criterionId === "journal-fixture-agreement")
          ?.status,
        `${row.rowId}`,
      ).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// The fabricated pass-with-fail (the anyFail→FAILED adversarial probe)
// ---------------------------------------------------------------------------

describe("VAL-026 discrimination: the fabricated pass-with-fail (anyFail→FAILED)", () => {
  test("the derivation catches the fabricated mix (COMPLETED + a FAIL criterion)", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "FAIL"],
    });
    expect(verdict.agreement).toBe(false);
    const reconciliation = deriveOutcomeReconciliation(
      honestFacts({ verificationStatuses: ["PASS", "FAIL", "PASS"] }),
    );
    expect(reconciliation.terminalCriteriaAgreement).toBe(false);
    expect(reconciliation.agreed).toBe(false);
  });

  test("the reverse fabrication (FAILED + all-PASS) is caught too", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(verdict.agreement).toBe(false);
  });

  test("a FABRICATING lifecycle (fail flipped to COMPLETED) FAILs the row honestly", async () => {
    for (const rowId of [
      "guard-rejected-zero-effects",
      "mid-work-rollback-zero-effects",
      "criterion-fail-any-fail-failed",
    ]) {
      const row = rowById(rowId);
      const result = await driveRowOverStack({
        row,
        taskIndex: taskIndexOf(rowId),
        fabricatePassWithFail: true,
      });
      // The platform's durable claim is COMPLETED; the criteria hold a
      // FAIL — the row's honest terminal is FAILED (the fabrication
      // NEVER passes).
      expect(result.execution?.observedTerminal, `${rowId} fabricated terminal`).toBe("COMPLETED");
      expect(result.terminal, `${rowId} honest row terminal`).toBe("FAILED");
      expect(
        result.criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")
          ?.status,
      ).toBe("FAIL");
    }
  });

  test("the FABRICATED pass-with-fail surfaced through the PUBLIC wire FAILs the app", async () => {
    const clock = createTickClock();
    const world = createOutcomeFakeApiWorld({ clock, fabricatePassWithFail: true });
    const { runOutcomeApp } = await import(
      "../../benchmarks/validation/apps/outcome-correctness/application"
    );
    const outcome = await runOutcomeApp({
      config: {
        applicationId: "app-1",
        baseUrl: "http://fake-zeck.local",
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: "rev",
        corpusRevision: "rev",
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
        configuration: { suite: "val-026-discrimination" },
      },
      runSuffix: "disc",
      taskIndex: taskIndexOf("guard-rejected-zero-effects"),
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(false);
    expect(
      outcome.outcomeCriteria.find(
        (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
      )?.status,
    ).toBe("FAIL");
  });

  test("the honest rows never fabricate (the control)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const result = await driveRowOverStack({ row, taskIndex });
      expect(result.execution?.observedTerminal).toBe(row.expected.terminal);
      expect(
        result.criteria.find((criterion) => criterion.criterionId === "terminal-criteria-agreement")
          ?.status,
        `${row.rowId}`,
      ).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// The re-arbitrated replay key (the idempotency discrimination)
// ---------------------------------------------------------------------------

describe("VAL-026 discrimination: the re-arbitrated replay key", () => {
  test("a leaky seam that re-arbitrates the replayed key FAILs the row", async () => {
    const row = rowById("replay-idempotent-zero-new-effects");
    const result = await driveRowOverStack({
      row,
      taskIndex: taskIndexOf(row.rowId),
      leakyReplay: true,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.replayProbe?.replayed).toBe(false);
    expect(result.replayProbe?.sameIdentity).toBe(false);
    expect(result.replayProbe?.newExecutions).toBe(1);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "replay-zero-new-effects")
        ?.status,
    ).toBe("FAIL");
    // The re-arbitration also left a phantom durable row.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "no-phantom-executions")
        ?.status,
    ).toBe("FAIL");
  });

  test("a replay probe that did not replay FAILs too", () => {
    // Fabricated probe facts through the row-level criteria (the
    // derivation-level catch — the PURE derivation is exercised
    // directly with an honest control shape and a fabricated probe).
    const row = rowById("replay-idempotent-zero-new-effects");
    const criteria = deriveOutcomeRowCriteria({
      row,
      execution: {
        executionId: "exec-1",
        outcome: "COMPLETED",
        observedTerminal: "COMPLETED",
        criteria: [
          {
            criterionId: "guard-admission",
            strategy: "deterministic",
            status: "PASS",
            evidence: [],
          },
        ],
        journalEffects: row.declaredEffects.map((effect) => effect.effect),
        journal: [],
        committedEffects: row.declaredEffects,
        discardedEffects: [],
        usage: null,
      },
      replayProbe: {
        replayed: false,
        sameIdentity: false,
        newExecutions: 0,
        newIdempotencyRecords: 0,
        newEffects: 0,
        keyDigest: "00000000",
      },
      baseline: {
        executionCount: 0,
        eventCount: 0,
        idempotencyRecordCount: 0,
        orphanEventCount: 0,
      },
      finalFacts: {
        executionCount: 1,
        eventCount: 5,
        idempotencyRecordCount: 1,
        orphanEventCount: 0,
      },
      fixtureDelta: Object.fromEntries(row.declaredEffects.map((effect) => [effect.effect, 1])),
      failure: null,
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "replay-zero-new-effects")?.status,
    ).toBe("FAIL");
  });

  test("the honest replays never re-arbitrate (the control)", async () => {
    for (const rowId of [
      "replay-idempotent-zero-new-effects",
      "replay-after-failure-zero-new-effects",
    ]) {
      const result = await driveRowOverStack({
        row: rowById(rowId),
        taskIndex: taskIndexOf(rowId),
      });
      expect(result.terminal).toBe(rowById(rowId).expected.terminal);
      expect(
        result.criteria.find((criterion) => criterion.criterionId === "replay-zero-new-effects")
          ?.status,
      ).toBe("PASS");
    }
  });
});
