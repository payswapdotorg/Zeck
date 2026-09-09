/**
 * Context-cost measurement (platform context-economics plane;
 * WORK-052 / E1.1 — ADR-0020 supporting metric "context cost").
 *
 * Bounded, explicit-basis cost accounting for context/prompt/prefix
 * composition (Work Order AC 1). The estimation-basis contract of
 * WORK-049/050 is the SEAM: every segment and every pricing fact
 * carries an explicit `CostBasisAttribution`
 * (`observed` | `estimated` | `defaulted` + a bounded source), and
 * every produced estimate is a bounded micro-USD integer inside the
 * foundation's money universe. UNATTRIBUTED or UNBOUNDED claims are
 * rejected before they exist (typed `ContextEconomicsError`) —
 * invariant 5: "context-cost claims carry explicit bases and bounds;
 * unattributed claims are rejected".
 *
 * The measurement is a PURE function of (composition, pricing,
 * digest): deterministic, idempotent, content-addressed
 * (`measurementDigest` over the canonical form). No clock, no
 * randomness, no provider vocabulary — the per-token price is a
 * caller-supplied attributed fact, never a hard-coded provider
 * number.
 */

import { canonicalJson } from "../execution-ir/canonical";
import type { CostBasis, CostBasisAttribution } from "../execution-ir/cost-model";
import { COST_BASES, MAX_IR_COST_MICRO_USD } from "../execution-ir/cost-model";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  ATTRIBUTION_SOURCE_MAX,
  CONTEXT_SEGMENT_KINDS,
  type ContextSegmentKind,
  MAX_CONTEXT_SEGMENTS,
  MAX_SEGMENT_TOKENS,
  MAX_TOTAL_TOKENS,
  PREFIX_STABLE_KINDS,
  reject,
} from "./catalog";

// ---------------------------------------------------------------------------
// The composition (typed, bounded, attributed)
// ---------------------------------------------------------------------------

/** One context segment: a typed, attributed size measurement. */
export interface ContextSegment {
  readonly kind: ContextSegmentKind;
  /** Token count in [0, MAX_SEGMENT_TOKENS] (bounded integer). */
  readonly tokenCount: number;
  /** REQUIRED explicit estimation basis (unattributed is rejected). */
  readonly basis: CostBasisAttribution;
}

/** A bounded, ordered context composition. */
export interface ContextComposition {
  readonly segments: readonly ContextSegment[];
}

/** The attributed per-token pricing fact (caller-supplied). */
export interface ContextPricingBasis {
  /**
   * Integer micro-USD per MILLION tokens (the neutral pricing unit;
   * fractional per-token prices stay exact through BigInt).
   */
  readonly microUsdPerMillionTokens: string;
  /** REQUIRED explicit estimation basis for the price itself. */
  readonly basis: CostBasisAttribution;
}

/** The measurement input: composition + pricing. */
export interface ContextCostInput {
  readonly composition: ContextComposition;
  readonly pricing: ContextPricingBasis;
}

// ---------------------------------------------------------------------------
// Validation (total, deterministic, fail-closed)
// ---------------------------------------------------------------------------

const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;
const MAX_COST_BIGINT = BigInt(MAX_IR_COST_MICRO_USD);

/** Validate one estimation-basis attribution (the seam contract). */
export function validateBasisAttribution(value: unknown, what: string): CostBasisAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("context-cost-basis", `${what} must carry an estimation basis attribution`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.basis !== "string" ||
    !(COST_BASES as readonly string[]).includes(record.basis)
  ) {
    reject("context-cost-basis", `${what} basis is outside the closed estimation vocabulary`, {
      got: String(record.basis),
    });
  }
  if (
    typeof record.source !== "string" ||
    record.source.length === 0 ||
    record.source.length > ATTRIBUTION_SOURCE_MAX
  ) {
    reject("context-cost-basis", `${what} basis source must be bounded non-empty text`, {
      got: String(record.source),
    });
  }
  if (
    record.evidenceDigest !== undefined &&
    (typeof record.evidenceDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.evidenceDigest))
  ) {
    reject("context-cost-shape", `${what} basis evidenceDigest must be a sha256 hex digest`);
  }
  return {
    basis: record.basis as CostBasis,
    source: record.source as string,
    ...(record.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: record.evidenceDigest as string }),
  };
}

function validateTokenCount(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SEGMENT_TOKENS
  ) {
    reject("context-cost-bound", `${what} must be an integer in [0, ${MAX_SEGMENT_TOKENS}]`, {
      got: String(value),
    });
  }
  return value;
}

/** Total validation of a context composition. */
export function validateContextComposition(value: unknown): ContextComposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("context-cost-shape", "context composition must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.segments)) {
    reject("context-cost-shape", "context composition must carry a segments array");
  }
  if (record.segments.length > MAX_CONTEXT_SEGMENTS) {
    reject("context-cost-bound", "context composition exceeds the segment bound", {
      segments: record.segments.length,
      max: MAX_CONTEXT_SEGMENTS,
    });
  }
  let total = 0;
  const segments: ContextSegment[] = [];
  for (const [index, segment] of (record.segments as unknown[]).entries()) {
    if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
      reject("context-cost-shape", `context segment ${index} must be an object`);
    }
    const seg = segment as Record<string, unknown>;
    if (
      typeof seg.kind !== "string" ||
      !(CONTEXT_SEGMENT_KINDS as readonly string[]).includes(seg.kind)
    ) {
      reject(
        "context-cost-shape",
        `context segment ${index} kind is outside the closed vocabulary`,
        {
          got: String(seg.kind),
        },
      );
    }
    const tokenCount = validateTokenCount(seg.tokenCount, `context segment ${index} tokenCount`);
    total += tokenCount;
    if (total > MAX_TOTAL_TOKENS) {
      reject("context-cost-bound", "context composition total tokens exceed the bound", {
        total,
        max: MAX_TOTAL_TOKENS,
      });
    }
    segments.push({
      kind: seg.kind as ContextSegmentKind,
      tokenCount,
      basis: validateBasisAttribution(seg.basis, `context segment ${index} basis`),
    });
  }
  return { segments };
}

/** Total validation of the pricing fact. */
export function validateContextPricingBasis(value: unknown): ContextPricingBasis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("context-cost-shape", "context pricing must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.microUsdPerMillionTokens !== "string" ||
    !MICRO_USD_PATTERN.test(record.microUsdPerMillionTokens)
  ) {
    reject(
      "context-cost-bound",
      "context pricing microUsdPerMillionTokens must be an integer micro-USD string in [0, 10^18)",
      { got: String(record.microUsdPerMillionTokens) },
    );
  }
  return {
    microUsdPerMillionTokens: record.microUsdPerMillionTokens,
    basis: validateBasisAttribution(record.basis, "context pricing basis"),
  };
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/** The context-cost measurement (bounded, attributed, content-addressed). */
export interface ContextCostMeasurement {
  /** The content-addressed identity: sha256 over the canonical form. */
  readonly measurementDigest: string;
  readonly segmentCount: number;
  /** Total tokens across the composition (bounded). */
  readonly totalTokens: number;
  /** Per-kind token totals (closed vocabulary keys, zero-filled). */
  readonly tokensByKind: Readonly<Record<ContextSegmentKind, number>>;
  /** Tokens inside the maximal stable prefix (prefix-cache planning input). */
  readonly stablePrefixTokens: number;
  /** The number of leading stable-prefix segments. */
  readonly stablePrefixSegments: number;
  /**
   * The bounded micro-USD estimate: ceil(totalTokens × price / 10^6).
   */
  readonly expectedCostMicroUsd: string;
  /** The composite estimation basis of the estimate (explicit). */
  readonly basis: CostBasisAttribution;
}

/**
 * Measure the context cost of a composition under an attributed
 * pricing fact. PURE and deterministic: the same (composition,
 * pricing) always produce the identical measurement (including the
 * `measurementDigest`). Every claim is bounded and attributed or it
 * does not exist.
 *
 * The composite basis is derived by the closed basis lattice
 * (weakest wins, so the estimate never claims more certainty than
 * its weakest input): `observed` > `estimated` > `defaulted`.
 */
export function measureContextCost(
  input: ContextCostInput,
  digest: IrDigestPort,
): ContextCostMeasurement {
  const composition = validateContextComposition(input.composition);
  const pricing = validateContextPricingBasis(input.pricing);

  const tokensByKind = Object.fromEntries(CONTEXT_SEGMENT_KINDS.map((kind) => [kind, 0])) as Record<
    ContextSegmentKind,
    number
  >;
  let totalTokens = 0;
  for (const segment of composition.segments) {
    tokensByKind[segment.kind] += segment.tokenCount;
    totalTokens += segment.tokenCount;
  }

  // The maximal stable prefix: the leading run of stable kinds.
  let stablePrefixSegments = 0;
  let stablePrefixTokens = 0;
  for (const segment of composition.segments) {
    if (!PREFIX_STABLE_KINDS.includes(segment.kind)) {
      break;
    }
    stablePrefixSegments += 1;
    stablePrefixTokens += segment.tokenCount;
  }

  // The bounded money estimate: ceil(tokens × microUsdPerMillion / 10^6).
  const costBigint =
    (BigInt(totalTokens) * BigInt(pricing.microUsdPerMillionTokens) + 999_999n) / 1_000_000n;
  if (costBigint > MAX_COST_BIGINT) {
    reject("context-cost-bound", "context cost estimate exceeds the bounded money universe", {
      totalTokens,
      microUsdPerMillionTokens: pricing.microUsdPerMillionTokens,
    });
  }

  // The composite basis: the weakest input basis wins (the estimate
  // never claims more certainty than any of its inputs).
  const segmentBasisRanks = composition.segments.map((segment) =>
    COST_BASES.indexOf(segment.basis.basis),
  );
  const pricingRank = COST_BASES.indexOf(pricing.basis.basis);
  const compositeRank = Math.max(pricingRank, ...segmentBasisRanks, 0);
  const compositeBasis = COST_BASES[compositeRank] as CostBasis;
  const compositeSource = `context-cost.composite(${composition.segments.length} segments; price=${pricing.basis.source})`;

  const form = {
    segmentCount: composition.segments.length,
    totalTokens,
    tokensByKind,
    stablePrefixTokens,
    stablePrefixSegments,
    expectedCostMicroUsd: costBigint.toString(),
    basis: { basis: compositeBasis, source: compositeSource },
  };
  return {
    ...form,
    measurementDigest: digest.sha256Hex(canonicalJson(form)),
  };
}
