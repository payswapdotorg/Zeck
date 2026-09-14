/**
 * The platform-side determinization-maturity engine (VAL-036).
 *
 * The mechanical engine of the maturity slice — the LONGITUDINAL
 * FINALE of the determinization chain (VAL-032..035): it takes the
 * RECORDED LIFECYCLE HISTORY those slices produced (the candidate
 * registry entries, the per-candidate lifecycle walks that end at
 * `promoted`, the per-generation accounting ledgers — the READ-ONLY
 * input; a recorded record is never rewritten) and derives the
 * MATURITY ANALYSIS of the workload portfolio: how each workload
 * family's determinization evolves across the PROMOTION GENERATIONS
 * (g1, g2, ... — each generation's per-family model-call counts, its
 * MEASURED cost/latency, its per-mechanism displacement counts over
 * the CANDIDATE_KINDS vocabulary: reuse / cache / competence /
 * deterministicization), the learning-curve analysis (which families
 * determinize fast — reaching stable promoted states in few
 * generations — and which stay variable, reported honestly with
 * their observed distributions), the per-generation savings
 * reconciliation against the recorded accounting ledgers, and the
 * honest MATURITY CLASSIFICATION per family:
 * determinized-stable / determinizing-trending / variable-resilient /
 * immature-insufficient-evidence.
 *
 * The maturity oracle (the PURE derivations that make a maturity
 * claim trustworthy):
 *
 *   * `deriveMaturityEvidenceCitation` — every maturity claim cites
 *     its FULL evidence population: the lifecycle records, the
 *     promotion generations and the accounting measurements it
 *     generalizes from. An UNCITED claim (a citation missing a
 *     recorded member), a PHANTOM citation (a cited member that is
 *     not in the recorded population) or a PARTIAL population (a
 *     recorded member the citation missed) FAILs with the member
 *     named;
 *   * `deriveCurveSeriesIntegrity` — the generation series is
 *     GAPLESS (a MISSING generation FAILs, named; a generation whose
 *     measurements are ABSENT FAILs, named) and every curve point
 *     cites RECORDED measurements only — an EXTRAPOLATED or
 *     FABRICATED point FAILs and is named;
 *   * `deriveMaturityClassification` — the verdict must match the
 *     observed data: a variable-resilient family classified
 *     determinized-stable FAILs (and vice versa) with both sides
 *     named (claimed vs observed); the thresholds are PINNED —
 *     stable = zero model-call variance + full displacement across
 *     the last K generations; trending = monotone displacement growth
 *     over at least the minimum generations; variable = recurring
 *     variance across generations; insufficient = fewer than the
 *     minimum generations (classified immature, NEVER stretched into
 *     a trend — a trend claim from insufficient evidence FAILs);
 *   * `deriveSavingsReconciliation` — per-mechanism savings (reuse /
 *     cache / competence / deterministicization attributed SEPARATELY)
 *     that reconcile with the recorded accounting ledgers: an
 *     aggregate number WITHOUT its per-mechanism breakdown FAILs, and
 *     a number that does not match the ledgers FAILs with BOTH sides
 *     named (claimed vs recorded);
 *   * `deriveMaturityHonesty` — honest measurement discipline: every
 *     generation's cost/latency is MEASURED (never estimated — an
 *     estimated measurement FAILs, named), and the none-reported
 *     boundaries are honest (usage is honestly none-reported offline
 *     and measured only on the live rail — a fabricated offline
 *     usage FAILs).
 *
 * Digest discipline: every identity, citation, generation point,
 * savings entry and report record carries an FNV-1a payload-free
 * digest (via `longitudinalDigestOf`); payload bytes never enter the
 * evidence. Latency is always measured; usage is honestly
 * none-reported offline and measured only on the live rail.
 *
 * Everything is seam-injected here (the lab contract); the
 * integration seam binds the REAL platform path and — for the live
 * row — the REAL model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type { CandidateKind, DiscoveryProposalRecord } from "./learning-discovery";
import { CANDIDATE_KINDS } from "./learning-discovery";
import type { ControlDispatch } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The maturity vocabulary (the learning-curve grammar)
// ---------------------------------------------------------------------------

/**
 * The maturity phase's learning mode: the maturity analysis is a
 * LONGITUDINAL READ — it generalizes the RECORDED lifecycle history
 * (VAL-032..035's registries, ledgers and lifecycle records) across
 * the promotion generations. It never rewrites a recorded record.
 */
export const MATURITY_LEARNING_PHASE = "maturity" as const;

/** The longitudinal-experiment kind every maturity run registers as. */
export const MATURITY_EXPERIMENT_KIND = "determinization-maturity";

/**
 * The honest maturity classifications (the per-family verdict
 * vocabulary — the analysis NEVER stretches the evidence):
 *
 *   * `determinized-stable` — the family reached a stable promoted
 *     state: zero model-call variance AND full displacement across
 *     the last K (stability-window) generations;
 *   * `determinizing-trending` — the family is still determinizing:
 *     monotone displacement growth over at least the minimum
 *     generations for a trend;
 *   * `variable-resilient` — the family stays variable across
 *     generations (recurring model-call variance — reported honestly
 *     with its observed distribution, never smoothed);
 *   * `immature-insufficient-evidence` — the family holds fewer than
 *     the minimum generations for a trend: the honest verdict, NEVER
 *     stretched into a trend claim.
 */
export const MATURITY_CLASSIFICATIONS = [
  "determinized-stable",
  "determinizing-trending",
  "variable-resilient",
  "immature-insufficient-evidence",
] as const;

export type MaturityClassification = (typeof MATURITY_CLASSIFICATIONS)[number];

export function isMaturityClassification(value: string): value is MaturityClassification {
  return (MATURITY_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * The MINIMUM number of promotion generations a family must hold
 * before ANY trend or stability claim is admissible (PINNED): below
 * it the family is classified `immature-insufficient-evidence` and
 * every stronger claim FAILs as evidence-stretching.
 */
export const MINIMUM_GENERATIONS_FOR_TREND = 3;

/**
 * The stability window K (PINNED): the number of LAST generations a
 * determinized-stable claim looks at — zero model-call variance AND
 * full displacement across ALL of them.
 */
export const STABILITY_WINDOW_GENERATIONS = 2;

/**
 * The maturity-probe kinds the corpus declares (the vocabulary the
 * later discrimination phases drive over the adversarial fixture
 * variants — designed here, pinned now):
 *
 *   * `uncited-claim` — a maturity claim whose evidence citation
 *     misses recorded members (or cites phantom members) — FAILs;
 *   * `gapped-series` — the generation series is gapped (a missing
 *     generation, or a generation whose measurements are absent) or
 *     holds an extrapolated/fabricated point — FAILs;
 *   * `misclassified-family` — the claimed classification contradicts
 *     the observed data (a variable family claimed stable, or a
 *     stable family claimed variable) — FAILs;
 *   * `unreconciled-savings` — the claimed savings carry no
 *     per-mechanism breakdown, or a number that does not match the
 *     recorded ledgers — FAILs;
 *   * `insufficient-evidence-trend` — a trend/stability claim from a
 *     family with fewer than the minimum generations — FAILs.
 */
export const MATURITY_PROBE_KINDS = [
  "uncited-claim",
  "gapped-series",
  "misclassified-family",
  "unreconciled-savings",
  "insufficient-evidence-trend",
] as const;

export type MaturityProbeKind = (typeof MATURITY_PROBE_KINDS)[number];

export function isMaturityProbeKind(value: string): value is MaturityProbeKind {
  return (MATURITY_PROBE_KINDS as readonly string[]).includes(value);
}

/**
 * The maturity verdict kinds (the per-row outcome vocabulary):
 *
 *   * `maturity-established` — the family's analysis is complete and
 *     trustworthy (fully cited, gapless, faithful, reconciled,
 *     honest) and its maturity report landed in the append-only
 *     report ledger;
 *   * `immaturity-honest` — the family's own recorded history does
 *     not support an analysis (no recorded lifecycle, or no
 *     generations): the run refuses honestly and nothing lands;
 *   * `maturity-invalid` — the run's mechanical shape is
 *     untrustworthy (an uncited claim, a gapped series, a
 *     misclassification, an unreconciled savings number, an
 *     insufficient-evidence trend, an estimated measurement): an
 *     internal honesty failure, never a passable outcome.
 */
export const MATURITY_VERDICTS = [
  "maturity-established",
  "immaturity-honest",
  "maturity-invalid",
] as const;

export type MaturityVerdictKind = (typeof MATURITY_VERDICTS)[number];

export function isMaturityVerdictKind(value: string): value is MaturityVerdictKind {
  return (MATURITY_VERDICTS as readonly string[]).includes(value);
}

/**
 * The honest refusal reasons (a maturity run refuses only when the
 * family's own recorded history genuinely justifies it):
 *
 *   * `family-unrecorded` — the cited workload family holds NO
 *     recorded lifecycle history at all (a phantom family);
 *   * `no-generations-recorded` — the family's history holds no
 *     promotion generations (nothing to analyze — an honest
 *     immaturity, never a fabricated trend).
 */
export const MATURITY_REFUSAL_REASONS = ["family-unrecorded", "no-generations-recorded"] as const;

export type MaturityRefusalReason = (typeof MATURITY_REFUSAL_REASONS)[number];

export function isMaturityRefusalReason(value: string): value is MaturityRefusalReason {
  return (MATURITY_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The curve-point source vocabulary: every learning-curve point must
 * cite RECORDED measurements only. `recorded` is the ONLY admissible
 * source — an `extrapolated` point (a number derived, not measured)
 * or a `fabricated` point (a number with no recorded basis at all)
 * FAILs the curve-series integrity and is named.
 */
export const CURVE_POINT_SOURCES = ["recorded", "extrapolated", "fabricated"] as const;

export type CurvePointSource = (typeof CURVE_POINT_SOURCES)[number];

export function isCurvePointSource(value: string): value is CurvePointSource {
  return (CURVE_POINT_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The recorded history shapes (the read-only input vocabulary)
// ---------------------------------------------------------------------------

/**
 * ONE recorded family lifecycle record — the read-only input unit the
 * maturity analysis generalizes from: a PROMOTED candidate (the
 * VAL-032 proposal that walked the FULL evidenced chain to
 * `promoted` through VAL-033..035), its candidate kind (the
 * displacement mechanism it embodies) and its recorded lifecycle
 * walk's evidence digest. Payload bytes never enter the record.
 */
export interface FamilyLifecycleRecord {
  /** The workload family the promoted candidate belongs to. */
  readonly familyId: string;
  /** The promoted candidate's stable proposal identity. */
  readonly proposalId: string;
  /** The displacement mechanism the candidate embodies (CANDIDATE_KINDS). */
  readonly kind: CandidateKind;
  /** The promotion generation the candidate landed in (1-based). */
  readonly generation: number;
  /** The recorded walk's evidence digest (the promoted landing's evidence). */
  readonly evidenceDigest: string;
}

/** The canonical digest over one family lifecycle record (PURE, payload-free). */
export function familyLifecycleDigestOf(record: FamilyLifecycleRecord): string {
  return longitudinalDigestOf([
    "family-lifecycle",
    record.familyId,
    record.proposalId,
    record.kind,
    record.generation,
    record.evidenceDigest,
  ]);
}

/**
 * ONE recorded promotion generation — the read-only measurement unit
 * of the learning curve: the family's per-generation model-call facts
 * (the baseline incumbent model calls vs the displaced model calls
 * the promoted replacements took over), the MEASURED cost/latency of
 * the generation's executions, and the per-mechanism displacement
 * counts (reuse / cache / competence / deterministicization — the
 * CANDIDATE_KINDS vocabulary, attributed separately). A generation
 * whose measurements are ABSENT (`measured: false`) FAILs the
 * curve-series integrity — a curve point must cite recorded
 * measurements only.
 */
export interface PromotionGenerationRecord {
  readonly familyId: string;
  /** 1-based generation ordinal within the family's series. */
  readonly generation: number;
  /** The incumbent model calls the generation started from (the baseline). */
  readonly baselineModelCalls: number;
  /** The model calls DISPLACED by promoted replacements in this generation. */
  readonly displacedModelCalls: number;
  /** The MEASURED cost of the generation's executions (micro-USD). */
  readonly measuredCostMicroUsd: number;
  /** The MEASURED latency of the generation's executions (ms). */
  readonly measuredLatencyMs: number;
  /** The per-mechanism displacement counts (attributed separately). */
  readonly perMechanismDisplacements: Readonly<Record<CandidateKind, number>>;
  /** Whether the generation's cost/latency were MEASURED (never estimated). */
  readonly measured: boolean;
  /** The promoted candidates the generation landed (the lifecycle citations). */
  readonly lifecycleProposalIds: readonly string[];
}

/** The canonical digest over one promotion generation (PURE, payload-free). */
export function generationRecordDigestOf(record: PromotionGenerationRecord): string {
  return longitudinalDigestOf([
    "promotion-generation",
    record.familyId,
    record.generation,
    record.baselineModelCalls,
    record.displacedModelCalls,
    record.measuredCostMicroUsd,
    record.measuredLatencyMs,
    [
      record.perMechanismDisplacements.reuse,
      record.perMechanismDisplacements.cache,
      record.perMechanismDisplacements.competence,
      record.perMechanismDisplacements.deterministicization,
    ],
    record.measured,
    record.lifecycleProposalIds,
  ]);
}

/**
 * ONE recorded accounting ledger entry — the read-only savings basis:
 * the per-mechanism measured savings a generation's displacements
 * produced (the incumbent's measured cost minus the replacement's
 * measured cost per displaced call, aggregated per mechanism). Every
 * claimed savings number must reconcile against THESE entries — a
 * number that does not match FAILs with both sides named.
 */
export interface AccountingLedgerEntry {
  readonly familyId: string;
  /** The generation the savings were measured in (1-based). */
  readonly generation: number;
  /** The mechanism the savings are attributed to (a CANDIDATE_KINDS member). */
  readonly mechanism: CandidateKind;
  /** The MEASURED savings for this mechanism in this generation (micro-USD). */
  readonly microUsd: number;
  /** The MEASURED latency delta for this mechanism in this generation (ms). */
  readonly latencyDeltaMs: number;
}

/** The canonical digest over one accounting ledger entry (PURE, payload-free). */
export function accountingEntryDigestOf(entry: AccountingLedgerEntry): string {
  return longitudinalDigestOf([
    "accounting-entry",
    entry.familyId,
    entry.generation,
    entry.mechanism,
    entry.microUsd,
    entry.latencyDeltaMs,
  ]);
}

/**
 * The claimed savings attribution (the analysis's savings claim): the
 * per-mechanism breakdown attributed SEPARATELY over the
 * CANDIDATE_KINDS vocabulary. `perMechanism: null` is the
 * AGGREGATE-ONLY shape — an aggregate number without its
 * per-mechanism breakdown FAILs the savings reconciliation.
 */
export interface SavingsAttribution {
  readonly totalMicroUsd: number;
  readonly perMechanism: Readonly<Record<CandidateKind, number>> | null;
}

/** The canonical digest over a savings attribution (PURE, payload-free). */
export function savingsAttributionDigestOf(attribution: SavingsAttribution): string {
  return longitudinalDigestOf([
    "savings-attribution",
    attribution.totalMicroUsd,
    attribution.perMechanism === null
      ? null
      : [
          attribution.perMechanism.reuse,
          attribution.perMechanism.cache,
          attribution.perMechanism.competence,
          attribution.perMechanism.deterministicization,
        ],
  ]);
}

/**
 * The evidence citation a maturity claim carries: the lifecycle
 * records, promotion generations and accounting measurements it
 * generalizes from. The CANONICAL citation cites the FULL population
 * (every recorded member); anything less FAILs completeness.
 */
export interface MaturityEvidenceCitation {
  /** The cited promoted candidates (every recorded lifecycle record). */
  readonly lifecycleProposalIds: readonly string[];
  /** The cited generation digests (every recorded generation). */
  readonly generationDigests: readonly string[];
  /** The cited accounting entry digests (every recorded ledger entry). */
  readonly accountingEntryDigests: readonly string[];
}

/**
 * The canonical FULL-population citation (PURE): every recorded
 * lifecycle proposal id, every recorded generation digest and every
 * recorded accounting entry digest for the family. A generalization
 * cites its FULL population — anything less FAILs.
 */
export function canonicalMaturityCitationOf(input: {
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  readonly generations: readonly PromotionGenerationRecord[];
  readonly accountingEntries: readonly AccountingLedgerEntry[];
}): MaturityEvidenceCitation {
  return {
    lifecycleProposalIds: input.lifecycleRecords.map((record) => record.proposalId),
    generationDigests: input.generations.map((record) => generationRecordDigestOf(record)),
    accountingEntryDigests: input.accountingEntries.map((entry) => accountingEntryDigestOf(entry)),
  };
}

/**
 * The canonical digest over a maturity evidence citation (PURE,
 * payload-free): the citation fingerprint the report ledger's
 * evidence carries.
 */
export function maturityCitationDigestOf(citation: MaturityEvidenceCitation): string {
  return longitudinalDigestOf([
    "maturity-citation",
    citation.lifecycleProposalIds,
    citation.generationDigests,
    citation.accountingEntryDigests,
  ]);
}

// ---------------------------------------------------------------------------
// The curve-point shape (the learning-curve's analysis unit)
// ---------------------------------------------------------------------------

/**
 * ONE learning-curve point — the analysis's per-generation fact: the
 * generation ordinal, the family, the MEASURED facts (the baseline and
 * displaced model calls, the measured cost/latency, the per-mechanism
 * displacement counts) and the point's citations (the generation digest
 * + the lifecycle/accounting evidence it cites). The point carries the
 * generation's FULL digest-relevant fact set so the boundary
 * re-derivation can reconstruct the recorded generation EXACTLY (the
 * point's own facts hash back to its `generationDigest`). A point's
 * `source` must be `recorded` — an extrapolated or fabricated point
 * FAILs the curve-series integrity and is named.
 */
export interface CurvePointShape {
  readonly familyId: string;
  /** 1-based generation ordinal. */
  readonly generation: number;
  /** The baseline incumbent model calls the generation started from. */
  readonly baselineModelCalls: number;
  /** The displaced model calls (the measured reduction). */
  readonly displacedModelCalls: number;
  /** The measured cost at this generation (micro-USD). */
  readonly measuredCostMicroUsd: number;
  /** The measured latency at this generation (ms). */
  readonly measuredLatencyMs: number;
  /** The per-mechanism displacement counts attributed at this generation. */
  readonly perMechanismDisplacements: Readonly<Record<CandidateKind, number>>;
  /** Whether the point's measurements are present (a generation with absent measurements FAILs). */
  readonly measured: boolean;
  /** The point's provenance: recorded / extrapolated / fabricated. */
  readonly pointSource: CurvePointSource;
  /** The recorded generation digest the point cites (empty = uncited). */
  readonly generationDigest: string;
  /** The lifecycle proposals the point cites. */
  readonly lifecycleProposalIds: readonly string[];
}

/** The canonical digest over one curve point (PURE, payload-free). */
export function curvePointDigestOf(point: CurvePointShape): string {
  return longitudinalDigestOf([
    "curve-point",
    point.familyId,
    point.generation,
    point.baselineModelCalls,
    point.displacedModelCalls,
    point.measuredCostMicroUsd,
    point.measuredLatencyMs,
    [
      point.perMechanismDisplacements.reuse,
      point.perMechanismDisplacements.cache,
      point.perMechanismDisplacements.competence,
      point.perMechanismDisplacements.deterministicization,
    ],
    point.measured,
    point.pointSource,
    point.generationDigest,
    point.lifecycleProposalIds,
  ]);
}

/**
 * Build the CANONICAL curve series from the recorded generations
 * (PURE — the honest analysis's own construction): one point per
 * recorded generation, every point citing its recorded generation
 * digest and lifecycle proposals, every point's source `recorded`.
 * The canonical series never extrapolates and never fabricates.
 */
export function canonicalCurveSeriesOf(
  familyId: string,
  generations: readonly PromotionGenerationRecord[],
): readonly CurvePointShape[] {
  return [...generations]
    .sort((left, right) => left.generation - right.generation)
    .map((generation) => ({
      familyId,
      generation: generation.generation,
      baselineModelCalls: generation.baselineModelCalls,
      displacedModelCalls: generation.displacedModelCalls,
      measuredCostMicroUsd: generation.measuredCostMicroUsd,
      measuredLatencyMs: generation.measuredLatencyMs,
      perMechanismDisplacements: { ...generation.perMechanismDisplacements },
      measured: generation.measured,
      pointSource: "recorded" as const,
      generationDigest: generationRecordDigestOf(generation),
      lifecycleProposalIds: [...generation.lifecycleProposalIds],
    }));
}

// ---------------------------------------------------------------------------
// The observed classification (the pinned thresholds — PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the family's OBSERVED maturity classification (PURE — the
 * pinned thresholds, never a judgment call): a family with fewer than
 * `minimumGenerationsForTrend` recorded generations is
 * `immature-insufficient-evidence` (the honest verdict — NEVER
 * stretched); a family with zero model-call variance AND full
 * displacement (every generation's displacement fraction = 1) across
 * the last `stabilityWindow` generations is `determinized-stable`; a
 * family whose displaced model calls grow monotonically (non-
 * decreasing with at least one strict increase) over at least the
 * minimum generations is `determinizing-trending`; otherwise the
 * family shows recurring variance across generations and is
 * `variable-resilient` (reported honestly with its observed
 * distribution).
 */
export function observedMaturityClassificationOf(
  generations: readonly PromotionGenerationRecord[],
  minimumGenerationsForTrend: number = MINIMUM_GENERATIONS_FOR_TREND,
  stabilityWindow: number = STABILITY_WINDOW_GENERATIONS,
): MaturityClassification {
  if (generations.length < minimumGenerationsForTrend) {
    return "immature-insufficient-evidence";
  }
  const ordered = [...generations].sort((left, right) => left.generation - right.generation);
  const window = ordered.slice(Math.max(0, ordered.length - stabilityWindow));
  const displacementFractionOf = (generation: PromotionGenerationRecord): number => {
    if (generation.baselineModelCalls <= 0) {
      return 0;
    }
    return generation.displacedModelCalls / generation.baselineModelCalls;
  };
  const fullDisplacementAcrossWindow = window.every(
    (generation) => displacementFractionOf(generation) >= 1,
  );
  const zeroVarianceAcrossWindow = window.every(
    (generation) => generation.displacedModelCalls === (window[0]?.displacedModelCalls ?? 0),
  );
  if (fullDisplacementAcrossWindow && zeroVarianceAcrossWindow) {
    return "determinized-stable";
  }
  const monotoneGrowth = ordered.every(
    (generation, index) =>
      index === 0 ||
      generation.displacedModelCalls >= (ordered[index - 1]?.displacedModelCalls ?? 0),
  );
  const strictIncreaseSomewhere = ordered.some(
    (generation, index) =>
      index > 0 && generation.displacedModelCalls > (ordered[index - 1]?.displacedModelCalls ?? 0),
  );
  if (monotoneGrowth && strictIncreaseSomewhere) {
    return "determinizing-trending";
  }
  return "variable-resilient";
}

/**
 * Whether a claimed classification DEMANDS more evidence than the
 * family holds (PURE): a `determinized-stable` or
 * `determinizing-trending` claim over fewer than the minimum
 * generations is evidence-stretching — the family must be classified
 * `immature-insufficient-evidence` instead.
 */
export function isEvidenceStretchingClaim(
  claimed: MaturityClassification,
  recordedGenerationCount: number,
  minimumGenerationsForTrend: number = MINIMUM_GENERATIONS_FOR_TREND,
): boolean {
  if (claimed === "determinized-stable" || claimed === "determinizing-trending") {
    return recordedGenerationCount < minimumGenerationsForTrend;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The maturity report record (the append-only artifact)
// ---------------------------------------------------------------------------

/**
 * ONE recorded maturity report — the analysis's ONLY artifact,
 * appended to the report ledger: the family, the honest
 * classification, the curve series's canonical digest members, the
 * savings attribution and the evidence citation digest. The report
 * ledger is APPEND-ONLY: an identical re-append REPLAYS (idempotent),
 * a different report under the same family FAILs the driver
 * mechanically.
 */
export interface MaturityReportRecord {
  readonly familyId: string;
  readonly classification: MaturityClassification;
  /** The curve series's point digests (in generation order). */
  readonly curvePointDigests: readonly string[];
  /** The savings attribution the report carries (per-mechanism). */
  readonly savings: SavingsAttribution;
  /** The evidence citation digest (the full population's fingerprint). */
  readonly citationDigest: string;
  /** 1-based append order within the report ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one maturity report (PURE, payload-free). */
export function maturityReportDigestOf(record: Omit<MaturityReportRecord, "ordinal">): string {
  return longitudinalDigestOf([
    "maturity-report",
    record.familyId,
    record.classification,
    record.curvePointDigests,
    savingsAttributionDigestOf(record.savings),
    record.citationDigest,
  ]);
}

// ---------------------------------------------------------------------------
// The read-only analysis port + the append-only report port
// ---------------------------------------------------------------------------

/**
 * The maturity analysis port (the READ-ONLY input): the RECORDED
 * lifecycle history (VAL-032..035's registries, walks and ledgers)
 * the analysis generalizes from. The maturity run NEVER rewrites a
 * recorded record; an analysis port whose facts digest changes over a
 * run FAILs the read-only discipline mechanically.
 */
export interface MaturityAnalysisPort {
  /** The family's recorded promoted-candidate lifecycle records. */
  lifecycleFor(familyId: string): readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (the measurement series). */
  generationsFor(familyId: string): readonly PromotionGenerationRecord[];
  /** The family's recorded accounting ledger entries (the savings basis). */
  accountingFor(familyId: string): readonly AccountingLedgerEntry[];
  /** The candidate registry's read-only proposal view (the cited identities). */
  proposalFor(proposalId: string): DiscoveryProposalRecord | null;
  /** The port's own frozen facts (the read-only fingerprint's basis). */
  facts(): MaturityAnalysisFacts;
}

/** The read-only analysis facts (the input fingerprint's basis). */
export interface MaturityAnalysisFacts {
  /** Every family the recorded history knows (sorted). */
  readonly familyIds: readonly string[];
  /** The number of recorded lifecycle records (the promoted walks). */
  readonly lifecycleRecordCount: number;
  /** The number of recorded promotion generations. */
  readonly generationRecordCount: number;
  /** The number of recorded accounting ledger entries. */
  readonly accountingEntryCount: number;
  /** The registry's proposal ids (sorted — the cited-identity basis). */
  readonly registryProposalIds: readonly string[];
}

/**
 * The canonical digest over the analysis port's facts (PURE — the
 * read-only fingerprint the driver snapshots before and after every
 * run: the recorded history is a frozen input).
 */
export function maturityInputDigestOf(facts: MaturityAnalysisFacts): string {
  return longitudinalDigestOf([
    "maturity-input",
    facts.familyIds,
    facts.lifecycleRecordCount,
    facts.generationRecordCount,
    facts.accountingEntryCount,
    facts.registryProposalIds,
  ]);
}

/**
 * The maturity report port (APPEND-ONLY): the analysis APPENDS its
 * maturity reports — an identical re-append REPLAYS (idempotent), a
 * different report under the same familyId is REFUSED, and a report
 * ledger that mutates the recorded history FAILs the driver
 * mechanically.
 */
export interface MaturityReportPort {
  append(record: Omit<MaturityReportRecord, "ordinal">): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }>;
  reportsFor(familyId: string): readonly MaturityReportRecord[];
}

// ---------------------------------------------------------------------------
// Evidence-citation completeness (the maturity oracle's citation leg)
// ---------------------------------------------------------------------------

/** The maturity evidence-citation verdict. */
export interface MaturityEvidenceCitationVerdict {
  /** Every cited member is a population member AND the full population is cited. */
  readonly complete: boolean;
  readonly populationLifecycleCount: number;
  readonly populationGenerationCount: number;
  readonly populationAccountingCount: number;
  /** Cited lifecycle proposals that are NOT members of the recorded population (phantom). */
  readonly phantomLifecycleProposalIds: readonly string[];
  /** Cited generation digests that are NOT members of the recorded population (phantom). */
  readonly phantomGenerationDigests: readonly string[];
  /** Cited accounting digests that are NOT members of the recorded population (phantom). */
  readonly phantomAccountingDigests: readonly string[];
  /** Recorded lifecycle members the citation MISSED (uncited / partial). */
  readonly uncitedLifecycleProposalIds: readonly string[];
  /** Recorded generation members the citation MISSED (uncited / partial). */
  readonly uncitedGenerationDigests: readonly string[];
  /** Recorded accounting members the citation MISSED (uncited / partial). */
  readonly uncitedAccountingDigests: readonly string[];
  /** A generalization demands at least one recorded generation (an empty population is not evidence). */
  readonly minimumEvidence: boolean;
  readonly citationDigest: string;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the maturity evidence-citation completeness (PURE — the
 * maturity oracle's citation leg): every maturity claim cites its
 * FULL evidence population — the lifecycle records, the promotion
 * generations and the accounting measurements it generalizes from.
 * A PHANTOM citation (a cited member that is not in the recorded
 * population) FAILs with the member named; an UNCITED claim (a
 * citation missing recorded members — a partial population) FAILs
 * with the missed members named; and the population must hold at
 * least one recorded generation (a generalization from an empty
 * population FAILs).
 */
export function deriveMaturityEvidenceCitation(input: {
  /** The family's recorded lifecycle records (the read-only population). */
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (the read-only population). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The family's recorded accounting entries (the read-only population). */
  readonly accountingEntries: readonly AccountingLedgerEntry[];
  /** The maturity claim's evidence citation under test. */
  readonly citation: MaturityEvidenceCitation;
}): MaturityEvidenceCitationVerdict {
  const populationLifecycle = input.lifecycleRecords.map((record) => record.proposalId);
  const populationGenerationDigests = input.generations.map((record) =>
    generationRecordDigestOf(record),
  );
  const populationAccountingDigests = input.accountingEntries.map((entry) =>
    accountingEntryDigestOf(entry),
  );
  const citedLifecycle = [...new Set(input.citation.lifecycleProposalIds)];
  const citedGenerationDigests = [...new Set(input.citation.generationDigests)];
  const citedAccountingDigests = [...new Set(input.citation.accountingEntryDigests)];

  const phantomLifecycleProposalIds = citedLifecycle.filter(
    (proposalId) => !populationLifecycle.includes(proposalId),
  );
  const phantomGenerationDigests = citedGenerationDigests.filter(
    (digest) => !populationGenerationDigests.includes(digest),
  );
  const phantomAccountingDigests = citedAccountingDigests.filter(
    (digest) => !populationAccountingDigests.includes(digest),
  );
  const uncitedLifecycleProposalIds = populationLifecycle.filter(
    (proposalId) => !citedLifecycle.includes(proposalId),
  );
  const uncitedGenerationDigests = populationGenerationDigests.filter(
    (digest) => !citedGenerationDigests.includes(digest),
  );
  const uncitedAccountingDigests = populationAccountingDigests.filter(
    (digest) => !citedAccountingDigests.includes(digest),
  );
  const minimumEvidence = input.generations.length >= 1;

  const complete =
    phantomLifecycleProposalIds.length === 0 &&
    phantomGenerationDigests.length === 0 &&
    phantomAccountingDigests.length === 0 &&
    uncitedLifecycleProposalIds.length === 0 &&
    uncitedGenerationDigests.length === 0 &&
    uncitedAccountingDigests.length === 0 &&
    minimumEvidence;

  return {
    complete,
    populationLifecycleCount: input.lifecycleRecords.length,
    populationGenerationCount: input.generations.length,
    populationAccountingCount: input.accountingEntries.length,
    phantomLifecycleProposalIds,
    phantomGenerationDigests,
    phantomAccountingDigests,
    uncitedLifecycleProposalIds,
    uncitedGenerationDigests,
    uncitedAccountingDigests,
    minimumEvidence,
    citationDigest: maturityCitationDigestOf(input.citation),
    criteria: [
      {
        criterionId: "citation-no-phantom-members",
        strategy: "deterministic",
        status:
          phantomLifecycleProposalIds.length === 0 &&
          phantomGenerationDigests.length === 0 &&
          phantomAccountingDigests.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `phantomLifecycle:${phantomLifecycleProposalIds.join(",") || "none"}`,
          `phantomGenerations:${phantomGenerationDigests.join(",") || "none"}`,
          `phantomAccounting:${phantomAccountingDigests.join(",") || "none"}`,
          phantomLifecycleProposalIds.length === 0 &&
          phantomGenerationDigests.length === 0 &&
          phantomAccountingDigests.length === 0
            ? "every-cited-member-is-a-recorded-population-member"
            : "PHANTOM-CITATION (a cited member is not in the recorded population — a fabricated citation)",
        ],
      },
      {
        criterionId: "citation-full-population",
        strategy: "deterministic",
        status:
          uncitedLifecycleProposalIds.length === 0 &&
          uncitedGenerationDigests.length === 0 &&
          uncitedAccountingDigests.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `populationLifecycle:${populationLifecycle.length}`,
          `populationGenerations:${populationGenerationDigests.length}`,
          `populationAccounting:${populationAccountingDigests.length}`,
          `uncitedLifecycle:${uncitedLifecycleProposalIds.join(",") || "none"}`,
          `uncitedGenerations:${uncitedGenerationDigests.join(",") || "none"}`,
          `uncitedAccounting:${uncitedAccountingDigests.join(",") || "none"}`,
          uncitedLifecycleProposalIds.length === 0 &&
          uncitedGenerationDigests.length === 0 &&
          uncitedAccountingDigests.length === 0
            ? "the-citation-cites-the-full-recorded-population"
            : "PARTIAL-POPULATION (a recorded member the citation missed — an uncited claim)",
        ],
      },
      {
        criterionId: "citation-minimum-evidence",
        strategy: "deterministic",
        status: minimumEvidence ? "PASS" : "FAIL",
        evidence: [
          `recordedGenerations:${input.generations.length}`,
          minimumEvidence
            ? "the-population-holds-at-least-one-recorded-generation"
            : "EMPTY-POPULATION (a generalization from an empty population is not evidence)",
        ],
      },
      {
        criterionId: "citation-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `citationDigest:${maturityCitationDigestOf(input.citation)}`,
          `phantoms:${phantomLifecycleProposalIds.length + phantomGenerationDigests.length + phantomAccountingDigests.length}`,
          `uncited:${uncitedLifecycleProposalIds.length + uncitedGenerationDigests.length + uncitedAccountingDigests.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Curve-series integrity (gapless generations, recorded measurements only)
// ---------------------------------------------------------------------------

/** The curve-series integrity verdict. */
export interface CurveSeriesIntegrityVerdict {
  /** The series is gapless, measured and cites recorded generations only. */
  readonly integral: boolean;
  /** The series' generation ordinals, in series order. */
  readonly seriesGenerations: readonly number[];
  /** The generation ordinals MISSING from the series (a gapped series). */
  readonly missingGenerations: readonly number[];
  /** Generation ordinals whose measurements are ABSENT (measured=false). */
  readonly unmeasuredGenerations: readonly number[];
  /** Points whose source is EXTRAPOLATED (named by generation). */
  readonly extrapolatedGenerations: readonly number[];
  /** Points whose source is FABRICATED (named by generation). */
  readonly fabricatedGenerations: readonly number[];
  /** Points whose cited generation digest is not a recorded generation's digest. */
  readonly unrecordedDigestGenerations: readonly number[];
  /** A curve demands at least one point (an empty series is not a curve). */
  readonly minimumSeries: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the curve-series integrity (PURE — the learning-curve's
 * oracle): the generation series is GAPLESS — the ordinals run 1..N
 * with no hole (a MISSING generation FAILs, named) — every generation
 * holds its MEASUREMENTS (a generation whose measurements are absent
 * FAILs, named), and every point cites RECORDED measurements only:
 * a point whose source is `extrapolated` (a derived, not measured
 * number) or `fabricated` (a number with no recorded basis) FAILs and
 * is NAMED (by its generation ordinal), as does a point whose cited
 * generation digest is not one of the recorded generations' digests.
 */
export function deriveCurveSeriesIntegrity(input: {
  /** The family's recorded promotion generations (the read-only basis). */
  readonly recordedGenerations: readonly PromotionGenerationRecord[];
  /** The claimed curve series under test (in claimed generation order). */
  readonly points: readonly CurvePointShape[];
}): CurveSeriesIntegrityVerdict {
  const seriesGenerations = input.points.map((point) => point.generation);
  const maximum = seriesGenerations.reduce((max, generation) => Math.max(max, generation), 0);
  const expectedOrdinals: number[] = [];
  for (let ordinal = 1; ordinal <= maximum; ordinal += 1) {
    expectedOrdinals.push(ordinal);
  }
  const missingGenerations = expectedOrdinals.filter(
    (ordinal) => !seriesGenerations.includes(ordinal),
  );
  const unmeasuredGenerations = input.points
    .filter((point) => !point.measured)
    .map((point) => point.generation);
  const extrapolatedGenerations = input.points
    .filter((point) => point.pointSource === "extrapolated")
    .map((point) => point.generation);
  const fabricatedGenerations = input.points
    .filter((point) => point.pointSource === "fabricated")
    .map((point) => point.generation);
  const recordedGenerationDigests = new Set(
    input.recordedGenerations.map((record) => generationRecordDigestOf(record)),
  );
  const unrecordedDigestGenerations = input.points
    .filter(
      (point) =>
        point.generationDigest.length === 0 ||
        !recordedGenerationDigests.has(point.generationDigest),
    )
    .map((point) => point.generation);
  const minimumSeries = input.points.length >= 1;

  const integral =
    missingGenerations.length === 0 &&
    unmeasuredGenerations.length === 0 &&
    extrapolatedGenerations.length === 0 &&
    fabricatedGenerations.length === 0 &&
    unrecordedDigestGenerations.length === 0 &&
    minimumSeries;

  return {
    integral,
    seriesGenerations,
    missingGenerations,
    unmeasuredGenerations,
    extrapolatedGenerations,
    fabricatedGenerations,
    unrecordedDigestGenerations,
    minimumSeries,
    criteria: [
      {
        criterionId: "curve-series-gapless",
        strategy: "deterministic",
        status: missingGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `seriesGenerations:${seriesGenerations.join(",") || "none"}`,
          `missingGenerations:${missingGenerations.join(",") || "none"}`,
          missingGenerations.length === 0
            ? "the-generation-series-is-gapless (ordinals 1..N, no hole)"
            : "GAPPED-SERIES (a generation is missing from the series — a learning-curve claim from a gapped series never passes)",
        ],
      },
      {
        criterionId: "curve-every-generation-measured",
        strategy: "deterministic",
        status: unmeasuredGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `points:${input.points.length}`,
          `unmeasuredGenerations:${unmeasuredGenerations.join(",") || "none"}`,
          unmeasuredGenerations.length === 0
            ? "every-generation-holds-its-measurements"
            : "ABSENT-MEASUREMENTS (a generation whose measurements are absent — a curve point must cite recorded measurements)",
        ],
      },
      {
        criterionId: "curve-recorded-measurements-only",
        strategy: "deterministic",
        status:
          extrapolatedGenerations.length === 0 && fabricatedGenerations.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `extrapolatedGenerations:${extrapolatedGenerations.join(",") || "none"}`,
          `fabricatedGenerations:${fabricatedGenerations.join(",") || "none"}`,
          extrapolatedGenerations.length === 0 && fabricatedGenerations.length === 0
            ? "every-curve-point-cites-recorded-measurements-only"
            : "UNRECORDED-POINT (a curve point is extrapolated or fabricated — never a measured fact)",
        ],
      },
      {
        criterionId: "curve-points-cite-recorded-generations",
        strategy: "deterministic",
        status: unrecordedDigestGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `recordedGenerationCount:${input.recordedGenerations.length}`,
          `unrecordedDigestGenerations:${unrecordedDigestGenerations.join(",") || "none"}`,
          unrecordedDigestGenerations.length === 0
            ? "every-points-cited-generation-digest-is-a-recorded-generations-digest"
            : "UNRECORDED-GENERATION-DIGEST (a point cites a digest the recorded generations do not hold)",
        ],
      },
      {
        criterionId: "curve-minimum-series",
        strategy: "deterministic",
        status: minimumSeries ? "PASS" : "FAIL",
        evidence: [
          `points:${input.points.length}`,
          minimumSeries
            ? "the-series-holds-at-least-one-point"
            : "EMPTY-SERIES (an empty curve is not a learning curve)",
        ],
      },
      {
        criterionId: "curve-integrity-summary",
        strategy: "deterministic",
        status: integral ? "PASS" : "FAIL",
        evidence: [
          `integral:${String(integral)}`,
          `points:${input.points.length}`,
          `missing:${missingGenerations.length}`,
          `unmeasured:${unmeasuredGenerations.length}`,
          `extrapolated:${extrapolatedGenerations.length}`,
          `fabricated:${fabricatedGenerations.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Classification fidelity (the verdict matches the observed data)
// ---------------------------------------------------------------------------

/** The maturity classification-fidelity verdict. */
export interface MaturityClassificationVerdict {
  /** The claimed classification matches the observed classification. */
  readonly fidelity: boolean;
  /** The classification the analysis CLAIMS. */
  readonly claimed: MaturityClassification;
  /** The classification the OBSERVED data pins (the pure thresholds). */
  readonly observed: MaturityClassification;
  /** Whether the claim stretched insufficient evidence into a trend. */
  readonly stretchedTrend: boolean;
  /** The recorded generation count (the evidence basis). */
  readonly recordedGenerationCount: number;
  /** The observed per-generation displaced model calls (the honest distribution). */
  readonly observedDisplacedModelCalls: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the maturity classification fidelity (PURE — the verdict's
 * oracle): the claimed classification must MATCH the observed data —
 * the pure thresholds of `observedMaturityClassificationOf` over the
 * recorded generations. A variable-resilient family classified
 * determinized-stable FAILs (and vice versa) with BOTH sides named
 * (claimed vs observed); a family with fewer than the minimum
 * generations MUST be classified immature-insufficient-evidence — a
 * trend or stability claim from insufficient evidence FAILs as
 * evidence-stretching (NEVER stretched into a trend).
 */
export function deriveMaturityClassification(input: {
  /** The family's recorded promotion generations (the observed data). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The classification the analysis claims. */
  readonly claimed: MaturityClassification;
  /** The minimum generations a trend claim demands (defaults to the pin). */
  readonly minimumGenerationsForTrend?: number;
  /** The stability window K (defaults to the pin). */
  readonly stabilityWindow?: number;
}): MaturityClassificationVerdict {
  const minimum = input.minimumGenerationsForTrend ?? MINIMUM_GENERATIONS_FOR_TREND;
  const window = input.stabilityWindow ?? STABILITY_WINDOW_GENERATIONS;
  const observed = observedMaturityClassificationOf(input.generations, minimum, window);
  const stretchedTrend = isEvidenceStretchingClaim(
    input.claimed,
    input.generations.length,
    minimum,
  );
  const fidelity = observed === input.claimed && !stretchedTrend;
  const observedDisplacedModelCalls = [...input.generations]
    .sort((left, right) => left.generation - right.generation)
    .map((generation) => generation.displacedModelCalls);

  return {
    fidelity,
    claimed: input.claimed,
    observed,
    stretchedTrend,
    recordedGenerationCount: input.generations.length,
    observedDisplacedModelCalls,
    criteria: [
      {
        criterionId: "classification-fidelity",
        strategy: "deterministic",
        status: observed === input.claimed ? "PASS" : "FAIL",
        evidence: [
          `claimed:${input.claimed}`,
          `observed:${observed}`,
          `recordedGenerations:${input.generations.length}`,
          `observedDisplacedModelCalls:${observedDisplacedModelCalls.join(",") || "none"}`,
          observed === input.claimed
            ? "the-verdict-matches-the-observed-data (the pinned thresholds)"
            : "MISCLASSIFIED-FAMILY (the claimed classification contradicts the observed data — a variable family claimed stable, or a stable family claimed variable)",
        ],
      },
      {
        criterionId: "classification-no-evidence-stretching",
        strategy: "deterministic",
        status: stretchedTrend ? "FAIL" : "PASS",
        evidence: [
          `claimed:${input.claimed}`,
          `recordedGenerations:${input.generations.length}`,
          `minimumGenerationsForTrend:${minimum}`,
          stretchedTrend
            ? "INSUFFICIENT-EVIDENCE-TREND (a trend claim from fewer than the minimum generations — the family must be classified immature-insufficient-evidence)"
            : "no-evidence-stretching (the claim's evidence basis meets its pinned minimum)",
        ],
      },
      {
        criterionId: "classification-fidelity-summary",
        strategy: "deterministic",
        status: fidelity ? "PASS" : "FAIL",
        evidence: [
          `fidelity:${String(fidelity)}`,
          `claimed:${input.claimed}`,
          `observed:${observed}`,
          `stretchedTrend:${String(stretchedTrend)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Savings reconciliation (per-mechanism, ledger-matched)
// ---------------------------------------------------------------------------

/** ONE per-mechanism savings mismatch (both sides named). */
export interface SavingsMismatch {
  /** The mechanism whose claimed number does not match the ledger. */
  readonly mechanism: CandidateKind;
  /** The analysis's claimed savings for the mechanism (micro-USD). */
  readonly claimedMicroUsd: number;
  /** The recorded ledger's measured savings for the mechanism (micro-USD). */
  readonly recordedMicroUsd: number;
}

/** The savings-reconciliation verdict. */
export interface SavingsReconciliationVerdict {
  /** The claimed savings carry their per-mechanism breakdown AND match the ledgers. */
  readonly reconciled: boolean;
  /** Whether the per-mechanism breakdown is present (an aggregate-only claim FAILs). */
  readonly perMechanismPresent: boolean;
  /** The per-mechanism mismatches (both sides named). */
  readonly mismatchedMechanisms: readonly SavingsMismatch[];
  /** Whether the claimed TOTAL matches the recorded ledger total. */
  readonly totalMatchesLedger: boolean;
  /** Whether the per-mechanism numbers SUM to the claimed total. */
  readonly breakdownSumsToTotal: boolean;
  /** The recorded ledger total (micro-USD). */
  readonly recordedTotalMicroUsd: number;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the savings reconciliation (PURE — the economics' oracle):
 * every generation's reported savings must reconcile with the
 * RECORDED accounting — per-mechanism (reuse / cache / competence /
 * deterministicization attributed SEPARATELY over the CANDIDATE_KINDS
 * vocabulary). An AGGREGATE number WITHOUT its per-mechanism
 * breakdown FAILs (`perMechanism: null`); a per-mechanism number that
 * does not match the recorded ledger entries for that mechanism
 * FAILs with BOTH sides named (claimed vs recorded); the breakdown
 * must SUM to the claimed total; and the claimed total must match
 * the recorded ledger total.
 */
export function deriveSavingsReconciliation(input: {
  /** The family's recorded accounting ledger entries (the savings basis). */
  readonly accountingLedger: readonly AccountingLedgerEntry[];
  /** The analysis's claimed savings attribution. */
  readonly claimedSavings: SavingsAttribution;
}): SavingsReconciliationVerdict {
  const recordedByMechanism = new Map<CandidateKind, number>();
  for (const kind of CANDIDATE_KINDS) {
    recordedByMechanism.set(kind, 0);
  }
  for (const entry of input.accountingLedger) {
    recordedByMechanism.set(
      entry.mechanism,
      (recordedByMechanism.get(entry.mechanism) ?? 0) + entry.microUsd,
    );
  }
  const recordedTotalMicroUsd = input.accountingLedger.reduce(
    (total, entry) => total + entry.microUsd,
    0,
  );

  const perMechanismPresent = input.claimedSavings.perMechanism !== null;
  const mismatchedMechanisms: SavingsMismatch[] = [];
  let breakdownSum = 0;
  if (input.claimedSavings.perMechanism !== null) {
    for (const kind of CANDIDATE_KINDS) {
      const claimed = input.claimedSavings.perMechanism[kind];
      const recorded = recordedByMechanism.get(kind) ?? 0;
      breakdownSum += claimed;
      if (claimed !== recorded) {
        mismatchedMechanisms.push({
          mechanism: kind,
          claimedMicroUsd: claimed,
          recordedMicroUsd: recorded,
        });
      }
    }
  }
  const breakdownSumsToTotal =
    input.claimedSavings.perMechanism === null
      ? false
      : breakdownSum === input.claimedSavings.totalMicroUsd;
  const totalMatchesLedger = input.claimedSavings.totalMicroUsd === recordedTotalMicroUsd;
  const reconciled =
    perMechanismPresent &&
    mismatchedMechanisms.length === 0 &&
    breakdownSumsToTotal &&
    totalMatchesLedger;

  return {
    reconciled,
    perMechanismPresent,
    mismatchedMechanisms,
    totalMatchesLedger,
    breakdownSumsToTotal,
    recordedTotalMicroUsd,
    criteria: [
      {
        criterionId: "savings-per-mechanism-breakdown-present",
        strategy: "deterministic",
        status: perMechanismPresent ? "PASS" : "FAIL",
        evidence: [
          `claimedTotal:${input.claimedSavings.totalMicroUsd}`,
          perMechanismPresent
            ? "the-claimed-savings-carry-their-per-mechanism-breakdown (reuse/cache/competence/deterministicization attributed separately)"
            : "AGGREGATE-ONLY (a savings number without its per-mechanism breakdown never passes)",
        ],
      },
      {
        criterionId: "savings-breakdown-matches-ledgers",
        strategy: "deterministic",
        status: mismatchedMechanisms.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `ledgerEntries:${input.accountingLedger.length}`,
          `mismatchedMechanisms:${mismatchedMechanisms.map((mismatch) => `${mismatch.mechanism}(claimed=${mismatch.claimedMicroUsd},recorded=${mismatch.recordedMicroUsd})`).join(";") || "none"}`,
          mismatchedMechanisms.length === 0
            ? "every-per-mechanism-number-matches-the-recorded-ledger"
            : "UNRECONCILED-SAVINGS (a claimed number that does not match the recorded ledgers — both sides named)",
        ],
      },
      {
        criterionId: "savings-breakdown-sums-to-total",
        strategy: "deterministic",
        status: breakdownSumsToTotal ? "PASS" : "FAIL",
        evidence: [
          `claimedTotal:${input.claimedSavings.totalMicroUsd}`,
          `breakdownSum:${input.claimedSavings.perMechanism === null ? "n/a" : breakdownSum}`,
          breakdownSumsToTotal
            ? "the-per-mechanism-breakdown-sums-to-the-claimed-total"
            : "BREAKDOWN-TOTAL-MISMATCH (the per-mechanism numbers do not sum to the claimed aggregate)",
        ],
      },
      {
        criterionId: "savings-total-matches-ledger",
        strategy: "deterministic",
        status: totalMatchesLedger ? "PASS" : "FAIL",
        evidence: [
          `claimedTotal:${input.claimedSavings.totalMicroUsd}`,
          `recordedTotal:${recordedTotalMicroUsd}`,
          totalMatchesLedger
            ? "the-claimed-total-matches-the-recorded-ledger-total"
            : "TOTAL-MISMATCH (the claimed aggregate does not match the recorded ledgers — both sides named)",
        ],
      },
      {
        criterionId: "savings-reconciliation-summary",
        strategy: "deterministic",
        status: reconciled ? "PASS" : "FAIL",
        evidence: [
          `reconciled:${String(reconciled)}`,
          `perMechanismPresent:${String(perMechanismPresent)}`,
          `mismatches:${mismatchedMechanisms.length}`,
          `totalMatchesLedger:${String(totalMatchesLedger)}`,
        ],
      },
    ],
  };
}

/**
 * Derive the CANONICAL savings attribution from the recorded
 * accounting ledger (PURE — the honest analysis's own construction):
 * the per-mechanism sums over the CANDIDATE_KINDS vocabulary, the
 * total their sum. The canonical attribution never reports an
 * aggregate without its breakdown.
 */
export function canonicalSavingsAttributionOf(
  accountingLedger: readonly AccountingLedgerEntry[],
): SavingsAttribution {
  const perMechanism = {} as Record<CandidateKind, number>;
  for (const kind of CANDIDATE_KINDS) {
    perMechanism[kind] = 0;
  }
  for (const entry of accountingLedger) {
    perMechanism[entry.mechanism] += entry.microUsd;
  }
  return {
    totalMicroUsd: CANDIDATE_KINDS.reduce((total, kind) => total + perMechanism[kind], 0),
    perMechanism,
  };
}

// ---------------------------------------------------------------------------
// Maturity honesty (measured, never estimated; honest boundaries)
// ---------------------------------------------------------------------------

/** The maturity-honesty verdict. */
export interface MaturityHonestyVerdict {
  /** Every measurement is measured (never estimated) and the boundaries are honest. */
  readonly honest: boolean;
  /** Generation ordinals whose cost/latency were ESTIMATED, not measured. */
  readonly estimatedGenerations: readonly number[];
  /** Whether the offline none-reported usage boundary is honest. */
  readonly noneReportedUsageHonest: boolean;
  /** Whether a fabricated usage was reported where none should be. */
  readonly fabricatedUsage: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the maturity honesty (PURE — the measurement-discipline
 * oracle): every generation's cost/latency must be MEASURED (never
 * estimated — a generation recorded with `measured: false` FAILs,
 * named) and the none-reported boundaries must be honest — offline,
 * the run's usage is honestly none-reported (`reportedUsage: null`),
 * and a FABRICATED usage reported offline FAILs. Usage is measured
 * only on the live rail.
 */
export function deriveMaturityHonesty(input: {
  /** The family's recorded promotion generations (the measurement basis). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The run's reported usage (null = honestly none-reported offline). */
  readonly reportedUsage: LabUsage | null;
  /** Whether the run executed on the live rail (measured usage admissible). */
  readonly liveRail: boolean;
}): MaturityHonestyVerdict {
  const estimatedGenerations = input.generations
    .filter((generation) => !generation.measured)
    .map((generation) => generation.generation);
  const fabricatedUsage = !input.liveRail && input.reportedUsage !== null;
  const noneReportedUsageHonest = input.liveRail || input.reportedUsage === null;
  const honest = estimatedGenerations.length === 0 && !fabricatedUsage && noneReportedUsageHonest;

  return {
    honest,
    estimatedGenerations,
    noneReportedUsageHonest,
    fabricatedUsage,
    criteria: [
      {
        criterionId: "honesty-measured-never-estimated",
        strategy: "deterministic",
        status: estimatedGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `generations:${input.generations.length}`,
          `estimatedGenerations:${estimatedGenerations.join(",") || "none"}`,
          estimatedGenerations.length === 0
            ? "every-generations-cost-and-latency-was-measured (never estimated)"
            : "ESTIMATED-MEASUREMENT (a generation's measurements were estimated, not measured — an honest benchmark never estimates)",
        ],
      },
      {
        criterionId: "honesty-none-reported-boundary",
        strategy: "deterministic",
        status: noneReportedUsageHonest ? "PASS" : "FAIL",
        evidence: [
          `liveRail:${String(input.liveRail)}`,
          `reportedUsage:${input.reportedUsage === null ? "none" : "present"}`,
          noneReportedUsageHonest
            ? input.liveRail
              ? "the-live-rails-usage-is-measured (the only place usage is admissible)"
              : "usage-honestly-none-reported-offline"
            : "FABRICATED-USAGE (a usage was reported offline where none should be — never fabricated)",
        ],
      },
      {
        criterionId: "honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `estimated:${estimatedGenerations.length}`,
          `fabricatedUsage:${String(fabricatedUsage)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The refusal honesty (a refusal is honest only when justified)
// ---------------------------------------------------------------------------

/** The maturity refusal-honesty verdict. */
export interface MaturityRefusalHonestyVerdict {
  /** The refusal reason matches the family's own recorded state. */
  readonly honest: boolean;
  readonly reason: MaturityRefusalReason | null;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the maturity refusal honesty (PURE): a refusal is honest
 * ONLY when the family's own recorded state justifies it —
 * `family-unrecorded` demands an EMPTY recorded lifecycle, and
 * `no-generations-recorded` demands a lifecycle WITHOUT generations.
 * Any other refusal (a recorded family with generations refusing) is
 * dishonest and FAILs.
 */
export function deriveMaturityRefusalHonesty(input: {
  readonly refusal: { readonly reason: MaturityRefusalReason } | null;
  readonly lifecycleRecordCount: number;
  readonly generationCount: number;
}): MaturityRefusalHonestyVerdict {
  let honest = true;
  if (input.refusal !== null) {
    if (input.refusal.reason === "family-unrecorded") {
      honest = input.lifecycleRecordCount === 0;
    } else if (input.refusal.reason === "no-generations-recorded") {
      honest = input.lifecycleRecordCount > 0 && input.generationCount === 0;
    }
  }
  return {
    honest,
    reason: input.refusal === null ? null : input.refusal.reason,
    criteria: [
      {
        criterionId: "refusal-honesty",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal === null ? "none" : input.refusal.reason}`,
          `lifecycleRecords:${input.lifecycleRecordCount}`,
          `generations:${input.generationCount}`,
          honest
            ? "the-refusal-matches-the-familys-own-recorded-state"
            : "DISHONEST-REFUSAL (the family's recorded state does not justify the refusal)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The corpus-row shape (the analysis declaration)
// ---------------------------------------------------------------------------

/**
 * ONE maturity corpus row: the workload family the analysis covers,
 * the family's generation series as the row DECLARES it (the curve
 * points citing the recorded lifecycle + accounting evidence), the
 * claimed classification + savings, and the EXPECTED outcome (the
 * honest oracle's verdict — established, honest immaturity, or the
 * probe's invalid shape).
 */
export interface MaturityCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The workload family the analysis covers (the family's recorded history is the read-only input). */
  readonly familyId: string;
  /** The analysis's claimed evidence citation (the full population, or the probe's broken shape). */
  readonly citation: MaturityEvidenceCitation;
  /** The analysis's claimed curve series (the canonical recorded points, or the probe's broken shape). */
  readonly curveSeries: readonly CurvePointShape[];
  /** The analysis's claimed classification. */
  readonly claimedClassification: MaturityClassification;
  /** The analysis's claimed savings attribution (per-mechanism, or the probe's aggregate-only shape). */
  readonly claimedSavings: SavingsAttribution;
  /** The pinned expected outcome (the honest oracle). */
  readonly expected: {
    /** The expected verdict kind. */
    readonly verdict: MaturityVerdictKind;
    /** The expected refusal reason (null when the run does not refuse). */
    readonly refusalReason: MaturityRefusalReason | null;
    /** The expected terminal status. */
    readonly terminal: "COMPLETED" | "FAILED";
    /** The expected route model calls (0 offline; the live row's measured round). */
    readonly modelCalls: number;
  };
  /** The probe the row declares (the adversarial variant driven in phase 2). */
  readonly probe?: { readonly kind: MaturityProbeKind };
  /** Whether the row demands the dispatch seam (the live rail). */
  readonly needsDispatch?: boolean;
  /** The live gate (the env vars that must be present). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}

// ---------------------------------------------------------------------------
// The row-level mechanical criteria (PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the citation legs
 * (full population, no phantoms), the curve-integrity legs (gapless,
 * measured, recorded-only), the classification-fidelity legs (the
 * verdict matches the observed data; no evidence-stretching), the
 * savings-reconciliation legs (per-mechanism, ledger-matched), the
 * honesty legs (measured, never estimated; honest boundaries), the
 * report-landing legs, the read-only input legs, the expected-verdict
 * contract, the payload-free digest discipline and the honest
 * accounting.
 */
export function deriveMaturityRowCriteria(input: {
  readonly row: MaturityCorpusRow;
  readonly refusal: { readonly reason: MaturityRefusalReason } | null;
  readonly refusalHonesty: MaturityRefusalHonestyVerdict | null;
  readonly citation: MaturityEvidenceCitationVerdict | null;
  readonly curveIntegrity: CurveSeriesIntegrityVerdict | null;
  readonly classification: MaturityClassificationVerdict | null;
  readonly savingsReconciliation: SavingsReconciliationVerdict | null;
  readonly honesty: MaturityHonestyVerdict | null;
  readonly reportLanded: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly reportsAppended: number;
  readonly inputUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly verdict: MaturityVerdictKind;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  if (input.citation !== null) {
    criteria.push(...input.citation.criteria);
  }
  if (input.curveIntegrity !== null) {
    criteria.push(...input.curveIntegrity.criteria);
  }
  if (input.classification !== null) {
    criteria.push(...input.classification.criteria);
  }
  if (input.savingsReconciliation !== null) {
    criteria.push(...input.savingsReconciliation.criteria);
  }
  if (input.honesty !== null) {
    criteria.push(...input.honesty.criteria);
  }
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // The report landing: an executed analysis appends its maturity
  // report; a refusal appends NOTHING.
  criteria.push({
    criterionId: "maturity-report-landing",
    strategy: "deterministic",
    status:
      input.refusal !== null
        ? input.reportsAppended === 0
          ? "PASS"
          : "FAIL"
        : input.reportLanded?.accepted
          ? "PASS"
          : "FAIL",
    evidence: [
      `row:${row.rowId}`,
      `family:${row.familyId}`,
      `refusal:${input.refusal === null ? "none" : input.refusal.reason}`,
      `reportsAppended:${input.reportsAppended}`,
      input.refusal !== null
        ? input.reportsAppended === 0
          ? "the-refusal-appended-nothing (nothing to report)"
          : "REFUSAL-APPENDED (a refusal must append nothing)"
        : input.reportLanded?.accepted
          ? "the-analysis-landed-its-maturity-report (append-only)"
          : "MISSING-REPORT (an executed analysis must append its maturity report)",
    ],
  });

  // The read-only input discipline: the recorded history's digest is
  // IDENTICAL before and after the run.
  criteria.push({
    criterionId: "maturity-input-read-only",
    strategy: "deterministic",
    status: input.inputUnchanged ? "PASS" : "FAIL",
    evidence: [
      `inputUnchanged:${String(input.inputUnchanged)}`,
      input.inputUnchanged
        ? "the-recorded-history-digest-is-identical-before-and-after (the read-only proof)"
        : "MUTATED-INPUT (the recorded lifecycle history changed over the run — a frozen input was rewritten)",
    ],
  });

  // The expected-verdict contract: the observed verdict matches the
  // pinned oracle.
  criteria.push({
    criterionId: "maturity-expected-verdict",
    strategy: "deterministic",
    status: input.verdict === row.expected.verdict ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.verdict}`,
      `observed:${input.verdict}`,
      input.verdict === row.expected.verdict
        ? "the-observed-verdict-matches-the-pinned-oracle"
        : "VERDICT-MISMATCH (the observed verdict drifted from the pinned oracle)",
    ],
  });

  // The run's own dispatches (zero offline; the live row's measured round).
  criteria.push({
    criterionId: "maturity-own-dispatches",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-maturity-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // The dispatch failure honesty: a failed live round FAILs the row.
  criteria.push({
    criterionId: "maturity-dispatch-failure-honesty",
    strategy: "deterministic",
    status: input.failure === null ? "PASS" : "FAIL",
    evidence: [
      `failure:${input.failure === null ? "none" : `${input.failure.category}:${input.failure.message}`}`,
      input.failure === null
        ? "no-dispatch-failure-was-recorded"
        : "DISPATCH-FAILURE (the live round failed — recorded honestly, never smoothed)",
    ],
  });

  return criteria;
}

/**
 * Derive the run's verdict kind (PURE): an honest refusal is
 * `immaturity-honest`; a trustworthy analysis is
 * `maturity-established`; every untrustworthy shape (a FAILing leg)
 * is `maturity-invalid` — an internal honesty failure, never a
 * passable outcome.
 */
export function deriveMaturityVerdictKind(input: {
  readonly refusal: { readonly reason: MaturityRefusalReason } | null;
  readonly refusalHonesty: MaturityRefusalHonestyVerdict | null;
  readonly citation: MaturityEvidenceCitationVerdict | null;
  readonly curveIntegrity: CurveSeriesIntegrityVerdict | null;
  readonly classification: MaturityClassificationVerdict | null;
  readonly savingsReconciliation: SavingsReconciliationVerdict | null;
  readonly honesty: MaturityHonestyVerdict | null;
  readonly inputUnchanged: boolean;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): MaturityVerdictKind {
  if (input.failure !== null) {
    return "maturity-invalid";
  }
  if (input.refusal !== null) {
    return (input.refusalHonesty?.honest ?? false) ? "immaturity-honest" : "maturity-invalid";
  }
  const trustworthy =
    (input.citation?.complete ?? false) &&
    (input.curveIntegrity?.integral ?? false) &&
    (input.classification?.fidelity ?? false) &&
    (input.savingsReconciliation?.reconciled ?? false) &&
    (input.honesty?.honest ?? false) &&
    input.inputUnchanged;
  return trustworthy ? "maturity-established" : "maturity-invalid";
}

// ---------------------------------------------------------------------------
// The driver (the mechanical maturity analysis over the read-only history)
// ---------------------------------------------------------------------------

/** ONE maturity run's full result (the driver's outcome). */
export interface MaturityRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly verdict: MaturityVerdictKind;
  readonly refusal: { readonly reason: MaturityRefusalReason } | null;
  readonly refusalHonesty: MaturityRefusalHonestyVerdict | null;
  readonly citation: MaturityEvidenceCitationVerdict | null;
  readonly curveIntegrity: CurveSeriesIntegrityVerdict | null;
  readonly classification: MaturityClassificationVerdict | null;
  readonly savingsReconciliation: SavingsReconciliationVerdict | null;
  readonly honesty: MaturityHonestyVerdict | null;
  readonly reportLanded: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly reportsAppended: number;
  readonly inputUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly usage: LabUsage | null;
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * The trajectory steps of one maturity run (PURE — the canonical
 * journal shape the platform records and the app re-derives over the
 * public events read).
 */
export function maturityTrajectoryStepsOf(input: {
  readonly rowId: string;
  readonly verdict: MaturityVerdictKind;
  readonly generationCount: number;
  readonly reportAppended: boolean;
}): readonly { readonly kind: string; readonly detail: string }[] {
  const steps: { kind: string; detail: string }[] = [
    { kind: "maturity:analysis-started", detail: input.rowId },
    { kind: "maturity:history-read", detail: `generations:${input.generationCount}` },
  ];
  if (input.verdict === "immaturity-honest") {
    steps.push({ kind: "maturity:immaturity-refused", detail: "honest" });
  } else if (input.reportAppended) {
    steps.push({ kind: "maturity:report-appended", detail: "append-only" });
  } else {
    steps.push({ kind: "maturity:report-withheld", detail: "untrustworthy-shape" });
  }
  steps.push({ kind: "maturity:analysis-settled", detail: input.verdict });
  return steps;
}

/**
 * Drive ONE maturity analysis over the recorded lifecycle history
 * (the mechanical engine): read the family's recorded lifecycle
 * records, promotion generations and accounting entries (the
 * READ-ONLY input — the input digest is snapshotted before and after
 * the run); refuse honestly when the family's own recorded history
 * does not support an analysis; otherwise derive the citation
 * completeness, the curve-series integrity, the classification
 * fidelity, the savings reconciliation and the honesty over the
 * row's declared claims — and, only when EVERY leg is trustworthy,
 * APPEND the family's maturity report to the append-only report
 * ledger. The live row's measured round rides the dispatch seam.
 */
export async function driveMaturityAnalysis(options: {
  readonly row: MaturityCorpusRow;
  /** The READ-ONLY recorded lifecycle history + accounting (VAL-032..035's records). */
  readonly analysis: MaturityAnalysisPort;
  /** The APPEND-ONLY maturity report ledger. */
  readonly reportLedger: MaturityReportPort;
  /** The dispatch seam (the live row's REAL measured round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<MaturityRunResult> {
  const { row } = options;
  if (row.needsDispatch === true && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL measured round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const startedAt = options.now().getTime();

  // ---- the frozen-input snapshot BEFORE the run ----
  const beforeInputDigest = maturityInputDigestOf(options.analysis.facts());

  // ---- the read-only history read ----
  const lifecycleRecords = options.analysis.lifecycleFor(row.familyId);
  const generations = options.analysis.generationsFor(row.familyId);
  const accountingEntries = options.analysis.accountingFor(row.familyId);

  let refusal: { reason: MaturityRefusalReason } | null = null;
  if (lifecycleRecords.length === 0) {
    refusal = { reason: "family-unrecorded" };
  } else if (generations.length === 0) {
    refusal = { reason: "no-generations-recorded" };
  }

  let citation: MaturityEvidenceCitationVerdict | null = null;
  let curveIntegrity: CurveSeriesIntegrityVerdict | null = null;
  let classification: MaturityClassificationVerdict | null = null;
  let savingsReconciliation: SavingsReconciliationVerdict | null = null;
  let honesty: MaturityHonestyVerdict | null = null;
  let refusalHonesty: MaturityRefusalHonestyVerdict | null = null;
  let reportLanded: { accepted: boolean; replayed: boolean } | null = null;
  let reportsAppended = 0;
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;
  let observedModelCalls = 0;

  if (refusal !== null) {
    // ---- the honest-immaturity path (the family's own recorded
    //      history does not support an analysis: nothing executes,
    //      nothing lands) ----
    refusalHonesty = deriveMaturityRefusalHonesty({
      refusal,
      lifecycleRecordCount: lifecycleRecords.length,
      generationCount: generations.length,
    });
  } else {
    // ---- the analysis legs (every claim re-derived mechanically) ----
    citation = deriveMaturityEvidenceCitation({
      lifecycleRecords,
      generations,
      accountingEntries,
      citation: row.citation,
    });
    curveIntegrity = deriveCurveSeriesIntegrity({
      recordedGenerations: generations,
      points: row.curveSeries,
    });
    classification = deriveMaturityClassification({
      generations,
      claimed: row.claimedClassification,
    });
    savingsReconciliation = deriveSavingsReconciliation({
      accountingLedger: accountingEntries,
      claimedSavings: row.claimedSavings,
    });
    honesty = deriveMaturityHonesty({
      generations,
      reportedUsage: null,
      liveRail: row.needsDispatch === true,
    });

    // ---- the maturity report append (ONLY a trustworthy analysis
    //      ever lands its report) ----
    const trustworthy =
      citation.complete &&
      curveIntegrity.integral &&
      classification.fidelity &&
      savingsReconciliation.reconciled &&
      honesty.honest;
    if (trustworthy) {
      const citationDigest = maturityCitationDigestOf(row.citation);
      const report = {
        familyId: row.familyId,
        classification: row.claimedClassification,
        curvePointDigests: row.curveSeries.map((point) => curvePointDigestOf(point)),
        savings: row.claimedSavings,
        citationDigest,
      };
      const receipt = await options.reportLedger.append(report);
      reportLanded = { accepted: receipt.accepted, replayed: receipt.replayed };
      reportsAppended = receipt.accepted ? 1 : 0;
    }
  }

  // ---- the live row's REAL measured round ----
  if (row.needsDispatch === true && options.dispatch !== undefined) {
    for (let round = 1; round <= row.expected.modelCalls; round += 1) {
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ round, attempt });
        if (outcome.kind === "success") {
          observedModelCalls += 1;
          if (outcome.usage !== undefined) {
            usage = {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              ...(outcome.usage.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
            };
          }
          break;
        }
        const retryable = isRetryableDispatchCategory(outcome.category ?? "");
        if (!retryable || attempt > retry.maxExtraAttempts) {
          failure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await retry.sleep(retry.backoffMs);
      }
      if (failure !== null) {
        break;
      }
    }
  }

  // ---- the frozen-input snapshot AFTER the run (the read-only proof) ----
  const afterInputDigest = maturityInputDigestOf(options.analysis.facts());
  const inputUnchanged = beforeInputDigest === afterInputDigest;

  const verdict = deriveMaturityVerdictKind({
    refusal,
    refusalHonesty,
    citation,
    curveIntegrity,
    classification,
    savingsReconciliation,
    honesty,
    inputUnchanged,
    failure,
  });

  const criteria = deriveMaturityRowCriteria({
    row,
    refusal,
    refusalHonesty,
    citation,
    curveIntegrity,
    classification,
    savingsReconciliation,
    honesty,
    reportLanded,
    reportsAppended,
    inputUnchanged,
    observedModelCalls,
    verdict,
    failure,
  });

  const anyFail = failure !== null || criteria.some((criterion) => criterion.status === "FAIL");

  // The terminal contract: an honest immaturity and an established
  // analysis are COMPLETED runs (the honest verdict IS the outcome);
  // an invalid shape FAILs. The pinned oracle's terminal wins when
  // every leg passed.
  const terminal: "COMPLETED" | "FAILED" = anyFail
    ? "FAILED"
    : row.expected.terminal === "FAILED"
      ? "FAILED"
      : "COMPLETED";

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : terminal,
    criteria,
    verdict,
    refusal,
    refusalHonesty,
    citation,
    curveIntegrity,
    classification,
    savingsReconciliation,
    honesty,
    reportLanded,
    reportsAppended,
    inputUnchanged,
    observedModelCalls,
    usage,
    latencyMs: options.now().getTime() - startedAt,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The app-boundary observation + the app contract (the oracle at the SDK seam)
// ---------------------------------------------------------------------------

/**
 * The maturity observation as the app reads it back through the
 * PUBLIC result read (never trusting the platform's own claim): the
 * read-back classification, the read-back curve series, the read-back
 * savings attribution, the read-back report record and the run's own
 * measured facts.
 */
export interface AppMaturityObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  readonly terminal: string | null;
  readonly verificationStatuses: readonly string[];
  /** The classification read back through the public result read. */
  readonly classification: string | null;
  /** The refusal reason read back (null when the run did not refuse). */
  readonly refusalReason: string | null;
  /** The curve series read back (the points the platform surfaced). */
  readonly curveSeries: readonly {
    readonly generation: number;
    readonly displacedModelCalls: number;
    readonly measuredCostMicroUsd: number;
    readonly measuredLatencyMs: number;
    readonly measured: boolean;
    readonly pointSource: string;
    readonly generationDigest: string;
    readonly lifecycleProposalIds: readonly string[];
  }[];
  /** The savings attribution read back (the per-mechanism numbers). */
  readonly savings: {
    readonly totalMicroUsd: number;
    readonly perMechanism: Readonly<Record<CandidateKind, number>> | null;
  } | null;
  /** Whether the maturity report landed in the report ledger. */
  readonly reportRecorded: boolean;
  /** The route's own model-call count (the run's own dispatches). */
  readonly observedModelCalls: number | null;
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
}

/**
 * The app-boundary maturity contract (PURE — the oracle at the SDK
 * seam): re-derive every leg AT the boundary over the read-back
 * observation — the classification fidelity over the read-back curve
 * series (a misclassified family never passes), the curve integrity
 * over the read-back points (a gapped or extrapolated series never
 * passes), the savings reconciliation over the read-back attribution
  (an aggregate-only or mismatched number never passes), the report
 * landing, the run's own dispatches and the trajectory class
 * membership. Never trust the platform's claim.
 */
export function verifyDeterminizationMaturityAppContract(input: {
  readonly row: MaturityCorpusRow;
  readonly observation: AppMaturityObservation;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row, observation } = input;

  // 1. The read-back classification matches the row's claimed
  //    classification (the pinned oracle's claim surfaced honestly).
  const classificationMatches =
    observation.classification !== null && observation.classification === row.claimedClassification;
  criteria.push({
    criterionId: "app-classification-read-back",
    strategy: "deterministic",
    status: classificationMatches ? "PASS" : "FAIL",
    evidence: [
      `claimed:${row.claimedClassification}`,
      `readBack:${observation.classification ?? "none"}`,
      classificationMatches
        ? "the-read-back-classification-matches-the-claimed-classification"
        : "CLASSIFICATION-READ-BACK-MISMATCH (the platform surfaced a different classification than the analysis claimed)",
    ],
  });

  // 2. The boundary re-derivation of the classification fidelity
  //    (over the read-back curve series as the observed data).
  const boundaryObserved = observedMaturityClassificationOf(
    observation.curveSeries.map((point) => ({
      familyId: row.familyId,
      generation: point.generation,
      baselineModelCalls:
        row.curveSeries.find((claimed) => claimed.generation === point.generation)
          ?.displacedModelCalls === point.displacedModelCalls
          ? point.displacedModelCalls
          : point.displacedModelCalls + 1,
      displacedModelCalls: point.displacedModelCalls,
      measuredCostMicroUsd: point.measuredCostMicroUsd,
      measuredLatencyMs: point.measuredLatencyMs,
      perMechanismDisplacements: {
        reuse: 0,
        cache: 0,
        competence: 0,
        deterministicization: 0,
      },
      measured: point.measured,
      lifecycleProposalIds: [...point.lifecycleProposalIds],
    })),
  );
  const boundaryFidelity = boundaryObserved === row.claimedClassification;
  criteria.push({
    criterionId: "app-classification-fidelity-re-derived",
    strategy: "deterministic",
    status: boundaryFidelity ? "PASS" : "FAIL",
    evidence: [
      `claimed:${row.claimedClassification}`,
      `boundaryObserved:${boundaryObserved}`,
      boundaryFidelity
        ? "the-boundary-re-derived-classification-matches-the-claim (never trusting the platform)"
        : "BOUNDARY-MISCLASSIFICATION (the read-back curve series contradicts the claimed classification)",
    ],
  });

  // 3. The boundary re-derivation of the curve integrity (over the
  //    read-back points) — ONLY for a row whose analysis EXECUTES: an
  //    honest immaturity surfaces NO curve (nothing was analyzed), so
  //    there is no series to re-derive at the boundary (the refusal
  //    read-back + the report-landing legs cover it instead). The
  //    recorded basis is the row's own claimed series — every claimed
  //    point carries its generation's FULL digest-relevant fact set, so
  //    the reconstructed record hashes back to the point's own
  //    `generationDigest` exactly.
  if (row.expected.verdict === "maturity-established") {
    const boundaryCurve = deriveCurveSeriesIntegrity({
      recordedGenerations: row.curveSeries
        .filter((point) => point.pointSource === "recorded")
        .map((point) => ({
          familyId: row.familyId,
          generation: point.generation,
          baselineModelCalls: point.baselineModelCalls,
          displacedModelCalls: point.displacedModelCalls,
          measuredCostMicroUsd: point.measuredCostMicroUsd,
          measuredLatencyMs: point.measuredLatencyMs,
          perMechanismDisplacements: { ...point.perMechanismDisplacements },
          measured: point.measured,
          lifecycleProposalIds: [...point.lifecycleProposalIds],
        })),
      points: observation.curveSeries.map((point) => ({
        familyId: row.familyId,
        generation: point.generation,
        // The read-back point's own baseline / per-mechanism facts never
        // enter the integrity check (only its cited generation digest
        // does) — the defaults keep the shape complete.
        baselineModelCalls: 0,
        displacedModelCalls: point.displacedModelCalls,
        measuredCostMicroUsd: point.measuredCostMicroUsd,
        measuredLatencyMs: point.measuredLatencyMs,
        perMechanismDisplacements: {
          reuse: 0,
          cache: 0,
          competence: 0,
          deterministicization: 0,
        },
        measured: point.measured,
        pointSource: (isCurvePointSource(point.pointSource)
          ? point.pointSource
          : "fabricated") as CurvePointSource,
        generationDigest: point.generationDigest,
        lifecycleProposalIds: [...point.lifecycleProposalIds],
      })),
    });
    criteria.push(
      ...boundaryCurve.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  }

  // 4. The boundary re-derivation of the savings reconciliation (over
  //    the read-back attribution; the recorded basis is the row's own
  //    claimed ledger numbers reconciled against the read-back ones).
  if (observation.savings !== null) {
    const claimedPerMechanism = row.claimedSavings.perMechanism;
    const boundarySavings = deriveSavingsReconciliation({
      accountingLedger:
        claimedPerMechanism === null
          ? []
          : CANDIDATE_KINDS.map((kind) => ({
              familyId: row.familyId,
              generation: 1,
              mechanism: kind,
              microUsd: claimedPerMechanism[kind],
              latencyDeltaMs: 0,
            })),
      claimedSavings: observation.savings,
    });
    criteria.push(
      ...boundarySavings.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  } else if (row.expected.verdict === "maturity-established") {
    criteria.push({
      criterionId: "app-savings-readable",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-SAVINGS (the boundary could not read the savings attribution)",
      ],
    });
  }

  // 5. The report landing: an established analysis surfaces its
  //    recorded report; an honest immaturity surfaces none.
  const reportLandingMatches =
    row.expected.verdict === "maturity-established"
      ? observation.reportRecorded
      : !observation.reportRecorded;
  criteria.push({
    criterionId: "app-report-landing",
    strategy: "deterministic",
    status: reportLandingMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedVerdict:${row.expected.verdict}`,
      `reportRecorded:${String(observation.reportRecorded)}`,
      reportLandingMatches
        ? "the-read-back-report-landing-matches-the-expected-verdict"
        : "REPORT-LANDING-MISMATCH (the report landing contradicts the expected verdict)",
    ],
  });

  // 6. The run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-maturity-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // 7. The refusal read-back (the honest immaturity's reason).
  if (row.expected.refusalReason !== null) {
    criteria.push({
      criterionId: "app-refusal-read-back",
      strategy: "deterministic",
      status: observation.refusalReason === row.expected.refusalReason ? "PASS" : "FAIL",
      evidence: [
        `expected:${row.expected.refusalReason}`,
        `readBack:${observation.refusalReason ?? "none"}`,
        observation.refusalReason === row.expected.refusalReason
          ? "the-read-back-refusal-reason-matches-the-pinned-oracle"
          : "REFUSAL-READ-BACK-MISMATCH (the platform surfaced a different refusal reason)",
      ],
    });
  }

  return criteria;
}
