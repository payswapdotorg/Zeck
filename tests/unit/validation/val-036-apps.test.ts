/**
 * VAL-036 acceptance criteria 1 + 2: the determinization-maturity
 * customer application rides the public SDK boundary end to end against
 * a controlled fake transport (the submission phase — one OWN durable
 * execution per row under its OWN idempotency key; the observation
 * phase — the completion poll observing the honest terminal, the result
 * retrieval surfacing the verification statuses, the route's
 * model-call count (zero offline — the offline analysis is
 * digest-level), the honest none-reported offline usage, the
 * classification read back, the refusal reason read back, the curve
 * series read back (the generation points with their measured facts and
 * recorded generation digests), the savings attribution read back (the
 * per-mechanism numbers), the report-recorded flag, and the events read
 * re-deriving the maturity trajectory digest over the public journal;
 * the assertion phase — the PURE per-row maturity contract re-derived
 * AT the boundary), and its pinned task slice matches the repository
 * configuration file and the corpus.
 *
 * Discrimination: the FAKE-HISTORY variants (GAPPED / UNMEASURED /
 * UNRECONCILED / MUTATING) and the row-level adversarial variants (an
 * EXTRAPOLATED point; an UNCITED claim) each FAIL a specific mechanical
 * criterion of `deriveMaturityRowCriteria` (named, with the offending
 * member or both sides named), the maturity report ledger is APPEND-ONLY
 * (the identical re-drive REPLAYS; an impostor report is REFUSED), and
 * every fake-world boundary knob FAILs a specific boundary criterion —
 * while the honest stack passes every offline row with the honest
 * oracle's verdicts, the four honest classes read back their pinned
 * classifications + curve facts + per-mechanism savings, and the two
 * honest refusals land nothing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DETERMINIZATION_MATURITY_TASKS,
  runDeterminizationMaturityApp,
} from "../../../benchmarks/validation/apps/determinization-maturity/application";
import {
  DETERMINIZATION_MATURITY_CORPUS,
  DETERMINIZATION_MATURITY_ROW_IDS,
  DETERMINIZATION_MATURITY_TASK_KIND,
  FAMILY_HISTORIES,
  familyHistoryById,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  maturityRowById,
  maturitySubmissionKey,
  maturityTaskBodyFor,
  OFFLINE_CORPUS_ROWS,
  PHANTOM_FAMILY_ID,
} from "../../../benchmarks/validation/apps/determinization-maturity/corpus";
import {
  createHonestMaturityStack,
  createMaturityFakeApiWorld,
  createMaturityHistoryPort,
  createMaturityReportLedger,
  createTickClock,
  type FakeHistoryVariant,
} from "../../../benchmarks/validation/apps/determinization-maturity/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type {
  MaturityClassification,
  MaturityCorpusRow,
  MaturityRunResult,
} from "../../../benchmarks/validation/platform/determinization-maturity";
import {
  canonicalMaturityCitationOf,
  canonicalSavingsAttributionOf,
  driveMaturityAnalysis,
  generationRecordDigestOf,
  maturityCitationDigestOf,
  observedMaturityClassificationOf,
} from "../../../benchmarks/validation/platform/determinization-maturity";

const REVISION = "1b9018200000000000000000000000000000000aa";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

/** The fake API world's boundary discrimination knobs. */
interface WorldKnobs {
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly uncited?: boolean;
  readonly gapped?: boolean;
  readonly extrapolated?: boolean;
  readonly misclassified?: boolean;
  readonly aggregatesavings?: boolean;
  readonly unreconciled?: boolean;
  readonly unreported?: boolean;
}

/** Run one app row over the fake API world (the boundary discrimination knobs). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly knobs?: WorldKnobs;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runDeterminizationMaturityApp>>;
  readonly createdExecutions: number;
}> {
  const knobs = options.knobs ?? {};
  const clock = createTickClock();
  const world = createMaturityFakeApiWorld({
    clock,
    ...(knobs.terminal === undefined ? {} : { terminal: knobs.terminal }),
    ...(knobs.uncited === true ? { uncited: true } : {}),
    ...(knobs.gapped === true ? { gapped: true } : {}),
    ...(knobs.extrapolated === true ? { extrapolated: true } : {}),
    ...(knobs.misclassified === true ? { misclassified: true } : {}),
    ...(knobs.aggregatesavings === true ? { aggregatesavings: true } : {}),
    ...(knobs.unreconciled === true ? { unreconciled: true } : {}),
    ...(knobs.unreported === true ? { unreported: true } : {}),
  });
  const outcome = await runDeterminizationMaturityApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport: world.transport as TransportImplementation,
    now: clock.now,
    sleep: async () => {
      clock.tick();
    },
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-036-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return {
    evidence: outcome.evidence,
    passed: outcome.passed,
    outcome,
    createdExecutions: world.createdExecutions,
  };
}

/**
 * Drive one offline row over a purpose-built fake stack (the seams under
 * test — the history-port variant or an adversarial row variant).
 */
async function driveRowOverStack(options: {
  readonly row: MaturityCorpusRow;
  readonly historyVariant?: FakeHistoryVariant;
  readonly reportLedger?: ReturnType<typeof createMaturityReportLedger>;
}): Promise<{
  readonly result: MaturityRunResult;
  readonly reportLedger: ReturnType<typeof createMaturityReportLedger>;
}> {
  const clock = createTickClock();
  const history = createMaturityHistoryPort(options.historyVariant);
  const reportLedger = options.reportLedger ?? createMaturityReportLedger();
  const result = await driveMaturityAnalysis({
    row: options.row,
    analysis: history,
    reportLedger,
    now: clock.now,
  });
  return { result, reportLedger };
}

/** The ABSOLUTE corpus index of one row (the app selects by the full-corpus index). */
function taskIndexOf(rowId: string): number {
  const index = DETERMINIZATION_MATURITY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): MaturityCorpusRow => {
  const row = maturityRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (result: MaturityRunResult, criterionId: string) =>
  result.criteria.find((criterion) => criterion.criterionId === criterionId);

const appCriterionOf = (
  outcome: Awaited<ReturnType<typeof runDeterminizationMaturityApp>>,
  criterionId: string,
) => outcome.appCriteria.find((criterion) => criterion.criterionId === criterionId);

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-036 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(DETERMINIZATION_MATURITY_TASKS.length).toBe(DETERMINIZATION_MATURITY_CORPUS.length);
    for (const [index, task] of DETERMINIZATION_MATURITY_TASKS.entries()) {
      const row = DETERMINIZATION_MATURITY_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(DETERMINIZATION_MATURITY_TASK_KIND);
      expect(task.familyId).toBe(row?.familyId);
      expect(task.generations).toBe(row?.curveSeries.length);
      expect(task.citedLifecycle).toBe(row?.citation.lifecycleProposalIds.length);
      expect(task.citedGenerationDigests).toBe(row?.citation.generationDigests.length);
      expect(task.citedAccountingDigests).toBe(row?.citation.accountingEntryDigests.length);
      expect(task.claimedClassification).toBe(row?.claimedClassification);
      expect(task.claimedSavingsTotalMicroUsd).toBe(row?.claimedSavings.totalMicroUsd);
      expect(task.perMechanismBreakdown).toBe(row?.claimedSavings.perMechanism !== null);
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedRefusalReason).toBe(row?.expected.refusalReason);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.expectedModelCalls).toBe(row?.expected.modelCalls);
      expect(task.probe ?? null).toBe(row?.probe?.kind ?? null);
      expect(task.liveGate ?? null).toEqual(row?.liveGate?.envVars ?? null);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/determinization-maturity/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(DETERMINIZATION_MATURITY_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = DETERMINIZATION_MATURITY_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.familyId).toBe(exported?.familyId);
      expect(task.generations).toBe(exported?.generations);
      expect(task.citedLifecycle).toBe(exported?.citedLifecycle);
      expect(task.citedGenerationDigests).toBe(exported?.citedGenerationDigests);
      expect(task.citedAccountingDigests).toBe(exported?.citedAccountingDigests);
      expect(task.claimedClassification).toBe(exported?.claimedClassification);
      expect(task.claimedSavingsTotalMicroUsd).toBe(exported?.claimedSavingsTotalMicroUsd);
      expect(task.perMechanismBreakdown).toBe(exported?.perMechanismBreakdown);
      expect(task.expectedVerdict).toBe(exported?.expectedVerdict);
      expect(task.expectedRefusalReason).toBe(exported?.expectedRefusalReason);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.expectedModelCalls).toBe(exported?.expectedModelCalls);
      expect(task.probe ?? null).toBe(exported?.probe ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, full-population citations, gapless recorded series, canonical savings)", () => {
    const rowIds = DETERMINIZATION_MATURITY_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(DETERMINIZATION_MATURITY_ROW_IDS).toEqual(rowIds);
    expect(maturityRowById("rag-retrieval-determinized-stable")?.rowId).toBe(
      "rag-retrieval-determinized-stable",
    );
    expect(maturityRowById("nonexistent")).toBeNull();

    for (const row of DETERMINIZATION_MATURITY_CORPUS) {
      const history = familyHistoryById(row.familyId);
      if (history === null) {
        // The phantom family: nothing recorded, nothing cited, the
        // honest family-unrecorded refusal.
        expect(row.familyId).toBe(PHANTOM_FAMILY_ID);
        expect(row.citation.lifecycleProposalIds).toHaveLength(0);
        expect(row.expected.verdict).toBe("immaturity-honest");
        expect(row.expected.refusalReason).toBe("family-unrecorded");
        continue;
      }
      // The citation cites the family's FULL recorded population.
      expect(row.citation, `${row.rowId} full-population citation`).toEqual(
        canonicalMaturityCitationOf({
          lifecycleRecords: history.lifecycleRecords,
          generations: history.generations,
          accountingEntries: history.accountingEntries,
        }),
      );
      // The curve series is the canonical recorded-only series: gapless
      // 1..N, every point citing its RECORDED generation digest.
      expect(row.curveSeries.map((point) => point.generation)).toEqual(
        history.generations.map((generation) => generation.generation),
      );
      for (const point of row.curveSeries) {
        const recorded = history.generations.find(
          (generation) => generation.generation === point.generation,
        );
        expect(point.generationDigest, `${row.rowId} gen ${point.generation} digest`).toBe(
          recorded === undefined ? "" : generationRecordDigestOf(recorded),
        );
        expect(point.pointSource).toBe("recorded");
        expect(point.measured).toBe(true);
      }
      // The claimed classification is the PURE observed derivation over
      // the recorded generations (never asserted, always derived).
      if (history.generations.length > 0) {
        expect(row.claimedClassification, `${row.rowId} observed classification`).toBe(
          observedMaturityClassificationOf(history.generations),
        );
      }
      // The claimed savings are the canonical per-mechanism attribution
      // over the recorded accounting ledger.
      expect(row.claimedSavings, `${row.rowId} canonical savings`).toEqual(
        canonicalSavingsAttributionOf(history.accountingEntries),
      );
      // The honest oracle: the verdict and refusal per the family's own
      // recorded state.
      if (history.generations.length === 0) {
        expect(row.expected.verdict).toBe("immaturity-honest");
        expect(row.expected.refusalReason).toBe("no-generations-recorded");
        expect(row.curveSeries).toHaveLength(0);
      } else {
        expect(row.expected.verdict).toBe("maturity-established");
        expect(row.expected.refusalReason).toBeNull();
      }
      expect(row.expected.terminal).toBe("COMPLETED");
    }
    // Offline rows never dispatch; the live row exactly one REAL round.
    const liveRows = DETERMINIZATION_MATURITY_CORPUS.filter((row) => row.liveGate !== undefined);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]?.expected.modelCalls).toBe(1);
    expect(liveRows[0]?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.needsDispatch ?? false).toBe(false);
      expect(row.expected.modelCalls).toBe(0);
    }
  });

  test("the pinned membership: four honest classes + five probes + two honest refusals + one live row", () => {
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(11);
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    // Every probe vocabulary member is declared by exactly one row.
    const probeKinds = DETERMINIZATION_MATURITY_CORPUS.flatMap((row) =>
      row.probe === undefined ? [] : [row.probe.kind],
    );
    expect(new Set(probeKinds).size).toBe(probeKinds.length);
    expect([...probeKinds].sort()).toEqual([
      "gapped-series",
      "insufficient-evidence-trend",
      "misclassified-family",
      "uncited-claim",
      "unreconciled-savings",
    ]);
    // The four honest classes are each claimed by at least one offline row.
    const claimed = new Set(OFFLINE_CORPUS_ROWS.map((row) => row.claimedClassification));
    const honestClasses: readonly MaturityClassification[] = [
      "determinized-stable",
      "determinizing-trending",
      "variable-resilient",
      "immature-insufficient-evidence",
    ];
    for (const classification of honestClasses) {
      expect(claimed.has(classification), `${classification} claimed`).toBe(true);
    }
    // The verdict distribution: 9 established (4 classes + 5 probes) +
    // 2 honest refusals offline, + 1 live established row.
    const established = DETERMINIZATION_MATURITY_CORPUS.filter(
      (row) => row.expected.verdict === "maturity-established",
    ).length;
    const refusals = DETERMINIZATION_MATURITY_CORPUS.filter(
      (row) => row.expected.verdict === "immaturity-honest",
    );
    expect(established).toBe(10);
    expect(refusals.map((row) => row.expected.refusalReason).sort()).toEqual([
      "family-unrecorded",
      "no-generations-recorded",
    ]);
    // The pinned family histories: five recorded families over the
    // pinned generation counts.
    expect(FAMILY_HISTORIES).toHaveLength(5);
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(maturitySubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe(
      "val-036-determinization-maturity-3-unit",
    );
    const keys = [0, 1, 2].map((taskIndex) =>
      maturitySubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = maturityTaskBodyFor({
      rowId: "rag-retrieval-determinized-stable",
      familyId: "rag-retrieval",
    });
    expect(body).toEqual({
      kind: DETERMINIZATION_MATURITY_TASK_KIND,
      rowId: "rag-retrieval-determinized-stable",
      familyId: "rag-retrieval",
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the corpus holds no live row");
    }
    expect(liveRow.rowId).toBe("rag-retrieval-maturity-live");
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    // Every offline row is always drivable (no gate to consult).
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.liveGate).toBeUndefined();
      expect(row.needsDispatch ?? false).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row behaves per its pin)
// ---------------------------------------------------------------------------

describe("VAL-036 app over the honest fake world", () => {
  test("every offline row PASSES the boundary contract with valid evidence (its OWN durable execution)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(
        run.passed,
        `${row.rowId} app passed (criteria: ${JSON.stringify(
          run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL"),
        )})`,
      ).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
      const failed = run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // The maturity submission landed its OWN durable execution (one
      // submission per row — never a replay, never a rejection).
      expect(run.createdExecutions).toBe(1);
      expect(run.outcome.submission.replayed).toBe(false);
      expect(run.outcome.submission.rejection).toBeNull();
      expect(run.outcome.submission.executionId).not.toBe("");
      // The observed terminal is the honest one (a refusal COMPLETES).
      expect(run.outcome.observedTerminal).toBe(row.expected.terminal);
      // The offline analysis is digest-level: zero own dispatches and
      // the usage honestly none-reported offline.
      expect(run.outcome.observedModelCalls).toBe(0);
      expect(run.outcome.usage).toBeNull();
      // The app re-derived the trajectory digest over the public journal.
      expect(run.outcome.trajectoryDigest).not.toBeNull();
    }
  });

  test("the four honest classes read back their pinned classifications and full curve facts", async () => {
    const classRows = [
      "rag-retrieval-determinized-stable",
      "text-summarization-determinizing-trending",
      "order-settlement-variable-resilient",
      "support-triage-immature-insufficient-evidence",
    ];
    for (const rowId of classRows) {
      const row = rowById(rowId);
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed, `${rowId} passed`).toBe(true);
      // The classification read back IS the pinned honest class.
      expect(run.outcome.classification).toBe(row.claimedClassification);
      // The curve series read back: the row's full canonical series
      // (generation order, measured facts, recorded digests).
      expect(
        run.outcome.curveSeries.map((point) => point.generation),
        `${rowId} curve generations`,
      ).toEqual(row.curveSeries.map((point) => point.generation));
      expect(
        run.outcome.curveSeries.map((point) => point.displacedModelCalls),
        `${rowId} displaced calls`,
      ).toEqual(row.curveSeries.map((point) => point.displacedModelCalls));
      for (const point of run.outcome.curveSeries) {
        expect(point.pointSource).toBe("recorded");
        expect(point.measured).toBe(true);
        expect(point.generationDigest).toMatch(/^[0-9a-f]{8}$/);
      }
      // The honest classes are ESTABLISHED analyses: their maturity
      // reports landed.
      expect(run.outcome.reportRecorded).toBe(true);
      expect(appCriterionOf(run.outcome, "app-classification-read-back")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-classification-fidelity-re-derived")?.status).toBe(
        "PASS",
      );
      expect(appCriterionOf(run.outcome, "app-report-landing")?.status).toBe("PASS");
    }
  });

  test("the honest classes read back per-mechanism savings that reconcile at the boundary", async () => {
    for (const rowId of [
      "rag-retrieval-determinized-stable",
      "text-summarization-determinizing-trending",
      "order-settlement-variable-resilient",
      "support-triage-immature-insufficient-evidence",
    ]) {
      const row = rowById(rowId);
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      // The savings read back carry their per-mechanism breakdown and
      // match the claimed per-mechanism numbers exactly.
      expect(run.outcome.savings?.perMechanism).not.toBeNull();
      expect(run.outcome.savings?.totalMicroUsd).toBe(row.claimedSavings.totalMicroUsd);
      expect(run.outcome.savings?.perMechanism).toEqual(row.claimedSavings.perMechanism);
      // The boundary re-derivation of the reconciliation passes.
      for (const criterionId of [
        "app-savings-per-mechanism-breakdown-present",
        "app-savings-breakdown-matches-ledgers",
        "app-savings-breakdown-sums-to-total",
        "app-savings-total-matches-ledger",
        "app-savings-reconciliation-summary",
      ]) {
        expect(appCriterionOf(run.outcome, criterionId)?.status, `${rowId} ${criterionId}`).toBe(
          "PASS",
        );
      }
    }
  });

  test("the two honest refusals read back their pinned reasons and land NOTHING", async () => {
    for (const rowId of [
      "unrecorded-family-maturity-refusal",
      "no-generations-family-maturity-refusal",
    ]) {
      const row = rowById(rowId);
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed, `${rowId} passed`).toBe(true);
      // An honest immaturity is a COMPLETED run — never a fabricated
      // analysis — and nothing lands.
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
      expect(run.outcome.refusalReason).toBe(row.expected.refusalReason);
      expect(run.outcome.reportRecorded).toBe(false);
      expect(run.outcome.curveSeries).toHaveLength(0);
      expect(run.outcome.savings?.totalMicroUsd ?? 0).toBe(0);
      expect(appCriterionOf(run.outcome, "app-refusal-read-back")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-report-landing")?.status).toBe("PASS");
      // The refusal surfaces the honest immature classification, never a
      // stretched trend.
      expect(run.outcome.classification).toBe("immature-insufficient-evidence");
    }
  });

  test("the run identity is the VAL-036 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-determinized-stable"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-036");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(DETERMINIZATION_MATURITY_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
    expect(run.evidence.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("the app-side trajectory digest is deterministic over the public journal", async () => {
    const taskIndex = taskIndexOf("rag-retrieval-determinized-stable");
    const first = await runAppOverFakeWorld({ taskIndex });
    const second = await runAppOverFakeWorld({ taskIndex });
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    // The same row's public event journal re-derives the SAME digest
    // (the maturity trajectory is deterministic).
    expect(first.outcome.trajectoryDigest).not.toBeNull();
    expect(second.outcome.trajectoryDigest).toBe(first.outcome.trajectoryDigest);
    // The executed and the refusal shapes hold DISTINCT trajectories.
    const refusal = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("unrecorded-family-maturity-refusal"),
    });
    expect(refusal.outcome.trajectoryDigest).not.toBe(first.outcome.trajectoryDigest);
  });
});

// ---------------------------------------------------------------------------
// The fixture discriminations (each variant FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-036 app discriminations (the fake-history variants)", () => {
  test("a GAPPED series (generation 3 dropped from the recorded history) FAILs the curve + citation legs", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("probe-gapped-series"),
      historyVariant: "gapped",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    // The claimed gen-3 point cites a digest the recorded generations
    // no longer hold — NAMED by its generation ordinal.
    const unrecorded = criterionOf(result, "curve-points-cite-recorded-generations");
    expect(unrecorded?.status).toBe("FAIL");
    expect(unrecorded?.evidence.join(" ")).toContain("3");
    // The citation's gen-3 digest became a PHANTOM member — named.
    expect(criterionOf(result, "citation-no-phantom-members")?.status).toBe("FAIL");
    expect(result.citation?.phantomGenerationDigests).toHaveLength(1);
    // The untrustworthy shape never lands its report.
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("an UNMEASURED generation (measurements marked absent) FAILs the honesty + citation legs", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("rag-retrieval-determinized-stable"),
      historyVariant: "unmeasured",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    // The estimated generation is NAMED (an honest benchmark never
    // estimates).
    const estimated = criterionOf(result, "honesty-measured-never-estimated");
    expect(estimated?.status).toBe("FAIL");
    expect(estimated?.evidence.join(" ")).toContain("ESTIMATED-MEASUREMENT");
    expect(result.honesty?.estimatedGenerations).toEqual([4]);
    // The unmeasured record's digest changed — the citation now cites a
    // phantom digest and the point cites an unrecorded one.
    expect(criterionOf(result, "citation-no-phantom-members")?.status).toBe("FAIL");
    expect(criterionOf(result, "curve-points-cite-recorded-generations")?.status).toBe("FAIL");
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("an EXTRAPOLATED point FAILs the recorded-measurements-only leg (named by generation)", async () => {
    const honest = rowById("text-summarization-determinizing-trending");
    const extrapolated: MaturityCorpusRow = {
      ...honest,
      curveSeries: honest.curveSeries.map((point) =>
        point.generation === 4 ? { ...point, pointSource: "extrapolated" as const } : point,
      ),
    };
    const { result, reportLedger } = await driveRowOverStack({ row: extrapolated });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    const unrecordedPoint = criterionOf(result, "curve-recorded-measurements-only");
    expect(unrecordedPoint?.status).toBe("FAIL");
    expect(unrecordedPoint?.evidence.join(" ")).toContain("UNRECORDED-POINT");
    expect(result.curveIntegrity?.extrapolatedGenerations).toEqual([4]);
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("an UNRECONCILED ledger FAILs the savings legs (both sides named)", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("probe-unreconciled-savings"),
      historyVariant: "unreconciled",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    // The claimed per-mechanism numbers no longer match the recorded
    // ledger — with BOTH sides named (claimed vs recorded).
    const mismatched = criterionOf(result, "savings-breakdown-matches-ledgers");
    expect(mismatched?.status).toBe("FAIL");
    expect(mismatched?.evidence.join(" ")).toContain("UNRECONCILED-SAVINGS");
    expect(mismatched?.evidence.join(" ")).toContain("claimed=");
    expect(mismatched?.evidence.join(" ")).toContain("recorded=");
    expect(result.savingsReconciliation?.mismatchedMechanisms.length).toBeGreaterThan(0);
    expect(criterionOf(result, "savings-total-matches-ledger")?.status).toBe("FAIL");
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a MUTATING input (the recorded history rewrites itself) FAILs the read-only discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("rag-retrieval-determinized-stable"),
      historyVariant: "mutating",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    // The recorded history's facts digest CHANGED over the run — the
    // frozen input was rewritten. The driver FAILs the row mechanically
    // (the run is invalid — a rewritten input is never a passable
    // outcome), even though the analysis legs themselves were honest
    // over the pre-mutation snapshot.
    const readOnly = criterionOf(result, "maturity-input-read-only");
    expect(readOnly?.status).toBe("FAIL");
    expect(readOnly?.evidence.join(" ")).toContain("MUTATED-INPUT");
    expect(result.inputUnchanged).toBe(false);
    expect(
      criterionOf(result, "maturity-expected-verdict")?.status,
      "the mutated run never lands the pinned established verdict",
    ).toBe("FAIL");
  });

  test("an UNCITED claim (the probe's adversarial shape: a dropped lifecycle member) FAILs the full-population leg", async () => {
    const honest = rowById("probe-uncited-claim");
    const dropped = honest.citation.lifecycleProposalIds[0] ?? "";
    const uncited: MaturityCorpusRow = {
      ...honest,
      citation: {
        ...honest.citation,
        lifecycleProposalIds: honest.citation.lifecycleProposalIds.filter((id) => id !== dropped),
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: uncited });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("maturity-invalid");
    // The missed recorded member is NAMED (an uncited claim).
    const partial = criterionOf(result, "citation-full-population");
    expect(partial?.status).toBe("FAIL");
    expect(partial?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
    expect(result.citation?.uncitedLifecycleProposalIds).toEqual([dropped]);
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The maturity report ledger over the driver (append-only)
// ---------------------------------------------------------------------------

describe("VAL-036 the maturity report ledger is append-only", () => {
  test("the identical re-drive REPLAYS and an impostor report is REFUSED", async () => {
    const row = rowById("rag-retrieval-determinized-stable");
    const stack = createHonestMaturityStack();
    const first = await driveMaturityAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    expect(first.terminal).toBe("COMPLETED");
    expect(first.reportLanded).toEqual({ accepted: true, replayed: false });
    const second = await driveMaturityAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    // The identical re-append REPLAYS (idempotent — exactly-once).
    expect(second.terminal).toBe("COMPLETED");
    expect(second.reportLanded).toEqual({ accepted: true, replayed: true });
    expect(stack.reportLedger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(stack.reportLedger.appendLog().at(-1)?.replayed).toBe(true);
    // A DIFFERENT report under the same family is REFUSED.
    const recorded = stack.reportLedger.reportsFor("rag-retrieval")[0];
    if (recorded === undefined) {
      throw new Error("the honest run recorded no maturity report");
    }
    const impostor = await stack.reportLedger.append({
      familyId: recorded.familyId,
      classification: "variable-resilient",
      curvePointDigests: [...recorded.curvePointDigests],
      savings: recorded.savings,
      citationDigest: recorded.citationDigest,
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(stack.reportLedger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(stack.reportLedger.reportsFor("rag-retrieval")[0]?.classification).toBe(
      "determinized-stable",
    );
  });

  test("the recorded report carries the canonical facts (classification, curve digests, savings, citation digest)", async () => {
    const row = rowById("order-settlement-variable-resilient");
    const stack = createHonestMaturityStack();
    const result = await driveMaturityAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    expect(result.terminal).toBe("COMPLETED");
    const report = stack.reportLedger.reportsFor("order-settlement")[0];
    if (report === undefined) {
      throw new Error("the variable row recorded no maturity report");
    }
    expect(report.classification).toBe("variable-resilient");
    expect(report.ordinal).toBe(1);
    expect(report.citationDigest).toBe(maturityCitationDigestOf(row.citation));
    expect(report.curvePointDigests).toHaveLength(row.curveSeries.length);
    expect(report.savings).toEqual(row.claimedSavings);
  });
});

// ---------------------------------------------------------------------------
// The fake-world boundary knobs (the app contract catches every knob)
// ---------------------------------------------------------------------------

describe("VAL-036 app discriminations (the fake-world boundary knobs)", () => {
  test("the honest world passes the boundary contract for the stable row (the control)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-determinized-stable"),
    });
    expect(run.passed).toBe(true);
    expect(run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
    expect(run.outcome.observedTerminal).toBe("COMPLETED");
    expect(run.outcome.classification).toBe("determinized-stable");
    expect(run.outcome.reportRecorded).toBe(true);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    // The uncited knob surfaces the citation digests the boundary
    // observation does not carry — that family is caught by the
    // DRIVER-level citation oracle (the fake-history variant suite
    // above); every other knob is caught AT the boundary.
    const knobToCriterion: readonly { readonly knob: WorldKnobs; readonly criterionId: string }[] =
      [
        { knob: { gapped: true }, criterionId: "app-curve-series-gapless" },
        { knob: { extrapolated: true }, criterionId: "app-curve-recorded-measurements-only" },
        { knob: { misclassified: true }, criterionId: "app-classification-read-back" },
        {
          knob: { aggregatesavings: true },
          criterionId: "app-savings-per-mechanism-breakdown-present",
        },
        { knob: { unreconciled: true }, criterionId: "app-savings-total-matches-ledger" },
        { knob: { unreported: true }, criterionId: "app-report-landing" },
      ];
    const taskIndex = taskIndexOf("rag-retrieval-determinized-stable");
    for (const { knob, criterionId } of knobToCriterion) {
      const run = await runAppOverFakeWorld({ taskIndex, knobs: knob });
      expect(run.passed, criterionId).toBe(false);
      const criterion = run.outcome.appCriteria.find((c) => c.criterionId === criterionId);
      expect(criterion, criterionId).toBeDefined();
      expect(criterion?.status, criterionId).toBe("FAIL");
    }
    // A terminal override FAILs the harness's own outcome assertion
    // (the honest terminal is the run's contract — never smoothed).
    const failed = await runAppOverFakeWorld({ taskIndex, knobs: { terminal: "FAILED" } });
    expect(failed.passed).toBe(false);
    expect(failed.outcome.observedTerminal).toBe("FAILED");
    const terminalAssertion = failed.evidence.assertions.find(
      (assertion) => assertion.name === "terminal-status",
    );
    expect(terminalAssertion?.passed).toBe(false);
    // The gapped knob NAMES the missing generation in the evidence.
    const gapped = await runAppOverFakeWorld({ taskIndex, knobs: { gapped: true } });
    expect(
      gapped.outcome.appCriteria
        .find((c) => c.criterionId === "app-curve-series-gapless")
        ?.evidence.join(" "),
    ).toContain("GAPPED-SERIES");
    // The extrapolated knob NAMES the extrapolated generation.
    const extrapolated = await runAppOverFakeWorld({ taskIndex, knobs: { extrapolated: true } });
    expect(
      extrapolated.outcome.appCriteria
        .find((c) => c.criterionId === "app-curve-recorded-measurements-only")
        ?.evidence.join(" "),
    ).toContain("UNRECORDED-POINT");
  });
});
