/**
 * The RECORDED substrate telemetry (VAL-046, acceptance criterion 1 +
 * 2): the platform-side substrate lifecycle provenance — the pinned,
 * deterministic windows of measured substrate lifecycle facts the
 * substrate-cost families derive over.
 *
 * Each window is a RECORDED observation of one substrate lifecycle:
 *
 *   * READINESS — the probe telemetry (every readiness probe's
 *     timestamp + verdict); the FIRST-USABLE point is DERIVED from the
 *     probes (the first PASSING probe — never a declared claim, never
 *     the first-dispatched time: readiness is warm-up to FIRST-USABLE);
 *   * STARTUP — the cold-start-to-ready duration (the derived
 *     first-usable minus the cold-start begin) and each RESTART's own
 *     fresh-sandbox cold start (the VAL-022 fresh-sandbox discipline:
 *     a lost/timed-out sandbox is never re-entered);
 *   * SUSTAINED RUNTIME — the window's ready-to-teardown wallclock and
 *     the MEASURED active usage seconds (the substrate's actual
 *     compute) held SEPARATELY from any STANDING RESERVATION (the
 *     reserved capacity billed by the interval regardless of use);
 *   * RELIABILITY — the evictions (sandboxes the substrate lost) and
 *     restarts (fresh-sandbox recoveries) the window observed, with
 *     their wasted-compute seconds — the amortization inputs.
 *
 * The workload a window served is RE-DERIVED from the RECORDED arm
 * corpora (VAL-041/042/43 — the run provenance) through the IMPORTED
 * VAL-044 extractor (`recordedArmFactsOf` — the same derivation its
 * input-integrity oracle runs): the served run/resolved counts and the
 * served-run digests are never copied and never re-measured. The
 * reliability SHAPES cite the VAL-022 substrate records (the recorded
 * substrate failure/readiness telemetry) as provenance — digest-
 * referenced into the imported VAL-022 corpus, never copied.
 *
 * Everything is deterministic and PURE: zero network, zero credentials,
 * exact BigInt micro-USD through the pinned substrate manifest.
 */

import { armReferenceOf } from "../economic-adjusted-cost/corpus";
import type { ArmLabel } from "../economic-adjusted-cost/driver";
import { economicDigestOf, recordedArmFactsOf } from "../economic-adjusted-cost/driver";
import { SUBSTRATE_FAILURE_CORPUS } from "../substrate-failure/corpus";
import {
  fxRateForSubstrate,
  priceMeasuredMs,
  priceReservedMs,
  resolveSubstratePrice,
  substrateManifestFor,
} from "./pricing";

// ---------------------------------------------------------------------------
// The recorded window vocabulary
// ---------------------------------------------------------------------------

/** One recorded readiness probe observation. */
export interface SubstrateProbeObservation {
  /** Elapsed ms from the cold-start begin. */
  readonly atMs: number;
  readonly ready: boolean;
  /** The probe's own reason when it refused (carried for evidence). */
  readonly reason?: string;
}

/** The workload-provenance reference (a recorded arm corpus row this window served). */
export interface ServedArmRun {
  readonly armLabel: ArmLabel;
  readonly corpusRowId: string;
}

/** One pinned substrate lifecycle telemetry window (the recorded facts). */
export interface SubstrateWindowTelemetry {
  readonly windowId: string;
  readonly description: string;
  /** The substrate fleet the window ran on (priced in the substrate manifest). */
  readonly fleet: string;
  /** The pinned substrate price revision that priced this window. */
  readonly priceRevision: string;
  /** The RECORDED arm corpus rows this window served (the run provenance — re-derived, never copied). */
  readonly servedArmRuns: readonly ServedArmRun[];
  /**
   * The VAL-022 substrate records whose recorded shapes this window's
   * reliability events mirror (digest-referenced provenance).
   */
  readonly reliabilityProvenance: readonly { readonly val022RowId: string }[];
  readonly lifecycle: {
    /** The cold-start begin (the window's elapsed-zero point). */
    readonly coldStartBeganAtMs: number;
    /** The readiness probe telemetry, in order (FIRST-USABLE derives from it). */
    readonly probes: readonly SubstrateProbeObservation[];
    /** The first workload dispatch (elapsed ms — never the readiness point). */
    readonly firstDispatchedAtMs: number;
    /** The teardown (elapsed ms — the window's end). */
    readonly tornDownAtMs: number;
  };
  readonly usage: {
    /** MEASURED active usage: the compute-seconds the substrate actually executed. */
    readonly activeUsageMs: number;
    /** STANDING RESERVATION held while the window stayed alive (billed per interval — never usage). */
    readonly reservedStandingMs: number;
    /** The summed fresh-sandbox cold starts of the window's restarts. */
    readonly restartStartupMs: number;
    /** The wasted compute-seconds of the window's evicted sandboxes. */
    readonly evictedWastedMs: number;
    /** The fresh-sandbox restarts observed (the VAL-022 recovery discipline). */
    readonly restarts: number;
    /** The sandbox evictions observed (mid-execution losses). */
    readonly evictions: number;
  };
  /** The capacity planner's usage quote (ESTIMATE — reported separately, never conflated). */
  readonly estimate?: { readonly usageMs: number };
}

// ---------------------------------------------------------------------------
// The derived window facts (the digest-pinned derivation basis)
// ---------------------------------------------------------------------------

/** The derived facts of one recorded window (PURE — the integrity oracle's basis). */
export interface SubstrateWindowFacts {
  readonly windowId: string;
  readonly fleet: string;
  readonly priceRevision: string;
  /** The served workload (RE-DERIVED from the arm corpora — the run provenance). */
  readonly servedRuns: number;
  readonly servedResolved: number;
  readonly servedArmDigests: readonly string[];
  /** The readiness telemetry (carried — the first-usable derivation's basis). */
  readonly readinessProbes: readonly SubstrateProbeObservation[];
  /** The cold-start begin (elapsed zero point of the window). */
  readonly coldStartBeganAtMs: number;
  /** FIRST-USABLE (derived: the first PASSING probe's timestamp — never a claim). */
  readonly firstUsableAtMs: number;
  readonly firstDispatchedAtMs: number;
  readonly tornDownAtMs: number;
  /** STARTUP: cold-start → first-usable (the readiness wait). */
  readonly startupMs: number;
  /** The sustained runtime: first-usable → teardown. */
  readonly sustainedRuntimeMs: number;
  readonly activeUsageMs: number;
  readonly reservedStandingMs: number;
  readonly restartStartupMs: number;
  readonly evictedWastedMs: number;
  readonly restarts: number;
  readonly evictions: number;
  /** The five-share cost decomposition (each share priced exactly, then summed — the decomposition reconstructs by construction). */
  readonly startupShareMicroUsd: string;
  readonly sustainedShareMicroUsd: string;
  readonly restartShareMicroUsd: string;
  readonly evictionShareMicroUsd: string;
  readonly reservedShareMicroUsd: string;
  readonly measuredMicroUsd: string;
  readonly reservedMicroUsd: string;
  readonly totalMicroUsd: string;
  /** The planner quote priced (ESTIMATE — separate, never conflated). */
  readonly estimateMicroUsd: string;
}

/** The first PASSING probe's timestamp (PURE — the first-usable derivation). */
export function firstUsableOfProbes(probes: readonly SubstrateProbeObservation[]): number | null {
  for (const probe of probes) {
    if (probe.ready) {
      return probe.atMs;
    }
  }
  return null;
}

/**
 * Derive one recorded window's facts (PURE): the readiness point from
 * the PROBE TELEMETRY (the first passing probe — never a declared
 * claim), the served workload from the RECORDED arm corpora (the
 * imported VAL-044 extractor — never copied, never re-measured), and
 * the five-share cost decomposition priced EXACTLY through the pinned
 * substrate manifest (each share its own BigInt rational with one
 * half-up rounding; the totals are the sums of the rounded shares so
 * the decomposition reconstructs by construction).
 */
export function substrateWindowFactsOf(window: SubstrateWindowTelemetry): SubstrateWindowFacts {
  const manifest = substrateManifestFor(window.priceRevision);
  const usageEntry = resolveSubstratePrice(manifest, window.fleet, "usage");
  if (usageEntry === null) {
    throw new Error(`no pinned usage price for fleet ${window.fleet} in ${window.priceRevision}`);
  }
  const fx = fxRateForSubstrate(manifest, usageEntry.currency);
  if (fx === null) {
    throw new Error(
      `the fleet ${window.fleet}'s currency ${usageEntry.currency} is outside the pinned FX table`,
    );
  }
  const firstUsableAtMs = firstUsableOfProbes(window.lifecycle.probes);
  if (firstUsableAtMs === null) {
    throw new Error(
      `the recorded window ${window.windowId} has no passing readiness probe — first-usable never observed`,
    );
  }
  if (window.lifecycle.firstDispatchedAtMs < firstUsableAtMs) {
    throw new Error(
      `the recorded window ${window.windowId} dispatched before first-usable — unrepresentable telemetry`,
    );
  }
  // The served workload: RE-DERIVED from the recorded arm corpora.
  let servedRuns = 0;
  let servedResolved = 0;
  const servedArmDigests: string[] = [];
  for (const served of window.servedArmRuns) {
    const reference = armReferenceOf(served.armLabel, served.corpusRowId);
    const resolved = recordedArmFactsOf(reference);
    if (resolved === null) {
      throw new Error(
        `the served run ${served.armLabel}:${served.corpusRowId} failed to re-derive from the arm corpora`,
      );
    }
    servedRuns += resolved.facts.runCount;
    servedResolved += resolved.facts.resolvedCount;
    servedArmDigests.push(reference.recordedDigest);
  }
  const startupMs = firstUsableAtMs - window.lifecycle.coldStartBeganAtMs;
  const usage = window.usage;
  if (
    (usage.restarts > 0 && usage.restartStartupMs <= 0) ||
    (usage.restarts === 0 && usage.restartStartupMs !== 0)
  ) {
    throw new Error(
      `the recorded window ${window.windowId} restart facts are inconsistent (restarts ${usage.restarts}, startup ${usage.restartStartupMs}ms)`,
    );
  }
  if (
    (usage.evictions > 0 && usage.evictedWastedMs <= 0) ||
    (usage.evictions === 0 && usage.evictedWastedMs !== 0)
  ) {
    throw new Error(
      `the recorded window ${window.windowId} eviction facts are inconsistent (evictions ${usage.evictions}, wasted ${usage.evictedWastedMs}ms)`,
    );
  }
  // The five shares (each priced exactly, one half-up rounding each).
  const startupShare = priceMeasuredMs({
    milliseconds: startupMs,
    entry: usageEntry,
    fx,
  });
  const sustainedShare = priceMeasuredMs({
    milliseconds: usage.activeUsageMs,
    entry: usageEntry,
    fx,
  });
  const restartShare = priceMeasuredMs({
    milliseconds: usage.restartStartupMs,
    entry: usageEntry,
    fx,
  });
  const evictionShare = priceMeasuredMs({
    milliseconds: usage.evictedWastedMs,
    entry: usageEntry,
    fx,
  });
  const reservationEntry = resolveSubstratePrice(manifest, window.fleet, "reservation");
  if (usage.reservedStandingMs > 0 && reservationEntry === null) {
    throw new Error(
      `the recorded window ${window.windowId} holds a standing reservation but fleet ${window.fleet} has no pinned reservation price`,
    );
  }
  const reservedShare =
    usage.reservedStandingMs > 0 && reservationEntry !== null
      ? priceReservedMs({ milliseconds: usage.reservedStandingMs, entry: reservationEntry, fx })
      : 0n;
  const measured = startupShare + sustainedShare + restartShare + evictionShare;
  const estimate =
    window.estimate === undefined
      ? 0n
      : priceMeasuredMs({ milliseconds: window.estimate.usageMs, entry: usageEntry, fx });
  return {
    windowId: window.windowId,
    fleet: window.fleet,
    priceRevision: window.priceRevision,
    servedRuns,
    servedResolved,
    servedArmDigests,
    readinessProbes: window.lifecycle.probes,
    coldStartBeganAtMs: window.lifecycle.coldStartBeganAtMs,
    firstUsableAtMs,
    firstDispatchedAtMs: window.lifecycle.firstDispatchedAtMs,
    tornDownAtMs: window.lifecycle.tornDownAtMs,
    startupMs,
    sustainedRuntimeMs: window.lifecycle.tornDownAtMs - firstUsableAtMs,
    activeUsageMs: usage.activeUsageMs,
    reservedStandingMs: usage.reservedStandingMs,
    restartStartupMs: usage.restartStartupMs,
    evictedWastedMs: usage.evictedWastedMs,
    restarts: usage.restarts,
    evictions: usage.evictions,
    startupShareMicroUsd: startupShare.toString(),
    sustainedShareMicroUsd: sustainedShare.toString(),
    restartShareMicroUsd: restartShare.toString(),
    evictionShareMicroUsd: evictionShare.toString(),
    reservedShareMicroUsd: reservedShare.toString(),
    measuredMicroUsd: measured.toString(),
    reservedMicroUsd: reservedShare.toString(),
    totalMicroUsd: (measured + reservedShare).toString(),
    estimateMicroUsd: estimate.toString(),
  };
}

/**
 * The content digest of one window's DERIVED facts (PURE — the
 * digest-reference discipline): binds the window identity, the fleet +
 * the pinned price revision, the derived lifecycle (first-usable,
 * first-dispatched, teardown), the usage facts, the five-share cost
 * decomposition and the re-derived served workload digests.
 */
export function recordedSubstrateWindowDigestOf(input: {
  readonly windowId: string;
  readonly facts: SubstrateWindowFacts;
}): string {
  return economicDigestOf({
    windowId: input.windowId,
    fleet: input.facts.fleet,
    priceRevision: input.facts.priceRevision,
    coldStartBeganAtMs: input.facts.coldStartBeganAtMs,
    firstUsableAtMs: input.facts.firstUsableAtMs,
    firstDispatchedAtMs: input.facts.firstDispatchedAtMs,
    tornDownAtMs: input.facts.tornDownAtMs,
    startupMs: input.facts.startupMs,
    activeUsageMs: input.facts.activeUsageMs,
    reservedStandingMs: input.facts.reservedStandingMs,
    restartStartupMs: input.facts.restartStartupMs,
    evictedWastedMs: input.facts.evictedWastedMs,
    restarts: input.facts.restarts,
    evictions: input.facts.evictions,
    measuredMicroUsd: input.facts.measuredMicroUsd,
    reservedMicroUsd: input.facts.reservedMicroUsd,
    totalMicroUsd: input.facts.totalMicroUsd,
    servedRuns: input.facts.servedRuns,
    servedResolved: input.facts.servedResolved,
    servedArmDigests: input.facts.servedArmDigests,
  });
}

/**
 * The content digest of one VAL-022 substrate record (PURE): binds the
 * recorded row's oracle facts — the substrate failure/readiness
 * telemetry the reliability provenance cites.
 */
export function recordedSubstrateFailureDigestOf(rowId: string): string {
  const row = SUBSTRATE_FAILURE_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`the VAL-022 corpus declares no substrate record ${rowId}`);
  }
  return economicDigestOf({
    val022RowId: row.rowId,
    injectedClass: row.oracle.injectedClass,
    injectedRetryable: row.oracle.injectedRetryable,
    submissions: row.oracle.submissions.map((submission) => ({
      attempts: submission.attempts,
      attemptOutcomes: submission.attemptOutcomes,
      terminal: submission.terminal,
      substrateClass: submission.substrateClass,
      layer: submission.layer,
    })),
  });
}

// ---------------------------------------------------------------------------
// The pinned windows (the recorded substrate lifecycle telemetry)
// ---------------------------------------------------------------------------

const HEADLINE_DIRECT: ServedArmRun = {
  armLabel: "direct",
  corpusRowId: "fixed-quality-direct-default-rail",
};
const HEADLINE_OPTIMIZED: ServedArmRun = {
  armLabel: "optimized",
  corpusRowId: "fixed-quality-optimized-routing-cache-amortized",
};
const HEADLINE_COMPETING: ServedArmRun = {
  armLabel: "competing",
  corpusRowId: "fixed-quality-competitor-default-routing",
};
const ZERO_DIRECT: ServedArmRun = {
  armLabel: "direct",
  corpusRowId: "zero-resolved-direct-null-discipline",
};
const ZERO_OPTIMIZED: ServedArmRun = {
  armLabel: "optimized",
  corpusRowId: "zero-resolved-optimized-null-discipline",
};
const ZERO_COMPETING: ServedArmRun = {
  armLabel: "competing",
  corpusRowId: "zero-resolved-competitor-null-discipline",
};
const STOP_DIRECT: ServedArmRun = {
  armLabel: "direct",
  corpusRowId: "fixed-cost-direct-budget-exhausted-honest-stop",
};
const STOP_OPTIMIZED: ServedArmRun = {
  armLabel: "optimized",
  corpusRowId: "fixed-cost-optimized-budget-exhausted-honest-stop",
};
const STOP_COMPETING: ServedArmRun = {
  armLabel: "competing",
  corpusRowId: "fixed-cost-competitor-budget-exhausted-honest-stop",
};

/**
 * The HEADLINE windows: the three fleets' clean lifecycle recordings
 * serving the three arms' headline fixed-quality recordings (the 8-run
 * rows — the substrate-side provenance of the comparable workload).
 */
const HEADLINE_WINDOWS: readonly SubstrateWindowTelemetry[] = [
  {
    windowId: "window-warm-fleet-a-headline",
    description:
      "The warm fleet's headline window: a two-refusal warm-up (capacity probes at 400ms and 900ms refused — the VAL-022 readiness-refused-transient shape), first-usable at 1400ms, serving the direct arm's 8-run headline recording on measured usage only (no standing reservation — the on-demand posture).",
    fleet: "warm-fleet-a",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_DIRECT],
    reliabilityProvenance: [{ val022RowId: "readiness-refused-transient" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 400, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 900, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 1400, ready: true },
      ],
      firstDispatchedAtMs: 2100,
      tornDownAtMs: 92000,
    },
    usage: {
      activeUsageMs: 22000,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
    estimate: { usageMs: 26000 },
  },
  {
    windowId: "window-reserved-fleet-c-headline",
    description:
      "The reserved fleet's headline window: an instant warm-pool readiness (first-usable at 300ms), a 120s standing reservation (2 × 60s intervals — the reserved capacity billed whether idle or busy) held while serving the optimized arm's 8-run headline recording, and ONE fresh-sandbox restart after a mid-window sandbox loss (the VAL-022 sandbox-lost-recovery shape — the lost sandbox is never re-entered; the restart's own 2.6s cold start is priced in the restart share).",
    fleet: "reserved-fleet-c",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_OPTIMIZED],
    reliabilityProvenance: [{ val022RowId: "sandbox-lost-recovery" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [{ atMs: 300, ready: true }],
      firstDispatchedAtMs: 900,
      tornDownAtMs: 148000,
    },
    usage: {
      activeUsageMs: 26000,
      reservedStandingMs: 120000,
      restartStartupMs: 2600,
      evictedWastedMs: 0,
      restarts: 1,
      evictions: 0,
    },
    estimate: { usageMs: 30000 },
  },
  {
    windowId: "window-cold-fleet-b-headline",
    description:
      "The cold fleet's headline window: the slow spot warm-up (four refused probes before first-usable at 4000ms — the startup-cost contrast the readiness families expose) serving the competing arm's 8-run headline recording on measured usage only.",
    fleet: "cold-fleet-b",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_COMPETING],
    reliabilityProvenance: [{ val022RowId: "healthy-substrate" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 800, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 1600, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 2400, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 3200, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 4000, ready: true },
      ],
      firstDispatchedAtMs: 4600,
      tornDownAtMs: 76000,
    },
    usage: {
      activeUsageMs: 12000,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
    estimate: { usageMs: 15000 },
  },
];

/**
 * The RELIABILITY windows: the failure-heavy lifecycle recordings —
 * readiness refusals, fresh-sandbox restarts and sandbox evictions
 * with their wasted compute (the VAL-022 recorded shapes), serving the
 * same three arms' headline recordings. The failure-amortization
 * family's honest surface: the restart and eviction shares are real.
 */
const RELIABILITY_WINDOWS: readonly SubstrateWindowTelemetry[] = [
  {
    windowId: "window-eu-warm-fleet-d-reliability",
    description:
      "The EU warm fleet's reliability window: a two-refusal warm-up, one mid-execution sandbox EVICTION (12s of compute consumed then lost — priced in the eviction share) and one fresh-sandbox restart (3.1s cold start), serving the direct arm's 8-run headline recording. EUR-denominated usage converts through the pinned VAL-040 FX table.",
    fleet: "eu-warm-fleet-d",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_DIRECT],
    reliabilityProvenance: [
      { val022RowId: "readiness-refused-transient" },
      { val022RowId: "sandbox-lost-persistent" },
      { val022RowId: "sandbox-lost-recovery" },
    ],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 500, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 1100, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 1700, ready: true },
      ],
      firstDispatchedAtMs: 2200,
      tornDownAtMs: 88000,
    },
    usage: {
      activeUsageMs: 41000,
      reservedStandingMs: 0,
      restartStartupMs: 3100,
      evictedWastedMs: 9500,
      restarts: 1,
      evictions: 1,
    },
    estimate: { usageMs: 45000 },
  },
  {
    windowId: "window-reserved-fleet-c-reliability",
    description:
      "The reserved fleet's reliability window: a one-refusal warm-up, TWO fresh-sandbox restarts (5.2s of summed cold starts), ONE eviction (12s of wasted compute) and a 180s standing reservation (3 intervals), serving the optimized arm's 8-run headline recording.",
    fleet: "reserved-fleet-c",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_OPTIMIZED],
    reliabilityProvenance: [
      { val022RowId: "readiness-refused-transient" },
      { val022RowId: "sandbox-lost-persistent" },
      { val022RowId: "sandbox-lost-recovery" },
    ],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 600, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 1200, ready: true },
      ],
      firstDispatchedAtMs: 1800,
      tornDownAtMs: 150000,
    },
    usage: {
      activeUsageMs: 55000,
      reservedStandingMs: 180000,
      restartStartupMs: 5200,
      evictedWastedMs: 12000,
      restarts: 2,
      evictions: 1,
    },
    estimate: { usageMs: 60000 },
  },
  {
    windowId: "window-cold-fleet-b-reliability",
    description:
      "The cold fleet's reliability window: a two-refusal slow warm-up and one fresh-sandbox restart (4.4s cold start), serving the competing arm's 8-run headline recording on measured usage only.",
    fleet: "cold-fleet-b",
    priceRevision: "sub-rev-001",
    servedArmRuns: [HEADLINE_COMPETING],
    reliabilityProvenance: [
      { val022RowId: "readiness-refused-transient" },
      { val022RowId: "sandbox-lost-recovery" },
    ],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 900, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 1800, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 2700, ready: true },
      ],
      firstDispatchedAtMs: 3300,
      tornDownAtMs: 68000,
    },
    usage: {
      activeUsageMs: 25000,
      reservedStandingMs: 0,
      restartStartupMs: 4400,
      evictedWastedMs: 0,
      restarts: 1,
      evictions: 0,
    },
    estimate: { usageMs: 30000 },
  },
];

/** The ZERO windows: serving the three arms' zero-resolved recordings (6 runs, 0 resolved each). */
const ZERO_WINDOWS: readonly SubstrateWindowTelemetry[] = [
  {
    windowId: "window-warm-fleet-a-zero",
    description:
      "The warm fleet's zero-resolved window: a one-refusal warm-up serving the direct arm's 6-run zero-resolved recording — the substrate cost is real while NOTHING resolved (the amortized-per-resolved family's honest NULL surface).",
    fleet: "warm-fleet-a",
    priceRevision: "sub-rev-001",
    servedArmRuns: [ZERO_DIRECT],
    reliabilityProvenance: [{ val022RowId: "readiness-refused-transient" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 1000, ready: false, reason: "no warm sandbox available at submission" },
        { atMs: 2000, ready: true },
      ],
      firstDispatchedAtMs: 2600,
      tornDownAtMs: 40000,
    },
    usage: {
      activeUsageMs: 15000,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
  {
    windowId: "window-cold-fleet-b-zero",
    description:
      "The cold fleet's zero-resolved window: a slow two-probe warm-up serving the optimized arm's 6-run zero-resolved recording.",
    fleet: "cold-fleet-b",
    priceRevision: "sub-rev-001",
    servedArmRuns: [ZERO_OPTIMIZED],
    reliabilityProvenance: [{ val022RowId: "healthy-substrate" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 1500, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 3000, ready: true },
      ],
      firstDispatchedAtMs: 3500,
      tornDownAtMs: 28000,
    },
    usage: {
      activeUsageMs: 9000,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
  {
    windowId: "window-eu-warm-fleet-d-zero",
    description:
      "The EU warm fleet's zero-resolved window: an instant readiness serving the competing arm's 6-run zero-resolved recording.",
    fleet: "eu-warm-fleet-d",
    priceRevision: "sub-rev-001",
    servedArmRuns: [ZERO_COMPETING],
    reliabilityProvenance: [{ val022RowId: "healthy-substrate" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [{ atMs: 800, ready: true }],
      firstDispatchedAtMs: 1200,
      tornDownAtMs: 33000,
    },
    usage: {
      activeUsageMs: 12000,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
];

/** The STOP windows: serving the three arms' honest budget-stop prefix recordings (3 runs each). */
const STOP_WINDOWS: readonly SubstrateWindowTelemetry[] = [
  {
    windowId: "window-warm-fleet-a-stop",
    description:
      "The warm fleet's stop-prefix window: an instant readiness serving the direct arm's 3-run honest budget-stop recording — the starved sample the below-minimum refusal derives over.",
    fleet: "warm-fleet-a",
    priceRevision: "sub-rev-001",
    servedArmRuns: [STOP_DIRECT],
    reliabilityProvenance: [{ val022RowId: "healthy-substrate" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [{ atMs: 1200, ready: true }],
      firstDispatchedAtMs: 1600,
      tornDownAtMs: 21000,
    },
    usage: {
      activeUsageMs: 7500,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
  {
    windowId: "window-reserved-fleet-c-stop",
    description:
      "The reserved fleet's stop-prefix window: an instant readiness and a single 60s standing interval serving the optimized arm's 3-run honest budget-stop recording.",
    fleet: "reserved-fleet-c",
    priceRevision: "sub-rev-001",
    servedArmRuns: [STOP_OPTIMIZED],
    reliabilityProvenance: [{ val022RowId: "healthy-substrate" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [{ atMs: 700, ready: true }],
      firstDispatchedAtMs: 1100,
      tornDownAtMs: 65000,
    },
    usage: {
      activeUsageMs: 6000,
      reservedStandingMs: 60000,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
  {
    windowId: "window-cold-fleet-b-stop",
    description:
      "The cold fleet's stop-prefix window: a one-refusal warm-up serving the competing arm's 3-run honest budget-stop recording.",
    fleet: "cold-fleet-b",
    priceRevision: "sub-rev-001",
    servedArmRuns: [STOP_COMPETING],
    reliabilityProvenance: [{ val022RowId: "readiness-refused-transient" }],
    lifecycle: {
      coldStartBeganAtMs: 0,
      probes: [
        { atMs: 2000, ready: false, reason: "cold capacity still provisioning" },
        { atMs: 3600, ready: true },
      ],
      firstDispatchedAtMs: 4100,
      tornDownAtMs: 18000,
    },
    usage: {
      activeUsageMs: 4500,
      reservedStandingMs: 0,
      restartStartupMs: 0,
      evictedWastedMs: 0,
      restarts: 0,
      evictions: 0,
    },
  },
];

/** The complete recorded telemetry corpus (every pinned window). */
export const SUBSTRATE_TELEMETRY: readonly SubstrateWindowTelemetry[] = [
  ...HEADLINE_WINDOWS,
  ...RELIABILITY_WINDOWS,
  ...ZERO_WINDOWS,
  ...STOP_WINDOWS,
];

/** The window sets by name (the corpus rows' pre-registered inputs). */
export const TELEMETRY_SETS: Readonly<
  Record<"headline" | "reliability" | "zero" | "stop", readonly SubstrateWindowTelemetry[]>
> = Object.freeze({
  headline: HEADLINE_WINDOWS,
  reliability: RELIABILITY_WINDOWS,
  zero: ZERO_WINDOWS,
  stop: STOP_WINDOWS,
});

/** Look up one recorded window by id (the reference resolution). */
export function substrateWindowById(windowId: string): SubstrateWindowTelemetry | null {
  return SUBSTRATE_TELEMETRY.find((candidate) => candidate.windowId === windowId) ?? null;
}
