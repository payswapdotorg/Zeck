/**
 * The economic-substrate-runtime corpus (VAL-046, AC1): the declared
 * rows of the SUBSTRATE-COST SYNTHESIS — the RECORDED substrate
 * telemetry windows (the platform-side lifecycle provenance) composed
 * with the RECORDED arm results (VAL-041/042/43 — the run provenance
 * and the model-cost side) into the three substrate-cost families.
 * Per row: the FAMILY under test (substrate-cost-per-run |
 * substrate-amortized-per-resolved | readiness-adjusted-comparison),
 * the PRE-REGISTERED window set (digest references into the recorded
 * telemetry — never copies), the composed ARM set (digest references
 * into the VAL-044 arm corpora), the statistical minimums, the Wilson
 * configuration and the EXPECTED COMPARABILITY VERDICT (comparable |
 * honestly-incomparable | refused-below-minimum).
 *
 * The offline rows are deterministically reproducible (the RECORDED
 * telemetry + the pinned manifests — zero credentials, zero network,
 * zero re-measurement): six honest rows (the three families over the
 * three fleets' headline windows; the reliability-amortized family
 * over the failure-heavy windows; the NULL-resolved honest
 * incomparability; the below-minimum honest refusal) PLUS the seven
 * adversarial PROBE rows whose denatured claim shapes (the
 * startup-hiding claim, the readiness-inflation claim, the
 * reserved/measured conflation claim, the failure-amortization-away
 * claim, the post-hoc window exclusion, the sample-size violation's
 * below-minimum comparability claim, the re-measurement masquerade)
 * each FAIL their named criterion honestly. The live row is
 * env-gated on the operator-authorized OpenRouter rail and demands
 * one REAL substrate lifecycle measurement (cold start → ready →
 * sustained → teardown).
 *
 * Rows never embed substrate prices and never copy recorded
 * telemetry: the windows are DIGEST REFERENCES resolved in the
 * telemetry corpus at verification time; the expected synthesis is
 * derived at module load through the same PURE derivations the driver
 * runs.
 */

import {
  armReferenceOf,
  liveArmReferenceOf,
  minimumSamplesOf,
} from "../economic-adjusted-cost/corpus";
import type { ArmInputReference } from "../economic-adjusted-cost/driver";
import { pooledFactsOf } from "../economic-adjusted-cost/driver";
import type {
  SubstrateAdversarialKind,
  SubstrateComparability,
  SubstrateCorpusRow,
  SubstrateWindowReference,
} from "./driver";
import { armInputsOf, deriveSubstrateFamilySynthesis, liveSubstratePlanDigestOf } from "./driver";
import type { SubstrateWindowFacts } from "./telemetry";
import {
  recordedSubstrateWindowDigestOf,
  SUBSTRATE_TELEMETRY,
  substrateWindowFactsOf,
  TELEMETRY_SETS,
} from "./telemetry";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const SUBSTRATE_TASK_KIND = "economic-substrate-runtime.experiment.v1";

/** The corpus version the synthesis carries. */
export const SUBSTRATE_CORPUS_VERSION = "val-046-substrate-runtime-v1";

// ---------------------------------------------------------------------------
// The window-reference builders (digest references to the RECORDED telemetry)
// ---------------------------------------------------------------------------

/**
 * The digest reference for one RECORDED telemetry window (PURE): the
 * window's own pinned price revision + the content digest of its
 * DERIVED facts — re-derived from the imported telemetry corpus
 * through the same extractor the input-integrity oracle runs at
 * verification time.
 */
export function windowReferenceOf(windowId: string): SubstrateWindowReference {
  const window = SUBSTRATE_TELEMETRY.find((candidate) => candidate.windowId === windowId);
  if (window === undefined) {
    throw new Error(`the telemetry corpus declares no recorded window ${windowId}`);
  }
  const facts = substrateWindowFactsOf(window);
  return {
    windowId,
    recordedDigest: recordedSubstrateWindowDigestOf({ windowId, facts }),
    priceRevision: window.priceRevision,
  };
}

/** Build the digest references for a set of recorded window ids (in order). */
function windowSetOf(windowIds: readonly string[]): readonly SubstrateWindowReference[] {
  return windowIds.map((windowId) => windowReferenceOf(windowId));
}

// ---------------------------------------------------------------------------
// The pre-registered arm sets (the model side + the run provenance)
// ---------------------------------------------------------------------------

/** The three arms' HEADLINE fixed-quality recordings (the comparable model side). */
const HEADLINE_ARM_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "fixed-quality-direct-default-rail"),
  armReferenceOf("optimized", "fixed-quality-optimized-routing-cache-amortized"),
  armReferenceOf("competing", "fixed-quality-competitor-default-routing"),
];

/** The three arms' ZERO-RESOLVED recordings (the honest incomparability model side). */
const ZERO_ARM_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "zero-resolved-direct-null-discipline"),
  armReferenceOf("optimized", "zero-resolved-optimized-null-discipline"),
  armReferenceOf("competing", "zero-resolved-competitor-null-discipline"),
];

/** The three arms' honest budget-stop PREFIX recordings (the stop model side). */
const STOP_ARM_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "fixed-cost-direct-budget-exhausted-honest-stop"),
  armReferenceOf("optimized", "fixed-cost-optimized-budget-exhausted-honest-stop"),
  armReferenceOf("competing", "fixed-cost-competitor-budget-exhausted-honest-stop"),
];

/** The direct arm's LIVE row (the live lane's pinned rail provenance). */
const LIVE_ARM_SET: readonly ArmInputReference[] = [
  liveArmReferenceOf("direct", "live-fixed-quality-direct-real-dispatch"),
];

// ---------------------------------------------------------------------------
// The honest window inputs (the driver's canonical input resolution)
// ---------------------------------------------------------------------------

/** The resolved facts of one recorded window (the reference + the derivation). */
export interface HonestWindowBundle {
  readonly windowId: string;
  readonly recordedDigest: string;
  readonly priceRevision: string;
  readonly facts: SubstrateWindowFacts;
}

/**
 * The honest window inputs of a window set (PURE): every reference
 * resolves through the telemetry extractor into the FULL derived facts
 * — the bundle the input-integrity oracle verifies field-by-field.
 */
export function honestWindowInputsOf(
  windowSet: readonly SubstrateWindowReference[],
): readonly HonestWindowBundle[] {
  return windowSet.map((reference) => {
    const window = SUBSTRATE_TELEMETRY.find(
      (candidate) => candidate.windowId === reference.windowId,
    );
    if (window === undefined) {
      throw new Error(`the telemetry corpus declares no recorded window ${reference.windowId}`);
    }
    return { ...reference, facts: substrateWindowFactsOf(window) };
  });
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * The honest per-window statistical minimum of a window set (PURE):
 * the MAXIMUM of the referenced arm rows' own served sample... no —
 * the windows serve the arms' RECORDED rows, so the honest per-window
 * minimum mirrors the arms' own declared statistical minimums (the
 * same discipline VAL-044's minimumSamplesOf applies to arm sets).
 */
export function minimumRunsOfWindowSet(windowSet: readonly SubstrateWindowReference[]): number {
  const minimums = windowSet.map((reference) => {
    const window = SUBSTRATE_TELEMETRY.find(
      (candidate) => candidate.windowId === reference.windowId,
    );
    if (window === undefined) {
      throw new Error(`the telemetry corpus declares no recorded window ${reference.windowId}`);
    }
    const armRefs = window.servedArmRuns.map((served) =>
      armReferenceOf(served.armLabel, served.corpusRowId),
    );
    return minimumSamplesOf(armRefs);
  });
  return Math.min(...minimums);
}

/**
 * Build one offline synthesis row with its PINNED expected synthesis:
 * the REAL derivations (the honest window inputs + the family
 * derivation over the recorded model side) run over the declared
 * window set at module load — exactly what the driver's own synthesis
 * must reproduce at run time.
 */
function substrateRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly family: SubstrateCorpusRow["family"];
  readonly windowSet: readonly SubstrateWindowReference[];
  readonly armSet: readonly ArmInputReference[];
  readonly minimumWindows?: number;
  readonly minimumRunsPerWindow?: number;
  readonly verdict?: SubstrateComparability;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly adversarial?: SubstrateAdversarialKind;
  readonly pinSynthesis?: boolean;
}): SubstrateCorpusRow {
  const windowSet = input.windowSet;
  const row: SubstrateCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    family: input.family,
    windowSet,
    armSet: input.armSet,
    minimumWindows: input.minimumWindows ?? windowSet.length,
    minimumRunsPerWindow: input.minimumRunsPerWindow ?? minimumRunsOfWindowSet(windowSet),
    needsDispatch: false,
    ...(input.adversarial === undefined ? {} : { adversarial: input.adversarial }),
    expected: {
      terminal: input.terminal ?? "COMPLETED",
      verdict: input.verdict ?? "comparable",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
  if ((input.pinSynthesis ?? true) && input.adversarial === undefined) {
    const derived = deriveSubstrateFamilySynthesis({
      row,
      windows: honestWindowInputsOf(windowSet),
      modelSide: modelSideOfRow(row),
    });
    if (derived.synthesis === null) {
      throw new Error(`the expected synthesis of ${input.rowId} failed to derive`);
    }
    return { ...row, expected: { ...row.expected, synthesis: derived.synthesis } };
  }
  return row;
}

/** The model side of a row: the RECORDED arm facts pooled (never re-measured). */
function modelSideOfRow(
  row: SubstrateCorpusRow,
): { measuredMicroUsd: bigint; resolved: number; runs: number } | null {
  if (row.armSet.length === 0) {
    return null;
  }
  const pooled = pooledFactsOf(armInputsOf(row.armSet));
  return {
    measuredMicroUsd: pooled.measuredMicroUsd,
    resolved: pooled.resolved,
    runs: pooled.runs,
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The window ids of each recorded set (the corpus's pinned slices). */
const HEADLINE_WINDOW_IDS = TELEMETRY_SETS.headline.map((window) => window.windowId);
const RELIABILITY_WINDOW_IDS = TELEMETRY_SETS.reliability.map((window) => window.windowId);
const ZERO_WINDOW_IDS = TELEMETRY_SETS.zero.map((window) => window.windowId);
const STOP_WINDOW_IDS = TELEMETRY_SETS.stop.map((window) => window.windowId);

/** The honest offline rows (the honest verdicts, each family covered). */
export const OFFLINE_CONTROL_ROWS: readonly SubstrateCorpusRow[] = [
  substrateRow({
    rowId: "substrate-cost-per-run-three-fleet-synthesis",
    description:
      "The headline SUBSTRATE COST PER RUN synthesis: the three fleets' headline lifecycle windows (warm-fleet-a's refused-probe warm-up, reserved-fleet-c's instant warm-pool readiness with one fresh-sandbox restart and a 120s standing reservation, cold-fleet-b's slow spot warm-up — digest-referenced, never copied) composed into the pooled substrate cost per recorded served run (24 runs — the run counts RE-DERIVED from the arm corpora, never the windows' own claims). Expected verdict: comparable.",
    family: "substrate-cost-per-run",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
  }),
  substrateRow({
    rowId: "substrate-cost-amortized-per-resolved-synthesis",
    description:
      "The headline SUBSTRATE COST AMORTIZED PER RESOLVED OUTCOME synthesis: the same three fleets' headline windows composed into the pooled substrate total divided by the recorded resolved count (24 resolved) — the substrate share of the cost of a successfully resolved outcome, with the readiness wait share (startup + restart) carried explicitly. NULL when nothing resolved (never zero, never estimate-backed). Expected verdict: comparable.",
    family: "substrate-amortized-per-resolved",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
  }),
  substrateRow({
    rowId: "readiness-adjusted-effective-comparison-synthesis",
    description:
      "The headline READINESS-ADJUSTED COMPARISON: the three arms' headline model costs (the RECORDED VAL-041/042/43 facts — digest-referenced, never re-measured) PLUS the substrate cost per resolved, composed into the EFFECTIVE cost per resolved outcome with the substrate share EXPLICIT — a comparison that silently absorbs the substrate cost into a provider price FAILs mechanically. Expected verdict: comparable.",
    family: "readiness-adjusted-comparison",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
  }),
  substrateRow({
    rowId: "substrate-reliability-failure-amortization-synthesis",
    description:
      "The RELIABILITY family synthesis: the failure-heavy lifecycle windows (the EU warm fleet's eviction + restart, the reserved fleet's two restarts + eviction + 180s standing reservation, the cold fleet's restart — the VAL-022 recorded failure shapes cited as provenance) composed into the amortized-per-resolved family with every restart's fresh-sandbox cold start and every eviction's wasted compute FULLY priced — the amortization-away probe's honest counterpart. Expected verdict: comparable.",
    family: "substrate-amortized-per-resolved",
    windowSet: windowSetOf(RELIABILITY_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
  }),
  substrateRow({
    rowId: "substrate-amortized-null-resolved-incomparable",
    description:
      "The honest NULL-RESOLVED incomparability: the three fleets' zero-resolved windows (serving the three arms' zero-resolved recordings — 18 runs, 0 resolved) composed into the amortized-per-resolved family — NOTHING resolved, so the substrate cost amortized per resolved outcome is NULL (never zero, never estimate-backed) while the substrate cost of the failed runs is still carried honestly. The honest incomparability IS the verified outcome. Expected verdict: honestly-incomparable.",
    family: "substrate-amortized-per-resolved",
    windowSet: windowSetOf(ZERO_WINDOW_IDS),
    armSet: ZERO_ARM_SET,
    verdict: "honestly-incomparable",
  }),
  substrateRow({
    rowId: "readiness-adjusted-below-minimum-honest-refusal",
    description:
      "The honest below-minimum REFUSAL: the three fleets' stop-prefix windows (each serving a 3-run honest budget-stop recording) against a pre-registered per-window minimum of 6 — the samples cannot support a comparability verdict, so the synthesis REFUSES (the honest refusal, never a fabricated comparability on a starved sample). The refusal is the verified outcome. Expected verdict: refused-below-minimum.",
    family: "readiness-adjusted-comparison",
    windowSet: windowSetOf(STOP_WINDOW_IDS),
    armSet: STOP_ARM_SET,
    minimumRunsPerWindow: 6,
    verdict: "refused-below-minimum",
  }),
];

/** The adversarial probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly SubstrateCorpusRow[] = [
  substrateRow({
    rowId: "probe-startup-hiding",
    description:
      "The startup-hiding probe: one window's comparison CLAIMS a zero startup share while its recorded telemetry shows a refused-probe warm-up of 1400ms — the startup-cost-inclusion oracle FAILs it MECHANICALLY with the claim named (the cold start is never free; the readiness wait is never hidden).",
    family: "substrate-cost-per-run",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "startup-hiding",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-readiness-inflation",
    description:
      "The readiness-inflation probe: one window's comparison CLAIMS first-usable at 400ms — the timestamp of the first REFUSED probe — while the first PASSING probe observed usability at 1400ms: the readiness-probe-honesty oracle FAILs it MECHANICALLY (readiness is warm-up to FIRST-USABLE, derived from the first passing probe — never a claim, never the first-dispatched point).",
    family: "readiness-adjusted-comparison",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "readiness-inflation",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-reserved-measured-conflation",
    description:
      "The reserved/measured conflation probe: the reserved fleet's window CLAIMS a measured total that absorbs its 120s standing reservation while claiming a zero reserved share — the reserved-measured-separation oracle FAILs it MECHANICALLY (the standing capacity was folded into the measured usage; idle standing cost is never hidden as usage).",
    family: "substrate-cost-per-run",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "reserved-conflation",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-failure-amortization-away",
    description:
      "The failure-amortization-away probe: the reliability windows' comparison CLAIMS zero restart and eviction shares while the recorded telemetry counts restarts and evictions with their wasted compute — the failure-amortization-completeness oracle FAILs it MECHANICALLY (every fresh-sandbox cold start is priced; evicted compute is never free).",
    family: "substrate-amortized-per-resolved",
    windowSet: windowSetOf(RELIABILITY_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "failure-amortization-away",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-post-hoc-exclusion",
    description:
      "The post-hoc exclusion probe: one pre-registered window is DROPPED from the executed input set — the confidence-and-minimum oracle FAILs it MECHANICALLY (the pre-registered window set decides; an excluded window is a post-hoc exclusion, never data).",
    family: "substrate-cost-per-run",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "post-hoc-exclusion",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-sample-size-violation",
    description:
      "The sample-size violation probe: the stop-prefix windows (3 served runs each) against a pre-registered per-window minimum of 6, with the row CLAIMING the comparable verdict — the below-minimum-refusal-honesty oracle FAILs it MECHANICALLY (a comparison below the pre-registered minimums claims a verdict it cannot support; the honest outcome is the refusal).",
    family: "readiness-adjusted-comparison",
    windowSet: windowSetOf(STOP_WINDOW_IDS),
    armSet: STOP_ARM_SET,
    minimumRunsPerWindow: 6,
    adversarial: "below-minimum-claim",
    terminal: "FAILED",
    verdict: "comparable",
    pinSynthesis: false,
  }),
  substrateRow({
    rowId: "probe-remeasurement-masquerade",
    description:
      "The re-measurement masquerade probe: one window's bundle carries a RE-MEASURED served run count (its own count, not the recorded arm corpora's) while declaring the recorded digest — the input-integrity oracle FAILs it MECHANICALLY, field by field (the synthesis derives over RECORDED telemetry; a re-measurement masquerading as derivation is refused).",
    family: "substrate-amortized-per-resolved",
    windowSet: windowSetOf(HEADLINE_WINDOW_IDS),
    armSet: HEADLINE_ARM_SET,
    adversarial: "remeasurement",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
];

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly SubstrateCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL lifecycle measurement)
// ---------------------------------------------------------------------------

/** The live plan's declaration digest (computed once — the live reference's recorded digest). */
const LIVE_PLAN_DIGEST = liveSubstratePlanDigestOf();

/** The live rows (env-gated on the authorized rail; one REAL substrate lifecycle). */
export const LIVE_CORPUS_ROWS: readonly SubstrateCorpusRow[] = [
  {
    rowId: "live-substrate-lifecycle-real-measurement",
    description:
      "A REAL substrate lifecycle measurement (env-gated): one REAL lifecycle over the REAL process substrate — cold start, readiness probes to FIRST-USABLE, a sustained runtime of three REAL workload units (each a real substrate execution riding one REAL model dispatch on the operator-authorized OpenRouter rail — BYOK, measured usage, every priced input at its pinned manifest revision), teardown — with the substrate-cost families computed over MEASURED facts and the verdict recorded through the REAL recorder with honest economics. Without the credential the row is honestly NOT RUN (never fabricated).",
    family: "readiness-adjusted-comparison",
    windowSet: [
      {
        windowId: "live-substrate-lifecycle-window",
        recordedDigest: LIVE_PLAN_DIGEST,
        priceRevision: "sub-rev-001",
        live: true,
      },
    ],
    armSet: LIVE_ARM_SET,
    minimumWindows: 1,
    minimumRunsPerWindow: 3,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL substrate lifecycle measurement demands REAL workload dispatches on the pinned rail (BYOK, measured usage, max_tokens 32 pinned explicitly, temperature unset per the provider's documented default)",
    },
    expected: {
      terminal: "COMPLETED",
      verdict: "comparable",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const SUBSTRATE_CORPUS: readonly SubstrateCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: SubstrateCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/** The app's idempotency key for one row's submission. */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-046-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY — the
 * row, the family, the pre-registered window set (window ids + digest
 * references), the composed arm set, the minimums, the Wilson level and
 * the expected verdict. Never a substrate price, never a recorded
 * telemetry copy (the platform resolves the corpora and the manifests
 * through their registries).
 */
export function taskBodyFor(options: {
  readonly row: SubstrateCorpusRow;
}): Record<string, unknown> {
  const { row } = options;
  return {
    kind: SUBSTRATE_TASK_KIND,
    rowId: row.rowId,
    family: row.family,
    preRegisteredWindowSet: row.windowSet.map((reference) => ({
      window: reference.windowId,
      recordedDigest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    composedArmSet: row.armSet.map((reference) => ({
      arm: reference.armLabel,
      rowId: reference.corpusRowId,
      recordedDigest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    minimumWindows: row.minimumWindows,
    minimumRunsPerWindow: row.minimumRunsPerWindow,
    wilsonConfidenceLevel: 0.95,
    expectedVerdict: row.expected.verdict,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const SUBSTRATE_ROW_IDS: readonly string[] = SUBSTRATE_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function substrateRowById(rowId: string): SubstrateCorpusRow | null {
  return SUBSTRATE_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
