/**
 * VAL-045 acceptance criteria 1 + 2: the savings-attribution customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission phase — one OWN durable
 * execution per row under its OWN idempotency key; the observation
 * phase — the completion poll observing the honest terminal, the result
 * retrieval surfacing the verification statuses, the route's
 * model-call count (zero offline — the offline analysis is
 * digest-level), the honest none-reported offline usage, the
 * per-mechanism attributed totals read back, the residual read back,
 * the per-generation splits read back, the report-recorded flag, the
 * refusal reason read back, and the events read re-deriving the
 * attribution trajectory digest over the public journal; the assertion
 * phase — the PURE per-row attribution contract re-derived AT the
 * boundary), and its pinned task slice matches the repository
 * configuration file and the corpus.
 *
 * Discrimination: the FAKE-ECONOMICS variants (GAPPED /
 * SWAPPED-BASELINE / UNRECONCILED / MUTATING) and the row-level
 * adversarial variants (an UNCITED claim; a DOUBLE-COUNT; a FORCED
 * RESIDUAL; a SWAPPED baseline; a GAPPED series) each FAIL a specific
 * mechanical criterion of `deriveAttributionRowCriteria` (named, with
 * the offending member or both sides named), the attribution report
 * ledger is APPEND-ONLY (the identical re-drive REPLAYS; an impostor
 * report is REFUSED), and every fake-world boundary knob FAILs a
 * specific boundary criterion — while the honest stack passes every
 * offline row with the honest oracle's verdicts, the five honest split
 * shapes read back their pinned per-mechanism splits + honest
 * residuals + per-generation identities, and the two honest refusals
 * read back their pinned reasons and land nothing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runSavingsAttributionApp,
  SAVINGS_ATTRIBUTION_TASKS,
} from "../../../benchmarks/validation/apps/savings-attribution/application";
import {
  attributionRowById,
  attributionSubmissionKey,
  attributionTaskBodyFor,
  declaredSplitTotalsOf,
  FAMILY_ECONOMICS,
  familyEconomicsById,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PHANTOM_FAMILY_ID,
  SAVINGS_ATTRIBUTION_CORPUS,
  SAVINGS_ATTRIBUTION_ROW_IDS,
  SAVINGS_ATTRIBUTION_TASK_KIND,
} from "../../../benchmarks/validation/apps/savings-attribution/corpus";
import {
  createAttributionFakeApiWorld,
  createAttributionHistoryPort,
  createAttributionReportLedger,
  createHonestAttributionStack,
  createTickClock,
  type FakeEconomicsVariant,
} from "../../../benchmarks/validation/apps/savings-attribution/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type {
  AttributionCorpusRow,
  AttributionRunResult,
} from "../../../benchmarks/validation/platform/savings-attribution";
import {
  attributionCitationDigestOf,
  canonicalAttributionCitationOf,
  driveAttributionAnalysis,
  incumbentBaselineDigestOf,
} from "../../../benchmarks/validation/platform/savings-attribution";

const REVISION = "7d42e5700000000000000000000000000000000aa";

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
  readonly attributedsplit?: boolean;
  readonly foldedresidual?: boolean;
  readonly gapped?: boolean;
  readonly inflatedtotal?: boolean;
  readonly unreported?: boolean;
}

/** Run one app row over the fake API world (the boundary discrimination knobs). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly knobs?: WorldKnobs;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runSavingsAttributionApp>>;
  readonly createdExecutions: number;
}> {
  const knobs = options.knobs ?? {};
  const clock = createTickClock();
  const world = createAttributionFakeApiWorld({
    clock,
    ...(knobs.terminal === undefined ? {} : { terminal: knobs.terminal }),
    ...(knobs.attributedsplit === true ? { attributedsplit: true } : {}),
    ...(knobs.foldedresidual === true ? { foldedresidual: true } : {}),
    ...(knobs.gapped === true ? { gapped: true } : {}),
    ...(knobs.inflatedtotal === true ? { inflatedtotal: true } : {}),
    ...(knobs.unreported === true ? { unreported: true } : {}),
  });
  const outcome = await runSavingsAttributionApp({
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
      configuration: { suite: "val-045-apps" },
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
 * Drive one offline row over a purpose-built fake stack (the seams
 * under test — the economics-port variant or an adversarial row
 * variant).
 */
async function driveRowOverStack(options: {
  readonly row: AttributionCorpusRow;
  readonly historyVariant?: FakeEconomicsVariant;
}): Promise<{
  readonly result: AttributionRunResult;
  readonly reportLedger: ReturnType<typeof createAttributionReportLedger>;
}> {
  const clock = createTickClock();
  const history = createAttributionHistoryPort(options.historyVariant);
  const reportLedger = createAttributionReportLedger();
  const result = await driveAttributionAnalysis({
    row: options.row,
    analysis: history,
    reportLedger,
    now: clock.now,
  });
  return { result, reportLedger };
}

/** The ABSOLUTE corpus index of one row (the app selects by the full-corpus index). */
function taskIndexOf(rowId: string): number {
  const index = SAVINGS_ATTRIBUTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): AttributionCorpusRow => {
  const row = attributionRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (result: AttributionRunResult, criterionId: string) =>
  result.criteria.find((criterion) => criterion.criterionId === criterionId);

const appCriterionOf = (
  outcome: Awaited<ReturnType<typeof runSavingsAttributionApp>>,
  criterionId: string,
) => outcome.appCriteria.find((criterion) => criterion.criterionId === criterionId);

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-045 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(SAVINGS_ATTRIBUTION_TASKS.length).toBe(SAVINGS_ATTRIBUTION_CORPUS.length);
    for (const [index, task] of SAVINGS_ATTRIBUTION_TASKS.entries()) {
      const row = SAVINGS_ATTRIBUTION_CORPUS[index];
      if (row === undefined) {
        throw new Error(`the corpus index ${index} holds no row`);
      }
      const declared = declaredSplitTotalsOf(row);
      expect(task?.rowId).toBe(row?.rowId);
      expect(task?.kind).toBe(SAVINGS_ATTRIBUTION_TASK_KIND);
      expect(task?.familyId).toBe(row?.familyId);
      expect(task?.claims).toBe(row?.split.claims.length);
      expect(task?.residualClaims).toBe(row?.split.residual.length);
      expect(task?.attributedReuseMicroUsd).toBe(declared.attributed.reuse);
      expect(task?.attributedCacheMicroUsd).toBe(declared.attributed.cache);
      expect(task?.attributedCompetenceMicroUsd).toBe(declared.attributed.competence);
      expect(task?.attributedDeterministicizationMicroUsd).toBe(
        declared.attributed.deterministicization,
      );
      expect(task?.attributedTotalMicroUsd).toBe(declared.attributedTotalMicroUsd);
      expect(task?.residualMicroUsd).toBe(declared.residualMicroUsd);
      expect(task?.expectedVerdict).toBe(row?.expected.verdict);
      expect(task?.expectedRefusalReason).toBe(row?.expected.refusalReason);
      expect(task?.expectedTerminal).toBe(row?.expected.terminal);
      expect(task?.expectedModelCalls).toBe(row?.expected.modelCalls);
      expect(task?.probe ?? null).toBe(row?.probe?.kind ?? null);
      expect(task?.liveGate ?? null).toEqual(row?.liveGate?.envVars ?? null);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/savings-attribution/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(SAVINGS_ATTRIBUTION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = SAVINGS_ATTRIBUTION_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.familyId).toBe(exported?.familyId);
      expect(task.claims).toBe(exported?.claims);
      expect(task.residualClaims).toBe(exported?.residualClaims);
      expect(task.attributedReuseMicroUsd).toBe(exported?.attributedReuseMicroUsd);
      expect(task.attributedCacheMicroUsd).toBe(exported?.attributedCacheMicroUsd);
      expect(task.attributedCompetenceMicroUsd).toBe(exported?.attributedCompetenceMicroUsd);
      expect(task.attributedDeterministicizationMicroUsd).toBe(
        exported?.attributedDeterministicizationMicroUsd,
      );
      expect(task.attributedTotalMicroUsd).toBe(exported?.attributedTotalMicroUsd);
      expect(task.residualMicroUsd).toBe(exported?.residualMicroUsd);
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

  test("the corpus is well-formed (unique ids, canonical splits over recorded families, recorded-evidence citations, live gating)", () => {
    const rowIds = SAVINGS_ATTRIBUTION_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(SAVINGS_ATTRIBUTION_ROW_IDS).toEqual(rowIds);
    expect(attributionRowById("rag-retrieval-all-mechanisms-attributed")?.rowId).toBe(
      "rag-retrieval-all-mechanisms-attributed",
    );
    expect(attributionRowById("nonexistent")).toBeNull();

    for (const row of SAVINGS_ATTRIBUTION_CORPUS) {
      const economics = familyEconomicsById(row.familyId);
      if (economics === null) {
        // The phantom family: nothing recorded, nothing claimed, the
        // honest family-unrecorded refusal.
        expect(row.familyId).toBe(PHANTOM_FAMILY_ID);
        expect(row.split.claims).toHaveLength(0);
        expect(row.split.residual).toHaveLength(0);
        expect(row.expected.verdict).toBe("no-evidence-honest");
        expect(row.expected.refusalReason).toBe("family-unrecorded");
        continue;
      }
      // Every claim cites a RECORDED ledger entry (its own measured
      // savings), the generation's recorded lifecycle records of the
      // same mechanism, and its RECORDED incumbent baseline digest.
      for (const claim of row.split.claims) {
        const entry = economics.ledgerEntries.find(
          (candidate) => candidate.entryId === claim.citedLedgerEntryIds[0],
        );
        expect(entry, `${row.rowId} claim cites its entry`).toBeDefined();
        expect(claim.claimedMicroUsd, `${row.rowId} claim carries the entry's number`).toBe(
          entry?.microUsd,
        );
        const baseline = economics.baselines.find(
          (candidate) =>
            candidate.generation === claim.generation && candidate.mechanism === claim.mechanism,
        );
        expect(baseline, `${row.rowId} recorded baseline`).toBeDefined();
        expect(claim.baselineDigest, `${row.rowId} claim cites its baseline digest`).toBe(
          baseline === undefined ? "" : incumbentBaselineDigestOf(baseline),
        );
        expect(claim.baselineBasis).toBe("recorded");
        for (const proposalId of claim.citedLifecycleProposalIds) {
          expect(
            economics.lifecycleRecords.some((record) => record.proposalId === proposalId),
            `${row.rowId} lifecycle citation ${proposalId}`,
          ).toBe(true);
        }
      }
      // The residual claims cover every recorded generation and equal
      // the recorded total minus the attributed sum (the identity).
      for (const total of economics.recordedTotals) {
        const residualClaim = row.split.residual.find(
          (claim) => claim.generation === total.generation,
        );
        expect(residualClaim, `${row.rowId} residual for g${total.generation}`).toBeDefined();
        const attributed = economics.ledgerEntries
          .filter((entry) => entry.generation === total.generation)
          .reduce((sum, entry) => sum + entry.microUsd, 0);
        expect(residualClaim?.residualMicroUsd).toBe(total.totalMicroUsd - attributed);
        expect(residualClaim?.reported).toBe(true);
      }
      // The honest oracle: a recorded family with savings is
      // established; the savings-less family refuses honestly.
      if (
        economics.generations.length > 0 &&
        economics.ledgerEntries.length === 0 &&
        economics.recordedTotals.length === 0
      ) {
        expect(row.expected.verdict).toBe("no-evidence-honest");
        expect(row.expected.refusalReason).toBe("no-savings-recorded");
        expect(row.split.claims).toHaveLength(0);
      } else {
        expect(row.expected.verdict).toBe("attribution-established");
        expect(row.expected.refusalReason).toBeNull();
      }
      expect(row.expected.terminal).toBe("COMPLETED");
    }
    // Offline rows never dispatch; the live row exactly one REAL round.
    const liveRows = SAVINGS_ATTRIBUTION_CORPUS.filter((row) => row.liveGate !== undefined);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]?.expected.modelCalls).toBe(1);
    expect(liveRows[0]?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.needsDispatch ?? false).toBe(false);
      expect(row.expected.modelCalls).toBe(0);
    }
  });

  test("the pinned membership: five honest split shapes + five probes + two honest refusals + one live row", () => {
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(12);
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    // Every probe vocabulary member is declared by exactly one row.
    const probeKinds = SAVINGS_ATTRIBUTION_CORPUS.flatMap((row) =>
      row.probe === undefined ? [] : [row.probe.kind],
    );
    expect(new Set(probeKinds).size).toBe(probeKinds.length);
    expect([...probeKinds].sort()).toEqual([
      "double-count",
      "forced-residual",
      "gapped-series",
      "swapped-baseline",
      "uncited-claim",
    ]);
    // The verdict distribution: 10 established (5 split shapes + 5
    // probes — the probe rows are HONEST over their families) + 2
    // honest refusals offline, + 1 live established row.
    const established = SAVINGS_ATTRIBUTION_CORPUS.filter(
      (row) => row.expected.verdict === "attribution-established",
    ).length;
    const refusals = SAVINGS_ATTRIBUTION_CORPUS.filter(
      (row) => row.expected.verdict === "no-evidence-honest",
    );
    expect(established).toBe(11);
    expect(refusals.map((row) => row.expected.refusalReason).sort()).toEqual([
      "family-unrecorded",
      "no-savings-recorded",
    ]);
    // The pinned family economics: six recorded families (five with
    // savings + the savings-less tool-routing family).
    expect(FAMILY_ECONOMICS).toHaveLength(6);
  });

  test("the pinned split numbers (the honest oracle's arithmetic)", () => {
    // rag: all four mechanisms + an honest residual per generation.
    const rag = declaredSplitTotalsOf(rowById("rag-retrieval-all-mechanisms-attributed"));
    expect(rag.attributed).toEqual({
      reuse: 80,
      cache: 100,
      competence: 60,
      deterministicization: 160,
    });
    expect(rag.attributedTotalMicroUsd).toBe(400);
    expect(rag.residualMicroUsd).toBe(95);
    // text-summarization: the LARGE honest residual (320 of 410).
    const text = declaredSplitTotalsOf(rowById("text-summarization-large-honest-residual"));
    expect(text.attributedTotalMicroUsd).toBe(90);
    expect(text.residualMicroUsd).toBe(320);
    // code-search: cache-dominant (330 of 350 attributed).
    const code = declaredSplitTotalsOf(rowById("code-search-cache-dominant"));
    expect(code.attributed.cache).toBe(330);
    expect(code.attributed.deterministicization).toBe(20);
    expect(code.residualMicroUsd).toBe(25);
    // invoice-extraction: reuse-dominant (280 of 295 attributed).
    const invoice = declaredSplitTotalsOf(rowById("invoice-extraction-reuse-dominant"));
    expect(invoice.attributed.reuse).toBe(280);
    expect(invoice.attributed.competence).toBe(15);
    expect(invoice.residualMicroUsd).toBe(30);
    // translation-glossary: deterministicization-dominant (315 of 350).
    const translation = declaredSplitTotalsOf(
      rowById("translation-glossary-deterministicization-dominant"),
    );
    expect(translation.attributed.deterministicization).toBe(315);
    expect(translation.residualMicroUsd).toBe(35);
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(attributionSubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe(
      "val-045-savings-attribution-3-unit",
    );
    const keys = [0, 1, 2].map((taskIndex) =>
      attributionSubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = attributionTaskBodyFor({
      rowId: "rag-retrieval-all-mechanisms-attributed",
      familyId: "rag-retrieval",
    });
    expect(body).toEqual({
      kind: SAVINGS_ATTRIBUTION_TASK_KIND,
      rowId: "rag-retrieval-all-mechanisms-attributed",
      familyId: "rag-retrieval",
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the corpus holds no live row");
    }
    expect(liveRow.rowId).toBe("rag-retrieval-attribution-live");
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

describe("VAL-045 app over the honest fake world", () => {
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
      // The attribution submission landed its OWN durable execution (one
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

  test("the five honest split shapes read back their pinned attributed splits, residuals and claimed totals", async () => {
    for (const rowId of [
      "rag-retrieval-all-mechanisms-attributed",
      "text-summarization-large-honest-residual",
      "code-search-cache-dominant",
      "invoice-extraction-reuse-dominant",
      "translation-glossary-deterministicization-dominant",
    ]) {
      const row = rowById(rowId);
      const declared = declaredSplitTotalsOf(row);
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed, `${rowId} passed`).toBe(true);
      // The per-mechanism attributed totals read back match the
      // declared split exactly (the honest oracle's arithmetic).
      expect(run.outcome.attributed).toEqual(declared.attributed);
      // The honest residual read back (reported, never folded).
      expect(run.outcome.residualMicroUsd).toBe(declared.residualMicroUsd);
      // The claimed total = attributed + residual.
      expect(run.outcome.claimedTotalMicroUsd).toBe(
        declared.attributedTotalMicroUsd + declared.residualMicroUsd,
      );
      // The per-generation series read back matches the declared series.
      const economics = familyEconomicsById(row.familyId);
      expect(
        run.outcome.perGeneration.map((split) => split.generation),
        `${rowId} generation series`,
      ).toEqual(economics?.recordedTotals.map((total) => total.generation));
      // The honest split shapes are ESTABLISHED attributions: their
      // reports landed.
      expect(run.outcome.reportRecorded).toBe(true);
      expect(appCriterionOf(run.outcome, "app-attributed-split-read-back")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-residual-read-back")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-report-landing")?.status).toBe("PASS");
    }
  });

  test("the split shapes reconcile at the boundary (attributed + residual = recorded total per generation)", async () => {
    for (const rowId of [
      "rag-retrieval-all-mechanisms-attributed",
      "text-summarization-large-honest-residual",
      "code-search-cache-dominant",
      "invoice-extraction-reuse-dominant",
      "translation-glossary-deterministicization-dominant",
    ]) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      for (const criterionId of [
        "app-attribution-reconciliation-identity-per-generation",
        "app-attribution-reconciliation-identity-family-total",
        "app-attribution-reconciliation-recorded-basis",
        "app-attribution-reconciliation-summary",
        "app-generation-series-read-back",
      ]) {
        expect(appCriterionOf(run.outcome, criterionId)?.status, `${rowId} ${criterionId}`).toBe(
          "PASS",
        );
      }
      // The per-generation identity holds mechanically over the
      // read-back numbers (never trusting the platform's claim).
      for (const split of run.outcome.perGeneration) {
        const attributed = Object.values(split.perMechanism).reduce(
          (total, value) => total + value,
          0,
        );
        expect(attributed + split.residualMicroUsd, `${rowId} g${split.generation} identity`).toBe(
          split.recordedTotalMicroUsd,
        );
      }
    }
  });

  test("the two honest refusals read back their pinned reasons and land NOTHING", async () => {
    for (const rowId of [
      "unrecorded-family-attribution-refusal",
      "no-savings-family-attribution-refusal",
    ]) {
      const row = rowById(rowId);
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed, `${rowId} passed`).toBe(true);
      // An honest no-evidence refusal is a COMPLETED run — never a
      // fabricated split — and nothing lands.
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
      expect(run.outcome.refusalReason).toBe(row.expected.refusalReason);
      expect(run.outcome.reportRecorded).toBe(false);
      expect(run.outcome.attributed).toEqual({
        reuse: 0,
        cache: 0,
        competence: 0,
        deterministicization: 0,
      });
      expect(run.outcome.residualMicroUsd).toBe(0);
      expect(run.outcome.perGeneration).toHaveLength(0);
      expect(appCriterionOf(run.outcome, "app-refusal-read-back")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-report-landing")?.status).toBe("PASS");
    }
  });

  test("the run identity is the VAL-045 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-all-mechanisms-attributed"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-045");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(SAVINGS_ATTRIBUTION_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
    expect(run.evidence.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("the app-side trajectory digest is deterministic over the public journal", async () => {
    const taskIndex = taskIndexOf("rag-retrieval-all-mechanisms-attributed");
    const first = await runAppOverFakeWorld({ taskIndex });
    const second = await runAppOverFakeWorld({ taskIndex });
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    // The same row's public event journal re-derives the SAME digest
    // (the attribution trajectory is deterministic).
    expect(first.outcome.trajectoryDigest).not.toBeNull();
    expect(second.outcome.trajectoryDigest).toBe(first.outcome.trajectoryDigest);
    // The executed and the refusal shapes hold DISTINCT trajectories.
    const refusal = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("unrecorded-family-attribution-refusal"),
    });
    expect(refusal.outcome.trajectoryDigest).not.toBe(first.outcome.trajectoryDigest);
  });
});

// ---------------------------------------------------------------------------
// The fixture discriminations (each variant FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-045 app discriminations (the fake-economics variants)", () => {
  test("a GAPPED maturity history (generation 2 dropped from the served curves) FAILs the series leg", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("translation-glossary-deterministicization-dominant"),
      historyVariant: "gapped",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The attribution's generation series now cites a generation the
    // served maturity curves DO NOT hold — NAMED by its ordinal.
    const mismatched = criterionOf(result, "attribution-series-no-fabricated-generations");
    expect(mismatched?.status).toBe("FAIL");
    expect(mismatched?.evidence.join(" ")).toContain("MISMATCHED-SERIES");
    expect(result.generationSeries?.unrecordedGenerations).toEqual([2]);
    // The untrustworthy shape never lands its report.
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a SWAPPED-BASELINE history (another generation's baseline served) FAILs the counterfactual leg", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("invoice-extraction-reuse-dominant"),
      historyVariant: "swappedbaseline",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The g2 reuse claim's own cited baseline digest is GONE from the
    // served population — a counterfactual that was never recorded
    // where it should be — and the number no longer matches the served
    // baseline's own counterfactual.
    const hypothetical = criterionOf(result, "attribution-baseline-recorded");
    expect(hypothetical?.status).toBe("FAIL");
    expect(hypothetical?.evidence.join(" ")).toContain("HYPOTHETICAL-BASELINE");
    expect(result.counterfactual?.infidelities.length).toBeGreaterThan(0);
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("an UNRECONCILED history (the recorded totals doubled) FAILs the reconciliation legs (both sides named)", async () => {
    const { result, reportLedger } = await driveRowOverStack({
      row: rowById("rag-retrieval-all-mechanisms-attributed"),
      historyVariant: "unreconciled",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The identity per generation FAILs with BOTH sides named (the
    // claimed side vs the recorded side).
    const identity = criterionOf(result, "attribution-reconciliation-identity-per-generation");
    expect(identity?.status).toBe("FAIL");
    expect(identity?.evidence.join(" ")).toContain("NON-RECONCILING-ATTRIBUTION");
    expect(identity?.evidence.join(" ")).toContain("attributed+residual=");
    expect(identity?.evidence.join(" ")).toContain("recorded=");
    expect(criterionOf(result, "attribution-reconciliation-identity-family-total")?.status).toBe(
      "FAIL",
    );
    // The reported residual no longer matches the recorded basis — both
    // sides named.
    const residualMatches = criterionOf(result, "attribution-residual-matches-recorded");
    expect(residualMatches?.status).toBe("FAIL");
    expect(residualMatches?.evidence.join(" ")).toContain("RESIDUAL-MISMATCH");
    expect(result.residualHonesty?.mismatchedResidualGenerations.length).toBeGreaterThan(0);
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a MUTATING history (the recorded history rewrites itself) FAILs the read-only discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("rag-retrieval-all-mechanisms-attributed"),
      historyVariant: "mutating",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The recorded economics + history's facts digest CHANGED over the
    // run — the frozen input was rewritten. The driver FAILs the row
    // mechanically (a rewritten input is never a passable outcome).
    const readOnly = criterionOf(result, "attribution-input-read-only");
    expect(readOnly?.status).toBe("FAIL");
    expect(readOnly?.evidence.join(" ")).toContain("MUTATED-INPUT");
    expect(result.inputUnchanged).toBe(false);
    expect(
      criterionOf(result, "attribution-expected-verdict")?.status,
      "the mutated run never lands the pinned established verdict",
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The row-level adversarial variants (the probe splits FAIL mechanically)
// ---------------------------------------------------------------------------

describe("VAL-045 app discriminations (the adversarial claim variants)", () => {
  test("an UNCITED claim (its citations dropped) FAILs the citation legs naming the claim", async () => {
    const honest = rowById("probe-uncited-claim");
    const target = honest.split.claims[0];
    if (target === undefined) {
      throw new Error("the uncited probe holds no claims");
    }
    const uncited: AttributionCorpusRow = {
      ...honest,
      split: {
        ...honest.split,
        claims: honest.split.claims.map((claim) =>
          claim === target
            ? { ...claim, citedLedgerEntryIds: [], citedLifecycleProposalIds: [] }
            : claim,
        ),
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: uncited });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The nonzero claim now cites NOTHING — NAMED by mechanism+generation.
    const uncitedLeg = criterionOf(result, "attribution-citation-claims-cite-evidence");
    expect(uncitedLeg?.status).toBe("FAIL");
    expect(uncitedLeg?.evidence.join(" ")).toContain("UNCITED-CLAIM");
    expect(uncitedLeg?.evidence.join(" ")).toContain(`uncitedClaims:${target.mechanism}@g`);
    // The dropped entry + lifecycle members are PARTIAL population.
    expect(criterionOf(result, "attribution-citation-full-population")?.status).toBe("FAIL");
    expect(result.citation?.uncitedLedgerEntryIds).toContain(target.citedLedgerEntryIds[0]);
    // The claim's number now exceeds its (empty) evidence — a forced
    // residual too.
    expect(criterionOf(result, "attribution-residual-never-forced")?.status).toBe("FAIL");
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a DOUBLE-COUNT (one entry cited by two claims) FAILs with BOTH claims named", async () => {
    const honest = rowById("probe-double-count");
    const victim = honest.split.claims[0];
    if (victim === undefined) {
      throw new Error("the double-count probe holds no claims");
    }
    const doubleCounted: AttributionCorpusRow = {
      ...honest,
      split: {
        ...honest.split,
        claims: [
          ...honest.split.claims,
          {
            mechanism: "reuse",
            generation: victim.generation,
            claimedMicroUsd: victim.claimedMicroUsd,
            citedLedgerEntryIds: [...victim.citedLedgerEntryIds],
            citedLifecycleProposalIds: [],
            baselineDigest: victim.baselineDigest,
            baselineBasis: "recorded" as const,
          },
        ],
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: doubleCounted });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The same ledger entry attributed to TWO mechanisms — BOTH claims
    // named (cache + reuse — the savings counted twice).
    const noDouble = criterionOf(result, "attribution-no-double-count");
    expect(noDouble?.status).toBe("FAIL");
    expect(noDouble?.evidence.join(" ")).toContain("DOUBLE-COUNT");
    expect(noDouble?.evidence.join(" ")).toContain(`${victim.citedLedgerEntryIds[0]}(cache+reuse)`);
    expect(result.noDoubleCount?.doubleCountedEntries).toHaveLength(1);
    expect(result.noDoubleCount?.doubleCountedEntries[0]?.firstMechanism).toBe("cache");
    expect(result.noDoubleCount?.doubleCountedEntries[0]?.secondMechanism).toBe("reuse");
    // The doubled attribution also breaks the reconciliation identity.
    expect(criterionOf(result, "attribution-reconciliation-identity-per-generation")?.status).toBe(
      "FAIL",
    );
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a FORCED RESIDUAL (the residual claimed as a mechanism) FAILs with the mechanism + excess named", async () => {
    const honest = rowById("probe-forced-residual");
    const forced: AttributionCorpusRow = {
      ...honest,
      split: {
        ...honest.split,
        claims: honest.split.claims.map((claim) =>
          claim.generation === 1
            ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd + 160 }
            : claim,
        ),
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: forced });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The claim EXCEEDS its cited evidence — the unattributed residual
    // forced into a mechanism — with BOTH sides named.
    const neverForced = criterionOf(result, "attribution-residual-never-forced");
    expect(neverForced?.status).toBe("FAIL");
    expect(neverForced?.evidence.join(" ")).toContain("FORCED-RESIDUAL");
    expect(neverForced?.evidence.join(" ")).toContain("claimed=200,evidence=40");
    expect(result.residualHonesty?.forcedResiduals[0]?.mechanism).toBe("cache");
    expect(result.residualHonesty?.forcedResiduals[0]?.citedEvidenceMicroUsd).toBe(40);
    // The inflated split no longer reconciles against the recorded total.
    expect(criterionOf(result, "attribution-reconciliation-identity-per-generation")?.status).toBe(
      "FAIL",
    );
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a SWAPPED baseline (the claim citing another generation's baseline) FAILs with both digests named", async () => {
    const honest = rowById("probe-swapped-baseline");
    const economics = familyEconomicsById(honest.familyId);
    const generation3Reuse = economics?.baselines.find(
      (baseline) => baseline.generation === 3 && baseline.mechanism === "reuse",
    );
    if (generation3Reuse === undefined) {
      throw new Error("the invoice family holds no g3 reuse baseline");
    }
    const swapped: AttributionCorpusRow = {
      ...honest,
      split: {
        ...honest.split,
        claims: honest.split.claims.map((claim) =>
          claim.generation === 1 && claim.mechanism === "reuse"
            ? { ...claim, baselineDigest: incumbentBaselineDigestOf(generation3Reuse) }
            : claim,
        ),
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: swapped });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The claim cites ANOTHER generation's recorded baseline — a
    // favorable counterfactual — with BOTH sides named (cited vs recorded).
    const notSwapped = criterionOf(result, "attribution-baseline-not-swapped");
    expect(notSwapped?.status).toBe("FAIL");
    expect(notSwapped?.evidence.join(" ")).toContain("SWAPPED-BASELINE");
    expect(notSwapped?.evidence.join(" ")).toContain(
      `cited=${incumbentBaselineDigestOf(generation3Reuse)}`,
    );
    expect(result.counterfactual?.infidelities[0]?.shape).toBe("swapped");
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });

  test("a GAPPED series (a generation's claims dropped) FAILs the series leg naming the generation", async () => {
    const honest = rowById("probe-gapped-series");
    const gapped: AttributionCorpusRow = {
      ...honest,
      split: {
        ...honest.split,
        claims: honest.split.claims.filter((claim) => claim.generation !== 2),
      },
    };
    const { result, reportLedger } = await driveRowOverStack({ row: gapped });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("attribution-invalid");
    // The attribution silently skipped generation 2 — NAMED by ordinal.
    const matches = criterionOf(result, "attribution-series-matches-maturity");
    expect(matches?.status).toBe("FAIL");
    expect(matches?.evidence.join(" ")).toContain("GAPPED-SERIES");
    expect(result.generationSeries?.missingGenerations).toEqual([2]);
    // The dropped generation's evidence became a partial population.
    expect(criterionOf(result, "attribution-citation-full-population")?.status).toBe("FAIL");
    expect(result.reportsAppended).toBe(0);
    expect(reportLedger.appendLog()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The attribution report ledger over the driver (append-only)
// ---------------------------------------------------------------------------

describe("VAL-045 the attribution report ledger is append-only", () => {
  test("the identical re-drive REPLAYS and an impostor report is REFUSED", async () => {
    const row = rowById("rag-retrieval-all-mechanisms-attributed");
    const stack = createHonestAttributionStack();
    const first = await driveAttributionAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    expect(first.terminal).toBe("COMPLETED");
    expect(first.reportLanded).toEqual({ accepted: true, replayed: false });
    const second = await driveAttributionAnalysis({
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
      throw new Error("the honest run recorded no attribution report");
    }
    const impostor = await stack.reportLedger.append({
      familyId: recorded.familyId,
      attributed: { ...recorded.attributed, cache: recorded.attributed.cache + 1 },
      residualMicroUsd: recorded.residualMicroUsd,
      claimedTotalMicroUsd: recorded.claimedTotalMicroUsd,
      claimDigests: [...recorded.claimDigests],
      residualDigests: [...recorded.residualDigests],
      citationDigest: recorded.citationDigest,
      maturityReportDigest: recorded.maturityReportDigest,
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(stack.reportLedger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(stack.reportLedger.reportsFor("rag-retrieval")[0]?.residualMicroUsd).toBe(95);
  });

  test("the recorded report carries the canonical facts (split, residual, claimed total, digests)", async () => {
    const row = rowById("code-search-cache-dominant");
    const economics = familyEconomicsById(row.familyId);
    if (economics === null) {
      throw new Error("the code-search family is unrecorded");
    }
    const declared = declaredSplitTotalsOf(row);
    const stack = createHonestAttributionStack();
    const result = await driveAttributionAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    expect(result.terminal).toBe("COMPLETED");
    const report = stack.reportLedger.reportsFor("code-search")[0];
    if (report === undefined) {
      throw new Error("the cache-dominant row recorded no attribution report");
    }
    expect(report.attributed).toEqual(declared.attributed);
    expect(report.residualMicroUsd).toBe(declared.residualMicroUsd);
    expect(report.claimedTotalMicroUsd).toBe(
      declared.attributedTotalMicroUsd + declared.residualMicroUsd,
    );
    expect(report.ordinal).toBe(1);
    // The citation digest is the FULL recorded population's fingerprint
    // (every ledger entry, lifecycle record, baseline and total).
    expect(report.citationDigest).toBe(
      attributionCitationDigestOf(
        canonicalAttributionCitationOf({
          ledgerEntries: economics.ledgerEntries,
          lifecycleRecords: economics.lifecycleRecords,
          baselines: economics.baselines,
          recordedTotals: economics.recordedTotals,
        }),
      ),
    );
    // The report links the family's recorded maturity report (the
    // generation-series record side).
    expect(report.maturityReportDigest).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The fake-world boundary knobs (the app contract catches every knob)
// ---------------------------------------------------------------------------

describe("VAL-045 app discriminations (the fake-world boundary knobs)", () => {
  test("the honest world passes the boundary contract for the all-mechanisms row (the control)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-all-mechanisms-attributed"),
    });
    expect(run.passed).toBe(true);
    expect(run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
    expect(run.outcome.observedTerminal).toBe("COMPLETED");
    expect(run.outcome.reportRecorded).toBe(true);
    expect(run.outcome.residualMicroUsd).toBe(95);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: WorldKnobs; readonly criterionId: string }[] =
      [
        { knob: { attributedsplit: true }, criterionId: "app-attributed-split-read-back" },
        { knob: { foldedresidual: true }, criterionId: "app-residual-read-back" },
        { knob: { gapped: true }, criterionId: "app-generation-series-read-back" },
        {
          knob: { inflatedtotal: true },
          criterionId: "app-attribution-reconciliation-identity-per-generation",
        },
        { knob: { unreported: true }, criterionId: "app-report-landing" },
      ];
    const taskIndex = taskIndexOf("rag-retrieval-all-mechanisms-attributed");
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
        .find((c) => c.criterionId === "app-generation-series-read-back")
        ?.evidence.join(" "),
    ).toContain("GAPPED-SERIES-READ-BACK");
    // The folded-residual knob also breaks the split read-back (the
    // residual folded into the cache mechanism's number).
    const folded = await runAppOverFakeWorld({ taskIndex, knobs: { foldedresidual: true } });
    expect(
      folded.outcome.appCriteria.find((c) => c.criterionId === "app-attributed-split-read-back")
        ?.status,
    ).toBe("FAIL");
    // The inflated-total knob breaks the family-total identity too.
    const inflated = await runAppOverFakeWorld({ taskIndex, knobs: { inflatedtotal: true } });
    expect(
      inflated.outcome.appCriteria.find(
        (c) => c.criterionId === "app-attribution-reconciliation-identity-family-total",
      )?.status,
    ).toBe("FAIL");
  });
});
