/**
 * VAL-046 acceptance criterion 6 — discrimination tests proving the
 * SUBSTRATE-COST families against controlled fakes (every family FAILs
 * mechanically; every family has an honest control that PASSES):
 *
 *   * STARTUP HIDING — a comparison that claims a zero (or
 *     disagreeing) startup share while the recorded telemetry shows a
 *     warm-up: the startup-cost-inclusion oracle FAILs (the cold start
 *     is never free; the readiness wait is never hidden);
 *   * READINESS INFLATION — a comparison that claims first-usable
 *     EARLIER than the first PASSING probe (the substrate looks ready
 *     before it ever observed usability), or a startup duration that
 *     uses the FIRST-DISPATCHED point instead: the readiness-probe
 *     -honesty oracle FAILs (readiness is warm-up to FIRST-USABLE,
 *     derived from the probe telemetry — never a claim, never the
 *     dispatch point);
 *   * RESERVED/MEASURED CONFLATION — a comparison that folds the
 *     standing reservation into the measured usage (or the reverse):
 *     the reserved-measured-separation oracle FAILs (idle standing
 *     capacity is never hidden as usage; usage is never billed as
 *     reserved);
 *   * FAILURE AMORTIZATION-AWAY — a comparison that claims away the
 *     restart or eviction shares while the recorded telemetry counts
 *     the failures: the failure-amortization-completeness oracle
 *     FAILs (every fresh-sandbox cold start is priced; evicted compute
 *     is never free);
 *   * SILENT SUBSTRATE ABSORPTION — a readiness-adjusted comparison
 *     whose effective cost equals the model-only number while the
 *     recorded substrate total is nonzero: the family's own oracle
 *     FAILs (the substrate cost is EXPLICIT, never absorbed into a
 *     provider price);
 *   * POST-HOC EXCLUSION / SAMPLE-SIZE VIOLATION — a comparison that
 *     drops a pre-registered window from the executed set, or claims a
 *     comparability verdict below the pre-registered minimums: the
 *     confidence-and-minimum and refusal-honesty oracles FAIL (the
 *     honest outcome is the refusal);
 *   * RE-MEASUREMENT MASQUERADE — an input bundle whose facts are not
 *     the RECORDED telemetry's own derivation (a re-measured count, a
 *     disagreeing digest, an unresolvable reference, an unpinned
 *     substrate price revision): the input-integrity oracle FAILs;
 *   * the Wilson-confidence application, the digest discipline (payload
 *     bytes never journaled), the honest controls over the whole
 *     fixture stack, and the substrate-manifest integrity probes.
 */

import { describe, expect, test } from "vitest";
import {
  OFFLINE_CONTROL_ROWS,
  PROBE_ROWS,
  SUBSTRATE_CORPUS,
  substrateRowById,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-substrate-runtime/corpus";
import type {
  SubstrateCorpusRow,
  SubstrateWindowInput,
} from "../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  deriveBelowMinimumRefusalHonesty,
  deriveConfidenceAndMinimum,
  deriveEstimateMeasureSeparation,
  deriveFailureAmortizationCompleteness,
  deriveReadinessProbeHonesty,
  deriveReservedMeasuredSeparation,
  deriveStartupCostInclusion,
  deriveSubstrateFamilySynthesis,
  deriveSubstrateInputIntegrity,
  driveSubstrateRow,
  pooledSubstrateFactsOf,
} from "../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  applySubstrateAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  windowInputsForRow,
} from "../../benchmarks/validation/apps/economic-substrate-runtime/fixtures";
import {
  computeSubstrateManifestDigest,
  deriveSubstrateManifestIntegrity,
  substrateManifestRevisionOf,
} from "../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "7c31a09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-046",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "synthesis:recorded-substrate-telemetry",
  environment: {
    runtime: "node discrimination test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-046-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): SubstrateCorpusRow => {
  const row = substrateRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const headline = (): readonly SubstrateWindowInput[] =>
  windowInputsForRow(rowById("substrate-cost-per-run-three-fleet-synthesis"));

const reliability = (): readonly SubstrateWindowInput[] =>
  windowInputsForRow(rowById("substrate-reliability-failure-amortization-synthesis"));

/** Drive one row over the honest offline stack (the discrimination floor). */
async function driveRowOverStack(
  row: SubstrateCorpusRow,
  windows: readonly SubstrateWindowInput[],
) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  // The PRE-ROW durable facts — captured BEFORE the app's submission
  // lands (the seam's create is the row's own execution).
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-046-disc-${row.rowId}`,
    body: taskBodyFor({ row }),
  });
  const result = await driveSubstrateRow({
    row,
    lifecycle,
    windows,
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-046-disc-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle };
}

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

// ---------------------------------------------------------------------------
// STARTUP HIDING
// ---------------------------------------------------------------------------

describe("discrimination: startup hiding FAILs (the cold start is never free)", () => {
  test("an honest startup share PASSES the inclusion oracle", () => {
    const startup = deriveStartupCostInclusion({ windows: headline() });
    expect(startup.conformant).toBe(true);
  });

  test("a claimed ZERO startup share against a recorded warm-up FAILs named", () => {
    const windows = applySubstrateAdversarialVariant(headline(), { startupHiding: true });
    const startup = deriveStartupCostInclusion({ windows });
    expect(startup.conformant).toBe(false);
    expect(startup.evidence.join(" ")).toContain("STARTUP-HIDING");
    expect(startup.evidence.join(" ")).toContain("1400ms");
  });

  test("a claimed startup share DISAGREEING with the recorded derivation FAILs named", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? { ...window, claimed: { ...window.claimed, startupShareMicroUsd: "1" } }
        : window,
    );
    const startup = deriveStartupCostInclusion({ windows });
    expect(startup.conformant).toBe(false);
    expect(startup.evidence.join(" ")).toContain("STARTUP-SHARE DISAGREEMENT");
  });

  test("a broken decomposition (the measured total hides a share) FAILs", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              measuredMicroUsd: (BigInt(window.facts.measuredMicroUsd) - 10n).toString(),
            },
          }
        : window,
    );
    const startup = deriveStartupCostInclusion({ windows });
    expect(startup.conformant).toBe(false);
  });

  test("the corpus's startup-hiding probe row FAILS its named criterion on the full drive", async () => {
    const { result } = await driveRowOverStack(
      rowById("probe-startup-hiding"),
      windowInputsForRow(rowById("probe-startup-hiding")),
    );
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "startup-cost-inclusion")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// READINESS INFLATION
// ---------------------------------------------------------------------------

describe("discrimination: readiness inflation FAILs (first-usable, not first-dispatched)", () => {
  test("the honest readiness derives from the first PASSING probe", () => {
    const readiness = deriveReadinessProbeHonesty({ windows: headline() });
    expect(readiness.conformant).toBe(true);
  });

  test("a claimed first-usable at the FIRST REFUSED probe FAILs named (the substrate was not usable)", () => {
    const windows = applySubstrateAdversarialVariant(headline(), { readinessInflation: true });
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("READINESS INFLATION");
  });

  test("a claimed first-usable at the FIRST-DISPATCHED point FAILs named (the misattribution)", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            claimed: {
              ...window.claimed,
              firstUsableAtMs: window.facts.firstDispatchedAtMs,
            },
          }
        : window,
    );
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("FIRST-DISPATCHED MISATTRIBUTION");
  });

  test("a facts-side startup duration using FIRST-DISPATCHED FAILs named", () => {
    const windows = applySubstrateAdversarialVariant(headline(), {
      firstDispatchedMisattribution: true,
    });
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("FIRST-DISPATCHED MISATTRIBUTION");
  });

  test("a window with NO passing probe FAILs (the readiness claim is fabricated)", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              readinessProbes: window.facts.readinessProbes.map((probe) => ({
                ...probe,
                ready: false,
              })),
            },
          }
        : window,
    );
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("NO PASSING PROBE");
  });

  test("a dispatch BEFORE first-usable FAILs (unrepresentable telemetry)", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              firstDispatchedAtMs: window.facts.firstUsableAtMs - 100,
            },
          }
        : window,
    );
    const readiness = deriveReadinessProbeHonesty({ windows });
    expect(readiness.conformant).toBe(false);
    expect(readiness.evidence.join(" ")).toContain("DISPATCHED BEFORE USABLE");
  });
});

// ---------------------------------------------------------------------------
// RESERVED/MEASURED CONFLATION
// ---------------------------------------------------------------------------

describe("discrimination: reserved/measured conflation FAILs (the split is structural)", () => {
  test("the honest split PASSES (the standing reservation by interval, the usage by second)", () => {
    const separation = deriveReservedMeasuredSeparation({ windows: headline() });
    expect(separation.conformant).toBe(true);
  });

  test("folding the standing reservation into the measured total FAILs named", () => {
    const windows = applySubstrateAdversarialVariant(headline(), { reservedConflation: true });
    const separation = deriveReservedMeasuredSeparation({ windows });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("RESERVED/MEASURED CONFLATION");
  });

  test("the reverse direction (measured zeroed into reserved) FAILs named", () => {
    const windows = headline().map((window) => {
      const reserved = BigInt(window.facts.reservedMicroUsd);
      if (reserved === 0n) {
        return window;
      }
      return {
        ...window,
        claimed: {
          ...window.claimed,
          reservedShareMicroUsd: (reserved + BigInt(window.facts.measuredMicroUsd)).toString(),
          measuredMicroUsd: "0",
        },
      };
    });
    const separation = deriveReservedMeasuredSeparation({ windows });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("MEASURED DISAGREEMENT");
  });

  test("a phantom reserved share with NO standing reservation FAILs named", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              reservedMicroUsd: "100",
              reservedShareMicroUsd: "100",
            },
          }
        : window,
    );
    const separation = deriveReservedMeasuredSeparation({ windows });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("PHANTOM RESERVATION");
  });
});

// ---------------------------------------------------------------------------
// FAILURE AMORTIZATION-AWAY
// ---------------------------------------------------------------------------

describe("discrimination: failure amortization-away FAILs (restarts and evictions are priced)", () => {
  test("the honest reliability windows PASS with every restart and eviction priced", () => {
    const failure = deriveFailureAmortizationCompleteness({ windows: reliability() });
    expect(failure.conformant).toBe(true);
    const pooled = pooledSubstrateFactsOf(reliability());
    expect(pooled.restarts).toBe(4);
    expect(pooled.evictions).toBe(2);
  });

  test("claimed-away restart shares against recorded restarts FAIL named", () => {
    const windows = applySubstrateAdversarialVariant(reliability(), {
      failureAmortizationAway: true,
    });
    const failure = deriveFailureAmortizationCompleteness({ windows });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("FAILURE AMORTIZATION-AWAY");
  });

  test("a facts-side zeroed restart share with recorded restarts FAILs named", () => {
    const windows = reliability().map((window, index) =>
      index === 0 && window.facts.restarts > 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              restartShareMicroUsd: "0",
              measuredMicroUsd: (
                BigInt(window.facts.measuredMicroUsd) - BigInt(window.facts.restartShareMicroUsd)
              ).toString(),
            },
          }
        : window,
    );
    const failure = deriveFailureAmortizationCompleteness({ windows });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("FAILURE AMORTIZATION-AWAY");
  });

  test("a phantom restart share with ZERO recorded restarts FAILs named", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              restartShareMicroUsd: "50",
              measuredMicroUsd: (BigInt(window.facts.measuredMicroUsd) + 50n).toString(),
            },
          }
        : window,
    );
    const failure = deriveFailureAmortizationCompleteness({ windows });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("PHANTOM RESTART SHARE");
  });
});

// ---------------------------------------------------------------------------
// SILENT SUBSTRATE ABSORPTION (the readiness-adjusted family's own catch)
// ---------------------------------------------------------------------------

describe("discrimination: silent substrate absorption FAILs (the substrate cost is EXPLICIT)", () => {
  const readinessRow = (): SubstrateCorpusRow =>
    rowById("readiness-adjusted-effective-comparison-synthesis");

  test("the honest effective cost = model + substrate with the share carried", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: readinessRow(),
      windows: headline(),
      modelSide: {
        measuredMicroUsd: 957n,
        resolved: 24,
        runs: 24,
      },
    });
    expect(family.familyConformant).toBe(true);
    const synthesis = family.synthesis;
    expect(synthesis?.modelPerResolvedMicroUsd).toBe("40");
    expect(synthesis?.substratePerResolvedMicroUsd).toBe("278");
    expect(synthesis?.effectivePerResolvedMicroUsd).toBe("318");
  });

  test("a claimed effective cost equal to the MODEL-ONLY number FAILs named", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: readinessRow(),
      windows: headline(),
      modelSide: {
        measuredMicroUsd: 957n,
        resolved: 24,
        runs: 24,
      },
      claimedEffectivePerResolvedMicroUsd: "40",
    });
    expect(family.familyConformant).toBe(false);
    expect(family.familyEvidence.join(" ")).toContain("SILENT SUBSTRATE ABSORPTION");
  });

  test("zeroed substrate cost fields (the absorbed substrate) FAIL the family", () => {
    const windows = applySubstrateAdversarialVariant(headline(), { silentAbsorption: true });
    const family = deriveSubstrateFamilySynthesis({
      row: readinessRow(),
      windows,
      modelSide: {
        measuredMicroUsd: 957n,
        resolved: 24,
        runs: 24,
      },
    });
    expect(family.familyConformant).toBe(false);
    expect(family.verdict).toBe("adversarial-failed");
  });

  test("a claimed effective cost DISAGREEING with the derivation FAILs named", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: readinessRow(),
      windows: headline(),
      modelSide: {
        measuredMicroUsd: 957n,
        resolved: 24,
        runs: 24,
      },
      claimedEffectivePerResolvedMicroUsd: "41",
    });
    expect(family.familyConformant).toBe(false);
    expect(family.familyEvidence.join(" ")).toContain("EFFECTIVE-COST DISAGREEMENT");
  });
});

// ---------------------------------------------------------------------------
// POST-HOC EXCLUSION + SAMPLE-SIZE VIOLATION
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc exclusion and sample-size violations FAIL", () => {
  test("a dropped pre-registered window FAILs the confidence-and-minimum oracle named", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const confidence = deriveConfidenceAndMinimum({
      row,
      windows: headline().slice(0, 2),
    });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain(
      "post-hoc-excluded:window-cold-fleet-b-headline",
    );
  });

  test("an UNDECLARED window in the executed set FAILs named", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const registered = new Set(row.windowSet.map((reference) => reference.windowId));
    const undeclared = reliability().find((window) => !registered.has(window.facts.windowId));
    expect(undeclared).toBeDefined();
    const confidence = deriveConfidenceAndMinimum({
      row,
      windows: [...headline(), ...(undeclared === undefined ? [] : [undeclared])],
    });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("undeclared-window");
  });

  test("the below-minimum comparison must REFUSE — a comparability claim FAILs named", () => {
    const row = rowById("probe-sample-size-violation");
    const windows = windowInputsForRow(row);
    const refusal = deriveBelowMinimumRefusalHonesty({ row, windows });
    expect(refusal.belowMinimum).toBe(true);
    expect(refusal.conformant).toBe(false);
    expect(refusal.evidence.join(" ")).toContain("BELOW-MINIMUM COMPARABILITY CLAIM");
  });

  test("the honest refusal (the same starved set claiming the refusal) PASSES", () => {
    const row = rowById("readiness-adjusted-below-minimum-honest-refusal");
    const windows = windowInputsForRow(row);
    const refusal = deriveBelowMinimumRefusalHonesty({ row, windows });
    expect(refusal.belowMinimum).toBe(true);
    expect(refusal.conformant).toBe(true);
  });

  test("the confidence-less comparison FAILs (Wilson required)", () => {
    const row = rowById("substrate-cost-per-run-three-fleet-synthesis");
    const confidence = deriveConfidenceAndMinimum({ row, windows: [] });
    expect(confidence.conformant).toBe(false);
    expect(confidence.wilson).toBeNull();
    expect(confidence.evidence.join(" ")).toContain("CONFIDENCE-LESS COMPARISON");
  });
});

// ---------------------------------------------------------------------------
// RE-MEASUREMENT MASQUERADE
// ---------------------------------------------------------------------------

describe("discrimination: re-measurement masquerades FAIL (the recorded telemetry decides)", () => {
  test("the honest bundles verify (digest + field equality)", () => {
    const integrity = deriveSubstrateInputIntegrity({ windows: headline() });
    expect(integrity.conformant).toBe(true);
  });

  test("a re-measured served run count FAILs named field by field", () => {
    const windows = applySubstrateAdversarialVariant(headline(), { remeasurement: true });
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
    expect(integrity.evidence.join(" ")).toContain("servedRuns");
  });

  test("a re-measured startup duration FAILs named", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? { ...window, facts: { ...window.facts, startupMs: window.facts.startupMs + 1 } }
        : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("startup");
  });

  test("a re-measured total FAILs against the recorded basis (never re-priced)", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? {
            ...window,
            facts: {
              ...window.facts,
              totalMicroUsd: (BigInt(window.facts.totalMicroUsd) + 1n).toString(),
            },
          }
        : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
  });

  test("a claimed (not factual) re-measured served count FAILs the integrity oracle", () => {
    const windows = headline().map((window, index) =>
      index === 0
        ? { ...window, claimed: { ...window.claimed, servedRuns: window.facts.servedRuns + 1 } }
        : window,
    );
    const integrity = deriveSubstrateInputIntegrity({ windows });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("re-measurement masquerading");
  });
});

// ---------------------------------------------------------------------------
// The substrate manifest integrity probes
// ---------------------------------------------------------------------------

describe("discrimination: the substrate manifest integrity (the pinning discipline)", () => {
  test("an in-place price mutation with a STALE digest FAILs the integrity derivation", () => {
    const base = substrateManifestRevisionOf("sub-rev-001");
    if (base === null) {
      throw new Error("missing sub-rev-001");
    }
    const mutated = {
      ...base,
      tables: base.tables.map((entry) =>
        entry.fleet === "warm-fleet-a" && entry.tier === "usage"
          ? { ...entry, price: "0.000001" }
          : entry,
      ),
      // The digest is NOT recomputed — the in-place mutation shape.
      digest: base.digest,
    };
    expect(computeSubstrateManifestDigest(mutated.tables)).not.toBe(mutated.digest);
  });

  test("an unpinned substrate revision FAILs the integrity derivation", () => {
    expect(deriveSubstrateManifestIntegrity({ revision: "sub-rev-xxx" }).agreed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The estimate/measure separation + the digest discipline
// ---------------------------------------------------------------------------

describe("discrimination: estimate separation and the digest discipline", () => {
  test("the estimate share never enters the measured basis (the honest control)", () => {
    const separation = deriveEstimateMeasureSeparation({ windows: headline() });
    expect(separation.conformant).toBe(true);
  });

  test("an estimate-absorbing measured basis FAILs against the recorded one", () => {
    const windows = headline().map((window, index) => {
      if (index !== 0 || window.facts.estimateMicroUsd === "0") {
        return window;
      }
      const estimate = BigInt(window.facts.estimateMicroUsd);
      return {
        ...window,
        facts: {
          ...window.facts,
          measuredMicroUsd: (BigInt(window.facts.measuredMicroUsd) + estimate).toString(),
          estimateMicroUsd: "0",
        },
      };
    });
    const separation = deriveEstimateMeasureSeparation({ windows });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("ESTIMATE-CONFLATION");
  });

  test("the journaled evidence carries DIGESTS only — never payload bytes", async () => {
    const { result, lifecycle } = await driveRowOverStack(
      rowById("substrate-cost-per-run-three-fleet-synthesis"),
      headline(),
    );
    expect(result.terminal).toBe("COMPLETED");
    const digests = lifecycle.journal.stepEvents.map((event) => event.record.digest);
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
    }
    // The evidence strings never contain the raw telemetry payload
    // (no probe reason strings, no fleet pricing prose).
    const allEvidence = result.criteria.flatMap((criterion) => criterion.evidence).join(" ");
    expect(allEvidence).not.toContain("no warm sandbox available at submission");
    expect(allEvidence).not.toContain("cold capacity still provisioning");
  });
});

// ---------------------------------------------------------------------------
// The honest controls (the whole fixture stack)
// ---------------------------------------------------------------------------

describe("discrimination: honest controls PASS (every family + every probe's counterpart)", () => {
  test("every honest control row drives to COMPLETED over the full stack", async () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const { result } = await driveRowOverStack(row, windowInputsForRow(row));
      expect(result.terminal, `${row.rowId}`).toBe("COMPLETED");
      const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
    }
  });

  test("every probe row drives to the honest FAILED with its named criterion FAILing", async () => {
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-startup-hiding": "startup-cost-inclusion",
      "probe-readiness-inflation": "readiness-probe-honesty",
      "probe-reserved-measured-conflation": "reserved-measured-separation",
      "probe-failure-amortization-away": "failure-amortization-completeness",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "substrate-input-integrity",
    };
    expect(PROBE_ROWS.length).toBe(7);
    for (const row of PROBE_ROWS) {
      const named = probeNamedCriterion[row.rowId] ?? "";
      expect(named.length, row.rowId).toBeGreaterThan(0);
      const { result } = await driveRowOverStack(row, windowInputsForRow(row));
      expect(result.terminal, `${row.rowId}`).toBe("FAILED");
      expect(criterionOf(result, named)?.status, `${row.rowId} ${named}`).toBe("FAIL");
    }
  });

  test("the corpus is complete (6 honest + 7 probes + 1 live = 14 rows)", () => {
    expect(SUBSTRATE_CORPUS.length).toBe(14);
    expect(OFFLINE_CONTROL_ROWS.length).toBe(6);
    expect(PROBE_ROWS.length).toBe(7);
    expect(SUBSTRATE_CORPUS.filter((row) => row.needsDispatch).length).toBe(1);
  });
});
