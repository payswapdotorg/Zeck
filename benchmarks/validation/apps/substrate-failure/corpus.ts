/**
 * The substrate-failure corpus (VAL-022, AC1): the declared rows of
 * the sandbox-readiness application. Per row: the substrate failure
 * mode (the injected scenario), the expected classification (the
 * substrate class AND the platform fold), the recovery policy outcome
 * (the bounded re-probe / retry-with-fresh-sandbox /
 * quarantine-on-repeat-failure / honest FAILED with the exact
 * boundary) and the terminal. Multi-execution rows (the quarantine
 * row) carry one oracle per execution — the registry state carries
 * across them, which is exactly what the quarantine propagation
 * proves.
 *
 * Every offline row is deterministically reproducible through the
 * app's fault-injection substrate adapters (replaying the REAL
 * substrate failure shapes from the documented sources); the live
 * rows drive the REAL process substrate adapter (the platform's
 * declared sandbox/compute adapter surface — the REAL substrate in
 * this environment IS the validation sandbox itself; live substrate
 * LOSS and live OOM coercion are NOT RUN boundaries — they cannot be
 * coerced on demand, the injection points are the adapter seams, per
 * the work order's own framing).
 *
 * The pinned policies (mirroring the program's bounded-retry
 * precedent): readiness probes gate EVERY dispatch with at most THREE
 * probes per execution (re-probe with backoff on refusal; a
 * quarantined substrate refused at the FIRST probe); retryable
 * classes (sandbox-lost / substrate-timeout) get at most TWO extra
 * attempts, each in a FRESH sandbox; the quarantine threshold is TWO
 * consecutive substrate-failure terminals on one substrate.
 */

import type {
  PlatformFailureClass,
  SubstrateAttemptOutcome,
  SubstrateExecutionOracle,
  SubstrateFailureClass,
} from "../../platform/substrate-readiness";
import type { SubstrateFaultScenario } from "./fixtures";

/** The pinned bounded dispatch-retry policy the corpus oracles assume. */
export const CORPUS_RETRY_POLICY = {
  maxExtraAttempts: 2,
} as const;

/** The pinned readiness re-probe policy (probes gate every dispatch). */
export const CORPUS_READINESS_POLICY = {
  maxProbes: 3,
} as const;

/** The pinned quarantine threshold (consecutive substrate-failure terminals). */
export const CORPUS_QUARANTINE_THRESHOLD = 2;

/** The task kind every row's submission carries (the app's task vocabulary). */
export const SUBSTRATE_TASK_KIND = "substrate-readiness.probe.v1";

/** The payload every offline row declares (argv — never a shell). */
const PROBE_TASK = {
  command: "probe-worker",
  args: ["--emit", "substrate-ok"],
  env: {},
} as const;

/** The limits every offline row declares (the fixture substrate scripts the outcome). */
const PROBE_LIMITS = {
  cpuMilliCores: 500,
  memoryMiB: 256,
  executionTimeoutMs: 5_000,
} as const;

/** One row of the substrate-failure corpus (oracle per execution). */
export interface SubstrateCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The offline fault-injection scenario (null for live rows). */
  readonly scenario: SubstrateFaultScenario | null;
  readonly substrateId: string;
  /** The sandbox task the row's executions dispatch (argv + explicit env). */
  readonly task: { readonly command: string; readonly args: readonly string[] };
  /** The admitted limits (the substrate enforces the time bound too). */
  readonly limits: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly executionTimeoutMs: number;
  };
  /**
   * One oracle per EXECUTION the row drives (multi-execution rows
   * carry the cross-execution registry state — the quarantine
   * propagation).
   */
  readonly executions: readonly SubstrateExecutionOracle[];
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  readonly source: string;
}

const oracle = (
  injectedClass: SubstrateFailureClass | null,
  injectedRetryable: boolean,
  substrateClass: SubstrateFailureClass | null,
  platformClass: PlatformFailureClass | null,
  attempts: number,
  attemptOutcomes: readonly SubstrateAttemptOutcome[],
  readinessProbes: number,
  quarantined: boolean,
  terminal: "COMPLETED" | "FAILED",
): SubstrateExecutionOracle => ({
  injectedClass,
  injectedRetryable,
  expected: {
    substrateClass,
    platformClass,
    attempts,
    attemptOutcomes,
    readinessProbes,
    quarantined,
    terminal,
  },
});

const failures = (count: number): readonly SubstrateAttemptOutcome[] =>
  Array.from({ length: count }, () => "failure" as const);

/** The pinned corpus: 10 offline rows (12 executions) + 3 live rows. */
export const SUBSTRATE_CORPUS: readonly SubstrateCorpusRow[] = [
  {
    rowId: "healthy-clean-run",
    description:
      "The healthy anchor: the substrate answers ready and the payload runs to exit 0 — one probe, one attempt, COMPLETED with measured usage.",
    scenario: "healthy-clean",
    substrateId: "substrate-proc-1",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [oracle(null, false, null, null, 1, ["success"], 1, false, "COMPLETED")],
    source: "the healthy replay shape (the fixture meter measures the usage)",
  },
  {
    rowId: "readiness-refused-terminal",
    description:
      "Sandbox unavailability at submission: the substrate refuses readiness on every probe — the bounded re-probe budget exhausts, ZERO dispatches ever happen (never dispatch to an unready substrate), the honest FAILED with the readiness-refused class and the runtime-unavailable platform fold.",
    scenario: "readiness-refused-forever",
    substrateId: "substrate-proc-2",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "readiness-refused",
        false,
        "readiness-refused",
        "runtime-unavailable",
        0,
        [],
        3,
        false,
        "FAILED",
      ),
    ],
    source:
      "the REAL fail-closed availability posture (the runner-pool/capacity refusal class every substrate can produce)",
  },
  {
    rowId: "readiness-refused-recovery",
    description:
      "Readiness recovery: the substrate refuses twice (a cold-start window) then answers ready on the LAST probe of the budget — the bounded re-probe recovers and the payload completes: COMPLETED with the probe history journaled.",
    scenario: "readiness-refused-twice-then-ready",
    substrateId: "substrate-proc-3",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [oracle(null, false, null, null, 1, ["success"], 3, false, "COMPLETED")],
    source: "the transient-cold-start recovery shape (the bounded re-probe policy)",
  },
  {
    rowId: "sandbox-lost-retry-fresh-recovery",
    description:
      "Mid-execution sandbox loss with recovery: the first sandbox vanishes (the observation never settles — no result is fabricated), the retry runs in a FRESH sandbox (the lost sandbox id is never reused) and completes: COMPLETED with the substrate-failure history journaled exactly once per attempt.",
    scenario: "sandbox-lost-once-then-healthy",
    substrateId: "substrate-proc-4",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle("sandbox-lost", true, null, null, 2, ["failure", "success"], 2, false, "COMPLETED"),
    ],
    source:
      "the REAL mid-execution loss shape (the never-settling observation — runner eviction / node crash) then the healthy replay",
  },
  {
    rowId: "sandbox-lost-exhausted",
    description:
      "Mid-execution sandbox loss on every attempt: the bounded retry exhausts at exactly three FRESH-sandbox attempts (each journaled exactly once, none fabricating an outcome) — the honest FAILED with the sandbox-lost class and the runtime-unavailable platform fold.",
    scenario: "sandbox-lost-always",
    substrateId: "substrate-proc-5",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "sandbox-lost",
        true,
        "sandbox-lost",
        "runtime-unavailable",
        3,
        failures(3),
        3,
        false,
        "FAILED",
      ),
    ],
    source: "the REAL mid-execution loss shape (repeated — the exhausted bound)",
  },
  {
    rowId: "substrate-timeout-classified",
    description:
      "Substrate timeout classification: the run exceeds its admitted wall-clock deadline on every attempt (the REAL process-runtime deadline kill: timedOut, exit 137) — classified substrate-timeout / the platform's timeout fold, RETRYABLE, bounded to exactly three attempts, the honest FAILED.",
    scenario: "substrate-timeout-always",
    substrateId: "substrate-proc-6",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "substrate-timeout",
        true,
        "substrate-timeout",
        "timeout",
        3,
        failures(3),
        3,
        false,
        "FAILED",
      ),
    ],
    source:
      "REAL live shape (the process runtime's admitted-deadline SIGKILL — timedOut: true; the REAL_SUBSTRATE_FAILURE_SHAPES fixture)",
  },
  {
    rowId: "resource-exhausted-oom",
    description:
      "Resource exhaustion: the OOM-killed shape (the REAL container-runtime inspection: State.OOMKilled, exit 137, NOT the timeout marker) — classified resource-exhausted (the OOM-vs-timeout discrimination), NON-retryable (the same work would exhaust again), exactly one attempt, the honest FAILED with the sandbox-execution platform fold.",
    scenario: "resource-exhausted-oom",
    substrateId: "substrate-proc-7",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "resource-exhausted",
        false,
        "resource-exhausted",
        "sandbox-execution",
        1,
        failures(1),
        1,
        false,
        "FAILED",
      ),
    ],
    source:
      "REAL live shape (the container-runtime State.OOMKilled inspection — the REAL_SUBSTRATE_FAILURE_SHAPES fixture)",
  },
  {
    rowId: "payload-exit-nonzero",
    description:
      "The payload's own execution failure: the sandbox ran the work and the work exited non-zero (exit 7) — classified sandbox-execution (the platform's exit-code class), NON-retryable (a deterministic failure reproduces itself), exactly one attempt, the honest FAILED.",
    scenario: "payload-exit-nonzero",
    substrateId: "substrate-proc-8",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "sandbox-execution",
        false,
        "sandbox-execution",
        "sandbox-execution",
        1,
        failures(1),
        1,
        false,
        "FAILED",
      ),
    ],
    source: "REAL live shape (the non-zero payload exit — the process provider's own fold)",
  },
  {
    rowId: "sandbox-lost-then-unready",
    description:
      "Loss then unavailability mid-recovery: the first sandbox is lost (retryable), and the readiness gate REFUSES the retry (the substrate went down after the loss) — readiness gates EVERY dispatch, retries included; the re-probe budget exhausts; the honest FAILED with the readiness-refused class after exactly one dispatched attempt.",
    scenario: "sandbox-lost-then-unready",
    substrateId: "substrate-proc-9",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      oracle(
        "sandbox-lost",
        true,
        "readiness-refused",
        "runtime-unavailable",
        1,
        failures(1),
        3,
        false,
        "FAILED",
      ),
    ],
    source:
      "the REAL mid-execution loss shape then the fail-closed availability posture (the mid-recovery refusal)",
  },
  {
    rowId: "quarantine-on-repeat-failure",
    description:
      "Quarantine on repeat failure, with propagation: THREE executions on ONE substrate — the first exhausts the lost-sandbox retry (streak 1); the second exhausts again and ITS terminal report crosses the threshold (streak 2 — the substrate is QUARANTINED and the decision journaled); the third submission is refused at the FIRST probe (the quarantined refusal — the exact boundary: no re-probe, zero dispatches, the honest FAILED). The registry state carries across the three executions — that carry IS the propagation proof.",
    scenario: "sandbox-lost-always",
    substrateId: "substrate-quarantine-1",
    task: PROBE_TASK,
    limits: PROBE_LIMITS,
    executions: [
      // execution 1: exhausted, streak 1, no quarantine yet
      oracle(
        "sandbox-lost",
        true,
        "sandbox-lost",
        "runtime-unavailable",
        3,
        failures(3),
        3,
        false,
        "FAILED",
      ),
      // execution 2: exhausted again — the streak crosses the threshold
      oracle(
        "sandbox-lost",
        true,
        "sandbox-lost",
        "runtime-unavailable",
        3,
        failures(3),
        3,
        true,
        "FAILED",
      ),
      // execution 3: the quarantined refusal — first probe, zero dispatches
      oracle(
        "readiness-refused",
        false,
        "readiness-refused",
        "runtime-unavailable",
        0,
        [],
        1,
        false,
        "FAILED",
      ),
    ],
    source:
      "the repeat-failure containment policy (the quarantine threshold pinned at two consecutive terminals)",
  },
  // ---- LIVE rows (the REAL process substrate — the platform's
  // declared adapter surface; driven inside the PG crown — the REAL
  // substrate in this environment is the validation sandbox itself;
  // each live row drives its OWN substrate id so the registry state
  // never leaks across the live probes — the cross-execution
  // quarantine carry is the offline quarantine row's contract) ----
  {
    rowId: "live-process-healthy",
    description:
      "The REAL process substrate adapter's healthy path: a REAL isolated process runs to exit 0 — one probe (a REAL trivial spawn), one attempt, COMPLETED with the adapter's measured usage (the process substrate reports its honest uncosted usage).",
    scenario: null,
    substrateId: "substrate-live-process-healthy",
    task: { command: "runtime", args: ["-e", "console.log('substrate-ok')"] },
    limits: { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 10_000 },
    liveGate: {
      envVars: ["ZECK_PG_TEST_URL"],
      requirement:
        "the REAL platform path (env ZECK_PG_TEST_URL — the crown gate); the REAL process substrate itself needs no credential — the operator's sandbox IS the substrate",
    },
    executions: [oracle(null, false, null, null, 1, ["success"], 1, false, "COMPLETED")],
    source: "the REAL process substrate adapter (ProcessSandboxProvider over runIsolatedProcess)",
  },
  {
    rowId: "live-process-timeout",
    description:
      "The REAL substrate timeout: a REAL payload that outlives its admitted wall-clock deadline (250 ms) is SIGKILLed by the REAL process runtime — classified substrate-timeout (the platform's timeout fold), RETRYABLE, bounded to exactly three REAL attempts, the honest FAILED. Live substrate LOSS and live OOM coercion are NOT RUN boundaries (not coercible on demand — the injection points are the adapter seams).",
    scenario: null,
    substrateId: "substrate-live-process-timeout",
    task: { command: "runtime", args: ["-e", "setTimeout(() => {}, 30000)"] },
    limits: { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 250 },
    liveGate: {
      envVars: ["ZECK_PG_TEST_URL"],
      requirement:
        "the REAL platform path (env ZECK_PG_TEST_URL — the crown gate); the REAL process substrate itself needs no credential",
    },
    executions: [
      oracle(
        "substrate-timeout",
        true,
        "substrate-timeout",
        "timeout",
        3,
        failures(3),
        3,
        false,
        "FAILED",
      ),
    ],
    source:
      "the REAL process substrate adapter's admitted-deadline enforcement (SIGKILL on expiry)",
  },
  {
    rowId: "live-process-exit-nonzero",
    description:
      "The REAL payload exit failure: a REAL isolated process exits 7 — classified sandbox-execution (the platform's exit-code class), NON-retryable, exactly one attempt, the honest FAILED.",
    scenario: null,
    substrateId: "substrate-live-process-exit",
    task: { command: "runtime", args: ["-e", "process.exit(7)"] },
    limits: { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 10_000 },
    liveGate: {
      envVars: ["ZECK_PG_TEST_URL"],
      requirement:
        "the REAL platform path (env ZECK_PG_TEST_URL — the crown gate); the REAL process substrate itself needs no credential",
    },
    executions: [
      oracle(
        "sandbox-execution",
        false,
        "sandbox-execution",
        "sandbox-execution",
        1,
        failures(1),
        1,
        false,
        "FAILED",
      ),
    ],
    source: "the REAL process substrate adapter's non-zero-exit fold",
  },
];

/** The offline rows (deterministic fault injection — always drivable). */
export const OFFLINE_CORPUS_ROWS: readonly SubstrateCorpusRow[] = SUBSTRATE_CORPUS.filter(
  (row) => row.liveGate === undefined,
);

/** The live rows (the REAL process substrate, gated on the crown PG path). */
export const LIVE_CORPUS_ROWS: readonly SubstrateCorpusRow[] = SUBSTRATE_CORPUS.filter(
  (row) => row.liveGate !== undefined,
);

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: SubstrateCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

/** The app's pinned task slice: ONE entry per EXECUTION (the flat order). */
export interface SubstrateTaskEntry {
  readonly kind: string;
  readonly scenario: string;
  readonly execution: number;
  readonly substrate: string;
  readonly expectedTerminal: "COMPLETED" | "FAILED";
}

/** The flattened per-execution task slice (the app's submission order). */
export const SUBSTRATE_FAILURE_TASKS: readonly SubstrateTaskEntry[] = SUBSTRATE_CORPUS.flatMap(
  (row) =>
    row.executions.map((_, index) => ({
      kind: SUBSTRATE_TASK_KIND,
      scenario: row.rowId,
      execution: index + 1,
      substrate: row.substrateId,
      expectedTerminal: row.executions[index]?.expected.terminal ?? "FAILED",
    })),
);

/** The task body one submission carries (the app→platform contract). */
export function taskBodyFor(
  row: SubstrateCorpusRow,
  executionIndex: number,
): {
  readonly kind: string;
  readonly scenario: string;
  readonly execution: number;
  readonly substrate: string;
  readonly task: { readonly command: string; readonly args: readonly string[] };
} {
  return {
    kind: SUBSTRATE_TASK_KIND,
    scenario: row.rowId,
    execution: executionIndex + 1,
    substrate: row.substrateId,
    task: { command: row.task.command, args: [...row.task.args] },
  };
}
