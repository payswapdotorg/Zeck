/**
 * VAL-046 acceptance criteria 4, 5 and 6 (the driver's oracles + the
 * discrimination floor): the substrate-cost families' mechanical
 * verification over the RECORDED substrate telemetry.
 *
 *   * the oracle matrices: the startup-cost inclusion (an honest
 *     five-share decomposition passes; a claimed-away startup share
 *     FAILs named), the readiness-probe honesty (first-usable derived
 *     from the first PASSING probe; an inflated claim FAILs named),
 *     the reserved/measured separation (the recorded split passes; a
 *     conflation FAILs named), the failure-amortization completeness
 *     (restarts and evictions priced; amortization-away FAILs named),
 *     the estimate/measure separation and the confidence-and-minimum
 *     enforcement (Wilson carried, minimums held, no post-hoc window
 *     exclusion);
 *   * the input-integrity matrix: the honest digest-referenced bundles
 *     verify against the RECORDED telemetry; a re-measurement
 *     masquerading as derivation FAILs named; a disagreeing digest
 *     FAILs; an unresolvable reference FAILs; an unpinned substrate
 *     price revision FAILs;
 *   * the substrate price manifest's integrity (content-addressed,
 *     append-only, public-list-only, FX through the VAL-040 pinned
 *     table);
 *   * the driver over EVERY offline row (the 6 honest verdict rows
 *     COMPLETE reproducing the pinned syntheses; the 7 adversarial
 *     probes FAIL their named criteria) and the live lane over the
 *     deterministic fake lifecycle port (the measured window's
 *     mechanics).
 */

import { describe, expect, test } from "vitest";
import { pooledFactsOf } from "../../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import {
  SUBSTRATE_CORPUS,
  SUBSTRATE_CORPUS_VERSION,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/corpus";
import type {
  LiveSubstrateLifecyclePort,
  SubstrateCorpusRow,
  SubstrateWindowInput,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  armInputsOf,
  deriveBelowMinimumRefusalHonesty,
  deriveConfidenceAndMinimum,
  deriveEstimateMeasureSeparation,
  deriveFailureAmortizationCompleteness,
  deriveReadinessProbeHonesty,
  deriveReservedMeasuredSeparation,
  deriveStartupCostInclusion,
  deriveSubstrateFamilySynthesis,
  deriveSubstrateInputIntegrity,
  driveLiveSubstrateRow,
  driveSubstrateRow,
  LIVE_SUBSTRATE_PLAN,
  liveSubstratePlanDigestOf,
  pooledSubstrateFactsOf,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  applySubstrateAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  windowInputsForRow,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/fixtures";
import {
  deriveSubstrateManifestAppendOnly,
  deriveSubstrateManifestIntegrity,
  priceMeasuredMs,
  priceReservedMs,
  resolveSubstratePrice,
  substrateManifestFor,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import { SUBSTRATE_TELEMETRY } from "../../../benchmarks/validation/apps/economic-substrate-runtime/telemetry";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "7c31a09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const _noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-046",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: SUBSTRATE_CORPUS_VERSION,
  integrationSurface: "synthesis:recorded-substrate-telemetry",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-046-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): SubstrateCorpusRow => {
  const row = SUBSTRATE_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** The model side of a row (the RECORDED arm facts pooled — never re-measured). */
const modelSideOf = (row: SubstrateCorpusRow) => {
  if (row.armSet.length === 0) {
    return null;
  }
  const pooled = pooledFactsOf(armInputsOf(row.armSet));
  return {
    measuredMicroUsd: pooled.measuredMicroUsd,
    resolved: pooled.resolved,
    runs: pooled.runs,
  };
};

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(
  row: SubstrateCorpusRow,
  options: { readonly windows?: readonly SubstrateWindowInput[] } = {},
) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({ key: `val-046-unit-${row.rowId}`, body: taskBodyFor({ row }) });
  const result = await driveSubstrateRow({
    row,
    lifecycle,
    windows: options.windows ?? windowInputsForRow(row),
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-046-unit-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

const headlineWindows = (): readonly SubstrateWindowInput[] =>
  windowInputsForRow(rowById("substrate-cost-per-run-three-fleet-synthesis"));

const reliabilityWindows = (): readonly SubstrateWindowInput[] =>
  windowInputsForRow(rowById("substrate-reliability-failure-amortization-synthesis"));

// ---------------------------------------------------------------------------
// The substrate price manifest
// ---------------------------------------------------------------------------

describe("VAL-046 substrate price manifest (the pinning discipline)", () => {
  test("the pinned registry is append-only with content-addressed revisions", () => {
    const appendOnly = deriveSubstrateManifestAppendOnly();
    expect(appendOnly.appendOnly).toBe(true);
    expect(appendOnly.revisions).toEqual(["sub-rev-001", "sub-rev-002"]);
    expect(appendOnly.evidence.join(" ")).toContain("correctionsAreNewRevisions");
  });

  test("the declared revision's integrity agrees (digest + tables + FX basis)", () => {
    const verdict = deriveSubstrateManifestIntegrity({ revision: "sub-rev-001" });
    expect(verdict.agreed).toBe(true);
    expect(verdict.declaredRevisionKnown).toBe(true);
    expect(verdict.digestAgrees).toBe(true);
    expect(verdict.tablesValid).toBe(true);
    expect(verdict.fxValid).toBe(true);
    expect(verdict.evidence.join(" ")).toContain("fxBasis:rev-001");
  });

  test("an unknown substrate revision FAILs integrity", () => {
    const verdict = deriveSubstrateManifestIntegrity({ revision: "sub-rev-999" });
    expect(verdict.agreed).toBe(false);
    expect(verdict.declaredRevisionKnown).toBe(false);
  });

  test("the append-only correction (sub-rev-002) prices warm-fleet-a differently but keeps rev-001 frozen", () => {
    const rev1 = substrateManifestFor("sub-rev-001");
    const rev2 = substrateManifestFor("sub-rev-002");
    const rev1Price = resolveSubstratePrice(rev1, "warm-fleet-a", "usage")?.price;
    const rev2Price = resolveSubstratePrice(rev2, "warm-fleet-a", "usage")?.price;
    expect(rev1Price).toBe("0.000061");
    expect(rev2Price).toBe("0.000058");
    expect(rev2.supersedes).toBe("sub-rev-001");
    expect(deriveSubstrateManifestIntegrity({ revision: "sub-rev-001" }).agreed).toBe(true);
  });

  test("the exact micro-USD pricing arithmetic (BigInt rationals, half-up)", () => {
    const manifest = substrateManifestFor("sub-rev-001");
    const entry = resolveSubstratePrice(manifest, "warm-fleet-a", "usage");
    const fx = { currency: "USD" as const, microUsdPerUnit: "1000000", asOf: "", sourceRef: "" };
    if (entry === null) {
      throw new Error("no warm-fleet-a usage price");
    }
    // 1000ms at $0.000061/s = 61 µ$ exactly.
    expect(priceMeasuredMs({ milliseconds: 1000, entry, fx })).toBe(61n);
    // 1400ms → 85.4 → 85 µ$ (half-up).
    expect(priceMeasuredMs({ milliseconds: 1400, entry, fx })).toBe(85n);
    const reservation = resolveSubstratePrice(manifest, "reserved-fleet-c", "reservation");
    if (reservation === null) {
      throw new Error("no reserved-fleet-c reservation price");
    }
    // 120000ms of standing at $0.0019 per 60s interval = 2 × 1900 µ$.
    expect(priceReservedMs({ milliseconds: 120000, entry: reservation, fx })).toBe(3800n);
    // 60001ms of standing still rounds UP to 2 intervals (ceil-to-interval).
    expect(priceReservedMs({ milliseconds: 60001, entry: reservation, fx })).toBe(3800n);
  });

  test("the EUR fleet converts through the VAL-040 pinned FX table", () => {
    const manifest = substrateManifestFor("sub-rev-001");
    const entry = resolveSubstratePrice(manifest, "eu-warm-fleet-d", "usage");
    if (entry === null) {
      throw new Error("no eu-warm-fleet-d usage price");
    }
    // 1000ms at €0.000055/s × 1.03 = 56.65 → 57 µ$.
    const fx = { currency: "EUR" as const, microUsdPerUnit: "1030000", asOf: "", sourceRef: "" };
    expect(priceMeasuredMs({ milliseconds: 1000, entry, fx })).toBe(57n);
  });
});

// ---------------------------------------------------------------------------
// The startup-cost inclusion oracle
// ---------------------------------------------------------------------------

describe("VAL-046 startup-cost inclusion (the never-hidden oracle)", () => {
  test("the honest five-share decomposition reconstructs on every recorded window", () => {
    const startup = deriveStartupCostInclusion({ windows: headlineWindows() });
    expect(startup.conformant).toBe(true);
    for (const window of [...headlineWindows(), ...reliabilityWindows()]) {
      const measured = BigInt(window.facts.measuredMicroUsd);
      const decomposition =
        BigInt(window.facts.startupShareMicroUsd) +
        BigInt(window.facts.sustainedShareMicroUsd) +
        BigInt(window.facts.restartShareMicroUsd) +
        BigInt(window.facts.evictionShareMicroUsd);
      expect(measured).toBe(decomposition);
      expect(BigInt(window.facts.totalMicroUsd)).toBe(
        measured + BigInt(window.facts.reservedMicroUsd),
      );
    }
  });

  test("every recorded warm-up is priced (a positive startup share on every window)", () => {
    for (const window of headlineWindows()) {
      expect(window.facts.startupMs).toBeGreaterThan(0);
      expect(BigInt(window.facts.startupShareMicroUsd)).toBeGreaterThan(0n);
    }
  });

  test("a claimed zero startup share against a recorded warm-up FAILs named (STARTUP-HIDING)", () => {
    const windows = applySubstrateAdversarialVariant(headlineWindows(), { startupHiding: true });
    const startup = deriveStartupCostInclusion({ windows });
    expect(startup.conformant).toBe(false);
    expect(startup.evidence.join(" ")).toContain("STARTUP-HIDING");
    expect(startup.evidence.join(" ")).toContain("window-warm-fleet-a-headline");
  });

  test("the startup-hiding PROBE row FAILs its named criterion and the row terminal", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-startup-hiding"));
    expect(criterionOf(result, "startup-cost-inclusion")?.status).toBe("FAIL");
    expect(criterionOf(result, "startup-cost-inclusion")?.evidence.join(" ")).toContain(
      "STARTUP-HIDING",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The readiness-probe honesty oracle
// ---------------------------------------------------------------------------

describe("VAL-046 readiness-probe honesty (the first-usable oracle)", () => {
  test("first-usable is DERIVED from the first PASSING probe on every recorded window", () => {
    const readiness = deriveReadinessProbeHonesty({ windows: headlineWindows() });
    expect(readiness.conformant).toBe(true);
    for (const window of headlineWindows()) {
      const firstPassing = window.facts.readinessProbes.find((probe) => probe.ready);
      expect(firstPassing).toBeDefined();
      expect(window.facts.firstUsableAtMs).toBe(firstPassing?.atMs);
      // Readiness is never the first-dispatched point.
      expect(window.facts.firstDispatchedAtMs).toBeGreaterThanOrEqual(window.facts.firstUsableAtMs);
    }
  });

  test("the cold fleet's slow warm-up is honestly 4000ms (four refused probes first)", () => {
    const cold = headlineWindows().find(
      (window) => window.facts.windowId === "window-cold-fleet-b-headline",
    );
    if (cold === undefined) {
      throw new Error("missing cold window");
    }
    expect(cold.facts.readinessProbes.filter((probe) => !probe.ready)).toHaveLength(4);
    expect(cold.facts.firstUsableAtMs).toBe(4000);
    expect(cold.facts.startupMs).toBe(4000);
    expect(cold.facts.firstDispatchedAtMs).toBe(4600);
  });

  test("a claimed first-usable at a REFUSED probe FAILs named (READINESS INFLATION)", () => {
    const windows = applySubstrateAdversarialVariant(headlineWindows(), {
      readinessInflation: true,
    });
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("READINESS INFLATION");
    expect(readiness.evidence.join(" ")).toContain("400");
    expect(readiness.evidence.join(" ")).toContain("1400");
  });

  test("a startup duration using FIRST-DISPATCHED FAILs named (the misattribution)", () => {
    const windows = applySubstrateAdversarialVariant(headlineWindows(), {
      firstDispatchedMisattribution: true,
    });
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("FIRST-DISPATCHED MISATTRIBUTION");
  });

  test("the readiness-inflation PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-readiness-inflation"));
    expect(criterionOf(result, "readiness-probe-honesty")?.status).toBe("FAIL");
    expect(criterionOf(result, "readiness-probe-honesty")?.evidence.join(" ")).toContain(
      "READINESS INFLATION",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The reserved/measured separation oracle
// ---------------------------------------------------------------------------

describe("VAL-046 reserved/measured separation (the standing-capacity oracle)", () => {
  test("the honest split bills the standing reservation by the interval and the usage by the second", () => {
    const separation = deriveReservedMeasuredSeparation({ windows: headlineWindows() });
    expect(separation.conformant).toBe(true);
    const reserved = headlineWindows().find(
      (window) => window.facts.windowId === "window-reserved-fleet-c-headline",
    );
    if (reserved === undefined) {
      throw new Error("missing reserved window");
    }
    expect(reserved.facts.reservedStandingMs).toBe(120000);
    expect(reserved.facts.reservedMicroUsd).toBe("3800"); // 2 × 60s intervals × $0.0019
    expect(BigInt(reserved.facts.measuredMicroUsd)).toBeGreaterThan(0n);
  });

  test("a claimed measured total absorbing the standing reservation FAILs named (CONFLATION)", () => {
    const windows = applySubstrateAdversarialVariant(headlineWindows(), {
      reservedConflation: true,
    });
    const separation = deriveReservedMeasuredSeparation({ windows });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("RESERVED/MEASURED CONFLATION");
  });

  test("on-demand windows carry NO reserved share (the separation is structural)", () => {
    for (const windowId of ["window-warm-fleet-a-headline", "window-cold-fleet-b-headline"]) {
      const window = headlineWindows().find((candidate) => candidate.facts.windowId === windowId);
      if (window === undefined) {
        throw new Error(`missing window ${windowId}`);
      }
      expect(window.facts.reservedStandingMs).toBe(0);
      expect(window.facts.reservedMicroUsd).toBe("0");
    }
  });

  test("the reserved-conflation PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-reserved-measured-conflation"));
    expect(criterionOf(result, "reserved-measured-separation")?.status).toBe("FAIL");
    expect(criterionOf(result, "reserved-measured-separation")?.evidence.join(" ")).toContain(
      "RESERVED/MEASURED CONFLATION",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The failure-amortization completeness oracle
// ---------------------------------------------------------------------------

describe("VAL-046 failure-amortization completeness (the restart/eviction oracle)", () => {
  test("the honest reliability windows price every restart's cold start and every eviction's wasted compute", () => {
    const failure = deriveFailureAmortizationCompleteness({ windows: reliabilityWindows() });
    expect(failure.conformant).toBe(true);
    const pooled = pooledSubstrateFactsOf(reliabilityWindows());
    expect(pooled.restarts).toBe(4);
    expect(pooled.evictions).toBe(2);
    expect(pooled.restartShareMicroUsd).toBeGreaterThan(0n);
    expect(pooled.evictionShareMicroUsd).toBeGreaterThan(0n);
  });

  test("claimed-away restart/eviction shares against recorded failure counts FAIL named", () => {
    const windows = applySubstrateAdversarialVariant(reliabilityWindows(), {
      failureAmortizationAway: true,
    });
    const failure = deriveFailureAmortizationCompleteness({ windows });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("FAILURE AMORTIZATION-AWAY");
  });

  test("the failure-amortization-away PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-failure-amortization-away"));
    expect(criterionOf(result, "failure-amortization-completeness")?.status).toBe("FAIL");
    expect(criterionOf(result, "failure-amortization-completeness")?.evidence.join(" ")).toContain(
      "FAILURE AMORTIZATION-AWAY",
    );
    expect(result.terminal).toBe("FAILED");
  });

  test("the reliability provenance cites VAL-022 substrate records that resolve", async () => {
    const { recordedSubstrateFailureDigestOf } = await import(
      "../../../benchmarks/validation/apps/economic-substrate-runtime/telemetry"
    );
    for (const window of SUBSTRATE_TELEMETRY) {
      for (const cited of window.reliabilityProvenance) {
        expect(() => recordedSubstrateFailureDigestOf(cited.val022RowId)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The estimate/measure separation oracle
// ---------------------------------------------------------------------------

describe("VAL-046 estimate/measure separation (the quote-never-conflated oracle)", () => {
  test("the honest windows' measured basis equals the recorded one and the quote rides separately", () => {
    const separation = deriveEstimateMeasureSeparation({ windows: headlineWindows() });
    expect(separation.conformant).toBe(true);
    const pooled = pooledSubstrateFactsOf(headlineWindows());
    expect(pooled.estimateMicroUsd).toBeGreaterThan(0n);
    expect(pooled.measuredMicroUsd).toBeGreaterThan(0n);
    // The quote is a capacity-planner estimate reported SEPARATELY —
    // never inside the measured basis.
    expect(separation.evidence.join(" ")).toContain("SEPARATELY");
  });
});

// ---------------------------------------------------------------------------
// The confidence-and-minimum + refusal-honesty oracles
// ---------------------------------------------------------------------------

describe("VAL-046 confidence-and-minimum enforcement (the pre-registered set + the Wilson)", () => {
  test("the honest headline comparison carries the Wilson interval and meets the minimums", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const confidence = deriveConfidenceAndMinimum({ row, windows: headlineWindows() });
    expect(confidence.conformant).toBe(true);
    expect(confidence.belowMinimum).toBe(false);
    expect(confidence.wilson).not.toBeNull();
    expect(confidence.wilson?.low).toBeLessThanOrEqual(1);
    expect(confidence.wilson?.high).toBeLessThanOrEqual(1);
  });

  test("a dropped pre-registered window FAILs named (post-hoc exclusion)", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const windows = headlineWindows().slice(0, 2);
    const confidence = deriveConfidenceAndMinimum({ row, windows });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("post-hoc-excluded");
  });

  test("an undeclared window FAILs named", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const extra = windowInputsForRow(
      rowById("substrate-reliability-failure-amortization-synthesis"),
    );
    const undeclared = extra.find(
      (window) =>
        !headlineWindows().some((candidate) => candidate.facts.windowId === window.facts.windowId),
    );
    expect(undeclared).toBeDefined();
    const confidence = deriveConfidenceAndMinimum({
      row,
      windows: [...headlineWindows(), ...(undeclared === undefined ? [] : [undeclared])],
    });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("undeclared-window");
  });

  test("the starved stop-prefix set is below-minimum and must REFUSE", () => {
    const row = rowById("readiness-adjusted-below-minimum-honest-refusal");
    const windows = windowInputsForRow(row);
    const confidence = deriveConfidenceAndMinimum({ row, windows });
    expect(confidence.belowMinimum).toBe(true);
    const refusal = deriveBelowMinimumRefusalHonesty({ row, windows });
    expect(refusal.conformant).toBe(true);
  });

  test("the sample-size-violation PROBE row (comparability claimed below minimum) FAILs named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-sample-size-violation"));
    expect(criterionOf(result, "below-minimum-refusal-honesty")?.status).toBe("FAIL");
    expect(criterionOf(result, "below-minimum-refusal-honesty")?.evidence.join(" ")).toContain(
      "BELOW-MINIMUM COMPARABILITY CLAIM",
    );
    expect(result.terminal).toBe("FAILED");
  });

  test("the post-hoc-exclusion PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-post-hoc-exclusion"));
    expect(criterionOf(result, "confidence-and-minimum")?.status).toBe("FAIL");
    expect(criterionOf(result, "confidence-and-minimum")?.evidence.join(" ")).toContain(
      "post-hoc-excluded",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The substrate input-integrity oracle
// ---------------------------------------------------------------------------

describe("VAL-046 substrate input integrity (the re-measurement catch)", () => {
  test("the honest digest-referenced bundles verify against the recorded telemetry", () => {
    const integrity = deriveSubstrateInputIntegrity({ windows: headlineWindows() });
    expect(integrity.conformant).toBe(true);
    expect(integrity.verdicts).toHaveLength(3);
    for (const verdict of integrity.verdicts) {
      expect(verdict.integrity).toBe(true);
      expect(verdict.failureReason).toBeNull();
    }
  });

  test("a re-measured served run count FAILs named (the masquerade)", () => {
    const windows = applySubstrateAdversarialVariant(headlineWindows(), { remeasurement: true });
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
  });

  test("a disagreeing digest FAILs named", () => {
    const windows = headlineWindows().map((window, index) =>
      index === 0 ? { ...window, recordedDigest: "deadbeef" } : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("DIGEST-DISAGREED");
  });

  test("an unresolvable window reference FAILs named", () => {
    const windows = headlineWindows().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: { ...window.facts, windowId: "window-does-not-exist" },
          }
        : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("UNRESOLVABLE DIGEST REFERENCE");
  });

  test("an unpinned substrate price revision FAILs named", () => {
    const windows = headlineWindows().map((window, index) =>
      index === 0 ? { ...window, priceRevision: "sub-rev-999" } : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("UNPINNED SUBSTRATE PRICING");
  });

  test("the re-measurement-masquerade PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-remeasurement-masquerade"));
    expect(criterionOf(result, "substrate-input-integrity")?.status).toBe("FAIL");
    expect(criterionOf(result, "substrate-input-integrity")?.evidence.join(" ")).toContain(
      "RE-MEASUREMENT MASQUERADE",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The family synthesis (the three substrate-cost families)
// ---------------------------------------------------------------------------

describe("VAL-046 the substrate-cost families (the synthesis derivations)", () => {
  test("substrate cost per run = pooled total / recorded runs (24)", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const family = deriveSubstrateFamilySynthesis({
      row,
      windows: headlineWindows(),
      modelSide: modelSideOf(row),
    });
    const pooled = pooledSubstrateFactsOf(headlineWindows());
    expect(family.familyConformant).toBe(true);
    expect(family.verdict).toBe("comparable");
    const synthesis = family.synthesis;
    expect(synthesis).not.toBeNull();
    expect(synthesis?.substratePerRunMicroUsd).toBe(
      divRoundHalfUpOf(pooled.totalMicroUsd, BigInt(pooled.runs)).toString(),
    );
  });

  test("substrate cost amortized per resolved = pooled total / recorded resolved (NULL when nothing resolved)", () => {
    const zero = rowById("substrate-amortized-null-resolved-incomparable");
    const zeroFamily = deriveSubstrateFamilySynthesis({
      row: zero,
      windows: windowInputsForRow(zero),
      modelSide: modelSideOf(zero),
    });
    expect(zeroFamily.verdict).toBe("honestly-incomparable");
    expect(zeroFamily.synthesis?.substratePerResolvedMicroUsd).toBeNull();
    expect(zeroFamily.synthesis?.modelPerResolvedMicroUsd).toBeNull();
    // The substrate cost of the failed runs is still carried honestly.
    expect(BigInt(zeroFamily.synthesis?.totalMicroUsd ?? "0")).toBeGreaterThan(0n);
  });

  test("the readiness-adjusted effective cost = model + substrate, with the substrate share explicit", () => {
    const row = rowById("readiness-adjusted-effective-comparison-synthesis");
    const family = deriveSubstrateFamilySynthesis({
      row,
      windows: headlineWindows(),
      modelSide: modelSideOf(row),
    });
    const synthesis = family.synthesis;
    expect(synthesis).not.toBeNull();
    expect(synthesis?.substratePerResolvedMicroUsd).not.toBeNull();
    expect(synthesis?.modelPerResolvedMicroUsd).toBe("40"); // 957µ$ / 24 resolved
    expect(BigInt(synthesis?.effectivePerResolvedMicroUsd ?? "0")).toBe(
      BigInt(synthesis?.substratePerResolvedMicroUsd ?? "0") +
        BigInt(synthesis?.modelPerResolvedMicroUsd ?? "0"),
    );
    expect(synthesis?.substrateShareOfEffective).toBeGreaterThan(0);
    expect(synthesis?.substrateShareOfEffective).toBeLessThan(1);
    // The readiness wait share (startup + restart) is carried explicitly.
    expect(BigInt(synthesis?.readinessWaitShareMicroUsd ?? "0")).toBe(
      BigInt(synthesis?.startupShareMicroUsd ?? "0") +
        BigInt(synthesis?.restartShareMicroUsd ?? "0"),
    );
    expect(BigInt(synthesis?.readinessWaitShareMicroUsd ?? "0")).toBeGreaterThan(0n);
  });

  test("a claimed effective cost equal to the model-only number FAILs (SILENT SUBSTRATE ABSORPTION)", () => {
    const row = rowById("readiness-adjusted-effective-comparison-synthesis");
    const family = deriveSubstrateFamilySynthesis({
      row,
      windows: headlineWindows(),
      modelSide: modelSideOf(row),
      claimedEffectivePerResolvedMicroUsd: "40",
    });
    expect(family.familyConformant).toBe(false);
    expect(family.familyEvidence.join(" ")).toContain("SILENT SUBSTRATE ABSORPTION");
  });

  test("zeroed substrate cost fields FAIL the absorption catch (the substrate silently absorbed)", () => {
    const row = rowById("readiness-adjusted-effective-comparison-synthesis");
    const windows = applySubstrateAdversarialVariant(headlineWindows(), {
      silentAbsorption: true,
    });
    const family = deriveSubstrateFamilySynthesis({
      row,
      windows,
      modelSide: modelSideOf(row),
    });
    expect(family.familyConformant).toBe(false);
    expect(family.verdict).toBe("adversarial-failed");
  });

  test("the driver's substrate decision is journaled BEFORE any input is consulted", async () => {
    const { lifecycle } = await driveRowOverHonestStack(
      rowById("substrate-cost-per-run-three-fleet-synthesis"),
    );
    const decisions = lifecycle.journal.decisions;
    expect(decisions.length).toBe(1);
    const decision = decisions[0];
    expect(decision?.armDecision.family).toBe("substrate-cost-per-run");
    expect(decision?.armDecision.deriveOnlyOverRecorded).toContain("never a re-measurement");
    expect(Array.isArray(decision?.armDecision.preRegisteredWindowSet)).toBe(true);
    expect(decision?.armDecision.wilson).toEqual({ confidenceLevel: 0.95 });
  });
});

/** Divide a BigInt rational, rounding half-up (mirrors the driver's arithmetic for the assertions). */
function divRoundHalfUpOf(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

// ---------------------------------------------------------------------------
// The driver over EVERY offline row
// ---------------------------------------------------------------------------

describe("VAL-046 driver over the offline corpus (the honest outcome contracts)", () => {
  test("every honest row COMPLETES with all criteria green and reproduces the pinned synthesis", async () => {
    for (const rowId of [
      "substrate-cost-per-run-three-fleet-synthesis",
      "substrate-cost-amortized-per-resolved-synthesis",
      "readiness-adjusted-effective-comparison-synthesis",
      "substrate-reliability-failure-amortization-synthesis",
      "substrate-amortized-null-resolved-incomparable",
      "readiness-adjusted-below-minimum-honest-refusal",
    ]) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(result.terminal, `${rowId} terminal`).toBe("COMPLETED");
      const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedCriteria, `${rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
      expect(result.failure).toBeNull();
      expect(result.observedTerminal).toBe("COMPLETED");
      const expected = rowById(rowId).expected.synthesis;
      expect(expected).toBeDefined();
      const observed = result.synthesis;
      expect(observed).not.toBeNull();
      if (expected !== undefined && observed !== null) {
        expect(observed.pooledRuns).toBe(expected.pooledRuns);
        expect(observed.pooledResolved).toBe(expected.pooledResolved);
        expect(observed.totalMicroUsd).toBe(expected.totalMicroUsd);
        expect(observed.substratePerRunMicroUsd).toBe(expected.substratePerRunMicroUsd);
        expect(observed.substratePerResolvedMicroUsd).toBe(expected.substratePerResolvedMicroUsd);
        expect(observed.effectivePerResolvedMicroUsd).toBe(expected.effectivePerResolvedMicroUsd);
        expect(observed.wilson.low).toBeCloseTo(expected.wilson.low, 12);
        expect(observed.wilson.high).toBeCloseTo(expected.wilson.high, 12);
      }
    }
  });

  test("every probe row FAILs its NAMED criterion with the honest FAILED terminal", async () => {
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-startup-hiding": "startup-cost-inclusion",
      "probe-readiness-inflation": "readiness-probe-honesty",
      "probe-reserved-measured-conflation": "reserved-measured-separation",
      "probe-failure-amortization-away": "failure-amortization-completeness",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "substrate-input-integrity",
    };
    for (const [rowId, named] of Object.entries(probeNamedCriterion)) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(result.terminal, `${rowId} terminal`).toBe("FAILED");
      const criterion = criterionOf(result, named);
      expect(criterion?.status, `${rowId} ${named}`).toBe("FAIL");
      expect(result.observedTerminal).toBe("FAILED");
      expect(criterionOf(result, "observed-terminal-readback")?.status, `${rowId} readback`).toBe(
        "PASS",
      );
      // The verdict evidence names the expected verdict.
      const verdict = criterionOf(result, "row-outcome-contract");
      expect(verdict?.status).toBe("PASS");
      expect(verdict?.evidence.join(" ")).toContain(
        `expectedVerdict:${rowById(rowId).expected.verdict}`,
      );
    }
  });

  test("every honest verified window seals through the REAL recorder with the decomposition", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("readiness-adjusted-effective-comparison-synthesis"),
    );
    expect(result.windows).toHaveLength(3);
    for (const window of result.windows) {
      expect(window.integrity).toBe(true);
    }
  });

  test("the ledger stays consistent (no phantoms, no drift, no orphans) on the honest rows", async () => {
    const { ledger } = await driveRowOverHonestStack(
      rowById("substrate-cost-per-run-three-fleet-synthesis"),
    );
    const facts = ledger.facts();
    expect(facts.executionCount).toBe(1);
    expect(facts.idempotencyRecordCount).toBe(1);
    expect(facts.orphanEventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The live lane over the deterministic fake lifecycle port
// ---------------------------------------------------------------------------

describe("VAL-046 live lane (the measured substrate lifecycle mechanics)", () => {
  /** The deterministic fake lifecycle port: cold start 120ms, ready on probe 2, 3 healthy units. */
  function createFakeLifecyclePort(): LiveSubstrateLifecyclePort {
    let probeCalls = 0;
    return {
      async probe(unit) {
        probeCalls += 1;
        void unit;
        return {
          ready: probeCalls >= 2,
          reason: probeCalls >= 2 ? null : "no warm sandbox available at submission",
          executionMs: 60,
        };
      },
      async runWorkloadUnit() {
        return {
          substrateExecutionMs: 250,
          model: {
            ok: true,
            inputTokens: 120,
            outputTokens: 24,
            latencyMs: 30,
          },
        };
      },
      async teardown() {
        return { executionMs: 10 };
      },
    };
  }

  /** The deterministic fake clock (advances 1ms per await). */
  const fakeClock = (): { now: () => Date } => {
    let ms = 1_000_000;
    return {
      now: () => {
        ms += 1;
        return new Date(ms);
      },
    };
  };

  test("the live plan is pinned (fleet, revision, workload units, the rail binding)", () => {
    expect(LIVE_SUBSTRATE_PLAN.fleet).toBe("warm-fleet-a");
    expect(LIVE_SUBSTRATE_PLAN.priceRevision).toBe("sub-rev-001");
    expect(LIVE_SUBSTRATE_PLAN.workloadUnits).toBe(3);
    expect(LIVE_SUBSTRATE_PLAN.rail.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(LIVE_SUBSTRATE_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(LIVE_SUBSTRATE_PLAN.rail.priceRevision).toBe("rev-001");
    expect(LIVE_SUBSTRATE_PLAN.rail.maxTokens).toBe(32);
    expect(liveSubstratePlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the measured lifecycle drives to COMPLETED with the families over MEASURED facts", async () => {
    const clock = fakeClock();
    const ledger = createFakeLedger(createTickClock());
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const row = rowById("live-substrate-lifecycle-real-measurement");
    const baseline = ledger.facts();
    const submission = await seam({ key: "val-046-live-unit", body: taskBodyFor({ row }) });
    const result = await driveLiveSubstrateRow({
      row,
      lifecycle,
      substrateLifecycle: createFakeLifecyclePort(),
      rails: createRealAccountingRails(),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: "val-046-live-unit",
      baseline,
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      now: clock.now,
    });
    expect(
      result.terminal,
      JSON.stringify(result.criteria.filter((c) => c.status === "FAIL")),
    ).toBe("COMPLETED");
    expect(result.failure).toBeNull();
    const synthesis = result.synthesis;
    expect(synthesis).not.toBeNull();
    // The measured lifecycle: 3 units, 3 resolved, measured substrate cost > 0.
    expect(synthesis?.pooledRuns).toBe(3);
    expect(synthesis?.pooledResolved).toBe(3);
    expect(BigInt(synthesis?.totalMicroUsd ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(synthesis?.modelPerResolvedMicroUsd ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(synthesis?.effectivePerResolvedMicroUsd ?? "0")).toBeGreaterThan(
      BigInt(synthesis?.modelPerResolvedMicroUsd ?? "0"),
    );
    // The measured window verified (the live lane).
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.integrity).toBe(true);
  });

  test("a lifecycle that never attains readiness FAILs honestly (readiness never observed)", async () => {
    const neverReady: LiveSubstrateLifecyclePort = {
      async probe() {
        return { ready: false, reason: "capacity exhausted", executionMs: 60 };
      },
      async runWorkloadUnit() {
        return {
          substrateExecutionMs: 0,
          model: { ok: false, inputTokens: 0, outputTokens: 0, latencyMs: 0, category: "unknown" },
        };
      },
      async teardown() {
        return { executionMs: 0 };
      },
    };
    const clock = fakeClock();
    const ledger = createFakeLedger(createTickClock());
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const row = rowById("live-substrate-lifecycle-real-measurement");
    const baseline = ledger.facts();
    const submission = await seam({ key: "val-046-live-unit-2", body: taskBodyFor({ row }) });
    const result = await driveLiveSubstrateRow({
      row,
      lifecycle,
      substrateLifecycle: neverReady,
      rails: createRealAccountingRails(),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: "val-046-live-unit-2",
      baseline,
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("readiness-never-attained");
  });
});
