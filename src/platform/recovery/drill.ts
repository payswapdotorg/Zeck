/**
 * The recovery-drill runner (platform recovery plane; WORK-048 / D-07).
 *
 * A drill is a SEQUENTIAL, TIMED, VERIFIED recovery procedure: each
 * phase is an operator-provided action over the REAL infrastructure
 * (PostgreSQL, artifact stores, transports — wired by the composition
 * root); the runner supplies the discipline the evidence contract
 * demands:
 *
 *  - exact-revision binding (the drill record names its revision);
 *  - per-phase timing with deterministic clocks;
 *  - fail-closed recovery declaration (`recovered` is true ONLY when
 *    every phase completed without error — a verification phase that
 *    fails marks the WHOLE drill not-recovered; incomplete evidence
 *    never becomes a PASS);
 *  - measured RTO (loss instant → all gates green) and measured RPO
 *    (loss instant − last consistent recovery point), reported even
 *    when they breach the target (honesty over comfort);
 *  - bounded evidence: phase names, errors and details are bounded
 *    strings — no payload leakage, no secrets (the drill vocabulary
 *    carries no credential concept at all).
 *
 * The runner never touches domain modules: phases are closures over
 * the owning machinery (restore engine, dispatcher, fabric, seams),
 * exactly like the deploy CLIs compose platform pieces.
 */

import type { DrillPhaseReport, RecoveryDrillReport } from "./rto-rpo";

/** The drill clock (deterministic in tests; wall clock in tools). */
export interface DrillClock {
  now(): Date;
}

/** One drill phase (an executable, timed recovery step). */
export interface DrillPhaseSpec {
  /** Short stable phase name (e.g. "authority-restore"). */
  readonly name: string;
  /** Bounded human description (operator runbook cross-reference). */
  readonly description?: string;
  /**
   * The phase action. A thrown error fails the phase (and therefore
   * the drill): recovery failures are typed exceptions, never silent.
   */
  readonly action: () => Promise<void>;
}

export interface DrillScenarioInput {
  /** Stable scenario id (e.g. "authority-loss"). */
  readonly scenarioId: string;
  /** The environment the drill executes against. */
  readonly environment: string;
  /** The exact Git revision the drill runs at. */
  readonly revision: string;
  /**
   * The instant of simulated infrastructure loss (RTO/RPO anchor).
   * After the drill starts, this is in the past.
   */
  readonly lossAt: Date;
  /**
   * The last consistent recovery point (RPO anchor) — for the
   * logical-backup procedure, the backup's creation instant. Null
   * when the scenario cannot lose authoritative data by construction.
   */
  readonly lastConsistentPointAt: Date | null;
  readonly phases: readonly DrillPhaseSpec[];
}

const MAX_PHASE_NAME = 100;
const MAX_DESCRIPTION = 300;
const MAX_ERROR_LENGTH = 500;

function bounded(value: string, bound: number): string {
  return value.length <= bound ? value : value.slice(0, bound);
}

/**
 * Run one recovery drill. The runner executes phases in order, stops
 * at the first failure (fail-closed: a failed restore phase never
 * runs the replay phases), measures RTO/RPO, and returns the bounded
 * evidence record.
 */
export async function runRecoveryDrill(
  input: DrillScenarioInput,
  clock: DrillClock,
): Promise<RecoveryDrillReport> {
  if (input.phases.length === 0) {
    // A drill without phases cannot verify anything — that is a
    // configuration error, not an empty pass.
    throw new Error("a recovery drill requires at least one phase (empty drills cannot verify)");
  }
  const startedAt = clock.now();
  const phases: DrillPhaseReport[] = [];
  let recovered = true;

  for (const phase of input.phases) {
    const phaseStart = clock.now();
    try {
      await phase.action();
      const phaseEnd = clock.now();
      phases.push(
        Object.freeze({
          name: bounded(phase.name, MAX_PHASE_NAME),
          description:
            phase.description === undefined ? null : bounded(phase.description, MAX_DESCRIPTION),
          startedAt: phaseStart.toISOString(),
          finishedAt: phaseEnd.toISOString(),
          durationMs: Math.max(0, phaseEnd.getTime() - phaseStart.getTime()),
          ok: true,
          error: null,
        }),
      );
    } catch (error) {
      const phaseEnd = clock.now();
      const message = error instanceof Error ? error.message : String(error);
      phases.push(
        Object.freeze({
          name: bounded(phase.name, MAX_PHASE_NAME),
          description:
            phase.description === undefined ? null : bounded(phase.description, MAX_DESCRIPTION),
          startedAt: phaseStart.toISOString(),
          finishedAt: phaseEnd.toISOString(),
          durationMs: Math.max(0, phaseEnd.getTime() - phaseStart.getTime()),
          ok: false,
          error: bounded(message, MAX_ERROR_LENGTH),
        }),
      );
      recovered = false;
      break; // fail closed: the recovery procedure stops at the failure
    }
  }

  const finishedAt = clock.now();
  const rtoMs = recovered ? Math.max(0, finishedAt.getTime() - input.lossAt.getTime()) : null; // an unverified recovery has no RTO claim
  const rpoMs =
    input.lastConsistentPointAt === null
      ? null
      : Math.max(0, input.lossAt.getTime() - input.lastConsistentPointAt.getTime());

  return Object.freeze({
    scenarioId: bounded(input.scenarioId, MAX_PHASE_NAME),
    environment: bounded(input.environment, 100),
    revision: bounded(input.revision, 64),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    phases: Object.freeze([...phases]),
    rtoMs,
    rpoMs,
    recovered,
  });
}
