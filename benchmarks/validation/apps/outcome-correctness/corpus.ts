/**
 * The outcome-correctness corpus (VAL-026, AC1): the declared rows of
 * the outcome-state application. Per row: the expected terminal, the
 * declared effect set (in declaration order — the staging order and
 * the digest's input), the declared budget-guard input, the declared
 * verification expectation (the expected fixture digest) and the
 * expected fixture-state delta — including the EMPTY delta for FAILED
 * rows (a failed execution's declared effects must NOT have been
 * applied — the atomicity of the verification boundary is a
 * first-class oracle expectation, pinned as the literal empty record).
 *
 * The effect families are the fixture-state oracle pattern proven
 * across the crowns: workspace trees, order placements, ticket
 * routings, citation attachments.
 *
 * Every offline row is deterministically reproducible (the outcome
 * semantics are ledger-level — no provider is needed; the guard, the
 * frozen targets and the declared digests are all
 * repository-reproducible constants); the live row is env-gated on the
 * operator-authorized rail and demands a REAL model confirmation round
 * where the effects demand one.
 */

import {
  declaredFixtureDigestOf,
  type OutcomeCorpusRow,
  type OutcomeEffectSpec,
} from "../../platform/outcome-correctness";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const OUTCOME_TASK_KIND = "outcome-correctness.effect.v1";

// ---------------------------------------------------------------------------
// The effect builders (the corpus's declared work)
// ---------------------------------------------------------------------------

function workspace(effect: string, key: string, amountMicro: number): OutcomeEffectSpec {
  return { effect: `workspace:${effect}`, kind: "workspace", key, amountMicro };
}

function order(effect: string, key: string, amountMicro: number): OutcomeEffectSpec {
  return { effect: `order:${effect}`, kind: "order", key, amountMicro };
}

function ticket(effect: string, key: string, amountMicro: number): OutcomeEffectSpec {
  return { effect: `ticket:${effect}`, kind: "ticket", key, amountMicro };
}

function citation(effect: string, key: string, amountMicro: number): OutcomeEffectSpec {
  return { effect: `citation:${effect}`, kind: "citation", key, amountMicro };
}

// ---------------------------------------------------------------------------
// The declared effect sets (the fixture-state oracle's targets)
// ---------------------------------------------------------------------------

/** The workspace-tree row's declared effects (the tree oracle). */
const WORKSPACE_TREE_EFFECTS: readonly OutcomeEffectSpec[] = [
  workspace("create-dir", "WS-101/tree", 2_000),
  workspace("write-file", "WS-101/tree/README.md", 1_500),
  workspace("set-perm", "WS-101/tree", 500),
];

/** The replay row's declared effects (the idempotency oracle). */
const WORKSPACE_REPLAY_EFFECTS: readonly OutcomeEffectSpec[] = [
  workspace("create-dir", "WS-801/tree", 2_000),
  workspace("write-file", "WS-801/tree/NOTES.md", 1_000),
];

/** The order-placement row's declared effects (the settlement oracle). */
const ORDER_PLACEMENT_EFFECTS: readonly OutcomeEffectSpec[] = [
  order("reserve", "ORD-201", 12_500),
  order("charge", "ORD-201", 12_500),
  order("notify", "ORD-201", 0),
];

/** The ticket-routing row's declared effects (the routing oracle). */
const TICKET_ROUTING_EFFECTS: readonly OutcomeEffectSpec[] = [
  ticket("route", "TCK-301", 3_300),
  ticket("close", "TCK-301", 1_100),
];

/** The citation-attachment row's declared effects (the citation oracle). */
const CITATION_EFFECTS: readonly OutcomeEffectSpec[] = [
  citation("attach", "CIT-401", 900),
  citation("index", "CIT-401", 600),
];

/** The guard-rejected row's declared effects (the precondition oracle). */
const GUARD_REJECTED_EFFECTS: readonly OutcomeEffectSpec[] = [
  order("reserve", "ORD-501", 8_800),
  order("charge", "ORD-501", 8_800),
  order("notify", "ORD-501", 0),
];

/** The mid-work-rollback row's declared effects (the frozen-target oracle). */
const MID_WORK_EFFECTS: readonly OutcomeEffectSpec[] = [
  order("reserve", "ORD-601", 7_700),
  order("charge", "ORD-601", 7_700),
  order("notify", "ORD-601", 0),
];

/** The criterion-fail row's declared effects (the anyFail oracle). */
const CITATION_CRITERION_FAIL_EFFECTS: readonly OutcomeEffectSpec[] = [
  citation("attach", "CIT-701", 2_200),
  citation("index", "CIT-701", 1_100),
];

/**
 * The criterion-fail row's DELIBERATELY WRONG declared expectation: the
 * digest of a MUTATED effect set (the attach amount differs) —
 * deterministic, repository-reproducible, never a random mismatch.
 */
const MUTATED_EXPECTATION_EFFECTS: readonly OutcomeEffectSpec[] = [
  citation("attach", "CIT-701", 2_400),
  citation("index", "CIT-701", 1_100),
];

/** The replay-after-failure row's declared effects. */
const REPLAY_FAILURE_EFFECTS: readonly OutcomeEffectSpec[] = [
  order("reserve", "ORD-901", 9_900),
  order("charge", "ORD-901", 9_900),
];

/** The live row's declared effects (the REAL-confirmation oracle). */
const LIVE_EFFECTS: readonly OutcomeEffectSpec[] = [
  order("settle", "LIVE-1001", 21_000),
  order("notify", "LIVE-1001", 0),
];

/** The delta oracle for a healthy effect set (every effect exactly once). */
function exactlyOnce(effects: readonly OutcomeEffectSpec[]): Record<string, number> {
  return Object.fromEntries(effects.map((effect) => [effect.effect, 1]));
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly OutcomeCorpusRow[] = [
  {
    rowId: "workspace-tree-completed",
    description:
      "A workspace-tree outcome row: the execution's work declares a three-effect workspace tree (create-dir, write-file, set-perm) — the budget guard admits the work, every declared effect stages and commits exactly once, the verification criteria all PASS and the fixture state holds EXACTLY the declared delta. The declared digest agrees with the staged outcome.",
    declaredEffects: WORKSPACE_TREE_EFFECTS,
    quotaMicro: 10_000,
    expectedFixtureDigest: declaredFixtureDigestOf(WORKSPACE_TREE_EFFECTS),
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(WORKSPACE_TREE_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "order-placement-completed",
    description:
      "An order-placement outcome row: the execution's work declares a three-effect settlement (reserve, charge, notify) against one order — the guard admits (the quota covers the demand), the settlement commits atomically, the fixture state holds the three effects exactly once and the terminal is COMPLETED with every criterion PASS.",
    declaredEffects: ORDER_PLACEMENT_EFFECTS,
    quotaMicro: 30_000,
    expectedFixtureDigest: declaredFixtureDigestOf(ORDER_PLACEMENT_EFFECTS),
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(ORDER_PLACEMENT_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "ticket-routing-completed",
    description:
      "A ticket-routing outcome row: the execution's work declares a two-effect routing (route, close) — admitted, committed exactly once, the fixture delta exactly the declared set, COMPLETED with every criterion PASS.",
    declaredEffects: TICKET_ROUTING_EFFECTS,
    quotaMicro: 10_000,
    expectedFixtureDigest: declaredFixtureDigestOf(TICKET_ROUTING_EFFECTS),
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(TICKET_ROUTING_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "citation-attachment-completed",
    description:
      "A citation-attachment outcome row: the execution's work declares a two-effect citation (attach, index) — admitted, committed exactly once, the fixture delta exactly the declared set, COMPLETED with every criterion PASS.",
    declaredEffects: CITATION_EFFECTS,
    quotaMicro: 5_000,
    expectedFixtureDigest: declaredFixtureDigestOf(CITATION_EFFECTS),
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(CITATION_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "guard-rejected-zero-effects",
    description:
      "A FAILED outcome row (the precondition shape): the declared quota (4_400 micro-USD) does NOT cover the declared effect demand (17_600 micro-USD) — the budget guard rejects the work BEFORE a single effect is staged, the execution FAILS honestly (the guard criterion records the honest FAIL) and the fixture-state delta is EMPTY: the declared effects must NOT have been applied.",
    declaredEffects: GUARD_REJECTED_EFFECTS,
    quotaMicro: 4_400,
    expectedFixtureDigest: declaredFixtureDigestOf(GUARD_REJECTED_EFFECTS),
    failure: { kind: "pre-effect-guard" },
    needsDispatch: false,
    expected: {
      terminal: "FAILED",
      // the EMPTY delta: a failed execution's declared effects must NOT
      // have been applied (the atomicity of the verification boundary).
      fixtureDelta: {},
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "mid-work-rollback-zero-effects",
    description:
      "A FAILED outcome row (the partial-failure shape): the work is admitted and the FIRST effect stages, but the fixture world rejects the SECOND declared effect (a frozen target — order:charge against ORD-601) mid-sequence — the staged effects are DISCARDED atomically, the execution FAILS and the fixture-state delta is EMPTY (the atomicity of the verification boundary: a partial application is unrepresentable).",
    declaredEffects: MID_WORK_EFFECTS,
    quotaMicro: 30_000,
    expectedFixtureDigest: declaredFixtureDigestOf(MID_WORK_EFFECTS),
    failure: { kind: "mid-work-effect-rejection", atEffect: "order:charge" },
    needsDispatch: false,
    expected: {
      terminal: "FAILED",
      fixtureDelta: {},
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "criterion-fail-any-fail-failed",
    description:
      "A FAILED outcome row (the anyFail→FAILED shape in its purest form): every effect stages cleanly and the guard admits, but the row's DECLARED verification expectation — the expected fixture digest — deliberately disagrees with the staged outcome (a mutated expectation): ONE criterion FAILs, so the verdict is fail, the staged effects are DISCARDED and the fixture-state delta is EMPTY. A pass-with-fail is unrepresentable: any failed criterion forces FAILED and zero committed effects.",
    declaredEffects: CITATION_CRITERION_FAIL_EFFECTS,
    quotaMicro: 5_000,
    // The deliberately WRONG declared expectation (see
    // MUTATED_EXPECTATION_EFFECTS above): ONE criterion will FAIL, so
    // the verdict is fail and the staged effects are discarded.
    expectedFixtureDigest: declaredFixtureDigestOf(MUTATED_EXPECTATION_EFFECTS),
    failure: { kind: "verification-criterion-fail" },
    needsDispatch: false,
    expected: {
      terminal: "FAILED",
      fixtureDelta: {},
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "replay-idempotent-zero-new-effects",
    description:
      "A replay outcome row (the idempotency discipline): the work completes and commits its two workspace effects, then the app's submission key is RE-ISSUED after completion — the idempotency ledger REPLAYS the committed outcome (identity preserved, the replayed flag surfaced), the durable ledger holds ZERO new executions and ZERO new records, and the fixture state shows ZERO new effects (the committed delta stays exactly-once).",
    declaredEffects: WORKSPACE_REPLAY_EFFECTS,
    quotaMicro: 10_000,
    expectedFixtureDigest: declaredFixtureDigestOf(WORKSPACE_REPLAY_EFFECTS),
    replay: { after: "after-completion" },
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(WORKSPACE_REPLAY_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "replay-after-failure-zero-new-effects",
    description:
      "A replay outcome row over a FAILED execution (the atomicity persists across replays): the quota guard rejects the work (FAILED, EMPTY delta), then the app's submission key is RE-ISSUED — the ledger replays the DURABLE FAILED receipt (identity preserved, replayed flag, terminal FAILED again), and the fixture state still shows ZERO effects (a replay never re-drives failed work, never re-applies discarded effects).",
    declaredEffects: REPLAY_FAILURE_EFFECTS,
    quotaMicro: 4_000,
    expectedFixtureDigest: declaredFixtureDigestOf(REPLAY_FAILURE_EFFECTS),
    failure: { kind: "pre-effect-guard" },
    replay: { after: "after-failure" },
    needsDispatch: false,
    expected: {
      terminal: "FAILED",
      fixtureDelta: {},
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatch). */
export const LIVE_CORPUS_ROWS: readonly OutcomeCorpusRow[] = [
  {
    rowId: "live-confirmation-then-effects",
    description:
      "A REAL outcome row (env-gated): the execution's work demands ONE REAL model confirmation round through the REAL platform model gateway BEFORE any effect is staged — the supervisor confirms, the two declared effects commit exactly once, and the measured usage rides the evidence (usage measured, never estimated).",
    declaredEffects: LIVE_EFFECTS,
    quotaMicro: 50_000,
    expectedFixtureDigest: declaredFixtureDigestOf(LIVE_EFFECTS),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the REAL confirmation round demands a REAL model dispatch",
    },
    expected: {
      terminal: "COMPLETED",
      fixtureDelta: exactlyOnce(LIVE_EFFECTS),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const OUTCOME_CORPUS: readonly OutcomeCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: OutcomeCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one row's submission. The replay probe
 * re-issues EXACTLY this key (the same body) — the ledger must replay.
 */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-026-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission (the request
 * fingerprint's driver). The replay submission carries the IDENTICAL
 * body — a different fingerprint under the same key would be a
 * conflict, never a replay.
 */
export function taskBodyFor(options: {
  readonly rowId: string;
  readonly quotaMicro: number;
}): Record<string, unknown> {
  return {
    kind: OUTCOME_TASK_KIND,
    rowId: options.rowId,
    quotaMicro: options.quotaMicro,
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const OUTCOME_ROW_IDS: readonly string[] = OUTCOME_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function outcomeRowById(rowId: string): OutcomeCorpusRow | null {
  return OUTCOME_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
