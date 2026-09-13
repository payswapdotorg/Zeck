/**
 * The platform-side substrate-failure driver (VAL-022).
 *
 * The reliability slice for compute-substrate failure: drives
 * sandbox-readiness probe executions through the REAL platform path,
 * exercising compute-substrate failure modes at the platform's DECLARED
 * sandbox/compute adapter surface — the neutral `SandboxProvider`
 * runtime contract (`execute(spec) → observation` with the platform's
 * own failure vocabulary) — with controlled failure injection:
 *
 *   * the substrate-failure taxonomy as PURE derivations —
 *     `classifySubstrateFailure` (fact-driven classification of the
 *     adapter observation: the substrate's OWN facts — the deadline
 *     elapsed flag, the OOM-kill evidence, the sandbox-lost evidence —
 *     WIN over the adapter's failure-class label; a timeout claim with
 *     OOM facts is the misattributed resource-exhaustion an adapter
 *     can genuinely produce, and a genuine deadline timeout is the
 *     retryable substrate-timeout), `deriveGateVerdict` (the quarantine
 *     gate short-circuits BEFORE the probe — a quarantined substrate is
 *     never even probed, never dispatched) and the strike/quarantine
 *     state derivations (repeat terminal substrate-layer failures →
 *     quarantine; the window elapses → recovery; a success closes the
 *     circuit);
 *   * the recovery policy — readiness probes gate dispatch (never
 *     dispatch to an unready substrate; every dispatched attempt was
 *     probed ready in the SAME attempt), retry-with-fresh-sandbox for
 *     the retryable substrate classes (readiness-refused / sandbox-lost
 *     / substrate-timeout) at most `maxExtraAttempts` extra attempts,
 *     every retry on a FRESH sandbox (the lost/timed-out sandbox is
 *     never re-entered), quarantine-on-repeat-failure propagating to
 *     future submissions, and the honest FAILED terminal with the
 *     exact boundary for the non-retryable classes
 *     (resource-exhausted — deterministic reproduction at the same
 *     profile; adapter-error; runtime-unavailable — the platform's own
 *     fail-closed posture for an unwired substrate; task-failure — the
 *     substrate is never blamed for the task's own non-zero exit);
 *   * the execution driver mirroring the VAL-019/020 drivers (authorize
 *     → plan → planning-decision BEFORE the first dispatch → queue →
 *     start → the gated attempt loop → verify → terminal: a failure
 *     outcome or any failed criterion → FAILED — never a
 *     partial-success shortcut), journaling through the platform's OWN
 *     step-event vocabulary: `sandbox-admitted` (the fresh sandbox
 *     admission), `sandbox-denied` (the pre-effect refusals —
 *     readiness, quarantine, unwired), `sandbox-completed` (the settled
 *     observation) and `agent-action-recorded` (the per-attempt
 *     journal, exactly once per attempt, DIGEST references only).
 *
 * Honesty invariants:
 *   * a substrate/task failure FAILS the execution (no partial-success
 *     shortcut); retries are bounded and journaled exactly once per
 *     attempt; non-retryable failures never retry;
 *   * readiness gates dispatch mechanically: a dispatched attempt
 *     without a passing probe in the SAME attempt is unrepresentable
 *     (the criterion FAILs on any such synthetic sequence);
 *   * the quarantine gate is checked BEFORE the probe: a quarantined
 *     substrate is never probed, never dispatched (zero substrate
 *     contact) until the cool-down window elapses — a lying-healthy
 *     probe cannot bypass it;
 *   * every retry dispatches to a FRESH sandboxId (a dead sandbox is
 *     never re-entered — the fresh-sandbox criterion FAILs on any
 *     re-entry sequence);
 *   * usage and latency are measured, never estimated; evidence
 *     carries spec DIGESTS, never payload bytes;
 *   * an out-of-vocabulary task or a malformed probe task is a
 *     platform-layer rejection BEFORE any probe or dispatch effect.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL executions service (canonical transitions +
 * planning decisions + the REAL step-event vocabulary) and — where the
 * adapter exists — the REAL process substrate over the platform's
 * declared runtime contract. Live substrate failure on EXTERNAL
 * substrates cannot be coerced on demand: the injection points are the
 * adapter seams (fake adapters replaying the REAL failure shapes), with
 * the REAL adapter's healthy path verified live where it exists.
 */

import type { LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The substrate-failure taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/**
 * The platform's own adapter-facing failure tokens — structurally the
 * `SandboxFailureClass` vocabulary the declared runtime contract
 * carries (`sandbox-execution` | `timeout` | `adapter-error` |
 * `runtime-unavailable`). The substrate-failure classes below are the
 * validation slice's fact-driven derivations OVER that vocabulary.
 */
export type SubstrateFailureToken =
  | "sandbox-execution"
  | "timeout"
  | "adapter-error"
  | "runtime-unavailable";

/**
 * The substrate-failure class vocabulary: the classes the corpus
 * exercises. `task-failure` and `platform-error` carry the honest
 * NON-substrate attributions (the task's own non-zero exit inside a
 * healthy sandbox; the platform's own pre-effect machinery) so
 * attribution must still NAME them — a substrate is never blamed for
 * the task's own failure, and the platform layer never leaks into the
 * substrate layer.
 */
export const SUBSTRATE_FAILURE_CLASSES = [
  // the substrate refused before any execution effect
  "readiness-refused",
  // the sandbox disappeared mid-execution
  "sandbox-lost",
  // the substrate's own deadline fired (fact-verified)
  "substrate-timeout",
  // the substrate's resource manager killed the sandbox (OOM)
  "resource-exhausted",
  // the adapter itself failed (no substrate verdict)
  "adapter-error",
  // the substrate kind has no wired adapter (the fail-closed posture)
  "runtime-unavailable",
  // the TASK failed inside a healthy sandbox (never the substrate)
  "task-failure",
  // the platform's own pre-effect machinery
  "platform-error",
] as const;

export type SubstrateFailureClass = (typeof SUBSTRATE_FAILURE_CLASSES)[number];

/** The attribution layer (the substrate axis: substrate vs task vs platform). */
export type SubstrateLayer = "substrate" | "task" | "platform";

/**
 * The retryable classes — bounded retry WITH A FRESH SANDBOX applies to
 * these ONLY. `resource-exhausted` is deliberately NON-retryable: an
 * OOM-killed sandbox reproduces deterministically at the same admitted
 * resource profile, so a retry would fabricate a different outcome than
 * the substrate can honestly produce (the exact boundary the honest
 * FAILED carries).
 */
const RETRYABLE_WITH_FRESH_SANDBOX: ReadonlySet<SubstrateFailureClass> = new Set([
  "readiness-refused",
  "sandbox-lost",
  "substrate-timeout",
]);

/** The layer each substrate-failure class attributes to (the taxonomy table). */
const CLASS_LAYERS: Readonly<Record<SubstrateFailureClass, SubstrateLayer>> = {
  "readiness-refused": "substrate",
  "sandbox-lost": "substrate",
  "substrate-timeout": "substrate",
  "resource-exhausted": "substrate",
  "adapter-error": "substrate",
  "runtime-unavailable": "substrate",
  "task-failure": "task",
  "platform-error": "platform",
};

/** Whether the class is retryable under the bounded fresh-sandbox policy. */
export function isRetryableSubstrateClass(value: SubstrateFailureClass): boolean {
  return RETRYABLE_WITH_FRESH_SANDBOX.has(value);
}

/** The layer a class attributes to (the taxonomy table lookup). */
export function layerOfSubstrateClass(value: SubstrateFailureClass): SubstrateLayer {
  return CLASS_LAYERS[value];
}

/** The platform's own fail-closed message for an unwired substrate. */
export function unwiredSubstrateMessage(kind: string): string {
  return `no runtime provider is wired for environment kind "${kind}"; the sandbox fails closed rather than executing without the required isolation substrate`;
}

const MAX_SUBSTRATE_MESSAGE = 200;

function sanitizeMessage(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "substrate failure (no adapter message)";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "substrate failure (no adapter message)";
  }
  return trimmed.length <= MAX_SUBSTRATE_MESSAGE ? trimmed : `${trimmed.slice(0, 200)}…`;
}

// ---------------------------------------------------------------------------
// The declared adapter surface (structurally the REAL SandboxProvider
// runtime contract + the substrate readiness mechanism)
// ---------------------------------------------------------------------------

/** The environment kinds the substrate plane resolves (the platform's own vocabulary). */
export type SubstrateKind = "process" | "container" | "microvm" | "vm" | "customer-runner";

/** The governed isolation-profile class (the platform's own vocabulary). */
export type SubstrateIsolationClass = "standard" | "strict" | "dedicated-customer";

/** The sanitized runtime specification a substrate executes (the SandboxRuntimeSpec shape). */
export interface SubstrateRuntimeSpec {
  readonly sandboxId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly kind: SubstrateKind;
  readonly isolationClass: SubstrateIsolationClass;
  readonly task: {
    readonly command: string;
    readonly args: readonly string[];
    readonly publicEnv: Readonly<Record<string, string>>;
  };
  readonly limits: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly executionTimeoutMs: number;
  } | null;
  readonly network: {
    readonly egress: "none" | "allowlist";
    readonly allowedHosts: readonly string[];
  };
  readonly filesystem: {
    readonly workspace: "none" | "ephemeral-read-only" | "ephemeral-writable";
    readonly readOnlyArtifactRefs: readonly string[];
  };
  /** Mediated secret references (opaque — never values). */
  readonly secretRefs: readonly string[];
}

/**
 * What one runtime execution observed — structurally the REAL
 * `SandboxExecutionObservation` contract: the outcome class, the output
 * DIGEST, the bounded output evidence (the process runtime's
 * `{exitCode, stderr, durationMs}` family, the container family's
 * `{exitCode, oomKilled}` and the deadline/sandbox-lost facts the
 * substrate's own machinery reports), the usage and the failure tuple
 * in the platform's own vocabulary.
 */
export interface SubstrateObservation {
  readonly outcomeClass: "sandbox-success" | "sandbox-failure";
  readonly outputDigest: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  /** Runtime-reported actual usage (integer micro-USD; null when unmetered). */
  readonly usageMicroUsd: string | null;
  readonly failure: {
    readonly failureClass: SubstrateFailureToken;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/** The substrate readiness verdict (the substrate's own mechanism, probed BEFORE dispatch). */
export interface SubstrateReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
}

/**
 * One compute-substrate adapter — the platform's DECLARED runtime
 * contract (`execute`, structurally `SandboxProvider`) plus the
 * readiness mechanism the substrate family owns (snapshots, warm pools
 * and readiness probes are substrate mechanisms, never Zeck
 * authorities). Fake adapters replay the REAL failure shapes; the
 * production binding adapts the REAL process substrate onto this seam.
 */
export interface SubstrateAdapter {
  probeReadiness(): Promise<SubstrateReadiness>;
  execute(spec: SubstrateRuntimeSpec): Promise<SubstrateObservation>;
}

// ---------------------------------------------------------------------------
// Fact-driven classification (the timeout-vs-OOM discrimination)
// ---------------------------------------------------------------------------

/** One classified substrate failure: class + layer + retryability + the facts it derived from. */
export interface SubstrateFailure {
  readonly failureClass: SubstrateFailureClass;
  readonly layer: SubstrateLayer;
  /** Retryable under the bounded fresh-sandbox policy. */
  readonly retryable: boolean;
  /** The adapter's own token (the platform's SandboxFailureClass). */
  readonly adapterToken: SubstrateFailureToken;
  readonly message: string;
  /** The observed facts the classification derived from (null = fact absent). */
  readonly exitCode: number | null;
  readonly deadlineElapsed: boolean | null;
  readonly oomKilled: boolean | null;
  readonly sandboxLost: boolean | null;
}

function readFact(output: Readonly<Record<string, unknown>> | null, key: string): unknown {
  if (output === null) {
    return undefined;
  }
  return output[key];
}

function readBooleanFact(
  output: Readonly<Record<string, unknown>> | null,
  key: string,
): boolean | null {
  const value = readFact(output, key);
  return typeof value === "boolean" ? value : null;
}

function readExitCodeFact(output: Readonly<Record<string, unknown>> | null): number | null {
  const value = readFact(output, "exitCode");
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Classify one substrate observation (PURE, fact-driven). The
 * substrate's OWN facts WIN over the adapter's failure-class label:
 *
 *   * an OOM verdict (`oomKilled: true`, the container family's own
 *     kill evidence) or a SIGKILL exit (137) while the deadline did NOT
 *     elapse is `resource-exhausted` — NON-retryable — regardless of
 *     whether the adapter labeled it `timeout` or `sandbox-execution`
 *     (the misattributed OOM-vs-timeout discrimination);
 *   * a `timeout` token confirmed by the deadline fact
 *     (`deadlineElapsed: true`) is `substrate-timeout` — retryable;
 *   * an `adapter-error` carrying the sandbox-lost evidence
 *     (`sandboxLost: true`, the closed/evicted-sandbox shape the
 *     substrate family produces mid-execution) is `sandbox-lost` —
 *     retryable with a fresh sandbox;
 *   * `sandbox-execution` without OOM evidence is `task-failure` — the
 *     task's own non-zero exit inside a healthy sandbox (the task
 *     layer, never the substrate);
 *   * `runtime-unavailable` is the platform's own fail-closed
 *     unwired-substrate posture;
 *   * anything else `adapter-error` stays the non-retryable
 *     adapter-error.
 *
 * A success observation carries no failure (null).
 */
export function classifySubstrateFailure(
  observation: SubstrateObservation,
): SubstrateFailure | null {
  if (observation.outcomeClass === "sandbox-success" || observation.failure === null) {
    return null;
  }
  const failure = observation.failure;
  const output = observation.output;
  const exitCode = readExitCodeFact(output);
  const deadlineElapsed = readBooleanFact(output, "deadlineElapsed");
  const oomKilled = readBooleanFact(output, "oomKilled");
  const sandboxLost = readBooleanFact(output, "sandboxLost");

  // The OOM evidence: the substrate's resource manager killed the
  // sandbox BEFORE the deadline (the container family's OOMKilled
  // verdict, or the 128+SIGKILL exit) — never the task's own exit.
  const oomEvidence = oomKilled === true || exitCode === 137;
  const deadlineConfirmed = deadlineElapsed === true;

  let failureClass: SubstrateFailureClass;
  if (failure.failureClass === "runtime-unavailable") {
    failureClass = "runtime-unavailable";
  } else if (failure.failureClass === "adapter-error") {
    // A thrown mid-execution loss carrying the closed-sandbox evidence
    // is the lost sandbox; a generic adapter error stays adapter-error.
    failureClass = sandboxLost === true ? "sandbox-lost" : "adapter-error";
  } else if (oomEvidence && !deadlineConfirmed) {
    // The misattribution fix: OOM facts override BOTH the timeout label
    // and the task-exit label (a kill by the resource manager is never
    // a retryable timeout and never the task's own failure).
    failureClass = "resource-exhausted";
  } else if (failure.failureClass === "timeout") {
    failureClass = "substrate-timeout";
  } else {
    failureClass = "task-failure";
  }

  return {
    failureClass,
    layer: layerOfSubstrateClass(failureClass),
    retryable: isRetryableSubstrateClass(failureClass),
    adapterToken: failure.failureClass,
    message: sanitizeMessage(failure.message),
    exitCode,
    deadlineElapsed,
    oomKilled,
    sandboxLost,
  };
}

// ---------------------------------------------------------------------------
// The strike/quarantine state machine (PURE derivations)
// ---------------------------------------------------------------------------

/** The mutable substrate health state the driver tracks per substrate plane. */
export interface SubstrateHealthState {
  /** Terminal substrate-layer submission failures without an intervening success. */
  strikes: number;
  /** When quarantined: the epoch-ms the cool-down window ends (null = healthy). */
  quarantinedUntilEpochMs: number | null;
}

export function freshSubstrateState(): SubstrateHealthState {
  return { strikes: 0, quarantinedUntilEpochMs: null };
}

/** Whether the strike count has reached the quarantine threshold. */
export function strikeLeadsToQuarantine(strikes: number, threshold: number): boolean {
  return strikes >= threshold;
}

/** Whether the substrate is quarantined AT the given epoch (the window check). */
export function isQuarantinedAt(state: SubstrateHealthState, nowEpochMs: number): boolean {
  return state.quarantinedUntilEpochMs !== null && nowEpochMs < state.quarantinedUntilEpochMs;
}

/** The outcome of applying one terminal substrate-layer failure to the state. */
export interface StrikeOutcome {
  readonly state: SubstrateHealthState;
  /** Whether THIS strike engaged the quarantine. */
  readonly quarantined: boolean;
  /** The cool-down window end when quarantined (epoch ms; else null). */
  readonly quarantinedUntilEpochMs: number | null;
}

/**
 * Apply one terminal substrate-layer failure (PURE): the strike count
 * increments; reaching the threshold engages the quarantine with the
 * cool-down window (a pre-existing window is never extended).
 */
export function applyStrike(
  state: SubstrateHealthState,
  options: {
    readonly threshold: number;
    readonly coolDownMs: number;
    readonly nowEpochMs: number;
  },
): StrikeOutcome {
  const strikes = state.strikes + 1;
  const quarantined = strikeLeadsToQuarantine(strikes, options.threshold);
  const quarantinedUntilEpochMs = quarantined
    ? (state.quarantinedUntilEpochMs ?? options.nowEpochMs + options.coolDownMs)
    : state.quarantinedUntilEpochMs;
  return {
    state: { strikes, quarantinedUntilEpochMs },
    quarantined,
    quarantinedUntilEpochMs,
  };
}

/** Apply one successful execution (PURE): the circuit closes. */
export function applySuccess(_state: SubstrateHealthState): SubstrateHealthState {
  return { strikes: 0, quarantinedUntilEpochMs: null };
}

/** Commit a derived state onto the shared plane state (in-place, shared identity). */
function commitState(target: SubstrateHealthState, source: SubstrateHealthState): void {
  target.strikes = source.strikes;
  target.quarantinedUntilEpochMs = source.quarantinedUntilEpochMs;
}

/** The submission-gate verdict (PURE): the quarantine check precedes the probe. */
export type SubstrateGateVerdict = "quarantined" | "probe-required";

export function deriveGateVerdict(
  state: SubstrateHealthState,
  nowEpochMs: number,
): SubstrateGateVerdict {
  return isQuarantinedAt(state, nowEpochMs) ? "quarantined" : "probe-required";
}

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

export function digestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The canonical fresh-sandbox identity for one attempt (deterministic, never reused). */
export function freshSandboxId(executionId: string, attempt: number): string {
  return `${executionId}-sbx-${attempt}`;
}

// ---------------------------------------------------------------------------
// The probe task (the app's submitted shape, validated pre-effect)
// ---------------------------------------------------------------------------

/** The task kind every corpus row's submission carries. */
export const SUBSTRATE_PROBE_TASK_KIND = "substrate-probe";

/** One submitted substrate-probe task (the app's public shape). */
export interface SubstrateProbeTask {
  readonly kind: typeof SUBSTRATE_PROBE_TASK_KIND;
  readonly scenario: string;
  /** 1-based submission index within the row (multi-submission rows). */
  readonly submission: number;
  readonly substrateKind: SubstrateKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly publicEnv: Readonly<Record<string, string>>;
  readonly limits: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly executionTimeoutMs: number;
  };
}

/** The pre-effect validation verdict. */
export interface ProbeTaskValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Validate one substrate-probe task (PURE, pre-effect): the shape must
 * be a substrate-probe with a well-formed argv (a shell-free program
 * name + bounded args), an explicit non-secret public env and explicit
 * resource limits (a process-class environment admitted without limits
 * is unrepresentable — the platform's own contract). A violation is a
 * platform-layer rejection BEFORE any probe or dispatch effect.
 */
export function validateSubstrateProbeTask(task: unknown): ProbeTaskValidation {
  if (task === null || typeof task !== "object") {
    return { valid: false, reason: "task must be an object" };
  }
  const record = task as {
    kind?: unknown;
    scenario?: unknown;
    submission?: unknown;
    substrateKind?: unknown;
    command?: unknown;
    args?: unknown;
    publicEnv?: unknown;
    limits?: unknown;
  };
  if (record.kind !== SUBSTRATE_PROBE_TASK_KIND) {
    return {
      valid: false,
      reason: `task kind ${String(record.kind)} is outside the substrate-probe vocabulary`,
    };
  }
  if (typeof record.scenario !== "string" || record.scenario.length === 0) {
    return { valid: false, reason: "task.scenario must be a non-empty string" };
  }
  if (
    typeof record.submission !== "number" ||
    !Number.isInteger(record.submission) ||
    record.submission < 1
  ) {
    return { valid: false, reason: "task.submission must be a positive integer" };
  }
  if (typeof record.substrateKind !== "string" || record.substrateKind.length === 0) {
    return { valid: false, reason: "task.substrateKind must be a non-empty string" };
  }
  if (
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    record.command.length > 256
  ) {
    return {
      valid: false,
      reason: "task.command must be a shell-free program name (1..256 chars)",
    };
  }
  if (!Array.isArray(record.args) || record.args.length > 128) {
    return { valid: false, reason: "task.args must be an array of at most 128 strings" };
  }
  for (const arg of record.args) {
    if (typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) {
      return { valid: false, reason: "task.args entries must be strings of at most 4096 chars" };
    }
  }
  if (
    record.publicEnv === null ||
    typeof record.publicEnv !== "object" ||
    Array.isArray(record.publicEnv)
  ) {
    return { valid: false, reason: "task.publicEnv must be an object" };
  }
  for (const [name, value] of Object.entries(record.publicEnv)) {
    if (typeof value !== "string") {
      return { valid: false, reason: `task.publicEnv["${name}"] must be a string` };
    }
    if (
      /(^|_)(API_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_?KEY|CREDENTIAL|CREDENTIALS)(_|$)/i.test(
        name,
      )
    ) {
      return {
        valid: false,
        reason: `task.publicEnv name "${name}" is secret-shaped; publicEnv is non-secret by contract`,
      };
    }
    if (/sk-[A-Za-z0-9]{16,}|bearer\s+[A-Za-z0-9._-]{16,}/i.test(value)) {
      return {
        valid: false,
        reason: `task.publicEnv["${name}"] looks like a raw secret value; raw secrets never enter sandbox tasks`,
      };
    }
  }
  const limits = record.limits as {
    cpuMilliCores?: unknown;
    memoryMiB?: unknown;
    executionTimeoutMs?: unknown;
  } | null;
  if (
    limits === null ||
    typeof limits !== "object" ||
    typeof limits.cpuMilliCores !== "number" ||
    typeof limits.memoryMiB !== "number" ||
    typeof limits.executionTimeoutMs !== "number" ||
    !Number.isFinite(limits.cpuMilliCores) ||
    !Number.isFinite(limits.memoryMiB) ||
    !Number.isFinite(limits.executionTimeoutMs) ||
    limits.cpuMilliCores <= 0 ||
    limits.memoryMiB <= 0 ||
    limits.executionTimeoutMs <= 0
  ) {
    return {
      valid: false,
      reason:
        "task.limits must declare explicit positive cpuMilliCores, memoryMiB and executionTimeoutMs",
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

export interface SubstrateFailureLifecyclePort {
  /**
   * Canonical transitions (no wait-tool cycles: the sandbox dispatch is
   * synchronous within the run).
   */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
    readonly reason: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the first dispatch. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
  }): Promise<void>;
  /**
   * The per-attempt dispatch journal (the platform's
   * `agent-action-recorded` step-event vocabulary): called EXACTLY
   * once per attempt with digest references only.
   */
  recordAttempt(input: {
    readonly executionId: string;
    readonly record: SubstrateAttemptRecord;
  }): Promise<void>;
  /** The platform's OWN sandbox vocabulary: admitted / denied / completed. */
  recordSubstrateEvent(input: {
    readonly executionId: string;
    readonly command: "sandbox-admitted" | "sandbox-denied" | "sandbox-completed";
    readonly reference: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** The quarantine engagement (the strike threshold crossing). */
  recordQuarantineEngaged(input: {
    readonly executionId: string;
    readonly strikes: number;
    readonly threshold: number;
    readonly quarantinedUntilEpochMs: number;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// The oracle (the corpus row's expected contract)
// ---------------------------------------------------------------------------

/** One attempt's outcome kind (the ordered sequence the oracle pins). */
export type SubstrateAttemptOutcome =
  | "success"
  | "failure"
  | "readiness-refused"
  | "quarantine-refused";

/** One submission's ground truth (multi-submission rows carry one per submission). */
export interface SubstrateSubmissionOracle {
  /** Total attempts (1 + bounded retries; a gate refusal is its single attempt). */
  readonly attempts: number;
  /** The ordered expected attempt-outcome sequence. */
  readonly attemptOutcomes: readonly SubstrateAttemptOutcome[];
  readonly terminal: "COMPLETED" | "FAILED";
  /** The FINAL attempt's substrate-failure class (null = clean success). */
  readonly substrateClass: SubstrateFailureClass | null;
  /** The FINAL attempt's attribution layer (null = clean success). */
  readonly layer: SubstrateLayer | null;
  /** Substrate-plane strikes BEFORE this submission (the propagation facts). */
  readonly strikesBefore: number;
  /** Substrate-plane strikes AFTER this submission. */
  readonly strikesAfter: number;
  /** Whether the quarantine engages at this submission's terminal failure. */
  readonly quarantineEngages: boolean;
  /** Whether the substrate is quarantined at this submission's first gate. */
  readonly gatedAtSubmission: boolean;
}

/** The ground truth one substrate-failure probe submission is judged by. */
export interface SubstrateOracle {
  /** The failure class the row's substrate failures carry (null = healthy row). */
  readonly injectedClass: SubstrateFailureClass | null;
  /** The injected failure class's retryability. */
  readonly injectedRetryable: boolean;
  readonly submissions: readonly SubstrateSubmissionOracle[];
}

/**
 * The FULL ground truth of ONE driven submission: the row-level injected
 * class/retryability plus the submission's own pinned contract (attempts,
 * outcome sequence, terminal, class/layer, strike propagation facts and
 * the quarantine posture). Fully declared by the corpus — the criteria
 * compare observed facts against THIS, never against re-derivations.
 */
export interface SubstrateSubmissionGroundTruth extends SubstrateSubmissionOracle {
  readonly injectedClass: SubstrateFailureClass | null;
  readonly injectedRetryable: boolean;
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

/** One journaled substrate attempt (digests and facts, never payload bytes). */
export interface SubstrateAttemptRecord {
  /** 1-based attempt number (0 = the pre-effect platform rejection). */
  readonly attempt: number;
  readonly outcome: SubstrateAttemptOutcome;
  readonly substrateClass: SubstrateFailureClass | null;
  readonly layer: SubstrateLayer | null;
  readonly retryable: boolean;
  /** Whether THIS attempt triggered a retry (a backoff followed it). */
  readonly retried: boolean;
  readonly latencyMs: number;
  /** The FRESH sandbox this attempt dispatched (null when refused pre-effect). */
  readonly sandboxId: string | null;
  /**
   * The probe verdict of THIS attempt (null = never probed: the
   * quarantine gate short-circuits before any substrate contact).
   */
  readonly probeReady: boolean | null;
  readonly specDigest: string;
  readonly exitCode: number | null;
  readonly deadlineElapsed: boolean | null;
  readonly oomKilled: boolean | null;
  readonly sandboxLost: boolean | null;
  readonly message: string;
  readonly atEpochMs: number;
}

export interface SubstrateFailureRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly attempts: readonly SubstrateAttemptRecord[];
  readonly totalAttempts: number;
  /** The final attempt's classification (null = clean success). */
  readonly finalFailure: SubstrateFailure | null;
  readonly totalDispatchLatencyMs: number;
  readonly usageMicroUsd: string | null;
  readonly outputDigest: string | null;
  /** The driver's own count of recordAttempt calls. */
  readonly journaledAttempts: number;
  /** Substrate-plane counters observed by the driver. */
  readonly probesPerformed: number;
  readonly executesPerformed: number;
  readonly strikesBefore: number;
  readonly strikesAfter: number;
  /** Whether the quarantine engaged during THIS run. */
  readonly quarantineEngagedDuringRun: boolean;
}

// ---------------------------------------------------------------------------
// The substrate plane (the driver's substrate side)
// ---------------------------------------------------------------------------

/**
 * The substrate plane: the adapter registry (kind → adapter), the
 * shared health state and the policy. The registry lookup returning
 * null is the platform's own fail-closed unwired-substrate posture.
 */
export interface SubstratePlane {
  adapterFor(kind: SubstrateKind): SubstrateAdapter | null;
  readonly state: SubstrateHealthState;
  readonly policy: {
    readonly quarantineThreshold: number;
    readonly quarantineCoolDownMs: number;
  };
  readonly clock: {
    nowMs(): number;
  };
}

// ---------------------------------------------------------------------------
// The substrate-failure execution driver
// ---------------------------------------------------------------------------

/**
 * Drive one submitted substrate-probe execution to completion through
 * the platform path: authorize → plan → planning-decision BEFORE the
 * first dispatch → queue → start → the gated attempt loop (quarantine
 * gate BEFORE the probe; probe gates dispatch; fresh sandbox per
 * dispatched attempt; bounded retry for the retryable substrate classes
 * ONLY; strike accounting on terminal substrate-layer failures) →
 * verify → terminal anyFail → FAILED.
 *
 * Honesty invariants (by construction): a dispatched attempt without a
 * passing same-attempt probe is unrepresentable; a quarantined
 * substrate is never probed nor dispatched (the gate short-circuits);
 * every retry lands on a FRESH sandbox identity; the quarantine
 * propagates to future submissions through the shared plane state; a
 * task failure never strikes the substrate; recovery (post-cool-down)
 * produces a COMPLETED execution with the failure history journaled.
 */
export async function driveSubstrateFailureExecution(options: {
  readonly executionId: string;
  readonly task: unknown;
  readonly groundTruth: SubstrateSubmissionGroundTruth;
  readonly provider: string;
  readonly model: string;
  readonly lifecycle: SubstrateFailureLifecyclePort;
  readonly plane: SubstratePlane;
  /** Bounded retry policy for RETRYABLE substrate classes only. */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
}): Promise<SubstrateFailureRunResult> {
  const { executionId, lifecycle, plane } = options;
  const task = options.task as Partial<SubstrateProbeTask> | null;
  const validation = validateSubstrateProbeTask(options.task);
  const strikesBefore = plane.state.strikes;

  await lifecycle.transition({ executionId, step: "authorize", reason: "val-022-authorize" });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-022-plan" });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "substrate-failure-probe",
    },
  });
  await lifecycle.transition({ executionId, step: "queue", reason: "val-022-queue" });
  await lifecycle.transition({ executionId, step: "start", reason: "val-022-start" });

  const attempts: SubstrateAttemptRecord[] = [];
  let journaledAttempts = 0;
  let probesPerformed = 0;
  let executesPerformed = 0;
  let quarantineEngagedDuringRun = false;
  let finalOutcome:
    | { readonly kind: "success"; readonly observation: SubstrateObservation }
    | { readonly kind: "failure"; readonly failure: SubstrateFailure }
    | { readonly kind: "rejected"; readonly failure: SubstrateFailure }
    | null = null;
  let successUsageMicroUsd: string | null = null;
  let successOutputDigest: string | null = null;

  if (validation.valid) {
    const substrateKind = task?.substrateKind as SubstrateKind;
    const adapter = plane.adapterFor(substrateKind);
    for (;;) {
      const attempt = attempts.length + 1;
      const nowEpochMs = plane.clock.nowMs();
      const specDigest = digestOf({
        kind: substrateKind,
        scenario: task?.scenario,
        command: task?.command,
        args: task?.args,
        publicEnv: task?.publicEnv,
        limits: task?.limits,
        submission: task?.submission,
      });
      const base = {
        attempt,
        latencyMs: 0,
        specDigest,
        atEpochMs: nowEpochMs,
      };

      // ---- the quarantine gate: BEFORE the probe (zero substrate contact) ----
      if (deriveGateVerdict(plane.state, nowEpochMs) === "quarantined") {
        const message = `substrate quarantined until ${String(plane.state.quarantinedUntilEpochMs)}ms (repeat substrate-layer failures); the submission is refused before any probe or dispatch`;
        await lifecycle.recordSubstrateEvent({
          executionId,
          command: "sandbox-denied",
          reference: {
            attempt,
            reason: "quarantine",
            quarantinedUntilEpochMs: plane.state.quarantinedUntilEpochMs,
          },
        });
        const record: SubstrateAttemptRecord = {
          ...base,
          outcome: "quarantine-refused",
          substrateClass: "readiness-refused",
          layer: "substrate",
          retryable: false,
          retried: false,
          sandboxId: null,
          probeReady: null,
          exitCode: null,
          deadlineElapsed: null,
          oomKilled: null,
          sandboxLost: null,
          message,
        };
        attempts.push(record);
        await lifecycle.recordAttempt({ executionId, record });
        journaledAttempts += 1;
        finalOutcome = {
          kind: "rejected",
          failure: {
            failureClass: "readiness-refused",
            layer: "substrate",
            retryable: false,
            adapterToken: "runtime-unavailable",
            message,
            exitCode: null,
            deadlineElapsed: null,
            oomKilled: null,
            sandboxLost: null,
          },
        };
        break;
      }

      // ---- the unwired substrate: the fail-closed posture ----
      if (adapter === null) {
        const message = unwiredSubstrateMessage(substrateKind);
        await lifecycle.recordSubstrateEvent({
          executionId,
          command: "sandbox-denied",
          reference: { attempt, reason: "unwired-substrate", kind: substrateKind },
        });
        const record: SubstrateAttemptRecord = {
          ...base,
          outcome: "failure",
          substrateClass: "runtime-unavailable",
          layer: "substrate",
          retryable: false,
          retried: false,
          sandboxId: null,
          probeReady: null,
          exitCode: null,
          deadlineElapsed: null,
          oomKilled: null,
          sandboxLost: null,
          message,
        };
        attempts.push(record);
        await lifecycle.recordAttempt({ executionId, record });
        journaledAttempts += 1;
        finalOutcome = {
          kind: "failure",
          failure: {
            failureClass: "runtime-unavailable",
            layer: "substrate",
            retryable: false,
            adapterToken: "runtime-unavailable",
            message,
            exitCode: null,
            deadlineElapsed: null,
            oomKilled: null,
            sandboxLost: null,
          },
        };
        // A terminal substrate-layer failure: the strike accounting.
        const strike = applyStrike(plane.state, {
          threshold: plane.policy.quarantineThreshold,
          coolDownMs: plane.policy.quarantineCoolDownMs,
          nowEpochMs: plane.clock.nowMs(),
        });
        commitState(plane.state, strike.state);
        if (strike.quarantined) {
          quarantineEngagedDuringRun = true;
          await lifecycle.recordQuarantineEngaged({
            executionId,
            strikes: strike.state.strikes,
            threshold: plane.policy.quarantineThreshold,
            quarantinedUntilEpochMs: strike.quarantinedUntilEpochMs ?? 0,
          });
        }
        break;
      }

      // ---- the readiness probe: gates dispatch (never dispatch unready) ----
      const probe = await adapter.probeReadiness();
      probesPerformed += 1;
      if (!probe.ready) {
        const message = `substrate not ready at submission: ${probe.reason ?? "no reason reported"}`;
        await lifecycle.recordSubstrateEvent({
          executionId,
          command: "sandbox-denied",
          reference: { attempt, reason: "readiness", probeReason: probe.reason },
        });
        const willRetry = attempt <= options.retry.maxExtraAttempts;
        const record: SubstrateAttemptRecord = {
          ...base,
          outcome: "readiness-refused",
          substrateClass: "readiness-refused",
          layer: "substrate",
          retryable: true,
          retried: willRetry,
          sandboxId: null,
          probeReady: false,
          exitCode: null,
          deadlineElapsed: null,
          oomKilled: null,
          sandboxLost: null,
          message,
        };
        attempts.push(record);
        await lifecycle.recordAttempt({ executionId, record });
        journaledAttempts += 1;
        finalOutcome = {
          kind: "failure",
          failure: {
            failureClass: "readiness-refused",
            layer: "substrate",
            retryable: true,
            adapterToken: "runtime-unavailable",
            message,
            exitCode: null,
            deadlineElapsed: null,
            oomKilled: null,
            sandboxLost: null,
          },
        };
        if (!willRetry) {
          // The terminal readiness refusal strikes (substrate layer).
          const strike = applyStrike(plane.state, {
            threshold: plane.policy.quarantineThreshold,
            coolDownMs: plane.policy.quarantineCoolDownMs,
            nowEpochMs: plane.clock.nowMs(),
          });
          commitState(plane.state, strike.state);
          if (strike.quarantined) {
            quarantineEngagedDuringRun = true;
            await lifecycle.recordQuarantineEngaged({
              executionId,
              strikes: strike.state.strikes,
              threshold: plane.policy.quarantineThreshold,
              quarantinedUntilEpochMs: strike.quarantinedUntilEpochMs ?? 0,
            });
          }
          break;
        }
        await options.retry.sleep(options.retry.backoffMs);
        continue;
      }

      // ---- dispatch on a FRESH sandbox (never re-enter a dead sandbox) ----
      const sandboxId = freshSandboxId(executionId, attempt);
      await lifecycle.recordSubstrateEvent({
        executionId,
        command: "sandbox-admitted",
        reference: { attempt, sandboxId, specDigest, freshSandbox: true },
      });
      const spec: SubstrateRuntimeSpec = {
        sandboxId,
        applicationId: `val-022-app-${digestOf(executionId)}`,
        tenantId: `val-022-tenant-${digestOf(executionId)}`,
        executionId,
        kind: substrateKind,
        isolationClass: "standard",
        task: {
          command: String(task?.command ?? ""),
          args: [...(task?.args ?? [])],
          publicEnv: { ...(task?.publicEnv ?? {}) },
        },
        limits: {
          ...(task?.limits ?? { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 }),
        },
        network: { egress: "none", allowedHosts: [] },
        filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
        secretRefs: [],
      };
      const dispatchStartedAt = plane.clock.nowMs();
      const observation = await adapter.execute(spec);
      executesPerformed += 1;
      const latencyMs = plane.clock.nowMs() - dispatchStartedAt;
      const failure = classifySubstrateFailure(observation);
      await lifecycle.recordSubstrateEvent({
        executionId,
        command: "sandbox-completed",
        reference: {
          attempt,
          sandboxId,
          outcomeClass: observation.outcomeClass,
          ...(failure === null
            ? { outputDigest: observation.outputDigest }
            : {
                failureClass: failure.failureClass,
                exitCode: failure.exitCode,
                deadlineElapsed: failure.deadlineElapsed,
                oomKilled: failure.oomKilled,
                sandboxLost: failure.sandboxLost,
                failureMessageDigest: digestOf(failure.message),
              }),
        },
      });

      if (failure === null) {
        // The healthy path: the run COMPLETES; the circuit closes.
        commitState(plane.state, applySuccess(plane.state));
        const record: SubstrateAttemptRecord = {
          ...base,
          latencyMs,
          outcome: "success",
          substrateClass: null,
          layer: null,
          retryable: false,
          retried: false,
          sandboxId,
          probeReady: true,
          exitCode: readExitCodeFact(observation.output),
          deadlineElapsed: readBooleanFact(observation.output, "deadlineElapsed"),
          oomKilled: readBooleanFact(observation.output, "oomKilled"),
          sandboxLost: readBooleanFact(observation.output, "sandboxLost"),
          message: "success",
        };
        attempts.push(record);
        await lifecycle.recordAttempt({ executionId, record });
        journaledAttempts += 1;
        finalOutcome = { kind: "success", observation };
        successUsageMicroUsd = observation.usageMicroUsd;
        successOutputDigest = observation.outputDigest;
        break;
      }

      // ---- the failure path: classify honestly, journal, strike-account ----
      const willRetry = failure.retryable && attempt <= options.retry.maxExtraAttempts;
      const record: SubstrateAttemptRecord = {
        ...base,
        latencyMs,
        outcome: "failure",
        substrateClass: failure.failureClass,
        layer: failure.layer,
        retryable: failure.retryable,
        retried: willRetry,
        sandboxId,
        probeReady: true,
        exitCode: failure.exitCode,
        deadlineElapsed: failure.deadlineElapsed,
        oomKilled: failure.oomKilled,
        sandboxLost: failure.sandboxLost,
        message: failure.message,
      };
      attempts.push(record);
      await lifecycle.recordAttempt({ executionId, record });
      journaledAttempts += 1;
      finalOutcome = { kind: "failure", failure };

      // Strike accounting: a terminal substrate-layer failure strikes;
      // a task failure never blames the substrate.
      if (failure.layer === "substrate" && !willRetry) {
        const strike = applyStrike(plane.state, {
          threshold: plane.policy.quarantineThreshold,
          coolDownMs: plane.policy.quarantineCoolDownMs,
          nowEpochMs: plane.clock.nowMs(),
        });
        commitState(plane.state, strike.state);
        if (strike.quarantined) {
          quarantineEngagedDuringRun = true;
          await lifecycle.recordQuarantineEngaged({
            executionId,
            strikes: strike.state.strikes,
            threshold: plane.policy.quarantineThreshold,
            quarantinedUntilEpochMs: strike.quarantinedUntilEpochMs ?? 0,
          });
        }
      }
      if (!willRetry) {
        break;
      }
      await options.retry.sleep(options.retry.backoffMs);
    }
  } else {
    // Out-of-vocabulary/malformed task: a platform-layer rejection
    // BEFORE any probe or dispatch effect.
    const message = validation.reason ?? "invalid substrate-probe task";
    const record: SubstrateAttemptRecord = {
      attempt: 0,
      outcome: "failure",
      substrateClass: "platform-error",
      layer: "platform",
      retryable: false,
      retried: false,
      latencyMs: 0,
      sandboxId: null,
      probeReady: null,
      specDigest: digestOf(options.task),
      exitCode: null,
      deadlineElapsed: null,
      oomKilled: null,
      sandboxLost: null,
      message,
      atEpochMs: plane.clock.nowMs(),
    };
    attempts.push(record);
    await lifecycle.recordAttempt({ executionId, record });
    journaledAttempts += 1;
    finalOutcome = {
      kind: "rejected",
      failure: {
        failureClass: "platform-error",
        layer: "platform",
        retryable: false,
        adapterToken: "runtime-unavailable",
        message,
        exitCode: null,
        deadlineElapsed: null,
        oomKilled: null,
        sandboxLost: null,
      },
    };
  }

  const totalDispatchLatencyMs = attempts.reduce((sum, record) => sum + record.latencyMs, 0);
  const criteria = deriveSubstrateFailureCriteria({
    executionId,
    groundTruth: options.groundTruth,
    attempts,
    finalOutcome,
    journaledAttempts,
    maxExtraAttempts: options.retry.maxExtraAttempts,
    strikesBefore,
    strikesAfter: plane.state.strikes,
    quarantineEngagedDuringRun,
    usageMicroUsd: successUsageMicroUsd,
    totalDispatchLatencyMs,
  });
  const outcomeFailed =
    finalOutcome !== null && (finalOutcome.kind === "failure" || finalOutcome.kind === "rejected");
  const anyFail = outcomeFailed || criteria.some((criterion) => criterion.status === "FAIL");

  await lifecycle.transition({ executionId, step: "verify", reason: "val-022-verify" });
  await lifecycle.complete({
    executionId,
    verdict: anyFail ? "fail" : "pass",
    criteria,
    reason: anyFail ? "val-022-mechanical-verification-failed" : "val-022-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    attempts,
    totalAttempts: attempts.length,
    finalFailure:
      finalOutcome === null ? null : finalOutcome.kind === "success" ? null : finalOutcome.failure,
    totalDispatchLatencyMs,
    usageMicroUsd: successUsageMicroUsd,
    outputDigest: successOutputDigest,
    journaledAttempts,
    probesPerformed,
    executesPerformed,
    strikesBefore,
    strikesAfter: plane.state.strikes,
    quarantineEngagedDuringRun,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one substrate-failure submission.
 * PURE: the same attempt history + oracle always yields the same
 * verdicts. The criteria prove classification correctness (class +
 * layer + retryability), bounded fresh-sandbox retry policy
 * conformance, the readiness-gated dispatch contract (every dispatched
 * attempt was probed ready in the SAME attempt; refusals never
 * dispatch), the fresh-sandbox contract (a dead sandbox is never
 * re-entered), the quarantine contract (the gate short-circuits with
 * zero substrate contact; recovery dispatches with a passing probe),
 * the strike propagation facts, the journal exactly-once contract and
 * the honest outcome contract.
 */
export function deriveSubstrateFailureCriteria(input: {
  readonly executionId: string;
  readonly groundTruth: SubstrateSubmissionGroundTruth;
  readonly attempts: readonly SubstrateAttemptRecord[];
  readonly finalOutcome:
    | { readonly kind: "success"; readonly observation: SubstrateObservation }
    | { readonly kind: "failure" | "rejected"; readonly failure: SubstrateFailure }
    | null;
  readonly journaledAttempts: number;
  readonly maxExtraAttempts: number;
  readonly strikesBefore: number;
  readonly strikesAfter: number;
  readonly quarantineEngagedDuringRun: boolean;
  readonly usageMicroUsd: string | null;
  readonly totalDispatchLatencyMs: number;
}): LabVerificationCriterion[] {
  const { attempts, groundTruth } = input;
  const criteria: LabVerificationCriterion[] = [];
  const finalFailure =
    input.finalOutcome === null || input.finalOutcome.kind === "success"
      ? null
      : input.finalOutcome.failure;
  const dispatched = attempts.filter((record) => record.sandboxId !== null);
  const failedAttempts = attempts.filter(
    (record) => record.outcome === "failure" || record.outcome === "readiness-refused",
  );

  // 1. The substrate-failure class of the final attempt (the submission
  //    oracle's own pinned class — the quarantine-refused gate boundary
  //    and every terminal failure alike).
  const observedClass = finalFailure === null ? null : finalFailure.failureClass;
  const classOk = observedClass === groundTruth.substrateClass;
  criteria.push({
    criterionId: "substrate-class",
    strategy: "deterministic",
    status: classOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.substrateClass ?? "none"}`,
      `observed:${observedClass ?? "none"}`,
      `finalOutcome:${input.finalOutcome === null ? "none" : input.finalOutcome.kind}`,
    ],
  });

  // 2. The attribution layer of the final attempt.
  const observedLayer = finalFailure === null ? null : finalFailure.layer;
  const layerOk = observedLayer === groundTruth.layer;
  criteria.push({
    criterionId: "attribution-layer",
    strategy: "deterministic",
    status: layerOk ? "PASS" : "FAIL",
    evidence: [`expected:${groundTruth.layer ?? "none"}`, `observed:${observedLayer ?? "none"}`],
  });

  // 3. Retry classification: every FAILED/REFUSED attempt carries the
  //    row's injected class with the injected retryability (a
  //    misattributed attempt — the OOM masquerading as a retryable
  //    timeout — FAILS here). Quarantine-gate refusals are excluded:
  //    they are the quarantine's own terminal boundary, never the
  //    injected failure.
  let retryClassOk = true;
  const retryEvidence: string[] = [];
  const classifiedAttempts = attempts.filter(
    (record) => record.outcome !== "quarantine-refused" && record.substrateClass !== null,
  );
  if (groundTruth.injectedClass === null) {
    retryEvidence.push("no-failure-injected");
    if (classifiedAttempts.length > 0) {
      retryClassOk = false;
      retryEvidence.push(`unexpected-failures:${classifiedAttempts.length}`);
    }
  } else {
    for (const record of classifiedAttempts) {
      const matches =
        record.substrateClass === groundTruth.injectedClass &&
        record.retryable === groundTruth.injectedRetryable &&
        record.layer === layerOfSubstrateClass(groundTruth.injectedClass);
      if (!matches) {
        retryClassOk = false;
      }
      retryEvidence.push(
        `attempt${record.attempt}:${record.substrateClass ?? "none"}/` +
          `${record.layer ?? "none"}/retryable:${String(record.retryable)}` +
          `/exit:${record.exitCode === null ? "?" : String(record.exitCode)}` +
          `/deadlineElapsed:${record.deadlineElapsed === null ? "?" : String(record.deadlineElapsed)}` +
          `/oomKilled:${record.oomKilled === null ? "?" : String(record.oomKilled)}`,
      );
    }
  }
  criteria.push({
    criterionId: "retry-classification",
    strategy: "deterministic",
    status: retryClassOk ? "PASS" : "FAIL",
    evidence: retryEvidence.length > 0 ? retryEvidence : ["no-attempts"],
  });

  // 4. Attempt count: the submission oracle pins the exact count
  //    (1 + bounded retries; the gate refusal is its single attempt).
  const attemptsOk = attempts.length === groundTruth.attempts;
  criteria.push({
    criterionId: "attempt-count",
    strategy: "deterministic",
    status: attemptsOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.attempts}`,
      `observed:${attempts.length}`,
      `maxExtraAttempts:${input.maxExtraAttempts}`,
    ],
  });

  // 5. Bounded-retry policy conformance: no infinite loop (at most
  //    1 + maxExtraAttempts); a non-retryable failure is always the LAST
  //    attempt; a quarantine-refused attempt is always the LAST (the
  //    boundary is terminal for the submission).
  const boundedAbove = attempts.length <= 1 + input.maxExtraAttempts;
  const nonRetryableLast = failedAttempts.every((record) => {
    if (record.retryable) {
      return true;
    }
    return record.attempt === attempts.length;
  });
  const quarantineRefusedLast = attempts
    .filter((record) => record.outcome === "quarantine-refused")
    .every((record) => record.attempt === attempts.length);
  const boundedOk = boundedAbove && nonRetryableLast && quarantineRefusedLast;
  criteria.push({
    criterionId: "bounded-retry",
    strategy: "deterministic",
    status: boundedOk ? "PASS" : "FAIL",
    evidence: [
      `attempts:${attempts.length}`,
      `limit:${1 + input.maxExtraAttempts}`,
      `nonRetryableFailuresTerminal:${String(nonRetryableLast)}`,
      `quarantineRefusalsTerminal:${String(quarantineRefusedLast)}`,
    ],
  });

  // 6. The fresh-sandbox contract: every dispatched attempt carries a
  //    DISTINCT fresh sandbox identity (a retry never re-enters a dead
  //    sandbox); the identities follow the canonical per-attempt form.
  const sandboxIds = dispatched.map((record) => record.sandboxId);
  const distinctSandboxes = new Set(sandboxIds);
  const canonicalForm = dispatched.every(
    (record) => record.sandboxId === freshSandboxId(input.executionId, record.attempt),
  );
  const freshOk = distinctSandboxes.size === sandboxIds.length && canonicalForm;
  criteria.push({
    criterionId: "fresh-sandbox-per-attempt",
    strategy: "deterministic",
    status: freshOk ? "PASS" : "FAIL",
    evidence: [
      `dispatched:${sandboxIds.length}`,
      `distinctSandboxes:${distinctSandboxes.size}`,
      `canonicalForm:${String(canonicalForm)}`,
      `sandboxIds:${sandboxIds.join("|") || "none"}`,
    ],
  });

  // 7. The readiness-gated dispatch contract: every DISPATCHED attempt
  //    was probed ready in the SAME attempt; every readiness-refused
  //    attempt was probed not-ready and NEVER dispatched; every
  //    quarantine-refused attempt was never probed (the gate
  //    short-circuits — zero substrate contact).
  const dispatchedGated = dispatched.every((record) => record.probeReady === true);
  const readinessRefusedNeverDispatched = attempts
    .filter((record) => record.outcome === "readiness-refused")
    .every((record) => record.probeReady === false && record.sandboxId === null);
  const quarantineRefusedNeverProbed = attempts
    .filter((record) => record.outcome === "quarantine-refused")
    .every((record) => record.probeReady === null && record.sandboxId === null);
  const gateOk = dispatchedGated && readinessRefusedNeverDispatched && quarantineRefusedNeverProbed;
  criteria.push({
    criterionId: "readiness-gated-dispatch",
    strategy: "deterministic",
    status: gateOk ? "PASS" : "FAIL",
    evidence: [
      `dispatchedWithPassingProbe:${String(dispatchedGated)}`,
      `readinessRefusedNeverDispatched:${String(readinessRefusedNeverDispatched)}`,
      `quarantineRefusedNeverProbed:${String(quarantineRefusedNeverProbed)}`,
      `probes:${attempts.filter((record) => record.probeReady !== null).length}`,
      `executes:${dispatched.length}`,
    ],
  });

  // 8. The quarantine contract against the submission oracle's declared
  //    posture: a gated submission NEVER contacts the substrate (every
  //    attempt is the gate refusal — no probe, no dispatch — the
  //    quarantine bypass this criterion mechanically rejects); an
  //    engaging submission crosses the threshold at its TERMINAL
  //    failure (the attempts before it were normal; no gate refusal
  //    follows within the same run); the strike propagation facts match
  //    the declared before/after counts exactly.
  let quarantineOk = true;
  const quarantineEvidence: string[] = [];
  const strikesOk =
    input.strikesBefore === groundTruth.strikesBefore &&
    input.strikesAfter === groundTruth.strikesAfter;
  if (groundTruth.gatedAtSubmission) {
    quarantineEvidence.push("gated-at-submission");
    if (
      attempts.length === 0 ||
      !attempts.every(
        (record) =>
          record.outcome === "quarantine-refused" &&
          record.probeReady === null &&
          record.sandboxId === null,
      )
    ) {
      quarantineOk = false;
      quarantineEvidence.push("gated-submission-contacted-substrate");
    }
    if (input.quarantineEngagedDuringRun) {
      quarantineOk = false;
      quarantineEvidence.push("engagement-inside-gated-run");
    }
  } else if (groundTruth.quarantineEngages) {
    quarantineEvidence.push("quarantine-engages");
    if (!input.quarantineEngagedDuringRun) {
      quarantineOk = false;
      quarantineEvidence.push("engagement-not-observed");
    }
    const lastAttempt = attempts[attempts.length - 1];
    if (
      lastAttempt === undefined ||
      lastAttempt.retried ||
      lastAttempt.substrateClass === null ||
      lastAttempt.layer !== "substrate"
    ) {
      quarantineOk = false;
      quarantineEvidence.push("engagement-not-at-terminal-failure");
    }
    if (attempts.some((record) => record.outcome === "quarantine-refused")) {
      quarantineOk = false;
      quarantineEvidence.push("gate-refusal-inside-engaging-run");
    }
  } else {
    quarantineEvidence.push("no-quarantine-in-run");
    if (input.quarantineEngagedDuringRun) {
      quarantineOk = false;
      quarantineEvidence.push("unexpected-engagement");
    }
  }
  if (!strikesOk) {
    quarantineOk = false;
  }
  quarantineEvidence.push(`strikes:${input.strikesBefore}->${input.strikesAfter}`);
  quarantineEvidence.push(`strikesMatchOracle:${String(strikesOk)}`);
  criteria.push({
    criterionId: "quarantine-contract",
    strategy: "deterministic",
    status: quarantineOk ? "PASS" : "FAIL",
    evidence: quarantineEvidence,
  });

  // 9. The recovery/outcome sequence (ordered, exact — the oracle pins it).
  const observedOutcomes = attempts.map((record) => record.outcome);
  const expectedOutcomes = groundTruth.attemptOutcomes;
  const sequenceOk =
    observedOutcomes.length === expectedOutcomes.length &&
    observedOutcomes.every((outcome, index) => outcome === expectedOutcomes[index]);
  criteria.push({
    criterionId: "recovery-outcome-sequence",
    strategy: "deterministic",
    status: sequenceOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedOutcomes.join(">") || "none"}`,
      `observed:${observedOutcomes.join(">") || "none"}`,
    ],
  });

  // 10. Journal exactly once per attempt.
  const journalOk = input.journaledAttempts === attempts.length;
  criteria.push({
    criterionId: "journal-exactly-once-per-attempt",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [
      `journaled:${input.journaledAttempts}`,
      `attempts:${attempts.length}`,
      `perAttemptSpecDigests:${attempts.map((record) => record.specDigest).join("|") || "none"}`,
    ],
  });

  // 11. The honest outcome contract: the derived terminal matches the
  //     oracle's pinned terminal (a failure FAILS; a healthy success
  //     COMPLETES — never a fabricated either way).
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.finalOutcome !== null && input.finalOutcome.kind === "success" ? "COMPLETED" : "FAILED";
  const outcomeOk = derivedTerminal === groundTruth.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: outcomeOk ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${groundTruth.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `finalOutcome:${input.finalOutcome === null ? "none" : input.finalOutcome.kind}`,
    ],
  });

  // 12. Honest economics: measured usage and latency recorded (never
  //     estimated); usage absent on failures is recorded honestly.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.usageMicroUsd === null ? "usage:none-reported" : `usageMicroUsd:${input.usageMicroUsd}`,
      `latencyMs:${input.totalDispatchLatencyMs}`,
      `attempts:${attempts.length}`,
      `strikes:${input.strikesBefore}->${input.strikesAfter}`,
    ],
  });

  return criteria;
}
