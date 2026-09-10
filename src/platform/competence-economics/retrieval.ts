/**
 * Progressive competence retrieval (platform competence-economics
 * plane; WORK-056 / E1.1 — ADR-0019, ADR-0020).
 *
 * THE PURE RETRIEVAL DECISION: given the competence corpus, one
 * typed applicability query and the bounded configuration, return
 * the BOUNDED, RANKED set of applicable competence candidates —
 * pure function of (corpus, query, configuration), deterministic
 * INCLUDING tie-breaks (architecture invariant 5), idempotent on
 * re-run (byte-identical output), fail-closed on unmet
 * preconditions.
 *
 * THE APPLICABILITY MATCH (bounded, typed — where competence
 * applies):
 *  - the record's tenant scope must EQUAL the query's (tenant
 *    safety: cross-tenant/cross-application competence never
 *    surfaces — the WORK-052 structural discipline, enforced);
 *  - the record's capability bound must cover the query's
 *    capability (exact);
 *  - the record's applicability tags must cover EVERY query tag
 *    (out-of-bounds work never matches);
 *  - the query's environment fingerprint must MATCH the record's
 *    (WORK-055's OWN `compareFingerprints` — imported read-only;
 *    drift means not-applicable, never a silent match).
 *
 * THE RANKING (deterministic TOTAL order):
 *  - applicable records first;
 *  - among applicable: expected successful-resolution cost
 *    ascending (the foundation's OWN `evaluateCandidate` machinery
 *    — ceil(cost / reliability), consumed never re-implemented);
 *  - ties: repetition evidence descending (observationCount — the
 *    stronger evidence wins);
 *  - ties: recordId ascending (every tie resolves on content).
 *
 * THE QUALITY-PRESERVING RULE (ADR-0020, the foundation's own): a
 * record whose expected quality is below the configuration's
 * quality floor is INVALID for retrieval (ranked out with its typed
 * evaluation — the "why the cheaper did not surface" evidence).
 *
 * ZERO-COMPETENCE OPERATION (architecture invariant 7): an empty
 * corpus is ALWAYS representable — the retrieval returns the empty
 * ranked set (no error, no phantom candidates): the probabilistic
 * path works with an empty corpus.
 *
 * The output entries carry the foundation's OWN
 * `CandidateRepresentation` shape (representationClass
 * `verified-competence`, the record's explicit-basis claim) —
 * selectable as decision evidence through the EXISTING seams,
 * never self-asserting, never an authorization.
 */

import type { TenantCacheScope } from "../context-economics/keys";
import { validateTenantCacheScope } from "../context-economics/keys";
import type { CandidateEvaluation, CandidateRepresentation } from "../execution-ir/cost-model";
import { evaluateCandidate } from "../execution-ir/cost-model";
import type { IrDigestPort } from "../execution-ir/ir";
import type { EnvironmentFingerprint } from "../failure-recovery/fingerprint";
import {
  compareFingerprints,
  validateEnvironmentFingerprint,
} from "../failure-recovery/fingerprint";
import {
  boundedDetail,
  CAPABILITY_REF_PATTERN,
  COMPETENCE_REPRESENTATION_CLASS,
  MAX_APPLICABILITY_TAGS,
  MAX_CORPUS_SIZE,
  MAX_RETRIEVAL_RESULTS,
  type RetrievalInadmissibleCode,
  reject,
  TAG_PATTERN,
} from "./catalog";
import type { CompetenceRecord } from "./record";
import { validateCompetenceRecord } from "./record";

// ---------------------------------------------------------------------------
// The retrieval input (typed, bounded, total)
// ---------------------------------------------------------------------------

/**
 * The bounded retrieval configuration — EXPLICIT policy inputs
 * (never ambient, never self-raising): the result bound and the
 * assurance floor the retrieved candidates must meet (the
 * foundation's own quality-preserving rule).
 */
export interface RetrievalConfiguration {
  /** The maximum results the retrieval may return ([1, 16]). */
  readonly maxResults: number;
  /** The inviolable quality floor for retrieved candidates ([0, 1]). */
  readonly qualityFloor: number;
}

/** Total, deterministic validation of the retrieval configuration. */
export function validateRetrievalConfiguration(
  value: RetrievalConfiguration,
): RetrievalConfiguration {
  if (typeof value !== "object" || value === null) {
    reject("retrieval-input-shape", "retrieval configuration must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.maxResults !== "number" ||
    !Number.isInteger(record.maxResults) ||
    record.maxResults < 1 ||
    record.maxResults > MAX_RETRIEVAL_RESULTS
  ) {
    reject("retrieval-input-shape", "maxResults must be an integer in [1, 16]", {
      got: boundedDetail(String(record.maxResults)),
    });
  }
  if (
    typeof record.qualityFloor !== "number" ||
    !Number.isFinite(record.qualityFloor) ||
    record.qualityFloor < 0 ||
    record.qualityFloor > 1
  ) {
    reject("retrieval-input-shape", "qualityFloor must be a probability in [0, 1]", {
      got: boundedDetail(String(record.qualityFloor)),
    });
  }
  return value;
}

/**
 * The competence query: the typed applicability position of the
 * work being planned — the tenant scope, the capability, the
 * declared tags and the environment the work will run in.
 */
export interface CompetenceQuery {
  readonly scope: TenantCacheScope;
  readonly capabilityId: string;
  readonly tags: readonly string[];
  readonly environment: EnvironmentFingerprint;
}

/** Total, deterministic validation of the competence query. */
export function validateCompetenceQuery(
  value: CompetenceQuery,
  digest: IrDigestPort,
): CompetenceQuery {
  validateTenantCacheScope(value.scope);
  if (typeof value.capabilityId !== "string" || !CAPABILITY_REF_PATTERN.test(value.capabilityId)) {
    reject("retrieval-input-shape", "the query capability must be a bounded neutral slug", {
      got: boundedDetail(String(value.capabilityId)),
    });
  }
  if (!Array.isArray(value.tags) || value.tags.length === 0) {
    reject("retrieval-input-shape", "the query must declare at least one tag");
  }
  if (value.tags.length > MAX_APPLICABILITY_TAGS) {
    reject("retrieval-input-shape", "query tags exceed the bound", {
      bound: MAX_APPLICABILITY_TAGS,
      got: value.tags.length,
    });
  }
  const seen = new Set<string>();
  for (const tag of value.tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      reject("retrieval-input-shape", "query tags must be bounded neutral slugs", {
        got: boundedDetail(String(tag)),
      });
    }
    if (seen.has(tag)) {
      reject("retrieval-input-shape", "query tags must be unique", { tag });
    }
    seen.add(tag);
  }
  // The failure-recovery plane's OWN fingerprint validation —
  // imported read-only (never re-implemented).
  validateEnvironmentFingerprint(value.environment, digest);
  return value;
}

// ---------------------------------------------------------------------------
// The retrieval verdicts and results
// ---------------------------------------------------------------------------

/** One record's applicability verdict (recorded evidence, never silent). */
export interface RetrievalVerdict {
  readonly recordId: string;
  readonly applicable: boolean;
  /** EXACTLY ONE closed reason code when not applicable. */
  readonly inadmissibleCode?: RetrievalInadmissibleCode;
  /** The bounded human-auditable inadmissibility detail. */
  readonly inadmissibleDetail?: string;
  /** The foundation's own evaluation (present for every applicable record). */
  readonly evaluation?: CandidateEvaluation;
}

/** One ranked, applicable competence candidate. */
export interface RetrievalEntry {
  /** The 1-based rank (the deterministic total order). */
  readonly rank: number;
  /** The validated competence record. */
  readonly record: CompetenceRecord;
  /**
   * The record AS the foundation's own candidate representation
   * (class `verified-competence`, the record's explicit-basis claim)
   * — selectable through the EXISTING seams.
   */
  readonly candidate: CandidateRepresentation;
  readonly evaluation: CandidateEvaluation;
}

/** The retrieval result — the bounded ranked set + every verdict. */
export interface CompetenceRetrievalResult {
  /** The ranked, applicable, above-floor entries (bounded by maxResults). */
  readonly results: readonly RetrievalEntry[];
  /** Every corpus record's applicability verdict (the audit evidence). */
  readonly verdicts: readonly RetrievalVerdict[];
  /** The corpus size the retrieval ran over. */
  readonly corpusSize: number;
  /** The frozen, human-auditable retrieval basis. */
  readonly retrievalBasis: string;
}

/** The frozen retrieval-basis statement. */
export const RETRIEVAL_BASIS =
  "tenant-scope-structural;capability-exact;tags-cover-query;environment-fingerprint-exact-match;quality-floor-as-validity;cost-ascending-then-observation-count-desc-then-recordId;bounded-results;zero-corpus-representable";

// ---------------------------------------------------------------------------
// The retrieval (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Retrieve the ranked, applicable competence candidates. THE pure
 * decision: applicability match (scope, capability, tags,
 * environment) → the foundation's own evaluation (quality floor as
 * validity) → the deterministic total order → the bounded result
 * set. Zero-competence operation: an empty corpus yields the empty
 * ranked set (never an error).
 */
export function retrieveCompetence(
  corpus: readonly CompetenceRecord[],
  query: CompetenceQuery,
  configuration: RetrievalConfiguration,
  digest: IrDigestPort,
): CompetenceRetrievalResult {
  const validatedQuery = validateCompetenceQuery(query, digest);
  const validatedConfiguration = validateRetrievalConfiguration(configuration);
  if (!Array.isArray(corpus)) {
    reject("retrieval-input-shape", "the competence corpus must be an array");
  }
  if (corpus.length > MAX_CORPUS_SIZE) {
    reject("retrieval-input-shape", "the competence corpus exceeds the bound", {
      bound: MAX_CORPUS_SIZE,
      got: corpus.length,
    });
  }
  // Tenant-scope structural guard (the query's scope is validated;
  // the corpus key derivation is deterministic over it — the
  // artifact-result class from the merged context-economics plane).
  validateTenantCacheScope(validatedQuery.scope);

  const verdicts: RetrievalVerdict[] = [];
  const applicable: { record: CompetenceRecord; evaluation: CandidateEvaluation }[] = [];
  const seenRecordIds = new Set<string>();

  for (const candidate of corpus) {
    // Read-time validation: a tampered record never surfaces — its
    // typed verdict records the failure (record-shape).
    let record: CompetenceRecord;
    try {
      record = validateCompetenceRecord(candidate, digest);
    } catch {
      verdicts.push({
        recordId: typeof candidate?.recordId === "string" ? candidate.recordId : "unknown",
        applicable: false,
        inadmissibleCode: "record-shape",
        inadmissibleDetail: "the record failed read-time validation (tampered or foreign)",
      });
      continue;
    }
    if (seenRecordIds.has(record.recordId)) {
      reject("retrieval-input-shape", "corpus record ids must be unique", {
        recordId: record.recordId,
      });
    }
    seenRecordIds.add(record.recordId);

    // --- The applicability match (bounded, typed) -----------------------
    if (
      record.scope.tenantId !== validatedQuery.scope.tenantId ||
      record.scope.applicationId !== validatedQuery.scope.applicationId
    ) {
      verdicts.push({
        recordId: record.recordId,
        applicable: false,
        inadmissibleCode: "capability-mismatch",
        inadmissibleDetail: "the record belongs to a different tenant/application scope",
      });
      continue;
    }
    if (record.capabilityId !== validatedQuery.capabilityId) {
      verdicts.push({
        recordId: record.recordId,
        applicable: false,
        inadmissibleCode: "capability-mismatch",
        inadmissibleDetail: `the record's capability bound ${record.capabilityId} does not cover ${validatedQuery.capabilityId}`,
      });
      continue;
    }
    const covers = validatedQuery.tags.every((tag) => record.tags.includes(tag));
    if (!covers) {
      verdicts.push({
        recordId: record.recordId,
        applicable: false,
        inadmissibleCode: "tag-bounds-mismatch",
        inadmissibleDetail: "the record's applicability tags do not cover the query's tags",
      });
      continue;
    }
    const comparison = compareFingerprints(record.environment, validatedQuery.environment);
    if (comparison.status !== "match") {
      verdicts.push({
        recordId: record.recordId,
        applicable: false,
        inadmissibleCode: "environment-drift",
        inadmissibleDetail: `the query's environment drifted from the record's (${comparison.drifted.length} drifted entries)`,
      });
      continue;
    }

    // --- The foundation's own evaluation (quality floor as validity) ---
    const representation = competenceCandidateOf(record);
    const evaluation = evaluateCandidate(representation, validatedConfiguration.qualityFloor);
    if (!evaluation.valid) {
      verdicts.push({
        recordId: record.recordId,
        applicable: false,
        inadmissibleCode: "quality-below-floor",
        inadmissibleDetail: `the record's expected quality ${evaluation.qualityExpectation.expectedQuality} is below the floor ${validatedConfiguration.qualityFloor}`,
        evaluation,
      });
      continue;
    }
    verdicts.push({
      recordId: record.recordId,
      applicable: true,
      evaluation,
    });
    applicable.push({ record, evaluation });
  }

  // --- THE DETERMINISTIC ORDER (total: cost → observations → id) -------
  applicable.sort(compareRetrievalEntries);
  const results: RetrievalEntry[] = [];
  const included = new Set<string>();
  for (const entry of applicable) {
    if (results.length >= validatedConfiguration.maxResults) {
      break;
    }
    if (included.has(entry.record.recordId)) {
      continue;
    }
    included.add(entry.record.recordId);
    results.push({
      rank: results.length + 1,
      record: entry.record,
      candidate: competenceCandidateOf(entry.record),
      evaluation: entry.evaluation,
    });
  }

  return {
    results,
    verdicts,
    corpusSize: corpus.length,
    retrievalBasis: RETRIEVAL_BASIS,
  };
}

/**
 * The record AS the foundation's own candidate representation —
 * the EXISTING-seam shape (class `verified-competence`, the
 * record's own explicit-basis claim, the record identity as the
 * candidate identity).
 */
export function competenceCandidateOf(record: CompetenceRecord): CandidateRepresentation {
  return {
    candidateId: record.recordId,
    representationClass: COMPETENCE_REPRESENTATION_CLASS,
    description: `competence;capability=${record.capabilityId};observations=${record.expectedOutcome.observationCount};stage=${record.stage}`,
    claim: record.claim,
  };
}

/**
 * Compare two applicable retrieval entries by the deterministic
 * total order: expected successful-resolution cost ascending, ties
 * by repetition evidence descending (observationCount), ties by
 * recordId ascending. Identical inputs can never produce a
 * different order — every tie resolves on content.
 */
export function compareRetrievalEntries(
  a: { record: CompetenceRecord; evaluation: CandidateEvaluation },
  b: { record: CompetenceRecord; evaluation: CandidateEvaluation },
): number {
  const costA = BigInt(a.evaluation.expectedSuccessfulResolutionCostMicroUsd);
  const costB = BigInt(b.evaluation.expectedSuccessfulResolutionCostMicroUsd);
  if (costA !== costB) {
    return costA < costB ? -1 : 1;
  }
  const observationsA = a.record.expectedOutcome.observationCount;
  const observationsB = b.record.expectedOutcome.observationCount;
  if (observationsA !== observationsB) {
    return observationsB - observationsA;
  }
  if (a.record.recordId !== b.record.recordId) {
    return a.record.recordId < b.record.recordId ? -1 : 1;
  }
  return 0;
}
