/**
 * The substrate-failure application's deterministic fault-injection
 * fixtures (VAL-022, AC2).
 *
 * Fake substrate adapters replaying the REAL failure shapes the
 * platform's substrate family produces — the observation bodies are
 * structurally the REAL `SandboxExecutionObservation` contract with the
 * platform's own failure tokens, and the bounded output facts are the
 * ones the substrate's own machinery reports:
 *
 *   * the PROCESS runtime's success shape (exitCode 0, stdout, stderr,
 *     durationMs, the sha256 outputDigest, usage "0") — verbatim the
 *     REAL `ProcessSandboxProvider` success observation;
 *   * the PROCESS runtime's genuine deadline timeout (its own timer
 *     fired: `timeout` token, retryable, `deadlineElapsed: true` — the
 *     REAL provider reports timeout ONLY when its timer fired);
 *   * the CONTAINER family's OOM kill surfacing MISLABELED as a
 *     timeout (exitCode 137 — 128+SIGKILL — with `oomKilled: true` and
 *     `deadlineElapsed: false`: the resource manager killed the
 *     sandbox BEFORE the deadline; an adapter guessing "timeout" from
 *     the kill alone is the documented misattribution the classifier
 *     must fix);
 *   * the E2B/DAYTONA family's mid-execution sandbox loss (the
 *     `adapter-error` token the platform's own dispatch wrapper maps a
 *     THROWN closed-sandbox error to, carrying the `sandboxLost: true`
 *     evidence in the bounded output);
 *   * the task's own non-zero exit inside a healthy sandbox (the
 *     `sandbox-execution` token, exitCode 2);
 *   * the readiness refusals the substrate family's own capacity/
 *     warm-pool machinery produces (`not-ready` with a reason).
 *
 * Every adapter is script-driven (probe + execute sequences advance per
 * call, STICKING at the last step), records every probe and every
 * executed runtime spec (the spy surface the discrimination tests
 * assert zero-contact guarantees with), and the substrate world wires
 * the shared plane: the adapters, the strike/quarantine state, the
 * pinned injectable clock and the pinned policy. The REAL process
 * substrate binding (the healthy path verified live where the adapter
 * exists) lives in the integration seam, never here.
 */

import { createHash } from "node:crypto";
import {
  freshSubstrateState,
  type SubstrateAdapter,
  type SubstrateObservation,
  type SubstratePlane,
  type SubstrateRuntimeSpec,
} from "../../platform/substrate-failure";

// ---------------------------------------------------------------------------
// The REAL failure-shape observation bodies (the replay fixtures)
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The REAL process-substrate success observation (ProcessSandboxProvider, verbatim shape). */
export function processSuccessObservation(
  stdout: string,
  durationMs: number,
): SubstrateObservation {
  return {
    outcomeClass: "sandbox-success",
    // The REAL runtime digests stdout with sha256; the replay digest is
    // the same sha256-of-stdout form (a digest, never the payload bytes).
    outputDigest: sha256Hex(stdout),
    output: { exitCode: 0, stdout, stderr: "", durationMs },
    usageMicroUsd: "0",
    failure: null,
  };
}

/**
 * The REAL process-substrate deadline timeout: the runtime's own timer
 * fired (SIGKILL on expiry) — the `timeout` token the provider reports
 * ONLY when its timer fired, so `deadlineElapsed: true` is the fact.
 */
export function processTimeoutObservation(timeoutMs: number): SubstrateObservation {
  return {
    outcomeClass: "sandbox-failure",
    outputDigest: null,
    output: { exitCode: -1, stderr: "", deadlineElapsed: true },
    usageMicroUsd: null,
    failure: {
      failureClass: "timeout",
      message: `process exceeded its admitted timeout of ${timeoutMs}ms`,
      retryable: true,
    },
  };
}

/**
 * The CONTAINER-family OOM kill, MISLABELED as a timeout by the adapter
 * (the documented misattribution shape): the resource manager killed
 * the sandbox BEFORE the deadline — exitCode 137 (128+SIGKILL), the
 * OOMKilled verdict, the deadline NOT elapsed. The classifier must
 * derive resource-exhausted from these facts, never trust the label.
 */
export function containerOomMislabeledAsTimeoutObservation(
  memoryMiBLimit: number,
): SubstrateObservation {
  return {
    outcomeClass: "sandbox-failure",
    outputDigest: null,
    output: { exitCode: 137, oomKilled: true, deadlineElapsed: false, memoryMiBLimit },
    usageMicroUsd: null,
    failure: {
      failureClass: "timeout",
      message: `container exceeded its admitted timeout (adapter guessed from the SIGKILL; memory limit ${memoryMiBLimit}MiB)`,
      retryable: true,
    },
  };
}

/**
 * The E2B/DAYTONA-family mid-execution sandbox loss: the sandbox
 * disappeared while the task was running (closed/evicted instance) —
 * the platform's own dispatch wrapper maps the thrown closed-sandbox
 * error to the `adapter-error` token, and the bounded output carries
 * the `sandboxLost: true` evidence the substrate's error family
 * produces.
 */
export function sandboxLostMidExecutionObservation(sandboxId: string): SubstrateObservation {
  return {
    outcomeClass: "sandbox-failure",
    outputDigest: null,
    output: { sandboxLost: true, deadlineElapsed: false, closedSandboxId: sandboxId },
    usageMicroUsd: null,
    failure: {
      failureClass: "adapter-error",
      message: `sandbox ${sandboxId} was closed while the task was running (mid-execution sandbox loss)`,
      retryable: true,
    },
  };
}

/** The task's own non-zero exit inside a healthy sandbox (exit 2). */
export function taskFailureObservation(exitCode: number): SubstrateObservation {
  return {
    outcomeClass: "sandbox-failure",
    outputDigest: null,
    output: { exitCode, stderr: "the probe task failed deliberately (non-zero exit)" },
    usageMicroUsd: null,
    failure: {
      failureClass: "sandbox-execution",
      message: `process exited with code ${exitCode}`,
      retryable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The script-driven substrate (probe + execute sequences, sticky last step)
// ---------------------------------------------------------------------------

/** One scripted probe step. */
export type ProbeStep = "ready" | "not-ready";

/** One scripted execute step (a scenario key the builder maps to the REAL shape). */
export type ExecuteStep =
  | "success"
  | "timeout"
  | "oom-mislabeled-timeout"
  | "lost"
  | "task-failure";

/** The scenario ids the fault-injection substrate understands. */
export type SubstrateScenario = ExecuteStep;

/** The scripted adapter's recorded calls (the spy surface). */
export interface SubstrateCallLog {
  probes: { count: number; ready: boolean[] };
  executes: { count: number; specs: SubstrateRuntimeSpec[] };
}

/** Build the REAL-shaped observation for one scripted execute step. */
export function observationForStep(
  step: ExecuteStep,
  spec: SubstrateRuntimeSpec,
): SubstrateObservation {
  switch (step) {
    case "success":
      return processSuccessObservation("substrate-ok", 12);
    case "timeout":
      return processTimeoutObservation(spec.limits?.executionTimeoutMs ?? 30_000);
    case "oom-mislabeled-timeout":
      return containerOomMislabeledAsTimeoutObservation(spec.limits?.memoryMiB ?? 256);
    case "lost":
      return sandboxLostMidExecutionObservation(spec.sandboxId);
    case "task-failure":
      return taskFailureObservation(2);
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled execute step ${String(exhaustive)}`);
    }
  }
}

/**
 * The scripted substrate adapter: replays the probe/execute scripts in
 * order, STICKING at the last step when a script runs out (the
 * persistent-failure posture). Every call is recorded (the spy surface
 * the discrimination tests assert zero-contact guarantees with).
 */
export function createScriptedSubstrate(options: {
  readonly probeScript?: readonly ProbeStep[];
  readonly executeScript?: readonly ExecuteStep[];
}): { readonly adapter: SubstrateAdapter; readonly calls: SubstrateCallLog } {
  const probeScript = options.probeScript ?? ["ready"];
  const executeScript = options.executeScript ?? ["success"];
  const calls: SubstrateCallLog = {
    probes: { count: 0, ready: [] },
    executes: { count: 0, specs: [] },
  };
  const adapter: SubstrateAdapter = {
    async probeReadiness() {
      const index = Math.min(calls.probes.count, probeScript.length - 1);
      const step = probeScript[index] ?? "ready";
      calls.probes.count += 1;
      calls.probes.ready.push(step === "ready");
      if (step === "ready") {
        return { ready: true, reason: null };
      }
      return {
        ready: false,
        reason: "substrate capacity exhausted (no warm sandbox available at submission)",
      };
    },
    async execute(spec) {
      const index = Math.min(calls.executes.count, executeScript.length - 1);
      const step = executeScript[index] ?? "success";
      calls.executes.count += 1;
      calls.executes.specs.push(spec);
      return observationForStep(step, spec);
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// The substrate world (the shared plane: adapters + state + clock + policy)
// ---------------------------------------------------------------------------

/** The pinned substrate-failure policy the corpus oracles assume. */
export const SUBSTRATE_POLICY = {
  /** TWO terminal substrate-layer submission failures engage the quarantine. */
  quarantineThreshold: 2,
  /** The quarantine cool-down window (the injectable clock advances past it). */
  quarantineCoolDownMs: 60_000,
} as const;

/** The pinned clock (deterministic epoch; advanced explicitly by the driving loop). */
export function createPinnedClock(startEpochMs = 1_000_000): {
  nowMs(): number;
  advance(ms: number): void;
} {
  let now = startEpochMs;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

/**
 * Create the deterministic substrate world for one corpus row: the
 * scripted adapter (bound to the `process` kind — the platform's own
 * environment vocabulary), the shared strike/quarantine state, the
 * pinned clock and the pinned policy. The `container` kind is left
 * UNWIRED unless explicitly scripted (the unwired-substrate row rides
 * the registry's fail-closed posture).
 */
export function createSubstrateWorld(options: {
  readonly probeScript?: readonly ProbeStep[];
  readonly executeScript?: readonly ExecuteStep[];
  readonly wireContainer?: boolean;
  readonly startEpochMs?: number;
}): {
  readonly plane: SubstratePlane;
  readonly calls: SubstrateCallLog;
  readonly clock: { nowMs(): number; advance(ms: number): void };
} {
  const { adapter, calls } = createScriptedSubstrate({
    probeScript: options.probeScript,
    executeScript: options.executeScript,
  });
  const adapters = new Map<string, SubstrateAdapter>([["process", adapter]]);
  if (options.wireContainer === true) {
    adapters.set("container", adapter);
  }
  const clock = createPinnedClock(options.startEpochMs);
  const state = freshSubstrateState();
  const plane: SubstratePlane = {
    adapterFor: (kind) => adapters.get(kind) ?? null,
    state,
    policy: {
      quarantineThreshold: SUBSTRATE_POLICY.quarantineThreshold,
      quarantineCoolDownMs: SUBSTRATE_POLICY.quarantineCoolDownMs,
    },
    clock,
  };
  return { plane, calls, clock };
}
