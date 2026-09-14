/**
 * The platform-side savings-attribution engine (VAL-045).
 *
 * The mechanical engine of the attribution slice — the SAVINGS
 * ATTRIBUTION domain finale of the determinization chain: it takes the
 * RECORDED ECONOMICS (VAL-044's quality/latency/failure-adjusted cost
 * model — the recorded INCUMBENT BASELINES the mechanisms displaced —
 * the READ-ONLY input) and the determinization lifecycle's RECORDED
 * HISTORY (VAL-030..036's candidate lifecycle records, promotion
 * generations, accounting ledgers and maturity reports — the READ-ONLY
 * input; a recorded record is never rewritten) and attributes the
 * measured savings to their MECHANISMS — per workload family, per
 * promotion generation: which savings came from REUSE (the
 * cross-workload shape candidates), which from CACHE (the stable
 * input→output transforms), which from COMPETENCE (the recurring
 * step-pattern tools), which from DETERMINISTICIZATION (the displaced
 * model rounds) — and which savings remain UNATTRIBUTED (the honest
 * RESIDUAL, reported, never forced into a mechanism).
 *
 * The attribution oracle (the PURE derivations that make an
 * attribution claim trustworthy):
 *
 *   * `deriveAttributionEvidenceCitation` — every attribution claim
 *     cites its FULL evidence population: the exact ledger entries,
 *     lifecycle records and cost measurements it attributes from. An
 *     UNCITED claim (a nonzero claim with no citations), a PHANTOM
 *     citation (a cited member that is not in the recorded
 *     population), a PARTIAL population (a recorded ledger entry or
 *     lifecycle record the union of claims missed) or an EMPTY
 *     evidence basis FAILs with the member named;
 *   * `deriveNoDoubleCount` — each ledger entry is attributed to AT
 *     MOST ONE mechanism: the same entry cited by two claims (or twice
 *     within one claim's citation) is a DOUBLE-COUNT and FAILs with
 *     BOTH claims named;
 *   * `deriveResidualHonesty` — the unattributed residual is REPORTED,
 *     never forced into a mechanism: a mechanism claim whose number
 *     EXCEEDS the sum of its cited entries' measured savings is a
 *     FORCED RESIDUAL and FAILs with the mechanism and the excess
 *     named; an under-claim FAILs with both sides named; the reported
 *     residual must EQUAL the recorded total minus the attributed sum
 *     (a hidden or inflated residual FAILs named);
 *   * `deriveAttributionReconciliation` — the reconciliation identity:
 *     the attributed savings (per mechanism, summed) + the honest
 *     residual EQUAL the recorded total savings per family per
 *     generation. A non-reconciling generation FAILs with BOTH sides
 *     named (attributed+residual vs recorded);
 *   * `deriveCounterfactualFidelity` — each mechanism's savings are
 *     measured against the RECORDED incumbent baseline (the adjusted
 *     cost the mechanism actually displaced, per VAL-044's adjusted
 *     model): an UNSTATED baseline (no digest cited), a SWAPPED
 *     baseline (another generation's or mechanism's recorded baseline
 *     cited), a HYPOTHETICAL baseline (a digest no recorded baseline
 *     holds, or a non-recorded basis) or a number that does not equal
 *     the recorded baseline's own counterfactual (incumbent minus
 *     replacement) FAILs named;
 *   * `deriveGenerationSeriesIntegrity` — the attribution's generation
 *     series MATCHES the maturity benchmark's recorded generations
 *     (VAL-036's curves): a GAPPED series (a recorded generation the
 *     attribution missed) or a MISMATCHED series (a generation the
 *     recorded maturity curves do not hold) FAILs named;
 *   * `deriveAttributionHonesty` — honest measurement discipline: the
 *     recorded incumbent baselines are MEASURED (never estimated — an
 *     estimated baseline FAILs, named), and the none-reported
 *     boundaries are honest (usage is honestly none-reported offline
 *     and measured only on the live rail — a fabricated offline usage
 *     FAILs).
 *
 * Digest discipline: every identity, citation, claim, generation
 * point, savings entry and report record carries an FNV-1a
 * payload-free digest (via `longitudinalDigestOf`); payload bytes
 * never enter the evidence. Latency is always measured; usage is
 * honestly none-reported offline and measured only on the live rail.
 *
 * Everything is seam-injected here (the lab contract); the
 * integration seam binds the REAL platform path and — for the live
 * row — the REAL model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type {
  FamilyLifecycleRecord,
  MaturityReportRecord,
  PromotionGenerationRecord,
} from "./determinization-maturity";
import { maturityReportDigestOf } from "./determinization-maturity";
import type { CandidateKind, DiscoveryProposalRecord } from "./learning-discovery";
import { CANDIDATE_KINDS } from "./learning-discovery";
import type { ControlDispatch } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The attribution vocabulary (the mechanism grammar)
// ---------------------------------------------------------------------------

/**
 * The attribution phase's learning mode: the attribution analysis is a
 * LONGITUDINAL READ — it attributes the RECORDED economics (VAL-044's
 * adjusted-cost baselines) over the RECORDED lifecycle history
 * (VAL-030..036's records). It never rewrites a recorded record.
 */
export const ATTRIBUTION_LEARNING_PHASE = "attribution" as const;

/** The longitudinal-experiment kind every attribution run registers as. */
export const ATTRIBUTION_EXPERIMENT_KIND = "savings-attribution";

/**
 * The savings-attribution MECHANISMS — the CANDIDATE_KINDS vocabulary
 * the whole determinization chain (VAL-030..036) attributed candidates
 * over: REUSE (the cross-workload shape candidates), CACHE (the stable
 * input→output transforms), COMPETENCE (the recurring step-pattern
 * tools) and DETERMINISTICIZATION (the displaced model rounds).
 */
export const ATTRIBUTION_MECHANISMS = CANDIDATE_KINDS;

export type AttributionMechanism = CandidateKind;

/**
 * The UNATTRIBUTED RESIDUAL sentinel: the savings whose mechanism was
 * never recorded. The residual is REPORTED honestly — never forced
 * into a mechanism (a residual claimed as reuse/cache/competence/
 * deterministicization without that mechanism's recorded evidence
 * FAILs the residual honesty).
 */
export const UNATTRIBUTED_RESIDUAL = "residual" as const;

/**
 * The counterfactual basis vocabulary: every mechanism claim's savings
 * are measured against a baseline whose basis must be `recorded` (the
 * RECORDED incumbent baseline per VAL-044's adjusted model). A
 * `hypothetical` basis (a favorable counterfactual that was never
 * measured) FAILs the counterfactual fidelity and is named.
 */
export const COUNTERFACTUAL_BASES = ["recorded", "hypothetical"] as const;

export type CounterfactualBasis = (typeof COUNTERFACTUAL_BASES)[number];

export function isCounterfactualBasis(value: string): value is CounterfactualBasis {
  return (COUNTERFACTUAL_BASES as readonly string[]).includes(value);
}

/**
 * The attribution-probe kinds the corpus declares (the vocabulary the
 * later discrimination phases drive over the adversarial fixture
 * variants — designed here, pinned now):
 *
 *   * `uncited-claim` — a mechanism claim whose evidence citation
 *     misses recorded members (or cites phantom members) — FAILs;
 *   * `double-count` — a ledger entry attributed to two mechanisms
 *     simultaneously — FAILs with both claims named;
 *   * `forced-residual` — the unattributed residual forced into a
 *     mechanism (a claim exceeding its cited evidence) — FAILs;
 *   * `swapped-baseline` — a claim measured against another
 *     generation's / mechanism's recorded baseline (or a hypothetical
 *     one) — FAILs;
 *   * `gapped-series` — the attribution's generation series gapped or
 *     mismatched against the maturity benchmark's recorded
 *     generations — FAILs.
 */
export const ATTRIBUTION_PROBE_KINDS = [
  "uncited-claim",
  "double-count",
  "forced-residual",
  "swapped-baseline",
  "gapped-series",
] as const;

export type AttributionProbeKind = (typeof ATTRIBUTION_PROBE_KINDS)[number];

export function isAttributionProbeKind(value: string): value is AttributionProbeKind {
  return (ATTRIBUTION_PROBE_KINDS as readonly string[]).includes(value);
}

/**
 * The attribution verdict kinds (the per-row outcome vocabulary):
 *
 *   * `attribution-established` — the family's attribution is complete
 *     and trustworthy (fully cited, undoubled, residual-honest,
 *     reconciled, counterfactually faithful, series-integral, honest)
 *     and its attribution report landed in the append-only report
 *     ledger;
 *   * `no-evidence-honest` — the family's own recorded history does
 *     not support an attribution (no recorded lifecycle at all, or no
 *     recorded savings to attribute): the run refuses honestly and
 *     nothing lands;
 *   * `attribution-invalid` — the run's mechanical shape is
 *     untrustworthy (an uncited claim, a double-count, a forced
 *     residual, a non-reconciling split, an unstated / swapped /
 *     hypothetical baseline, a gapped or mismatched series, an
 *     estimated baseline): an internal honesty failure, never a
 *     passable outcome.
 */
export const ATTRIBUTION_VERDICTS = [
  "attribution-established",
  "no-evidence-honest",
  "attribution-invalid",
] as const;

export type AttributionVerdictKind = (typeof ATTRIBUTION_VERDICTS)[number];

export function isAttributionVerdictKind(value: string): value is AttributionVerdictKind {
  return (ATTRIBUTION_VERDICTS as readonly string[]).includes(value);
}

/**
 * The honest refusal reasons (an attribution run refuses only when the
 * family's own recorded history genuinely justifies it):
 *
 *   * `family-unrecorded` — the cited workload family holds NO
 *     recorded lifecycle history at all (a phantom family);
 *   * `no-savings-recorded` — the family's history holds recorded
 *     lifecycle and generations but NO recorded savings (no ledger
 *     entries and no recorded totals — nothing to attribute, never a
 *     fabricated split).
 */
export const ATTRIBUTION_REFUSAL_REASONS = ["family-unrecorded", "no-savings-recorded"] as const;

export type AttributionRefusalReason = (typeof ATTRIBUTION_REFUSAL_REASONS)[number];

export function isAttributionRefusalReason(value: string): value is AttributionRefusalReason {
  return (ATTRIBUTION_REFUSAL_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The recorded economics shapes (the read-only input vocabulary)
// ---------------------------------------------------------------------------

/**
 * ONE recorded accounting ledger entry — the attribution's read-only
 * savings basis: the MEASURED savings one mechanism's displacements
 * produced in one generation (the incumbent's measured adjusted cost
 * minus the replacement's measured adjusted cost, aggregated for the
 * entry's mechanism+generation). Every entry carries a stable entryId;
 * an entry attributed to two mechanisms simultaneously FAILs the
 * no-double-count oracle with both claims named.
 */
export interface AttributionLedgerEntry {
  readonly familyId: string;
  /** The generation the savings were measured in (1-based). */
  readonly generation: number;
  /** The mechanism the savings belong to (an ATTRIBUTION_MECHANISMS member). */
  readonly mechanism: CandidateKind;
  /** The entry's stable identity (the no-double-count basis). */
  readonly entryId: string;
  /** The MEASURED savings for this mechanism in this generation (micro-USD). */
  readonly microUsd: number;
  /** The MEASURED latency delta for this mechanism in this generation (ms). */
  readonly latencyDeltaMs: number;
}

/** The canonical digest over one attribution ledger entry (PURE, payload-free). */
export function attributionEntryDigestOf(entry: AttributionLedgerEntry): string {
  return longitudinalDigestOf([
    "attribution-entry",
    entry.familyId,
    entry.generation,
    entry.mechanism,
    entry.entryId,
    entry.microUsd,
    entry.latencyDeltaMs,
  ]);
}

/**
 * ONE recorded incumbent baseline — VAL-044's adjusted-cost model's
 * recorded counterfactual: the quality/latency/failure-ADJUSTED cost
 * of the incumbent calls one mechanism displaced in one generation
 * (`incumbentAdjustedCostMicroUsd`) and the adjusted cost of the
 * replacement that displaced them (`replacementAdjustedCostMicroUsd`).
 * The mechanism's recorded savings are the counterfactual difference —
 * and every attribution claim must measure against THIS recorded
 * baseline (an unstated, swapped or hypothetical baseline FAILs the
 * counterfactual fidelity).
 */
export interface IncumbentBaselineRecord {
  readonly familyId: string;
  /** The generation the baseline was recorded in (1-based). */
  readonly generation: number;
  /** The mechanism whose displacements the baseline covers. */
  readonly mechanism: CandidateKind;
  /** The incumbent's ADJUSTED cost for the displaced calls (micro-USD). */
  readonly incumbentAdjustedCostMicroUsd: number;
  /** The replacement's ADJUSTED cost for the same work (micro-USD). */
  readonly replacementAdjustedCostMicroUsd: number;
  /** Whether the baseline was MEASURED (never estimated). */
  readonly measured: boolean;
}

/**
 * The recorded counterfactual savings over one incumbent baseline
 * (PURE): the incumbent's adjusted cost MINUS the replacement's
 * adjusted cost — the number a claim measured against THIS baseline
 * must carry exactly.
 */
export function recordedCounterfactualOf(baseline: IncumbentBaselineRecord): number {
  return baseline.incumbentAdjustedCostMicroUsd - baseline.replacementAdjustedCostMicroUsd;
}

/** The canonical digest over one incumbent baseline (PURE, payload-free). */
export function incumbentBaselineDigestOf(baseline: IncumbentBaselineRecord): string {
  return longitudinalDigestOf([
    "incumbent-baseline",
    baseline.familyId,
    baseline.generation,
    baseline.mechanism,
    baseline.incumbentAdjustedCostMicroUsd,
    baseline.replacementAdjustedCostMicroUsd,
    baseline.measured,
  ]);
}

/**
 * ONE recorded savings total — the family's per-generation RECORDED
 * total savings (the maturity world's own accounting: the incumbent
 * baseline total minus the generation's measured cost). The ledger
 * entries carry the MECHANISM-ATTRIBUTABLE share; the difference
 * between the recorded total and the attributed sum is the honest
 * UNATTRIBUTED RESIDUAL — reported, never forced.
 */
export interface RecordedSavingsTotalRecord {
  readonly familyId: string;
  /** The generation the total was recorded for (1-based). */
  readonly generation: number;
  /** The RECORDED total savings for the generation (micro-USD). */
  readonly totalMicroUsd: number;
}

/** The canonical digest over one recorded savings total (PURE, payload-free). */
export function recordedSavingsTotalDigestOf(record: RecordedSavingsTotalRecord): string {
  return longitudinalDigestOf([
    "recorded-savings-total",
    record.familyId,
    record.generation,
    record.totalMicroUsd,
  ]);
}

// ---------------------------------------------------------------------------
// The attribution claim shapes (the analysis's declared split)
// ---------------------------------------------------------------------------

/**
 * ONE mechanism attribution claim — the analysis's per-mechanism,
 * per-generation attribution: the claimed savings, the EXACT ledger
 * entries and lifecycle records the claim attributes from (its full
 * evidence population), and the recorded incumbent baseline the
 * savings are measured against (the counterfactual citation). A claim
 * whose number exceeds its cited evidence is a FORCED RESIDUAL; a
 * claim citing an entry another claim also cites is a DOUBLE-COUNT.
 */
export interface AttributionClaim {
  /** The mechanism the savings are attributed to. */
  readonly mechanism: CandidateKind;
  /** The generation the claim covers (1-based). */
  readonly generation: number;
  /** The claimed savings for this mechanism in this generation (micro-USD). */
  readonly claimedMicroUsd: number;
  /** The EXACT ledger entries the claim attributes from (entryIds). */
  readonly citedLedgerEntryIds: readonly string[];
  /** The lifecycle records the claim attributes from (proposalIds). */
  readonly citedLifecycleProposalIds: readonly string[];
  /** The RECORDED incumbent baseline digest the claim measures against. */
  readonly baselineDigest: string;
  /** The claimed counterfactual basis (recorded / hypothetical). */
  readonly baselineBasis: CounterfactualBasis;
}

/** The canonical digest over one attribution claim (PURE, payload-free). */
export function attributionClaimDigestOf(claim: AttributionClaim): string {
  return longitudinalDigestOf([
    "attribution-claim",
    claim.mechanism,
    claim.generation,
    claim.claimedMicroUsd,
    claim.citedLedgerEntryIds,
    claim.citedLifecycleProposalIds,
    claim.baselineDigest,
    claim.baselineBasis,
  ]);
}

/**
 * ONE residual claim — the analysis's honest UNATTRIBUTED residual per
 * generation: the savings whose mechanism was never recorded. The
 * residual is REPORTED (`reported: false` while a residual exists is a
 * HIDDEN residual and FAILs); its number must EQUAL the recorded total
 * minus the attributed sum (an inflated or deflated residual FAILs
 * with both sides named).
 */
export interface ResidualClaim {
  /** The generation the residual covers (1-based). */
  readonly generation: number;
  /** The reported unattributed residual for the generation (micro-USD). */
  readonly residualMicroUsd: number;
  /** Whether the residual is reported at all (a hidden residual FAILs). */
  readonly reported: boolean;
}

/** The canonical digest over one residual claim (PURE, payload-free). */
export function residualClaimDigestOf(claim: ResidualClaim): string {
  return longitudinalDigestOf([
    "residual-claim",
    claim.generation,
    claim.residualMicroUsd,
    claim.reported,
  ]);
}

/**
 * The family's declared attribution split (the analysis's claim set):
 * the per-mechanism claims (each citing its full evidence population)
 * and the honest residual claims (per generation).
 */
export interface FamilyAttributionSplit {
  /** The per-mechanism, per-generation claims. */
  readonly claims: readonly AttributionClaim[];
  /** The honest unattributed residual (per generation). */
  readonly residual: readonly ResidualClaim[];
}

/**
 * The attribution evidence citation (the family-level fingerprint the
 * report carries): the full population of ledger entry digests,
 * lifecycle proposal ids, baseline digests and recorded-total digests
 * the attribution's claims cite. The CANONICAL citation cites the FULL
 * population; anything less FAILs completeness.
 */
export interface AttributionEvidenceCitation {
  /** Every cited ledger entry digest (every recorded entry). */
  readonly ledgerEntryDigests: readonly string[];
  /** Every cited lifecycle proposal id (every recorded lifecycle record). */
  readonly lifecycleProposalIds: readonly string[];
  /** Every cited incumbent baseline digest (every recorded baseline). */
  readonly baselineDigests: readonly string[];
  /** Every cited recorded-total digest (every recorded savings total). */
  readonly recordedTotalDigests: readonly string[];
}

/**
 * The canonical FULL-population citation (PURE): every recorded ledger
 * entry digest, every recorded lifecycle proposal id, every recorded
 * baseline digest and every recorded savings-total digest for the
 * family. An attribution cites its FULL population — anything less
 * FAILs.
 */
export function canonicalAttributionCitationOf(input: {
  readonly ledgerEntries: readonly AttributionLedgerEntry[];
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  readonly baselines: readonly IncumbentBaselineRecord[];
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
}): AttributionEvidenceCitation {
  return {
    ledgerEntryDigests: input.ledgerEntries.map((entry) => attributionEntryDigestOf(entry)),
    lifecycleProposalIds: input.lifecycleRecords.map((record) => record.proposalId),
    baselineDigests: input.baselines.map((baseline) => incumbentBaselineDigestOf(baseline)),
    recordedTotalDigests: input.recordedTotals.map((record) =>
      recordedSavingsTotalDigestOf(record),
    ),
  };
}

/**
 * The canonical digest over an attribution evidence citation (PURE,
 * payload-free): the citation fingerprint the report ledger's evidence
 * carries.
 */
export function attributionCitationDigestOf(citation: AttributionEvidenceCitation): string {
  return longitudinalDigestOf([
    "attribution-citation",
    citation.ledgerEntryDigests,
    citation.lifecycleProposalIds,
    citation.baselineDigests,
    citation.recordedTotalDigests,
  ]);
}

// ---------------------------------------------------------------------------
// The canonical split (the honest analysis's own construction)
// ---------------------------------------------------------------------------

/**
 * Derive the CANONICAL family attribution split from the recorded
 * economics (PURE — the honest analysis's own construction): one claim
 * per recorded ledger entry's (mechanism, generation) — the claim
 * carrying the entry's own measured savings, citing the entry and the
 * generation's lifecycle records of the same mechanism, and measuring
 * against the RECORDED incumbent baseline for that (mechanism,
 * generation) — plus the honest residual per generation (the recorded
 * total minus the attributed sum, reported). The canonical split
 * never double-counts (each entry cited exactly once), never forces
 * the residual into a mechanism and never cites a phantom member.
 */
export function canonicalAttributionSplitOf(input: {
  readonly familyId: string;
  readonly ledgerEntries: readonly AttributionLedgerEntry[];
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  readonly baselines: readonly IncumbentBaselineRecord[];
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
}): FamilyAttributionSplit {
  const claims: AttributionClaim[] = [];
  for (const entry of [...input.ledgerEntries].sort(
    (left, right) =>
      left.generation - right.generation || left.mechanism.localeCompare(right.mechanism),
  )) {
    const baseline = input.baselines.find(
      (candidate) =>
        candidate.generation === entry.generation && candidate.mechanism === entry.mechanism,
    );
    const lifecycleForGeneration = input.lifecycleRecords
      .filter((record) => record.generation === entry.generation && record.kind === entry.mechanism)
      .map((record) => record.proposalId);
    claims.push({
      mechanism: entry.mechanism,
      generation: entry.generation,
      claimedMicroUsd: entry.microUsd,
      citedLedgerEntryIds: [entry.entryId],
      citedLifecycleProposalIds: lifecycleForGeneration,
      baselineDigest: baseline === undefined ? "" : incumbentBaselineDigestOf(baseline),
      baselineBasis: "recorded" as const,
    });
  }
  const residual: ResidualClaim[] = [...input.recordedTotals]
    .sort((left, right) => left.generation - right.generation)
    .map((record) => {
      const attributedInGeneration = input.ledgerEntries
        .filter((entry) => entry.generation === record.generation)
        .reduce((total, entry) => total + entry.microUsd, 0);
      return {
        generation: record.generation,
        residualMicroUsd: record.totalMicroUsd - attributedInGeneration,
        reported: true,
      };
    });
  return { claims, residual };
}

// ---------------------------------------------------------------------------
// The attribution report record (the append-only artifact)
// ---------------------------------------------------------------------------

/**
 * ONE recorded attribution report — the analysis's ONLY artifact,
 * appended to the report ledger: the family, the per-mechanism
 * attributed totals, the honest residual, the claimed total
 * (attributed + residual), the per-claim digests, the evidence
 * citation digest and the VAL-036 maturity report digest the
 * attribution links to (the generation-series linkage's record side).
 * The report ledger is APPEND-ONLY: an identical re-append REPLAYS
 * (idempotent), a different report under the same family FAILs the
 * driver mechanically.
 */
export interface SavingsAttributionReportRecord {
  readonly familyId: string;
  /** The per-mechanism attributed totals (over the ATTRIBUTION_MECHANISMS). */
  readonly attributed: Readonly<Record<CandidateKind, number>>;
  /** The honest unattributed residual total (reported, never forced). */
  readonly residualMicroUsd: number;
  /** The claimed total (attributed summed + the residual). */
  readonly claimedTotalMicroUsd: number;
  /** The claim digests (in canonical claim order). */
  readonly claimDigests: readonly string[];
  /** The residual claim digests (in generation order). */
  readonly residualDigests: readonly string[];
  /** The evidence citation digest (the full population's fingerprint). */
  readonly citationDigest: string;
  /** The linked VAL-036 maturity report's digest (the generation-series record). */
  readonly maturityReportDigest: string | null;
  /** 1-based append order within the report ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one attribution report (PURE, payload-free). */
export function savingsAttributionReportDigestOf(
  record: Omit<SavingsAttributionReportRecord, "ordinal">,
): string {
  return longitudinalDigestOf([
    "savings-attribution-report",
    record.familyId,
    [
      record.attributed.reuse,
      record.attributed.cache,
      record.attributed.competence,
      record.attributed.deterministicization,
    ],
    record.residualMicroUsd,
    record.claimedTotalMicroUsd,
    record.claimDigests,
    record.residualDigests,
    record.citationDigest,
    record.maturityReportDigest,
  ]);
}

// ---------------------------------------------------------------------------
// The read-only analysis port + the append-only report port
// ---------------------------------------------------------------------------

/**
 * The attribution analysis port (the READ-ONLY input): the RECORDED
 * economics (VAL-044's incumbent baselines + the recorded savings
 * totals) and the RECORDED lifecycle history (VAL-030..036's lifecycle
 * records, promotion generations, accounting ledgers and maturity
 * reports) the attribution attributes from. The attribution run NEVER
 * rewrites a recorded record; an analysis port whose facts digest
 * changes over a run FAILs the read-only discipline mechanically.
 */
export interface AttributionAnalysisPort {
  /** The family's recorded promoted-candidate lifecycle records. */
  lifecycleFor(familyId: string): readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (VAL-036's maturity curves). */
  generationsFor(familyId: string): readonly PromotionGenerationRecord[];
  /** The family's recorded accounting ledger entries (the savings basis). */
  accountingFor(familyId: string): readonly AttributionLedgerEntry[];
  /** The family's recorded incumbent baselines (VAL-044's adjusted model). */
  baselinesFor(familyId: string): readonly IncumbentBaselineRecord[];
  /** The family's recorded per-generation savings totals. */
  recordedTotalsFor(familyId: string): readonly RecordedSavingsTotalRecord[];
  /** The family's recorded maturity reports (VAL-036's append-only artifacts). */
  maturityReportsFor(familyId: string): readonly MaturityReportRecord[];
  /** The candidate registry's read-only proposal view (the cited identities). */
  proposalFor(proposalId: string): DiscoveryProposalRecord | null;
  /** The port's own frozen facts (the read-only fingerprint's basis). */
  facts(): AttributionAnalysisFacts;
}

/** The read-only analysis facts (the input fingerprint's basis). */
export interface AttributionAnalysisFacts {
  /** Every family the recorded economics + history know (sorted). */
  readonly familyIds: readonly string[];
  /** The number of recorded lifecycle records (the promoted walks). */
  readonly lifecycleRecordCount: number;
  /** The number of recorded promotion generations (the maturity curves). */
  readonly generationRecordCount: number;
  /** The number of recorded accounting ledger entries. */
  readonly accountingEntryCount: number;
  /** The number of recorded incumbent baselines (VAL-044's model). */
  readonly baselineCount: number;
  /** The number of recorded savings totals. */
  readonly recordedTotalCount: number;
  /** The number of recorded maturity reports (VAL-036's artifacts). */
  readonly maturityReportCount: number;
  /** The registry's proposal ids (sorted — the cited-identity basis). */
  readonly registryProposalIds: readonly string[];
}

/**
 * The canonical digest over the analysis port's facts (PURE — the
 * read-only fingerprint the driver snapshots before and after every
 * run: the recorded economics + history are a frozen input).
 */
export function attributionInputDigestOf(facts: AttributionAnalysisFacts): string {
  return longitudinalDigestOf([
    "attribution-input",
    facts.familyIds,
    facts.lifecycleRecordCount,
    facts.generationRecordCount,
    facts.accountingEntryCount,
    facts.baselineCount,
    facts.recordedTotalCount,
    facts.maturityReportCount,
    facts.registryProposalIds,
  ]);
}

/**
 * The attribution report port (APPEND-ONLY): the analysis APPENDS its
 * attribution reports — an identical re-append REPLAYS (idempotent), a
 * different report under the same familyId is REFUSED, and a report
 * ledger that mutates the recorded history FAILs the driver
 * mechanically.
 */
export interface AttributionReportPort {
  append(record: Omit<SavingsAttributionReportRecord, "ordinal">): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }>;
  reportsFor(familyId: string): readonly SavingsAttributionReportRecord[];
}

// ---------------------------------------------------------------------------
// Evidence-citation completeness (the attribution oracle's citation leg)
// ---------------------------------------------------------------------------

/** The attribution evidence-citation verdict. */
export interface AttributionEvidenceCitationVerdict {
  /** Every cited member is a population member AND the full population is cited. */
  readonly complete: boolean;
  readonly populationLedgerCount: number;
  readonly populationLifecycleCount: number;
  readonly populationBaselineCount: number;
  readonly populationTotalCount: number;
  /** Cited ledger entry ids that are NOT members of the recorded population (phantom). */
  readonly phantomLedgerEntryIds: readonly string[];
  /** Cited lifecycle proposals that are NOT members of the recorded population (phantom). */
  readonly phantomLifecycleProposalIds: readonly string[];
  /** Claims with a NONZERO number and NO ledger citations (uncited claims). */
  readonly uncitedClaims: readonly {
    readonly mechanism: CandidateKind;
    readonly generation: number;
  }[];
  /** Recorded ledger entries NO claim cited (the partial population). */
  readonly uncitedLedgerEntryIds: readonly string[];
  /** Recorded lifecycle records NO claim cited (the partial population). */
  readonly uncitedLifecycleProposalIds: readonly string[];
  /** A generalization demands at least one recorded generation (an empty basis is not evidence). */
  readonly minimumEvidence: boolean;
  readonly citationDigest: string;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the attribution evidence-citation completeness (PURE — the
 * attribution oracle's citation leg): every attribution claim cites
 * its FULL evidence population — the exact ledger entries and
 * lifecycle records it attributes from, and the family-level
 * population is FULLY covered (every recorded ledger entry and every
 * recorded lifecycle record cited by some claim). A PHANTOM citation
 * (a cited member that is not in the recorded population) FAILs with
 * the member named; an UNCITED claim (a nonzero claim with no ledger
 * citations) FAILs with the claim named; a PARTIAL population (a
 * recorded member the union of claims missed) FAILs with the member
 * named; and the family must hold at least one recorded generation
 * (an attribution from an empty basis FAILs).
 */
export function deriveAttributionEvidenceCitation(input: {
  /** The family's recorded lifecycle records (the read-only population). */
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (the read-only basis). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The family's recorded accounting ledger entries (the read-only population). */
  readonly ledgerEntries: readonly AttributionLedgerEntry[];
  /** The family's recorded incumbent baselines (the read-only population). */
  readonly baselines: readonly IncumbentBaselineRecord[];
  /** The family's recorded savings totals (the read-only population). */
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): AttributionEvidenceCitationVerdict {
  const populationLedgerEntryIds = input.ledgerEntries.map((entry) => entry.entryId);
  const populationLifecycleProposalIds = input.lifecycleRecords.map((record) => record.proposalId);

  const citedLedgerEntryIds = [
    ...new Set(input.split.claims.flatMap((claim) => [...claim.citedLedgerEntryIds])),
  ];
  const citedLifecycleProposalIds = [
    ...new Set(input.split.claims.flatMap((claim) => [...claim.citedLifecycleProposalIds])),
  ];

  const phantomLedgerEntryIds = citedLedgerEntryIds.filter(
    (entryId) => !populationLedgerEntryIds.includes(entryId),
  );
  const phantomLifecycleProposalIds = citedLifecycleProposalIds.filter(
    (proposalId) => !populationLifecycleProposalIds.includes(proposalId),
  );
  const uncitedClaims = input.split.claims
    .filter(
      (claim) =>
        claim.claimedMicroUsd !== 0 &&
        claim.citedLedgerEntryIds.length === 0 &&
        claim.citedLifecycleProposalIds.length === 0,
    )
    .map((claim) => ({ mechanism: claim.mechanism, generation: claim.generation }));
  const uncitedLedgerEntryIds = populationLedgerEntryIds.filter(
    (entryId) => !citedLedgerEntryIds.includes(entryId),
  );
  const uncitedLifecycleProposalIds = populationLifecycleProposalIds.filter(
    (proposalId) => !citedLifecycleProposalIds.includes(proposalId),
  );
  const minimumEvidence = input.generations.length >= 1;

  const complete =
    phantomLedgerEntryIds.length === 0 &&
    phantomLifecycleProposalIds.length === 0 &&
    uncitedClaims.length === 0 &&
    uncitedLedgerEntryIds.length === 0 &&
    uncitedLifecycleProposalIds.length === 0 &&
    minimumEvidence;

  const citation = canonicalAttributionCitationOf({
    ledgerEntries: input.ledgerEntries,
    lifecycleRecords: input.lifecycleRecords,
    baselines: input.baselines,
    recordedTotals: input.recordedTotals,
  });

  return {
    complete,
    populationLedgerCount: input.ledgerEntries.length,
    populationLifecycleCount: input.lifecycleRecords.length,
    populationBaselineCount: input.baselines.length,
    populationTotalCount: input.recordedTotals.length,
    phantomLedgerEntryIds,
    phantomLifecycleProposalIds,
    uncitedClaims,
    uncitedLedgerEntryIds,
    uncitedLifecycleProposalIds,
    minimumEvidence,
    citationDigest: attributionCitationDigestOf(citation),
    criteria: [
      {
        criterionId: "attribution-citation-no-phantom-members",
        strategy: "deterministic",
        status:
          phantomLedgerEntryIds.length === 0 && phantomLifecycleProposalIds.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `phantomLedgerEntries:${phantomLedgerEntryIds.join(",") || "none"}`,
          `phantomLifecycle:${phantomLifecycleProposalIds.join(",") || "none"}`,
          phantomLedgerEntryIds.length === 0 && phantomLifecycleProposalIds.length === 0
            ? "every-cited-member-is-a-recorded-population-member"
            : "PHANTOM-CITATION (a cited member is not in the recorded population — a fabricated citation)",
        ],
      },
      {
        criterionId: "attribution-citation-claims-cite-evidence",
        strategy: "deterministic",
        status: uncitedClaims.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `claims:${input.split.claims.length}`,
          `uncitedClaims:${uncitedClaims.map((claim) => `${claim.mechanism}@g${claim.generation}`).join(",") || "none"}`,
          uncitedClaims.length === 0
            ? "every-nonzero-claim-cites-its-ledger-evidence"
            : "UNCITED-CLAIM (a nonzero claim with no ledger citations — an attribution from nothing)",
        ],
      },
      {
        criterionId: "attribution-citation-full-population",
        strategy: "deterministic",
        status:
          uncitedLedgerEntryIds.length === 0 && uncitedLifecycleProposalIds.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `populationLedgerEntries:${populationLedgerEntryIds.length}`,
          `populationLifecycle:${populationLifecycleProposalIds.length}`,
          `uncitedLedgerEntries:${uncitedLedgerEntryIds.join(",") || "none"}`,
          `uncitedLifecycle:${uncitedLifecycleProposalIds.join(",") || "none"}`,
          uncitedLedgerEntryIds.length === 0 && uncitedLifecycleProposalIds.length === 0
            ? "the-claims-cite-the-full-recorded-population (every entry and every lifecycle record attributed somewhere)"
            : "PARTIAL-POPULATION (a recorded member the claims missed — an incomplete attribution)",
        ],
      },
      {
        criterionId: "attribution-citation-minimum-evidence",
        strategy: "deterministic",
        status: minimumEvidence ? "PASS" : "FAIL",
        evidence: [
          `recordedGenerations:${input.generations.length}`,
          minimumEvidence
            ? "the-family-holds-at-least-one-recorded-generation"
            : "EMPTY-BASIS (an attribution from an empty recorded basis is not evidence)",
        ],
      },
      {
        criterionId: "attribution-citation-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `citationDigest:${attributionCitationDigestOf(citation)}`,
          `phantoms:${phantomLedgerEntryIds.length + phantomLifecycleProposalIds.length}`,
          `uncitedClaims:${uncitedClaims.length}`,
          `uncitedPopulation:${uncitedLedgerEntryIds.length + uncitedLifecycleProposalIds.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// No-double-count (each ledger entry attributed to at most one mechanism)
// ---------------------------------------------------------------------------

/** ONE double-counted ledger entry (both claiming mechanisms named). */
export interface DoubleCountedEntry {
  /** The entry attributed to more than one mechanism (named). */
  readonly entryId: string;
  /** The FIRST mechanism claiming the entry (named). */
  readonly firstMechanism: CandidateKind;
  /** The SECOND mechanism claiming the entry (both claims named). */
  readonly secondMechanism: CandidateKind;
}

/** The no-double-count verdict. */
export interface NoDoubleCountVerdict {
  /** Each ledger entry is attributed to at most one mechanism. */
  readonly undoubled: boolean;
  /** The entries attributed to two mechanisms (both claims named). */
  readonly doubleCountedEntries: readonly DoubleCountedEntry[];
  /** Claims citing the SAME entry twice within their own citation list. */
  readonly selfDoubleCitingClaims: readonly {
    readonly mechanism: CandidateKind;
    readonly generation: number;
  }[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the no-double-count discipline (PURE — the attribution
 * oracle's exclusivity leg): each ledger entry is attributed to AT
 * MOST ONE mechanism. The same entry cited by TWO claims is a
 * DOUBLE-COUNT and FAILs with BOTH claims named (the two mechanisms
 * inflating the attribution by counting the same savings twice); a
 * claim citing the same entry TWICE within its own citation list is a
 * SELF-DOUBLE-CITE and FAILs with the claim named.
 */
export function deriveNoDoubleCount(input: {
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): NoDoubleCountVerdict {
  const entryOwners = new Map<string, CandidateKind[]>();
  for (const claim of input.split.claims) {
    const uniqueEntries = [...new Set(claim.citedLedgerEntryIds)];
    for (const entryId of uniqueEntries) {
      const owners = entryOwners.get(entryId) ?? [];
      owners.push(claim.mechanism);
      entryOwners.set(entryId, owners);
    }
  }
  const doubleCountedEntries: DoubleCountedEntry[] = [];
  for (const [entryId, owners] of entryOwners) {
    if (owners.length > 1) {
      doubleCountedEntries.push({
        entryId,
        firstMechanism: owners[0] ?? "reuse",
        secondMechanism: owners[1] ?? "cache",
      });
    }
  }
  const selfDoubleCitingClaims = input.split.claims
    .filter((claim) => new Set(claim.citedLedgerEntryIds).size !== claim.citedLedgerEntryIds.length)
    .map((claim) => ({ mechanism: claim.mechanism, generation: claim.generation }));
  const undoubled = doubleCountedEntries.length === 0 && selfDoubleCitingClaims.length === 0;

  return {
    undoubled,
    doubleCountedEntries,
    selfDoubleCitingClaims,
    criteria: [
      {
        criterionId: "attribution-no-double-count",
        strategy: "deterministic",
        status: doubleCountedEntries.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `claims:${input.split.claims.length}`,
          `doubleCountedEntries:${doubleCountedEntries.map((entry) => `${entry.entryId}(${entry.firstMechanism}+${entry.secondMechanism})`).join(";") || "none"}`,
          doubleCountedEntries.length === 0
            ? "each-ledger-entry-is-attributed-to-at-most-one-mechanism"
            : "DOUBLE-COUNT (the same ledger entry attributed to two mechanisms — both claims named; the savings counted twice)",
        ],
      },
      {
        criterionId: "attribution-no-self-double-cite",
        strategy: "deterministic",
        status: selfDoubleCitingClaims.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `selfDoubleCitingClaims:${selfDoubleCitingClaims.map((claim) => `${claim.mechanism}@g${claim.generation}`).join(",") || "none"}`,
          selfDoubleCitingClaims.length === 0
            ? "no-claim-cites-the-same-entry-twice-within-its-own-citation"
            : "SELF-DOUBLE-CITE (a claim citing the same entry twice — inflating its own evidence)",
        ],
      },
      {
        criterionId: "attribution-no-double-count-summary",
        strategy: "deterministic",
        status: undoubled ? "PASS" : "FAIL",
        evidence: [
          `undoubled:${String(undoubled)}`,
          `doubleCounted:${doubleCountedEntries.length}`,
          `selfDoubleCiting:${selfDoubleCitingClaims.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Residual honesty (reported, never forced)
// ---------------------------------------------------------------------------

/** ONE forced-residual shape (the mechanism and the excess named). */
export interface ForcedResidualShape {
  /** The mechanism the residual was forced into (named). */
  readonly mechanism: CandidateKind;
  /** The generation the forcing happened in (named). */
  readonly generation: number;
  /** The claimed number (the inflated side). */
  readonly claimedMicroUsd: number;
  /** The cited evidence's measured sum (the recorded side). */
  readonly citedEvidenceMicroUsd: number;
}

/** The residual-honesty verdict. */
export interface ResidualHonestyVerdict {
  /** The residual is reported honestly and never forced into a mechanism. */
  readonly honest: boolean;
  /** Mechanism claims EXCEEDING their cited evidence (the forced residual). */
  readonly forcedResiduals: readonly ForcedResidualShape[];
  /** Mechanism claims UNDER their cited evidence (the under-attribution). */
  readonly underAttributions: readonly ForcedResidualShape[];
  /** Generations whose residual exists but was NOT reported (hidden). */
  readonly hiddenResidualGenerations: readonly number[];
  /** Generations whose reported residual does not match the recorded basis. */
  readonly mismatchedResidualGenerations: readonly {
    readonly generation: number;
    readonly reportedResidualMicroUsd: number;
    readonly recordedResidualMicroUsd: number;
  }[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the residual honesty (PURE — the attribution oracle's honesty
 * leg): the unattributed residual is REPORTED, never forced into a
 * mechanism. A mechanism claim whose number EXCEEDS the sum of its
 * cited entries' measured savings is a FORCED RESIDUAL — savings
 * without that mechanism's recorded evidence claimed as its own — and
 * FAILs with the mechanism and the excess named; an UNDER-attribution
 * (a claim below its evidence) FAILs with both sides named. The
 * REPORTED residual must equal the recorded total minus the attributed
 * sum per generation: a HIDDEN residual (a residual exists but was
 * not reported) or an INFLATED/DEFLATED one FAILs with both sides
 * named.
 */
export function deriveResidualHonesty(input: {
  /** The family's recorded accounting ledger entries (the savings basis). */
  readonly ledgerEntries: readonly AttributionLedgerEntry[];
  /** The family's recorded savings totals (the residual basis). */
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): ResidualHonestyVerdict {
  const entryById = new Map(input.ledgerEntries.map((entry) => [entry.entryId, entry]));
  const forcedResiduals: ForcedResidualShape[] = [];
  const underAttributions: ForcedResidualShape[] = [];
  for (const claim of input.split.claims) {
    let citedEvidence = 0;
    for (const entryId of claim.citedLedgerEntryIds) {
      const entry = entryById.get(entryId);
      if (entry !== undefined) {
        citedEvidence += entry.microUsd;
      }
    }
    if (claim.claimedMicroUsd > citedEvidence) {
      forcedResiduals.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        claimedMicroUsd: claim.claimedMicroUsd,
        citedEvidenceMicroUsd: citedEvidence,
      });
    } else if (claim.claimedMicroUsd < citedEvidence) {
      underAttributions.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        claimedMicroUsd: claim.claimedMicroUsd,
        citedEvidenceMicroUsd: citedEvidence,
      });
    }
  }

  const hiddenResidualGenerations: number[] = [];
  const mismatchedResidualGenerations: {
    generation: number;
    reportedResidualMicroUsd: number;
    recordedResidualMicroUsd: number;
  }[] = [];
  for (const total of input.recordedTotals) {
    const attributedInGeneration = input.split.claims
      .filter((claim) => claim.generation === total.generation)
      .reduce((sum, claim) => sum + claim.claimedMicroUsd, 0);
    const recordedResidual = total.totalMicroUsd - attributedInGeneration;
    const residualClaim = input.split.residual.find(
      (claim) => claim.generation === total.generation,
    );
    if (residualClaim === undefined || !residualClaim.reported) {
      if (recordedResidual !== 0) {
        hiddenResidualGenerations.push(total.generation);
      }
      continue;
    }
    if (residualClaim.residualMicroUsd !== recordedResidual) {
      mismatchedResidualGenerations.push({
        generation: total.generation,
        reportedResidualMicroUsd: residualClaim.residualMicroUsd,
        recordedResidualMicroUsd: recordedResidual,
      });
    }
  }

  const honest =
    forcedResiduals.length === 0 &&
    underAttributions.length === 0 &&
    hiddenResidualGenerations.length === 0 &&
    mismatchedResidualGenerations.length === 0;

  return {
    honest,
    forcedResiduals,
    underAttributions,
    hiddenResidualGenerations,
    mismatchedResidualGenerations,
    criteria: [
      {
        criterionId: "attribution-residual-never-forced",
        strategy: "deterministic",
        status: forcedResiduals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `claims:${input.split.claims.length}`,
          `forcedResiduals:${forcedResiduals.map((shape) => `${shape.mechanism}@g${shape.generation}(claimed=${shape.claimedMicroUsd},evidence=${shape.citedEvidenceMicroUsd})`).join(";") || "none"}`,
          forcedResiduals.length === 0
            ? "no-mechanism-claim-exceeds-its-cited-evidence (the residual never forced into a mechanism)"
            : "FORCED-RESIDUAL (a claim exceeding its cited evidence — unattributed savings claimed as a mechanism's own, both sides named)",
        ],
      },
      {
        criterionId: "attribution-no-under-attribution",
        strategy: "deterministic",
        status: underAttributions.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `underAttributions:${underAttributions.map((shape) => `${shape.mechanism}@g${shape.generation}(claimed=${shape.claimedMicroUsd},evidence=${shape.citedEvidenceMicroUsd})`).join(";") || "none"}`,
          underAttributions.length === 0
            ? "every-claim-carries-its-cited-evidence-exactly"
            : "UNDER-ATTRIBUTION (a claim below its cited evidence — the split understates a mechanism, both sides named)",
        ],
      },
      {
        criterionId: "attribution-residual-reported",
        strategy: "deterministic",
        status: hiddenResidualGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `recordedTotals:${input.recordedTotals.length}`,
          `hiddenResidualGenerations:${hiddenResidualGenerations.join(",") || "none"}`,
          hiddenResidualGenerations.length === 0
            ? "every-existing-residual-is-reported (never silently dropped)"
            : "HIDDEN-RESIDUAL (a residual exists but was not reported — hiding the unattributed share)",
        ],
      },
      {
        criterionId: "attribution-residual-matches-recorded",
        strategy: "deterministic",
        status: mismatchedResidualGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `mismatchedResidualGenerations:${mismatchedResidualGenerations.map((shape) => `g${shape.generation}(reported=${shape.reportedResidualMicroUsd},recorded=${shape.recordedResidualMicroUsd})`).join(";") || "none"}`,
          mismatchedResidualGenerations.length === 0
            ? "every-reported-residual-equals-the-recorded-total-minus-the-attributed-sum"
            : "RESIDUAL-MISMATCH (the reported residual does not match the recorded basis — both sides named)",
        ],
      },
      {
        criterionId: "attribution-residual-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `forced:${forcedResiduals.length}`,
          `under:${underAttributions.length}`,
          `hidden:${hiddenResidualGenerations.length}`,
          `mismatched:${mismatchedResidualGenerations.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The reconciliation identity (attributed + residual = recorded total)
// ---------------------------------------------------------------------------

/** ONE per-generation reconciliation mismatch (both sides named). */
export interface ReconciliationMismatch {
  /** The generation whose identity broke (named). */
  readonly generation: number;
  /** The attributed sum + the reported residual (the claimed side). */
  readonly attributedPlusResidualMicroUsd: number;
  /** The recorded total savings (the recorded side). */
  readonly recordedTotalMicroUsd: number;
}

/** The reconciliation verdict. */
export interface AttributionReconciliationVerdict {
  /** The reconciliation identity holds per family per generation. */
  readonly reconciled: boolean;
  /** The per-generation mismatches (both sides named). */
  readonly mismatchedGenerations: readonly ReconciliationMismatch[];
  /** The per-mechanism attributed totals over the whole family. */
  readonly attributedByMechanism: Readonly<Record<CandidateKind, number>>;
  /** The family's total attributed savings. */
  readonly attributedTotalMicroUsd: number;
  /** The family's total reported residual. */
  readonly residualTotalMicroUsd: number;
  /** The family's recorded total savings. */
  readonly recordedTotalMicroUsd: number;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the attribution reconciliation (PURE — the attribution
 * oracle's identity leg): the attributed savings (per mechanism,
 * summed) + the honest residual EQUAL the recorded total savings per
 * family per generation — the reconciliation identity. A generation
 * whose attributed-plus-residual does not equal the recorded total
 * FAILs with BOTH sides named (the claimed side vs the recorded
 * side); a family whose recorded generations hold no totals FAILs the
 * identity's basis.
 */
export function deriveAttributionReconciliation(input: {
  /** The family's recorded savings totals (the identity's recorded side). */
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): AttributionReconciliationVerdict {
  const attributedByMechanism = {} as Record<CandidateKind, number>;
  for (const kind of ATTRIBUTION_MECHANISMS) {
    attributedByMechanism[kind] = 0;
  }
  for (const claim of input.split.claims) {
    attributedByMechanism[claim.mechanism] += claim.claimedMicroUsd;
  }
  const attributedTotalMicroUsd = ATTRIBUTION_MECHANISMS.reduce(
    (total, kind) => total + attributedByMechanism[kind],
    0,
  );
  const residualTotalMicroUsd = input.split.residual
    .filter((claim) => claim.reported)
    .reduce((total, claim) => total + claim.residualMicroUsd, 0);
  const recordedTotalMicroUsd = input.recordedTotals.reduce(
    (total, record) => total + record.totalMicroUsd,
    0,
  );

  const mismatchedGenerations: ReconciliationMismatch[] = [];
  for (const total of input.recordedTotals) {
    const attributedInGeneration = input.split.claims
      .filter((claim) => claim.generation === total.generation)
      .reduce((sum, claim) => sum + claim.claimedMicroUsd, 0);
    const residualInGeneration =
      input.split.residual.find((claim) => claim.generation === total.generation)
        ?.residualMicroUsd ?? 0;
    const attributedPlusResidual = attributedInGeneration + residualInGeneration;
    if (attributedPlusResidual !== total.totalMicroUsd) {
      mismatchedGenerations.push({
        generation: total.generation,
        attributedPlusResidualMicroUsd: attributedPlusResidual,
        recordedTotalMicroUsd: total.totalMicroUsd,
      });
    }
  }
  const identityHoldsPerGeneration = mismatchedGenerations.length === 0;
  const familyIdentityHolds =
    attributedTotalMicroUsd + residualTotalMicroUsd === recordedTotalMicroUsd;
  const hasRecordedBasis = input.recordedTotals.length >= 1;
  const reconciled = identityHoldsPerGeneration && familyIdentityHolds && hasRecordedBasis;

  return {
    reconciled,
    mismatchedGenerations,
    attributedByMechanism,
    attributedTotalMicroUsd,
    residualTotalMicroUsd,
    recordedTotalMicroUsd,
    criteria: [
      {
        criterionId: "attribution-reconciliation-identity-per-generation",
        strategy: "deterministic",
        status: identityHoldsPerGeneration ? "PASS" : "FAIL",
        evidence: [
          `recordedTotals:${input.recordedTotals.length}`,
          `mismatchedGenerations:${mismatchedGenerations.map((shape) => `g${shape.generation}(attributed+residual=${shape.attributedPlusResidualMicroUsd},recorded=${shape.recordedTotalMicroUsd})`).join(";") || "none"}`,
          identityHoldsPerGeneration
            ? "attributed-plus-residual-equals-the-recorded-total-per-generation (the reconciliation identity)"
            : "NON-RECONCILING-ATTRIBUTION (a generation where attributed + residual does not equal the recorded total — both sides named)",
        ],
      },
      {
        criterionId: "attribution-reconciliation-identity-family-total",
        strategy: "deterministic",
        status: familyIdentityHolds ? "PASS" : "FAIL",
        evidence: [
          `attributedTotal:${attributedTotalMicroUsd}`,
          `residualTotal:${residualTotalMicroUsd}`,
          `recordedTotal:${recordedTotalMicroUsd}`,
          familyIdentityHolds
            ? "the-family-attributed-plus-residual-equals-the-recorded-total"
            : "FAMILY-TOTAL-MISMATCH (the family's attributed + residual does not sum to the recorded total — both sides named)",
        ],
      },
      {
        criterionId: "attribution-reconciliation-recorded-basis",
        strategy: "deterministic",
        status: hasRecordedBasis ? "PASS" : "FAIL",
        evidence: [
          `recordedTotals:${input.recordedTotals.length}`,
          hasRecordedBasis
            ? "the-family-holds-recorded-savings-totals (the identity's recorded side)"
            : "NO-RECORDED-BASIS (no recorded savings totals to reconcile against)",
        ],
      },
      {
        criterionId: "attribution-reconciliation-summary",
        strategy: "deterministic",
        status: reconciled ? "PASS" : "FAIL",
        evidence: [
          `reconciled:${String(reconciled)}`,
          `attributedTotal:${attributedTotalMicroUsd}`,
          `residualTotal:${residualTotalMicroUsd}`,
          `recordedTotal:${recordedTotalMicroUsd}`,
          `mismatchedGenerations:${mismatchedGenerations.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Counterfactual fidelity (the recorded incumbent baseline)
// ---------------------------------------------------------------------------

/** ONE counterfactual infidelity shape (both sides named). */
export interface CounterfactualInfidelity {
  /** The mechanism whose claim broke the counterfactual (named). */
  readonly mechanism: CandidateKind;
  /** The generation the claim covers (named). */
  readonly generation: number;
  /** The shape of the infidelity (unstated / swapped / hypothetical / mismatched). */
  readonly shape: "unstated" | "swapped" | "hypothetical" | "counterfactual-mismatch";
  /** The cited baseline digest ("" when unstated). */
  readonly citedBaselineDigest: string;
  /** The recorded baseline digest for the (mechanism, generation). */
  readonly recordedBaselineDigest: string;
  /** The claimed savings (the claimed side, when numbers disagree). */
  readonly claimedMicroUsd: number | null;
  /** The recorded counterfactual (the recorded side, when numbers disagree). */
  readonly recordedCounterfactualMicroUsd: number | null;
}

/** The counterfactual-fidelity verdict. */
export interface CounterfactualFidelityVerdict {
  /** Every claim measures against the RECORDED incumbent baseline. */
  readonly faithful: boolean;
  /** The infidelity shapes (both sides named). */
  readonly infidelities: readonly CounterfactualInfidelity[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the counterfactual fidelity (PURE — the attribution oracle's
 * counterfactual leg): each mechanism's savings are measured against
 * the RECORDED incumbent baseline — the adjusted cost the mechanism
 * actually displaced, per VAL-044's adjusted model. An UNSTATED
 * baseline (a claim citing no baseline digest) FAILs named; a SWAPPED
 * baseline (a claim citing another generation's or another mechanism's
 * recorded baseline — a favorable counterfactual) FAILs with BOTH
 * sides named (cited vs recorded); a HYPOTHETICAL baseline (a digest
 * no recorded baseline holds, or a non-recorded basis) FAILs named;
 * and the claimed savings must EQUAL the recorded baseline's own
 * counterfactual (the incumbent's adjusted cost minus the
 * replacement's) — a number that does not FAILs with both sides named.
 */
export function deriveCounterfactualFidelity(input: {
  /** The family's recorded incumbent baselines (VAL-044's adjusted model). */
  readonly baselines: readonly IncumbentBaselineRecord[];
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): CounterfactualFidelityVerdict {
  const recordedBaselineByMechanismGeneration = new Map<string, IncumbentBaselineRecord>();
  for (const baseline of input.baselines) {
    recordedBaselineByMechanismGeneration.set(
      `${baseline.mechanism}@${baseline.generation}`,
      baseline,
    );
  }
  const allRecordedBaselineDigests = new Set(
    input.baselines.map((baseline) => incumbentBaselineDigestOf(baseline)),
  );

  const infidelities: CounterfactualInfidelity[] = [];
  for (const claim of input.split.claims) {
    const recorded = recordedBaselineByMechanismGeneration.get(
      `${claim.mechanism}@${claim.generation}`,
    );
    const recordedDigest = recorded === undefined ? "" : incumbentBaselineDigestOf(recorded);
    if (claim.baselineBasis !== "recorded") {
      infidelities.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        shape: "hypothetical",
        citedBaselineDigest: claim.baselineDigest,
        recordedBaselineDigest: recordedDigest,
        claimedMicroUsd: claim.claimedMicroUsd,
        recordedCounterfactualMicroUsd:
          recorded === undefined ? null : recordedCounterfactualOf(recorded),
      });
      continue;
    }
    if (claim.baselineDigest.length === 0) {
      infidelities.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        shape: "unstated",
        citedBaselineDigest: "",
        recordedBaselineDigest: recordedDigest,
        claimedMicroUsd: claim.claimedMicroUsd,
        recordedCounterfactualMicroUsd:
          recorded === undefined ? null : recordedCounterfactualOf(recorded),
      });
      continue;
    }
    if (claim.baselineDigest !== recordedDigest) {
      const swappedToAnotherRecorded = allRecordedBaselineDigests.has(claim.baselineDigest);
      infidelities.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        shape: swappedToAnotherRecorded ? "swapped" : "hypothetical",
        citedBaselineDigest: claim.baselineDigest,
        recordedBaselineDigest: recordedDigest,
        claimedMicroUsd: claim.claimedMicroUsd,
        recordedCounterfactualMicroUsd:
          recorded === undefined ? null : recordedCounterfactualOf(recorded),
      });
      continue;
    }
    if (recorded !== undefined && claim.claimedMicroUsd !== recordedCounterfactualOf(recorded)) {
      infidelities.push({
        mechanism: claim.mechanism,
        generation: claim.generation,
        shape: "counterfactual-mismatch",
        citedBaselineDigest: claim.baselineDigest,
        recordedBaselineDigest: recordedDigest,
        claimedMicroUsd: claim.claimedMicroUsd,
        recordedCounterfactualMicroUsd: recordedCounterfactualOf(recorded),
      });
    }
  }

  const unstated = infidelities.filter((shape) => shape.shape === "unstated");
  const swapped = infidelities.filter((shape) => shape.shape === "swapped");
  const hypothetical = infidelities.filter((shape) => shape.shape === "hypothetical");
  const mismatched = infidelities.filter((shape) => shape.shape === "counterfactual-mismatch");
  const faithful = infidelities.length === 0;

  return {
    faithful,
    infidelities,
    criteria: [
      {
        criterionId: "attribution-baseline-stated",
        strategy: "deterministic",
        status: unstated.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `claims:${input.split.claims.length}`,
          `unstated:${unstated.map((shape) => `${shape.mechanism}@g${shape.generation}`).join(",") || "none"}`,
          unstated.length === 0
            ? "every-claim-cites-its-incumbent-baseline"
            : "UNSTATED-BASELINE (a claim measuring against no stated baseline — the counterfactual is undefined)",
        ],
      },
      {
        criterionId: "attribution-baseline-not-swapped",
        strategy: "deterministic",
        status: swapped.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `swapped:${swapped.map((shape) => `${shape.mechanism}@g${shape.generation}(cited=${shape.citedBaselineDigest},recorded=${shape.recordedBaselineDigest})`).join(";") || "none"}`,
          swapped.length === 0
            ? "every-claim-measures-against-its-own-recorded-baseline (the generation-and-mechanism's own incumbent)"
            : "SWAPPED-BASELINE (a claim citing another generation's or mechanism's recorded baseline — a favorable counterfactual, both sides named)",
        ],
      },
      {
        criterionId: "attribution-baseline-recorded",
        strategy: "deterministic",
        status: hypothetical.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `hypothetical:${hypothetical.map((shape) => `${shape.mechanism}@g${shape.generation}`).join(",") || "none"}`,
          hypothetical.length === 0
            ? "every-claim-basis-is-recorded (never hypothetical)"
            : "HYPOTHETICAL-BASELINE (a claim measured against a baseline that was never recorded — a fabricated counterfactual)",
        ],
      },
      {
        criterionId: "attribution-counterfactual-number",
        strategy: "deterministic",
        status: mismatched.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `mismatched:${mismatched.map((shape) => `${shape.mechanism}@g${shape.generation}(claimed=${shape.claimedMicroUsd},recorded=${shape.recordedCounterfactualMicroUsd})`).join(";") || "none"}`,
          mismatched.length === 0
            ? "every-claimed-savings-equals-the-recorded-baselines-own-counterfactual (incumbent minus replacement)"
            : "COUNTERFACTUAL-MISMATCH (the claimed savings do not equal the recorded baseline's counterfactual — both sides named)",
        ],
      },
      {
        criterionId: "attribution-counterfactual-summary",
        strategy: "deterministic",
        status: faithful ? "PASS" : "FAIL",
        evidence: [
          `faithful:${String(faithful)}`,
          `unstated:${unstated.length}`,
          `swapped:${swapped.length}`,
          `hypothetical:${hypothetical.length}`,
          `mismatched:${mismatched.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Generation-series integrity (matching VAL-036's maturity curves)
// ---------------------------------------------------------------------------

/** The generation-series integrity verdict. */
export interface GenerationSeriesIntegrityVerdict {
  /** The series matches the maturity benchmark's recorded generations. */
  readonly integral: boolean;
  /** The attribution's generation ordinals (sorted). */
  readonly seriesGenerations: readonly number[];
  /** The maturity benchmark's recorded generation ordinals (sorted). */
  readonly maturityGenerations: readonly number[];
  /** Recorded generations the attribution MISSED (a gapped series). */
  readonly missingGenerations: readonly number[];
  /** Attribution generations the recorded maturity curves DO NOT hold (mismatched). */
  readonly unrecordedGenerations: readonly number[];
  /** The attribution demands at least one generation (an empty series is not an attribution). */
  readonly minimumSeries: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the generation-series integrity (PURE — the attribution
 * oracle's maturity-linkage leg): the attribution's generation series
 * must MATCH the maturity benchmark's recorded generations (VAL-036's
 * curves — the family's recorded promotion generations). A GAPPED
 * series (a recorded generation the attribution's claims missed — the
 * attribution silently skipped a generation's savings) FAILs with the
 * generation named; a MISMATCHED series (a generation the recorded
 * maturity curves do not hold — a fabricated generation) FAILs with
 * the generation named; and an EMPTY series FAILs the minimum.
 */
export function deriveGenerationSeriesIntegrity(input: {
  /** The family's recorded promotion generations (VAL-036's maturity curves). */
  readonly recordedGenerations: readonly PromotionGenerationRecord[];
  /** The attribution's declared claim set under test. */
  readonly split: FamilyAttributionSplit;
}): GenerationSeriesIntegrityVerdict {
  const maturityGenerations = [
    ...new Set(input.recordedGenerations.map((generation) => generation.generation)),
  ].sort((left, right) => left - right);
  const seriesGenerations = [...new Set(input.split.claims.map((claim) => claim.generation))].sort(
    (left, right) => left - right,
  );
  const missingGenerations = maturityGenerations.filter(
    (generation) => !seriesGenerations.includes(generation),
  );
  const unrecordedGenerations = seriesGenerations.filter(
    (generation) => !maturityGenerations.includes(generation),
  );
  const minimumSeries = seriesGenerations.length >= 1;
  const integral =
    missingGenerations.length === 0 && unrecordedGenerations.length === 0 && minimumSeries;

  return {
    integral,
    seriesGenerations,
    maturityGenerations,
    missingGenerations,
    unrecordedGenerations,
    minimumSeries,
    criteria: [
      {
        criterionId: "attribution-series-matches-maturity",
        strategy: "deterministic",
        status: missingGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `maturityGenerations:${maturityGenerations.join(",") || "none"}`,
          `seriesGenerations:${seriesGenerations.join(",") || "none"}`,
          `missingGenerations:${missingGenerations.join(",") || "none"}`,
          missingGenerations.length === 0
            ? "the-attribution-covers-every-recorded-maturity-generation (VAL-036's curves)"
            : "GAPPED-SERIES (a recorded generation the attribution missed — a generation's savings silently skipped)",
        ],
      },
      {
        criterionId: "attribution-series-no-fabricated-generations",
        strategy: "deterministic",
        status: unrecordedGenerations.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `unrecordedGenerations:${unrecordedGenerations.join(",") || "none"}`,
          unrecordedGenerations.length === 0
            ? "every-attributed-generation-is-a-recorded-maturity-generation"
            : "MISMATCHED-SERIES (a generation the recorded maturity curves do not hold — a fabricated generation)",
        ],
      },
      {
        criterionId: "attribution-series-minimum",
        strategy: "deterministic",
        status: minimumSeries ? "PASS" : "FAIL",
        evidence: [
          `seriesGenerations:${seriesGenerations.length}`,
          minimumSeries
            ? "the-attribution-covers-at-least-one-generation"
            : "EMPTY-SERIES (an attribution over no generations is not an attribution)",
        ],
      },
      {
        criterionId: "attribution-series-summary",
        strategy: "deterministic",
        status: integral ? "PASS" : "FAIL",
        evidence: [
          `integral:${String(integral)}`,
          `series:${seriesGenerations.join(",") || "none"}`,
          `maturity:${maturityGenerations.join(",") || "none"}`,
          `missing:${missingGenerations.length}`,
          `unrecorded:${unrecordedGenerations.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Attribution honesty (measured baselines, honest boundaries)
// ---------------------------------------------------------------------------

/** The attribution-honesty verdict. */
export interface AttributionHonestyVerdict {
  /** Every recorded baseline is measured and the boundaries are honest. */
  readonly honest: boolean;
  /** Baselines (by mechanism+generation) whose costs were ESTIMATED, not measured. */
  readonly estimatedBaselines: readonly {
    readonly mechanism: CandidateKind;
    readonly generation: number;
  }[];
  /** Whether the offline none-reported usage boundary is honest. */
  readonly noneReportedUsageHonest: boolean;
  /** Whether a fabricated usage was reported where none should be. */
  readonly fabricatedUsage: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the attribution honesty (PURE — the measurement-discipline
 * oracle): every recorded incumbent baseline's adjusted costs must be
 * MEASURED (never estimated — a baseline recorded with
 * `measured: false` FAILs, named by mechanism+generation) and the
 * none-reported boundaries must be honest — offline, the run's usage
 * is honestly none-reported (`reportedUsage: null`), and a FABRICATED
 * usage reported offline FAILs. Usage is measured only on the live
 * rail.
 */
export function deriveAttributionHonesty(input: {
  /** The family's recorded incumbent baselines (the measurement basis). */
  readonly baselines: readonly IncumbentBaselineRecord[];
  /** The run's reported usage (null = honestly none-reported offline). */
  readonly reportedUsage: LabUsage | null;
  /** Whether the run executed on the live rail (measured usage admissible). */
  readonly liveRail: boolean;
}): AttributionHonestyVerdict {
  const estimatedBaselines = input.baselines
    .filter((baseline) => !baseline.measured)
    .map((baseline) => ({ mechanism: baseline.mechanism, generation: baseline.generation }));
  const fabricatedUsage = !input.liveRail && input.reportedUsage !== null;
  const noneReportedUsageHonest = input.liveRail || input.reportedUsage === null;
  const honest = estimatedBaselines.length === 0 && !fabricatedUsage && noneReportedUsageHonest;

  return {
    honest,
    estimatedBaselines,
    noneReportedUsageHonest,
    fabricatedUsage,
    criteria: [
      {
        criterionId: "attribution-honesty-baselines-measured",
        strategy: "deterministic",
        status: estimatedBaselines.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `baselines:${input.baselines.length}`,
          `estimatedBaselines:${estimatedBaselines.map((shape) => `${shape.mechanism}@g${shape.generation}`).join(",") || "none"}`,
          estimatedBaselines.length === 0
            ? "every-recorded-baseline-was-measured (never estimated)"
            : "ESTIMATED-BASELINE (a baseline's adjusted costs were estimated, not measured — an honest attribution never estimates its counterfactual)",
        ],
      },
      {
        criterionId: "attribution-honesty-none-reported-boundary",
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
        criterionId: "attribution-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `estimated:${estimatedBaselines.length}`,
          `fabricatedUsage:${String(fabricatedUsage)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The refusal honesty (a refusal is honest only when justified)
// ---------------------------------------------------------------------------

/** The attribution refusal-honesty verdict. */
export interface AttributionRefusalHonestyVerdict {
  /** The refusal reason matches the family's own recorded state. */
  readonly honest: boolean;
  readonly reason: AttributionRefusalReason | null;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the attribution refusal honesty (PURE): a refusal is honest
 * ONLY when the family's own recorded state justifies it —
 * `family-unrecorded` demands an EMPTY recorded lifecycle, and
 * `no-savings-recorded` demands a recorded lifecycle WITH generations
 * but NO recorded savings (no ledger entries AND no recorded totals).
 * Any other refusal (a recorded family with savings refusing) is
 * dishonest and FAILs.
 */
export function deriveAttributionRefusalHonesty(input: {
  readonly refusal: { readonly reason: AttributionRefusalReason } | null;
  readonly lifecycleRecordCount: number;
  readonly generationCount: number;
  readonly ledgerEntryCount: number;
  readonly recordedTotalCount: number;
}): AttributionRefusalHonestyVerdict {
  let honest = true;
  if (input.refusal !== null) {
    if (input.refusal.reason === "family-unrecorded") {
      honest = input.lifecycleRecordCount === 0;
    } else if (input.refusal.reason === "no-savings-recorded") {
      honest =
        input.lifecycleRecordCount > 0 &&
        input.generationCount > 0 &&
        input.ledgerEntryCount === 0 &&
        input.recordedTotalCount === 0;
    }
  }
  return {
    honest,
    reason: input.refusal === null ? null : input.refusal.reason,
    criteria: [
      {
        criterionId: "attribution-refusal-honesty",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal === null ? "none" : input.refusal.reason}`,
          `lifecycleRecords:${input.lifecycleRecordCount}`,
          `generations:${input.generationCount}`,
          `ledgerEntries:${input.ledgerEntryCount}`,
          `recordedTotals:${input.recordedTotalCount}`,
          honest
            ? "the-refusal-matches-the-familys-own-recorded-state"
            : "DISHONEST-REFUSAL (the family's recorded state does not justify the refusal)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The corpus-row shape (the attribution declaration)
// ---------------------------------------------------------------------------

/**
 * ONE attribution corpus row: the workload family the attribution
 * covers, the family's declared attribution split (the per-mechanism
 * claims citing the recorded lifecycle + ledger + baseline evidence,
 * and the honest residual), and the EXPECTED outcome (the honest
 * oracle's verdict — established, an honest no-evidence refusal, or
 * the probe's invalid shape).
 */
export interface AttributionCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The workload family the attribution covers (the family's recorded economics + history are the read-only input). */
  readonly familyId: string;
  /** The declared attribution split (the per-mechanism claims + the honest residual). */
  readonly split: FamilyAttributionSplit;
  /** The pinned expected outcome (the honest oracle). */
  readonly expected: {
    /** The expected verdict kind. */
    readonly verdict: AttributionVerdictKind;
    /** The expected refusal reason (null when the run does not refuse). */
    readonly refusalReason: AttributionRefusalReason | null;
    /** The expected terminal status. */
    readonly terminal: "COMPLETED" | "FAILED";
    /** The expected route model calls (0 offline; the live row's measured round). */
    readonly modelCalls: number;
  };
  /** The probe the row declares (the adversarial variant driven in phase 2). */
  readonly probe?: { readonly kind: AttributionProbeKind };
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
 * (full population, no phantoms, every claim cited), the
 * no-double-count legs (each entry at most one mechanism), the
 * residual-honesty legs (never forced, always reported, matching the
 * recorded basis), the reconciliation legs (the identity per
 * generation and family), the counterfactual legs (the recorded
 * incumbent baseline), the generation-series legs (matching VAL-036's
 * curves), the honesty legs (measured baselines; honest boundaries),
 * the report-landing legs, the read-only input legs, the
 * expected-verdict contract, the payload-free digest discipline and
 * the honest accounting.
 */
export function deriveAttributionRowCriteria(input: {
  readonly row: AttributionCorpusRow;
  readonly refusal: { readonly reason: AttributionRefusalReason } | null;
  readonly refusalHonesty: AttributionRefusalHonestyVerdict | null;
  readonly citation: AttributionEvidenceCitationVerdict | null;
  readonly noDoubleCount: NoDoubleCountVerdict | null;
  readonly residualHonesty: ResidualHonestyVerdict | null;
  readonly reconciliation: AttributionReconciliationVerdict | null;
  readonly counterfactual: CounterfactualFidelityVerdict | null;
  readonly generationSeries: GenerationSeriesIntegrityVerdict | null;
  readonly honesty: AttributionHonestyVerdict | null;
  readonly reportLanded: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly reportsAppended: number;
  readonly inputUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly verdict: AttributionVerdictKind;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  if (input.citation !== null) {
    criteria.push(...input.citation.criteria);
  }
  if (input.noDoubleCount !== null) {
    criteria.push(...input.noDoubleCount.criteria);
  }
  if (input.residualHonesty !== null) {
    criteria.push(...input.residualHonesty.criteria);
  }
  if (input.reconciliation !== null) {
    criteria.push(...input.reconciliation.criteria);
  }
  if (input.counterfactual !== null) {
    criteria.push(...input.counterfactual.criteria);
  }
  if (input.generationSeries !== null) {
    criteria.push(...input.generationSeries.criteria);
  }
  if (input.honesty !== null) {
    criteria.push(...input.honesty.criteria);
  }
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // The report landing: an executed attribution appends its report; a
  // refusal appends NOTHING.
  criteria.push({
    criterionId: "attribution-report-landing",
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
          ? "the-refusal-appended-nothing (nothing to attribute)"
          : "REFUSAL-APPENDED (a refusal must append nothing)"
        : input.reportLanded?.accepted
          ? "the-analysis-landed-its-attribution-report (append-only)"
          : "MISSING-REPORT (an executed attribution must append its report)",
    ],
  });

  // The read-only input discipline: the recorded economics + history's
  // digest is IDENTICAL before and after the run.
  criteria.push({
    criterionId: "attribution-input-read-only",
    strategy: "deterministic",
    status: input.inputUnchanged ? "PASS" : "FAIL",
    evidence: [
      `inputUnchanged:${String(input.inputUnchanged)}`,
      input.inputUnchanged
        ? "the-recorded-economics-and-history-digest-is-identical-before-and-after (the read-only proof)"
        : "MUTATED-INPUT (the recorded economics or lifecycle history changed over the run — a frozen input was rewritten)",
    ],
  });

  // The expected-verdict contract: the observed verdict matches the
  // pinned oracle.
  criteria.push({
    criterionId: "attribution-expected-verdict",
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
    criterionId: "attribution-own-dispatches",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-attribution-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // The dispatch failure honesty: a failed live round FAILs the row.
  criteria.push({
    criterionId: "attribution-dispatch-failure-honesty",
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
 * `no-evidence-honest`; a trustworthy attribution is
 * `attribution-established`; every untrustworthy shape (a FAILing
 * leg) is `attribution-invalid` — an internal honesty failure, never
 * a passable outcome.
 */
export function deriveAttributionVerdictKind(input: {
  readonly refusal: { readonly reason: AttributionRefusalReason } | null;
  readonly refusalHonesty: AttributionRefusalHonestyVerdict | null;
  readonly citation: AttributionEvidenceCitationVerdict | null;
  readonly noDoubleCount: NoDoubleCountVerdict | null;
  readonly residualHonesty: ResidualHonestyVerdict | null;
  readonly reconciliation: AttributionReconciliationVerdict | null;
  readonly counterfactual: CounterfactualFidelityVerdict | null;
  readonly generationSeries: GenerationSeriesIntegrityVerdict | null;
  readonly honesty: AttributionHonestyVerdict | null;
  readonly inputUnchanged: boolean;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): AttributionVerdictKind {
  if (input.failure !== null) {
    return "attribution-invalid";
  }
  if (input.refusal !== null) {
    return (input.refusalHonesty?.honest ?? false) ? "no-evidence-honest" : "attribution-invalid";
  }
  const trustworthy =
    (input.citation?.complete ?? false) &&
    (input.noDoubleCount?.undoubled ?? false) &&
    (input.residualHonesty?.honest ?? false) &&
    (input.reconciliation?.reconciled ?? false) &&
    (input.counterfactual?.faithful ?? false) &&
    (input.generationSeries?.integral ?? false) &&
    (input.honesty?.honest ?? false) &&
    input.inputUnchanged;
  return trustworthy ? "attribution-established" : "attribution-invalid";
}

// ---------------------------------------------------------------------------
// The driver (the mechanical attribution over the read-only economics)
// ---------------------------------------------------------------------------

/** ONE attribution run's full result (the driver's outcome). */
export interface AttributionRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly verdict: AttributionVerdictKind;
  readonly refusal: { readonly reason: AttributionRefusalReason } | null;
  readonly refusalHonesty: AttributionRefusalHonestyVerdict | null;
  readonly citation: AttributionEvidenceCitationVerdict | null;
  readonly noDoubleCount: NoDoubleCountVerdict | null;
  readonly residualHonesty: ResidualHonestyVerdict | null;
  readonly reconciliation: AttributionReconciliationVerdict | null;
  readonly counterfactual: CounterfactualFidelityVerdict | null;
  readonly generationSeries: GenerationSeriesIntegrityVerdict | null;
  readonly honesty: AttributionHonestyVerdict | null;
  readonly reportLanded: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly reportsAppended: number;
  readonly inputUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly usage: LabUsage | null;
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * The trajectory steps of one attribution run (PURE — the canonical
 * journal shape the platform records and the app re-derives over the
 * public events read).
 */
export function attributionTrajectoryStepsOf(input: {
  readonly rowId: string;
  readonly verdict: AttributionVerdictKind;
  readonly claimCount: number;
  readonly reportAppended: boolean;
}): readonly { readonly kind: string; readonly detail: string }[] {
  const steps: { kind: string; detail: string }[] = [
    { kind: "attribution:analysis-started", detail: input.rowId },
    { kind: "attribution:economics-read", detail: `claims:${input.claimCount}` },
  ];
  if (input.verdict === "no-evidence-honest") {
    steps.push({ kind: "attribution:no-evidence-refused", detail: "honest" });
  } else if (input.reportAppended) {
    steps.push({ kind: "attribution:report-appended", detail: "append-only" });
  } else {
    steps.push({ kind: "attribution:report-withheld", detail: "untrustworthy-shape" });
  }
  steps.push({ kind: "attribution:analysis-settled", detail: input.verdict });
  return steps;
}

/**
 * Drive ONE attribution analysis over the recorded economics + history
 * (the mechanical engine): read the family's recorded lifecycle
 * records, promotion generations, accounting ledger entries, incumbent
 * baselines and recorded savings totals (the READ-ONLY input — the
 * input digest is snapshotted before and after the run); refuse
 * honestly when the family's own recorded history does not support an
 * attribution; otherwise derive the citation completeness, the
 * no-double-count discipline, the residual honesty, the reconciliation
 * identity, the counterfactual fidelity, the generation-series
 * integrity and the honesty over the row's declared split — and, only
 * when EVERY leg is trustworthy, APPEND the family's attribution
 * report to the append-only report ledger. The live row's measured
 * round rides the dispatch seam.
 */
export async function driveAttributionAnalysis(options: {
  readonly row: AttributionCorpusRow;
  /** The READ-ONLY recorded economics + lifecycle history (VAL-044's baselines + VAL-030..036's records). */
  readonly analysis: AttributionAnalysisPort;
  /** The APPEND-ONLY attribution report ledger. */
  readonly reportLedger: AttributionReportPort;
  /** The dispatch seam (the live row's REAL measured round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<AttributionRunResult> {
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
  const beforeInputDigest = attributionInputDigestOf(options.analysis.facts());

  // ---- the read-only economics + history read ----
  const lifecycleRecords = options.analysis.lifecycleFor(row.familyId);
  const generations = options.analysis.generationsFor(row.familyId);
  const ledgerEntries = options.analysis.accountingFor(row.familyId);
  const baselines = options.analysis.baselinesFor(row.familyId);
  const recordedTotals = options.analysis.recordedTotalsFor(row.familyId);
  const maturityReports = options.analysis.maturityReportsFor(row.familyId);

  let refusal: { reason: AttributionRefusalReason } | null = null;
  if (lifecycleRecords.length === 0) {
    refusal = { reason: "family-unrecorded" };
  } else if (generations.length > 0 && ledgerEntries.length === 0 && recordedTotals.length === 0) {
    refusal = { reason: "no-savings-recorded" };
  }

  let citation: AttributionEvidenceCitationVerdict | null = null;
  let noDoubleCount: NoDoubleCountVerdict | null = null;
  let residualHonesty: ResidualHonestyVerdict | null = null;
  let reconciliation: AttributionReconciliationVerdict | null = null;
  let counterfactual: CounterfactualFidelityVerdict | null = null;
  let generationSeries: GenerationSeriesIntegrityVerdict | null = null;
  let honesty: AttributionHonestyVerdict | null = null;
  let refusalHonesty: AttributionRefusalHonestyVerdict | null = null;
  let reportLanded: { accepted: boolean; replayed: boolean } | null = null;
  let reportsAppended = 0;
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;
  let observedModelCalls = 0;

  if (refusal !== null) {
    // ---- the honest-no-evidence path (the family's own recorded
    //      history does not support an attribution: nothing executes,
    //      nothing lands) ----
    refusalHonesty = deriveAttributionRefusalHonesty({
      refusal,
      lifecycleRecordCount: lifecycleRecords.length,
      generationCount: generations.length,
      ledgerEntryCount: ledgerEntries.length,
      recordedTotalCount: recordedTotals.length,
    });
  } else {
    // ---- the attribution legs (every claim re-derived mechanically) ----
    citation = deriveAttributionEvidenceCitation({
      lifecycleRecords,
      generations,
      ledgerEntries,
      baselines,
      recordedTotals,
      split: row.split,
    });
    noDoubleCount = deriveNoDoubleCount({ split: row.split });
    residualHonesty = deriveResidualHonesty({
      ledgerEntries,
      recordedTotals,
      split: row.split,
    });
    reconciliation = deriveAttributionReconciliation({
      recordedTotals,
      split: row.split,
    });
    counterfactual = deriveCounterfactualFidelity({
      baselines,
      split: row.split,
    });
    generationSeries = deriveGenerationSeriesIntegrity({
      recordedGenerations: generations,
      split: row.split,
    });
    honesty = deriveAttributionHonesty({
      baselines,
      reportedUsage: null,
      liveRail: row.needsDispatch === true,
    });

    // ---- the attribution report append (ONLY a trustworthy
    //      attribution ever lands its report) ----
    const trustworthy =
      citation.complete &&
      noDoubleCount.undoubled &&
      residualHonesty.honest &&
      reconciliation.reconciled &&
      counterfactual.faithful &&
      generationSeries.integral &&
      honesty.honest;
    if (trustworthy) {
      const canonicalCitation = canonicalAttributionCitationOf({
        ledgerEntries,
        lifecycleRecords,
        baselines,
        recordedTotals,
      });
      const maturityReport = maturityReports[0] ?? null;
      const report = {
        familyId: row.familyId,
        attributed: reconciliation.attributedByMechanism,
        residualMicroUsd: reconciliation.residualTotalMicroUsd,
        claimedTotalMicroUsd:
          reconciliation.attributedTotalMicroUsd + reconciliation.residualTotalMicroUsd,
        claimDigests: row.split.claims.map((claim) => attributionClaimDigestOf(claim)),
        residualDigests: row.split.residual.map((claim) => residualClaimDigestOf(claim)),
        citationDigest: attributionCitationDigestOf(canonicalCitation),
        maturityReportDigest:
          maturityReport === null ? null : maturityReportDigestOf(maturityReport),
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
  const afterInputDigest = attributionInputDigestOf(options.analysis.facts());
  const inputUnchanged = beforeInputDigest === afterInputDigest;

  const verdict = deriveAttributionVerdictKind({
    refusal,
    refusalHonesty,
    citation,
    noDoubleCount,
    residualHonesty,
    reconciliation,
    counterfactual,
    generationSeries,
    honesty,
    inputUnchanged,
    failure,
  });

  const criteria = deriveAttributionRowCriteria({
    row,
    refusal,
    refusalHonesty,
    citation,
    noDoubleCount,
    residualHonesty,
    reconciliation,
    counterfactual,
    generationSeries,
    honesty,
    reportLanded,
    reportsAppended,
    inputUnchanged,
    observedModelCalls,
    verdict,
    failure,
  });

  const anyFail = failure !== null || criteria.some((criterion) => criterion.status === "FAIL");

  // The terminal contract: an honest no-evidence refusal and an
  // established attribution are COMPLETED runs (the honest verdict IS
  // the outcome); an invalid shape FAILs. The pinned oracle's terminal
  // wins when every leg passed.
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
    noDoubleCount,
    residualHonesty,
    reconciliation,
    counterfactual,
    generationSeries,
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
 * The attribution observation as the app reads it back through the
 * PUBLIC result read (never trusting the platform's own claim): the
 * read-back per-mechanism attributed totals, the read-back residual,
 * the read-back per-generation splits, the read-back report record and
 * the run's own measured facts.
 */
export interface AppAttributionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  readonly terminal: string | null;
  readonly verificationStatuses: readonly string[];
  /** The per-mechanism attributed totals read back through the public result read. */
  readonly attributed: Readonly<Record<CandidateKind, number>> | null;
  /** The honest residual total read back. */
  readonly residualMicroUsd: number | null;
  /** The claimed total (attributed + residual) read back. */
  readonly claimedTotalMicroUsd: number | null;
  /** The per-generation splits read back (the attributed + residual + recorded total per generation). */
  readonly perGeneration: readonly {
    readonly generation: number;
    readonly perMechanism: Readonly<Record<CandidateKind, number>>;
    readonly residualMicroUsd: number;
    readonly recordedTotalMicroUsd: number;
  }[];
  /** The refusal reason read back (null when the run did not refuse). */
  readonly refusalReason: string | null;
  /** Whether the attribution report landed in the report ledger. */
  readonly reportRecorded: boolean;
  /** The route's own model-call count (the run's own dispatches). */
  readonly observedModelCalls: number | null;
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
}

/**
 * The app-boundary savings-attribution contract (PURE — the oracle at
 * the SDK seam): re-derive every leg AT the boundary over the read-back
 * observation — the attributed split read-back (the per-mechanism
 * numbers the platform surfaced must match the row's declared split),
 * the boundary re-derivation of the reconciliation identity over the
 * read-back numbers (a non-reconciling split never passes), the
 * residual read-back honesty (the residual surfaced exactly as
 * declared — never hidden, never folded), the report landing, the
 * run's own dispatches and the refusal read-back. Never trust the
 * platform's claim.
 */
export function verifySavingsAttributionAppContract(input: {
  readonly row: AttributionCorpusRow;
  readonly observation: AppAttributionObservation;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row, observation } = input;

  // 1. The read-back attributed split matches the row's declared split
  //    (the per-mechanism numbers surfaced honestly).
  const declaredByMechanism = {} as Record<CandidateKind, number>;
  for (const kind of ATTRIBUTION_MECHANISMS) {
    declaredByMechanism[kind] = 0;
  }
  for (const claim of row.split.claims) {
    declaredByMechanism[claim.mechanism] += claim.claimedMicroUsd;
  }
  const splitMatches =
    observation.attributed !== null &&
    ATTRIBUTION_MECHANISMS.every(
      (kind) => (observation.attributed?.[kind] ?? -1) === declaredByMechanism[kind],
    );
  criteria.push({
    criterionId: "app-attributed-split-read-back",
    strategy: "deterministic",
    status: splitMatches ? "PASS" : "FAIL",
    evidence: [
      `declared:${ATTRIBUTION_MECHANISMS.map((kind) => `${kind}=${declaredByMechanism[kind]}`).join(",")}`,
      `readBack:${observation.attributed === null ? "none" : ATTRIBUTION_MECHANISMS.map((kind) => `${kind}=${observation.attributed?.[kind] ?? "none"}`).join(",")}`,
      splitMatches
        ? "the-read-back-attributed-split-matches-the-declared-split"
        : "SPLIT-READ-BACK-MISMATCH (the platform surfaced a different per-mechanism split than the analysis declared)",
    ],
  });

  // 2. The boundary re-derivation of the reconciliation identity over
  //    the read-back numbers (only for a row whose attribution
  //    executes; the read-back per-generation splits are the claimed
  //    side and the read-back recorded totals the recorded side).
  if (row.expected.verdict === "attribution-established") {
    const boundaryReconciliation = deriveAttributionReconciliation({
      recordedTotals: observation.perGeneration.map((split) => ({
        familyId: row.familyId,
        generation: split.generation,
        totalMicroUsd: split.recordedTotalMicroUsd,
      })),
      split: {
        claims: observation.perGeneration.flatMap((split) =>
          ATTRIBUTION_MECHANISMS.filter((kind) => split.perMechanism[kind] !== 0).map((kind) => ({
            mechanism: kind,
            generation: split.generation,
            claimedMicroUsd: split.perMechanism[kind],
            citedLedgerEntryIds: [],
            citedLifecycleProposalIds: [],
            baselineDigest: "",
            baselineBasis: "recorded" as const,
          })),
        ),
        residual: observation.perGeneration.map((split) => ({
          generation: split.generation,
          residualMicroUsd: split.residualMicroUsd,
          reported: true,
        })),
      },
    });
    criteria.push(
      ...boundaryReconciliation.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  }

  // 3. The residual read-back honesty: an established attribution
  //    surfaces its residual EXACTLY as declared (never hidden, never
  //    folded into a mechanism).
  if (row.expected.verdict === "attribution-established") {
    const declaredResidual = row.split.residual
      .filter((claim) => claim.reported)
      .reduce((total, claim) => total + claim.residualMicroUsd, 0);
    const residualMatches = observation.residualMicroUsd === declaredResidual;
    criteria.push({
      criterionId: "app-residual-read-back",
      strategy: "deterministic",
      status: residualMatches ? "PASS" : "FAIL",
      evidence: [
        `declaredResidual:${declaredResidual}`,
        `readBackResidual:${observation.residualMicroUsd ?? "none"}`,
        residualMatches
          ? "the-read-back-residual-matches-the-declared-residual (reported honestly, never folded)"
          : "RESIDUAL-READ-BACK-MISMATCH (the platform surfaced a different residual than declared — hidden or inflated)",
      ],
    });
  }

  // 3b. The boundary generation-series integrity: an established
  //     attribution's surfaced per-generation series must MATCH the
  //     declared generation series — a GAPPED surface (a declared
  //     generation the platform did not surface) or a MISMATCHED one
  //     (a surfaced generation the attribution never declared) never
  //     passes.
  if (row.expected.verdict === "attribution-established") {
    const declaredGenerations = [
      ...new Set(row.split.claims.map((claim) => claim.generation)),
    ].sort((left, right) => left - right);
    const surfacedGenerations = observation.perGeneration
      .map((split) => split.generation)
      .sort((left, right) => left - right);
    const gappedGenerations = declaredGenerations.filter(
      (generation) => !surfacedGenerations.includes(generation),
    );
    const extraGenerations = surfacedGenerations.filter(
      (generation) => !declaredGenerations.includes(generation),
    );
    const seriesMatches = gappedGenerations.length === 0 && extraGenerations.length === 0;
    criteria.push({
      criterionId: "app-generation-series-read-back",
      strategy: "deterministic",
      status: seriesMatches ? "PASS" : "FAIL",
      evidence: [
        `declaredGenerations:${declaredGenerations.join(",") || "none"}`,
        `surfacedGenerations:${surfacedGenerations.join(",") || "none"}`,
        `gappedGenerations:${gappedGenerations.join(",") || "none"}`,
        `extraGenerations:${extraGenerations.join(",") || "none"}`,
        seriesMatches
          ? "the-surfaced-generation-series-matches-the-declared-series"
          : "GAPPED-SERIES-READ-BACK (the platform surfaced a generation series that does not match the declared attribution — a generation's savings silently dropped or fabricated)",
      ],
    });
  }

  // 4. The report landing: an established attribution surfaces its
  //    recorded report; an honest no-evidence refusal surfaces none.
  const reportLandingMatches =
    row.expected.verdict === "attribution-established"
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

  // 5. The run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-attribution-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // 6. The refusal read-back (the honest no-evidence refusal's reason).
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
