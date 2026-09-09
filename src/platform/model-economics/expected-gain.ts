/**
 * The bounded, typed expected-gain arithmetic (platform
 * model-economics plane; WORK-053).
 *
 * The trade-off machinery of the 0/1/N agent gate (WORK-053 scope:
 * "expected quality gain versus cost, latency and verification
 * burden; below-threshold selections are inadmissible"):
 *
 *   netExpectedGainMicroUsd
 *     = valueOfGain − incrementalCost − verificationBurden − latencyTerm
 *
 * where every term is bounded integer micro-USD arithmetic over
 * EXPLICIT caller-declared exchange rates (`AgentGateEconomics`) and
 * explicit-basis claims:
 *
 *  - `valueOfGain` = ceil(qualityValueMicroUsd × expectedQualityGain)
 *    — the money value of the claimed quality gain (scaled integer
 *    arithmetic, conservative ceiling, exactly the foundation's
 *    reliability-scaling pattern);
 *  - `incrementalCost` = the N strategy's expected
 *    successful-resolution cost MINUS the anchor's (signed: a
 *    genuinely cheaper parallel path reduces it);
 *  - `verificationBurden` = the N candidate's claimed judging/voting
 *    cost (≥ 0, explicit basis — required on every N candidate);
 *  - `latencyTerm` = latencyValueMicroUsdPerMs × round(ΔlatencyMs)
 *    (signed: a parallel latency BENEFIT offsets cost).
 *
 * The gate rule (architecture invariant 2): N is admissible ONLY with
 * a POSITIVE net — "N-agent requires positive expected quality-gain
 * evidence, not enthusiasm". A non-positive net is the typed
 * `quality-gain-below-threshold` inadmissibility (recorded, never
 * silently applied).
 *
 * Total and deterministic: every value is a pure function of its
 * inputs; overflow past the bounded money universe is a typed
 * rejection (never a silent infinity).
 */

import type { AgentGainClaim } from "./vocabulary";
import { parseBoundedMicroUsd, reject } from "./vocabulary";

// ---------------------------------------------------------------------------
// The typed trade-off analysis
// ---------------------------------------------------------------------------

/** The bounded money ceiling for every arithmetic term. */
const MAX_MONEY = 999999999999999999n;

/** The quality-gain scaling factor (1e12 — the foundation's pattern). */
const GAIN_SCALE = 1000000000000n;

/** The anchor facts an N strategy's premium is measured against. */
export interface GainAnchor {
  /** The anchor's expected successful-resolution cost (micro-USD). */
  readonly expectedSuccessfulResolutionCostMicroUsd: string;
  /** The anchor's expected latency (milliseconds). */
  readonly expectedLatencyMs: number;
}

/** The typed, bounded expected-gain analysis of ONE N candidate. */
export interface ExpectedGainAnalysis {
  readonly candidateId: string;
  /** The claimed expected quality gain in (0, 1] (explicit basis). */
  readonly expectedQualityGain: number;
  /** The parallelism width. */
  readonly agentCount: number;
  /** ceil(qualityValueMicroUsd × expectedQualityGain) — micro-USD. */
  readonly valueOfGainMicroUsd: string;
  /** N cost − anchor cost (signed micro-USD). */
  readonly incrementalCostMicroUsd: string;
  /** The claimed verification burden (≥ 0 micro-USD). */
  readonly verificationBurdenMicroUsd: string;
  /** N latency − anchor latency (signed milliseconds). */
  readonly latencyDeltaMs: number;
  /** latencyValueMicroUsdPerMs × round(latencyDeltaMs) (signed micro-USD). */
  readonly latencyTermMicroUsd: string;
  /** valueOfGain − incrementalCost − verificationBurden − latencyTerm. */
  readonly netExpectedGainMicroUsd: string;
  /** True iff netExpectedGainMicroUsd > 0 (the gate rule). */
  readonly positive: boolean;
}

function boundedTerm(value: bigint, what: string): bigint {
  // Signed bound: |value| must stay inside the money universe.
  if (value > MAX_MONEY || value < -MAX_MONEY) {
    reject("claim-overflow", `${what} exceeds the bounded money universe`, {
      got: value.toString(),
    });
  }
  return value;
}

function scaledGain(gain: number): bigint {
  // The foundation's scaled-integer pattern: round(gain × 1e12).
  const scaled = BigInt(Math.round(gain * 1e12));
  if (scaled <= 0n || scaled > GAIN_SCALE) {
    reject("gate-shape", "the expected quality gain must scale into (0, 1e12]", {
      gain,
    });
  }
  return scaled;
}

/**
 * Analyze ONE N candidate's expected gain against the anchor (or
 * against the empty path when no admissible cheaper anchor exists —
 * the premium is then measured against nothing, and N must still
 * carry positive absolute value). Every term is bounded, typed and
 * deterministic. The N candidate's expected successful-resolution
 * cost is supplied by the caller (computed through the foundation's
 * `evaluateCandidate`, exactly like the anchor's).
 */
export function analyzeExpectedGain(input: {
  readonly candidateId: string;
  /** The N candidate's expected successful-resolution cost (micro-USD). */
  readonly expectedSuccessfulResolutionCostMicroUsd: string;
  readonly claim: { expectedLatencyMs: number };
  readonly gain: AgentGainClaim;
  /** The anchor's cost, or "0" when no admissible cheaper anchor exists. */
  readonly anchorCostMicroUsd: string;
  readonly anchorLatencyMs: number;
  readonly economics: {
    readonly qualityValueMicroUsd: string;
    readonly latencyValueMicroUsdPerMs?: string;
  };
}): ExpectedGainAnalysis {
  const qualityValue = parseBoundedMicroUsd(
    input.economics.qualityValueMicroUsd,
    "qualityValueMicroUsd",
  );
  const latencyValue = parseBoundedMicroUsd(
    input.economics.latencyValueMicroUsdPerMs ?? "0",
    "latencyValueMicroUsdPerMs",
  );
  const nCost = parseBoundedMicroUsd(
    input.expectedSuccessfulResolutionCostMicroUsd,
    "the n-agent expected successful-resolution cost",
  );
  const anchorCost = parseBoundedMicroUsd(input.anchorCostMicroUsd, "the anchor cost");
  const burden = parseBoundedMicroUsd(
    input.gain.expectedVerificationBurdenMicroUsd,
    "the verification burden",
  );

  // valueOfGain = ceil(qualityValue × gain) in scaled integer math.
  const gainScaled = scaledGain(input.gain.expectedQualityGain);
  const valueOfGain = (qualityValue * gainScaled + GAIN_SCALE - 1n) / GAIN_SCALE;
  boundedTerm(valueOfGain, "valueOfGain");

  // The incremental premium: N cost − anchor cost (signed — a
  // genuinely cheaper parallel path carries a negative premium).
  const incrementalCost = boundedTerm(nCost - anchorCost, "incrementalCost");

  const latencyDeltaMs = input.claim.expectedLatencyMs - input.anchorLatencyMs;
  const latencyTerm = boundedTerm(latencyValue * BigInt(Math.round(latencyDeltaMs)), "latencyTerm");

  const net = boundedTerm(valueOfGain - incrementalCost - burden - latencyTerm, "netExpectedGain");

  return {
    candidateId: input.candidateId,
    expectedQualityGain: input.gain.expectedQualityGain,
    agentCount: input.gain.agentCount,
    valueOfGainMicroUsd: valueOfGain.toString(),
    incrementalCostMicroUsd: incrementalCost.toString(),
    verificationBurdenMicroUsd: burden.toString(),
    latencyDeltaMs,
    latencyTermMicroUsd: latencyTerm.toString(),
    netExpectedGainMicroUsd: net.toString(),
    positive: net > 0n,
  };
}

/** The anchor's facts from an already-evaluated admissible verdict. */
export function anchorOf(anchor: {
  readonly evaluation: { expectedSuccessfulResolutionCostMicroUsd: string };
  readonly claim: { expectedLatencyMs: number };
}): GainAnchor {
  return {
    expectedSuccessfulResolutionCostMicroUsd:
      anchor.evaluation.expectedSuccessfulResolutionCostMicroUsd,
    expectedLatencyMs: anchor.claim.expectedLatencyMs,
  };
}
