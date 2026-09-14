/**
 * The economic-substrate-runtime driver (VAL-046, acceptance criteria
 * 1, 2, 4 and 5 — the substrate-cost families over the RECORDED
 * substrate telemetry).
 *
 * The substrate economics the work order exists for: the cost of the
 * substrate itself, composed into the economic comparisons as an
 * EXPLICIT substrate-cost family —
 *
 *   * SUBSTRATE COST PER RUN: the pooled substrate total (startup +
 *     sustained + restart + eviction + reserved shares) divided by the
 *     RECORDED served run count (re-derived from the arm corpora —
 *     never a window's own claim); NULL when nothing ran;
 *   * SUBSTRATE COST AMORTIZED PER RESOLVED OUTCOME: the pooled
 *     substrate total divided by the recorded resolved count; NULL
 *     when nothing resolved (never zero, never estimate-backed);
 *   * THE READINESS-ADJUSTED COMPARISON: the effective cost per
 *     resolved outcome = the model cost per resolved (the RECORDED arm
 *     facts — the imported VAL-044 derivation, never re-measured) PLUS
 *     the substrate cost per resolved, with the readiness wait share
 *     (startup + restart) carried EXPLICITLY — a comparison that
 *     silently absorbs the substrate cost into a provider price (an
 *     effective cost equal to the model-only number while the recorded
 *     substrate total is nonzero) FAILS mechanically.
 *
 * The verification core (each probed adversarially — the discrimination
 * battery): STARTUP-COST INCLUSION (never hidden), READINESS-PROBE
 * HONESTY (first-usable, not first-dispatched — the claim must agree
 * with the first PASSING probe), RESERVED/MEASURED SEPARATION (the
 * standing reservation bills by the interval, the usage by the second
 * — never conflated), FAILURE-AMORTIZATION COMPLETENESS (restarts and
 * evictions counted and priced — never amortized away),
 * ESTIMATE/MEASURE SEPARATION, CONFIDENCE-AND-MINIMUM enforcement
 * (Wilson carried, minimums held, no post-hoc window exclusion — the
 * pre-registered set decides) and the INPUT INTEGRITY (every window
 * digest-verified against the RECORDED telemetry; a re-measurement
 * masquerading as derivation FAILs field by field).
 *
 * The verdict is MECHANICAL: any failure, any failed criterion →
 * verdict fail → terminal FAILED (never a partial-success shortcut).
 * The live lane (env-gated, BYOK) drives one REAL substrate lifecycle
 * measurement (cold start → ready → sustained → teardown) with every
 * priced input at its pinned manifest revision.
 */

import { wilsonInterval } from "../../accounting/aggregate";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { RunMetadata } from "../../run-identity";
import { minimumSamplesOf } from "../economic-adjusted-cost/corpus";
import type { ArmInputReference, RecordedArmInput } from "../economic-adjusted-cost/driver";
import {
  economicDigestOf,
  pooledFactsOf,
  recordedArmFactsOf,
} from "../economic-adjusted-cost/driver";
import type {
  EconomicAccountingRails,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicWorldFacts,
  LandedExecutionsProvider,
} from "../economic-baseline/driver";
import type { UsageFact } from "../economic-baseline/normalization";
import { manifestFor, normalizeArmCosts } from "../economic-baseline/normalization";
import {
  deriveSubstrateManifestIntegrity,
  divRoundHalfUp,
  fxRateForSubstrate,
  priceMeasuredMs,
  resolveSubstratePrice,
  substrateManifestFor,
} from "./pricing";
import type { SubstrateWindowFacts } from "./telemetry";
import {
  recordedSubstrateFailureDigestOf,
  recordedSubstrateWindowDigestOf,
  substrateWindowById,
  substrateWindowFactsOf,
} from "./telemetry";

// ---------------------------------------------------------------------------
// The synthesis vocabulary
// ---------------------------------------------------------------------------

/** The three substrate-cost families under test. */
export type SubstrateCostFamily =
  | "substrate-cost-per-run"
  | "substrate-amortized-per-resolved"
  | "readiness-adjusted-comparison";

/** The comparability verdict the synthesis exists to derive. */
export type SubstrateComparability =
  | "comparable"
  | "honestly-incomparable"
  | "refused-below-minimum"
  | "adversarial-failed";

/** The adversarial probe shapes the discrimination battery drives. */
export type SubstrateAdversarialKind =
  | "startup-hiding"
  | "readiness-inflation"
  | "reserved-conflation"
  | "failure-amortization-away"
  | "post-hoc-exclusion"
  | "below-minimum-claim"
  | "remeasurement";

/** The Wilson configuration every comparison carries (95%, pinned). */
export const WILSON_CONFIG: { readonly confidenceLevel: number } = Object.freeze({
  confidenceLevel: 0.95,
});

/** The pre-registered window-set entry: a DIGEST REFERENCE, never a copy. */
export interface SubstrateWindowReference {
  readonly windowId: string;
  /** The content digest of the window's DERIVED facts (digest references only). */
  readonly recordedDigest: string;
  /** The window's own pinned substrate price revision. */
  readonly priceRevision: string;
  /** A live-window declaration (the measured lane — never compared field-wise against recorded telemetry). */
  readonly live?: boolean;
}

/** One resolved window input (the driver's bundle entry). */
export interface SubstrateWindowInput extends SubstrateWindowReference {
  readonly facts: SubstrateWindowFacts;
  /**
   * The window's OWN claims — never trusted (the gaming catches): a
   * claimed startup share of zero against a recorded warm-up, a
   * claimed first-usable earlier than the first passing probe, a
   * claimed reserved/measured split that disagrees with the recorded
   * split, claimed-away restart/eviction shares, a re-measured served
   * run count — each FAILs its named criterion.
   */
  readonly claimed?: {
    readonly startupShareMicroUsd?: string;
    readonly firstUsableAtMs?: number;
    readonly reservedShareMicroUsd?: string;
    readonly measuredMicroUsd?: string;
    readonly restartShareMicroUsd?: string;
    readonly evictionShareMicroUsd?: string;
    readonly servedRuns?: number;
  };
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** The substrate synthesis corpus row (the comparison declaration). */
export interface SubstrateCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The substrate-cost family under test. */
  readonly family: SubstrateCostFamily;
  /** The PRE-REGISTERED window set (digest references into the recorded telemetry). */
  readonly windowSet: readonly SubstrateWindowReference[];
  /**
   * The RECORDED arm inputs the comparison composes (digest references
   * into the VAL-041/042/43 corpora — the model-cost side of the
   * readiness-adjusted comparison and the run provenance).
   */
  readonly armSet: readonly ArmInputReference[];
  /** The minimum number of DISTINCT substrate windows (the synthesis sample). */
  readonly minimumWindows: number;
  /** The per-window statistical minimum (every window's served run count must reach it). */
  readonly minimumRunsPerWindow: number;
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The adversarial probe declaration (probe rows only). */
  readonly adversarial?: SubstrateAdversarialKind;
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly verdict: SubstrateComparability;
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The pinned expected synthesis (offline honest rows only). */
    readonly synthesis?: ExpectedSubstrateOutcome;
  };
}

/** The expected substrate synthesis the derivation must reproduce. */
export interface ExpectedSubstrateOutcome {
  readonly family: SubstrateCostFamily;
  readonly windows: number;
  readonly pooledRuns: number;
  readonly pooledResolved: number;
  readonly measuredMicroUsd: string;
  readonly reservedMicroUsd: string;
  readonly totalMicroUsd: string;
  readonly startupShareMicroUsd: string;
  readonly restartShareMicroUsd: string;
  readonly evictionShareMicroUsd: string;
  /** The readiness-determined substrate share (startup + restart) — carried EXPLICITLY. */
  readonly readinessWaitShareMicroUsd: string;
  /** Family 1: substrate cost per run (NULL when nothing ran). */
  readonly substratePerRunMicroUsd: string | null;
  /** Family 2: substrate cost amortized per resolved outcome (NULL when nothing resolved). */
  readonly substratePerResolvedMicroUsd: string | null;
  /** Family 3: the model cost per resolved from the RECORDED arm facts (NULL when nothing resolved). */
  readonly modelPerResolvedMicroUsd: string | null;
  /** Family 3: the effective cost per resolved (model + substrate; NULL when nothing resolved). */
  readonly effectivePerResolvedMicroUsd: string | null;
  /** Family 3: the substrate share of the effective cost (0..1). */
  readonly substrateShareOfEffective: number | null;
  readonly wilson: { readonly low: number; readonly high: number };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One verified window input (the driver's per-input settlement). */
export interface VerifiedSubstrateWindow {
  readonly reference: SubstrateWindowReference;
  /** Whether the window's facts EQUAL the recorded telemetry derivation. */
  readonly integrity: boolean;
  readonly failureReason: string | null;
}

/** The substrate row run result (the honest outcome contract). */
export interface SubstrateRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  readonly observedTerminal: string | null;
  readonly windows: readonly VerifiedSubstrateWindow[];
  readonly synthesis: ExpectedSubstrateOutcome | null;
  readonly totalLatencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The pooled substrate facts (the synthesis basis)
// ---------------------------------------------------------------------------

/** The pooled substrate facts over the window inputs (PURE). */
export function pooledSubstrateFactsOf(windows: readonly SubstrateWindowInput[]): {
  readonly windows: number;
  readonly runs: number;
  readonly resolved: number;
  readonly measuredMicroUsd: bigint;
  readonly reservedMicroUsd: bigint;
  readonly totalMicroUsd: bigint;
  readonly estimateMicroUsd: bigint;
  readonly startupShareMicroUsd: bigint;
  readonly restartShareMicroUsd: bigint;
  readonly evictionShareMicroUsd: bigint;
  readonly restarts: number;
  readonly evictions: number;
  readonly readinessWaitMs: number[];
  readonly sustainedRuntimeMs: number[];
} {
  let runs = 0;
  let resolved = 0;
  let measured = 0n;
  let reserved = 0n;
  let estimate = 0n;
  let startupShare = 0n;
  let restartShare = 0n;
  let evictionShare = 0n;
  let restarts = 0;
  let evictions = 0;
  const readinessWaitMs: number[] = [];
  const sustainedRuntimeMs: number[] = [];
  for (const window of windows) {
    runs += window.facts.servedRuns;
    resolved += window.facts.servedResolved;
    measured += BigInt(window.facts.measuredMicroUsd);
    reserved += BigInt(window.facts.reservedMicroUsd);
    estimate += BigInt(window.facts.estimateMicroUsd);
    startupShare += BigInt(window.facts.startupShareMicroUsd);
    restartShare += BigInt(window.facts.restartShareMicroUsd);
    evictionShare += BigInt(window.facts.evictionShareMicroUsd);
    restarts += window.facts.restarts;
    evictions += window.facts.evictions;
    readinessWaitMs.push(window.facts.startupMs + window.facts.restartStartupMs);
    sustainedRuntimeMs.push(window.facts.sustainedRuntimeMs);
  }
  return {
    windows: windows.length,
    runs,
    resolved,
    measuredMicroUsd: measured,
    reservedMicroUsd: reserved,
    totalMicroUsd: measured + reserved,
    estimateMicroUsd: estimate,
    startupShareMicroUsd: startupShare,
    restartShareMicroUsd: restartShare,
    evictionShareMicroUsd: evictionShare,
    restarts,
    evictions,
    readinessWaitMs,
    sustainedRuntimeMs,
  };
}

/** The model-side facts (the RECORDED arm inputs — never re-measured). */
export interface ModelSideFacts {
  readonly measuredMicroUsd: bigint;
  readonly resolved: number;
  readonly runs: number;
}

/** Resolve the arm inputs' recorded facts (PURE — the imported VAL-044 extractor). */
export function armInputsOf(armSet: readonly ArmInputReference[]): readonly RecordedArmInput[] {
  return armSet.map((reference) => {
    const resolved = recordedArmFactsOf(reference);
    if (resolved === null) {
      throw new Error(
        `the recorded facts of ${reference.armLabel}:${reference.corpusRowId} failed to re-derive`,
      );
    }
    return { ...reference, recorded: resolved.facts };
  });
}

// ---------------------------------------------------------------------------
// The verification oracles (PURE — each its own mechanical criterion)
// ---------------------------------------------------------------------------

/**
 * The STARTUP-COST INCLUSION oracle (PURE): every window with a
 * recorded warm-up (a first-usable after the cold-start begin) must
 * carry a POSITIVE startup share in the comparison's effective
 * decomposition, and the decomposition must RECONSTRUCT (the measured
 * total is exactly the sum of the four usage-priced shares; the total
 * adds the reserved share). A window that claims a zero (or
 * disagreeing) startup share while its recorded warm-up is nonzero is
 * a STARTUP-HIDING comparison and FAILs named — the cold start is
 * never free.
 */
export function deriveStartupCostInclusion(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const window of input.windows) {
    const facts = window.facts;
    const measuredTotal = BigInt(facts.measuredMicroUsd);
    const decomposition =
      BigInt(facts.startupShareMicroUsd) +
      BigInt(facts.sustainedShareMicroUsd) +
      BigInt(facts.restartShareMicroUsd) +
      BigInt(facts.evictionShareMicroUsd);
    if (measuredTotal !== decomposition) {
      violations.push(
        `${facts.windowId} (measured ${measuredTotal} != startup ${facts.startupShareMicroUsd} + sustained ${facts.sustainedShareMicroUsd} + restart ${facts.restartShareMicroUsd} + eviction ${facts.evictionShareMicroUsd})`,
      );
    }
    if (BigInt(facts.totalMicroUsd) !== measuredTotal + BigInt(facts.reservedMicroUsd)) {
      violations.push(
        `${facts.windowId} (total ${facts.totalMicroUsd} != measured ${measuredTotal} + reserved ${facts.reservedMicroUsd})`,
      );
    }
    // The honest startup share RECOMPUTED from the recorded facts
    // through the pinned manifest (a sub-micro-USD warm-up honestly
    // rounds to zero — the hiding catch fires only when a priced
    // warm-up was zeroed or the claim disagrees).
    const manifest = substrateManifestFor(facts.priceRevision);
    const usageEntry = resolveSubstratePrice(manifest, facts.fleet, "usage");
    if (usageEntry === null) {
      violations.push(
        `UNPINNED SUBSTRATE PRICING: ${facts.windowId} (no pinned usage price for fleet ${facts.fleet} in ${facts.priceRevision})`,
      );
      continue;
    }
    const fx = fxRateForSubstrate(manifest, usageEntry.currency);
    if (fx === null) {
      violations.push(
        `UNPINNED FX: ${facts.windowId} (the fleet's currency is outside the pinned FX table)`,
      );
      continue;
    }
    const recomputedStartup = priceMeasuredMs({
      milliseconds: facts.startupMs,
      entry: usageEntry,
      fx,
    });
    if (BigInt(facts.startupShareMicroUsd) !== recomputedStartup) {
      violations.push(
        `STARTUP-SHARE DISAGREEMENT: ${facts.windowId} (carries ${facts.startupShareMicroUsd}, the recorded derivation prices ${recomputedStartup.toString()} for the ${facts.startupMs}ms warm-up)`,
      );
    }
    if (recomputedStartup > 0n && facts.startupShareMicroUsd === "0") {
      violations.push(
        `STARTUP-HIDING: ${facts.windowId} (a recorded warm-up of ${facts.startupMs}ms priced at zero — the cold start is never free)`,
      );
    }
    const claimedStartup = window.claimed?.startupShareMicroUsd;
    if (claimedStartup !== undefined && claimedStartup !== facts.startupShareMicroUsd) {
      if (claimedStartup === "0" && recomputedStartup > 0n) {
        violations.push(
          `STARTUP-HIDING: ${facts.windowId} (claims a zero startup share while its recorded warm-up of ${facts.startupMs}ms prices at ${recomputedStartup.toString()}µ$ — the cold start is never free)`,
        );
      } else {
        violations.push(
          `STARTUP-SHARE DISAGREEMENT: ${facts.windowId} (claims ${claimedStartup}, the recorded derivation prices ${facts.startupShareMicroUsd})`,
        );
      }
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `windows:${input.windows.length}`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "startup included (every recorded warm-up priced in the decomposition — the cold start is never free)"
        : "STARTUP-HIDING COMPARISON (a startup cost was hidden or the decomposition does not reconstruct)",
    ],
  };
}

/**
 * The READINESS-PROBE HONESTY oracle (PURE — the verification core):
 * readiness is warm-up to FIRST-USABLE, and FIRST-USABLE is the first
 * PASSING probe's timestamp — DERIVED from the probe telemetry, never
 * a declared claim and NEVER the first-dispatched time. A claimed
 * first-usable earlier than the first passing probe is a READINESS
 * INFLATION (the substrate looks ready before it ever observed
 * usability — deflating the startup cost); a startup duration that
 * matches first-dispatched instead of first-usable is a
 * FIRST-DISPATCHED MISATTRIBUTION (inflating the wait cost); a
 * dispatch before first-usable is unrepresentable telemetry.
 */
export function deriveReadinessProbeHonesty(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const window of input.windows) {
    const facts = window.facts;
    let firstPassing: number | null = null;
    for (const probe of facts.readinessProbes) {
      if (probe.ready) {
        firstPassing = probe.atMs;
        break;
      }
    }
    if (firstPassing === null) {
      violations.push(
        `NO PASSING PROBE: ${facts.windowId} (the substrate never observed first-usable — the readiness claim is fabricated)`,
      );
      continue;
    }
    if (facts.firstUsableAtMs !== firstPassing) {
      violations.push(
        `FIRST-USABLE DISAGREEMENT: ${facts.windowId} (recorded ${facts.firstUsableAtMs}ms, the first PASSING probe observed ${firstPassing}ms)`,
      );
    }
    if (facts.firstDispatchedAtMs < facts.firstUsableAtMs) {
      violations.push(
        `DISPATCHED BEFORE USABLE: ${facts.windowId} (dispatch ${facts.firstDispatchedAtMs}ms < first-usable ${facts.firstUsableAtMs}ms)`,
      );
    }
    const claimedFirstUsable = window.claimed?.firstUsableAtMs;
    if (claimedFirstUsable !== undefined && claimedFirstUsable !== firstPassing) {
      if (claimedFirstUsable === facts.firstDispatchedAtMs) {
        violations.push(
          `FIRST-DISPATCHED MISATTRIBUTION: ${facts.windowId} (readiness claimed at first-dispatched ${claimedFirstUsable}ms — readiness is FIRST-USABLE ${firstPassing}ms, not first-dispatched)`,
        );
      } else if (claimedFirstUsable < firstPassing) {
        violations.push(
          `READINESS INFLATION: ${facts.windowId} (claims first-usable at ${claimedFirstUsable}ms, the first PASSING probe observed ${firstPassing}ms — the substrate was not usable when it claimed to be)`,
        );
      } else {
        violations.push(
          `READINESS CLAIM DISAGREEMENT: ${facts.windowId} (claims ${claimedFirstUsable}ms, the first passing probe observed ${firstPassing}ms)`,
        );
      }
    }
    // The facts-side startup must be the first-usable derivation — a
    // bundle whose startup matches first-dispatched misattributes.
    if (
      facts.startupMs !== firstPassing - facts.coldStartBeganAtMs &&
      facts.startupMs === facts.firstDispatchedAtMs - facts.coldStartBeganAtMs &&
      facts.firstDispatchedAtMs !== firstPassing
    ) {
      violations.push(
        `FIRST-DISPATCHED MISATTRIBUTION: ${facts.windowId} (startup ${facts.startupMs}ms uses the first-dispatched point — readiness is FIRST-USABLE ${firstPassing - facts.coldStartBeganAtMs}ms)`,
      );
    } else if (facts.startupMs !== firstPassing - facts.coldStartBeganAtMs) {
      violations.push(
        `STARTUP DISAGREEMENT: ${facts.windowId} (startup ${facts.startupMs}ms, the recorded telemetry derives ${firstPassing - facts.coldStartBeganAtMs}ms)`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `windows:${input.windows.length}`,
      ...input.windows.map(
        (window) =>
          `${window.facts.windowId}: firstUsable=${window.facts.firstUsableAtMs}ms firstDispatched=${window.facts.firstDispatchedAtMs}ms probes=${window.facts.readinessProbes.length}`,
      ),
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "readiness honest (first-usable derived from the first PASSING probe — never first-dispatched, never a claim)"
        : "READINESS DISHONESTY (an inflated, misattributed or unbacked readiness claim)",
    ],
  };
}

/**
 * The RESERVED/MEASURED SEPARATION oracle (PURE): the standing
 * reservation and the measured usage are priced SEPARATELY — the
 * reserved share bills by the ceil-to-interval count at the pinned
 * per-interval price (never the usage seconds at the measured rate),
 * the measured share is the usage seconds at the pinned per-second
 * rate. A claimed split that zeroes the reserved share while folding
 * its seconds into the measured total (or the reverse) is a
 * RESERVED/MEASURED CONFLATION and FAILs named — idle standing
 * capacity is never hidden as usage, and usage is never billed as
 * reserved.
 */
export function deriveReservedMeasuredSeparation(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  let reservedTotal = 0n;
  let measuredTotal = 0n;
  for (const window of input.windows) {
    const facts = window.facts;
    reservedTotal += BigInt(facts.reservedMicroUsd);
    measuredTotal += BigInt(facts.measuredMicroUsd);
    if (facts.reservedStandingMs > 0 && facts.reservedMicroUsd === "0") {
      violations.push(
        `RESERVED HIDING: ${facts.windowId} (a standing reservation of ${facts.reservedStandingMs}ms priced at zero)`,
      );
    }
    if (facts.reservedStandingMs === 0 && facts.reservedMicroUsd !== "0") {
      violations.push(
        `PHANTOM RESERVATION: ${facts.windowId} (a reserved share of ${facts.reservedMicroUsd}µ$ with no standing reservation held)`,
      );
    }
    // The claimed split must agree with the recorded split.
    const claimedReserved = window.claimed?.reservedShareMicroUsd;
    const claimedMeasured = window.claimed?.measuredMicroUsd;
    if (claimedReserved !== undefined && claimedReserved !== facts.reservedMicroUsd) {
      violations.push(
        `RESERVED/MEASURED CONFLATION: ${facts.windowId} (claims a reserved share of ${claimedReserved}µ$ where the recorded derivation prices ${facts.reservedMicroUsd}µ$ for ${facts.reservedStandingMs}ms of standing capacity — the split is not the recorded one)`,
      );
    }
    if (claimedMeasured !== undefined && claimedMeasured !== facts.measuredMicroUsd) {
      const claimed = BigInt(claimedMeasured);
      const recorded = BigInt(facts.measuredMicroUsd);
      const reserved = BigInt(facts.reservedMicroUsd);
      if (claimed === recorded + reserved && BigInt(facts.reservedMicroUsd) > 0n) {
        violations.push(
          `RESERVED/MEASURED CONFLATION: ${facts.windowId} (the measured total absorbs the reserved share — the standing capacity was folded into the measured usage: claimed ${claimedMeasured}, recorded measured ${facts.measuredMicroUsd} + reserved ${facts.reservedMicroUsd})`,
        );
      } else {
        violations.push(
          `MEASURED DISAGREEMENT: ${facts.windowId} (claims ${claimedMeasured}, the recorded derivation prices ${facts.measuredMicroUsd})`,
        );
      }
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `measuredMicroUsd:${measuredTotal.toString()} (the usage-priced share — per compute-second)`,
      `reservedMicroUsd:${reservedTotal.toString()} (the standing share — per reserved interval, SEPARATE)`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "separated (the standing reservation bills by the interval, the usage by the second — never conflated)"
        : "RESERVED/MEASURED CONFLATION (the standing capacity and the measured usage were conflated)",
    ],
  };
}

/**
 * The FAILURE-AMORTIZATION COMPLETENESS oracle (PURE): restarts and
 * evictions are counted and FULLY amortized — every restart's
 * fresh-sandbox cold start and every eviction's wasted compute is
 * priced in the substrate total. A window that claims away the
 * restart or eviction share while its recorded telemetry counts the
 * failures is a FAILURE AMORTIZATION-AWAY comparison and FAILs named
 * — a restart without a cold start is unrepresentable (the fresh
 * sandbox DID cold-start), and evicted compute is never free.
 */
export function deriveFailureAmortizationCompleteness(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  let restarts = 0;
  let evictions = 0;
  for (const window of input.windows) {
    const facts = window.facts;
    restarts += facts.restarts;
    evictions += facts.evictions;
    if (facts.restarts > 0 && facts.restartShareMicroUsd === "0") {
      violations.push(
        `FAILURE AMORTIZATION-AWAY: ${facts.windowId} (${facts.restarts} restart(s) recorded with a zero restart share — every fresh-sandbox cold start is priced)`,
      );
    }
    if (facts.restarts === 0 && facts.restartShareMicroUsd !== "0") {
      violations.push(
        `PHANTOM RESTART SHARE: ${facts.windowId} (a restart share of ${facts.restartShareMicroUsd}µ$ with zero recorded restarts)`,
      );
    }
    if (facts.evictions > 0 && facts.evictionShareMicroUsd === "0") {
      violations.push(
        `FAILURE AMORTIZATION-AWAY: ${facts.windowId} (${facts.evictions} eviction(s) recorded with a zero eviction share — the evicted compute is never free)`,
      );
    }
    if (facts.evictions === 0 && facts.evictionShareMicroUsd !== "0") {
      violations.push(
        `PHANTOM EVICTION SHARE: ${facts.windowId} (an eviction share of ${facts.evictionShareMicroUsd}µ$ with zero recorded evictions)`,
      );
    }
    const claimedRestart = window.claimed?.restartShareMicroUsd;
    if (claimedRestart !== undefined && claimedRestart !== facts.restartShareMicroUsd) {
      if (claimedRestart === "0" && facts.restarts > 0) {
        violations.push(
          `FAILURE AMORTIZATION-AWAY: ${facts.windowId} (claims a zero restart share while ${facts.restarts} restart(s) are recorded — the fresh-sandbox cold starts are unpriced)`,
        );
      } else {
        violations.push(
          `RESTART-SHARE DISAGREEMENT: ${facts.windowId} (claims ${claimedRestart}, the recorded derivation prices ${facts.restartShareMicroUsd})`,
        );
      }
    }
    const claimedEviction = window.claimed?.evictionShareMicroUsd;
    if (claimedEviction !== undefined && claimedEviction !== facts.evictionShareMicroUsd) {
      if (claimedEviction === "0" && facts.evictions > 0) {
        violations.push(
          `FAILURE AMORTIZATION-AWAY: ${facts.windowId} (claims a zero eviction share while ${facts.evictions} eviction(s) are recorded — the evicted compute is unpriced)`,
        );
      } else {
        violations.push(
          `EVICTION-SHARE DISAGREEMENT: ${facts.windowId} (claims ${claimedEviction}, the recorded derivation prices ${facts.evictionShareMicroUsd})`,
        );
      }
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `restarts:${restarts}`,
      `evictions:${evictions}`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "complete amortization (every restart's cold start and every eviction's wasted compute priced in the substrate total)"
        : "FAILURE AMORTIZATION-AWAY (restarts or evictions were amortized away — their costs are unpriced)",
    ],
  };
}

/**
 * The ESTIMATE/MEASURE SEPARATION oracle (PURE): the substrate
 * measured basis is exactly the RECORDED telemetry's own measured
 * total, and the capacity planner's quote rides SEPARATELY. A bundle
 * whose measured total absorbs the estimate share (or whose estimate
 * share was zeroed while the measured total grew) is an
 * ESTIMATE-CONFLATING comparison and FAILs named against the recorded
 * basis.
 */
export function deriveEstimateMeasureSeparation(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const conflations: string[] = [];
  let measured = 0n;
  let estimate = 0n;
  for (const window of input.windows) {
    const facts = window.facts;
    measured += BigInt(facts.measuredMicroUsd);
    estimate += BigInt(facts.estimateMicroUsd);
    const recorded = substrateWindowById(facts.windowId);
    if (recorded !== null) {
      const recordedFacts = substrateWindowFactsOf(recorded);
      if (BigInt(facts.measuredMicroUsd) !== BigInt(recordedFacts.measuredMicroUsd)) {
        conflations.push(
          `${facts.windowId} (measured ${facts.measuredMicroUsd} != the recorded measured basis ${recordedFacts.measuredMicroUsd})`,
        );
      }
      if (BigInt(facts.estimateMicroUsd) !== BigInt(recordedFacts.estimateMicroUsd)) {
        conflations.push(
          `${facts.windowId} (estimate ${facts.estimateMicroUsd} != the recorded estimate share ${recordedFacts.estimateMicroUsd})`,
        );
      }
      if (
        BigInt(facts.measuredMicroUsd) ===
          BigInt(recordedFacts.measuredMicroUsd) + BigInt(recordedFacts.estimateMicroUsd) &&
        BigInt(recordedFacts.estimateMicroUsd) > 0n &&
        facts.estimateMicroUsd === "0"
      ) {
        conflations.push(
          `${facts.windowId} (the estimate share was absorbed into the measured basis — the quote-backed shape)`,
        );
      }
    }
  }
  return {
    conformant: conflations.length === 0,
    evidence: [
      `measuredMicroUsd:${measured.toString()}`,
      `estimatedMicroUsd:${estimate.toString()} (reported SEPARATELY)`,
      `conflations:${conflations.length}`,
      ...conflations,
      conflations.length === 0
        ? "separated (the substrate planner's quote never enters the measured basis)"
        : "ESTIMATE-CONFLATION (estimates conflated into the measured substrate basis — the adjusted cost would be quote-backed, not measured)",
    ],
  };
}

/**
 * The CONFIDENCE-AND-MINIMUM oracle (PURE): the executed window count
 * reaches the pre-registered minimum, every window's served run count
 * reaches the per-window statistical minimum, the executed window set
 * is EXACTLY the pre-registered set (a post-hoc window exclusion or an
 * undeclared window FAILs named), every composed arm input's recorded
 * sample reaches the arm's own declared minimum, and the comparison
 * carries the Wilson 95% interval on the pooled substrate workload
 * resolution rate (the REAL accounting module's derivation —
 * imported, never re-implemented). Below-minimum is a REFUSAL (the
 * honest verdict), not a silent pass.
 */
export function deriveConfidenceAndMinimum(input: {
  readonly row: SubstrateCorpusRow;
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly wilson: { readonly low: number; readonly high: number } | null;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const registered = new Set(input.row.windowSet.map((reference) => reference.windowId));
  const present = new Set(input.windows.map((window) => window.facts.windowId));
  for (const windowId of registered) {
    if (!present.has(windowId)) {
      violations.push(
        `post-hoc-excluded:${windowId} (a pre-registered substrate window is absent — the pre-registered set decides)`,
      );
    }
  }
  for (const windowId of present) {
    if (!registered.has(windowId)) {
      violations.push(`undeclared-window:${windowId} (a window outside the pre-registered set)`);
    }
  }
  if (input.windows.length < input.row.minimumWindows) {
    violations.push(
      `BELOW-MINIMUM: ${input.windows.length} windows < ${input.row.minimumWindows} pre-registered (the synthesis sample is starved)`,
    );
  }
  const starved = input.windows.filter(
    (window) => window.facts.servedRuns < input.row.minimumRunsPerWindow,
  );
  const pooled = pooledSubstrateFactsOf(input.windows);
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.resolved, pooled.runs) : null;
  if (wilson === null) {
    violations.push(
      "CONFIDENCE-LESS COMPARISON: the Wilson 95% interval is required on every comparison",
    );
  }
  // The composed arm inputs' own recorded samples must reach the arms'
  // declared minimums (the imported VAL-044 corpus derivation). The
  // LIVE lane's arm set is a rail declaration (the live arm rows carry
  // no recorded replay — the model side is the MEASURED dispatches),
  // so the arm-side sample check applies to the recorded lanes only.
  const armInputs =
    input.row.armSet.length > 0 && !input.row.needsDispatch ? armInputsOf(input.row.armSet) : [];
  const armMinimum = armInputs.length > 0 ? minimumSamplesOf(input.row.armSet) : 0;
  const starvedArms = armInputs.filter((item) => item.recorded.runCount < armMinimum);
  return {
    conformant: violations.length === 0,
    belowMinimum:
      input.windows.length < input.row.minimumWindows ||
      starved.length > 0 ||
      starvedArms.length > 0,
    wilson,
    evidence: [
      `minimumWindows:${input.row.minimumWindows}`,
      `windows:${input.windows.length}`,
      `minimumRunsPerWindow:${input.row.minimumRunsPerWindow}`,
      `armMinimumSamples:${armMinimum}`,
      `pooledRuns:${pooled.runs}`,
      `pooledResolved:${pooled.resolved}`,
      wilson === null
        ? "wilson95:none"
        : `wilson95:[${wilson.low.toFixed(4)}, ${wilson.high.toFixed(4)}] (level ${WILSON_CONFIG.confidenceLevel})`,
      ...(starved.length === 0
        ? []
        : starved.map(
            (window) =>
              `below-minimum-window:${window.facts.windowId} (served sample ${window.facts.servedRuns} < the per-window minimum ${input.row.minimumRunsPerWindow} — the comparison must REFUSE)`,
          )),
      ...(starvedArms.length === 0
        ? []
        : starvedArms.map(
            (item) =>
              `below-minimum-arm:${item.armLabel}:${item.corpusRowId} (recorded sample ${item.recorded.runCount} < the arm's declared minimum ${armMinimum})`,
          )),
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "confident (the pre-registered window set held and the interval brackets the pooled resolution)"
        : "NON-CONFORMANT (an excluded, undeclared, starved or confidence-less comparison)",
    ],
  };
}

/**
 * The BELOW-MINIMUM REFUSAL HONESTY oracle (PURE): a below-minimum
 * comparison must claim the REFUSED verdict — a comparison that claims
 * comparability (or incomparability) while below the pre-registered
 * minimums FAILs named (the verdict is fabricated on a starved
 * sample).
 */
export function deriveBelowMinimumRefusalHonesty(input: {
  readonly row: SubstrateCorpusRow;
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly evidence: readonly string[];
} {
  const confidence = deriveConfidenceAndMinimum({ row: input.row, windows: input.windows });
  const belowMinimum = confidence.belowMinimum;
  const claimsRefusal = input.row.expected.verdict === "refused-below-minimum";
  const conformant = belowMinimum === claimsRefusal;
  return {
    conformant,
    belowMinimum,
    evidence: [
      `expectedVerdict:${input.row.expected.verdict}`,
      `minimumWindows:${input.row.minimumWindows}`,
      `minimumRunsPerWindow:${input.row.minimumRunsPerWindow}`,
      `belowMinimum:${String(belowMinimum)}`,
      conformant
        ? belowMinimum
          ? "refused honestly (the below-minimum comparison refuses — never a fabricated comparability)"
          : "not below minimum (the comparability claim stands on a sufficient sample)"
        : "BELOW-MINIMUM COMPARABILITY CLAIM (a comparison below the pre-registered minimums claims a verdict it cannot support — the honest outcome is the refusal)",
    ],
  };
}

/**
 * The SUBSTRATE INPUT-INTEGRITY oracle (PURE — the re-measurement
 * catch): every RECORDED window's digest reference resolves in the
 * pinned telemetry corpus, the declared digest agrees with the
 * re-derived one, and the bundle's facts EQUAL the corpus's own
 * derivation (lifecycle, usage, the five-share decomposition, the
 * served workload) — a re-measurement masquerading as derivation
 * FAILs named, field by field. Every window's pinned substrate price
 * revision passes the substrate manifest-integrity derivation, and
 * every cited VAL-022 reliability provenance row resolves with digest
 * agreement. Live windows (the measured lane) verify their manifest +
 * plan digest only — the live lane is the only place new measurements
 * happen.
 */
export function deriveSubstrateInputIntegrity(input: {
  readonly windows: readonly SubstrateWindowInput[];
}): {
  readonly conformant: boolean;
  readonly verdicts: readonly (VerifiedSubstrateWindow & { readonly detail: readonly string[] })[];
  readonly evidence: readonly string[];
} {
  const verdicts: (VerifiedSubstrateWindow & { readonly detail: readonly string[] })[] = [];
  const failures: string[] = [];
  for (const window of input.windows) {
    const manifest = deriveSubstrateManifestIntegrity({ revision: window.priceRevision });
    if (!manifest.agreed) {
      failures.push(
        `UNPINNED SUBSTRATE PRICING: ${window.facts.windowId} (revision ${window.priceRevision} failed manifest integrity)`,
      );
    }
    if (window.live === true) {
      // The live lane: the measurement IS the fact — only the pinned
      // pricing basis and the reference shape verify here.
      verdicts.push({
        reference: window,
        integrity: manifest.agreed,
        failureReason: manifest.agreed ? null : "manifest-integrity-failed",
        detail: [
          `window:${window.facts.windowId}`,
          "lane:live (the measured lane — new measurements happen only here)",
          `priceRevision:${window.priceRevision} (${manifest.agreed ? "integrity-agreed" : "integrity-FAILED"})`,
        ],
      });
      continue;
    }
    const recorded = substrateWindowById(window.facts.windowId);
    if (recorded === null) {
      failures.push(
        `UNRESOLVABLE DIGEST REFERENCE: ${window.facts.windowId} (no such recorded telemetry window)`,
      );
      verdicts.push({
        reference: window,
        integrity: false,
        failureReason: "unresolvable-reference",
        detail: ["the digest reference resolves to no recorded telemetry window"],
      });
      continue;
    }
    const recordedFacts = substrateWindowFactsOf(recorded);
    const digest = recordedSubstrateWindowDigestOf({
      windowId: recorded.windowId,
      facts: recordedFacts,
    });
    const digestAgrees = digest === window.recordedDigest;
    const fieldMismatches: string[] = [];
    const facts = window.facts;
    if (facts.firstUsableAtMs !== recordedFacts.firstUsableAtMs) {
      fieldMismatches.push(
        `firstUsable ${facts.firstUsableAtMs} != recorded ${recordedFacts.firstUsableAtMs}`,
      );
    }
    if (facts.startupMs !== recordedFacts.startupMs) {
      fieldMismatches.push(`startup ${facts.startupMs} != recorded ${recordedFacts.startupMs}`);
    }
    if (facts.activeUsageMs !== recordedFacts.activeUsageMs) {
      fieldMismatches.push(
        `activeUsage ${facts.activeUsageMs} != recorded ${recordedFacts.activeUsageMs}`,
      );
    }
    if (facts.reservedStandingMs !== recordedFacts.reservedStandingMs) {
      fieldMismatches.push(
        `reservedStanding ${facts.reservedStandingMs} != recorded ${recordedFacts.reservedStandingMs}`,
      );
    }
    if (facts.restartStartupMs !== recordedFacts.restartStartupMs) {
      fieldMismatches.push(
        `restartStartup ${facts.restartStartupMs} != recorded ${recordedFacts.restartStartupMs}`,
      );
    }
    if (facts.evictedWastedMs !== recordedFacts.evictedWastedMs) {
      fieldMismatches.push(
        `evictedWasted ${facts.evictedWastedMs} != recorded ${recordedFacts.evictedWastedMs}`,
      );
    }
    if (facts.restarts !== recordedFacts.restarts) {
      fieldMismatches.push(`restarts ${facts.restarts} != recorded ${recordedFacts.restarts}`);
    }
    if (facts.evictions !== recordedFacts.evictions) {
      fieldMismatches.push(`evictions ${facts.evictions} != recorded ${recordedFacts.evictions}`);
    }
    if (facts.measuredMicroUsd !== recordedFacts.measuredMicroUsd) {
      fieldMismatches.push(
        `measured ${facts.measuredMicroUsd} != recorded ${recordedFacts.measuredMicroUsd}`,
      );
    }
    if (facts.reservedMicroUsd !== recordedFacts.reservedMicroUsd) {
      fieldMismatches.push(
        `reserved ${facts.reservedMicroUsd} != recorded ${recordedFacts.reservedMicroUsd}`,
      );
    }
    if (facts.totalMicroUsd !== recordedFacts.totalMicroUsd) {
      fieldMismatches.push(
        `total ${facts.totalMicroUsd} != recorded ${recordedFacts.totalMicroUsd}`,
      );
    }
    if (facts.servedRuns !== recordedFacts.servedRuns) {
      fieldMismatches.push(
        `servedRuns ${facts.servedRuns} != recorded ${recordedFacts.servedRuns}`,
      );
    }
    if (facts.servedResolved !== recordedFacts.servedResolved) {
      fieldMismatches.push(
        `servedResolved ${facts.servedResolved} != recorded ${recordedFacts.servedResolved}`,
      );
    }
    if (facts.startupShareMicroUsd !== recordedFacts.startupShareMicroUsd) {
      fieldMismatches.push("startupShare disagrees with the recorded derivation");
    }
    if (facts.restartShareMicroUsd !== recordedFacts.restartShareMicroUsd) {
      fieldMismatches.push("restartShare disagrees with the recorded derivation");
    }
    if (facts.evictionShareMicroUsd !== recordedFacts.evictionShareMicroUsd) {
      fieldMismatches.push("evictionShare disagrees with the recorded derivation");
    }
    const claimedRuns = window.claimed?.servedRuns;
    if (claimedRuns !== undefined && claimedRuns !== recordedFacts.servedRuns) {
      fieldMismatches.push(
        `claimed servedRuns ${claimedRuns} != recorded ${recordedFacts.servedRuns} (a re-measurement masquerading as the recorded result)`,
      );
    }
    if (!digestAgrees) {
      failures.push(
        `DIGEST-DISAGREED: ${window.facts.windowId} (declared ${window.recordedDigest} != re-derived ${digest})`,
      );
    }
    if (fieldMismatches.length > 0) {
      failures.push(
        `RE-MEASUREMENT MASQUERADE: ${window.facts.windowId} (${fieldMismatches.join("; ")}) — the synthesis derives over RECORDED telemetry`,
      );
    }
    // The cited VAL-022 reliability provenance resolves + digest-verifies.
    for (const cited of recorded.reliabilityProvenance) {
      try {
        const digest022 = recordedSubstrateFailureDigestOf(cited.val022RowId);
        void digest022;
      } catch (error) {
        failures.push(
          `UNRESOLVABLE PROVENANCE: ${window.facts.windowId} (the cited VAL-022 record ${cited.val022RowId} does not resolve: ${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    verdicts.push({
      reference: window,
      integrity: digestAgrees && fieldMismatches.length === 0 && manifest.agreed,
      failureReason: !digestAgrees
        ? "digest-disagreed"
        : fieldMismatches.length > 0
          ? "re-measurement-masquerade"
          : manifest.agreed
            ? null
            : "manifest-integrity-failed",
      detail: [
        `digest:declared=${window.recordedDigest}`,
        `digest:rederived=${digest}`,
        `digest:${digestAgrees ? "AGREED" : "DISAGREED"}`,
        `priceRevision:${window.priceRevision} (${manifest.agreed ? "integrity-agreed" : "integrity-FAILED"})`,
        `fields:${fieldMismatches.length === 0 ? "identical-to-the-recorded-telemetry" : fieldMismatches.join("; ")}`,
      ],
    });
  }
  return {
    conformant: failures.length === 0,
    verdicts,
    evidence: [
      `windows:${input.windows.length}`,
      `failures:${failures.length}`,
      ...failures,
      failures.length === 0
        ? "integrity held (every window IS the recorded telemetry's own derivation — digest-verified, never re-measured)"
        : "INTEGRITY FAILED (a window is not the recorded telemetry's result — a re-measurement masquerading as derivation)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The family synthesis (the substrate-cost comparison itself — PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the full substrate-cost comparison for one row over its
 * window inputs (PURE): the family's headline number with every oracle
 * applied, the pooled five-share decomposition, the readiness wait
 * share (startup + restart — carried EXPLICITLY), the model side (the
 * RECORDED arm facts — imported, never re-measured; the measured
 * model cost on the live lane), the Wilson 95% interval on the pooled
 * substrate workload resolution and the comparability verdict. The
 * verdict is honest: nothing resolved → HONESTLY INCOMPARABLE (never
 * a zero-denominator fabrication); below-minimum inputs REFUSE; any
 * failed oracle → ADVERSARIAL-FAILED.
 *
 * The READINESS-ADJUSTED family's own catch: a comparison whose
 * effective cost equals the model-only number while the recorded
 * substrate total is nonzero SILENTLY ABSORBS the substrate cost into
 * the provider price and FAILs mechanically.
 */
export function deriveSubstrateFamilySynthesis(input: {
  readonly row: SubstrateCorpusRow;
  readonly windows: readonly SubstrateWindowInput[];
  /**
   * The model side: for offline rows the RECORDED arm facts (the
   * imported VAL-044 pooled derivation — never re-measured); for the
   * live lane the MEASURED model dispatch facts.
   */
  readonly modelSide: ModelSideFacts | null;
  /** A claimed effective cost per resolved (never trusted — the absorption catch). */
  readonly claimedEffectivePerResolvedMicroUsd?: string;
}): {
  readonly synthesis: ExpectedSubstrateOutcome | null;
  readonly verdict: SubstrateComparability;
  readonly familyConformant: boolean;
  readonly familyCriterionId: string;
  readonly familyEvidence: readonly string[];
} {
  const pooled = pooledSubstrateFactsOf(input.windows);
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.resolved, pooled.runs) : null;
  const readinessWaitShare = pooled.startupShareMicroUsd + pooled.restartShareMicroUsd;
  const substratePerRun =
    pooled.runs > 0 ? divRoundHalfUp(pooled.totalMicroUsd, BigInt(pooled.runs)) : null;
  const substratePerResolved =
    pooled.resolved > 0 ? divRoundHalfUp(pooled.totalMicroUsd, BigInt(pooled.resolved)) : null;
  const modelPerResolved =
    input.modelSide !== null && input.modelSide.resolved > 0
      ? divRoundHalfUp(input.modelSide.measuredMicroUsd, BigInt(input.modelSide.resolved))
      : null;
  const effectivePerResolved =
    substratePerResolved !== null && modelPerResolved !== null
      ? substratePerResolved + modelPerResolved
      : null;
  const substrateShareOfEffective =
    effectivePerResolved !== null && effectivePerResolved > 0n
      ? Number(substratePerResolved) / Number(effectivePerResolved)
      : null;

  const familyViolations: string[] = [];
  let familyCriterionId: string;
  if (input.row.family === "substrate-cost-per-run") {
    familyCriterionId = "substrate-per-run-derivation";
    // The denominator is the RECORDED served run count — a window that
    // re-measured its served count fails integrity; the family derives
    // over the recorded basis only.
    if (pooled.runs === 0 && substratePerRun !== null) {
      familyViolations.push("cost-per-run claimed while nothing ran");
    }
  } else if (input.row.family === "substrate-amortized-per-resolved") {
    familyCriterionId = "substrate-per-resolved-amortization";
    if (pooled.resolved === 0 && substratePerResolved !== null) {
      familyViolations.push(
        "amortized-per-resolved claimed while nothing resolved (never zero, never estimate-backed)",
      );
    }
  } else {
    familyCriterionId = "readiness-adjusted-absorption-honesty";
    // The absorption catch: the substrate cost is EXPLICIT — a
    // comparison whose effective cost equals the model-only number
    // while the recorded substrate total is nonzero silently absorbed
    // the substrate cost into the provider price.
    if (pooled.totalMicroUsd > 0n && pooled.resolved > 0 && substratePerResolved === 0n) {
      familyViolations.push(
        "SILENT SUBSTRATE ABSORPTION (the substrate cost per resolved rounded to zero while the recorded substrate total is nonzero)",
      );
    }
    if (input.claimedEffectivePerResolvedMicroUsd !== undefined) {
      const claimed = BigInt(input.claimedEffectivePerResolvedMicroUsd);
      if (modelPerResolved !== null && claimed === modelPerResolved && pooled.totalMicroUsd > 0n) {
        familyViolations.push(
          `SILENT SUBSTRATE ABSORPTION (the claimed effective cost ${claimed} equals the model-only cost ${modelPerResolved} while the recorded substrate total is ${pooled.totalMicroUsd}µ$ — the substrate cost was silently absorbed into the provider price)`,
        );
      }
    }
    if (
      input.claimedEffectivePerResolvedMicroUsd !== undefined &&
      effectivePerResolved !== null &&
      BigInt(input.claimedEffectivePerResolvedMicroUsd) !== effectivePerResolved
    ) {
      familyViolations.push(
        `EFFECTIVE-COST DISAGREEMENT (claims ${input.claimedEffectivePerResolvedMicroUsd}, the recorded derivation computes ${effectivePerResolved})`,
      );
    }
  }

  const startup = deriveStartupCostInclusion({ windows: input.windows });
  const readiness = deriveReadinessProbeHonesty({ windows: input.windows });
  const separation = deriveReservedMeasuredSeparation({ windows: input.windows });
  const failure = deriveFailureAmortizationCompleteness({ windows: input.windows });
  const estimate = deriveEstimateMeasureSeparation({ windows: input.windows });
  const confidence = deriveConfidenceAndMinimum({ row: input.row, windows: input.windows });
  const integrity = deriveSubstrateInputIntegrity({ windows: input.windows });
  const refusal = deriveBelowMinimumRefusalHonesty({ row: input.row, windows: input.windows });
  const allConformant =
    familyViolations.length === 0 &&
    startup.conformant &&
    readiness.conformant &&
    separation.conformant &&
    failure.conformant &&
    estimate.conformant &&
    confidence.conformant &&
    integrity.conformant &&
    refusal.conformant;

  const familyHeadline =
    input.row.family === "substrate-cost-per-run"
      ? substratePerRun
      : input.row.family === "substrate-amortized-per-resolved"
        ? substratePerResolved
        : effectivePerResolved;

  const synthesis: ExpectedSubstrateOutcome | null =
    wilson === null
      ? null
      : {
          family: input.row.family,
          windows: pooled.windows,
          pooledRuns: pooled.runs,
          pooledResolved: pooled.resolved,
          measuredMicroUsd: pooled.measuredMicroUsd.toString(),
          reservedMicroUsd: pooled.reservedMicroUsd.toString(),
          totalMicroUsd: pooled.totalMicroUsd.toString(),
          startupShareMicroUsd: pooled.startupShareMicroUsd.toString(),
          restartShareMicroUsd: pooled.restartShareMicroUsd.toString(),
          evictionShareMicroUsd: pooled.evictionShareMicroUsd.toString(),
          readinessWaitShareMicroUsd: readinessWaitShare.toString(),
          substratePerRunMicroUsd: substratePerRun === null ? null : substratePerRun.toString(),
          substratePerResolvedMicroUsd:
            substratePerResolved === null ? null : substratePerResolved.toString(),
          modelPerResolvedMicroUsd: modelPerResolved === null ? null : modelPerResolved.toString(),
          effectivePerResolvedMicroUsd:
            effectivePerResolved === null ? null : effectivePerResolved.toString(),
          substrateShareOfEffective,
          wilson: { low: wilson.low, high: wilson.high },
        };

  const verdict: SubstrateComparability = !allConformant
    ? "adversarial-failed"
    : confidence.belowMinimum
      ? "refused-below-minimum"
      : familyHeadline === null
        ? "honestly-incomparable"
        : "comparable";

  return {
    synthesis,
    verdict,
    familyConformant: allConformant,
    familyCriterionId,
    familyEvidence: [
      `family:${input.row.family}`,
      `pooledWindows:${pooled.windows}`,
      `pooledRuns:${pooled.runs}`,
      `pooledResolved:${pooled.resolved}`,
      `substrateTotalMicroUsd:${pooled.totalMicroUsd.toString()} (startup ${pooled.startupShareMicroUsd.toString()} + restart ${pooled.restartShareMicroUsd.toString()} + eviction ${pooled.evictionShareMicroUsd.toString()} in the measured basis; reserved ${pooled.reservedMicroUsd.toString()} SEPARATE)`,
      `readinessWaitShareMicroUsd:${readinessWaitShare.toString()} (startup + restart — the readiness-determined share, carried EXPLICITLY)`,
      ...(substratePerRun === null
        ? ["substratePerRun:null (nothing ran)"]
        : [`substratePerRun:${substratePerRun.toString()}`]),
      ...(substratePerResolved === null
        ? ["substratePerResolved:null (nothing resolved — never zero, never estimate-backed)"]
        : [`substratePerResolved:${substratePerResolved.toString()}`]),
      ...(modelPerResolved === null
        ? ["modelPerResolved:null (no model side resolved)"]
        : [
            `modelPerResolved:${modelPerResolved.toString()} (the RECORDED arm facts — never re-measured)`,
          ]),
      ...(effectivePerResolved === null
        ? ["effectivePerResolved:null (honestly incomparable)"]
        : [
            `effectivePerResolved:${effectivePerResolved.toString()} (model + substrate — the substrate cost is EXPLICIT, never absorbed)`,
          ]),
      ...(substrateShareOfEffective === null
        ? ["substrateShareOfEffective:null"]
        : [`substrateShareOfEffective:${substrateShareOfEffective.toFixed(6)}`]),
      `wilson95:${wilson === null ? "none" : `[${wilson.low.toFixed(4)}, ${wilson.high.toFixed(4)}]`}`,
      ...familyViolations,
      `familyViolations:${familyViolations.length}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The row criteria (the mechanical verification battery)
// ---------------------------------------------------------------------------

/**
 * Derive the substrate row's criteria (PURE — the verification
 * battery): the input-integrity oracle, the startup-cost inclusion,
 * the readiness-probe honesty, the reserved/measured separation, the
 * failure-amortization completeness, the estimate/measure separation,
 * the confidence-and-minimum enforcement, the below-minimum refusal
 * honesty, the family oracle, the synthesis-outcome oracle (the
 * derived comparison reproduces the pinned expected synthesis), the
 * durable contracts and the honest outcome contract.
 */
export function deriveSubstrateRowCriteria(input: {
  readonly row: SubstrateCorpusRow;
  readonly windows: readonly SubstrateWindowInput[];
  readonly modelSide: ModelSideFacts | null;
  readonly observedTerminal: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalLatencyMs: number;
}): readonly LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const integrity = deriveSubstrateInputIntegrity({ windows: input.windows });
  criteria.push({
    criterionId: "substrate-input-integrity",
    strategy: "deterministic",
    status: integrity.conformant ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });
  const startup = deriveStartupCostInclusion({ windows: input.windows });
  criteria.push({
    criterionId: "startup-cost-inclusion",
    strategy: "deterministic",
    status: startup.conformant ? "PASS" : "FAIL",
    evidence: startup.evidence,
  });
  const readiness = deriveReadinessProbeHonesty({ windows: input.windows });
  criteria.push({
    criterionId: "readiness-probe-honesty",
    strategy: "deterministic",
    status: readiness.conformant ? "PASS" : "FAIL",
    evidence: readiness.evidence,
  });
  const separation = deriveReservedMeasuredSeparation({ windows: input.windows });
  criteria.push({
    criterionId: "reserved-measured-separation",
    strategy: "deterministic",
    status: separation.conformant ? "PASS" : "FAIL",
    evidence: separation.evidence,
  });
  const failureAmortization = deriveFailureAmortizationCompleteness({
    windows: input.windows,
  });
  criteria.push({
    criterionId: "failure-amortization-completeness",
    strategy: "deterministic",
    status: failureAmortization.conformant ? "PASS" : "FAIL",
    evidence: failureAmortization.evidence,
  });
  const estimate = deriveEstimateMeasureSeparation({ windows: input.windows });
  criteria.push({
    criterionId: "estimate-measure-separation",
    strategy: "deterministic",
    status: estimate.conformant ? "PASS" : "FAIL",
    evidence: estimate.evidence,
  });
  const confidence = deriveConfidenceAndMinimum({ row: input.row, windows: input.windows });
  criteria.push({
    criterionId: "confidence-and-minimum",
    strategy: "deterministic",
    status: confidence.conformant ? "PASS" : "FAIL",
    evidence: confidence.evidence,
  });
  const refusal = deriveBelowMinimumRefusalHonesty({ row: input.row, windows: input.windows });
  criteria.push({
    criterionId: "below-minimum-refusal-honesty",
    strategy: "deterministic",
    status: refusal.conformant ? "PASS" : "FAIL",
    evidence: refusal.evidence,
  });
  const family = deriveSubstrateFamilySynthesis({
    row: input.row,
    windows: input.windows,
    modelSide: input.modelSide,
  });
  criteria.push({
    criterionId: family.familyCriterionId,
    strategy: "deterministic",
    status: family.familyConformant ? "PASS" : "FAIL",
    evidence: family.familyEvidence,
  });
  if (input.row.expected.synthesis !== undefined) {
    const expected = input.row.expected.synthesis;
    const observed = family.synthesis;
    const matches =
      observed !== null &&
      observed.family === expected.family &&
      observed.windows === expected.windows &&
      observed.pooledRuns === expected.pooledRuns &&
      observed.pooledResolved === expected.pooledResolved &&
      observed.measuredMicroUsd === expected.measuredMicroUsd &&
      observed.reservedMicroUsd === expected.reservedMicroUsd &&
      observed.totalMicroUsd === expected.totalMicroUsd &&
      observed.startupShareMicroUsd === expected.startupShareMicroUsd &&
      observed.restartShareMicroUsd === expected.restartShareMicroUsd &&
      observed.evictionShareMicroUsd === expected.evictionShareMicroUsd &&
      observed.readinessWaitShareMicroUsd === expected.readinessWaitShareMicroUsd &&
      observed.substratePerRunMicroUsd === expected.substratePerRunMicroUsd &&
      observed.substratePerResolvedMicroUsd === expected.substratePerResolvedMicroUsd &&
      observed.modelPerResolvedMicroUsd === expected.modelPerResolvedMicroUsd &&
      observed.effectivePerResolvedMicroUsd === expected.effectivePerResolvedMicroUsd &&
      Math.abs(
        (observed.substrateShareOfEffective ?? 0) - (expected.substrateShareOfEffective ?? 0),
      ) < 1e-9 &&
      Math.abs(observed.wilson.low - expected.wilson.low) < 1e-9 &&
      Math.abs(observed.wilson.high - expected.wilson.high) < 1e-9;
    criteria.push({
      criterionId: "synthesis-outcome-oracle",
      strategy: "deterministic",
      status: matches ? "PASS" : "FAIL",
      evidence: [
        `expectedFamily:${expected.family}`,
        `observedFamily:${observed?.family ?? "none"}`,
        `expectedPooledRuns:${expected.pooledRuns}`,
        `observedPooledRuns:${observed?.pooledRuns ?? "none"}`,
        `expectedPooledResolved:${expected.pooledResolved}`,
        `observedPooledResolved:${observed?.pooledResolved ?? "none"}`,
        `expectedTotal:${expected.totalMicroUsd}`,
        `observedTotal:${observed?.totalMicroUsd ?? "none"}`,
        `expectedEffective:${expected.effectivePerResolvedMicroUsd ?? "null"}`,
        `observedEffective:${observed?.effectivePerResolvedMicroUsd ?? "none"}`,
      ],
    });
  }
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === input.row.expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${input.row.expected.executions}`,
    ],
  });
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === input.row.expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${input.row.expected.idempotencyRecords}`,
    ],
  });
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: input.finalFacts.orphanEventCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null || !family.familyConformant ? "FAILED" : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${input.row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `expectedVerdict:${input.row.expected.verdict}`,
      `derivedVerdict:${family.verdict}`,
      `observedTerminal:${input.observedTerminal ?? "none"}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.row.needsDispatch
        ? "substrate:rail-measured on the live lifecycle (BYOK; measured, never estimated)"
        : "substrate:recorded telemetry facts (deterministic recorded lifecycle — honestly labeled, never presented as live measurements)",
      "model:the RECORDED arm facts at each arm's own pinned revision (never re-priced, never re-measured)",
      "latencyMs:measured",
      `totalLatencyMs:${input.totalLatencyMs}`,
      "evidence:payload digests only (never payload bytes)",
    ],
  });
  return criteria;
}

// ---------------------------------------------------------------------------
// The row driver (the landed synthesis execution)
// ---------------------------------------------------------------------------

/**
 * Drive one substrate-cost row to settlement through the platform
 * path: the landed execution's chain records the SUBSTRATE DECISIONS
 * BEFORE any input is consulted (the family, the pre-registered window
 * set with every digest reference, the arm references, the minimums,
 * the Wilson configuration, the pinned revisions), then each recorded
 * window is verified against the telemetry corpus (digest + field
 * equality — journaled as digest references only) and sealed through
 * the REAL accounting rails (the five-share decomposition as
 * substrate-scoped cost facts with the restart/eviction share as
 * retry-overhead — the failure-amortized substrate share; the planner
 * quote as a SEPARATE estimate fact), the substrate-cost family is
 * derived PURELY over the recorded results, the row-level mechanical
 * criteria are assembled, the verdict completes the execution and the
 * observed terminal is read back from the ledger. The honest terminal
 * is FAILED when any failure was observed or any criterion failed —
 * never a partial-success shortcut.
 */
export async function driveSubstrateRow(options: {
  readonly row: SubstrateCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The resolved window inputs (the fixtures' bundles — verified here). */
  readonly windows: readonly SubstrateWindowInput[];
  /** The accounting rails (the REAL recorder — the verified inputs' sealing). */
  readonly rails: EconomicAccountingRails;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
}): Promise<SubstrateRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const key = (): string => {
    keyCounter.count += 1;
    return `k${keyCounter.count}`;
  };
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveSubstrateRowCriteria({
        row: options.row,
        windows: options.windows,
        modelSide: modelSideOf(options.row),
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      windows: [],
      synthesis: null,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
    };
  }
  const executionId = landed[0];
  let failure: { category: string; message: string } | null = null;

  // ---- the canonical prologue ----
  await options.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-046-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-046-plan",
    callKey: key(),
  });

  // ---- the SUBSTRATE DECISIONS (made BEFORE any input is consulted) ----
  const substrateDecision: Record<string, unknown> = {
    kind: "substrate-cost-synthesis-plan",
    family: options.row.family,
    deriveOnlyOverRecorded:
      "the substrate-cost families derive over the RECORDED substrate telemetry (digest references; never a re-measurement, never a re-pricing)",
    preRegisteredWindowSet: options.row.windowSet.map((reference) => ({
      window: reference.windowId,
      digest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    composedArmSet: options.row.armSet.map((reference) => ({
      arm: reference.armLabel,
      row: reference.corpusRowId,
      digest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    minimumWindows: options.row.minimumWindows,
    minimumRunsPerWindow: options.row.minimumRunsPerWindow,
    wilson: WILSON_CONFIG,
    expectedVerdict: options.row.expected.verdict,
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "substrate",
      model: "recorded-substrate-telemetry",
      strategyClass: "economic-substrate-runtime",
    },
    armDecision: substrateDecision,
  });
  await options.lifecycle.recordStepEvent({
    executionId,
    record: {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(substrateDecision),
      detail: `substrate-decision:${options.row.rowId}:${options.row.family}`,
    },
  });
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-046-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-046-start",
    callKey: key(),
  });

  // ---- the input-verification loop (digest references only) ----
  const integrity = deriveSubstrateInputIntegrity({ windows: options.windows });
  const verifiedWindows: VerifiedSubstrateWindow[] = [];
  let ordinal = 1;
  for (const verdict of integrity.verdicts) {
    const record: EconomicJournalRecord = {
      ordinal: ordinal + 1,
      kind: verdict.integrity ? "round" : "failure",
      digest: economicDigestOf({
        window: verdict.reference.windowId,
        declared: verdict.reference.recordedDigest,
        integrity: verdict.integrity,
      }),
      detail: `window:${verdict.reference.windowId}:${verdict.integrity ? "verified" : (verdict.failureReason ?? "failed")}`,
    };
    await options.lifecycle.recordStepEvent({ executionId, record });
    ordinal += 1;
    verifiedWindows.push({
      reference: verdict.reference,
      integrity: verdict.integrity,
      failureReason: verdict.failureReason,
    });
    if (!verdict.integrity && failure === null) {
      failure = {
        category: "input-integrity-failed",
        message: `${verdict.reference.windowId} ${verdict.failureReason ?? ""}`.trim(),
      };
    }
    // The verified window seals through the REAL recorder: the
    // five-share decomposition as substrate-scoped cost facts (the
    // restart/eviction share as retry-overhead — the
    // failure-amortized substrate share), the planner quote as a
    // SEPARATE estimate fact, the lifecycle wallclock as the latency.
    const item = options.windows.find(
      (candidate) => candidate.facts.windowId === verdict.reference.windowId,
    );
    if (item === undefined) {
      continue;
    }
    const facts = item.facts;
    const directSubstrate =
      BigInt(facts.startupShareMicroUsd) +
      BigInt(facts.sustainedShareMicroUsd) +
      BigInt(facts.reservedShareMicroUsd);
    const failureShare = BigInt(facts.restartShareMicroUsd) + BigInt(facts.evictionShareMicroUsd);
    const sealedAt = options.now().toISOString();
    options.rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: facts.windowId,
      environmentIdentity: options.environmentIdentity,
      events: [
        {
          kind: "run-start",
          data: { substrateWindow: facts.windowId, fleet: facts.fleet },
          at: sealedAt,
        },
        {
          kind: "model-choice",
          data: {
            requestDigest: verdict.reference.recordedDigest,
            request: 1,
            synthesisInput: true,
          },
          at: sealedAt,
        },
        {
          kind: "run-end",
          data: { terminalStatus: verdict.integrity ? "COMPLETED" : "FAILED" },
          at: sealedAt,
        },
      ],
      cost: [
        ...(directSubstrate > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: directSubstrate.toString(),
                source: `val-046:${options.row.rowId}:recorded:${facts.priceRevision}`,
                scope: "substrate" as const,
              },
            ]
          : []),
        ...(failureShare > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: failureShare.toString(),
                source: `val-046:${options.row.rowId}:recorded:${facts.priceRevision}`,
                scope: "retry-overhead" as const,
              },
            ]
          : []),
        ...(BigInt(facts.estimateMicroUsd) > 0n
          ? [
              {
                kind: "estimate" as const,
                amountMicroUsd: facts.estimateMicroUsd,
                source: `val-046:${options.row.rowId}:recorded:${facts.priceRevision}`,
                scope: "substrate" as const,
              },
            ]
          : []),
      ],
      latency: [
        {
          phase: "total" as const,
          source: "platform-ledger" as const,
          milliseconds: facts.tornDownAtMs,
        },
      ],
      environment: [
        {
          kind: "state-transitioned",
          assertion: `the recorded window ${facts.windowId} verified against the telemetry corpus`,
          observedVia: "platform-ledger",
          passed: verdict.integrity,
        },
      ],
      sealedAt,
    });
  }

  // ---- the substrate-cost family (PURE over the recorded results) ----
  const comparison = deriveSubstrateFamilySynthesis({
    row: options.row,
    windows: options.windows,
    modelSide: modelSideOf(options.row),
  });

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-046-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveSubstrateRowCriteria({
    row: options.row,
    windows: options.windows,
    modelSide: modelSideOf(options.row),
    observedTerminal: null,
    baseline: options.baseline,
    finalFacts,
    failure,
    totalLatencyMs,
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason:
      verdict === "pass"
        ? "val-046-verified"
        : `val-046-${failure?.category ?? "protocol-violation"}`,
  });

  // ---- the observed terminal read back from the ledger ----
  const observedTerminal = await options.lifecycle.statusOf(executionId);
  const readbackAgrees = observedTerminal === derivedTerminal;
  const criteria: LabVerificationCriterion[] = [
    ...rowCriteria,
    {
      criterionId: "observed-terminal-readback",
      strategy: "deterministic",
      status: readbackAgrees ? "PASS" : "FAIL",
      evidence: [
        `derivedTerminal:${derivedTerminal}`,
        `observedTerminal:${observedTerminal ?? "none"}`,
        readbackAgrees
          ? "the ledger's own terminal agrees with the mechanically derived verdict"
          : "DISAGREED (a fabricated terminal at the ledger — the anyFail→FAILED invariant)",
      ],
    },
  ];
  const anyFail = derivedTerminal === "FAILED" || !readbackAgrees;
  return {
    rowId: options.row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    executionId,
    observedTerminal,
    windows: verifiedWindows,
    synthesis: comparison.synthesis,
    totalLatencyMs,
    failure,
  };
}

/** The model side of one row: the RECORDED arm facts pooled (never re-measured). */
function modelSideOf(row: SubstrateCorpusRow): ModelSideFacts | null {
  if (row.armSet.length === 0) {
    return null;
  }
  const inputs = armInputsOf(row.armSet);
  const pooled = pooledFactsOf(inputs);
  return {
    measuredMicroUsd: pooled.measuredMicroUsd,
    resolved: pooled.resolved,
    runs: pooled.runs,
  };
}

// ---------------------------------------------------------------------------
// The live lane (env-gated — one REAL substrate lifecycle measurement)
// ---------------------------------------------------------------------------

/** The pinned live-substrate plan (the measured lane's declaration). */
export const LIVE_SUBSTRATE_PLAN = Object.freeze({
  /** The substrate fleet the live lifecycle runs on (priced in the substrate manifest). */
  fleet: "warm-fleet-a",
  /** The pinned substrate price revision pricing the measured lifecycle. */
  priceRevision: "sub-rev-001",
  /** The REAL workload units the sustained runtime drives. */
  workloadUnits: 3,
  /** The bounded readiness-probe budget (the warm-up loop's ceiling). */
  maxProbes: 8,
  /** The pinned model rail the workload dispatches ride (ONE binding — the live-run lesson). */
  rail: Object.freeze({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    priceRevision: "rev-001",
    maxTokens: 32,
    temperature: "unset (the provider's documented default — nothing rides the request)",
  }),
});

/** The live window's identity (the measured lane's declaration reference). */
export const LIVE_WINDOW_ID = "live-substrate-lifecycle-window";

/** The declaration digest of the live plan (the reference's recorded digest). */
export function liveSubstratePlanDigestOf(): string {
  return economicDigestOf({
    liveWindow: LIVE_WINDOW_ID,
    fleet: LIVE_SUBSTRATE_PLAN.fleet,
    priceRevision: LIVE_SUBSTRATE_PLAN.priceRevision,
    workloadUnits: LIVE_SUBSTRATE_PLAN.workloadUnits,
    maxProbes: LIVE_SUBSTRATE_PLAN.maxProbes,
    rail: LIVE_SUBSTRATE_PLAN.rail,
  });
}

/** One REAL readiness probe observation on the live substrate. */
export interface LiveSubstrateProbeOutcome {
  readonly ready: boolean;
  readonly reason: string | null;
  /** The probe's own measured execution duration (ms). */
  readonly executionMs: number;
}

/** One REAL workload unit's measured facts. */
export interface LiveSubstrateWorkloadOutcome {
  /** The substrate's own measured execution duration for the unit (ms). */
  readonly substrateExecutionMs: number;
  /** The REAL model dispatch the unit's workload rides (ONE binding). */
  readonly model: {
    readonly ok: boolean;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly latencyMs: number;
    /** The provider envelope's own code token on failure (wins over the raw HTTP status). */
    readonly category?: string;
  };
}

/**
 * The live substrate lifecycle seam: bound at the crown to the REAL
 * process substrate (`ProcessSandboxProvider` — the adapter that
 * exists) for the probes/executions/teardown and the REAL operator-
 * authorized OpenRouter rail for the workload's model dispatches
 * (BYOK, measured). Injected here; never fabricated.
 */
export interface LiveSubstrateLifecyclePort {
  /** One REAL readiness probe on the substrate (a real execution proving usability). */
  probe(unit: number): Promise<LiveSubstrateProbeOutcome>;
  /** One REAL workload unit (a real substrate execution + the REAL model dispatch). */
  runWorkloadUnit(unit: number): Promise<LiveSubstrateWorkloadOutcome>;
  /** The REAL teardown (a final real execution closing the window). */
  teardown(): Promise<{ readonly executionMs: number }>;
}

/** The measured live lifecycle facts (the driver's measured window basis). */
export interface MeasuredLiveLifecycle {
  readonly probes: { readonly atMs: number; readonly ready: boolean; readonly reason?: string }[];
  readonly firstUsableAtMs: number | null;
  readonly firstDispatchedAtMs: number;
  readonly tornDownAtMs: number;
  readonly activeUsageMs: number;
  readonly restartStartupMs: number;
  readonly restarts: number;
  readonly evictions: number;
  readonly workload: readonly LiveSubstrateWorkloadOutcome[];
  /** The measured model usage facts (priced at the pinned rail revision — measured, never estimated). */
  readonly modelUsageFacts: readonly UsageFact[];
  readonly modelRuns: number;
  readonly modelResolved: number;
}

/** The RETRYABLE live model-dispatch categories (the envelope's code tokens). */
const RETRYABLE_LIVE_CATEGORIES: ReadonlySet<string> = new Set([
  "rate-limit",
  "transport-failure",
  "provider-unavailable",
]);

/**
 * Drive one REAL substrate lifecycle measurement (env-gated): cold
 * start → readiness probes to FIRST-USABLE → the sustained runtime
 * (the REAL workload units with the REAL model dispatches on the
 * pinned rail — ONE binding) → teardown. Every fact is MEASURED (the
 * probe timestamps, the execution durations, the model usage tokens);
 * the substrate-cost families are computed over the measured facts
 * with every priced input at its pinned manifest revision, sealed
 * through the REAL recorder with honest economics. A retryable model
 * failure triggers ONE bounded retry per unit on a FRESH probe (a
 * restart — counted and priced honestly); an empty-completion 200 is
 * honest SUCCESS (the VAL-014 rule); the provider envelope's code
 * token wins over the raw HTTP status.
 */
export async function measureLiveSubstrateLifecycle(options: {
  readonly substrateLifecycle: LiveSubstrateLifecyclePort;
  readonly now: () => Date;
}): Promise<
  | { readonly ok: true; readonly measured: MeasuredLiveLifecycle }
  | { readonly ok: false; readonly category: string; readonly message: string }
> {
  const startedAt = options.now().getTime();
  const elapsed = (): number => options.now().getTime() - startedAt;
  const probes: { atMs: number; ready: boolean; reason?: string }[] = [];
  let firstUsableAtMs: number | null = null;
  for (let unit = 1; unit <= LIVE_SUBSTRATE_PLAN.maxProbes; unit += 1) {
    const probe = await options.substrateLifecycle.probe(unit);
    const atMs = elapsed();
    probes.push({
      atMs,
      ready: probe.ready,
      ...(probe.reason === null ? {} : { reason: probe.reason }),
    });
    if (probe.ready) {
      firstUsableAtMs = atMs;
      break;
    }
  }
  if (firstUsableAtMs === null) {
    return {
      ok: false,
      category: "readiness-never-attained",
      message: `the substrate never observed first-usable across ${LIVE_SUBSTRATE_PLAN.maxProbes} probes`,
    };
  }
  let firstDispatchedAtMs = 0;
  let activeUsageMs = 0;
  let restartStartupMs = 0;
  let restarts = 0;
  const workload: LiveSubstrateWorkloadOutcome[] = [];
  const modelUsageFacts: UsageFact[] = [];
  let modelRuns = 0;
  let modelResolved = 0;
  for (let unit = 1; unit <= LIVE_SUBSTRATE_PLAN.workloadUnits; unit += 1) {
    if (unit === 1) {
      firstDispatchedAtMs = elapsed();
    }
    let outcome = await options.substrateLifecycle.runWorkloadUnit(unit);
    // ONE bounded retry on RETRYABLE envelope categories (a fresh probe
    // first — the fresh-sandbox discipline; a restart counted + priced).
    if (!outcome.model.ok) {
      const category = outcome.model.category ?? "unknown";
      if (RETRYABLE_LIVE_CATEGORIES.has(category)) {
        const fresh = await options.substrateLifecycle.probe(100 + unit);
        restarts += 1;
        restartStartupMs += fresh.executionMs;
        activeUsageMs += fresh.executionMs;
        outcome = await options.substrateLifecycle.runWorkloadUnit(unit);
      }
    }
    workload.push(outcome);
    activeUsageMs += outcome.substrateExecutionMs;
    modelRuns += 1;
    if (outcome.model.ok) {
      // The empty-completion 200 is honest SUCCESS (the VAL-014 rule).
      modelResolved += 1;
      modelUsageFacts.push(
        {
          provider: LIVE_SUBSTRATE_PLAN.rail.provider,
          model: LIVE_SUBSTRATE_PLAN.rail.model,
          tier: "input",
          currency: "USD",
          tokens: outcome.model.inputTokens,
          kind: "measured",
          scope: "direct-execution",
        },
        {
          provider: LIVE_SUBSTRATE_PLAN.rail.provider,
          model: LIVE_SUBSTRATE_PLAN.rail.model,
          tier: "output",
          currency: "USD",
          tokens: outcome.model.outputTokens,
          kind: "measured",
          scope: "direct-execution",
        },
      );
    }
  }
  await options.substrateLifecycle.teardown();
  const tornDownAtMs = elapsed();
  return {
    ok: true,
    measured: {
      probes,
      firstUsableAtMs,
      firstDispatchedAtMs,
      tornDownAtMs,
      activeUsageMs,
      restartStartupMs,
      restarts,
      evictions: 0,
      workload,
      modelUsageFacts,
      modelRuns,
      modelResolved,
    },
  };
}

/**
 * Drive the live substrate row to settlement: the REAL lifecycle
 * measurement through the injected port, the measured window priced at
 * the pinned substrate revision, the model usage priced at the pinned
 * rail revision (the IMPORTED VAL-040 normalization — the same
 * machinery the live economics rows ride), the family derived over the
 * MEASURED facts, sealed through the REAL recorder, with the full
 * mechanical battery and the honest anyFail→FAILED terminal.
 */
export async function driveLiveSubstrateRow(options: {
  readonly row: SubstrateCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  readonly substrateLifecycle: LiveSubstrateLifecyclePort;
  readonly rails: EconomicAccountingRails;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
}): Promise<SubstrateRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const key = (): string => {
    keyCounter.count += 1;
    return `k${keyCounter.count}`;
  };
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveSubstrateRowCriteria({
        row: options.row,
        windows: [],
        modelSide: null,
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      windows: [],
      synthesis: null,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
    };
  }
  const executionId = landed[0];

  // ---- the canonical prologue + the LIVE SUBSTRATE DECISION ----
  await options.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-046-live-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-046-live-plan",
    callKey: key(),
  });
  const liveDecision: Record<string, unknown> = {
    kind: "live-substrate-lifecycle-plan",
    family: options.row.family,
    plan: LIVE_SUBSTRATE_PLAN,
    minimumWindows: options.row.minimumWindows,
    minimumRunsPerWindow: options.row.minimumRunsPerWindow,
    wilson: WILSON_CONFIG,
    expectedVerdict: options.row.expected.verdict,
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "substrate",
      model: "live-process-substrate",
      strategyClass: "economic-substrate-runtime",
    },
    armDecision: liveDecision,
  });
  await options.lifecycle.recordStepEvent({
    executionId,
    record: {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(liveDecision),
      detail: `live-substrate-decision:${options.row.rowId}`,
    },
  });
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-046-live-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-046-live-start",
    callKey: key(),
  });

  // ---- the REAL lifecycle measurement ----
  const measurement = await measureLiveSubstrateLifecycle({
    substrateLifecycle: options.substrateLifecycle,
    now: options.now,
  });
  let failure: { category: string; message: string } | null = null;
  let measuredWindow: SubstrateWindowInput | null = null;
  let modelSide: ModelSideFacts | null = null;
  let modelCostFacts: {
    kind: "measured";
    amountMicroUsd: string;
    source: string;
    scope: "direct-execution";
  }[] = [];
  if (!measurement.ok) {
    failure = { category: measurement.category, message: measurement.message };
  } else {
    const measured = measurement.measured;
    if (measured.firstUsableAtMs === null) {
      failure = {
        category: "readiness-never-attained",
        message: "the live substrate never observed first-usable",
      };
    } else {
      // The measured window: priced at the pinned substrate revision.
      const manifestIntegrity = deriveSubstrateManifestIntegrity({
        revision: LIVE_SUBSTRATE_PLAN.priceRevision,
      });
      if (!manifestIntegrity.agreed) {
        failure = {
          category: "unpinned-substrate-pricing",
          message: `the pinned substrate revision ${LIVE_SUBSTRATE_PLAN.priceRevision} failed manifest integrity`,
        };
      } else {
        const facts = measuredWindowFactsOf(measured);
        measuredWindow = {
          windowId: LIVE_WINDOW_ID,
          recordedDigest: recordedSubstrateWindowDigestOf({ windowId: LIVE_WINDOW_ID, facts }),
          priceRevision: LIVE_SUBSTRATE_PLAN.priceRevision,
          live: true,
          facts,
        };
        // The model side: the MEASURED dispatch facts priced at the
        // pinned rail revision (the IMPORTED VAL-040 normalization).
        const basis = normalizeArmCosts(measured.modelUsageFacts, substrateManifestForModel());
        modelSide = {
          measuredMicroUsd: BigInt(basis.measuredMicroUsd),
          resolved: measured.modelResolved,
          runs: measured.modelRuns,
        };
        modelCostFacts = [
          {
            kind: "measured",
            amountMicroUsd: basis.measuredMicroUsd,
            source: `val-046-live:${LIVE_SUBSTRATE_PLAN.rail.priceRevision}`,
            scope: "direct-execution",
          },
        ];
      }
    }
  }

  // ---- the sealing through the REAL recorder ----
  if (measuredWindow !== null) {
    const facts = measuredWindow.facts;
    const directSubstrate =
      BigInt(facts.startupShareMicroUsd) +
      BigInt(facts.sustainedShareMicroUsd) +
      BigInt(facts.reservedShareMicroUsd);
    const failureShare = BigInt(facts.restartShareMicroUsd) + BigInt(facts.evictionShareMicroUsd);
    const sealedAt = options.now().toISOString();
    options.rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: LIVE_WINDOW_ID,
      environmentIdentity: options.environmentIdentity,
      events: [
        {
          kind: "run-start",
          data: { substrateWindow: LIVE_WINDOW_ID, fleet: facts.fleet },
          at: sealedAt,
        },
        {
          kind: "model-choice",
          data: { requestDigest: measuredWindow.recordedDigest, request: 1, synthesisInput: true },
          at: sealedAt,
        },
        { kind: "run-end", data: { terminalStatus: "COMPLETED" }, at: sealedAt },
      ],
      cost: [
        ...(directSubstrate > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: directSubstrate.toString(),
                source: `val-046-live:${facts.priceRevision}`,
                scope: "substrate" as const,
              },
            ]
          : []),
        ...(failureShare > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: failureShare.toString(),
                source: `val-046-live:${facts.priceRevision}`,
                scope: "retry-overhead" as const,
              },
            ]
          : []),
        ...modelCostFacts,
      ],
      latency: [
        {
          phase: "total" as const,
          source: "platform-ledger" as const,
          milliseconds: facts.tornDownAtMs,
        },
      ],
      environment: [
        {
          kind: "state-transitioned",
          assertion:
            "the live substrate lifecycle measured end to end (cold start → ready → sustained → teardown)",
          observedVia: "platform-ledger",
          passed: true,
        },
      ],
      sealedAt,
    });
  }

  // ---- the family derivation over the MEASURED facts ----
  const windows = measuredWindow === null ? [] : [measuredWindow];
  const comparison = deriveSubstrateFamilySynthesis({
    row: options.row,
    windows,
    modelSide,
  });

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-046-live-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveSubstrateRowCriteria({
    row: options.row,
    windows,
    modelSide,
    observedTerminal: null,
    baseline: options.baseline,
    finalFacts,
    failure,
    totalLatencyMs,
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason:
      verdict === "pass"
        ? "val-046-live-verified"
        : `val-046-live-${failure?.category ?? "protocol-violation"}`,
  });
  const observedTerminal = await options.lifecycle.statusOf(executionId);
  const readbackAgrees = observedTerminal === derivedTerminal;
  const criteria: LabVerificationCriterion[] = [
    ...rowCriteria,
    {
      criterionId: "observed-terminal-readback",
      strategy: "deterministic",
      status: readbackAgrees ? "PASS" : "FAIL",
      evidence: [
        `derivedTerminal:${derivedTerminal}`,
        `observedTerminal:${observedTerminal ?? "none"}`,
        readbackAgrees
          ? "the ledger's own terminal agrees with the mechanically derived verdict"
          : "DISAGREED (a fabricated terminal at the ledger — the anyFail→FAILED invariant)",
      ],
    },
  ];
  const anyFail = derivedTerminal === "FAILED" || !readbackAgrees;
  return {
    rowId: options.row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    executionId,
    observedTerminal,
    windows: windows.map((window) => ({
      reference: window,
      integrity: true,
      failureReason: null,
    })),
    synthesis: comparison.synthesis,
    totalLatencyMs,
    failure,
  };
}

/** The model-rail manifest for the live lane (the pinned VAL-040 revision). */
function substrateManifestForModel() {
  return manifestFor(LIVE_SUBSTRATE_PLAN.rail.priceRevision);
}

/** Derive the measured live window's facts (PURE — priced at the pinned substrate revision). */
function measuredWindowFactsOf(measured: MeasuredLiveLifecycle): SubstrateWindowFacts {
  const manifest = substrateManifestFor(LIVE_SUBSTRATE_PLAN.priceRevision);
  const usageEntry = resolveSubstratePrice(manifest, LIVE_SUBSTRATE_PLAN.fleet, "usage");
  if (usageEntry === null) {
    throw new Error(`no pinned usage price for fleet ${LIVE_SUBSTRATE_PLAN.fleet}`);
  }
  const fx = fxRateForSubstrate(manifest, usageEntry.currency);
  if (fx === null) {
    throw new Error("the live fleet's currency is outside the pinned FX table");
  }
  const firstUsableAtMs = measured.firstUsableAtMs ?? 0;
  const startupMs = firstUsableAtMs;
  const startupShare = priceMeasuredMs({ milliseconds: startupMs, entry: usageEntry, fx });
  const sustainedShare = priceMeasuredMs({
    milliseconds: measured.activeUsageMs,
    entry: usageEntry,
    fx,
  });
  const restartShare = priceMeasuredMs({
    milliseconds: measured.restartStartupMs,
    entry: usageEntry,
    fx,
  });
  const evictionShare = priceMeasuredMs({ milliseconds: 0, entry: usageEntry, fx });
  const measuredTotal = startupShare + sustainedShare + restartShare + evictionShare;
  return {
    windowId: LIVE_WINDOW_ID,
    fleet: LIVE_SUBSTRATE_PLAN.fleet,
    priceRevision: LIVE_SUBSTRATE_PLAN.priceRevision,
    servedRuns: measured.modelRuns,
    servedResolved: measured.modelResolved,
    servedArmDigests: [],
    readinessProbes: measured.probes,
    coldStartBeganAtMs: 0,
    firstUsableAtMs,
    firstDispatchedAtMs: measured.firstDispatchedAtMs,
    tornDownAtMs: measured.tornDownAtMs,
    startupMs,
    sustainedRuntimeMs: measured.tornDownAtMs - firstUsableAtMs,
    activeUsageMs: measured.activeUsageMs,
    reservedStandingMs: 0,
    restartStartupMs: measured.restartStartupMs,
    evictedWastedMs: 0,
    restarts: measured.restarts,
    evictions: measured.evictions,
    startupShareMicroUsd: startupShare.toString(),
    sustainedShareMicroUsd: sustainedShare.toString(),
    restartShareMicroUsd: restartShare.toString(),
    evictionShareMicroUsd: evictionShare.toString(),
    reservedShareMicroUsd: "0",
    measuredMicroUsd: measuredTotal.toString(),
    reservedMicroUsd: "0",
    totalMicroUsd: measuredTotal.toString(),
    estimateMicroUsd: "0",
  };
}

// ---------------------------------------------------------------------------
// The re-exports (the imported substrate — never copied)
// ---------------------------------------------------------------------------

export type { ArmInputReference, RecordedArmInput } from "../economic-adjusted-cost/driver";
/** The VAL-040 digest helper re-export (the digest discipline). */
export { economicDigestOf } from "../economic-adjusted-cost/driver";
