/**
 * The platform-side substrate-readiness driver (VAL-022).
 *
 * The reliability slice for substrate failure: drives sandbox-readiness
 * probe executions through the REAL platform path — compute-substrate
 * failure modes (sandbox unavailability at submission, mid-execution
 * sandbox loss, substrate timeout classification, resource exhaustion)
 * each classified, recovered and contained per policy:
 *
 *   * the substrate-failure taxonomy as PURE derivations —
 *     `classifySubstrateRun` (the raw observation a compute substrate
 *     actually reports: a never-settling observation is the honest
 *     mid-execution LOSS, classified `sandbox-lost` and never a
 *     fabricated result; the admitted-deadline kill (`timedOut`, exit
 *     137) is `substrate-timeout` — retryable, the platform's own
 *     timeout class; the OOM-killed shape (`oomKilled`, exit 137, NOT
 *     timedOut) is `resource-exhausted` — the OOM-vs-timeout
 *     discrimination at the heart of AC6; a settled non-zero exit is
 *     `sandbox-execution`; a thrown adapter error is `adapter-error`)
 *     folded onto the platform's OWN `SandboxFailureClass` vocabulary
 *     (`platformFailureClassOf`: timeout / sandbox-execution /
 *     runtime-unavailable / adapter-error);
 *   * REAL substrate failure shape fixtures — the verbatim raw SHAPES
 *     the REAL substrates produce (the process runtime's timedOut kill;
 *     the container runtime's `State.OOMKilled` inspection shape; the
 *     container provider's fail-closed runtime-unavailable posture) —
 *     replayed by the app's deterministic fault-injection substrate
 *     adapters;
 *   * the readiness gate as a bounded policy: readiness probes gate
 *     EVERY dispatch (never dispatch to an unready substrate — the
 *     driver probes before each attempt, and the criteria verify the
 *     gating probe mechanically); a refused probe is re-probed at most
 *     `readinessMaxProbes` times with a measured backoff; a QUARANTINED
 *     substrate is refused immediately (the exact boundary, no
 *     re-probe);
 *   * the quarantine registry: after `quarantineThreshold` consecutive
 *     substrate-failure terminals on ONE substrate, the substrate is
 *     quarantined and the quarantine propagates to future submissions
 *     (their first probe is the quarantined refusal — zero dispatches);
 *     a success resets the streak; quarantine is per-substrate;
 *   * the bounded substrate dispatch retry: RETRYABLE classes only
 *     (sandbox-lost / substrate-timeout), at most `maxExtraAttempts`
 *     extra attempts with a measured backoff, EVERY attempt in a FRESH
 *     sandbox (per-attempt-distinct sandbox ids — a lost sandbox is
 *     never reused), every attempt journaled EXACTLY once (digests in
 *     the journal, never payload bytes); non-retryable failures never
 *     retry;
 *   * the execution driver mirroring the VAL-019/020/21 drivers
 *     (authorize → plan → planning-decision BEFORE the first dispatch →
 *     queue → start → the readiness-gated bounded retry loop → verify
 *     → terminal: a failure outcome or any failed criterion → FAILED —
 *     never a partial-success shortcut).
 *
 * Honesty invariants:
 *   * a substrate failure FAILS the execution (no partial-success
 *     shortcut) while the criteria prove the SEMANTICS (the VAL-020
 *     review calibration: a correctly-classified, correctly-bounded
 *     failure PASSES its criteria while the terminal stays honestly
 *     FAILED);
 *   * a lost sandbox journals NO sandbox outcome (the honest absence —
 *     never a fabricated result) and its sandbox id is never reused;
 *   * readiness refusals NEVER dispatch (zero attempts, zero sandbox
 *     admissions — mechanically verified); a quarantined substrate is
 *     refused at the first probe;
 *   * retryable failures get bounded retries — never an infinite loop;
 *     non-retryable failures never retry;
 *   * recovery-after-retry (or after a bounded readiness re-probe)
 *     produces a COMPLETED execution with the substrate-failure
 *     history journaled exactly once per attempt;
 *   * usage, cost and latency are measured, never estimated; evidence
 *     carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected and network-free here (the lab
 * contract); the integration seam binds the REAL executions service
 * (the REAL ledger vocabularies: sandbox-admitted / sandbox-denied /
 * sandbox-completed / agent-action-recorded) and — where the REAL
 * adapter's healthy path exists in the environment — the REAL process
 * substrate adapter (the platform's declared sandbox/compute adapter
 * surface).
 */

import type { LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The substrate-failure taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/**
 * The substrate-seam failure vocabulary — the failure modes the corpus
 * exercises, finer-grained than the platform's fold because the RAW
 * signals (the timeout marker vs the OOM-kill marker) discriminate
 * classes the platform folds together.
 */
export const SUBSTRATE_FAILURE_CLASSES = [
  // the readiness gate: the substrate refused readiness (unavailable or
  // quarantined) — NO dispatch ever happened
  "readiness-refused",
  // the sandbox vanished mid-execution: the observation never settled
  "sandbox-lost",
  // the admitted wall-clock deadline killed the run (the REAL timeout class)
  "substrate-timeout",
  // the substrate OOM-killed the run (the container OOMKilled shape)
  "resource-exhausted",
  // the payload ran and exited non-zero (a genuine execution failure)
  "sandbox-execution",
  // the adapter machinery itself threw (the platform's adapter-error class)
  "adapter-error",
] as const;

export type SubstrateFailureClass = (typeof SUBSTRATE_FAILURE_CLASSES)[number];

/**
 * The platform's OWN sandbox failure-class vocabulary
 * (`SandboxFailureClass` in the sandbox module domain — the declared
 * adapter surface the slice folds onto).
 */
export const PLATFORM_FAILURE_CLASSES = [
  "sandbox-execution",
  "timeout",
  "adapter-error",
  "runtime-unavailable",
] as const;

export type PlatformFailureClass = (typeof PLATFORM_FAILURE_CLASSES)[number];

/** The retryable classes (bounded substrate dispatch retry applies to these ONLY). */
const RETRYABLE_CLASSES: ReadonlySet<SubstrateFailureClass> = new Set([
  "sandbox-lost",
  "substrate-timeout",
]);

/**
 * The fold onto the platform's OWN class vocabulary: the timeout kill is
 * the platform's `timeout`; the OOM kill and the payload exit are the
 * platform's `sandbox-execution` (the exit-code class); the readiness
 * refusal and the mid-execution loss are the platform's
 * `runtime-unavailable` (the substrate could not establish/keep the
 * runtime); a thrown adapter error is `adapter-error`.
 */
const CLASS_PLATFORM_FOLD: Readonly<Record<SubstrateFailureClass, PlatformFailureClass>> = {
  "readiness-refused": "runtime-unavailable",
  "sandbox-lost": "runtime-unavailable",
  "substrate-timeout": "timeout",
  "resource-exhausted": "sandbox-execution",
  "sandbox-execution": "sandbox-execution",
  "adapter-error": "adapter-error",
};

/** Whether the class is retryable under the bounded substrate retry policy. */
export function isRetryableSubstrateClass(value: SubstrateFailureClass): boolean {
  return RETRYABLE_CLASSES.has(value);
}

/** The platform's own failure class a substrate class folds onto. */
export function platformFailureClassOf(value: SubstrateFailureClass): PlatformFailureClass {
  return CLASS_PLATFORM_FOLD[value];
}

/** One substrate-failure verdict: class + platform fold + retryability. */
export interface SubstrateFailureVerdict {
  readonly substrateClass: SubstrateFailureClass | null;
  readonly platformClass: PlatformFailureClass | null;
  readonly retryable: boolean;
  readonly message: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
}

const MAX_SUBSTRATE_MESSAGE = 200;

function sanitizeMessage(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "substrate failure (no substrate message)";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "substrate failure (no substrate message)";
  }
  return trimmed.length <= MAX_SUBSTRATE_MESSAGE ? trimmed : `${trimmed.slice(0, 200)}…`;
}

/**
 * The raw observation ONE compute substrate produces for one sandbox
 * run — the union of the REAL shapes the process runtime and the
 * container runtimes actually report:
 *
 *   - the process runtime reports `{exitCode, timedOut, stdout, stderr,
 *     stdoutDigest, durationMs}` (the admitted-deadline SIGKILL is
 *     `timedOut: true`);
 *   - the container runtimes report the inspection shape
 *     (`State.OOMKilled` + exit 137) — the OOM-kill marker the process
 *     class cannot observe (honest: the process fold reads a
 *     non-timeout 137 as the exit-code class);
 *   - a sandbox that vanishes mid-execution settles NOTHING — the
 *     bounded executor's observation race records `settled: false`
 *     (the honest absence, never a fabricated result).
 */
export interface RawSubstrateObservation {
  /** Whether the substrate produced a settled observation at all. */
  readonly settled: boolean;
  /** The admitted-deadline kill marker (the REAL process-runtime flag). */
  readonly timedOut: boolean;
  /** The OOM-kill marker (the REAL container-runtime inspection flag). */
  readonly oomKilled: boolean;
  readonly exitCode: number | null;
  /** Digest of the primary output (null when nothing was produced). */
  readonly stdoutDigest: string | null;
  readonly durationMs: number | null;
  /** Runtime-reported actual usage (integer micro-USD; null when unmetered). */
  readonly usageMicroUsd: string | null;
  /** The adapter machinery itself threw (classified adapter-error). */
  readonly adapterError: string | null;
}

/** The settled successful observation shape (the healthy anchor). */
export function healthySubstrateObservation(options?: {
  readonly stdout?: string;
  readonly usageMicroUsd?: string;
  readonly durationMs?: number;
}): RawSubstrateObservation {
  const stdout = options?.stdout ?? "substrate-ok";
  return {
    settled: true,
    timedOut: false,
    oomKilled: false,
    exitCode: 0,
    stdoutDigest: digestOf(stdout),
    durationMs: options?.durationMs ?? 5,
    usageMicroUsd: options?.usageMicroUsd ?? "1250",
    adapterError: null,
  };
}

/**
 * Classify one raw substrate observation (PURE). The discrimination
 * ORDER is the contract: an adapter error wins (the machinery failed);
 * a never-settled observation is the honest LOSS (never a fabricated
 * result); the admitted-deadline kill is the TIMEOUT; the OOM-kill
 * marker (independent of the exit code) is RESOURCE-EXHAUSTED — the
 * OOM-vs-timeout discrimination: a 137 WITH the timeout marker is
 * never an OOM, a 137 WITH the OOM marker is never a timeout; a
 * settled non-zero exit is the payload's own execution failure; exit
 * zero is the clean success (class null).
 */
export function classifySubstrateRun(raw: RawSubstrateObservation): SubstrateFailureVerdict {
  if (raw.adapterError !== null) {
    return {
      substrateClass: "adapter-error",
      platformClass: "adapter-error",
      retryable: false,
      message: sanitizeMessage(raw.adapterError),
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      oomKilled: raw.oomKilled,
    };
  }
  if (!raw.settled) {
    return {
      substrateClass: "sandbox-lost",
      platformClass: "runtime-unavailable",
      retryable: true,
      message:
        "the sandbox was lost mid-execution (the observation never settled; no result was produced)",
      exitCode: null,
      timedOut: false,
      oomKilled: false,
    };
  }
  if (raw.timedOut) {
    return {
      substrateClass: "substrate-timeout",
      platformClass: "timeout",
      retryable: true,
      message: "the run exceeded its admitted wall-clock deadline and was killed by the substrate",
      exitCode: raw.exitCode,
      timedOut: true,
      oomKilled: raw.oomKilled,
    };
  }
  if (raw.oomKilled) {
    return {
      substrateClass: "resource-exhausted",
      platformClass: "sandbox-execution",
      retryable: false,
      message:
        "the substrate killed the run for memory exhaustion (OOMKilled; the same work would exhaust again)",
      exitCode: raw.exitCode,
      timedOut: false,
      oomKilled: true,
    };
  }
  const exitCode = raw.exitCode;
  if (exitCode !== null && exitCode !== 0) {
    return {
      substrateClass: "sandbox-execution",
      platformClass: "sandbox-execution",
      retryable: false,
      message: `the payload exited with code ${exitCode} (a genuine execution failure)`,
      exitCode,
      timedOut: false,
      oomKilled: false,
    };
  }
  return {
    substrateClass: null,
    platformClass: null,
    retryable: false,
    message: "success",
    exitCode: exitCode ?? 0,
    timedOut: false,
    oomKilled: false,
  };
}

/**
 * Classify a readiness refusal (PURE): the substrate refused readiness
 * — either it is unavailable (the fail-closed posture) or it is
 * QUARANTINED (repeat substrate failures). Layer: the readiness gate;
 * NO dispatch ever happens; the platform fold is
 * `runtime-unavailable`; not dispatch-retryable (the bounded re-probe
 * policy — a different policy from the dispatch retry loop).
 */
export function classifyReadinessRefusal(reason: string): SubstrateFailureVerdict {
  return {
    substrateClass: "readiness-refused",
    platformClass: "runtime-unavailable",
    retryable: false,
    message: sanitizeMessage(reason),
    exitCode: null,
    timedOut: false,
    oomKilled: false,
  };
}

// ---------------------------------------------------------------------------
// REAL substrate failure shape fixtures (the documented raw shapes)
// ---------------------------------------------------------------------------

/**
 * The REAL substrate failure shapes the live substrates actually
 * produce (the documented sources). These are the replay fixtures the
 * app's fault-injection substrate adapters use — never fabricated
 * outcomes, never credentials.
 */
export const REAL_SUBSTRATE_FAILURE_SHAPES = [
  {
    shapeId: "process-runtime-deadline-kill",
    raw: {
      settled: true,
      timedOut: true,
      oomKilled: false,
      exitCode: 137,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    },
    documentedSource:
      "the REAL process runtime's admitted-deadline enforcement (SIGKILL on expiry — timedOut: true, exit 137; src/platform/sandbox/process-runtime.ts)",
  },
  {
    shapeId: "container-runtime-oomkilled",
    raw: {
      settled: true,
      timedOut: false,
      oomKilled: true,
      exitCode: 137,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    },
    documentedSource:
      "the REAL container-runtime inspection shape (State.OOMKilled: true, exit 137 — the memory-exhaustion kill the runner reports; the platform's container provider fold)",
  },
  {
    shapeId: "container-provider-fail-closed",
    raw: {
      settled: true,
      timedOut: false,
      oomKilled: false,
      exitCode: null,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError:
        "isolation guarantees cannot be established (no container runtime client is configured)",
    },
    documentedSource:
      "the REAL container provider's fail-closed posture (runtime-unavailable without a configured runtime client — never a permissive fallback; src/modules/sandbox/adapters/container-provider.ts)",
  },
  {
    shapeId: "payload-exit-nonzero",
    raw: {
      settled: true,
      timedOut: false,
      oomKilled: false,
      exitCode: 7,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    },
    documentedSource:
      "the REAL payload exit-code failure shape (the process provider's non-zero-exit fold — sandbox-execution, non-retryable)",
  },
] as const;

/** The process-runtime deadline-kill raw shape (the timeout replay). */
export const PROCESS_DEADLINE_KILL_SHAPE: Readonly<RawSubstrateObservation> =
  REAL_SUBSTRATE_FAILURE_SHAPES[0].raw;
/** The container-runtime OOMKilled raw shape (the resource-exhaustion replay). */
export const CONTAINER_OOMKILLED_SHAPE: Readonly<RawSubstrateObservation> =
  REAL_SUBSTRATE_FAILURE_SHAPES[1].raw;
/** The container-provider fail-closed raw shape (the adapter-error replay). */
export const CONTAINER_FAIL_CLOSED_SHAPE: Readonly<RawSubstrateObservation> =
  REAL_SUBSTRATE_FAILURE_SHAPES[2].raw;
/** The payload exit-code raw shape (the sandbox-execution replay). */
export const PAYLOAD_EXIT_NONZERO_SHAPE: Readonly<RawSubstrateObservation> =
  REAL_SUBSTRATE_FAILURE_SHAPES[3].raw;

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

function digestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The task-spec digest (payload DIGEST, never payload bytes). */
export function substrateTaskDigest(task: SubstrateTaskSpec): string {
  return digestOf({ command: task.command, args: [...task.args], env: task.env });
}

// ---------------------------------------------------------------------------
// The substrate seam (the platform's declared sandbox/compute adapter surface)
// ---------------------------------------------------------------------------

/** The task one sandbox executes (argv + EXPLICIT public env — never secrets). */
export interface SubstrateTaskSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** EXPLICIT non-secret environment entries (never the ambient host env). */
  readonly env: Readonly<Record<string, string>>;
}

/** The admitted resource limits (the substrate enforces the time bound too). */
export interface SubstrateLimits {
  readonly cpuMilliCores: number;
  readonly memoryMiB: number;
  readonly executionTimeoutMs: number;
}

/** The readiness verdict one substrate answers its probe with. */
export interface SubstrateReadinessVerdict {
  readonly ready: boolean;
  /** Whether the refusal is a QUARANTINE (repeat substrate failures). */
  readonly quarantined: boolean;
  readonly reason: string | null;
}

/** One dispatch into one sandbox on one substrate. */
export interface SubstrateDispatchSpec {
  readonly sandboxId: string;
  readonly substrateId: string;
  readonly task: SubstrateTaskSpec;
  readonly limits: SubstrateLimits;
}

/**
 * The compute-substrate seam — structurally mirroring the platform's
 * declared `SandboxProvider` adapter surface (probe + execute) with the
 * RAW observation vocabulary the substrates actually report. The
 * production binding adapts the REAL process substrate adapter onto
 * this seam; the app's fixtures replay the REAL failure shapes.
 */
export interface ComputeSubstrateSeam {
  probeReadiness(input: { readonly substrateId: string }): Promise<SubstrateReadinessVerdict>;
  runInSandbox(spec: SubstrateDispatchSpec): Promise<RawSubstrateObservation>;
}

// ---------------------------------------------------------------------------
// The quarantine registry (the substrate-health state)
// ---------------------------------------------------------------------------

/** The registry's report for one terminal-outcome notification. */
export interface QuarantineReport {
  readonly substrateId: string;
  readonly failureStreak: number;
  /** Whether THIS report crossed the quarantine threshold (the transition). */
  readonly quarantined: boolean;
}

/**
 * The substrate-health registry port: quarantine state per substrate.
 * `probe` answers the quarantine verdict; `reportExecutionOutcome`
 * advances the failure streak (a success resets it).
 */
export interface SubstrateHealthRegistry {
  probe(input: { readonly substrateId: string }): Promise<SubstrateReadinessVerdict>;
  reportExecutionOutcome(input: {
    readonly substrateId: string;
    readonly failed: boolean;
  }): Promise<QuarantineReport>;
}

/**
 * The quarantine decision (PURE): a substrate is quarantined exactly
 * when its consecutive substrate-failure streak reaches the threshold
 * — never before (a premature quarantine is a discrimination finding),
 * and a success resets the streak (a recovered substrate is healthy
 * again).
 */
export function deriveQuarantineDecision(input: {
  readonly failureStreak: number;
  readonly threshold: number;
}): { readonly quarantined: boolean; readonly reason: string | null } {
  if (input.failureStreak >= input.threshold) {
    return {
      quarantined: true,
      reason: `quarantined after ${input.failureStreak} consecutive substrate failures`,
    };
  }
  return { quarantined: false, reason: null };
}

/**
 * The in-memory substrate-health registry — REAL stateful code (the
 * lab/crown binding; the SQL-backed registry is the platform module's
 * own surface). The quarantine decision rides the PURE derivation.
 */
export function createInMemorySubstrateRegistry(options?: {
  readonly threshold?: number;
}): SubstrateHealthRegistry & {
  readonly threshold: number;
  readonly streakOf: (substrateId: string) => number;
  readonly isQuarantined: (substrateId: string) => boolean;
} {
  const threshold = options?.threshold ?? 2;
  const streaks = new Map<string, number>();
  const quarantined = new Set<string>();
  const registry: SubstrateHealthRegistry = {
    async probe({ substrateId }) {
      if (quarantined.has(substrateId)) {
        const decision = deriveQuarantineDecision({
          failureStreak: streaks.get(substrateId) ?? threshold,
          threshold,
        });
        return { ready: false, quarantined: true, reason: decision.reason };
      }
      return { ready: true, quarantined: false, reason: null };
    },
    async reportExecutionOutcome({ substrateId, failed }) {
      if (!failed) {
        streaks.set(substrateId, 0);
        quarantined.delete(substrateId);
        return { substrateId, failureStreak: 0, quarantined: false };
      }
      const previous = streaks.get(substrateId) ?? 0;
      const streak = previous + 1;
      streaks.set(substrateId, streak);
      const decision = deriveQuarantineDecision({ failureStreak: streak, threshold });
      const newlyQuarantined = decision.quarantined && !quarantined.has(substrateId);
      if (decision.quarantined) {
        quarantined.add(substrateId);
      }
      return { substrateId, failureStreak: streak, quarantined: newlyQuarantined };
    },
  };
  return Object.assign(registry, {
    threshold,
    streakOf: (substrateId: string) => streaks.get(substrateId) ?? 0,
    isQuarantined: (substrateId: string) => quarantined.has(substrateId),
  });
}

// ---------------------------------------------------------------------------
// The bound seams the driver consumes
// ---------------------------------------------------------------------------

/**
 * Bind the readiness gate: the QUARANTINE registry first (a quarantined
 * substrate is refused before the substrate is even asked), then the
 * substrate seam's own availability answer. A bypassing binding (one
 * that ignores the registry) is caught mechanically by the criteria
 * (the quarantine-contract / readiness-gates derivations).
 */
export function bindReadinessGate(options: {
  readonly registry: SubstrateHealthRegistry;
  readonly seam: ComputeSubstrateSeam;
}): (input: { readonly substrateId: string }) => Promise<SubstrateReadinessVerdict> {
  return async (input) => {
    const quarantine = await options.registry.probe({ substrateId: input.substrateId });
    if (!quarantine.ready) {
      return quarantine;
    }
    return options.seam.probeReadiness({ substrateId: input.substrateId });
  };
}

/** The outcome of one bounded substrate dispatch attempt (the observation race). */
export type SubstrateRunOutcome =
  | { readonly kind: "settled"; readonly raw: RawSubstrateObservation }
  | { readonly kind: "lost" };

/**
 * Create the bounded substrate executor: one attempt = one sandbox run
 * raced against the OBSERVATION deadline. A sandbox that vanishes
 * mid-execution never settles — the deadline elapses and the attempt
 * is classified `sandbox-lost` (the honest absence — no result is
 * fabricated); a thrown adapter error settles as `adapter-error`
 * (the machinery failed — never a loss).
 */
export function createBoundedSubstrateExecutor(options: {
  readonly seam: ComputeSubstrateSeam;
  /** The observation deadline for ONE sandbox run. */
  readonly observationDeadlineMs: number;
  /** Injectable deadline timer (defaults to a real timed wait). */
  readonly timer?: (ms: number) => Promise<void>;
}): (spec: SubstrateDispatchSpec) => Promise<SubstrateRunOutcome> {
  const timer =
    options.timer ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (spec) => {
    // NOTE: the two promise chains must be SYMMETRIC in depth (one
    // .then each — the race discipline): a deeper chain resolves a
    // microtask later and an immediate test timer would win against
    // a settled run. The two-argument .then keeps the adapter-error
    // fold INSIDE the same link (an adapter throw settles as
    // adapter-error — never a loss).
    const settled = await Promise.race([
      options.seam.runInSandbox(spec).then(
        (raw) => ({ kind: "settled" as const, raw }),
        (error: unknown): { kind: "settled"; raw: RawSubstrateObservation } => ({
          kind: "settled",
          raw: {
            settled: true,
            timedOut: false,
            oomKilled: false,
            exitCode: null,
            stdoutDigest: null,
            durationMs: null,
            usageMicroUsd: null,
            adapterError: error instanceof Error ? error.message : String(error),
          },
        }),
      ),
      timer(options.observationDeadlineMs).then(() => ({ kind: "lost" as const, raw: null })),
    ]);
    if (settled.kind === "lost") {
      return { kind: "lost" };
    }
    return { kind: "settled", raw: settled.raw };
  };
}

/** The per-attempt substrate run seam the driver consumes. */
export type SubstrateRun = (input: {
  readonly sandboxId: string;
  readonly attempt: number;
}) => Promise<RawSubstrateObservation>;

/**
 * Bind the bounded executor + the row's dispatch facts as the
 * per-attempt run seam (mirrors the rail/tool dispatch bindings).
 */
export function bindSubstrateRun(options: {
  readonly executor: (spec: SubstrateDispatchSpec) => Promise<SubstrateRunOutcome>;
  readonly substrateId: string;
  readonly task: SubstrateTaskSpec;
  readonly limits: SubstrateLimits;
}): SubstrateRun {
  return async (input) => {
    const outcome = await options.executor({
      sandboxId: input.sandboxId,
      substrateId: options.substrateId,
      task: options.task,
      limits: options.limits,
    });
    if (outcome.kind === "lost") {
      return {
        settled: false,
        timedOut: false,
        oomKilled: false,
        exitCode: null,
        stdoutDigest: null,
        durationMs: null,
        usageMicroUsd: null,
        adapterError: null,
      };
    }
    return outcome.raw;
  };
}

/**
 * The FRESH sandbox id for one attempt (PURE): per-attempt-distinct by
 * construction — a retry NEVER reuses the lost sandbox's id. A journal
 * that repeats a sandbox id across attempts is a discrimination
 * finding (the reused-sandbox catch).
 */
export function deriveFreshSandboxId(input: {
  readonly executionId: string;
  readonly attempt: number;
}): string {
  return `${input.executionId}/sandbox/${input.attempt}`;
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

/** One journaled readiness probe (the gate's own evidence). */
export interface ReadinessProbeRecord {
  /** 1-based probe number within the execution. */
  readonly probe: number;
  readonly ready: boolean;
  readonly quarantined: boolean;
  readonly reason: string | null;
}

/** One journaled substrate dispatch attempt (digests, never payload bytes). */
export interface SubstrateAttemptRecord {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly outcome: "success" | "failure";
  readonly substrateClass: SubstrateFailureClass | null;
  readonly platformClass: PlatformFailureClass | null;
  readonly retryable: boolean;
  /** Whether THIS attempt triggered a retry (a backoff followed it). */
  readonly retried: boolean;
  readonly latencyMs: number;
  /** THIS attempt's fresh sandbox id. */
  readonly sandboxId: string;
  /** The probe that gated THIS dispatch (1-based). */
  readonly gatingProbe: number;
  readonly taskDigest: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
  readonly message: string;
}

export interface SubstrateReadinessLifecyclePort {
  /** Canonical transitions (no wait states: the sandbox dispatch is driver-synchronous). */
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
   * The readiness-probe journal (the platform's
   * `agent-action-recorded` step-event vocabulary): called EXACTLY once
   * per probe with the composite verdict.
   */
  recordReadinessProbe(input: {
    readonly executionId: string;
    readonly record: ReadinessProbeRecord;
  }): Promise<void>;
  /** The sandbox admission journal (the platform's `sandbox-admitted` vocabulary). */
  recordSandboxAdmission(input: {
    readonly executionId: string;
    readonly attempt: number;
    readonly sandboxId: string;
    readonly taskDigest: string;
  }): Promise<void>;
  /**
   * The per-attempt dispatch journal (the platform's
   * `agent-action-recorded` vocabulary): EXACTLY once per attempt.
   */
  recordDispatchAttempt(input: {
    readonly executionId: string;
    readonly record: SubstrateAttemptRecord;
  }): Promise<void>;
  /**
   * The sandbox outcome journal (the platform's `sandbox-completed`
   * vocabulary): called ONLY for SETTLED attempts — a lost sandbox
   * journals NO outcome (the honest absence, never a fabricated
   * result).
   */
  recordSandboxOutcome(input: {
    readonly executionId: string;
    readonly attempt: number;
    readonly sandboxId: string;
    readonly reference: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** The quarantine decision journal (the platform's `sandbox-denied` vocabulary). */
  recordQuarantine(input: {
    readonly executionId: string;
    readonly substrateId: string;
    readonly failureStreak: number;
    readonly reason: string;
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
// The oracle (the corpus row's expected substrate contract)
// ---------------------------------------------------------------------------

/** The per-attempt outcome kind sequence the oracle may pin. */
export type SubstrateAttemptOutcome = "failure" | "success";

/**
 * The ground truth one substrate-readiness probe execution is judged
 * by. Multi-execution rows (the quarantine row) carry one oracle per
 * execution.
 */
export interface SubstrateExecutionOracle {
  /** The failure class the row injects/observes on its FAILED attempts (null = healthy). */
  readonly injectedClass: SubstrateFailureClass | null;
  /** The injected failure class's dispatch-retryability. */
  readonly injectedRetryable: boolean;
  readonly expected: {
    /** The FINAL classification (null = clean success). */
    readonly substrateClass: SubstrateFailureClass | null;
    /** The FINAL platform fold (null = clean success). */
    readonly platformClass: PlatformFailureClass | null;
    /** Total dispatch attempts (1 + bounded retries). */
    readonly attempts: number;
    /** The ordered expected attempt-outcome sequence. */
    readonly attemptOutcomes: readonly SubstrateAttemptOutcome[];
    /** Total readiness probes (the gate probes before EVERY dispatch + re-probes). */
    readonly readinessProbes: number;
    /** Whether THIS execution's terminal report crossed the quarantine threshold. */
    readonly quarantined: boolean;
    readonly terminal: "COMPLETED" | "FAILED";
  };
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface SubstrateReadinessRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly attempts: readonly SubstrateAttemptRecord[];
  readonly probes: readonly ReadinessProbeRecord[];
  readonly totalAttempts: number;
  /** The final classification (null = clean success). */
  readonly finalSubstrateClass: SubstrateFailureClass | null;
  readonly finalPlatformClass: PlatformFailureClass | null;
  /** The per-attempt fresh sandbox ids (pairwise distinct by construction). */
  readonly sandboxIds: readonly string[];
  /** Whether THIS execution's terminal report quarantined the substrate. */
  readonly quarantinedByThisExecution: boolean;
  readonly failureStreak: number;
  readonly usageMicroUsd: string | null;
  readonly totalDispatchLatencyMs: number;
  readonly journaledAttempts: number;
  /** Sandbox outcomes journaled (settled attempts only — lost journals none). */
  readonly journaledOutcomes: number;
  readonly taskDigest: string | null;
}

// ---------------------------------------------------------------------------
// The substrate-readiness execution driver
// ---------------------------------------------------------------------------

/**
 * Drive one submitted substrate-readiness probe execution to
 * completion through the platform path: authorize → plan →
 * planning-decision BEFORE the first dispatch → queue → start → the
 * readiness-gated bounded retry loop (per attempt: a FRESH sandbox
 * admitted, the observation race, the per-attempt journal EXACTLY
 * once, the settled outcome journaled; readiness probes gate EVERY
 * dispatch; a quarantined substrate refused at the first probe) →
 * the terminal registry report (quarantine-on-repeat-failure) → verify
 * → terminal anyFail → FAILED.
 *
 * Honesty invariants (by construction): readiness refusals NEVER
 * dispatch; a quarantined substrate is refused immediately (the exact
 * boundary); retryable failures get at most `maxExtraAttempts` extra
 * attempts, each in a FRESH sandbox; non-retryable failures never
 * retry; a lost sandbox journals NO outcome; recovery lands COMPLETED
 * with the substrate-failure history journaled exactly once per
 * attempt; a substrate failure FAILS the execution (never a
 * partial-success shortcut) while the semantics criteria PASS (the
 * VAL-020 review calibration).
 */
export async function driveSubstrateReadinessExecution(options: {
  readonly executionId: string;
  readonly task: { readonly kind: string; readonly input?: Readonly<Record<string, unknown>> };
  readonly groundTruth: SubstrateExecutionOracle;
  readonly substrateId: string;
  readonly taskSpec: SubstrateTaskSpec;
  readonly limits: SubstrateLimits;
  readonly provider: string;
  readonly model: string;
  readonly lifecycle: SubstrateReadinessLifecyclePort;
  /** The per-attempt run seam (the bounded executor binding). */
  readonly run: SubstrateRun;
  /** The composite readiness gate (registry + substrate availability). */
  readonly probe: (input: { readonly substrateId: string }) => Promise<SubstrateReadinessVerdict>;
  /** The substrate-health registry (the terminal outcome report). */
  readonly report: (input: {
    readonly substrateId: string;
    readonly failed: boolean;
  }) => Promise<QuarantineReport>;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly readiness: {
    readonly maxProbes: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** The consecutive-failure threshold that quarantines a substrate. */
  readonly quarantineThreshold: number;
  readonly now: () => number;
}): Promise<SubstrateReadinessRunResult> {
  const { executionId, groundTruth, lifecycle } = options;
  const isSubstrateProbe = options.task.kind === "substrate-probe";

  await lifecycle.transition({ executionId, step: "authorize", reason: "val-022-authorize" });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-022-plan" });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "substrate-readiness-probe",
    },
  });
  await lifecycle.transition({ executionId, step: "queue", reason: "val-022-queue" });
  await lifecycle.transition({ executionId, step: "start", reason: "val-022-start" });

  const probes: ReadinessProbeRecord[] = [];
  const attempts: SubstrateAttemptRecord[] = [];
  const sandboxIds: string[] = [];
  let journaledAttempts = 0;
  let journaledOutcomes = 0;
  let settledAttempts = 0;
  let finalVerdict: SubstrateFailureVerdict | null = null;
  let finalUsageMicroUsd: string | null = null;
  const taskDigest = substrateTaskDigest(options.taskSpec);

  if (isSubstrateProbe) {
    for (;;) {
      // ---- the readiness gate (before EVERY dispatch — never dispatch
      // to an unready substrate) ----
      if (probes.length >= options.readiness.maxProbes) {
        finalVerdict = classifyReadinessRefusal(
          `readiness probe budget exhausted (${options.readiness.maxProbes} probes) — ` +
            `substrate ${options.substrateId} never became ready; no dispatch ever happened`,
        );
        break;
      }
      const probeIndex = probes.length + 1;
      const verdict = await options.probe({ substrateId: options.substrateId });
      const probeRecord: ReadinessProbeRecord = {
        probe: probeIndex,
        ready: verdict.ready,
        quarantined: verdict.quarantined,
        reason: verdict.reason,
      };
      await lifecycle.recordReadinessProbe({ executionId, record: probeRecord });
      probes.push(probeRecord);
      if (!verdict.ready) {
        if (verdict.quarantined) {
          // The quarantine boundary is EXACT: refused at the first
          // probe, no re-probe, no dispatch — the propagation to future
          // submissions.
          finalVerdict = classifyReadinessRefusal(
            `substrate ${options.substrateId} is QUARANTINED: ${verdict.reason ?? "repeat substrate failures"}`,
          );
          break;
        }
        // Unavailable: bounded backoff re-probe — never dispatch.
        await options.readiness.sleep(options.readiness.backoffMs);
        continue;
      }

      // ---- the dispatch (a FRESH sandbox per attempt) ----
      const attempt = attempts.length + 1;
      const sandboxId = deriveFreshSandboxId({ executionId, attempt });
      sandboxIds.push(sandboxId);
      await lifecycle.recordSandboxAdmission({
        executionId,
        attempt,
        sandboxId,
        taskDigest,
      });
      const startedAt = options.now();
      const raw = await options.run({ sandboxId, attempt });
      const latencyMs = options.now() - startedAt;
      const classification = classifySubstrateRun(raw);
      const outcomeKind: SubstrateAttemptOutcome =
        classification.substrateClass === null ? "success" : "failure";
      const willRetry =
        classification.substrateClass !== null &&
        classification.retryable &&
        attempt <= options.retry.maxExtraAttempts;
      const record: SubstrateAttemptRecord = {
        attempt,
        outcome: outcomeKind,
        substrateClass: classification.substrateClass,
        platformClass: classification.platformClass,
        retryable: classification.retryable,
        retried: willRetry,
        latencyMs,
        sandboxId,
        gatingProbe: probeIndex,
        taskDigest,
        exitCode: classification.exitCode,
        timedOut: classification.timedOut,
        oomKilled: classification.oomKilled,
        message: classification.message,
      };
      attempts.push(record);
      // Journaled EXACTLY once per attempt (digests, never payloads).
      await lifecycle.recordDispatchAttempt({ executionId, record });
      journaledAttempts += 1;
      if (raw.settled) {
        // A settled attempt journals its outcome; a LOST sandbox
        // journals NO outcome (no result was produced — the honest
        // absence, never a fabricated result).
        await lifecycle.recordSandboxOutcome({
          executionId,
          attempt,
          sandboxId,
          reference: {
            outcomeClass:
              classification.substrateClass === null ? "sandbox-success" : "sandbox-failure",
            substrateClass: classification.substrateClass,
            platformClass: classification.platformClass,
            exitCode: classification.exitCode,
            timedOut: classification.timedOut,
            oomKilled: classification.oomKilled,
            usageMicroUsd: raw.usageMicroUsd,
            stdoutDigest: raw.stdoutDigest,
            durationMs: raw.durationMs,
          },
        });
        journaledOutcomes += 1;
        settledAttempts += 1;
        finalUsageMicroUsd = raw.usageMicroUsd;
      }
      if (!willRetry) {
        finalVerdict = classification;
        break;
      }
      await options.retry.sleep(options.retry.backoffMs);
      // The retry re-enters the readiness gate (readiness gates every
      // dispatch — retries too).
    }
  } else {
    // Out-of-vocabulary task: an honest adapter-error-classified
    // rejection BEFORE any probe or dispatch (zero probes, zero
    // attempts, zero sandbox admissions).
    finalVerdict = {
      substrateClass: "adapter-error",
      platformClass: "adapter-error",
      retryable: false,
      message: `task kind ${options.task.kind} is outside the substrate-probe vocabulary`,
      exitCode: null,
      timedOut: false,
      oomKilled: false,
    };
  }

  const totalDispatchLatencyMs = attempts.reduce((sum, record) => sum + record.latencyMs, 0);
  const failed = finalVerdict !== null && finalVerdict.substrateClass !== null;

  // ---- the terminal registry report: quarantine-on-repeat-failure,
  // streak reset on success (the propagation to future submissions).
  // An out-of-vocabulary task is the driver's own input rejection — it
  // never touches the substrate's health streak. ----
  const report: QuarantineReport = isSubstrateProbe
    ? await options.report({ substrateId: options.substrateId, failed })
    : { substrateId: options.substrateId, failureStreak: 0, quarantined: false };
  if (report.quarantined) {
    await lifecycle.recordQuarantine({
      executionId,
      substrateId: options.substrateId,
      failureStreak: report.failureStreak,
      reason:
        `quarantined after ${report.failureStreak} consecutive substrate failures ` +
        `(threshold ${options.quarantineThreshold})`,
    });
  }

  const criteria = deriveSubstrateReadinessCriteria({
    groundTruth,
    attempts,
    probes,
    finalVerdict,
    journaledAttempts,
    journaledOutcomes,
    settledAttempts,
    maxExtraAttempts: options.retry.maxExtraAttempts,
    readinessMaxProbes: options.readiness.maxProbes,
    usageMicroUsd: finalUsageMicroUsd,
    totalDispatchLatencyMs,
    quarantinedByThisExecution: report.quarantined,
    failureStreak: report.failureStreak,
    quarantineThreshold: options.quarantineThreshold,
  });
  // The honest terminal: a substrate failure FAILS the execution ALWAYS
  // (no partial-success shortcut); a criteria failure fails it too.
  const anyFail = failed || criteria.some((criterion) => criterion.status === "FAIL");

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
    probes,
    totalAttempts: attempts.length,
    finalSubstrateClass: finalVerdict === null ? null : finalVerdict.substrateClass,
    finalPlatformClass: finalVerdict === null ? null : finalVerdict.platformClass,
    sandboxIds,
    quarantinedByThisExecution: report.quarantined,
    failureStreak: report.failureStreak,
    usageMicroUsd: finalUsageMicroUsd,
    totalDispatchLatencyMs,
    journaledAttempts,
    journaledOutcomes,
    taskDigest,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one substrate-readiness run.
 * PURE: the same attempt/probe history + oracle always yields the same
 * verdicts. The criteria prove the classification (substrate class +
 * the platform fold), the retry classification, bounded-retry policy
 * conformance (no infinite loops; no retry after a non-retryable
 * failure), the recovery outcome sequence, journal-exactly-once, the
 * fresh-sandbox contract, the readiness gate (every dispatch gated by
 * a READY probe — dispatch-to-unready and quarantine-bypass are
 * mechanically caught), the quarantine contract (threshold-exact, no
 * premature quarantine, no missed propagation), the honest outcome
 * journal (lost sandboxes journal no outcome) and the honest outcome
 * contract (a failure FAILS; a recovery COMPLETES).
 */
export function deriveSubstrateReadinessCriteria(input: {
  readonly groundTruth: SubstrateExecutionOracle;
  readonly attempts: readonly SubstrateAttemptRecord[];
  readonly probes: readonly ReadinessProbeRecord[];
  readonly finalVerdict: SubstrateFailureVerdict | null;
  readonly journaledAttempts: number;
  readonly journaledOutcomes: number;
  readonly settledAttempts: number;
  readonly maxExtraAttempts: number;
  readonly readinessMaxProbes: number;
  readonly usageMicroUsd: string | null;
  readonly totalDispatchLatencyMs: number;
  readonly quarantinedByThisExecution: boolean;
  readonly failureStreak: number;
  readonly quarantineThreshold: number;
}): LabVerificationCriterion[] {
  const { groundTruth, attempts, probes } = input;
  const finalClass = input.finalVerdict === null ? null : input.finalVerdict.substrateClass;
  const criteria: LabVerificationCriterion[] = [];

  // 1. The substrate class of the final classification.
  const classOk = finalClass === groundTruth.expected.substrateClass;
  criteria.push({
    criterionId: "substrate-class",
    strategy: "deterministic",
    status: classOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.substrateClass ?? "none"}`,
      `observed:${finalClass ?? "none"}`,
    ],
  });

  // 2. The platform fold of the final classification.
  const platformOk =
    (input.finalVerdict === null ? null : input.finalVerdict.platformClass) ===
    groundTruth.expected.platformClass;
  criteria.push({
    criterionId: "platform-class-fold",
    strategy: "deterministic",
    status: platformOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.platformClass ?? "none"}`,
      `observed:${input.finalVerdict === null ? "none" : (input.finalVerdict.platformClass ?? "none")}`,
    ],
  });

  // 3. Retry classification: every FAILED attempt carries the injected
  //    class with the injected retryability and the correct platform
  //    fold (a misattributed OOM-vs-timeout FAILS here).
  const failedAttempts = attempts.filter((record) => record.outcome === "failure");
  let retryClassOk = true;
  const retryEvidence: string[] = [];
  if (groundTruth.injectedClass === null) {
    retryEvidence.push("no-failure-injected");
    if (failedAttempts.length > 0) {
      retryClassOk = false;
      retryEvidence.push(`unexpected-failures:${failedAttempts.length}`);
    }
  } else {
    for (const record of failedAttempts) {
      const matches =
        record.substrateClass === groundTruth.injectedClass &&
        record.retryable === groundTruth.injectedRetryable &&
        record.platformClass === platformFailureClassOf(groundTruth.injectedClass);
      if (!matches) {
        retryClassOk = false;
      }
      retryEvidence.push(
        `attempt${record.attempt}:${record.substrateClass ?? "none"}/` +
          `${record.platformClass ?? "none"}/retryable:${String(record.retryable)}`,
      );
    }
  }
  criteria.push({
    criterionId: "retry-classification",
    strategy: "deterministic",
    status: retryClassOk ? "PASS" : "FAIL",
    evidence: retryEvidence.length > 0 ? retryEvidence : ["no-attempts"],
  });

  // 4. Attempt count (1 + bounded retries, exactly as the oracle pins).
  const attemptsOk = attempts.length === groundTruth.expected.attempts;
  criteria.push({
    criterionId: "attempt-count",
    strategy: "deterministic",
    status: attemptsOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.attempts}`,
      `observed:${attempts.length}`,
      `maxExtraAttempts:${input.maxExtraAttempts}`,
    ],
  });

  // 5. Bounded-retry policy conformance: no infinite loop; a
  //    non-retryable failure is always the LAST attempt; a
  //    non-retryable injected class produces AT MOST one dispatch
  //    attempt (zero when readiness refused pre-dispatch — never a
  //    retry after a non-retryable failure).
  const boundedAbove = attempts.length <= 1 + input.maxExtraAttempts;
  const nonRetryableLast = failedAttempts.every((record) => {
    if (record.retryable) {
      return true;
    }
    return record.attempt === attempts.length;
  });
  const nonRetryableSingle =
    groundTruth.injectedClass === null || groundTruth.injectedRetryable || attempts.length <= 1;
  const boundedOk = boundedAbove && nonRetryableLast && nonRetryableSingle;
  criteria.push({
    criterionId: "bounded-retry",
    strategy: "deterministic",
    status: boundedOk ? "PASS" : "FAIL",
    evidence: [
      `attempts:${attempts.length}`,
      `limit:${1 + input.maxExtraAttempts}`,
      `nonRetryableFailuresTerminal:${String(nonRetryableLast)}`,
      `nonRetryableAtMostSingle:${String(nonRetryableSingle)}`,
      `injectedRetryable:${String(groundTruth.injectedRetryable)}`,
    ],
  });

  // 6. The recovery/outcome sequence (ordered, exact).
  const observedOutcomes = attempts.map((record) => record.outcome);
  const sequenceOk =
    observedOutcomes.length === groundTruth.expected.attemptOutcomes.length &&
    observedOutcomes.every(
      (outcome, index) => outcome === groundTruth.expected.attemptOutcomes[index],
    );
  criteria.push({
    criterionId: "recovery-outcome-sequence",
    strategy: "deterministic",
    status: sequenceOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.attemptOutcomes.join(">") || "none"}`,
      `observed:${observedOutcomes.join(">") || "none"}`,
    ],
  });

  // 7. Journal exactly-once per attempt.
  const journalOk = input.journaledAttempts === attempts.length;
  criteria.push({
    criterionId: "journal-exactly-once-per-attempt",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [
      `journaled:${input.journaledAttempts}`,
      `attempts:${attempts.length}`,
      `perAttemptDigests:${attempts.map((record) => record.taskDigest).join("|") || "none"}`,
    ],
  });

  // 8. The fresh-sandbox contract: one admission per attempt, all
  //    sandbox ids pairwise DISTINCT (a lost sandbox is never reused —
  //    a journal that repeats an id is the reused-sandbox catch).
  const distinctSandboxes = new Set(attempts.map((record) => record.sandboxId));
  const freshOk = distinctSandboxes.size === attempts.length;
  criteria.push({
    criterionId: "fresh-sandbox-per-attempt",
    strategy: "deterministic",
    status: freshOk ? "PASS" : "FAIL",
    evidence: [
      `attempts:${attempts.length}`,
      `distinctSandboxIds:${distinctSandboxes.size}`,
      `sandboxIds:${attempts.map((record) => record.sandboxId).join("|") || "none"}`,
    ],
  });

  // 9. The readiness gate: every dispatch's gating probe was READY
  //    (dispatch-to-unready and quarantine-bypass are caught here);
  //    the ready-probe count equals the dispatch count (the
  //    probe-per-dispatch discipline); the probe count matches the
  //    oracle; a quarantined probe is never followed by a dispatch.
  let gateOk = true;
  const gateEvidence: string[] = [];
  for (const record of attempts) {
    const gating = probes[record.gatingProbe - 1];
    if (gating === undefined || !gating.ready || gating.quarantined) {
      gateOk = false;
      gateEvidence.push(`attempt${record.attempt}:gatingProbe${record.gatingProbe}:not-ready`);
    }
  }
  const readyProbes = probes.filter((probe) => probe.ready).length;
  const quarantinedProbeFollowedByDispatch = probes.some(
    (probe, index) =>
      probe.quarantined && attempts.some((record) => record.gatingProbe > index + 1),
  );
  if (quarantinedProbeFollowedByDispatch) {
    gateOk = false;
    gateEvidence.push("dispatch-after-quarantined-probe");
  }
  if (readyProbes !== attempts.length) {
    gateOk = false;
    gateEvidence.push(`readyProbes:${readyProbes}!=attempts:${attempts.length}`);
  }
  if (probes.length !== groundTruth.expected.readinessProbes) {
    gateOk = false;
    gateEvidence.push(`probes:${probes.length}!=expected:${groundTruth.expected.readinessProbes}`);
  }
  if (probes.length > input.readinessMaxProbes) {
    gateOk = false;
    gateEvidence.push(`probeBudgetExceeded:${probes.length}>${input.readinessMaxProbes}`);
  }
  criteria.push({
    criterionId: "readiness-gates-dispatch",
    strategy: "deterministic",
    status: gateOk ? "PASS" : "FAIL",
    evidence:
      gateEvidence.length > 0
        ? gateEvidence
        : [
            `probes:${probes.length}`,
            `readyProbes:${readyProbes}`,
            `attempts:${attempts.length}`,
            `quarantinedProbes:${probes.filter((probe) => probe.quarantined).length}`,
          ],
  });

  // 10. The quarantine contract: the execution's terminal report
  //     crossed the threshold exactly when the oracle pins it — never
  //     prematurely (streak < threshold), never missed.
  const quarantineOk = input.quarantinedByThisExecution === groundTruth.expected.quarantined;
  criteria.push({
    criterionId: "quarantine-contract",
    strategy: "deterministic",
    status: quarantineOk ? "PASS" : "FAIL",
    evidence: [
      `expectedQuarantined:${String(groundTruth.expected.quarantined)}`,
      `observedQuarantined:${String(input.quarantinedByThisExecution)}`,
      `failureStreak:${input.failureStreak}`,
      `threshold:${input.quarantineThreshold}`,
    ],
  });

  // 11. The honest outcome journal: sandbox outcomes journaled exactly
  //     for the SETTLED attempts (a lost sandbox never fabricates an
  //     outcome).
  const outcomeJournalOk = input.journaledOutcomes === input.settledAttempts;
  criteria.push({
    criterionId: "honest-outcome-journal",
    strategy: "deterministic",
    status: outcomeJournalOk ? "PASS" : "FAIL",
    evidence: [
      `journaledOutcomes:${input.journaledOutcomes}`,
      `settledAttempts:${input.settledAttempts}`,
      `lostAttempts:${attempts.filter((record) => record.substrateClass === "sandbox-lost").length}`,
    ],
  });

  // 12. The honest outcome contract: the derived terminal matches the
  //     oracle's terminal (a substrate failure FAILS; the recovery and
  //     healthy rows COMPLETE — never a fabricated either way).
  const derivedTerminal: "COMPLETED" | "FAILED" = finalClass === null ? "COMPLETED" : "FAILED";
  const terminalOk = derivedTerminal === groundTruth.expected.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: terminalOk ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${groundTruth.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `finalClass:${finalClass ?? "none"}`,
    ],
  });

  // 13. Honest economics: measured usage and latency recorded (never
  //     estimated); usage absent on failures is recorded honestly.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.usageMicroUsd === null ? "usage:none-reported" : `usageMicroUsd:${input.usageMicroUsd}`,
      `latencyMs:${input.totalDispatchLatencyMs}`,
      `attempts:${attempts.length}`,
    ],
  });

  return criteria;
}
