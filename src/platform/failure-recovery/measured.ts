/**
 * Measured-evidence facts (platform failure-recovery plane; ACR-008 §4 —
 * the PCR-002 observed-reliability input).
 *
 * Strategy selection gains an OPTIONAL typed input: OBSERVED-RELIABILITY
 * FACTS — measured per-provider/per-route success, latency-distribution
 * summaries and cooldown observations, each with its EXPLICIT BASIS
 * (source observation identity, window, sample count).
 *
 * THE INVARIANT-13 BOUNDARY (learning can change recommendations but
 * cannot weaken policy or authority boundaries) is enforced
 * STRUCTURALLY in this plane: the measured facts are consumed ONLY by
 * the preference ordering of the ALREADY-admissible strategy verdicts
 * (`strategy.ts` — the reorder pass); the admissibility machinery, the
 * quality floors, the budget/latency ceilings and the policy
 * restrictions NEVER see them. Measured facts may reorder candidate
 * preferences; they can NEVER lower a quality floor, raise a budget
 * ceiling, bypass a policy restriction or admit an otherwise-
 * inadmissible move — the misordering is unrepresentable because the
 * admissible set is computed before the reorder pass and never
 * recomputed from measured inputs.
 *
 * DISCIPLINE (fail-closed, total, deterministic):
 *
 *  - every value is BOUNDED (route count, sample count, latency
 *    percentiles, cooldown remaining, observation identity) — an
 *    unbounded or malformed fact is a typed `measured-shape` rejection,
 *    never a silent truncation or default;
 *  - every fact carries its EXPLICIT BASIS — the source observation
 *    identity, the observation window (start before end) and the
 *    sample count (>= 1): provenance is a REQUIRED field, never an
 *    afterthought;
 *  - the facts are NEVER AMBIENT: they are an explicit selection input
 *    (never an environment read, never module state — architecture-
 *    proven), and their ABSENCE is the default state;
 *  - provenance is content-derived and auditable: `measuredProvenanceOf`
 *    derives the bounded provenance statement (digest over the
 *    canonical fact set, route count, total sample count, observed
 *    window) that rides every decision record which consumed measured
 *    facts (the WORK-049 seam's append-only values).
 */

import { canonicalJson } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  boundedDetail,
  COMPONENT_REF_PATTERN,
  MAX_MEASURED_COOLDOWN_MS,
  MAX_MEASURED_LATENCY_MS,
  MAX_MEASURED_ROUTE_FACTS,
  MAX_MEASURED_SAMPLE_COUNT,
  MEASURED_OBSERVATION_ID_MAX,
  reject,
} from "./catalog";

// ---------------------------------------------------------------------------
// The measured fact types (typed, bounded, explicit-basis)
// ---------------------------------------------------------------------------

/**
 * The EXPLICIT basis of one measured fact: WHICH observations produced
 * it (the source observation identity), OVER WHICH WINDOW (start/end
 * instants), FROM HOW MANY SAMPLES. Absence of any basis element is a
 * typed rejection — a measured fact without provenance is
 * unrepresentable (ACR-008 §4).
 */
export interface MeasuredRouteBasis {
  /** The bounded identity of the source observation stream (opaque slug). */
  readonly sourceObservationId: string;
  /** The observation window's start instant (RFC3339 — an input, never ambient). */
  readonly windowStart: string;
  /** The observation window's end instant (RFC3339 — must not precede the start). */
  readonly windowEnd: string;
  /** The sample count the fact was measured over (integer in [1, 10_000_000]). */
  readonly sampleCount: number;
}

/** The latency-distribution summary of one measured route (bounded percentiles). */
export interface LatencyDistributionSummary {
  /** The observed median latency (integer milliseconds, p95 >= p50). */
  readonly p50Ms: number;
  /** The observed 95th-percentile latency (integer milliseconds, >= p50). */
  readonly p95Ms: number;
}

/**
 * The cooldown state of one measured route: an ACTIVE cooldown carries
 * its remaining duration (the measured evidence that the route is
 * currently refusing or degrading traffic); an INACTIVE cooldown is the
 * honest absence of one (an incoherent `active: false` value carrying a
 * remaining duration is a typed rejection).
 */
export type RouteCooldownState =
  | { readonly active: true; readonly remainingMs: number }
  | { readonly active: false };

/** One observed per-route reliability fact (measured, explicit-basis). */
export interface ObservedRouteReliability {
  /** The measured route (bounded neutral provider/model slugs). */
  readonly route: { readonly provider: string; readonly model: string };
  /** The measured success rate over the basis window (probability in [0, 1]). */
  readonly measuredSuccessRate: number;
  /** The measured latency-distribution summary (bounded percentiles). */
  readonly latencySummary: LatencyDistributionSummary;
  /** The measured cooldown state. */
  readonly cooldown: RouteCooldownState;
  /** The EXPLICIT basis (source observation identity, window, sample count). */
  readonly basis: MeasuredRouteBasis;
}

/**
 * The observed-reliability facts: the OPTIONAL measured-evidence input
 * to strategy selection (ACR-008 §4). Bounded, unique-route, closed
 * JSON universe — the same facts always produce the same provenance
 * digest (determinism).
 */
export interface ObservedReliabilityFacts {
  /** The measured route facts (unique routes, at most 32 entries). */
  readonly routes: readonly ObservedRouteReliability[];
}

// ---------------------------------------------------------------------------
// Total, deterministic validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !COMPONENT_REF_PATTERN.test(value)) {
    reject("measured-shape", `the measured fact's ${field} must be a bounded neutral slug`, {
      got: boundedDetail(String(value)),
    });
  }
  return value;
}

function requireInstant(value: unknown, field: string): number {
  if (typeof value !== "string" || value.length === 0) {
    reject("measured-shape", `the measured fact's ${field} must be a non-empty instant string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    reject("measured-shape", `the measured fact's ${field} must be a parsable instant`, {
      got: boundedDetail(String(value)),
    });
  }
  return parsed;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    reject(
      "measured-shape",
      `the measured fact's ${field} must be an integer in [${minimum}, ${maximum}]`,
      {
        got: boundedDetail(String(value)),
      },
    );
  }
  return value;
}

/** Total, deterministic validation of one measured route fact. */
function validateObservedRouteReliability(value: unknown): ObservedRouteReliability {
  if (!isRecord(value)) {
    reject("measured-shape", "a measured route fact must be an object");
  }
  const record = value;
  if (!isRecord(record.route)) {
    reject("measured-shape", "a measured route fact requires its route");
  }
  const route = {
    provider: requireSlug(record.route.provider, "route provider"),
    model: requireSlug(record.route.model, "route model"),
  };
  if (
    typeof record.measuredSuccessRate !== "number" ||
    !Number.isFinite(record.measuredSuccessRate) ||
    record.measuredSuccessRate < 0 ||
    record.measuredSuccessRate > 1
  ) {
    reject("measured-shape", "the measured success rate must be a probability in [0, 1]", {
      got: boundedDetail(String(record.measuredSuccessRate)),
    });
  }
  if (!isRecord(record.latencySummary)) {
    reject("measured-shape", "a measured route fact requires its latency summary");
  }
  const p50Ms = requireBoundedInteger(
    record.latencySummary.p50Ms,
    "latency p50",
    1,
    MAX_MEASURED_LATENCY_MS,
  );
  const p95Ms = requireBoundedInteger(
    record.latencySummary.p95Ms,
    "latency p95",
    1,
    MAX_MEASURED_LATENCY_MS,
  );
  if (p95Ms < p50Ms) {
    reject("measured-shape", "the latency summary's p95 must not precede its p50", {
      p50Ms,
      p95Ms,
    });
  }
  if (!isRecord(record.cooldown)) {
    reject("measured-shape", "a measured route fact requires its cooldown state");
  }
  let cooldown: RouteCooldownState;
  if (record.cooldown.active === true) {
    const remainingMs = requireBoundedInteger(
      record.cooldown.remainingMs,
      "cooldown remaining",
      1,
      MAX_MEASURED_COOLDOWN_MS,
    );
    cooldown = { active: true, remainingMs };
  } else if (record.cooldown.active === false) {
    if (record.cooldown.remainingMs !== undefined) {
      reject(
        "measured-shape",
        "an inactive cooldown cannot carry a remaining duration (the incoherent shape is rejected)",
      );
    }
    cooldown = { active: false };
  } else {
    reject("measured-shape", "the cooldown active flag must be boolean", {
      got: boundedDetail(String(record.cooldown.active)),
    });
  }
  if (!isRecord(record.basis)) {
    reject("measured-shape", "a measured route fact requires its explicit basis");
  }
  const sourceObservationId = record.basis.sourceObservationId;
  if (
    typeof sourceObservationId !== "string" ||
    sourceObservationId.length === 0 ||
    sourceObservationId.length > MEASURED_OBSERVATION_ID_MAX
  ) {
    reject(
      "measured-shape",
      "the basis source observation identity must be bounded non-empty text",
      {
        got: boundedDetail(String(sourceObservationId)),
      },
    );
  }
  const windowStartMs = requireInstant(record.basis.windowStart, "window start");
  const windowEndMs = requireInstant(record.basis.windowEnd, "window end");
  if (windowEndMs < windowStartMs) {
    reject("measured-shape", "the basis observation window must not end before it starts", {
      windowStart: boundedDetail(String(record.basis.windowStart)),
      windowEnd: boundedDetail(String(record.basis.windowEnd)),
    });
  }
  const sampleCount = requireBoundedInteger(
    record.basis.sampleCount,
    "sample count",
    1,
    MAX_MEASURED_SAMPLE_COUNT,
  );
  return {
    route,
    measuredSuccessRate: record.measuredSuccessRate,
    latencySummary: { p50Ms, p95Ms },
    cooldown,
    basis: {
      sourceObservationId,
      windowStart: record.basis.windowStart as string,
      windowEnd: record.basis.windowEnd as string,
      sampleCount,
    },
  };
}

/**
 * Total, deterministic validation of the observed-reliability facts:
 * bounded route count, unique routes, every fact fully validated. A
 * malformed corpus is a typed `measured-shape` rejection — never a
 * partial consumption, never a silent default.
 */
export function validateObservedReliabilityFacts(value: unknown): ObservedReliabilityFacts {
  if (!isRecord(value)) {
    reject("measured-shape", "the observed-reliability facts must be an object");
  }
  if (!Array.isArray(value.routes)) {
    reject("measured-shape", "the observed-reliability facts require their routes array");
  }
  if (value.routes.length > MAX_MEASURED_ROUTE_FACTS) {
    reject("measured-shape", "the observed-reliability route facts exceed the hard bound", {
      routes: value.routes.length,
      max: MAX_MEASURED_ROUTE_FACTS,
    });
  }
  const routes: ObservedRouteReliability[] = [];
  const seen = new Set<string>();
  for (const entry of value.routes) {
    const fact = validateObservedRouteReliability(entry);
    const key = `${fact.route.provider}/${fact.route.model}`;
    if (seen.has(key)) {
      reject("measured-shape", "a route carries more than one measured fact", {
        route: boundedDetail(key),
      });
    }
    seen.add(key);
    routes.push(fact);
  }
  return { routes };
}

// ---------------------------------------------------------------------------
// The auditable provenance statement
// ---------------------------------------------------------------------------

/**
 * Derive the bounded, content-addressed provenance statement of the
 * observed-reliability facts: the digest over the canonical fact set,
 * the route count, the total sample count and the observed window
 * (earliest start / latest end). Deterministic — the same facts always
 * produce the byte-identical statement — and REQUIRED on every
 * decision record that consumed measured facts (the auditable answer
 * to "which observations, which window").
 */
export function measuredProvenanceOf(
  facts: ObservedReliabilityFacts,
  digest: IrDigestPort,
): string {
  const identity = digest.sha256Hex(canonicalJson({ routes: facts.routes }));
  const samples = facts.routes.reduce((sum, fact) => sum + fact.basis.sampleCount, 0);
  let earliestStart = "";
  let latestEnd = "";
  for (const fact of facts.routes) {
    if (earliestStart === "" || fact.basis.windowStart < earliestStart) {
      earliestStart = fact.basis.windowStart;
    }
    if (fact.basis.windowEnd > latestEnd) {
      latestEnd = fact.basis.windowEnd;
    }
  }
  return boundedDetail(
    `measured;digest=${identity};routes=${facts.routes.length};samples=${samples};window=${earliestStart}/${latestEnd}`,
  );
}
