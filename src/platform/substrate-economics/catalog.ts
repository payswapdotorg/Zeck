/**
 * The closed vocabularies and typed errors of the substrate-economics
 * plane (platform substrate-economics; WORK-054 / E1.1 charter wave
 * member 4 — ADR-0019, ADR-0020).
 *
 * This plane is the SUBSTRATE-ECONOMICS surface: neutral substrate
 * facts (expected quality, readiness, latency, reliability and cost
 * with warm/cold/snapshot availability — every fact explicit-basis,
 * never provider-marketing truth), the least-expense-sufficient
 * substrate selection (quality is a hard floor; economics minimize
 * above it), readiness/startup lifecycle measurement, warm/snapshot
 * aware execution decision inputs, and the runtime provider adapters
 * (the researched E1.1 provider set plus self-hosted) as NEUTRAL
 * MECHANISMS behind the existing compute/sandbox seams. It is a
 * CONSUMER of the WORK-049/050
 * foundation (Execution IR, constraints, cost model, decision records)
 * — it is NEVER a second authority:
 *
 *  - providers are NEVER authorities: provider specifics stay behind
 *    adapter seams; domain/plane code consumes only neutral substrate
 *    facts (invariant 1, mechanically proven by the architecture
 *    tests);
 *  - adapters are MECHANISMS: no adapter grants capabilities,
 *    authorizes work or defines budgets (invariant 2);
 *  - selection is the least expensive SUFFICIENT substrate: required
 *    quality is a hard floor, economics minimize above it (invariant
 *    3 — a below-floor selection is unrepresentable, discrimination
 *    tested);
 *  - every substrate fact carries an explicit basis and bounds:
 *    unattributed or unbounded claims are rejected (invariant 4 — the
 *    WORK-049 estimation-basis contract, imported not forked);
 *  - determinism: the same substrate facts + constraints +
 *    configuration produce the same selection and decision record,
 *    including tie-breaking (invariant 5);
 *  - warm/snapshot-awareness is decision INPUT, not hidden state: the
 *    execution layer decides; adapters report (invariant 6);
 *  - zero-provider operation is representable and tested: the neutral
 *    path works with no adapters registered (invariant 7);
 *  - no new durable state machine: the sole durable surface this
 *    plane participates in is the WORK-049 decision-record store, as
 *    decision evidence at the caller's seam (invariant 8 — zero new
 *    migrations, zero stores).
 *
 * Everything in this plane is deterministic: the same inputs (facts,
 * constraints, configuration, injected digest port) produce the same
 * outputs. No clock, no randomness, no ambient state: `now` and
 * `recordedAt` are explicit inputs.
 */

// ---------------------------------------------------------------------------
// Typed errors (closed invariant vocabulary)
// ---------------------------------------------------------------------------

/**
 * The closed invariant-code vocabulary of the plane. Every rejection
 * is a typed `SubstrateEconomicsError` naming exactly one of these
 * codes — never an untyped throw, never an open extension.
 */
export const SUBSTRATE_ECONOMICS_INVARIANT_CODES = [
  "substrate-descriptor-shape",
  "substrate-descriptor-vocabulary",
  "substrate-fact-unattributed",
  "substrate-fact-unbounded",
  "readiness-observation-shape",
  "readiness-observation-stale",
  "startup-computation-shape",
  "selection-constraint-shape",
  "selection-candidate-set",
  "selection-no-sufficient-substrate",
  "accounting-shape",
  "adapter-shape",
  "adapter-boundary",
] as const;
export type SubstrateEconomicsInvariantCode = (typeof SUBSTRATE_ECONOMICS_INVARIANT_CODES)[number];

/** The typed, bounded substrate-economics error. */
export class SubstrateEconomicsError extends Error {
  readonly invariant: SubstrateEconomicsInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: SubstrateEconomicsInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "SubstrateEconomicsError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details });
  }
}

const DETAIL_LIMIT = 200;

/** Bounded detail rendering for typed rejections. */
export function boundedDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

export function rejectSubstrate(
  invariant: SubstrateEconomicsInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? boundedDetail(value) : value;
    }
  }
  throw new SubstrateEconomicsError(invariant, message, boundedDetails);
}

// ---------------------------------------------------------------------------
// Availability modes (warm/cold/snapshot)
// ---------------------------------------------------------------------------

/**
 * The closed availability-mode vocabulary — how a substrate's compute
 * environment may be reached (E1.1 research baseline):
 *
 *  - `cold`    — full provisioning from scratch (create + boot +
 *                initialize); the always-representable baseline mode;
 *  - `warm`    — a pre-created ready environment (warm pool); the
 *                substrate reports readiness, startup collapses;
 *  - `snapshot`— restore from a persisted snapshot of a prior
 *                environment; cheaper startup than cold.
 *
 * The vocabulary is NEUTRAL (no provider names — "warm pool",
 * "snapshot" are the industry-neutral terms the research baseline
 * documents across every researched runtime provider alike).
 * Inventing a mode outside
 * this set is rejected: the descriptor set is CLOSED.
 */
export const SUBSTRATE_AVAILABILITY_MODES = ["cold", "warm", "snapshot"] as const;
export type SubstrateAvailabilityMode = (typeof SUBSTRATE_AVAILABILITY_MODES)[number];

export function isSubstrateAvailabilityMode(value: string): value is SubstrateAvailabilityMode {
  return (SUBSTRATE_AVAILABILITY_MODES as readonly string[]).includes(value);
}

/**
 * The deterministic availability-mode preference rank used ONLY as the
 * final tie-break of the selection (identical expected cost AND
 * identical substrate identity is impossible — the rank orders
 * mode-vs-mode within one substrate when a substrate offers several
 * modes at exactly the same expected cost; the MORE prepared state
 * wins because it leaves the least provisioning exposure). Lower rank
 * = preferred.
 */
export const AVAILABILITY_MODE_RANK: Readonly<Record<SubstrateAvailabilityMode, number>> =
  Object.freeze({ snapshot: 0, warm: 1, cold: 2 });

// ---------------------------------------------------------------------------
// Readiness states (the neutral startup lifecycle)
// ---------------------------------------------------------------------------

/**
 * The closed readiness-state vocabulary — the NEUTRAL startup
 * lifecycle of a substrate environment (E1.1 research baseline:
 * distinguish "started" from "ready"; application readiness can
 * dominate raw boot). The words are neutral lifecycle vocabulary, not
 * any provider's state machine:
 *
 *   created   → the environment identity exists (nothing running);
 *   scheduled → the environment is placed on compute;
 *   started   → the runtime process began booting (NOT yet usable);
 *   ready     → the environment passed its readiness probe and can
 *               accept work.
 *
 * The EXECUTION-PLANE distinction (started ≠ ready) is the whole point
 * of the model: expected readiness latency must cover the FULL path
 * created → ready, never the boot time alone.
 */
export const SUBSTRATE_READINESS_STATES = ["created", "scheduled", "started", "ready"] as const;
export type SubstrateReadinessState = (typeof SUBSTRATE_READINESS_STATES)[number];

export function isSubstrateReadinessState(value: string): value is SubstrateReadinessState {
  return (SUBSTRATE_READINESS_STATES as readonly string[]).includes(value);
}

/**
 * The ordinal position of each readiness state on the one-way startup
 * path (evidence for observation classification: the latest credible
 * observation is the substrate's believed state; states never regress
 * on the path within one startup).
 */
export const READINESS_STATE_RANK: Readonly<Record<SubstrateReadinessState, number>> =
  Object.freeze({ created: 0, scheduled: 1, started: 2, ready: 3 });

// ---------------------------------------------------------------------------
// Selection reason codes (the closed sufficiency vocabulary)
// ---------------------------------------------------------------------------

/**
 * The closed reason-code vocabulary explaining why one (substrate,
 * mode) candidate was judged insufficient — exactly one code per
 * failed sufficiency dimension, recorded (never silent, never a bare
 * boolean). A sufficient candidate carries no reason code.
 */
export const SUBSTRATE_INSUFFICIENCY_CODES = [
  "quality-below-floor",
  "reliability-below-floor",
  "latency-above-ceiling",
  "isolation-below-floor",
  "cost-above-ceiling",
  "mode-not-offered",
] as const;
export type SubstrateInsufficiencyCode = (typeof SUBSTRATE_INSUFFICIENCY_CODES)[number];

/** The closed selection-outcome vocabulary. */
export const SUBSTRATE_SELECTION_OUTCOMES = [
  "selected",
  "no-sufficient-substrate",
  "no-candidates",
] as const;
export type SubstrateSelectionOutcome = (typeof SUBSTRATE_SELECTION_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Bounds (every value the plane admits is bounded)
// ---------------------------------------------------------------------------

/** The plane's money bound — the WORK-049 bounded money universe. */
export const MAX_SUBSTRATE_COST_MICRO_USD = "999999999999999999";

/**
 * The bounded latency universe: finite non-negative milliseconds,
 * [0, 2^53-1] (the WORK-049 claim discipline — an unbounded or
 * non-finite latency fact is rejected, never silently rounded).
 */
export const MAX_SUBSTRATE_LATENCY_MS = Number.MAX_SAFE_INTEGER;

/** Max candidates in one selection (bounded evidence set). */
export const MAX_SUBSTRATE_CANDIDATES = 64;

/** Max readiness observations in one readiness input (bounded). */
export const MAX_READINESS_OBSERVATIONS = 128;

/** The readiness freshness window bounds (ms). */
export const READINESS_FRESHNESS_WINDOW_BOUNDS = { min: 1, max: 3_600_000 } as const;

/** The bounded identifier patterns (the repository's neutral slug discipline). */
export const SUBSTRATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SUBSTRATE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const SUBSTRATE_ADAPTER_REF_PATTERN = /^[a-z0-9][a-z0-9.-]{0,199}$/;
export const SUBSTRATE_DESCRIPTION_MAX = 2000;

/**
 * The plane's own module identity (provenance vocabulary): the
 * selector version recorded in every selection record so a deterministic
 * audit can replay the exact comparison semantics.
 */
export const SUBSTRATE_SELECTOR_VERSION = "substrate-economics-v1";
