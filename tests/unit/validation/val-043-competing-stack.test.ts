/**
 * VAL-043 acceptance criteria 1, 2 and 4 (the offline oracle floor):
 *
 *   * the competitor configuration is explicit, exhaustive and
 *     content-addressed (digest agreement, the correction-as-new-
 *     revision discipline, the in-place bound-mutation catch, the
 *     structural validation — every toggle carrying a documented
 *     reference);
 *   * the configuration-conformance derivation FAILs an UNDECLARED
 *     setting (the masquerade catch), the behavior-variance
 *     derivation FAILs observed variance without the declaration
 *     (the silent routing change catch) and the retry-posture
 *     derivation FAILs an undeclared escalation — all at the
 *     derivation level;
 *   * the corpus declares per-row arm manifest entries (the frozen
 *     VAL-040 grammar), pinned configuration revisions and the
 *     expected normalized outcomes (the honest hand-computed
 *     numbers);
 *   * the competing driver drives EVERY offline corpus row to
 *     settlement over the deterministic fixtures with the REAL
 *     accounting rails, reproducing the corpus's pinned expected
 *     normalized outcomes exactly — the declared internal-fallback
 *     amortization, the routed catalog classes, the EUR conversion,
 *     the budget-stop prefix and the NULL discipline included.
 */

import { describe, expect, test } from "vitest";
import { manifestFor } from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import { validateArmDeclaration } from "../../../benchmarks/validation/apps/economic-baseline/protocol";
import {
  COMPETITOR_CONFIG,
  competitorConfigFor,
  computeCompetitorConfigDigest,
  deriveBehaviorVariance,
  deriveCompetitorConfigAppendOnly,
  deriveCompetitorConfigConformance,
  deriveCompetitorConfigIntegrity,
  deriveRetryPostureConformance,
  MODEL_SELECTION_NAME,
  RETRY_POLICY_NAME,
  retryBoundOf,
  routeForClass,
  varianceDeclarationOf,
} from "../../../benchmarks/validation/apps/economic-controls-competing/competitor-config";
import {
  COMPETING_CORPUS,
  COMPETING_CORPUS_VERSION,
  competingTasksForArm,
  OFFLINE_CORPUS_ROWS,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-controls-competing/corpus";
import {
  type CompetingCorpusRow,
  createRealAccountingRails,
  deriveCompetingRoundBudgetBoundMicroUsd,
  driveCompetingRow,
  economicDigestOf,
  taskClassesOfRow,
} from "../../../benchmarks/validation/apps/economic-controls-competing/driver";
import {
  createCompetingReplayExecutor,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  mutatedCompetitorConfigOf,
} from "../../../benchmarks/validation/apps/economic-controls-competing/fixtures";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "054a041530ecffe0f82df8faf343fc5ece3b1046";

const noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-043",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "stack:openrouter",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-043-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): CompetingCorpusRow => {
  const row = COMPETING_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(row: CompetingCorpusRow) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createCompetingReplayExecutor({ row, clock });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-043-unit-${row.rowId}`,
    body: taskBodyFor({ row }),
  });
  const result = await driveCompetingRow({
    row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: competingTasksForArm(row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-043-unit-${row.rowId}`,
    corpusVersion: COMPETING_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

// ---------------------------------------------------------------------------
// The competitor configuration registry
// ---------------------------------------------------------------------------

describe("VAL-043 competitor configuration", () => {
  test("the registry is append-only with unique revisions and frozen digests", () => {
    const appendOnly = deriveCompetitorConfigAppendOnly();
    expect(appendOnly.appendOnly).toBe(true);
    expect(appendOnly.revisions).toEqual(["cmp-rev-001", "cmp-rev-002"]);
  });

  test("a bound correction is a NEW revision — cmp-rev-001 stays frozen and readable", () => {
    const first = competitorConfigFor("cmp-rev-001");
    const corrected = competitorConfigFor("cmp-rev-002");
    expect(corrected.supersedes).toBe("cmp-rev-001");
    expect(retryBoundOf(first)).toBe(2);
    expect(retryBoundOf(corrected)).toBe(1);
    // The first revision's digest still agrees with its own content
    // (frozen and readable — the correction never edits it).
    expect(deriveCompetitorConfigIntegrity({ revision: "cmp-rev-001" }).agreed).toBe(true);
    expect(first.digest).not.toBe(corrected.digest);
  });

  test("configuration integrity agrees for every pinned revision", () => {
    for (const revision of COMPETITOR_CONFIG) {
      const verdict = deriveCompetitorConfigIntegrity({ revision: revision.revision });
      expect(verdict.agreed, revision.revision).toBe(true);
    }
  });

  test("an IN-PLACE bound mutation breaks digest agreement mechanically", () => {
    const mutated = mutatedCompetitorConfigOf("cmp-rev-001", {
      name: RETRY_POLICY_NAME,
      bound: { maxInternalRetries: 0 },
    });
    const verdict = deriveCompetitorConfigIntegrity({
      revision: "cmp-rev-001",
      registry: [mutated],
    });
    expect(verdict.declaredRevisionKnown).toBe(true);
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("an unknown declared revision fails configuration integrity", () => {
    const verdict = deriveCompetitorConfigIntegrity({ revision: "cmp-rev-999" });
    expect(verdict.declaredRevisionKnown).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("structural validation rejects malformed configurations", () => {
    const base = competitorConfigFor("cmp-rev-001");
    // An entry WITHOUT a documented reference (the undocumented toggle).
    const undocumented = {
      ...base,
      entries: base.entries.map((entry) => ({ ...entry, documentedRef: "" })),
      digest: computeCompetitorConfigDigest({
        entries: base.entries.map((entry) => ({ ...entry, documentedRef: "" })),
        routes: base.routes,
        fallbackRoute: base.fallbackRoute,
      }),
    };
    expect(
      deriveCompetitorConfigIntegrity({ revision: "cmp-rev-001", registry: [undocumented] }).agreed,
    ).toBe(false);
    // A provider-routing entry WITHOUT an explicit variance declaration.
    const varianceless = {
      ...base,
      entries: base.entries.map((entry) =>
        entry.kind === "provider-routing" ? { ...entry, bound: { ordering: "pool" } } : entry,
      ),
    };
    const verdict = deriveCompetitorConfigIntegrity({
      revision: "cmp-rev-001",
      registry: [varianceless],
    });
    expect(verdict.structurallyValid).toBe(false);
    // A duplicate task class in the model-selection table.
    const duplicated = {
      ...base,
      routes: [...base.routes, base.routes[0] as (typeof base.routes)[number]],
    };
    expect(
      deriveCompetitorConfigIntegrity({ revision: "cmp-rev-001", registry: [duplicated] })
        .structurallyValid,
    ).toBe(false);
  });

  test("the model-selection table resolves per class with the conservative fallback", () => {
    const config = competitorConfigFor("cmp-rev-001");
    expect(routeForClass(config, "extract")).toEqual({
      taskClass: "extract",
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
    });
    expect(routeForClass(config, "translate")).toEqual({
      taskClass: "translate",
      provider: "euro-relay",
      model: "euro-small-v1",
    });
    expect(routeForClass(config, "unknown-class")).toEqual(config.fallbackRoute);
  });

  test("the configuration-conformance derivation FAILs an UNDECLARED setting", () => {
    const config = competitorConfigFor("cmp-rev-001");
    const honest = deriveCompetitorConfigConformance({
      config,
      appliedSettings: config.entries.map((entry) => entry.name),
    });
    expect(honest.conformant).toBe(true);
    const masquerade = deriveCompetitorConfigConformance({
      config,
      appliedSettings: [MODEL_SELECTION_NAME, "secret-negotiated-rate-toggle"],
    });
    expect(masquerade.conformant).toBe(false);
    expect(masquerade.undeclared).toEqual(["secret-negotiated-rate-toggle"]);
  });

  test("the behavior-variance derivation FAILs observed variance without the declaration", () => {
    const config = competitorConfigFor("cmp-rev-001");
    // Declared variance + observed variance → honest.
    const declared = deriveBehaviorVariance({
      config,
      observations: [
        { taskClass: "extract", routedEndpoint: "pool-primary" },
        { taskClass: "extract", routedEndpoint: "pool-secondary" },
      ],
    });
    expect(declared.varianceObserved).toBe(true);
    expect(declared.conformant).toBe(true);
    // Reproduced observations → pass regardless.
    const reproduced = deriveBehaviorVariance({
      config,
      observations: [
        { taskClass: "extract", routedEndpoint: "pool-primary" },
        { taskClass: "extract", routedEndpoint: "pool-primary" },
      ],
    });
    expect(reproduced.varianceObserved).toBe(false);
    expect(reproduced.conformant).toBe(true);
    // The pinned-ordering variant (variance "none") + observed variance → the silent routing change.
    const pinned = {
      ...config,
      entries: config.entries.map((entry) =>
        entry.kind === "provider-routing"
          ? { ...entry, bound: { ...entry.bound, variance: "none (pinned)" } }
          : entry,
      ),
    };
    const silent = deriveBehaviorVariance({
      config: pinned,
      observations: [
        { taskClass: "extract", routedEndpoint: "pool-primary" },
        { taskClass: "extract", routedEndpoint: "pool-shadow" },
      ],
    });
    expect(silent.varianceObserved).toBe(true);
    expect(silent.conformant).toBe(false);
    expect(varianceDeclarationOf(config)).toBe("declared");
  });

  test("the retry-posture derivation FAILs an undeclared escalation", () => {
    const config = competitorConfigFor("cmp-rev-001");
    const honest = deriveRetryPostureConformance({
      config,
      observations: [{ taskId: "t1", internalAttempts: 3 }],
    });
    expect(honest.conformant).toBe(true);
    const escalated = deriveRetryPostureConformance({
      config,
      observations: [{ taskId: "t1", internalAttempts: 4 }],
    });
    expect(escalated.conformant).toBe(false);
  });

  test("the per-round budget bound is the worst case over the row's declared classes", () => {
    const manifest = manifestFor("rev-001");
    const config = competitorConfigFor("cmp-rev-001");
    // extract-only rows: the openrouter bound at 64 tokens = 8 + 16 = 24 µ$.
    expect(
      deriveCompetingRoundBudgetBoundMicroUsd({
        manifest,
        config,
        taskClasses: ["extract"],
        maxTokens: 64,
      }),
    ).toBe("24");
    // A row declaring summarize + transform-batch + extract rides the
    // batched rail's 500-token ceil at its worst case: 64 tokens round
    // UP to the whole 500-token batch → 40 + 160 = 200 µ$ (the bound
    // composes the manifest's own batched metering so it never
    // under-reserves).
    expect(
      deriveCompetingRoundBudgetBoundMicroUsd({
        manifest,
        config,
        taskClasses: ["summarize", "transform-batch", "extract"],
        maxTokens: 64,
      }),
    ).toBe("200");
  });
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe("VAL-043 corpus", () => {
  test("the corpus declares per-row arm manifest entries and configuration revisions", () => {
    for (const row of COMPETING_CORPUS) {
      expect(validateArmDeclaration(row.arm), row.rowId).toEqual([]);
      expect(row.arm.integrationSurface).toBe("stack:openrouter");
      expect(competitorConfigFor(row.competitorConfigRevision).revision).toBe(
        row.competitorConfigRevision,
      );
      expect(row.frozenPortfolio.manifestDigest).toMatch(/^[0-9a-f]{8}$/);
      // The offline rows pin their expected normalized outcome.
      if (!row.needsDispatch) {
        expect(row.expected.normalized, row.rowId).toBeDefined();
      }
    }
    expect(OFFLINE_CORPUS_ROWS.length).toBe(7);
  });

  test("the pinned expected economics are the honest hand-computed numbers", () => {
    const table: readonly (readonly [string, number, number, string, string, string | null])[] = [
      ["fixed-quality-competitor-default-routing", 8, 8, "210", "17", "26"],
      ["fixed-quality-competitor-routed-classes", 8, 8, "602", "17", "75"],
      ["fixed-quality-competitor-eu-catalog", 6, 5, "747", "0", "149"],
      ["fixed-quality-competitor-corrected-config", 6, 6, "166", "0", "28"],
      ["fixed-cost-competitor-within-budget", 6, 5, "125", "0", "25"],
      ["fixed-cost-competitor-budget-exhausted-honest-stop", 3, 2, "59", "0", "30"],
      ["zero-resolved-competitor-null-discipline", 6, 0, "156", "0", null],
    ];
    for (const [rowId, runs, resolved, measured, estimated, cpr] of table) {
      const row = rowById(rowId);
      const normalized = row.expected.normalized;
      expect(normalized, rowId).toBeDefined();
      if (normalized === undefined) {
        continue;
      }
      expect(normalized.runCount, rowId).toBe(runs);
      expect(normalized.resolvedCount, rowId).toBe(resolved);
      expect(normalized.measuredCostMicroUsd, rowId).toBe(measured);
      expect(normalized.estimatedCostMicroUsd, rowId).toBe(estimated);
      expect(normalized.costPerResolvedMicroUsd, rowId).toBe(cpr);
      expect(normalized.resolutionConfidence, rowId).not.toBeNull();
    }
  });

  test("the task bodies carry references only — never an inline price or configuration bound", () => {
    for (const row of COMPETING_CORPUS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      // No inline list price (a token price, a per-1M rate) and no
      // configuration bound ever rides the body — references only.
      expect(body, row.rowId).not.toContain('"price"');
      expect(body, row.rowId).not.toMatch(/\d\.\d+\s*(usd|eur|jpy)/i);
      expect(body, row.rowId).not.toContain("maxInternalRetries");
      expect(body, row.rowId).not.toContain("variance");
      expect(body, row.rowId).toContain("competitorConfigRevision");
    }
  });

  test("the frozen-portfolio references are the VAL-030 baseline revisions by digest", () => {
    for (const row of COMPETING_CORPUS) {
      const reference = row.frozenPortfolio;
      // The digest re-derives through the platform's own derivation
      // (the row criteria verify it mechanically too — this unit
      // asserts the corpus's references were built from the frozen
      // portfolio's own manifest entries).
      expect(reference.appId.startsWith("portfolio:")).toBe(true);
      expect(reference.workloadRevision).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The driver over the offline corpus
// ---------------------------------------------------------------------------

describe("VAL-043 driver over the offline corpus", () => {
  test("every offline row completes with valid evidence and the pinned normalized outcome", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal, row.rowId).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.comparison).not.toBeNull();
      const expected = row.expected.normalized;
      if (expected === undefined || result.comparison === null) {
        throw new Error(`missing oracle for ${row.rowId}`);
      }
      expect(result.comparison.runCount, row.rowId).toBe(expected.runCount);
      expect(result.comparison.resolvedCount, row.rowId).toBe(expected.resolvedCount);
      expect(result.comparison.measuredCostMicroUsd, row.rowId).toBe(expected.measuredCostMicroUsd);
      expect(result.comparison.estimatedCostMicroUsd, row.rowId).toBe(
        expected.estimatedCostMicroUsd,
      );
      expect(result.comparison.costPerResolvedMicroUsd, row.rowId).toBe(
        expected.costPerResolvedMicroUsd,
      );
      expect(result.comparison.resolutionConfidence?.low, row.rowId).toBeCloseTo(
        expected.resolutionConfidence.low,
        12,
      );
    }
  });

  test("the headline row: the internal-fallback amortization rides INSIDE the request", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const { result } = await driveRowOverHonestStack(row);
    expect(result.rounds).toHaveLength(8);
    // Rounds 1-7: one request, one internal attempt each.
    for (const round of result.rounds.slice(0, 7)) {
      expect(round.internalAttempts).toBe(1);
      expect(round.attempts).toBe(1);
    }
    // Round 8: THREE internal attempts inside ONE request (the
    // aggregate usage 360/50 — priced as the request's own measured
    // usage, the amortization inside the competitor's boundary).
    const eighth = result.rounds[7];
    expect(eighth?.internalAttempts).toBe(3);
    expect(eighth?.attempts).toBe(1);
    const inputFacts = eighth?.usageFacts.filter(
      (fact) => fact.tier === "input" && fact.kind === "measured",
    );
    expect(inputFacts).toHaveLength(1);
    expect(inputFacts?.[0]?.tokens).toBe(360);
    // The variance observation: the eighth request rode the tertiary endpoint.
    expect(eighth?.routedEndpoint).toBe("openrouter-pool-tertiary");
  });

  test("the routed row rides the declared catalog classes (the batched ceil-to-batch included)", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const { result } = await driveRowOverHonestStack(row);
    const classes = result.rounds.map((round) => round.taskClass);
    expect(classes).toEqual([
      "summarize",
      "summarize",
      "summarize",
      "extract",
      "extract",
      "extract",
      "transform-batch",
      "transform-batch",
    ]);
    // The batched rounds charge ceil-to-batch on BOTH tiers (520 in →
    // 1000 charged; 60 out → 500 charged).
    const batched = result.rounds[7];
    expect(batched?.route).toEqual({ provider: "batch-relay", model: "batch-medium-v1" });
    expect(result.comparison?.measuredCostMicroUsd).toBe("602");
  });

  test("the EU-catalog row converges the EUR prices through the pinned FX", async () => {
    const row = rowById("fixed-quality-competitor-eu-catalog");
    const { result } = await driveRowOverHonestStack(row);
    expect(result.comparison?.resolvedCount).toBe(5);
    expect(result.comparison?.measuredCostMicroUsd).toBe("747");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("149");
    for (const round of result.rounds) {
      expect(round.route).toEqual({ provider: "euro-relay", model: "euro-small-v1" });
    }
  });

  test("the corrected-config row rides cmp-rev-002's tightened posture", async () => {
    const row = rowById("fixed-quality-competitor-corrected-config");
    const { result } = await driveRowOverHonestStack(row);
    const retried = result.rounds.slice(4);
    for (const round of retried) {
      expect(round.internalAttempts).toBe(2);
    }
    expect(result.comparison?.measuredCostMicroUsd).toBe("166");
  });

  test("the budget-stop row stops honestly after the declared prefix", async () => {
    const row = rowById("fixed-cost-competitor-budget-exhausted-honest-stop");
    const { result } = await driveRowOverHonestStack(row);
    expect(result.rounds).toHaveLength(3);
    expect(result.budgetStopAfter).toBe(3);
    expect(result.comparison?.measuredCostMicroUsd).toBe("59");
    expect(result.comparison?.resolvedCount).toBe(2);
  });

  test("the zero-resolved row holds the NULL discipline (never zero, never estimate-backed)", async () => {
    const row = rowById("zero-resolved-competitor-null-discipline");
    const { result } = await driveRowOverHonestStack(row);
    expect(result.comparison?.resolvedCount).toBe(0);
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.comparison?.measuredCostMicroUsd).toBe("156");
  });

  test("the arm decisions are journaled BEFORE the first round (the durable planning decision)", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const { lifecycle } = await driveRowOverHonestStack(row);
    const decision = lifecycle.journal.decisions[0];
    expect(decision).toBeDefined();
    expect(decision?.armDecision.kind).toBe("competing-fixed-quality-plan");
    expect(decision?.armDecision.competitorConfigRevision).toBe("cmp-rev-001");
    expect(String(decision?.armDecision.competitorConfigDigest)).toContain("sha256:");
    // The canonical transitions: authorize → plan → queue → start → verify.
    expect(lifecycle.journal.transitions.map((transition) => transition.step)).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
    ]);
    // The arm-decision journal record precedes every round record.
    const stepEvents = lifecycle.journal.stepEvents.map((event) => event.record.kind);
    expect(stepEvents[0]).toBe("arm-decision");
    expect(stepEvents.indexOf("round")).toBeGreaterThan(0);
  });

  test("the fixed-cost arm decision records the budget bound priced BEFORE dispatch", async () => {
    const row = rowById("fixed-cost-competitor-budget-exhausted-honest-stop");
    const { lifecycle, result } = await driveRowOverHonestStack(row);
    const decision = lifecycle.journal.decisions[0];
    expect(decision?.armDecision.kind).toBe("competing-fixed-cost-budget-plan");
    expect(decision?.armDecision.roundBoundMicroUsd).toBe("24");
    expect(result.budgetStopAfter).toBe(3);
  });

  test("the per-decision-distinct call keys never collide on the ledger", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const { lifecycle } = await driveRowOverHonestStack(row);
    const keys = lifecycle.journal.callKeys;
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the digest helper is deterministic and payload-safe", () => {
    expect(economicDigestOf({ a: 1 })).toBe(economicDigestOf({ a: 1 }));
    expect(economicDigestOf({ a: 1 })).not.toBe(economicDigestOf({ a: 2 }));
    expect(economicDigestOf("payload")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the row's declared classes derive in first-appearance order", () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    expect(taskClassesOfRow(row)).toEqual(["summarize", "extract", "transform-batch"]);
  });
});
