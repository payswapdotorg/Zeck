/**
 * The evaluated configurations (PCL-003 — the pre-registered arms).
 *
 * TWO ARMS, the same corpus, the same arm-agnostic deterministic draws
 * (the transport's draws key on stream key, attempt and provider —
 * never on the arm): only the PACING differs, so the comparison
 * isolates the tail mechanics exactly.
 *
 * - `baseline-today`: the capstone's own recorded posture, QUOTED from
 *   the PPR-027 machinery (read-only): ONE policy retry failing over
 *   to the next supply in the round-robin (compose.ts's traced
 *   `maxRetryAttempts: 1` / `retry-once-next-supply` defaults), a 5 ms
 *   inter-attempt wait (compose.ts's `retryCooldownMs ?? 5` default),
 *   and the sweep driver's declared compressed 10 ms terminal poll
 *   interval (driver.ts's `pollIntervalMs ?? 10` default). NO pacing
 *   configuration is authored — the PCL-002 plane is absent, exactly
 *   the capstone's wired state (the PCL-002 absence-equivalence proof's
 *   own posture: nothing in the stack addresses the pacing plane).
 *
 * - `tail-tuned-v1`: the PCL-002 declarative tail-pacing configuration
 *   ARMED through the pacing seam — the tail-tuning posture the
 *   evaluation exists to judge: a TIGHT linear backoff (base 1 ms —
 *   the recovery pace beats the capstone's flat 5 ms wait; ceiling
 *   5 ms; zero jitter — the observable-and-replayable evidence
 *   discipline, the domain's own documented spelling), a two-retry
 *   budget over the SYNTHETIC WORLD'S OWN retryable fault classes
 *   (the transport declares rate-limit and timeout retryable and
 *   provider-unavailable NON-retryable — the tuned arm admits exactly
 *   the transport's retryable classes in the PCL-01 taxonomy, the
 *   same truth the capstone's recovery plane consumed), failure-class-aware provider cooldowns with explicit
 *   expiry re-entry (a throttle cools differently than a 5xx: 2500 ms
 *   vs 500 ms, a timeout 1000 ms — held re-entry means the retry FAILS
 *   OVER, and the provider stays diverted for subsequent dispatches on
 *   the replay's virtual clock), event-stream-else-polled progress
 *   delivery (the synthetic supplies declare no event-stream support —
 *   polled is the honest fallback at the declared 50 ms interval, the
 *   pacing surface's own minimum), under the declared timeout contract
 *   (30 s per attempt — the capstone driver's own per-execution
 *   latency constraint, 120 s logical-dispatch budget). The fail-closed
 *   preservation gate runs at construction (the timeout/terminal
 *   laws are not tunable away).
 *
 * THE HONEST DISCLOSURES (the explicit-basis discipline): every arm
 * declares its basis; the tuned arm's progress-delivery dimension is
 * RECORDED, never latency-differentiated, in this replay (the
 * synthetic supplies are synchronous request/response draws — they
 * model no progress-observation delay; the event-stream and poll-
 * quantization effects are operator-era live questions, never
 * backfilled). The synthetic supplies' closed fault vocabulary maps to
 * the PCL-001 failure taxonomy by the DECLARED mapping below (rate-
 * limit → provider-throttle, timeout → provider-timeout,
 * provider-unavailable → provider-5xx — the same caller-side mapping
 * discipline the capstone's compose layer uses for the recovery
 * plane's signals).
 */

import type { OutcomeFailureClass } from "./facts";
import type { TailPacingConfiguration } from "./pacing";

/** The arm ids (the pre-registered comparison). */
export type ArmId = "baseline-today" | "tail-tuned-v1";

/** The closed synthetic-supply fault vocabulary → the PCL-001 failure taxonomy (declared). */
export const FAILURE_CLASS_OF_SUPPLY_FAULT: Readonly<Record<string, OutcomeFailureClass>> = {
  "rate-limit": "provider-throttle",
  timeout: "provider-timeout",
  "provider-unavailable": "provider-5xx",
};

/** The neutral model slug of a synthetic supply surface (the modality class is the transport's per-surface identity). */
export function syntheticModelOfClass(modalityClass: string): string {
  return modalityClass;
}

/** The capstone's quoted baseline posture (read-only, from the PPR-027 machinery's own defaults). */
export interface BaselinePosture {
  /** compose.ts's traced recovery default: ONE policy retry. */
  readonly policyRetryLimit: 1;
  /** compose.ts's `retryCooldownMs ?? 5` default (ms). */
  readonly interAttemptWaitMs: 5;
  /** The sweep driver's declared compressed terminal poll interval (ms). */
  readonly driverPollIntervalMs: 10;
}

/** The capstone's recorded posture, quoted verbatim from the PPR-027 machinery. */
export const BASELINE_POSTURE: BaselinePosture = {
  policyRetryLimit: 1,
  interAttemptWaitMs: 5,
  driverPollIntervalMs: 10,
};

/** The baseline arm: no pacing configuration authored (the capstone's wired state). */
export const BASELINE_ARM: {
  readonly armId: "baseline-today";
  readonly label: string;
  readonly basis: string;
  readonly posture: BaselinePosture;
  readonly pacing: null;
} = {
  armId: "baseline-today",
  label:
    "the capstone's recorded posture (ONE policy retry, failover to the next supply, 5 ms wait, polled 10 ms driver interval) — no pacing configuration authored (synthetic-supply, synthetic-cost, synthetic-latency)",
  basis:
    "quoted read-only from the PPR-027 machinery's own defaults (experiments/ppr-027/compose.ts: maxRetryAttempts 1, retry-once-next-supply, retryCooldownMs 5; experiments/ppr-027/driver.ts: pollIntervalMs 10)",
  posture: BASELINE_POSTURE,
  pacing: null,
};

/**
 * The tuned arm's declarative tail-pacing configuration (the PCL-002
 * surface): the tail-tuning posture under evaluation. THE DESIGN
 * PRINCIPLE (first principles, declared before the committed run): the
 * tail mechanics are the PACING — how retries are paced, where they
 * are re-addressed, and how progress is delivered — NOT a deeper
 * retry budget (a budget extension is a resolution play, not a tail
 * play; the gate exists to refuse exactly that trade). The tuned arm
 * therefore holds the retry budget at the traced posture (ONE retry)
 * and tunes everything else: a tight linear backoff, the
 * class-aware cooldown diversion, the declared timeout contract. The
 * preservation gate's arithmetic: (1 + 1) * 30_000 + 1 * 5 = 60_005
 * <= 120_000 ✓; the polling interval 50 <= the attempt timeout
 * 30_000 ✓; no terminal class is retryable ✓.
 */
export const TUNED_PACING_CONFIGURATION: TailPacingConfiguration = {
  version: 1,
  retryPacing: {
    maxRetries: 1,
    backoff: { shape: "linear", baseMs: 1, ceilingMs: 5, jitterFraction: 0 },
    retryableFailureClasses: ["provider-throttle", "provider-timeout", "connection-error"],
  },
  cooldownDiscipline: {
    rules: [
      { failureClass: "provider-throttle", cooldownMs: 2_500, reentry: "expiry" },
      { failureClass: "provider-5xx", cooldownMs: 500, reentry: "expiry" },
      { failureClass: "provider-timeout", cooldownMs: 1_000, reentry: "expiry" },
    ],
  },
  progressDelivery: {
    preference: "event-stream-else-polled",
    pollingIntervalMs: 50,
  },
  timeoutContract: {
    attemptTimeoutMs: 30_000,
    dispatchBudgetMs: 120_000,
  },
};

/** The tuned arm: the PCL-002 configuration armed through the pacing seam. */
export const TUNED_ARM: {
  readonly armId: "tail-tuned-v1";
  readonly label: string;
  readonly basis: string;
  readonly posture: null;
  readonly pacing: TailPacingConfiguration;
} = {
  armId: "tail-tuned-v1",
  label:
    "the PCL-002 declarative tail-pacing configuration armed through the pacing seam (tight linear backoff, two-retry budget, failure-class-aware cooldowns with expiry re-entry, event-stream-else-polled progress at the declared interval, declared timeout contract) (synthetic-supply, synthetic-cost, synthetic-latency)",
  basis:
    "the PCL-002 declarative configuration (src/modules/executions/domain/tail-pacing-configuration.ts — the typed, closed, versioned pacing DATA), consumed through the app-local projection pinned in-suite against the real plane",
  posture: null,
  pacing: TUNED_PACING_CONFIGURATION,
};

/** The evaluated arms in order. */
export const EVALUATED_ARMS: readonly (typeof BASELINE_ARM | typeof TUNED_ARM)[] = [
  BASELINE_ARM,
  TUNED_ARM,
];

/** The synthetic transports' own progress capability facts (the ACR-009 pattern: the transport's own truth). */
export const SYNTHETIC_TRANSPORT_CAPABILITIES = { eventStream: false } as const;

/** The synthetic supplies declare no event-stream support — the honest fallback is polled everywhere. */
export const SYNTHETIC_TRANSPORT_CAPABILITY_BASIS =
  "the PPR-027 synthetic supplies are synchronous request/response transports (experiments/ppr-027/transport.ts declares no event-stream capability) — eventStream: false is the transport's own typed capability truth";
