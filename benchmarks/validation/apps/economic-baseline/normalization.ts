/**
 * The normalization core (VAL-040, acceptance criteria 1 + 4).
 *
 * Every arm's HETEROGENEOUS pricing — per-token list prices in mixed
 * currencies and units, metered vs. batched metering, retry/failure
 * amortization — converges onto the program's canonical basis:
 * MICRO-USD COST PER SUCCESSFULLY RESOLVED OUTCOME.
 *
 * The convergence is mechanical and measured-facts-only (the VAL-006
 * accounting discipline extended to the cross-arm basis):
 *
 *   * CURRENCY: every usage fact's declared currency must match the
 *     pinned list-price entry's currency AND convert through the
 *     pinned manifest FX table — a fact denominated in a currency the
 *     manifest does not pin (or a raw sum of amounts across
 *     currencies, the classic conflation) FAILS to normalize and
 *     fails the row honestly;
 *   * UNIT: per-1M / per-1K / per-token prices reduce to an exact
 *     per-token rational (BigInt arithmetic — never floats), so the
 *     same token count prices identically whatever unit the provider
 *     publishes;
 *   * METERING: metered pricing charges the exact token count;
 *     batched pricing rounds usage UP to whole batch increments
 *     (ceil-to-batch) before pricing;
 *   * RETRY AMORTIZATION: failed attempts consume tokens too — their
 *     cost lands as `retry-overhead` scoped facts of the SAME run, so
 *     a resolved outcome's cost amortizes its retries (measured, in
 *     the same run's ledger);
 *   * MEASURED vs. ESTIMATE: measured facts and estimate facts are
 *     summed SEPARATELY and never conflated — cost-per-resolved is
 *     computed from MEASURED facts only, is NULL when nothing
 *     resolved (never zero), and a cost-per-resolution backed by
 *     estimates instead of measurements FAILS the comparison
 *     validation mechanically (the estimate-separation oracle).
 *
 * Everything here is PURE over the pinned manifest.
 */

import type { CostFact } from "../../recorder/record";
import {
  manifestRevisionOf,
  type PriceCurrency,
  type PriceManifestRevision,
  parseDecimal,
  resolveFxRate,
  resolveListPrice,
} from "./pricing";

// ---------------------------------------------------------------------------
// The usage vocabulary (what an executor observes per dispatch attempt)
// ---------------------------------------------------------------------------

/** One measured-or-estimated token usage fact from one dispatch attempt. */
export interface UsageFact {
  /** The provider rail the attempt rode (resolved in the manifest). */
  readonly provider: string;
  readonly model: string;
  readonly tier: "input" | "output";
  /**
   * The currency the attempt's usage is DENOMINATED in — must match
   * the pinned list-price entry's currency (a mismatch is the
   * mixed-currency conflation).
   */
  readonly currency: PriceCurrency;
  /** The token count consumed by the attempt (the metering input). */
  readonly tokens: number;
  /**
   * The accounting kind: MEASURED (a settled ledger fact — a real
   * dispatch's reported usage, or a recorded replay's settled fact)
   * or ESTIMATE (a planner/provider quote — reported separately,
   * NEVER conflated into cost-per-resolved).
   */
  readonly kind: "measured" | "estimate";
  /**
   * The cost scope: `direct-execution` for the round's final attempt
   * that produced the outcome, `retry-overhead` for failed attempts
   * the bounded retry policy absorbed (the amortization input).
   */
  readonly scope: "direct-execution" | "retry-overhead";
  /**
   * When the rail reported its OWN charge (a settled provider charge
   * in the declared currency), the decimal amount — recorded as a
   * cross-check observation; the canonical basis still prices the
   * measured tokens through the pinned manifest so every arm is
   * comparable at the SAME pinned list prices.
   */
  readonly chargedAmount?: string | null;
}

/** The normalized cost of one usage fact (micro-USD integer string). */
export interface NormalizedCost {
  readonly microUsd: string;
  readonly scope: UsageFact["scope"];
  readonly kind: UsageFact["kind"];
  readonly evidence: readonly string[];
}

/** One normalization failure (each FAILS the row's integrity criterion). */
export interface NormalizationFailure {
  readonly provider: string;
  readonly tier: UsageFact["tier"];
  readonly reason: string;
}

/** An arm's converged cost basis (measured and estimated, separate). */
export interface ArmCostBasis {
  /** Sum of MEASURED facts (micro-USD integer string). */
  readonly measuredMicroUsd: string;
  /** Sum of ESTIMATE facts (micro-USD integer string — reported separately). */
  readonly estimatedMicroUsd: string;
  /** The per-fact normalized costs (evidence order). */
  readonly facts: readonly NormalizedCost[];
  /** The normalization failures (a non-empty list FAILS the row). */
  readonly failures: readonly NormalizationFailure[];
}

// ---------------------------------------------------------------------------
// Exact micro-USD arithmetic (BigInt rationals — never floats)
// ---------------------------------------------------------------------------

/** Divide a BigInt rational, rounding half-up (deterministic). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("normalization denominator must be positive");
  }
  if (numerator >= 0n) {
    return (numerator * 2n + denominator) / (denominator * 2n);
  }
  return -((-numerator * 2n + denominator) / (denominator * 2n));
}

/** The token basis of one price unit (tokens per published unit). */
function unitBasisOf(unit: "per-1M-tokens" | "per-1K-tokens" | "per-token"): bigint {
  if (unit === "per-1M-tokens") {
    return 1_000_000n;
  }
  if (unit === "per-1K-tokens") {
    return 1_000n;
  }
  return 1n;
}

/**
 * Normalize one usage fact onto the canonical micro-USD basis
 * (PURE): resolve the pinned list-price entry, validate the declared
 * currency against BOTH the entry's currency and the pinned FX
 * table, reduce the unit to an exact per-token rational, apply the
 * metering semantics (ceil-to-batch for batched), and convert the
 * currency through the pinned FX rate — all in exact BigInt
 * arithmetic with one deterministic half-up rounding at the end.
 */
export function normalizeUsageFact(
  fact: UsageFact,
  manifest: PriceManifestRevision,
):
  | { readonly ok: true; readonly cost: NormalizedCost }
  | { readonly ok: false; readonly failure: NormalizationFailure } {
  const entry = resolveListPrice(manifest, fact.provider, fact.model, fact.tier);
  if (entry === null) {
    return {
      ok: false,
      failure: {
        provider: fact.provider,
        tier: fact.tier,
        reason:
          "UNPINNED PRICING: no pinned list-price entry for this provider/model/tier in the declared revision — the arm must price through the manifest",
      },
    };
  }
  if (fact.currency !== entry.currency) {
    return {
      ok: false,
      failure: {
        provider: fact.provider,
        tier: fact.tier,
        reason: `MIXED-CURRENCY CONFLATION: the usage fact declares ${fact.currency} but the pinned list price is denominated in ${entry.currency} — amounts must convert through the pinned FX table, never sum raw across currencies`,
      },
    };
  }
  const fx = resolveFxRate(manifest, fact.currency);
  if (fx === null) {
    return {
      ok: false,
      failure: {
        provider: fact.provider,
        tier: fact.tier,
        reason: `MIXED-CURRENCY CONFLATION: the currency ${fact.currency} is outside the pinned FX table — no ad-hoc conversion is permitted`,
      },
    };
  }
  const price = parseDecimal(entry.price);
  const rate = parseDecimal(fx.microUsdPerUnit);
  if (price === null || rate === null) {
    return {
      ok: false,
      failure: {
        provider: fact.provider,
        tier: fact.tier,
        reason: "the pinned price or FX rate is not a parseable decimal string",
      },
    };
  }
  if (!Number.isInteger(fact.tokens) || fact.tokens < 0) {
    return {
      ok: false,
      failure: {
        provider: fact.provider,
        tier: fact.tier,
        reason: `the token count must be a non-negative integer (observed ${fact.tokens})`,
      },
    };
  }
  // The metering semantics: metered charges the exact token count;
  // batched rounds usage UP to whole batch increments.
  const batch = entry.metering === "batched" ? BigInt(entry.batchSize ?? 1) : 1n;
  const tokens = BigInt(fact.tokens);
  const chargedTokens =
    entry.metering === "batched" ? ((tokens + batch - 1n) / batch) * batch : tokens;
  // micro-USD = price × (chargedTokens / unitBasis) × fxRate:
  // exact BigInt rational, one deterministic half-up rounding.
  //   price = priceDigits / 10^priceScale (currency per unitBasis tokens)
  //   fxRate = rateDigits / 10^rateScale (micro-USD per 1 currency unit)
  const numerator = price.digits * chargedTokens * rate.digits;
  const denominator =
    10n ** BigInt(price.scale) * unitBasisOf(entry.unit) * 10n ** BigInt(rate.scale);
  const microUsd = divRoundHalfUp(numerator, denominator);
  return {
    ok: true,
    cost: {
      microUsd: microUsd.toString(),
      scope: fact.scope,
      kind: fact.kind,
      evidence: [
        `provider:${fact.provider}`,
        `tier:${fact.tier}`,
        `currency:${fact.currency}`,
        `unit:${entry.unit}`,
        `metering:${entry.metering}`,
        `tokens:${fact.tokens}`,
        `chargedTokens:${chargedTokens.toString()}`,
        `price:${entry.price}`,
        `fxMicroUsdPerUnit:${fx.microUsdPerUnit}`,
        `microUsd:${microUsd.toString()}`,
        `kind:${fact.kind}`,
        `scope:${fact.scope}`,
        ...(fact.chargedAmount === undefined || fact.chargedAmount === null
          ? []
          : [
              `railChargeObserved:${fact.chargedAmount} ${fact.currency} (cross-check, not the basis)`,
            ]),
      ],
    },
  };
}

/**
 * Converge one arm's usage facts onto the canonical basis (PURE):
 * every fact normalizes (any failure fails the arm's integrity),
 * measured and estimated sums are kept SEPARATE, and the per-fact
 * evidence is preserved (digest references only — never payloads).
 */
export function normalizeArmCosts(
  facts: readonly UsageFact[],
  manifest: PriceManifestRevision,
): ArmCostBasis {
  let measured = 0n;
  let estimated = 0n;
  const normalized: NormalizedCost[] = [];
  const failures: NormalizationFailure[] = [];
  for (const fact of facts) {
    const outcome = normalizeUsageFact(fact, manifest);
    if (!outcome.ok) {
      failures.push(outcome.failure);
      continue;
    }
    normalized.push(outcome.cost);
    const amount = BigInt(outcome.cost.microUsd);
    if (fact.kind === "measured") {
      measured += amount;
    } else {
      estimated += amount;
    }
  }
  return {
    measuredMicroUsd: measured.toString(),
    estimatedMicroUsd: estimated.toString(),
    facts: normalized,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Cost-per-resolved (the VAL-006 discipline on the canonical basis)
// ---------------------------------------------------------------------------

/**
 * Derive the cost per SUCCESSFULLY resolved outcome (PURE — the
 * canonical basis' headline number): MEASURED facts divided by the
 * resolved count, NULL when nothing resolved (never zero, never
 * estimate-backed). The `estimateBacking` flag is raised when the
 * caller tried to substitute estimates for measurements — the
 * comparison validation FAILS on it mechanically.
 */
export function deriveCostPerResolved(input: {
  readonly measuredMicroUsd: string;
  readonly estimatedMicroUsd: string;
  readonly resolvedCount: number;
}): {
  readonly costPerResolvedMicroUsd: string | null;
  /** True when the input tried to back the number with estimates. */
  readonly estimateBacking: boolean;
  readonly evidence: readonly string[];
} {
  const measured = BigInt(input.measuredMicroUsd);
  const estimated = BigInt(input.estimatedMicroUsd);
  if (input.resolvedCount <= 0) {
    return {
      costPerResolvedMicroUsd: null,
      estimateBacking: false,
      evidence: [
        `measured:${input.measuredMicroUsd}`,
        `estimated:${input.estimatedMicroUsd}`,
        `resolved:${input.resolvedCount}`,
        "costPerResolved:NULL (nothing resolved — never zero, never estimate-backed)",
      ],
    };
  }
  if (measured === 0n && estimated > 0n) {
    // The estimate-backed shape: no measured fact settled, yet a
    // cost-per-resolution would be claimed — mechanically refused.
    return {
      costPerResolvedMicroUsd: null,
      estimateBacking: true,
      evidence: [
        `measured:${input.measuredMicroUsd}`,
        `estimated:${input.estimatedMicroUsd}`,
        `resolved:${input.resolvedCount}`,
        "costPerResolved:REFUSED (estimate-backed — measured facts are required, estimates are never conflated)",
      ],
    };
  }
  const perResolved = divRoundHalfUp(measured, BigInt(input.resolvedCount));
  return {
    costPerResolvedMicroUsd: perResolved.toString(),
    estimateBacking: false,
    evidence: [
      `measured:${input.measuredMicroUsd}`,
      `estimated:${input.estimatedMicroUsd}`,
      `resolved:${input.resolvedCount}`,
      `costPerResolved:${perResolved.toString()}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The accounting-rails projection (micro-USD CostFacts, VAL-004 shape)
// ---------------------------------------------------------------------------

/**
 * Project an arm's normalized cost basis onto the recorder's CostFact
 * shape (measured and estimate as SEPARATE kinds; the wire money
 * discipline: micro-USD integer strings). The source records the
 * pricing provenance — the pinned manifest revision that priced the
 * facts (replayed-record offline, rail-measured live).
 */
export function costFactsOf(basis: ArmCostBasis, source: string): readonly CostFact[] {
  const facts: CostFact[] = [];
  const measured = BigInt(basis.measuredMicroUsd);
  const estimated = BigInt(basis.estimatedMicroUsd);
  const direct = basis.facts
    .filter((fact) => fact.kind === "measured" && fact.scope === "direct-execution")
    .reduce((sum, fact) => sum + BigInt(fact.microUsd), 0n);
  const retry = basis.facts
    .filter((fact) => fact.kind === "measured" && fact.scope === "retry-overhead")
    .reduce((sum, fact) => sum + BigInt(fact.microUsd), 0n);
  if (direct > 0n) {
    facts.push({
      kind: "measured",
      amountMicroUsd: direct.toString(),
      source,
      scope: "direct-execution",
    });
  }
  if (retry > 0n) {
    facts.push({
      kind: "measured",
      amountMicroUsd: retry.toString(),
      source,
      scope: "retry-overhead",
    });
  }
  // The measured total is pinned as the run's settled total (the
  // direct + retry decomposition above is the amortization evidence).
  if (measured !== direct + retry) {
    // Defensive: the decomposition must always reconstruct the total.
    throw new Error("the cost decomposition must reconstruct the measured total");
  }
  if (estimated > 0n) {
    facts.push({
      kind: "estimate",
      amountMicroUsd: estimated.toString(),
      source,
      scope: "direct-execution",
    });
  }
  return facts;
}

/**
 * The manifest for a declared revision (the pricing oracle's
 * resolution — throws when the revision is unknown, since a run
 * against an unpinned revision has no basis at all).
 */
export function manifestFor(revision: string): PriceManifestRevision {
  const manifest = manifestRevisionOf(revision);
  if (manifest === null) {
    throw new Error(`the declared price revision ${revision} is not pinned in the manifest`);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// The pinned per-round budget bound (the BEFORE-dispatch gate input)
// ---------------------------------------------------------------------------

/**
 * Derive the worst-case micro-USD cost of ONE dispatch round, priced
 * from the pinned manifest (PURE): the declared max tokens priced at
 * BOTH the pinned input and output list prices (the conservative
 * bound — the fixed-cost arm's budget gate must never under-reserve).
 * Pinned list prices are deterministic PLANNING inputs; the arm's
 * accounting stays measured-facts-only (the bound gates dispatch,
 * never the ledger).
 */
export function deriveRoundBudgetBoundMicroUsd(input: {
  readonly manifest: PriceManifestRevision;
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
}): string {
  const bound = ["input", "output"]
    .map((tier) => {
      const entry = resolveListPrice(
        input.manifest,
        input.provider,
        input.model,
        tier as "input" | "output",
      );
      if (entry === null) {
        throw new Error(
          `no pinned list-price entry for ${input.provider}/${input.model}/${tier} in ${input.manifest.revision}`,
        );
      }
      const price = parseDecimal(entry.price);
      const fx = resolveFxRate(input.manifest, entry.currency);
      const rate = fx === null ? null : parseDecimal(fx.microUsdPerUnit);
      if (price === null || rate === null) {
        throw new Error(
          `the pinned price/FX entries failed to parse for ${input.provider}/${tier}`,
        );
      }
      const tokens = BigInt(Math.max(0, input.maxTokens));
      const numerator = price.digits * tokens * rate.digits;
      const denominator =
        10n ** BigInt(price.scale) * unitBasisOf(entry.unit) * 10n ** BigInt(rate.scale);
      return divRoundHalfUp(numerator, denominator);
    })
    .reduce((sum, term) => sum + term, 0n);
  return bound.toString();
}
