/**
 * The Compatibility Evidence Record (ACR-006 §3).
 *
 * A record binds, for ONE pinned application revision:
 *  - application identity and pinned upstream revision;
 *  - integration revision;
 *  - the declared execution graph;
 *  - every material AI edge and its disposition;
 *  - Zeck execution identifiers (through the recorded trace facts);
 *  - direct-provider egress observations;
 *  - provider credential presence/absence (env-var NAMES only, never values);
 *  - runtime evidence (the declared corpus and its usability);
 *  - quality/reliability/economic comparison facts (when measured);
 *  - limitations and NOT-RUN causes.
 *
 * IT IS EVIDENCE, SUBORDINATE TO THE EXISTING EVIDENCE AUTHORITY: the
 * record carries observations and facts; it never executes, never
 * verifies customer-domain outcomes and never upgrades anything. The
 * application-level status is NOT a field of this record — it is always
 * DERIVED by the admission function (status.ts) over these facts, so no
 * recorded document can assert AI_EXECUTION_COMPLETE by writing it down.
 *
 * SECRET SAFETY: there is no field where a credential VALUE could even
 * appear — credential facts carry env-var NAMES and a presence boolean
 * (the platform's M5/M7 discipline, applied to the compatibility layer).
 */

import type { ApplicationExecutionGraph } from "./execution-graph";
import { validateExecutionGraph } from "./execution-graph";
import type { PinnedApplication } from "./revisions";
import { validatePinnedApplication } from "./revisions";

/**
 * The basis of a delegated edge's Zeck evidence. Rule 5 of the strict
 * admission contract: only `live` evidence counts as an external PASS —
 * `fixture`, `mock` and `simulated-provider` are honest proof scaffolding
 * that can NEVER satisfy the delegation requirement.
 */
export const EVIDENCE_BASES = ["live", "fixture", "mock", "simulated-provider"] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

/** A delegated edge's Zeck execution identifiers (rule 1 + rule 4 inputs). */
export interface DelegatedEdgeEvidence {
  /** Every Zeck execution id the delegated edge ran through. */
  readonly zeckExecutionIds: readonly string[];
  /**
   * The basis of the Zeck evidence for this edge. Only `live` counts
   * toward admission rule 5 (fixtures/mocks/simulations are disclosed
   * scaffolding, never external PASS).
   */
  readonly evidenceBasis: EvidenceBasis;
}

/** An edge observed to execute on a direct external AI provider (a bypass). */
export interface DirectProviderEdgeEvidence {
  /** The observation that established the direct-provider execution. */
  readonly observationBasis: string;
}

/** An edge not yet executed/assessed in the proof, with its cause + owner. */
export interface NotRunEdgeEvidence {
  readonly cause: string;
  /** Who owns unblocking this edge (Lead / architect / provider / operator). */
  readonly owner: string;
}

/** An edge explicitly reclassified as non-AI (the target-matrix rule). */
export interface NonAiEdgeEvidence {
  /** The justification (verbatim; auditable, never silent). */
  readonly justification: string;
}

/** The disposition of one declared material edge: delegated through Zeck. */
export interface DelegatedEdgeDisposition extends DelegatedEdgeEvidence {
  readonly edgeId: string;
  readonly disposition: "delegated";
}

/** The disposition of one declared material edge: direct-provider bypass. */
export interface DirectProviderEdgeDisposition extends DirectProviderEdgeEvidence {
  readonly edgeId: string;
  readonly disposition: "direct-provider";
}

/** The disposition of one declared material edge: not run in the proof. */
export interface NotRunEdgeDisposition extends NotRunEdgeEvidence {
  readonly edgeId: string;
  readonly disposition: "not-run";
}

/** The disposition of one declared material edge: explicitly reclassified non-AI. */
export interface NonAiEdgeDisposition extends NonAiEdgeEvidence {
  readonly edgeId: string;
  readonly disposition: "non-ai";
}

/**
 * The disposition entry of one declared edge — a FLAT discriminated
 * union so `disposition` narrows cleanly (no intersections).
 */
export type EdgeDispositionEntry =
  | DelegatedEdgeDisposition
  | DirectProviderEdgeDisposition
  | NotRunEdgeDisposition
  | NonAiEdgeDisposition;

/** The edge-disposition vocabulary (machine-readable). */
export const EDGE_DISPOSITIONS = ["delegated", "direct-provider", "not-run", "non-ai"] as const;
export type EdgeDispositionKind = (typeof EDGE_DISPOSITIONS)[number];

/** The disposition shape union (the evidence payloads per kind). */
export type EdgeDisposition =
  | DelegatedEdgeEvidence
  | DirectProviderEdgeEvidence
  | NotRunEdgeEvidence
  | NonAiEdgeEvidence;

/** One recorded direct-provider egress violation. */
export interface EgressViolation {
  /** The host the request targeted (opaque; never a credential). */
  readonly host: string;
  /** The request URL as observed (path + query only, when the harness records it). */
  readonly url: string;
  /** The deny rule that matched (its note — opaque provenance). */
  readonly rule: string;
  /** When the violation was observed (ISO timestamp). */
  readonly at: string;
  /** True when the harness BLOCKED the request (deny mode); false when it was observed passing (observe mode). */
  readonly blocked: boolean;
}

/** The runtime direct-provider egress observation for the proof run. */
export interface EgressObservation {
  /** The harness mode active during the proof (observe records; deny blocks). */
  readonly mode: "observe" | "deny";
  readonly status: "not-run" | "observed-clean" | "violations-detected" | "provably-blocked";
  /** Every recorded violation (blocked and observed-passing). */
  readonly violations: readonly EgressViolation[];
}

/** Provider credential presence/absence (env-var NAMES only — never values). */
export interface ProviderCredentialFact {
  /** The credential's environment-variable NAME (a name, never a value). */
  readonly envVarName: string;
  /** Was the credential present in the proof runtime? */
  readonly present: boolean;
}

/** The runtime evidence axis: the declared corpus and its usability (rule 3). */
export interface RuntimeEvidence {
  /** Was a representative corpus declared for this proof? */
  readonly corpusDeclared: boolean;
  /**
   * The corpus usability outcome: `verified` only when the application
   * remained functionally usable for the declared corpus during the
   * proof — the honest states below can never satisfy rule 3.
   */
  readonly corpusUsability: "verified" | "not-verified" | "not-run";
  /** The verbatim observations backing the usability outcome. */
  readonly observations: readonly string[];
}

/** One measured comparison fact (economic/quality/reliability; optional). */
export interface ComparisonFact {
  /** What was compared (e.g. "direct-baseline", "optimized-baseline"). */
  readonly baseline: string;
  /** The measured basis (honest vocabulary — never a fabricated number). */
  readonly basis: "measured" | "estimated" | "not-measured";
  /** The comparison statement (verbatim; units and caveats included). */
  readonly statement: string;
}

/** One recorded Zeck trace fact (the correlation of one delegated execution). */
export interface ZeckTraceFact {
  readonly edgeId: string;
  readonly executionId: string;
  readonly applicationId: string;
  /** Was the execution found through the executions public surface? */
  readonly found: boolean;
  /** The execution's lifecycle status when found (wire vocabulary), else null. */
  readonly status: string | null;
  /** Terminal status when found (COMPLETED/FAILED/CANCELLED/EXPIRED). */
  readonly terminal: boolean;
  /** Events on the execution's canonical ledger. */
  readonly eventCount: number;
  /** Durable verification results recorded on the execution. */
  readonly verificationCount: number;
  /** Verification results with status PASS. */
  readonly passingVerificationCount: number;
  /**
   * True when found AND carrying durable evidence (ledger events + at
   * least one verification result) — the rule-4 requirement per edge.
   */
  readonly correlated: boolean;
  /**
   * Route facts (provider/model/strategy class, opaque neutral strings)
   * when the correlation projected them from the execution's canonical
   * ledger; null when not present — never fabricated.
   */
  readonly route?: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly strategyClass: string | null;
  } | null;
  /** Settled cost (integer micro-USD string) when present; null otherwise. */
  readonly costMicroUsd?: string | null;
  /** Provider-reported usage when present; null otherwise. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/** One recorded limitation (rendered verbatim; never hidden). */
export interface LimitationEntry {
  readonly area: string;
  readonly statement: string;
  /** The owner of resolving the limitation (Lead / architect / provider). */
  readonly owner: string;
}

/** One NOT-RUN cause with its owner (the honest-not-run discipline). */
export interface NotRunCause {
  readonly area: string;
  readonly cause: string;
  readonly owner: string;
}

/**
 * The compatibility evidence record itself. `recordBasis` distinguishes
 * the honest fixture records the foundation ships (proof-scaffolding
 * demos — never certifiable) from live-proof records (produced by real
 * proof runs against real applications).
 */
export interface CompatibilityEvidenceRecord {
  /** Stable record identity (the demo registry binds entries by this id). */
  readonly recordId: string;
  /** Honest record basis: a fixture record can NEVER reach AI_EXECUTION_COMPLETE. */
  readonly recordBasis: "fixture" | "live-proof";
  readonly pinnedApplication: PinnedApplication;
  readonly graph: ApplicationExecutionGraph;
  /** The disposition of every declared edge, referenced by edge id. */
  readonly dispositions: readonly EdgeDispositionEntry[];
  readonly egressObservation: EgressObservation;
  readonly providerCredentials: readonly ProviderCredentialFact[];
  readonly runtimeEvidence: RuntimeEvidence;
  readonly comparison: readonly ComparisonFact[];
  /** The recorded Zeck trace facts (the correlation output, durably recorded). */
  readonly zeckTraces: readonly ZeckTraceFact[];
  readonly limitations: readonly LimitationEntry[];
  readonly notRunCauses: readonly NotRunCause[];
  /** When the record was produced (ISO timestamp). */
  readonly recordedAt: string;
}

/** A record validation issue (fail-closed, machine-readable). */
export interface EvidenceRecordIssue {
  readonly field: string;
  readonly issue: string;
}

/**
 * Validate the record's STRUCTURE (conformance): identities, pin, graph,
 * disposition vocabulary and shape, trace facts, observations. Structural
 * validity is a precondition for evaluation — but a structurally valid
 * record can still assess to UNASSESSED/PARTIAL/BLOCKED/BYPASS_DETECTED;
 * evaluation (status.ts) derives that from the facts.
 */
export function validateCompatibilityEvidenceRecord(
  record: unknown,
): readonly EvidenceRecordIssue[] {
  if (typeof record !== "object" || record === null) {
    return [{ field: "record", issue: "evidence record must be an object" }];
  }
  const value = record as Record<string, unknown>;
  const issues: EvidenceRecordIssue[] = [];
  if (typeof value.recordId !== "string" || value.recordId.trim().length === 0) {
    issues.push({ field: "recordId", issue: "record id is mandatory" });
  }
  if (value.recordBasis !== "fixture" && value.recordBasis !== "live-proof") {
    issues.push({ field: "recordBasis", issue: 'record basis must be "fixture" or "live-proof"' });
  }
  for (const issue of validatePinnedApplication(value.pinnedApplication)) {
    issues.push({ field: `pinnedApplication.${issue.field}`, issue: issue.issue });
  }
  for (const issue of validateExecutionGraph(value.graph)) {
    issues.push({
      field: issue.edgeId === undefined ? `graph.${issue.field}` : `graph.${issue.field}`,
      issue: issue.edgeId === undefined ? issue.issue : `${issue.edgeId}: ${issue.issue}`,
    });
  }
  issues.push(...validateDispositions(value.dispositions, value.graph));
  issues.push(...validateEgressObservation(value.egressObservation));
  issues.push(...validateCredentials(value.providerCredentials));
  issues.push(...validateRuntimeEvidence(value.runtimeEvidence));
  if (value.comparison !== undefined && !Array.isArray(value.comparison)) {
    issues.push({ field: "comparison", issue: "comparison facts must be an array" });
  }
  if (value.zeckTraces !== undefined && !Array.isArray(value.zeckTraces)) {
    issues.push({ field: "zeckTraces", issue: "zeck trace facts must be an array" });
  }
  if (value.zeckTraces !== undefined && Array.isArray(value.zeckTraces)) {
    for (const trace of value.zeckTraces) {
      const t = trace as Record<string, unknown>;
      if (typeof t.edgeId !== "string" || typeof t.executionId !== "string") {
        issues.push({
          field: "zeckTraces",
          issue: "every trace fact carries its edge id and execution id",
        });
      }
      if (t.correlated !== undefined && typeof t.correlated !== "boolean") {
        issues.push({ field: "zeckTraces.correlated", issue: "correlated must be a boolean" });
      }
    }
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.trim().length === 0) {
    issues.push({ field: "recordedAt", issue: "recorded-at timestamp is mandatory" });
  }
  return issues;
}

function validateDispositions(
  dispositions: unknown,
  graph: unknown,
): readonly EvidenceRecordIssue[] {
  const issues: EvidenceRecordIssue[] = [];
  if (!Array.isArray(dispositions)) {
    return [{ field: "dispositions", issue: "dispositions must be an array" }];
  }
  const edgeIds = new Set<string>(
    ((graph as { edges?: readonly { edgeId?: unknown }[] } | null)?.edges ?? [])
      .map((edge) => edge?.edgeId)
      .filter((id): id is string => typeof id === "string"),
  );
  const seen = new Set<string>();
  for (const entry of dispositions) {
    if (typeof entry !== "object" || entry === null) {
      issues.push({ field: "dispositions", issue: "every disposition must be an object" });
      continue;
    }
    const disposition = entry as Record<string, unknown>;
    if (typeof disposition.edgeId !== "string") {
      issues.push({ field: "dispositions.edgeId", issue: "disposition edge id is mandatory" });
      continue;
    }
    if (seen.has(disposition.edgeId)) {
      issues.push({
        field: "dispositions",
        issue: `duplicate disposition for edge ${disposition.edgeId}`,
      });
    }
    seen.add(disposition.edgeId);
    if (edgeIds.size > 0 && !edgeIds.has(disposition.edgeId)) {
      issues.push({
        field: "dispositions",
        issue: `disposition references unknown edge ${disposition.edgeId}`,
      });
    }
    const kind = disposition.disposition;
    if (kind === "delegated") {
      if (
        !Array.isArray(disposition.zeckExecutionIds) ||
        disposition.zeckExecutionIds.length === 0 ||
        disposition.zeckExecutionIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        issues.push({
          field: "dispositions",
          issue: `delegated edge ${disposition.edgeId} must carry at least one Zeck execution id`,
        });
      }
      if (!(EVIDENCE_BASES as readonly string[]).includes(String(disposition.evidenceBasis))) {
        issues.push({
          field: "dispositions",
          issue: `delegated edge ${disposition.edgeId} must declare its evidence basis (live | fixture | mock | simulated-provider)`,
        });
      }
    } else if (kind === "direct-provider") {
      if (
        typeof disposition.observationBasis !== "string" ||
        disposition.observationBasis.length === 0
      ) {
        issues.push({
          field: "dispositions",
          issue: `direct-provider edge ${disposition.edgeId} must carry its observation basis`,
        });
      }
    } else if (kind === "not-run") {
      if (typeof disposition.cause !== "string" || disposition.cause.length === 0) {
        issues.push({
          field: "dispositions",
          issue: `not-run edge ${disposition.edgeId} must carry its NOT-RUN cause`,
        });
      }
      if (typeof disposition.owner !== "string" || disposition.owner.length === 0) {
        issues.push({
          field: "dispositions",
          issue: `not-run edge ${disposition.edgeId} must name its owner`,
        });
      }
    } else if (kind === "non-ai") {
      if (typeof disposition.justification !== "string" || disposition.justification.length === 0) {
        issues.push({
          field: "dispositions",
          issue: `non-ai edge ${disposition.edgeId} must carry its reclassification justification`,
        });
      }
    } else {
      issues.push({
        field: "dispositions",
        issue: `edge ${disposition.edgeId} carries an unknown disposition ${String(kind)}`,
      });
    }
  }
  return issues;
}

function validateEgressObservation(observation: unknown): readonly EvidenceRecordIssue[] {
  if (typeof observation !== "object" || observation === null) {
    return [{ field: "egressObservation", issue: "egress observation must be an object" }];
  }
  const value = observation as Record<string, unknown>;
  const issues: EvidenceRecordIssue[] = [];
  if (value.mode !== "observe" && value.mode !== "deny") {
    issues.push({ field: "egressObservation.mode", issue: 'mode must be "observe" or "deny"' });
  }
  const statuses = ["not-run", "observed-clean", "violations-detected", "provably-blocked"];
  if (!statuses.includes(String(value.status))) {
    issues.push({
      field: "egressObservation.status",
      issue: "status must be not-run | observed-clean | violations-detected | provably-blocked",
    });
  }
  if (value.violations !== undefined && !Array.isArray(value.violations)) {
    issues.push({ field: "egressObservation.violations", issue: "violations must be an array" });
  }
  return issues;
}

function validateCredentials(credentials: unknown): readonly EvidenceRecordIssue[] {
  if (credentials === undefined) {
    return [];
  }
  if (!Array.isArray(credentials)) {
    return [{ field: "providerCredentials", issue: "provider credential facts must be an array" }];
  }
  const issues: EvidenceRecordIssue[] = [];
  for (const credential of credentials) {
    const value = credential as Record<string, unknown>;
    if (typeof value.envVarName !== "string" || value.envVarName.trim().length === 0) {
      issues.push({
        field: "providerCredentials",
        issue: "every credential fact carries an env-var NAME (never a value)",
      });
    }
    if (typeof value.present !== "boolean") {
      issues.push({
        field: "providerCredentials",
        issue: `credential fact for ${String(value.envVarName)} must carry a presence boolean`,
      });
    }
  }
  return issues;
}

function validateRuntimeEvidence(evidence: unknown): readonly EvidenceRecordIssue[] {
  if (typeof evidence !== "object" || evidence === null) {
    return [{ field: "runtimeEvidence", issue: "runtime evidence must be an object" }];
  }
  const value = evidence as Record<string, unknown>;
  const issues: EvidenceRecordIssue[] = [];
  if (typeof value.corpusDeclared !== "boolean") {
    issues.push({
      field: "runtimeEvidence.corpusDeclared",
      issue:
        "corpusDeclared must be a boolean (an undeclared corpus is honest — it simply fails rule 3)",
    });
  }
  const usability = ["verified", "not-verified", "not-run"];
  if (!usability.includes(String(value.corpusUsability))) {
    issues.push({
      field: "runtimeEvidence.corpusUsability",
      issue: "corpus usability must be verified | not-verified | not-run",
    });
  }
  if (value.observations !== undefined && !Array.isArray(value.observations)) {
    issues.push({
      field: "runtimeEvidence.observations",
      issue: "runtime observations must be an array",
    });
  }
  return issues;
}

/** The disposition of one edge (null when the record carries none). */
export function dispositionOf(
  record: CompatibilityEvidenceRecord,
  edgeId: string,
): EdgeDispositionEntry | null {
  return record.dispositions.find((entry) => entry.edgeId === edgeId) ?? null;
}
