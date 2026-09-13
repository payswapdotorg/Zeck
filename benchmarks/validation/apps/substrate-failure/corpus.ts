/**
 * The substrate-failure corpus (VAL-022, AC1): the declared rows of the
 * sandbox-readiness and compute-substrate failure application. Per
 * row: the substrate failure mode (the injected class), the expected
 * classification (class + layer + retryability), the recovery policy
 * (bounded fresh-sandbox retries / the exact non-retryable boundary /
 * quarantine-on-repeat-failure with the cool-down recovery) and the
 * terminal outcome — per SUBMISSION for the multi-submission rows
 * (the strike/quarantine propagation is a cross-submission contract).
 *
 * Every offline row is deterministically reproducible through the app's
 * script-driven substrate adapters (replaying the REAL failure shapes
 * the platform's substrate family produces); the REAL process rows
 * ride the REAL `ProcessSandboxProvider` in the crown integration
 * suite (the REAL adapter's healthy path verified live where it
 * exists — live substrate failure on EXTERNAL substrates cannot be
 * coerced on demand; the injection points are the adapter seams).
 *
 * The pinned policies: the bounded fresh-sandbox retry budget is TWO
 * extra attempts (the program's bounded-retry precedent); the
 * quarantine threshold is TWO terminal substrate-layer submission
 * failures; the quarantine cool-down is 60s on the pinned injectable
 * clock. Waits are measured, never counted as attempts.
 */

import type {
  SubstrateFailureClass,
  SubstrateLayer,
  SubstrateOracle,
  SubstrateSubmissionOracle,
} from "../../platform/substrate-failure";
import type { ExecuteStep, ProbeStep } from "./fixtures";

/** The pinned bounded-retry policy the corpus oracles assume. */
export const CORPUS_RETRY_POLICY = {
  maxExtraAttempts: 2,
} as const;

/** One row of the substrate-failure corpus (oracles included, per submission). */
export interface SubstrateFailureCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The submitted task's substrate kind (the platform's own vocabulary). */
  readonly substrateKind: "process" | "container";
  /** The probe argv the platform dispatches (REAL executables for the REAL rows). */
  readonly command: string;
  readonly args: readonly string[];
  readonly publicEnv: Readonly<Record<string, string>>;
  readonly limits: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly executionTimeoutMs: number;
  };
  /** The fault-injection scripts (probe + execute; sticky last step). */
  readonly probeScript?: readonly ProbeStep[];
  readonly executeScript?: readonly ExecuteStep[];
  /**
   * Clock advance applied BEFORE each submission (the quarantine
   * cool-down recovery; index-aligned with the oracle's submissions).
   */
  readonly clockAdvanceBySubmission?: readonly number[];
  /** The full oracle (row-level injected class + per-submission contracts). */
  readonly oracle: SubstrateOracle;
  /** Whether the row rides the REAL process substrate (the crown binding). */
  readonly realProcessAdapter?: boolean;
  /** Provenance of the replayed/injected shape. */
  readonly source: string;
}

const submission = (
  attempts: number,
  attemptOutcomes: readonly ("success" | "failure" | "readiness-refused" | "quarantine-refused")[],
  terminal: "COMPLETED" | "FAILED",
  substrateClass: SubstrateFailureClass | null,
  layer: SubstrateLayer | null,
  strikesBefore: number,
  strikesAfter: number,
  extra?: { readonly quarantineEngages?: boolean; readonly gatedAtSubmission?: boolean },
): SubstrateSubmissionOracle => ({
  attempts,
  attemptOutcomes,
  terminal,
  substrateClass,
  layer,
  strikesBefore,
  strikesAfter,
  quarantineEngages: extra?.quarantineEngages === true,
  gatedAtSubmission: extra?.gatedAtSubmission === true,
});

/** The pinned probe task limits (a modest process-class profile). */
const LIMITS = {
  cpuMilliCores: 500,
  memoryMiB: 128,
  executionTimeoutMs: 30_000,
} as const;

/** The offline rows (deterministic fault injection — always drivable). */
export const OFFLINE_CORPUS_ROWS: readonly SubstrateFailureCorpusRow[] = [
  {
    rowId: "healthy-substrate",
    substrateKind: "process",
    description:
      "A clean first-attempt success on a ready substrate: one probe, one fresh sandbox, one execute — COMPLETED, no attribution.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["success"],
    oracle: {
      injectedClass: null,
      injectedRetryable: false,
      submissions: [submission(1, ["success"], "COMPLETED", null, null, 0, 0)],
    },
    source: "the REAL process-substrate success shape (ProcessSandboxProvider verbatim)",
  },
  {
    rowId: "readiness-refused-transient",
    substrateKind: "process",
    description:
      "Sandbox unavailability AT SUBMISSION (the capacity refusal): the first probe refuses, the bounded fresh-sandbox retry probes again, the substrate is ready — COMPLETED with the refusal history journaled (never dispatched to an unready substrate).",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["not-ready", "ready"],
    executeScript: ["success"],
    oracle: {
      injectedClass: "readiness-refused",
      injectedRetryable: true,
      submissions: [submission(2, ["readiness-refused", "success"], "COMPLETED", null, null, 0, 0)],
    },
    source: "the substrate family's own capacity/warm-pool refusal shape",
  },
  {
    rowId: "readiness-refused-persistent",
    substrateKind: "process",
    description:
      "Persistent sandbox unavailability at submission: every probe refuses across the whole bounded budget — the honest FAILED terminal with the exact boundary (zero executes; never dispatched to an unready substrate).",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["not-ready"],
    executeScript: [],
    oracle: {
      injectedClass: "readiness-refused",
      injectedRetryable: true,
      submissions: [
        submission(
          3,
          ["readiness-refused", "readiness-refused", "readiness-refused"],
          "FAILED",
          "readiness-refused",
          "substrate",
          0,
          1,
        ),
      ],
    },
    source: "the substrate family's own persistent capacity refusal shape",
  },
  {
    rowId: "sandbox-lost-recovery",
    substrateKind: "process",
    description:
      "Mid-execution sandbox loss with recovery: the sandbox disappears on the first execute, the bounded retry dispatches to a FRESH sandbox (never re-entering the lost one) and completes — COMPLETED with the loss history journaled exactly once per attempt.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["lost", "success"],
    oracle: {
      injectedClass: "sandbox-lost",
      injectedRetryable: true,
      submissions: [submission(2, ["failure", "success"], "COMPLETED", null, null, 0, 0)],
    },
    source:
      "the E2B/DAYTONA closed-sandbox mid-execution loss shape (adapter-error + sandboxLost evidence)",
  },
  {
    rowId: "sandbox-lost-persistent",
    substrateKind: "process",
    description:
      "Persistent mid-execution sandbox loss: every execute loses its sandbox across the whole bounded budget — three FRESH sandboxes, the honest FAILED terminal with the exact boundary.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["lost"],
    oracle: {
      injectedClass: "sandbox-lost",
      injectedRetryable: true,
      submissions: [
        submission(
          3,
          ["failure", "failure", "failure"],
          "FAILED",
          "sandbox-lost",
          "substrate",
          0,
          1,
        ),
      ],
    },
    source: "the E2B/DAYTONA closed-sandbox loss shape (persistent posture)",
  },
  {
    rowId: "substrate-timeout",
    substrateKind: "process",
    description:
      "The genuine substrate deadline timeout (the runtime's own timer fired — deadlineElapsed: true, the fact-verified classification): retryable-with-fresh-sandbox across the bounded budget, then the honest FAILED terminal with the exact boundary.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["timeout"],
    oracle: {
      injectedClass: "substrate-timeout",
      injectedRetryable: true,
      submissions: [
        submission(
          3,
          ["failure", "failure", "failure"],
          "FAILED",
          "substrate-timeout",
          "substrate",
          0,
          1,
        ),
      ],
    },
    source:
      "the REAL process-runtime deadline timeout shape (timeout token, retryable, timer-fired fact)",
  },
  {
    rowId: "resource-exhausted-oom",
    substrateKind: "process",
    description:
      "The OOM-killed sandbox the adapter MISLABELED as a timeout (exit 137, oomKilled, deadline NOT elapsed): the fact-driven classification derives resource-exhausted — NON-retryable (an OOM reproduces deterministically at the same admitted profile) — the honest FAILED on exactly ONE attempt with the exact boundary.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: { cpuMilliCores: 500, memoryMiB: 64, executionTimeoutMs: 30_000 },
    probeScript: ["ready"],
    executeScript: ["oom-mislabeled-timeout"],
    oracle: {
      injectedClass: "resource-exhausted",
      injectedRetryable: false,
      submissions: [submission(1, ["failure"], "FAILED", "resource-exhausted", "substrate", 0, 1)],
    },
    source:
      "the container-family OOM kill mislabeled as timeout (exit 137 + OOMKilled + deadline not elapsed — the documented misattribution shape)",
  },
  {
    rowId: "task-failure-in-sandbox",
    substrateKind: "process",
    description:
      "The task's own non-zero exit inside a HEALTHY sandbox: attributed to the TASK layer (the substrate is never blamed — no strike, no retry), the honest FAILED on exactly one attempt.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["task-failure"],
    oracle: {
      injectedClass: "task-failure",
      injectedRetryable: false,
      submissions: [submission(1, ["failure"], "FAILED", "task-failure", "task", 0, 0)],
    },
    source: "the REAL process-runtime non-zero-exit shape (sandbox-execution token, non-retryable)",
  },
  {
    rowId: "unwired-substrate",
    substrateKind: "container",
    description:
      "An environment kind with NO wired adapter: the platform's own fail-closed posture — the dispatch refuses BEFORE any probe or execute (zero substrate contact), runtime-unavailable, NON-retryable, the honest FAILED on exactly one admission attempt.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: [],
    oracle: {
      injectedClass: "runtime-unavailable",
      injectedRetryable: false,
      submissions: [submission(1, ["failure"], "FAILED", "runtime-unavailable", "substrate", 0, 1)],
    },
    source:
      "the platform's own unwired-substrate fail-closed posture (sandbox-service dispatch, verbatim message)",
  },
  {
    rowId: "quarantine-propagation-and-recovery",
    substrateKind: "process",
    description:
      "Quarantine on repeat failure, propagation to future submissions, and the cool-down recovery: submission 1 fails persistently (strike 1); submission 2 fails persistently again (strike 2 — the quarantine ENGAGES at its terminal failure); submission 3 — a FUTURE submission while quarantined — is refused at the gate BEFORE any probe or execute (zero substrate contact, the honest FAILED); after the cool-down window elapses on the pinned clock, submission 4 probes ready and completes — a COMPLETED execution with the substrate-failure history journaled across the ledger.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    probeScript: ["ready"],
    executeScript: ["lost", "lost", "lost", "lost", "lost", "lost", "success"],
    clockAdvanceBySubmission: [0, 0, 0, 60_001],
    oracle: {
      injectedClass: "sandbox-lost",
      injectedRetryable: true,
      submissions: [
        submission(
          3,
          ["failure", "failure", "failure"],
          "FAILED",
          "sandbox-lost",
          "substrate",
          0,
          1,
        ),
        submission(
          3,
          ["failure", "failure", "failure"],
          "FAILED",
          "sandbox-lost",
          "substrate",
          1,
          2,
          {
            quarantineEngages: true,
          },
        ),
        submission(1, ["quarantine-refused"], "FAILED", "readiness-refused", "substrate", 2, 2, {
          gatedAtSubmission: true,
        }),
        submission(1, ["success"], "COMPLETED", null, null, 2, 0),
      ],
    },
    source:
      "the strike/quarantine policy over the E2B/DAYTONA loss shape (repeat terminal failures → quarantine → cool-down → recovery)",
  },
];

/**
 * The REAL process-substrate rows (driven in the crown integration
 * suite over the REAL `ProcessSandboxProvider` — no credentials
 * required; the REAL adapter's healthy path, its genuine non-zero-exit
 * task failure and its genuine deadline timeout, all coerced on demand
 * through the REAL runtime).
 */
export const REAL_PROCESS_ROWS: readonly SubstrateFailureCorpusRow[] = [
  {
    rowId: "real-process-echo-healthy",
    substrateKind: "process",
    description:
      "The REAL process substrate executes a REAL child process (/bin/echo) in its ephemeral isolated workspace with the explicit non-secret env: COMPLETED with the REAL sha256 output digest, the exit-0 success observation and measured duration.",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    realProcessAdapter: true,
    oracle: {
      injectedClass: null,
      injectedRetryable: false,
      submissions: [submission(1, ["success"], "COMPLETED", null, null, 0, 0)],
    },
    source: "the REAL ProcessSandboxProvider (the adapter that exists; verified live)",
  },
  {
    rowId: "real-process-exit-task-failure",
    substrateKind: "process",
    description:
      "The REAL process substrate runs a REAL failing task (/bin/false, exit 1): attributed to the TASK layer by the REAL adapter's own observation (sandbox-execution, non-retryable — the substrate is not blamed), the honest FAILED on exactly one attempt.",
    command: "/bin/false",
    args: [],
    publicEnv: { PROBE: "substrate-failure" },
    limits: LIMITS,
    realProcessAdapter: true,
    oracle: {
      injectedClass: "task-failure",
      injectedRetryable: false,
      submissions: [submission(1, ["failure"], "FAILED", "task-failure", "task", 0, 0)],
    },
    source: "the REAL ProcessSandboxProvider non-zero-exit observation (verbatim)",
  },
  {
    rowId: "real-process-sleep-timeout",
    substrateKind: "process",
    description:
      "The REAL substrate deadline timeout coerced on demand: the REAL runtime executes /bin/sleep with a 250ms admitted timeout — the runtime's OWN timer fires (SIGKILL), the REAL observation carries the timeout token, retryable — bounded fresh-sandbox retries then the honest FAILED terminal.",
    command: "/bin/sleep",
    args: ["5"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 250 },
    realProcessAdapter: true,
    oracle: {
      injectedClass: "substrate-timeout",
      injectedRetryable: true,
      submissions: [
        submission(
          3,
          ["failure", "failure", "failure"],
          "FAILED",
          "substrate-timeout",
          "substrate",
          0,
          1,
        ),
      ],
    },
    source:
      "the REAL ProcessSandboxProvider deadline-timeout observation (the runtime's own timer — genuinely coercible on the REAL adapter)",
  },
];

/** The complete corpus (offline + REAL process rows; the app's pinned task slice). */
export const SUBSTRATE_FAILURE_CORPUS: readonly SubstrateFailureCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...REAL_PROCESS_ROWS,
];

/** The submission count of one row (1 for single-submission rows). */
export function submissionCountOf(row: SubstrateFailureCorpusRow): number {
  return row.oracle.submissions.length;
}

/** The row's headline terminal (its LAST submission's terminal). */
export function headlineTerminalOf(row: SubstrateFailureCorpusRow): "COMPLETED" | "FAILED" {
  return row.oracle.submissions[row.oracle.submissions.length - 1]?.terminal ?? "FAILED";
}

/** The ground truth of one submission (row-level injected facts + the submission's own contract). */
export function groundTruthForSubmission(
  row: SubstrateFailureCorpusRow,
  submissionIndex: number,
): {
  readonly injectedClass: SubstrateFailureClass | null;
  readonly injectedRetryable: boolean;
  readonly attempts: number;
  readonly attemptOutcomes: readonly (
    | "success"
    | "failure"
    | "readiness-refused"
    | "quarantine-refused"
  )[];
  readonly terminal: "COMPLETED" | "FAILED";
  readonly substrateClass: SubstrateFailureClass | null;
  readonly layer: SubstrateLayer | null;
  readonly strikesBefore: number;
  readonly strikesAfter: number;
  readonly quarantineEngages: boolean;
  readonly gatedAtSubmission: boolean;
} {
  const submissionOracle = row.oracle.submissions[submissionIndex];
  if (submissionOracle === undefined) {
    throw new Error(`corpus row ${row.rowId} has no submission ${submissionIndex + 1}`);
  }
  return {
    injectedClass: row.oracle.injectedClass,
    injectedRetryable: row.oracle.injectedRetryable,
    ...submissionOracle,
  };
}

/** The task body one submission carries (the app's public task shape). */
export function taskBodyForSubmission(
  row: SubstrateFailureCorpusRow,
  submissionIndex: number,
): {
  readonly kind: "substrate-probe";
  readonly scenario: string;
  readonly submission: number;
  readonly substrateKind: "process" | "container";
  readonly command: string;
  readonly args: readonly string[];
  readonly publicEnv: Readonly<Record<string, string>>;
  readonly limits: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly executionTimeoutMs: number;
  };
} {
  return {
    kind: "substrate-probe",
    scenario: row.rowId,
    submission: submissionIndex + 1,
    substrateKind: row.substrateKind,
    command: row.command,
    args: [...row.args],
    publicEnv: { ...row.publicEnv },
    limits: { ...row.limits },
  };
}
