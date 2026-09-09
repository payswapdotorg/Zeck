/**
 * Readiness/startup lifecycle measurement (platform substrate-economics
 * plane; WORK-054 / E1.1 charter wave member 4 — ADR-0019, ADR-0020).
 *
 * THE MEASUREMENT MODELS of the substrate-economics plane — the
 * bounded, typed computations over substrate startup, readiness probes
 * and warm-pool/snapshot states (the Work Order's third scope item;
 * the E1.1 research baseline's core lesson: distinguish "started"
 * from "ready", and optimize TOTAL readiness latency — application
 * initialization can dominate raw boot time).
 *
 * Three contracts, all pure and deterministic:
 *
 *  - `ReadinessObservation` — one measured probe outcome: the neutral
 *    readiness state a substrate adapter REPORTED (created /
 *    scheduled / started / ready) at an explicit epoch instant with a
 *    bounded attribution source. Warm/snapshot-awareness is decision
 *    INPUT, not hidden state (architecture invariant 6): adapters
 *    report; the execution layer decides.
 *
 *  - `classifyReadiness` — the believed current state of one
 *    substrate: the LATEST observation within the explicit freshness
 *    window; anything older, absent or out-of-order is `unknown`, and
 *    `unknown` NEVER upgrades readiness (fail closed: a substrate
 *    without fresh evidence is treated as its DECLARED facts describe,
 *    never as silently warm).
 *
 *  - `computeStartupExpectation` / `expectedExecutionEconomics` — the
 *    bounded, typed computation of (a) the expected startup→ready
 *    latency and cost for one availability mode (the FULL created →
 *    ready path, never the boot time alone), collapsed to zero ONLY
 *    when a fresh `ready` observation proves the environment can
 *    accept work now (the warm-pool collapse), and (b) the composite
 *    execution economics: total latency = readiness + execution, total
 *    cost = startup + execution, and the expected SUCCESSFUL-
 *    RESOLUTION cost `ceil(total / reliability)` — the WORK-049
 *    bounded integer arithmetic, extended with startup, never
 *    re-implemented differently.
 *
 * Every number is bounded; every expectation carries the explicit
 * basis of the fact it was derived from (declared observed/estimated/
 * defaulted, or `observed` with the readiness observation source when
 * the warm collapse applies). Nothing here consults clocks, caches or
 * ambient state — `nowEpochMs` is an explicit input.
 */

import type { CostBasisAttribution } from "../execution-ir/cost-model";
import {
  boundedDetail,
  isSubstrateReadinessState,
  MAX_READINESS_OBSERVATIONS,
  READINESS_FRESHNESS_WINDOW_BOUNDS,
  rejectSubstrate,
  SUBSTRATE_ID_PATTERN,
  type SubstrateAvailabilityMode,
  type SubstrateReadinessState,
} from "./catalog";
import {
  offeredModes,
  type SubstrateDescriptor,
  type SubstrateStartupFact,
  startupFactOf,
} from "./facts";

// ---------------------------------------------------------------------------
// Readiness observations (the probe evidence adapters report)
// ---------------------------------------------------------------------------

/**
 * One measured readiness-probe observation — the neutral fact a
 * substrate adapter REPORTS about one substrate's current environment
 * state. Basis is `observed` by construction (this IS the
 * measurement); `source` attributes the reporting adapter probe.
 */
export interface ReadinessObservation {
  readonly substrateId: string;
  readonly state: SubstrateReadinessState;
  /** The epoch-millisecond instant the probe observed the state. */
  readonly observedAtEpochMs: number;
  /** Bounded attribution of the reporting probe (e.g. the adapter's probe id). */
  readonly source: string;
}

const SOURCE_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of one readiness observation. */
export function validateReadinessObservation(value: unknown): ReadinessObservation {
  if (!isRecord(value)) {
    rejectSubstrate("readiness-observation-shape", "readiness observation must be an object");
  }
  if (typeof value.substrateId !== "string" || !SUBSTRATE_ID_PATTERN.test(value.substrateId)) {
    rejectSubstrate(
      "readiness-observation-shape",
      "observation substrateId must be a neutral slug",
      {
        got: boundedDetail(value.substrateId),
      },
    );
  }
  if (typeof value.state !== "string" || !isSubstrateReadinessState(value.state)) {
    rejectSubstrate(
      "readiness-observation-shape",
      "observation state must be on the neutral readiness ladder",
      {
        got: boundedDetail(value.state),
      },
    );
  }
  if (
    typeof value.observedAtEpochMs !== "number" ||
    !Number.isFinite(value.observedAtEpochMs) ||
    !Number.isInteger(value.observedAtEpochMs) ||
    value.observedAtEpochMs < 0
  ) {
    rejectSubstrate(
      "readiness-observation-shape",
      "observedAtEpochMs must be a non-negative integer epoch",
    );
  }
  if (
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    value.source.length > SOURCE_MAX
  ) {
    rejectSubstrate(
      "readiness-observation-shape",
      "observation source must be bounded non-empty text",
    );
  }
  return {
    substrateId: value.substrateId,
    state: value.state,
    observedAtEpochMs: value.observedAtEpochMs,
    source: value.source,
  };
}

/**
 * Validate a bounded observation set. Duplicates are legal (probes
 * repeat); the set is bounded.
 */
export function validateReadinessObservations(
  values: readonly unknown[],
): readonly ReadinessObservation[] {
  if (!Array.isArray(values)) {
    rejectSubstrate("readiness-observation-shape", "readiness observations must be an array");
  }
  if (values.length > MAX_READINESS_OBSERVATIONS) {
    rejectSubstrate(
      "readiness-observation-shape",
      `readiness observations exceed the bound of ${MAX_READINESS_OBSERVATIONS}`,
    );
  }
  return values.map(validateReadinessObservation);
}

// ---------------------------------------------------------------------------
// Readiness classification (fail closed — never silently warm)
// ---------------------------------------------------------------------------

/** The believed current readiness of one substrate. */
export type ReadinessClassification =
  | {
      readonly kind: "observed";
      readonly state: SubstrateReadinessState;
      readonly observedAtEpochMs: number;
      readonly source: string;
    }
  | { readonly kind: "unknown" };

/**
 * Classify one substrate's believed readiness: the LATEST observation
 * within the freshness window wins. A regressed observation (an older
 * instant than one already seen) is ignored; a stale or absent
 * observation yields `unknown` — and `unknown` NEVER upgrades anything
 * (the caller treats the substrate exactly as its declared facts
 * describe; readiness is never assumed).
 */
export function classifyReadiness(
  observations: readonly ReadinessObservation[],
  substrateId: string,
  nowEpochMs: number,
  freshnessWindowMs: number,
): ReadinessClassification {
  if (
    !Number.isInteger(nowEpochMs) ||
    nowEpochMs < 0 ||
    !Number.isInteger(freshnessWindowMs) ||
    freshnessWindowMs < READINESS_FRESHNESS_WINDOW_BOUNDS.min ||
    freshnessWindowMs > READINESS_FRESHNESS_WINDOW_BOUNDS.max
  ) {
    rejectSubstrate(
      "readiness-observation-stale",
      "classification requires a bounded now and freshness window",
    );
  }
  let best: ReadinessObservation | null = null;
  for (const observation of observations) {
    if (observation.substrateId !== substrateId) {
      continue;
    }
    // Freshness: only observations within the window count.
    if (nowEpochMs - observation.observedAtEpochMs > freshnessWindowMs) {
      continue;
    }
    if (observation.observedAtEpochMs > nowEpochMs) {
      // An observation from the future is not credible evidence.
      continue;
    }
    if (best === null || observation.observedAtEpochMs > best.observedAtEpochMs) {
      best = observation;
    }
  }
  if (best === null) {
    return { kind: "unknown" };
  }
  return {
    kind: "observed",
    state: best.state,
    observedAtEpochMs: best.observedAtEpochMs,
    source: best.source,
  };
}

// ---------------------------------------------------------------------------
// Startup expectation (the bounded created → ready computation)
// ---------------------------------------------------------------------------

/** The measured startup expectation of one availability mode. */
export interface StartupExpectation {
  readonly mode: SubstrateAvailabilityMode;
  /** Expected milliseconds from request to READY (the FULL path). */
  readonly readinessMs: number;
  /** Expected one-time startup cost (integer micro-USD string). */
  readonly startupCostMicroUsd: string;
  /** The explicit basis of the expectation (declared fact or probe). */
  readonly basis: CostBasisAttribution;
  /** True when a fresh `ready` observation collapsed startup to zero. */
  readonly warmCollapse: boolean;
}

/**
 * Compute the startup expectation of one mode:
 *
 *  - the DECLARED startup fact of the mode is the default expectation
 *    (bounded, attributed — the descriptor's own evidence);
 *  - a fresh `ready` observation collapses the WARM mode to zero
 *    startup (the environment can accept work now — the warm-pool
 *    collapse; basis becomes `observed` at the probe's source);
 *  - cold/snapshot modes are provisioning paths a ready-idle
 *    observation cannot collapse (a cold start creates from scratch; a
 *    snapshot restore creates from a snapshot) — the declared facts
 *    stand;
 *  - a mode the substrate does not offer is a TYPED rejection (an
 *    unoffered mode is unrepresentable — never a silent cold
 *    fallback).
 */
export function computeStartupExpectation(
  descriptor: SubstrateDescriptor,
  mode: SubstrateAvailabilityMode,
  classification: ReadinessClassification = { kind: "unknown" },
): StartupExpectation {
  if (!offeredModes(descriptor).includes(mode)) {
    rejectSubstrate("substrate-descriptor-vocabulary", "mode is not offered by this substrate", {
      substrateId: descriptor.substrateId,
      mode,
    });
  }
  const fact: SubstrateStartupFact = startupFactOf(descriptor, mode);
  if (mode === "warm" && classification.kind === "observed" && classification.state === "ready") {
    return {
      mode,
      readinessMs: 0,
      startupCostMicroUsd: "0",
      basis: {
        basis: "observed",
        source: `substrate-readiness-observation:${classification.source}`,
      },
      warmCollapse: true,
    };
  }
  return {
    mode,
    readinessMs: fact.readinessMs,
    startupCostMicroUsd: fact.startupCostMicroUsd,
    basis: fact.basis,
    warmCollapse: false,
  };
}

// ---------------------------------------------------------------------------
// The composite execution economics (bounded, BigInt-exact)
// ---------------------------------------------------------------------------

/** The composite economics of executing one unit of work on (substrate, mode). */
export interface SubstrateEconomics {
  readonly substrateId: string;
  readonly version: string;
  readonly mode: SubstrateAvailabilityMode;
  /** Expected total latency: readiness + execution (ms). */
  readonly totalLatencyMs: number;
  /** Expected total cost: startup + execution (integer micro-USD string). */
  readonly totalCostMicroUsd: string;
  /**
   * Expected cost of a SUCCESSFULLY RESOLVED outcome:
   * `ceil(totalCost / executionReliability)` — the WORK-049 bounded
   * integer formula extended with startup, never re-implemented
   * differently.
   */
  readonly expectedSuccessfulResolutionCostMicroUsd: string;
  /** The explicit-basis composite startup expectation. */
  readonly startup: StartupExpectation;
  /** The steady-state execution claim (bounded, attributed). */
  readonly execution: SubstrateDescriptor["execution"];
}

const MAX_MICRO_USD_BIGINT = 999999999999999999n;

function addMicroUsd(left: string, right: string): string {
  const sum = BigInt(left) + BigInt(right);
  if (sum > MAX_MICRO_USD_BIGINT) {
    rejectSubstrate(
      "substrate-fact-unbounded",
      "composite cost exceeds the bounded money universe",
      {
        sum: sum.toString(),
      },
    );
  }
  return sum.toString();
}

function ceilDivide(microUsd: string, reliability: number): string {
  // reliability ∈ (0, 1] (validated by the WORK-049 claim contract):
  // ceil(cost / reliability) with EXACTLY the foundation's bounded
  // integer arithmetic (1e12-scaled, Math.round on the double) — the
  // formula is shared, never re-implemented differently.
  const cost = BigInt(microUsd);
  const scaled = BigInt(Math.round(reliability * 1e12));
  if (scaled <= 0n) {
    rejectSubstrate("substrate-fact-unbounded", "reliability scaling collapsed to zero");
  }
  const quotient = (cost * 1000000000000n + scaled - 1n) / scaled;
  if (quotient > MAX_MICRO_USD_BIGINT) {
    rejectSubstrate(
      "substrate-fact-unbounded",
      "expected successful-resolution cost exceeds the money universe",
      {
        quotient: quotient.toString(),
      },
    );
  }
  return quotient.toString();
}

/**
 * The composite economics of one (substrate, mode) execution:
 * totalLatency = readiness + execution latency; totalCost = startup +
 * execution cost; expectedSuccessfulResolutionCost = ceil(totalCost /
 * reliability). All bounds enforced; all inputs already validated.
 */
export function expectedExecutionEconomics(
  descriptor: SubstrateDescriptor,
  mode: SubstrateAvailabilityMode,
  classification: ReadinessClassification = { kind: "unknown" },
): SubstrateEconomics {
  const startup = computeStartupExpectation(descriptor, mode, classification);
  const totalLatencyMs = startup.readinessMs + descriptor.execution.expectedLatencyMs;
  if (!Number.isFinite(totalLatencyMs) || totalLatencyMs < 0) {
    rejectSubstrate(
      "substrate-fact-unbounded",
      "composite latency must remain finite and non-negative",
    );
  }
  const totalCostMicroUsd = addMicroUsd(
    startup.startupCostMicroUsd,
    descriptor.execution.expectedCostMicroUsd,
  );
  return {
    substrateId: descriptor.substrateId,
    version: descriptor.version,
    mode,
    totalLatencyMs,
    totalCostMicroUsd,
    expectedSuccessfulResolutionCostMicroUsd: ceilDivide(
      totalCostMicroUsd,
      descriptor.execution.expectedReliability,
    ),
    startup,
    execution: descriptor.execution,
  };
}
