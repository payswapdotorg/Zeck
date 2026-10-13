/**
 * Tail-pacing wiring seam (executions module adapter; ACR-010 §3–§4;
 * work order PCL-002 — the existing pipeline reads its pacing from the
 * configuration HERE, additively, default-off and absence-equivalent).
 *
 * THE SEAM (the PCR-002 wiring discipline): the executions module's
 * pacing-reading point — the SINGLE place the pipeline consults the
 * declarative tail-pacing configuration (`domain/
 * tail-pacing-configuration.ts` — data, never an engine). The resolver
 * is a PASSIVE data-resolution surface: it reads the declared
 * configuration and resolves the pacing quantities (the retry delay,
 * the cooldown state and re-entry admission, the progress mode and
 * interval, the mechanics record). It decides NOTHING else: no route,
 * no plan, no execution, no verification — there is no second router,
 * planner, executor or verification service anywhere in this adapter
 * (ACR-010 §6; the E1.1 non-redundancy invariant — this is not a
 * "Retry Optimizer", it is the parameter surface the EXISTING
 * machinery reads).
 *
 * ABSENCE EQUIVALENCE (ACR-010 §4 — the default-off law): with NO
 * configuration authored (the dependency absent, or the configuration
 * undefined | null — both the absent spelling), the resolver is INERT:
 * every read returns the ABSENT verdict — no delay is read
 * (`retryDelayFor` → undefined: the caller's existing path runs
 * unchanged), no cooldown is entered (`cooldownAtDispatch` → the
 * `none` state; `admitCooldownReentry` → admissible `no-rule`), no
 * progress mode is resolved (`resolveProgress` → null: the caller's
 * existing delivery), no mechanics record is produced
 * (`progressFacts` → null). The integration proof
 * (tests/integration/tail-pacing-absence-equivalence.test.ts) pins the
 * byte-identity over the real wired stack.
 *
 * FAIL-CLOSED AT THE CONFIGURATION BOUNDARY: a PRESENT but malformed
 * configuration (unknown vocabulary, out-of-bounds value, the
 * terminal-failure-masking shape, the timeout-violating schedule) is
 * rejected typed AT CONSTRUCTION — the resolver never arms a partial
 * or invalid configuration, never silently defaults one
 * (`resolveTailPacing` in the domain throws the typed
 * `TailPacingConfigurationError` carrying the validation's reason).
 *
 * THE AMBIENT EDGES LIVE HERE AND ONLY HERE (the adapter discipline):
 * the jitter DRAW is injected by the composition root (this module
 * declares no default draw — the entropy source is the composition's
 * own, exactly like the digest port; tests inject deterministic draws
 * and the domain stays pure). No environment read, no clock, no I/O.
 */
import type { DispatchCooldownState, OutcomeFailureClass } from "../domain/outcome-latency-facts";
import type {
  CooldownDisciplineConfiguration,
  CooldownReentryAdmission,
  ProgressDeliveryConfiguration,
  ResolvedProgressDelivery,
  RetryPacingConfiguration,
  TailPacingConfiguration,
  TransportProgressCapabilities,
} from "../domain/tail-pacing-configuration";
import {
  cooldownReentryAdmission,
  cooldownStateAtDispatch,
  progressDeliveryFactsOf,
  resolveProgressDelivery,
  resolveTailPacing,
  retryBackoffDelayMs,
} from "../domain/tail-pacing-configuration";

/**
 * The pacing-reading seam the existing pipeline consults. Every read
 * is a PURE resolution over the declared configuration; the absent
 * verdicts are the byte-identical-today spellings (see the module
 * header — the seam is inert until a configuration is authored).
 */
export interface TailPacingResolver {
  /**
   * The bounded, jittered retry delay (ms) for the next retry attempt —
   * `undefined` when no retry pacing is authored (the caller's existing
   * delay path runs unchanged). The jitter draw is this seam's own
   * (composition-injected — deterministic in tests).
   */
  retryDelayFor(nextAttempt: number): number | undefined;
  /** Whether the retry pacing admits a retry for the failure class. */
  retryAdmits(failureClass: OutcomeFailureClass): boolean;
  /**
   * The cooldown state at dispatch (the PCL-01 vocabulary) — the
   * `none` state when no cooldown discipline is authored or the class
   * carries no rule.
   */
  cooldownAtDispatch(failureClass: OutcomeFailureClass, elapsedMs: number): DispatchCooldownState;
  /**
   * The explicit re-entry admission for a dispatch — admissible
   * (`no-rule`) when no cooldown discipline is authored.
   */
  admitCooldownReentry(
    failureClass: OutcomeFailureClass,
    elapsedMs: number,
  ): CooldownReentryAdmission;
  /**
   * The resolved progress delivery (mode + applied interval) — `null`
   * when no progress configuration is authored (the caller's existing
   * delivery runs unchanged).
   */
  resolveProgress(capabilities: TransportProgressCapabilities): ResolvedProgressDelivery | null;
  /**
   * THE MECHANICS RECORD (read-only consumption of the PCL-01 facts):
   * the `ProgressDeliveryFacts` block the outcome record carries —
   * `null` when no progress configuration is authored (the block is
   * absent, the byte-identical-today state).
   */
  progressFacts(
    capabilities: TransportProgressCapabilities,
    cooldownAtDispatch: DispatchCooldownState,
  ): ReturnType<typeof progressDeliveryFactsOf> | null;
  /** The armed configuration (evaluation evidence), or null when absent. */
  readonly configuration: TailPacingConfiguration | null;
}

/** The resolver's composition inputs (all explicit, never ambient). */
export interface TailPacingResolverDeps {
  /**
   * The declarative tail-pacing configuration — OPTIONAL (absent =
   * default-off = the byte-identical-today posture). A present but
   * malformed configuration fails closed at construction.
   */
  readonly configuration?: TailPacingConfiguration | null;
  /**
   * The jitter draw source ([0, 1]) — REQUIRED when retry pacing is
   * authored (the entropy source is the composition's own; never a
   * module-owned default, never an ambient randomness read here).
   */
  readonly jitterDraw?: () => number;
}

/**
 * Build the pacing-reading seam. Fail-closed at the configuration
 * boundary (a malformed configuration throws the typed
 * `TailPacingConfigurationError` naming the field and the offending
 * value — never a silent default, never a partial arm).
 */
export function createTailPacingResolver(deps: TailPacingResolverDeps): TailPacingResolver {
  const resolved = resolveTailPacing(deps.configuration);
  const armed = resolved.armed ? resolved.configuration : null;
  if (armed !== null && armed.retryPacing !== undefined && deps.jitterDraw === undefined) {
    throw new Error(
      "the tail-pacing resolver requires an injected jitterDraw when retry pacing is authored (the entropy source is the composition's own — never ambient, never module-owned)",
    );
  }
  const retryPacing: RetryPacingConfiguration | undefined =
    armed?.retryPacing !== undefined && armed.retryPacing !== null ? armed.retryPacing : undefined;
  const cooldownDiscipline: CooldownDisciplineConfiguration | undefined =
    armed?.cooldownDiscipline !== undefined && armed.cooldownDiscipline !== null
      ? armed.cooldownDiscipline
      : undefined;
  const progressDelivery: ProgressDeliveryConfiguration | undefined =
    armed?.progressDelivery !== undefined && armed.progressDelivery !== null
      ? armed.progressDelivery
      : undefined;

  return {
    configuration: armed,
    retryDelayFor(nextAttempt: number): number | undefined {
      if (retryPacing === undefined) {
        return undefined;
      }
      return retryBackoffDelayMs(retryPacing, nextAttempt, deps.jitterDraw?.() ?? 0.5);
    },
    retryAdmits(failureClass: OutcomeFailureClass): boolean {
      if (retryPacing === undefined) {
        return false;
      }
      return retryPacing.retryableFailureClasses.includes(failureClass);
    },
    cooldownAtDispatch(
      failureClass: OutcomeFailureClass,
      elapsedMs: number,
    ): DispatchCooldownState {
      return cooldownStateAtDispatch(cooldownDiscipline, failureClass, elapsedMs);
    },
    admitCooldownReentry(
      failureClass: OutcomeFailureClass,
      elapsedMs: number,
    ): CooldownReentryAdmission {
      return cooldownReentryAdmission(cooldownDiscipline, failureClass, elapsedMs);
    },
    resolveProgress(capabilities: TransportProgressCapabilities): ResolvedProgressDelivery | null {
      if (progressDelivery === undefined) {
        return null;
      }
      return resolveProgressDelivery(progressDelivery, capabilities);
    },
    progressFacts(
      capabilities: TransportProgressCapabilities,
      cooldownAtDispatch: DispatchCooldownState,
    ): ReturnType<typeof progressDeliveryFactsOf> | null {
      const resolvedProgress =
        progressDelivery === undefined
          ? null
          : resolveProgressDelivery(progressDelivery, capabilities);
      if (resolvedProgress === null) {
        return null;
      }
      return progressDeliveryFactsOf(resolvedProgress, cooldownAtDispatch);
    },
  };
}
