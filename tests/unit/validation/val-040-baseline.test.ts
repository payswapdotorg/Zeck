/**
 * VAL-040 acceptance criteria 1, 2 and 4 (the offline oracle floor):
 *
 *   * the pinned price manifest is content-addressed and append-only
 *     (digest agreement, the correction-as-new-revision discipline,
 *     the in-place mutation catch, the public-list-only source
 *     validation);
 *   * the normalization core converges heterogeneous pricing (mixed
 *     currencies/units, metered vs. batched metering, retry
 *     amortization, measured-vs-estimate separation) onto the
 *     canonical micro-USD basis with exact BigInt arithmetic — and a
 *     mixed-currency fact, an FX-external currency or an unpinned
 *     provider FAIL to normalize;
 *   * the frozen experiment protocol (the arm grammar, the
 *     digest-frozen declaration, the slice/sample/threshold/budget
 *     derivations, the comparison validation with the Wilson
 *     confidence carried);
 *   * the execution driver drives EVERY offline corpus row to
 *     settlement over the deterministic fixtures with the REAL
 *     accounting rails (the REAL recorder, the REAL evaluation
 *     oracle, the REAL accounting aggregate), reproducing the
 *     corpus's pinned expected normalized outcomes exactly.
 */

import { describe, expect, test } from "vitest";
import type { ArmAggregate } from "../../../benchmarks/validation/accounting/aggregate";
import {
  ECONOMIC_CORPUS,
  ECONOMIC_CORPUS_VERSION,
  economicTasksForArm,
  OFFLINE_CORPUS_ROWS,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-baseline/corpus";
import {
  createRealAccountingRails,
  driveEconomicRow,
  type EconomicCorpusRow,
  economicDigestOf,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRecordedReplayExecutor,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-baseline/fixtures";
import {
  costFactsOf,
  deriveCostPerResolved,
  deriveRoundBudgetBoundMicroUsd,
  manifestFor,
  normalizeArmCosts,
  normalizeUsageFact,
  type UsageFact,
} from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import {
  computeManifestDigest,
  deriveManifestAppendOnly,
  deriveManifestIntegrity,
  type ListPriceEntry,
  manifestRevisionOf,
  PRICE_MANIFEST,
  validatePriceTableEntry,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import {
  deriveBudgetRespect,
  deriveNormalizedComparison,
  deriveSampleSufficiency,
  deriveSliceConformance,
  deriveThresholdAttainment,
  type EconomicArm,
  type FixedCostArm,
  type FixedQualityArm,
  pinExperiment,
  validateArmDeclaration,
  validateNormalizedComparison,
  verifyDeclarationDrift,
  wilsonInterval,
} from "../../../benchmarks/validation/apps/economic-baseline/protocol";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "d63a77e684f6097dd974caabe4a05d6c39302fe3";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-040",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-040-baseline" },
  },
  observedAt,
});

const noSleep = async () => {};

const rowById = (rowId: string): EconomicCorpusRow => {
  const row = ECONOMIC_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over the deterministic fake stack + the REAL accounting rails. */
async function driveRowOverFakeStack(options: {
  readonly row: EconomicCorpusRow;
  readonly runSuffix?: string;
}): Promise<ReturnType<typeof driveEconomicRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createRecordedReplayExecutor({ row: options.row, clock });
  const rails = createRealAccountingRails();
  // The baseline is captured BEFORE the app's submission lands (the
  // row's durable deltas are judged against the pre-row world).
  const baseline = ledger.facts();
  const key = `val-040-unit-${options.runSuffix ?? "x"}-${options.row.rowId}`;
  const submission = await seam({ key, body: taskBodyFor({ row: options.row }) });
  const result = await driveEconomicRow({
    row: options.row,
    lifecycle,
    executor,
    rails,
    tasks: economicTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-040-unit-${options.row.rowId}`,
    corpusVersion: ECONOMIC_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
  });
  return result;
}

// ---------------------------------------------------------------------------
// The pinned price manifest (content-addressed, append-only)
// ---------------------------------------------------------------------------

describe("VAL-040 price manifest", () => {
  test("the registry is append-only with unique revisions and frozen digests", () => {
    const verdict = deriveManifestAppendOnly();
    expect(verdict.appendOnly).toBe(true);
    expect(verdict.revisions).toEqual(["rev-001", "rev-002"]);
  });

  test("a price correction is a NEW revision — rev-001 stays frozen and readable", () => {
    const rev001 = manifestRevisionOf("rev-001");
    const rev002 = manifestRevisionOf("rev-002");
    expect(rev001).not.toBeNull();
    expect(rev002).not.toBeNull();
    expect(rev002?.supersedes).toBe("rev-001");
    // rev-002 corrects the openrouter input price only.
    const rev001Input = rev001?.tables.find(
      (entry) => entry.provider === "openrouter" && entry.tier === "input",
    );
    const rev002Input = rev002?.tables.find(
      (entry) => entry.provider === "openrouter" && entry.tier === "input",
    );
    expect(rev001Input?.price).toBe("0.12");
    expect(rev002Input?.price).toBe("0.1128");
    // Every other entry is identical; rev-001's digest is unchanged.
    expect(computeManifestDigest(rev001?.tables ?? [], rev001?.fx ?? [])).toBe(rev001?.digest);
    expect(computeManifestDigest(rev002?.tables ?? [], rev002?.fx ?? [])).toBe(rev002?.digest);
    expect(PRICE_MANIFEST.length).toBe(2);
  });

  test("manifest integrity agrees for every pinned revision", () => {
    for (const revision of PRICE_MANIFEST) {
      const verdict = deriveManifestIntegrity({ revision: revision.revision });
      expect(verdict.agreed, verdict.evidence.join(" | ")).toBe(true);
    }
  });

  test("an IN-PLACE price mutation breaks digest agreement mechanically", () => {
    const base = manifestRevisionOf("rev-001");
    expect(base).not.toBeNull();
    const mutated = {
      ...(base as NonNullable<typeof base>),
      tables: (base as NonNullable<typeof base>).tables.map((entry) =>
        entry.provider === "openrouter" && entry.tier === "input"
          ? { ...entry, price: "0.06" }
          : entry,
      ),
    };
    const verdict = deriveManifestIntegrity({ revision: "rev-001", registry: [mutated] });
    expect(verdict.declaredRevisionKnown).toBe(true);
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("DISAGREED");
  });

  test("an unknown declared revision fails manifest integrity", () => {
    const verdict = deriveManifestIntegrity({ revision: "rev-999" });
    expect(verdict.declaredRevisionKnown).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("negotiated/bulk/undocumented pricing is FORBIDDEN in any table entry", () => {
    const honest = PRICE_MANIFEST[0]?.tables[0] as ListPriceEntry;
    const negotiated: ListPriceEntry = { ...honest, source: "negotiated" as never };
    const violations = validatePriceTableEntry(negotiated);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.reason).toContain("FORBIDDEN");
    expect(validatePriceTableEntry(honest)).toEqual([]);
  });

  test("table validation rejects malformed metering and prices", () => {
    const honest = PRICE_MANIFEST[0]?.tables[0] as ListPriceEntry;
    expect(validatePriceTableEntry({ ...honest, metering: "batched" }).length).toBeGreaterThan(0);
    const batched = PRICE_MANIFEST[0]?.tables.find(
      (entry) => entry.metering === "batched",
    ) as ListPriceEntry;
    expect(validatePriceTableEntry({ ...batched, batchSize: 0 }).length).toBeGreaterThan(0);
    expect(
      validatePriceTableEntry({ ...batched, metering: "metered", batchSize: 500 }).length,
    ).toBeGreaterThan(0);
    expect(validatePriceTableEntry({ ...honest, price: "0" }).length).toBeGreaterThan(0);
    expect(validatePriceTableEntry({ ...honest, price: "abc" }).length).toBeGreaterThan(0);
    expect(validatePriceTableEntry({ ...honest, sourceRef: "" }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The normalization core (the canonical micro-USD basis)
// ---------------------------------------------------------------------------

describe("VAL-040 normalization", () => {
  const rev001 = manifestFor("rev-001");

  test("USD per-1M metered pricing converges exactly (openrouter)", () => {
    const input = normalizeUsageFact(
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "input",
        currency: "USD",
        tokens: 120,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(input.ok).toBe(true);
    if (input.ok) {
      expect(input.cost.microUsd).toBe("14");
    }
    const output = normalizeUsageFact(
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "output",
        currency: "USD",
        tokens: 30,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.cost.microUsd).toBe("8");
    }
  });

  test("EUR per-1M pricing converts through the pinned FX table (euro-relay)", () => {
    const input = normalizeUsageFact(
      {
        provider: "euro-relay",
        model: "euro-small-v1",
        tier: "input",
        currency: "EUR",
        tokens: 200,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(input.ok).toBe(true);
    if (input.ok) {
      expect(input.cost.microUsd).toBe("82");
    }
    const output = normalizeUsageFact(
      {
        provider: "euro-relay",
        model: "euro-small-v1",
        tier: "output",
        currency: "EUR",
        tokens: 40,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.cost.microUsd).toBe("49");
    }
  });

  test("JPY per-1K pricing reduces to the exact per-token basis (tokyo-relay)", () => {
    const input = normalizeUsageFact(
      {
        provider: "tokyo-relay",
        model: "tokyo-mini-v1",
        tier: "input",
        currency: "JPY",
        tokens: 300,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(input.ok).toBe(true);
    if (input.ok) {
      expect(input.cost.microUsd).toBe("28125");
    }
    const output = normalizeUsageFact(
      {
        provider: "tokyo-relay",
        model: "tokyo-mini-v1",
        tier: "output",
        currency: "JPY",
        tokens: 50,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.cost.microUsd).toBe("14063");
    }
  });

  test("the unit basis is exact: per-1M, per-1K and per-token price identically at 1200 tokens", () => {
    const perMillion = normalizeUsageFact(
      {
        provider: "unit-m",
        model: "unit-v1",
        tier: "input",
        currency: "USD",
        tokens: 1200,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        ...rev001,
        tables: [
          {
            provider: "unit-m",
            model: "unit-v1",
            tier: "input",
            currency: "USD",
            unit: "per-1M-tokens",
            price: "0.12",
            metering: "metered",
            source: "public-list",
            sourceRef: "unit fixture",
          },
        ],
      },
    );
    const perThousand = normalizeUsageFact(
      {
        provider: "unit-k",
        model: "unit-v1",
        tier: "input",
        currency: "USD",
        tokens: 1200,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        ...rev001,
        tables: [
          {
            provider: "unit-k",
            model: "unit-v1",
            tier: "input",
            currency: "USD",
            unit: "per-1K-tokens",
            price: "0.00012",
            metering: "metered",
            source: "public-list",
            sourceRef: "unit fixture",
          },
        ],
      },
    );
    const perToken = normalizeUsageFact(
      {
        provider: "unit-1",
        model: "unit-v1",
        tier: "input",
        currency: "USD",
        tokens: 1200,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        ...rev001,
        tables: [
          {
            provider: "unit-1",
            model: "unit-v1",
            tier: "input",
            currency: "USD",
            unit: "per-token",
            price: "0.00000012",
            metering: "metered",
            source: "public-list",
            sourceRef: "unit fixture",
          },
        ],
      },
    );
    expect(perMillion.ok && perMillion.cost.microUsd).toBe("144");
    expect(perThousand.ok && perThousand.cost.microUsd).toBe("144");
    expect(perToken.ok && perToken.cost.microUsd).toBe("144");
  });

  test("batched metering rounds usage UP to whole batches before pricing", () => {
    for (const [tokens, charged] of [
      [300, 500],
      [500, 500],
      [700, 1000],
      [999, 1000],
      [1000, 1000],
      [1234, 1500],
    ] as const) {
      const outcome = normalizeUsageFact(
        {
          provider: "batch-relay",
          model: "batch-medium-v1",
          tier: "input",
          currency: "USD",
          tokens,
          kind: "measured",
          scope: "direct-execution",
        },
        rev001,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.cost.evidence.join("|")).toContain(`chargedTokens:${charged}`);
      }
    }
    // 500 charged input tokens at $0.08/1M = 40 µ$ exactly.
    const exact = normalizeUsageFact(
      {
        provider: "batch-relay",
        model: "batch-medium-v1",
        tier: "input",
        currency: "USD",
        tokens: 300,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(exact.ok && exact.cost.microUsd).toBe("40");
    // 60 output tokens batch up to 500 charged at $0.32/1M = 160 µ$.
    const output = normalizeUsageFact(
      {
        provider: "batch-relay",
        model: "batch-medium-v1",
        tier: "output",
        currency: "USD",
        tokens: 60,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(output.ok && output.cost.microUsd).toBe("160");
  });

  test("a MIXED-CURRENCY conflation fails to normalize mechanically", () => {
    // EUR usage priced against the USD-denominated openrouter entry.
    const mismatch = normalizeUsageFact(
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "input",
        currency: "EUR",
        tokens: 120,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.failure.reason).toContain("MIXED-CURRENCY CONFLATION");
    }
    // GBP sits OUTSIDE the pinned FX table — a GBP-DENOMINATED table
    // entry has no pinned conversion (no ad-hoc spot rate is
    // permitted: the fact fails at the FX lookup).
    const gbpEntry = rev001.tables.find(
      (entry) => entry.provider === "euro-relay" && entry.tier === "input",
    );
    expect(gbpEntry).toBeDefined();
    const external = normalizeUsageFact(
      {
        provider: "euro-relay",
        model: "euro-small-v1",
        tier: "input",
        currency: "GBP",
        tokens: 200,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        ...rev001,
        tables: rev001.tables.map((entry) =>
          entry.provider === "euro-relay" ? { ...entry, currency: "GBP" as const } : entry,
        ),
      },
    );
    expect(external.ok).toBe(false);
    if (!external.ok) {
      expect(external.failure.reason).toContain("outside the pinned FX table");
    }
  });

  test("UNPINNED pricing fails to normalize mechanically", () => {
    const outcome = normalizeUsageFact(
      {
        provider: "mystery-relay",
        model: "unknown-v1",
        tier: "input",
        currency: "USD",
        tokens: 100,
        kind: "measured",
        scope: "direct-execution",
      },
      rev001,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toContain("UNPINNED PRICING");
    }
  });

  test("retry amortization: failed attempts are measured retry-overhead facts of the same run", () => {
    const facts: UsageFact[] = [
      {
        provider: "retry-relay",
        model: "retry-small-v1",
        tier: "input",
        currency: "USD",
        tokens: 150,
        kind: "measured",
        scope: "retry-overhead",
      },
      {
        provider: "retry-relay",
        model: "retry-small-v1",
        tier: "output",
        currency: "USD",
        tokens: 10,
        kind: "measured",
        scope: "retry-overhead",
      },
      {
        provider: "retry-relay",
        model: "retry-small-v1",
        tier: "input",
        currency: "USD",
        tokens: 150,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        provider: "retry-relay",
        model: "retry-small-v1",
        tier: "output",
        currency: "USD",
        tokens: 35,
        kind: "measured",
        scope: "direct-execution",
      },
    ];
    const basis = normalizeArmCosts(facts, rev001);
    expect(basis.failures).toEqual([]);
    expect(basis.measuredMicroUsd).toBe("44");
    const costFacts = costFactsOf(basis, "val-040-unit");
    // The amortization decomposition: 26 direct + 18 retry-overhead.
    expect(
      costFacts.find((fact) => fact.scope === "direct-execution" && fact.kind === "measured")
        ?.amountMicroUsd,
    ).toBe("26");
    expect(costFacts.find((fact) => fact.scope === "retry-overhead")?.amountMicroUsd).toBe("18");
  });

  test("measured and estimate facts are summed SEPARATELY (never conflated)", () => {
    const facts: UsageFact[] = [
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "input",
        currency: "USD",
        tokens: 120,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "output",
        currency: "USD",
        tokens: 30,
        kind: "measured",
        scope: "direct-execution",
      },
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "input",
        currency: "USD",
        tokens: 100,
        kind: "estimate",
        scope: "direct-execution",
      },
      {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "output",
        currency: "USD",
        tokens: 20,
        kind: "estimate",
        scope: "direct-execution",
      },
    ];
    const basis = normalizeArmCosts(facts, rev001);
    expect(basis.measuredMicroUsd).toBe("22");
    expect(basis.estimatedMicroUsd).toBe("17");
    expect(
      costFactsOf(basis, "val-040-unit").map((fact) => `${fact.kind}:${fact.amountMicroUsd}`),
    ).toEqual(["measured:22", "estimate:17"]);
  });

  test("cost-per-resolved is NULL when nothing resolves (never zero)", () => {
    const outcome = deriveCostPerResolved({
      measuredMicroUsd: "552",
      estimatedMicroUsd: "0",
      resolvedCount: 0,
    });
    expect(outcome.costPerResolvedMicroUsd).toBeNull();
    expect(outcome.estimateBacking).toBe(false);
  });

  test("an estimate-backed cost-per-resolved is REFUSED mechanically", () => {
    const outcome = deriveCostPerResolved({
      measuredMicroUsd: "0",
      estimatedMicroUsd: "136",
      resolvedCount: 8,
    });
    expect(outcome.costPerResolvedMicroUsd).toBeNull();
    expect(outcome.estimateBacking).toBe(true);
    expect(outcome.evidence.join(" ")).toContain("REFUSED");
  });

  test("cost-per-resolved divides measured facts by the resolved count (262/8 → 33)", () => {
    const outcome = deriveCostPerResolved({
      measuredMicroUsd: "262",
      estimatedMicroUsd: "0",
      resolvedCount: 8,
    });
    expect(outcome.costPerResolvedMicroUsd).toBe("33");
  });

  test("the pinned per-round budget bound prices maxTokens at BOTH tiers (24 µ$ at 64 tokens)", () => {
    expect(
      deriveRoundBudgetBoundMicroUsd({
        manifest: rev001,
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct",
        maxTokens: 64,
      }),
    ).toBe("24");
  });
});

// ---------------------------------------------------------------------------
// The frozen experiment protocol
// ---------------------------------------------------------------------------

describe("VAL-040 protocol", () => {
  const honestArm = OFFLINE_CORPUS_ROWS[0]?.arm as FixedQualityArm;
  const honestFixedCost = rowById("fixed-cost-budget-exhausted-honest-stop").arm as FixedCostArm;

  test("the frozen arm grammar validates the honest arms and rejects malformed ones", () => {
    expect(validateArmDeclaration(honestArm)).toEqual([]);
    expect(
      validateArmDeclaration({ ...honestArm, priceRevision: "rev-999" }).length,
    ).toBeGreaterThan(0);
    expect(validateArmDeclaration({ ...honestArm, minimumSamples: 1 }).length).toBeGreaterThan(0);
    expect(
      validateArmDeclaration({
        ...honestArm,
        corpusSlice: honestArm.corpusSlice.slice(0, 4),
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateArmDeclaration({
        ...honestArm,
        corpusSlice: [...honestArm.corpusSlice.slice(0, 4), honestArm.corpusSlice[0] as string],
        minimumSamples: 4,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateArmDeclaration({
        ...honestArm,
        pinnedThreshold: { resolutionRate: 1.5 },
      }).length,
    ).toBeGreaterThan(0);
    expect(validateArmDeclaration(honestFixedCost)).toEqual([]);
    expect(
      validateArmDeclaration({
        ...honestFixedCost,
        pinnedBudgetMicroUsd: "0",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateArmDeclaration({
        ...honestFixedCost,
        pinnedBudgetMicroUsd: "-5",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateArmDeclaration({ ...honestFixedCost, maxTokensPerRound: 0 }).length,
    ).toBeGreaterThan(0);
  });

  test("pinExperiment freezes the declaration under a digest; drift fails mechanically", () => {
    const pinned = pinExperiment([honestArm, OFFLINE_CORPUS_ROWS[1]?.arm as EconomicArm]);
    expect(pinned.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyDeclarationDrift(pinned, pinned.arms)).toEqual([]);
    const drifted = { ...honestArm, pinnedThreshold: { resolutionRate: 0.5 } };
    expect(
      verifyDeclarationDrift(pinned, [drifted, pinned.arms[1] as EconomicArm]).length,
    ).toBeGreaterThan(0);
    expect(verifyDeclarationDrift(pinned, [honestArm]).length).toBeGreaterThan(0);
    expect(
      verifyDeclarationDrift(pinned, [
        honestArm,
        pinned.arms[1] as EconomicArm,
        { ...honestArm, armId: "undeclared-arm" },
      ]).length,
    ).toBeGreaterThan(0);
    expect(() => pinExperiment([honestArm, { ...honestArm }])).toThrow();
  });

  test("slice conformance: exact for fixed-quality, prefix for fixed-cost, catches exclusions", () => {
    const exact = deriveSliceConformance({
      arm: honestArm,
      executedTaskIds: honestArm.corpusSlice,
    });
    expect(exact.conformant).toBe(true);
    // The post-hoc exclusion: dropping a non-resolved task FAILS.
    const excluded = deriveSliceConformance({
      arm: honestArm,
      executedTaskIds: honestArm.corpusSlice.slice(0, 7),
    });
    expect(excluded.conformant).toBe(false);
    expect(excluded.evidence.join(" ")).toContain("NON-CONFORMANT");
    const foreign = deriveSliceConformance({
      arm: honestArm,
      executedTaskIds: [...honestArm.corpusSlice.slice(0, 7), "some-other-task#001"],
    });
    expect(foreign.conformant).toBe(false);

    const prefix = deriveSliceConformance({
      arm: honestFixedCost,
      executedTaskIds: honestFixedCost.corpusSlice.slice(0, 3),
    });
    expect(prefix.conformant).toBe(true);
    // A cherry-picked subset (skipping a middle task) FAILS.
    const cherry = deriveSliceConformance({
      arm: honestFixedCost,
      executedTaskIds: [
        honestFixedCost.corpusSlice[0] as string,
        honestFixedCost.corpusSlice[2] as string,
      ],
    });
    expect(cherry.conformant).toBe(false);
  });

  test("sample sufficiency enforces the declared minimum", () => {
    expect(deriveSampleSufficiency({ arm: honestArm, executedCount: 8 }).sufficient).toBe(true);
    const insufficient = deriveSampleSufficiency({ arm: honestArm, executedCount: 5 });
    expect(insufficient.sufficient).toBe(false);
    expect(insufficient.evidence.join(" ")).toContain("INSUFFICIENT");
  });

  test("threshold attainment is RECOMPUTED — a gamed claim is caught", () => {
    const met = deriveThresholdAttainment({
      arm: honestArm,
      observedResolutionRate: 0.75,
    });
    expect(met.met).toBe(true);
    const notMet = deriveThresholdAttainment({
      arm: honestArm,
      observedResolutionRate: 0.625,
    });
    expect(notMet.met).toBe(false);
    const gamed = deriveThresholdAttainment({
      arm: honestArm,
      observedResolutionRate: 0.625,
      claimedMet: true,
    });
    expect(gamed.met).toBe(false);
    expect(gamed.evidence.join(" ")).toContain("THRESHOLD GAMING");
  });

  test("budget respect is judged on the MEASURED total", () => {
    expect(
      deriveBudgetRespect({ arm: honestFixedCost, measuredMicroUsd: "59", estimatedMicroUsd: "0" })
        .respected,
    ).toBe(true);
    const breach = deriveBudgetRespect({
      arm: honestFixedCost,
      measuredMicroUsd: "100",
      estimatedMicroUsd: "0",
    });
    expect(breach.respected).toBe(false);
    expect(breach.evidence.join(" ")).toContain("BREACHED");
  });

  test("the comparison validation battery fails the confidence-less comparison", () => {
    const comparison = deriveNormalizedComparison({
      arm: honestArm,
      aggregate: aggregateOf(8, 8, "176", "17"),
      executedTaskIds: honestArm.corpusSlice,
    });
    expect(validateNormalizedComparison(comparison)).toEqual([]);
    const confidenceLess = { ...comparison, resolutionConfidence: null };
    const violations = validateNormalizedComparison(confidenceLess);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.reason).toContain("CONFIDENCE-LESS COMPARISON");
  });

  test("the comparison validation battery fails the below-minimum arm", () => {
    const comparison = deriveNormalizedComparison({
      arm: honestArm,
      aggregate: aggregateOf(5, 5, "110", "0"),
      executedTaskIds: honestArm.corpusSlice.slice(0, 5),
    });
    const violations = validateNormalizedComparison(comparison);
    expect(violations.some((violation) => violation.reason.includes("SAMPLE-SIZE VIOLATION"))).toBe(
      true,
    );
  });

  test("the comparison validation battery fails the estimate-backed comparison", () => {
    const comparison = deriveNormalizedComparison({
      arm: honestArm,
      aggregate: aggregateOf(8, 8, "0", "136"),
      executedTaskIds: honestArm.corpusSlice,
    });
    const violations = validateNormalizedComparison(comparison);
    expect(
      violations.some((violation) =>
        violation.reason.includes("ESTIMATE-BACKED COST-PER-RESOLUTION"),
      ),
    ).toBe(true);
  });

  test("the comparison validation battery fails the post-hoc exclusion and threshold gaming", () => {
    const excluded = deriveNormalizedComparison({
      arm: honestArm,
      aggregate: aggregateOf(6, 6, "132", "0"),
      executedTaskIds: honestArm.corpusSlice.slice(0, 6),
    });
    expect(
      validateNormalizedComparison(excluded).some((violation) =>
        violation.reason.includes("POST-HOC ARM EXCLUSION"),
      ),
    ).toBe(true);
    const gamed = deriveNormalizedComparison({
      arm: { ...honestArm, pinnedThreshold: { resolutionRate: 0.9 } },
      aggregate: aggregateOf(8, 6, "176", "17"),
      executedTaskIds: honestArm.corpusSlice,
      claimedThresholdMet: true,
    });
    const gaming = validateNormalizedComparison(gamed);
    expect(gaming.some((violation) => violation.reason.includes("THRESHOLD GAMING"))).toBe(true);
    expect(gaming.some((violation) => violation.reason.includes("THRESHOLD NOT ATTAINED"))).toBe(
      true,
    );
  });

  test("the comparison carries the Wilson 95% interval from the REAL accounting module", () => {
    const euroArm = rowById("fixed-quality-euro-relay-eur").arm;
    const comparison = deriveNormalizedComparison({
      arm: euroArm,
      aggregate: aggregateOf(8, 6, "970", "0"),
      executedTaskIds: euroArm.corpusSlice,
    });
    const expected = wilsonInterval(6, 8);
    expect(comparison.resolutionConfidence).not.toBeNull();
    if (comparison.resolutionConfidence !== null) {
      expect(comparison.resolutionConfidence.low).toBeCloseTo(expected.low, 12);
      expect(comparison.resolutionConfidence.high).toBeCloseTo(expected.high, 12);
    }
    expect(comparison.costPerResolvedMicroUsd).toBe("162");
  });
});

/** Build a REAL-shaped accounting aggregate literal for the protocol-level probes. */
function aggregateOf(
  runs: number,
  resolved: number,
  measuredMicroUsd: string,
  estimatedMicroUsd: string,
): ArmAggregate {
  const confidence = wilsonInterval(resolved, runs);
  return {
    arm: "probe",
    corpusSlice: "probe",
    runCount: runs,
    resolvedCount: resolved,
    resolutionRate: runs === 0 ? 0 : resolved / runs,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
    measuredCostMicroUsd: measuredMicroUsd,
    estimatedCostMicroUsd: estimatedMicroUsd,
    costPerResolvedMicroUsd: resolved > 0 ? measuredMicroUsd : null,
    latency: { mean: 1, p95: 1, max: 1 },
  };
}

// ---------------------------------------------------------------------------
// The driver over every offline row (the REAL rails, the fake platform)
// ---------------------------------------------------------------------------

describe("VAL-040 driver over the offline corpus", () => {
  test("the corpus declares per-row arm manifest entries and expected normalized outcomes", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(validateArmDeclaration(row.arm)).toEqual([]);
      expect(row.expected.normalized).toBeDefined();
      expect(row.expected.appCreated).toBe(1);
      // The rows never embed list prices: the body carries references only.
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body).not.toMatch(/"(input|output)Price"/);
      expect(body).toContain(row.arm.priceRevision);
    }
  });

  test("every offline row completes with valid evidence and the pinned normalized outcome", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverFakeStack({ row, runSuffix: "all" });
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      expect(result.observedTerminal).toBe("COMPLETED");
      expect(result.comparison).not.toBeNull();
      const expected = row.expected.normalized;
      expect(expected).toBeDefined();
      const comparison = result.comparison;
      if (expected !== undefined && comparison !== null) {
        expect(comparison.runCount, `${row.rowId} runs`).toBe(expected.runCount);
        expect(comparison.resolvedCount, `${row.rowId} resolved`).toBe(expected.resolvedCount);
        expect(comparison.measuredCostMicroUsd, `${row.rowId} measured`).toBe(
          expected.measuredCostMicroUsd,
        );
        expect(comparison.estimatedCostMicroUsd, `${row.rowId} estimated`).toBe(
          expected.estimatedCostMicroUsd,
        );
        expect(comparison.costPerResolvedMicroUsd, `${row.rowId} cpr`).toBe(
          expected.costPerResolvedMicroUsd,
        );
        expect(comparison.resolutionConfidence?.low, `${row.rowId} wilson low`).toBeCloseTo(
          expected.resolutionConfidence.low,
          12,
        );
        expect(comparison.resolutionConfidence?.high, `${row.rowId} wilson high`).toBeCloseTo(
          expected.resolutionConfidence.high,
          12,
        );
      }
      // The comparison carries the Wilson interval of the REAL aggregate.
      if (comparison !== null && result.aggregate !== null) {
        expect(comparison.resolutionConfidence?.low).toBe(
          result.aggregate.resolutionConfidence.low,
        );
      }
    }
  }, 120_000);

  test("the pinned expected economics are the honest hand-computed numbers", () => {
    const expectations: Readonly<
      Record<
        string,
        { runs: number; resolved: number; measured: string; estimated: string; cpr: string | null }
      >
    > = {
      "fixed-quality-openrouter-usd-metered": {
        runs: 8,
        resolved: 8,
        measured: "176",
        estimated: "17",
        cpr: "22",
      },
      "fixed-quality-euro-relay-eur": {
        runs: 8,
        resolved: 6,
        measured: "970",
        estimated: "0",
        cpr: "162",
      },
      "fixed-quality-tokyo-relay-jpy-per-1k": {
        runs: 8,
        resolved: 7,
        measured: "325129",
        estimated: "0",
        cpr: "46447",
      },
      "fixed-quality-batch-relay-batched": {
        runs: 8,
        resolved: 8,
        measured: "1880",
        estimated: "0",
        cpr: "235",
      },
      "fixed-quality-retry-amortization": {
        runs: 8,
        resolved: 8,
        measured: "262",
        estimated: "0",
        cpr: "33",
      },
      "fixed-cost-openrouter-within-budget": {
        runs: 6,
        resolved: 5,
        measured: "125",
        estimated: "0",
        cpr: "25",
      },
      "fixed-cost-budget-exhausted-honest-stop": {
        runs: 3,
        resolved: 2,
        measured: "59",
        estimated: "0",
        cpr: "30",
      },
      "zero-resolved-null-cost-per-resolved": {
        runs: 6,
        resolved: 0,
        measured: "552",
        estimated: "0",
        cpr: null,
      },
    };
    for (const [rowId, expected] of Object.entries(expectations)) {
      const row = rowById(rowId);
      const normalized = row.expected.normalized;
      expect(normalized, rowId).toBeDefined();
      if (normalized !== undefined) {
        expect(normalized.runCount, `${rowId} runs`).toBe(expected.runs);
        expect(normalized.resolvedCount, `${rowId} resolved`).toBe(expected.resolved);
        expect(normalized.measuredCostMicroUsd, `${rowId} measured`).toBe(expected.measured);
        expect(normalized.estimatedCostMicroUsd, `${rowId} estimated`).toBe(expected.estimated);
        expect(normalized.costPerResolvedMicroUsd, `${rowId} cpr`).toBe(expected.cpr);
      }
    }
  });

  test("the budget-stop row stops honestly after the declared prefix", async () => {
    const row = rowById("fixed-cost-budget-exhausted-honest-stop");
    const result = await driveRowOverFakeStack({ row, runSuffix: "stop" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.budgetStopAfter).toBe(3);
    expect(result.rounds.map((round) => round.taskId)).toEqual(row.arm.corpusSlice.slice(0, 3));
    // The measured total respects the pinned 70 µ$ budget.
    expect(result.comparison?.measuredCostMicroUsd).toBe("59");
    expect(result.comparison?.budget?.respected).toBe(true);
  });

  test("the zero-resolved row holds the NULL discipline (never zero, never estimate-backed)", async () => {
    const row = rowById("zero-resolved-null-cost-per-resolved");
    const result = await driveRowOverFakeStack({ row, runSuffix: "zero" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.resolvedCount).toBe(0);
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.comparison?.resolutionConfidence?.low).toBe(0);
    expect(result.comparison?.resolutionConfidence?.high).toBeGreaterThan(0);
  });

  test("the retry-amortization row amortizes the retries into the resolved cost", async () => {
    const row = rowById("fixed-quality-retry-amortization");
    const result = await driveRowOverFakeStack({ row, runSuffix: "retry" });
    expect(result.terminal).toBe("COMPLETED");
    // 3 rounds retried (2 attempts each); the retry-overhead facts ride the runs.
    const retried = result.rounds.filter((round) => round.attempts === 2);
    expect(retried.length).toBe(3);
    expect(result.comparison?.measuredCostMicroUsd).toBe("262");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("33");
  });

  test("the arm decision is journaled BEFORE the first round (the durable planning decision)", async () => {
    const row = rowById("fixed-cost-budget-exhausted-honest-stop");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const executor = createRecordedReplayExecutor({ row, clock });
    const submission = await seam({ key: "val-040-unit-decision", body: taskBodyFor({ row }) });
    await driveEconomicRow({
      row,
      lifecycle,
      executor,
      rails: createRealAccountingRails(),
      tasks: economicTasksForArm(row.arm),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: "val-040-unit-decision",
      corpusVersion: ECONOMIC_CORPUS_VERSION,
      baseline: ledger.facts(),
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
      now: clock.now,
    });
    const journal = lifecycle.journal;
    // The planning decision carries the ARM DECISION (the budget plan).
    expect(journal.decisions.length).toBe(1);
    const decision = journal.decisions[0];
    expect(decision?.armDecision.kind).toBe("fixed-cost-budget-plan");
    expect(decision?.armDecision.pinnedBudgetMicroUsd).toBe("70");
    expect(decision?.armDecision.roundBoundMicroUsd).toBe("24");
    // The decision's journal record precedes every round record.
    const decisionOrdinal = journal.stepEvents.find((event) => event.record.kind === "arm-decision")
      ?.record.ordinal;
    const firstRoundOrdinal = journal.stepEvents.find(
      (event) => event.record.kind === "round" || event.record.kind === "failure",
    )?.record.ordinal;
    expect(decisionOrdinal).toBeDefined();
    expect(firstRoundOrdinal).toBeDefined();
    expect(decisionOrdinal as number).toBeLessThan(firstRoundOrdinal as number);
    // The call keys are per-decision distinct (the VAL-018 lesson).
    expect(new Set(journal.callKeys).size).toBe(journal.callKeys.length);
    // The canonical transition order holds.
    const steps = journal.transitions.map((transition) => transition.step);
    expect(steps).toEqual(["authorize", "plan", "queue", "start", "verify"]);
  });

  test("the digest helper is deterministic and payload-safe", () => {
    expect(economicDigestOf({ a: 1 })).toBe(economicDigestOf({ a: 1 }));
    expect(economicDigestOf({ a: 1 })).not.toBe(economicDigestOf({ a: 2 }));
    expect(economicDigestOf("secret-payload")).toMatch(/^[0-9a-f]{8}$/);
  });
});
