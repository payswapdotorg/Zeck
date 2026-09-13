/**
 * The substrate-failure application's deterministic fault-injection
 * fixtures (VAL-022, AC2).
 *
 * Fake compute-substrate adapters that replay the REAL substrate
 * failure shapes the live substrates actually produce (exported
 * verbatim from the platform module's REAL_SUBSTRATE_FAILURE_SHAPES:
 * the process runtime's admitted-deadline kill — timedOut, exit 137;
 * the container runtime's State.OOMKilled inspection shape — exit 137
 * with the OOM marker, NOT the timeout marker; the payload exit-code
 * failure; the never-settling mid-execution loss) — plus the healthy
 * replay shape, the lost-once-then-healthy recovery adapter, the
 * readiness-refused adapters (unavailable at submission and the
 * lost-then-unready mid-recovery refusal) and the replay meter (the
 * deterministic usage the fixture substrate measures). Every offline
 * corpus row is reproducible through these fixtures with zero network
 * dependence and zero credentials.
 *
 * The controlled readiness surface exercises the readiness-gate
 * semantics: an adapter that refuses readiness (the substrate is down
 * at submission), one that refuses twice then recovers (the bounded
 * re-probe recovery), and one that loses its first sandbox then goes
 * down (the mid-recovery refusal — readiness gates EVERY dispatch,
 * retries included).
 */

import {
  CONTAINER_OOMKILLED_SHAPE,
  type ComputeSubstrateSeam,
  healthySubstrateObservation,
  type RawSubstrateObservation,
  type SubstrateDispatchSpec,
  type SubstrateReadinessVerdict,
} from "../../platform/substrate-readiness";

/** The scenario ids the fault-injection substrate adapters understand. */
export type SubstrateFaultScenario =
  | "readiness-refused-forever"
  | "readiness-refused-twice-then-ready"
  | "sandbox-lost-once-then-healthy"
  | "sandbox-lost-always"
  | "substrate-timeout-always"
  | "resource-exhausted-oom"
  | "payload-exit-nonzero"
  | "healthy-clean"
  | "sandbox-lost-then-unready";

/** The deterministic usage the fixture substrate measures per settled run. */
const FIXTURE_USAGE_MICRO_USD = "1250";

/**
 * The REAL process-runtime deadline-kill shape with the fixture's
 * measured usage (the shape fields verbatim from
 * REAL_SUBSTRATE_FAILURE_SHAPES; the usage is the fixture meter's
 * deterministic measurement).
 */
const PROCESS_DEADLINE_KILL_WITH_USAGE: RawSubstrateObservation = {
  settled: true,
  timedOut: true,
  oomKilled: false,
  exitCode: 137,
  stdoutDigest: null,
  durationMs: null,
  usageMicroUsd: FIXTURE_USAGE_MICRO_USD,
  adapterError: null,
};

/** The never-settling observation (the mid-execution LOSS shape). */
const NEVER_SETTLING_RUN: Promise<RawSubstrateObservation> = new Promise<RawSubstrateObservation>(
  () => {},
);

/**
 * The scripted readiness answers per scenario (null = always ready).
 * The probe counter is per-adapter-instance, so each corpus row drives
 * its own scripted sequence.
 */
function readinessScriptFor(
  scenario: SubstrateFaultScenario,
): ((probeCount: number) => SubstrateReadinessVerdict) | null {
  switch (scenario) {
    case "readiness-refused-forever":
      return () => ({
        ready: false,
        quarantined: false,
        reason: "substrate unavailable at submission (injected: the runner pool has no capacity)",
      });
    case "readiness-refused-twice-then-ready":
      return (probeCount) =>
        probeCount <= 2
          ? {
              ready: false,
              quarantined: false,
              reason: `substrate warming up (injected: probe ${probeCount} of the cold-start window)`,
            }
          : { ready: true, quarantined: false, reason: null };
    case "sandbox-lost-then-unready":
      // Ready for the FIRST dispatch; the first run is lost; every
      // probe after the loss refuses (the substrate went down
      // mid-recovery — readiness gates the retry too).
      return (probeCount) =>
        probeCount <= 1
          ? { ready: true, quarantined: false, reason: null }
          : {
              ready: false,
              quarantined: false,
              reason: "substrate went down after the sandbox loss (injected mid-recovery refusal)",
            };
    default:
      return null;
  }
}

/**
 * The scripted run outcome per scenario. The run counter is
 * per-adapter-instance; a scripted run observes exactly which
 * substrate dispatch specs it received (the assertion surface).
 */
function runScriptFor(
  scenario: SubstrateFaultScenario,
):
  | ((runCount: number, spec: SubstrateDispatchSpec) => RawSubstrateObservation | "never-settles")
  | null {
  switch (scenario) {
    case "sandbox-lost-once-then-healthy":
      return (runCount) => (runCount === 1 ? "never-settles" : healthySubstrateObservation());
    case "sandbox-lost-always":
    case "sandbox-lost-then-unready":
      return () => "never-settles";
    case "substrate-timeout-always":
      return () => ({ ...PROCESS_DEADLINE_KILL_WITH_USAGE });
    case "resource-exhausted-oom":
      return () => ({ ...CONTAINER_OOMKILLED_SHAPE });
    case "payload-exit-nonzero":
      return () => ({
        settled: true,
        timedOut: false,
        oomKilled: false,
        exitCode: 7,
        stdoutDigest: null,
        durationMs: 4,
        usageMicroUsd: FIXTURE_USAGE_MICRO_USD,
        adapterError: null,
      });
    case "healthy-clean":
    case "readiness-refused-forever":
    case "readiness-refused-twice-then-ready":
      return () => healthySubstrateObservation();
    default: {
      const exhaustive: never = scenario;
      throw new Error(`unhandled fault scenario ${String(exhaustive)}`);
    }
  }
}

/** What one fault-injected adapter observed (the assertion surface). */
export interface SubstrateCallLog {
  readonly probeCount: number;
  readonly runCount: number;
  readonly runSpecs: readonly SubstrateDispatchSpec[];
}

/**
 * Build the deterministic fault-injection compute-substrate adapter
 * for one scenario: scripts the readiness answers and the run
 * observations in order, recording every dispatch spec it received
 * (fresh-sandbox ids included — the reuse assertion surface).
 */
export function createFaultInjectedSubstrate(options: {
  readonly scenario: SubstrateFaultScenario;
}): {
  readonly seam: ComputeSubstrateSeam;
  readonly calls: SubstrateCallLog;
} {
  const calls: { probeCount: number; runCount: number; runSpecs: SubstrateDispatchSpec[] } = {
    probeCount: 0,
    runCount: 0,
    runSpecs: [],
  };
  const readinessScript = readinessScriptFor(options.scenario);
  const runScript = runScriptFor(options.scenario);
  const seam: ComputeSubstrateSeam = {
    async probeReadiness() {
      calls.probeCount += 1;
      if (readinessScript === null) {
        return { ready: true, quarantined: false, reason: null };
      }
      return readinessScript(calls.probeCount);
    },
    async runInSandbox(spec) {
      calls.runCount += 1;
      calls.runSpecs.push({ ...spec, task: { ...spec.task, args: [...spec.task.args] } });
      if (runScript === null) {
        return healthySubstrateObservation();
      }
      const scripted = runScript(calls.runCount, spec);
      if (scripted === "never-settles") {
        // Deliberately NEVER settles: the observation race records the
        // honest LOSS — no result was produced, none is fabricated.
        return NEVER_SETTLING_RUN;
      }
      return scripted;
    },
  };
  return { seam, calls };
}
