/**
 * The concurrency/soak corpus (VAL-025, AC1): the declared rows of the
 * concurrency application. Per row: the submission pattern (same-key
 * race / distinct-key fan-out / over-ceiling burst / soak rounds), the
 * submission contract (the per-group lane count, the key discipline,
 * the app-side created/replayed/rejected expectations), the admission
 * shaping contract (the burst rows' declared ceiling + waves), the
 * soak window declaration (the rounds + the inter-round spacing) and
 * the expected durable state (executions, idempotency records, ledger
 * transitions, effect multiplicity) after the pattern settles.
 *
 * Every offline row is deterministically reproducible (the racing
 * semantics are ledger-level — no provider is needed; the arbitration
 * winner is the platform's choice, never pinned by identity); the live
 * rows are env-gated on the operator-authorized rail and demand REAL
 * model dispatches where the concurrency-under-real-dispatch proof
 * requires them.
 *
 * The pinned policies: the declared admission ceiling is TWO admitted
 * executions in flight; the soak window is SIX rounds with a 25 ms
 * inter-round spacing (a compact, honestly-sustainable window — the
 * elapsed window is MEASURED at run time, never fabricated).
 */

import type { ConcurrencyCorpusRow, SoakEffectSpec } from "../../platform/concurrency-soak";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const CONCURRENCY_TASK_KIND = "concurrency-soak.settlement.v1";

/** The probe task kind the driver's racing/replay probes carry. */
export const CONCURRENCY_PROBE_KIND = "concurrency-soak.probe.v1";

/** The pinned declared admission ceiling (the load-shaping contract). */
export const CORPUS_CEILING = 2;

/** The pinned soak policy: six rounds, 25 ms inter-round spacing. */
export const CORPUS_SOAK_POLICY = {
  rounds: 6,
  interRoundSpacingMs: 25,
  distinctLanesPerRound: 2,
} as const;

/** The pinned bounded dispatch-retry budget the live rows assume. */
export const CORPUS_RETRY_POLICY = {
  maxExtraAttempts: 2,
} as const;

// ---------------------------------------------------------------------------
// The effect builders (the corpus's declared work)
// ---------------------------------------------------------------------------

function settle(effectId: string, key: string, amountMicro: number): SoakEffectSpec {
  return { effect: `settle:${effectId}`, kind: "settle", key, amountMicro };
}

function notify(effectId: string, key: string): SoakEffectSpec {
  return { effect: `notify:${effectId}`, kind: "notify", key, amountMicro: 0 };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly ConcurrencyCorpusRow[] = [
  {
    rowId: "same-key-race-pair",
    pattern: "same-key-race",
    description:
      "A same-key racing PAIR (two submissions in flight simultaneously under ONE idempotency key): the ledger's transactional arbitration admits exactly ONE — the loser waits on the unique index and then replays the winner's committed outcome (identity preserved, the replayed flag surfaced) — never two executions. The driver's service-level probe re-drives the racing pair through the REAL arbitration authority; the ledger's row-count delta proves the app-side pair converged too.",
    submissions: { count: 1, sameKey: true },
    needsDispatch: false,
    laneEffects: (lane) => [settle(`RACE-101-L${lane}`, `RACE-101-L${lane}`, 12_500)],
    expected: {
      terminal: "COMPLETED",
      // the app's racing pair's ONE durable execution + the probe pair's ONE.
      executions: 2,
      idempotencyRecords: 2,
      effects: { "settle:RACE-101-L0": 1, "settle:RACE-101-L1": 1 },
      appCreated: 1,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "same-key-race-storm",
    pattern: "same-key-race",
    description:
      "A same-key racing STORM (five submissions in flight simultaneously under ONE idempotency key): the ledger converges the whole storm — one created, four replays of the winner's committed outcome — ONE durable execution, ONE idempotency record, the settlement applied exactly once across the storm.",
    submissions: { count: 1, sameKey: true },
    needsDispatch: false,
    laneEffects: (lane) => [settle(`RACE-102-L${lane}`, `RACE-102-L${lane}`, 15_000)],
    expected: {
      terminal: "COMPLETED",
      executions: 2,
      idempotencyRecords: 2,
      effects: { "settle:RACE-102-L0": 1, "settle:RACE-102-L1": 1 },
      appCreated: 1,
      replayedSubmissions: 4,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "same-key-race-conflict",
    pattern: "same-key-race",
    description:
      "A same-key racing CONFLICT (two concurrent submissions under ONE key with DIFFERENT task bodies): the ledger admits whichever submission's insert wins and typed-rejects the loser with the REAL 409 IDEMPOTENCY_KEY_REUSED — exactly one durable execution; the loser's effect NEVER lands.",
    submissions: { count: 1, sameKey: true },
    needsDispatch: false,
    laneEffects: (lane) => [settle(`RACE-103-L${lane}`, `RACE-103-L${lane}`, 8_800)],
    expected: {
      terminal: "COMPLETED",
      executions: 2,
      idempotencyRecords: 2,
      effects: { "settle:RACE-103-L0": 1, "settle:RACE-103-L1": 1 },
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 1,
    },
  },
  {
    rowId: "distinct-key-fanout-parallel",
    pattern: "distinct-key-fanout",
    description:
      "A distinct-key fan-out (four independent submissions in flight simultaneously): every lane proceeds concurrently WITHOUT head-of-line blocking — the observed processing windows overlap (or the shared journal interleaves: one execution's records straddle another's) — and every lane's settlement applies exactly once.",
    submissions: { count: 4, sameKey: false },
    needsDispatch: false,
    laneEffects: (lane) => [
      settle(`FAN-201-L${lane}`, `FAN-201-L${lane}`, 9_900),
      ...(lane === 3 ? [notify(`FAN-201-L${lane}`, `FAN-201-L${lane}`)] : []),
    ],
    expected: {
      terminal: "COMPLETED",
      executions: 4,
      idempotencyRecords: 4,
      effects: {
        "settle:FAN-201-L0": 1,
        "settle:FAN-201-L1": 1,
        "settle:FAN-201-L2": 1,
        "settle:FAN-201-L3": 1,
        "notify:FAN-201-L3": 1,
      },
      appCreated: 4,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      maxConcurrent: 2,
    },
  },
  {
    rowId: "over-ceiling-burst-shaped",
    pattern: "over-ceiling-burst",
    description:
      "An over-ceiling burst (five distinct-key submissions in flight simultaneously against the declared ceiling of TWO): the admission gate admits exactly two — the other three receive the platform's typed POLICY_DENIED admission rejection (the REAL throttled/queue-full vocabulary) with the durable execution.policy-denied envelope, the execution STAYS CREATED (dispatch remains impossible) and ZERO effects land on the denied lanes.",
    submissions: { count: 5, sameKey: false },
    burstWaves: [5],
    ceiling: CORPUS_CEILING,
    needsDispatch: false,
    laneEffects: () => [settle("BURST-301", "BURST-301", 7_700)],
    expected: {
      terminal: "COMPLETED",
      // all five lanes create durable rows; two are admitted.
      executions: 5,
      idempotencyRecords: 5,
      effects: { "settle:BURST-301": 2 },
      appCreated: 5,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      admitted: 2,
      denied: 3,
    },
  },
  {
    rowId: "over-ceiling-burst-slot-release",
    pattern: "over-ceiling-burst",
    description:
      "The slot-release burst (the ceiling is load SHAPING, never a permanent denial): wave one submits three lanes against the ceiling of two — two admit, one is typed-denied; the admitted lanes settle (their slots release); wave two's single submission then ADMITS on the freed slot. Exactly three admissions, one typed denial, zero effects on the denied lane.",
    submissions: { count: 3, sameKey: false },
    burstWaves: [3, 1],
    ceiling: CORPUS_CEILING,
    needsDispatch: false,
    laneEffects: () => [settle("BURST-401", "BURST-401", 6_600)],
    expected: {
      terminal: "COMPLETED",
      executions: 4,
      idempotencyRecords: 4,
      effects: { "settle:BURST-401": 3 },
      appCreated: 4,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      admitted: 3,
      denied: 1,
    },
  },
  {
    rowId: "soak-rounds-invariants",
    pattern: "soak-rounds",
    description:
      "The endurance/soak row (six repeated submission rounds over a declared sustained window — 25 ms inter-round spacing, the elapsed window MEASURED): every round drives a same-key racing pair plus two distinct lanes concurrently; after EVERY round the durable invariants are re-verified (journal exactly-once-per-attempt, no ledger drift, no row-count leak, the round's racing probe converged) and the round's probe key is re-issued (the replay — the key never arbitrates a second transition).",
    submissions: { count: 3, sameKey: true },
    soak: {
      rounds: CORPUS_SOAK_POLICY.rounds,
      interRoundSpacingMs: CORPUS_SOAK_POLICY.interRoundSpacingMs,
    },
    needsDispatch: false,
    laneEffects: (lane, round) => [
      settle(`SOAK-R${round}-L${lane}`, `SOAK-R${round}-L${lane}`, 2_200 + lane * 100),
      ...(lane === 2 ? [notify(`SOAK-R${round}-L${lane}`, `SOAK-R${round}-L${lane}`)] : []),
    ],
    expected: {
      terminal: "COMPLETED",
      // per round: the app's three lanes + the driver's probe lane.
      executions: CORPUS_SOAK_POLICY.rounds * 4,
      idempotencyRecords: CORPUS_SOAK_POLICY.rounds * 4,
      effects: Object.fromEntries(
        Array.from(
          { length: CORPUS_SOAK_POLICY.rounds },
          (_, roundIndex) => roundIndex + 1,
        ).flatMap((round) => [
          [`settle:SOAK-R${round}-L0`, 1],
          [`settle:SOAK-R${round}-L1`, 1],
          [`settle:SOAK-R${round}-L2`, 1],
          [`notify:SOAK-R${round}-L2`, 1],
          [`settle:SOAK-R${round}-L3`, 1],
        ]),
      ),
      appCreated: CORPUS_SOAK_POLICY.rounds * 3,
      replayedSubmissions: CORPUS_SOAK_POLICY.rounds,
      rejectedSubmissions: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatches)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatches). */
export const LIVE_CORPUS_ROWS: readonly ConcurrencyCorpusRow[] = [
  {
    rowId: "live-fanout-real-dispatch",
    pattern: "distinct-key-fanout",
    description:
      "A REAL distinct-key fan-out (env-gated): three independent lanes driven CONCURRENTLY, each with ONE REAL model confirmation round through the REAL platform model gateway — the dispatches ride the platform concurrently without interference, the observed windows overlap, and every lane's settlement applies exactly once (usage measured, never estimated).",
    submissions: { count: 3, sameKey: false },
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the concurrent REAL confirmation rounds demand REAL model dispatches",
    },
    laneEffects: (lane) => [settle(`LIVE-FAN-501-L${lane}`, `LIVE-FAN-501-L${lane}`, 21_000)],
    expected: {
      terminal: "COMPLETED",
      executions: 3,
      idempotencyRecords: 3,
      effects: {
        "settle:LIVE-FAN-501-L0": 1,
        "settle:LIVE-FAN-501-L1": 1,
        "settle:LIVE-FAN-501-L2": 1,
      },
      appCreated: 3,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      maxConcurrent: 2,
    },
  },
  {
    rowId: "live-race-after-real-dispatch",
    pattern: "same-key-race",
    description:
      "A REAL same-key racing pair (env-gated): the winner drives ONE REAL model confirmation round through the REAL model gateway and settles; the racing loser replays the winner's committed receipt — identity preserved, ZERO additional REAL dispatches, the settlement applied exactly once across the pair.",
    submissions: { count: 1, sameKey: true },
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the winner's REAL confirmation round demands a REAL model dispatch",
    },
    laneEffects: (lane) => [settle(`LIVE-RACE-601-L${lane}`, `LIVE-RACE-601-L${lane}`, 17_500)],
    expected: {
      terminal: "COMPLETED",
      executions: 2,
      idempotencyRecords: 2,
      effects: { "settle:LIVE-RACE-601-L0": 1, "settle:LIVE-RACE-601-L1": 1 },
      appCreated: 1,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const CONCURRENCY_CORPUS: readonly ConcurrencyCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: ConcurrencyCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one submission lane. The racing rows'
 * pair shares ONE key (the race); the fan-out/burst lanes carry
 * distinct keys; the soak rounds carry round-distinct keys.
 */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
  readonly lane: number;
  readonly round?: number;
  readonly racingPair?: boolean;
}): string {
  const roundPart = options.round === undefined ? "" : `-r${options.round}`;
  const lanePart = options.racingPair === true ? "-race" : `-l${options.lane}`;
  return `val-025-app-${options.runSuffix}-${options.taskIndex}${roundPart}${lanePart}`;
}

/**
 * The app's task body for one submission lane (the request
 * fingerprint's driver). The racing-conflict row's PEER submission
 * carries a MUTATED body (a different fingerprint under the same key).
 */
export function taskBodyFor(options: {
  readonly rowId: string;
  readonly lane: number;
  readonly round?: number;
  readonly mutated?: boolean;
}): Record<string, unknown> {
  return {
    kind: CONCURRENCY_TASK_KIND,
    rowId: options.rowId,
    ...(options.round === undefined ? {} : { round: options.round }),
    lane: options.mutated === true ? "conflicting-mutation" : options.lane,
    ...(options.mutated === true ? { amountMicro: 999_999 } : {}),
  };
}

/**
 * The per-round submission expectation for the soak rows (the app's
 * per-round runs are judged by the ROUND-scaled counts: the racing
 * pair's 2 concurrent submissions + the 2 distinct lanes).
 */
export function soakRoundExpectation(): {
  readonly submissions: number;
  readonly created: number;
  readonly replayed: number;
  readonly rejected: number;
} {
  return {
    submissions: 4,
    created: 3,
    replayed: 1,
    rejected: 0,
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const CONCURRENCY_ROW_IDS: readonly string[] = CONCURRENCY_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function concurrencyRowById(rowId: string): ConcurrencyCorpusRow | null {
  return CONCURRENCY_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
