/**
 * The economic-adjusted-cost corpus (VAL-044, AC1): the declared rows
 * of the ADJUSTED-COST SYNTHESIS — the three control arms' RECORDED
 * results (VAL-041 direct-provider, VAL-042 optimized non-Zeck
 * baseline, VAL-043 competing stack) composed with the pinned
 * manifests into the three adjusted-cost families. Per row: the
 * FAMILY under test (quality-adjusted | latency-adjusted |
 * failure-adjusted), the PRE-REGISTERED ARM SET (digest references to
 * the recorded arm corpora — never copies), the pinned price
 * revisions of every input, the statistical minimums, the Wilson
 * configuration and the EXPECTED COMPARABILITY VERDICT (comparable |
 * honestly-incomparable | refused-below-minimum — the honest verdicts
 * the economic validation exists for).
 *
 * The offline rows are deterministically reproducible (the RECORDED
 * arm corpora + the pinned manifests — zero credentials, zero
 * network, zero re-measurement): seven honest rows (the three
 * families over the three arms' headline recordings; the NULL-
 * attainment / NULL-resolved honest incomparability; the honest
 * stop-prefix comparability; the below-minimum honest refusal) PLUS
 * the six adversarial PROBE rows whose denatured input shapes (the
 * quality-inflated denominator, the latency omission, the failure
 * hiding, the estimate conflation, the re-measurement masquerade, the
 * below-minimum comparability claim) each FAIL their named criterion
 * honestly. The live row is env-gated on the operator-authorized
 * OpenRouter rail and demands one REAL adjusted comparison over a
 * REAL representative slice.
 *
 * Rows never embed list prices and never copy recorded outcomes: the
 * arms' inputs are DIGEST REFERENCES resolved in their own corpora at
 * verification time; the expected synthesis is derived at module load
 * through the same PURE derivations the driver runs.
 */

import { COMPETING_CORPUS } from "../economic-controls-competing/corpus";
import { DIRECT_CORPUS } from "../economic-controls-direct/corpus";
import { OPTIMIZED_CORPUS } from "../economic-controls-optimized/corpus";
import type {
  AdjustedCorpusRow,
  AdjustedCostFamily,
  AdversarialVariantKind,
  ArmInputReference,
  ArmLabel,
  RecordedArmInput,
} from "./driver";
import {
  deriveAdjustedSynthesis,
  liveArmDigestOf,
  recordedArmDigestOf,
  recordedArmFactsOf,
} from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const ADJUSTED_TASK_KIND = "economic-adjusted-cost.experiment.v1";

/** The corpus version the synthesis carries. */
export const ADJUSTED_CORPUS_VERSION = "val-044-adjusted-cost-v1";

// ---------------------------------------------------------------------------
// The arm-set builders (digest references to the RECORDED corpora)
// ---------------------------------------------------------------------------

/** One recorded arm corpus (label → corpus) — imported, never copied. */
const ARM_CORPORA: Readonly<
  Record<
    ArmLabel,
    readonly {
      readonly rowId: string;
      readonly arm: {
        readonly priceRevision: string;
        readonly armId: string;
        readonly minimumSamples: number;
        readonly corpusSlice: readonly string[];
      };
    }[]
  >
> = {
  direct: DIRECT_CORPUS,
  optimized: OPTIMIZED_CORPUS,
  competing: COMPETING_CORPUS,
};

/**
 * The digest reference for one RECORDED arm corpus row (PURE): the
 * arm's own pinned price revision + the content digest of its
 * RECORDED outcome, re-derived from the imported corpus through the
 * driver's extractor (the same derivation the input-integrity oracle
 * runs at verification time).
 */
export function armReferenceOf(armLabel: ArmLabel, corpusRowId: string): ArmInputReference {
  const corpus = ARM_CORPORA[armLabel];
  const row = corpus.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    throw new Error(`the ${armLabel} corpus declares no recorded row ${corpusRowId}`);
  }
  const preliminary: ArmInputReference = {
    armLabel,
    corpusRowId,
    recordedDigest: "",
    priceRevision: row.arm.priceRevision,
  };
  const resolved = recordedArmFactsOf(preliminary);
  if (resolved === null) {
    throw new Error(`the recorded facts of ${armLabel}:${corpusRowId} failed to re-derive`);
  }
  return {
    armLabel,
    corpusRowId,
    recordedDigest: recordedArmDigestOf({ armLabel, corpusRowId, facts: resolved.facts }),
    priceRevision: row.arm.priceRevision,
  };
}

/** The live-arm reference for one arm's LIVE corpus row (the declaration digest). */
export function liveArmReferenceOf(armLabel: ArmLabel, corpusRowId: string): ArmInputReference {
  const corpus = ARM_CORPORA[armLabel];
  const row = corpus.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    throw new Error(`the ${armLabel} corpus declares no live row ${corpusRowId}`);
  }
  return {
    armLabel,
    corpusRowId,
    recordedDigest: liveArmDigestOf({
      armLabel,
      corpusRowId,
      armId: row.arm.armId,
      sliceSize: row.arm.corpusSlice.length,
    }),
    priceRevision: row.arm.priceRevision,
  };
}

/**
 * The honest per-arm statistical minimum of one arm set (PURE): the
 * MINIMUM of the referenced arms' own declared minimums — every
 * input's recorded sample must reach it for the comparison to claim
 * comparability.
 */
export function minimumSamplesOf(armSet: readonly ArmInputReference[]): number {
  const minimums = armSet.map((reference) => {
    const corpus = ARM_CORPORA[reference.armLabel];
    const row = corpus.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      throw new Error(`the ${reference.armLabel} corpus declares no row ${reference.corpusRowId}`);
    }
    return row.arm.minimumSamples;
  });
  return Math.min(...minimums);
}

// ---------------------------------------------------------------------------
// The pre-registered arm sets (the three recorded control arms)
// ---------------------------------------------------------------------------

/** The three arms' HEADLINE fixed-quality recordings (the comparable set). */
const HEADLINE_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "fixed-quality-direct-default-rail"),
  armReferenceOf("optimized", "fixed-quality-optimized-routing-cache-amortized"),
  armReferenceOf("competing", "fixed-quality-competitor-default-routing"),
];

/** The three arms' ZERO-RESOLVED recordings (the honest incomparability set). */
const ZERO_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "zero-resolved-direct-null-discipline"),
  armReferenceOf("optimized", "zero-resolved-optimized-null-discipline"),
  armReferenceOf("competing", "zero-resolved-competitor-null-discipline"),
];

/** The three arms' honest budget-stop PREFIX recordings (the stop set). */
const STOP_SET: readonly ArmInputReference[] = [
  armReferenceOf("direct", "fixed-cost-direct-budget-exhausted-honest-stop"),
  armReferenceOf("optimized", "fixed-cost-optimized-budget-exhausted-honest-stop"),
  armReferenceOf("competing", "fixed-cost-competitor-budget-exhausted-honest-stop"),
];

/** The three arms' LIVE rows (the live synthesis set — declaration digests). */
const LIVE_SET: readonly ArmInputReference[] = [
  liveArmReferenceOf("direct", "live-fixed-quality-direct-real-dispatch"),
  liveArmReferenceOf("optimized", "live-fixed-quality-optimized-real-dispatch"),
  liveArmReferenceOf("competing", "live-fixed-quality-competitor-real-dispatch"),
];

// ---------------------------------------------------------------------------
// The honest recorded inputs (the driver's canonical input resolution)
// ---------------------------------------------------------------------------

/**
 * The honest recorded inputs of one arm set (PURE): every reference
 * resolves through the driver's extractor into the FULL recorded
 * facts (the normalized outcome, the per-run latencies, the failure
 * decomposition) — the bundle the driver's input-integrity oracle
 * verifies field-by-field against the same corpus derivation.
 */
export function honestInputsOf(armSet: readonly ArmInputReference[]): readonly RecordedArmInput[] {
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
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one offline synthesis row with its PINNED expected synthesis:
 * the REAL derivations (the honest recorded inputs + the family
 * derivation + the Wilson interval + the comparability verdict) run
 * over the declared arm set at module load — exactly what the
 * driver's own synthesis must reproduce at run time.
 */
function adjustedRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly family: AdjustedCostFamily;
  readonly armSet: readonly ArmInputReference[];
  readonly minimumInputs?: number;
  readonly minimumSamplesPerInput?: number;
  readonly latencyBudgetMs?: number;
  readonly verdict?: AdjustedCorpusRow["expected"]["verdict"];
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly adversarial?: AdversarialVariantKind;
  readonly pinSynthesis?: boolean;
}): AdjustedCorpusRow {
  const armSet = input.armSet;
  const row: AdjustedCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    family: input.family,
    armSet,
    minimumInputs: input.minimumInputs ?? armSet.length,
    minimumSamplesPerInput: input.minimumSamplesPerInput ?? minimumSamplesOf(armSet),
    ...(input.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: input.latencyBudgetMs }),
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
  if ((input.pinSynthesis ?? true) && !row.needsDispatch && input.adversarial === undefined) {
    const derived = deriveAdjustedSynthesis({ row, inputs: honestInputsOf(armSet) });
    if (derived.synthesis === null) {
      throw new Error(`the expected synthesis of ${input.rowId} failed to derive`);
    }
    return { ...row, expected: { ...row.expected, synthesis: derived.synthesis } };
  }
  return row;
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The honest offline rows (the honest verdicts, each family covered). */
export const OFFLINE_CONTROL_ROWS: readonly AdjustedCorpusRow[] = [
  adjustedRow({
    rowId: "quality-adjusted-three-arm-synthesis",
    description:
      "The headline QUALITY-ADJUSTED synthesis: the three arms' headline fixed-quality recordings (VAL-041 direct default-rail, VAL-042 optimized routing-cache-amortized, VAL-043 competing default-routing — digest-referenced, never copied) composed into the measured cost per unit of VERIFIED quality attainment. The denominator is the attainment RECOMPUTED from the recorded runs' own resolution counts (never an arm's claim); every input's pinned revision is verified against the manifest; the comparison carries the Wilson 95% interval over the pooled sample. Expected verdict: comparable.",
    family: "quality-adjusted",
    armSet: HEADLINE_SET,
  }),
  adjustedRow({
    rowId: "latency-adjusted-three-arm-synthesis",
    description:
      "The headline LATENCY-ADJUSTED synthesis: the same three recorded arms composed into the cost-per-resolved weighted by latency-budget compliance — every recorded run's OWN recorded latency (the direct arm's per-attempt wallclocks, the optimized arm's cache-hit 3ms replays, the competing arm's gateway aggregates) weighed against the pinned 1000ms budget. A latency-omitting comparison FAILs mechanically; the weighting is INCLUDED. Expected verdict: comparable.",
    family: "latency-adjusted",
    armSet: HEADLINE_SET,
    latencyBudgetMs: 1000,
  }),
  adjustedRow({
    rowId: "failure-adjusted-three-arm-synthesis",
    description:
      "The headline FAILURE-ADJUSTED synthesis: the three recorded arms composed into the measured cost per successfully resolved outcome with retries and failed attempts FULLY amortized — the direct arm's per-attempt retry-overhead facts, the optimized arm's retry-amortized rounds, the competing arm's gateway-aggregate internal retries all counted in the measured totals (the VAL-006 discipline; NULL when nothing resolved). Expected verdict: comparable.",
    family: "failure-adjusted",
    armSet: HEADLINE_SET,
  }),
  adjustedRow({
    rowId: "quality-adjusted-null-attainment-incomparable",
    description:
      "The honest NULL-ATTAINMENT incomparability: the three arms' zero-resolved recordings composed into the quality-adjusted family — NOTHING resolved in any arm, so the verified attainment is 0 and the quality-adjusted cost is NULL (never a zero-denominator fabrication). The honest incomparability IS the verified outcome; the comparison still carries the recorded measured totals and the Wilson [0, high] intervals. Expected verdict: honestly-incomparable.",
    family: "quality-adjusted",
    armSet: ZERO_SET,
    verdict: "honestly-incomparable",
  }),
  adjustedRow({
    rowId: "failure-adjusted-null-resolved-incomparable",
    description:
      "The honest NULL-RESOLVED incomparability: the three arms' zero-resolved recordings composed into the failure-adjusted family — the fully-amortized cost per successfully resolved outcome is NULL when nothing resolved (never zero, never estimate-backed) while the measured cost of the failed runs is still carried honestly. Expected verdict: honestly-incomparable.",
    family: "failure-adjusted",
    armSet: ZERO_SET,
    verdict: "honestly-incomparable",
  }),
  adjustedRow({
    rowId: "latency-adjusted-honest-stop-prefix",
    description:
      "The honest stop-prefix comparability: the three arms' honest budget-stop PREFIX recordings (each arm's declared prefix stop — 3-of-8 executed, the stop that is never a post-hoc exclusion) composed into the latency-adjusted family. The executed prefixes hold each arm's own statistical minimum; the declared stop is honest data, never dropped, and the latency weighting includes every executed run's recorded latency. Expected verdict: comparable.",
    family: "latency-adjusted",
    armSet: STOP_SET,
    latencyBudgetMs: 1000,
  }),
  adjustedRow({
    rowId: "quality-adjusted-below-minimum-honest-refusal",
    description:
      "The honest below-minimum REFUSAL: the three arms' stop-prefix recordings (3 executed rounds each) against a pre-registered per-arm minimum of 6 — the samples cannot support a comparability verdict, so the synthesis REFUSES (the honest refusal, never a fabricated comparability on a starved sample). The refusal is the verified outcome. Expected verdict: refused-below-minimum.",
    family: "quality-adjusted",
    armSet: STOP_SET,
    minimumSamplesPerInput: 6,
    verdict: "refused-below-minimum",
  }),
];

/** The adversarial probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly AdjustedCorpusRow[] = [
  adjustedRow({
    rowId: "probe-quality-inflated-denominator",
    description:
      "The quality-inflation probe: one input's bundle claims an attainment above the RECOMPUTED verified attainment — the inflated denominator deflates the quality-adjusted cost, and the quality-adjustment-honesty oracle FAILs it MECHANICALLY with the claim named (the derivation decides, never the claim).",
    family: "quality-adjusted",
    armSet: HEADLINE_SET,
    adversarial: "quality-inflation",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  adjustedRow({
    rowId: "probe-latency-omission",
    description:
      "The latency-omission probe: every input's bundle carries NO per-run latencies while the row claims a latency adjustment — the latency-adjustment-inclusion oracle FAILs it MECHANICALLY (a comparison that omits latencies cannot claim a latency adjustment; the weighting would be fabricated).",
    family: "latency-adjusted",
    armSet: HEADLINE_SET,
    latencyBudgetMs: 1000,
    adversarial: "latency-omission",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  adjustedRow({
    rowId: "probe-failure-hiding",
    description:
      "The failure-hiding probe: every input's bundle zeroes the retry-overhead share and the failed rounds' cost — the failure-adjusted cost would amortize NOTHING, and the failure-adjustment-completeness oracle FAILs it MECHANICALLY with the dropped shares named (retries and failed attempts are fully amortized or the comparison is dishonest).",
    family: "failure-adjusted",
    armSet: HEADLINE_SET,
    adversarial: "failure-hiding",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  adjustedRow({
    rowId: "probe-estimate-conflation",
    description:
      "The estimate-conflation probe: every input's bundle absorbs the estimate share into the measured total (the estimate field zeroed) — the estimate/measure-separation oracle FAILs it MECHANICALLY (the adjusted cost would be quote-backed, not measured; estimates are never conflated).",
    family: "quality-adjusted",
    armSet: HEADLINE_SET,
    adversarial: "estimate-conflation",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  adjustedRow({
    rowId: "probe-remeasurement-masquerade",
    description:
      "The re-measurement masquerade probe: one input's bundle carries a RE-MEASURED outcome (its own run counts, not the recorded corpus's) while declaring the recorded digest — the input-integrity oracle FAILs it MECHANICALLY, field by field (the synthesis derives over RECORDED results; a re-measurement masquerading as synthesis is refused).",
    family: "quality-adjusted",
    armSet: HEADLINE_SET,
    adversarial: "remeasurement",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  adjustedRow({
    rowId: "probe-below-minimum-comparability-claim",
    description:
      "The below-minimum comparability claim probe: the stop-prefix recordings (3 executed rounds each) against a pre-registered per-arm minimum of 6, with the row CLAIMING the comparable verdict — the below-minimum-refusal-honesty oracle FAILs it MECHANICALLY (a comparison below the pre-registered minimums claims a verdict it cannot support; the honest outcome is the refusal).",
    family: "quality-adjusted",
    armSet: STOP_SET,
    minimumSamplesPerInput: 6,
    adversarial: "below-minimum-claim",
    terminal: "FAILED",
    verdict: "comparable",
    pinSynthesis: false,
  }),
];

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly AdjustedCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL comparison)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; one REAL adjusted comparison). */
export const LIVE_CORPUS_ROWS: readonly AdjustedCorpusRow[] = [
  {
    rowId: "live-adjusted-synthesis-real-comparison",
    description:
      "A REAL adjusted-cost comparison (env-gated): the three arms' LIVE rows driven with REAL dispatches on the operator-authorized OpenRouter rail (BYOK, measured usage) — every arm priced at its pinned manifest revision, the adjusted families computed over MEASURED facts, the verdict recorded through the REAL recorder with honest economics. Without the credential the row is honestly NOT RUN (never fabricated).",
    family: "quality-adjusted",
    armSet: LIVE_SET,
    minimumInputs: 3,
    minimumSamplesPerInput: 3,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL adjusted comparison demands REAL measured results on every arm",
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
export const ADJUSTED_CORPUS: readonly AdjustedCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: AdjustedCorpusRow, env: NodeJS.ProcessEnv): boolean {
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
  return `val-044-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY —
 * the row, the family, the pre-registered arm set (arm labels + row
 * ids + digest references), the minimums, the Wilson level and the
 * expected verdict. Never a price, never a token price, never a
 * recorded outcome copy (the platform resolves the corpora and the
 * manifests through their registries).
 */
export function taskBodyFor(options: { readonly row: AdjustedCorpusRow }): Record<string, unknown> {
  const { row } = options;
  return {
    kind: ADJUSTED_TASK_KIND,
    rowId: row.rowId,
    family: row.family,
    preRegisteredArmSet: row.armSet.map((reference) => ({
      arm: reference.armLabel,
      rowId: reference.corpusRowId,
      recordedDigest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    minimumInputs: row.minimumInputs,
    minimumSamplesPerInput: row.minimumSamplesPerInput,
    wilsonConfidenceLevel: 0.95,
    ...(row.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: row.latencyBudgetMs }),
    expectedVerdict: row.expected.verdict,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const ADJUSTED_ROW_IDS: readonly string[] = ADJUSTED_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function adjustedRowById(rowId: string): AdjustedCorpusRow | null {
  return ADJUSTED_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
