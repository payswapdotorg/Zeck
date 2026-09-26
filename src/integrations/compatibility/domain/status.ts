/**
 * The compatibility status vocabulary and the strict admission machine
 * (ACR-006 §4) — the ONE status transition function of the compatibility
 * layer.
 *
 * The only application-level statuses are:
 *
 *   UNASSESSED | PARTIAL | BLOCKED | BYPASS_DETECTED | AI_EXECUTION_COMPLETE
 *
 * AI_EXECUTION_COMPLETE requires ALL FIVE strict admission rules (ACR-006
 * §4, verbatim semantics):
 *
 *  1. every declared material AI execution edge is delegated through Zeck
 *     (an edge explicitly reclassified as non-AI, with its mandatory
 *     auditable justification, is not an AI edge — ordinary domain logic
 *     never has to surrender to achieve completeness);
 *  2. direct AI-provider egress is absent or provably blocked during the
 *     proof;
 *  3. the application remains functionally usable for the declared corpus;
 *  4. Zeck execution records/evidence exist for every delegated edge;
 *  5. no fixture, simulation, or mocked provider path is counted as an
 *     external PASS.
 *
 * Plus the work order's completeness invariant, enforced as a sixth gate
 * OUTSIDE the five ACR rules (it is coverage, not admission): no hard
 * static no-bypass coverage defect (an UNDECLARED_EDGE or a missing
 * inventory) may stand — an omitted material edge is a visible coverage
 * defect, never silently out of scope, and it alone forbids COMPLETE.
 *
 * THE ENFORCEMENT POINT: status is NEVER a field on any record, registry
 * entry or projection. The ONLY way to obtain a status is this pure
 * function over the evidence record — so a fixture record, a demo entry,
 * a UI or any other projection is structurally unable to manufacture,
 * upgrade or persist a status. This definition can never be relaxed to
 * make a demo pass (relaxation would have to edit THIS function, whose
 * tests pin every rule's discriminating power).
 */

import type { CompatibilityEvidenceRecord, ZeckTraceFact } from "./evidence";
import { dispositionOf } from "./evidence";
import type { DiscoveredEdgeInventory } from "./execution-graph";
import type { StaticNoBypassFinding } from "./no-bypass";
import { hasHardCoverageDefect, reconcileExecutionGraph } from "./no-bypass";

/** The only application-level compatibility statuses (ACR-006 §4). */
export const COMPATIBILITY_STATUSES = [
  "UNASSESSED",
  "PARTIAL",
  "BLOCKED",
  "BYPASS_DETECTED",
  "AI_EXECUTION_COMPLETE",
] as const;

export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

/** The five strict admission rule ids (ACR-006 §4, in order). */
export const COMPATIBILITY_ADMISSION_RULES = [
  {
    id: "EVERY_DECLARED_EDGE_DELEGATED",
    statement:
      "Every declared material AI execution edge is delegated through Zeck (an explicitly reclassified non-AI edge, with its auditable justification, is not an AI edge).",
  },
  {
    id: "DIRECT_EGRESS_ABSENT_OR_BLOCKED",
    statement: "Direct AI-provider egress is absent or provably blocked during the proof.",
  },
  {
    id: "CORPUS_FUNCTIONALLY_USABLE",
    statement: "The application remains functionally usable for the declared corpus.",
  },
  {
    id: "ZECK_EVIDENCE_FOR_EVERY_DELEGATED_EDGE",
    statement: "Zeck execution records and evidence exist for every delegated edge.",
  },
  {
    id: "NO_FIXTURE_COUNTED_AS_EXTERNAL_PASS",
    statement: "No fixture, simulation, or mocked provider path is counted as an external PASS.",
  },
] as const;

export type AdmissionRuleId = (typeof COMPATIBILITY_ADMISSION_RULES)[number]["id"];

/** The evaluation of one admission rule (explicit and auditable). */
export interface AdmissionRuleResult {
  readonly ruleId: AdmissionRuleId;
  readonly satisfied: boolean;
  readonly detail: string;
}

/** A named admission finding (machine-readable; rendered verbatim). */
export interface AdmissionFinding {
  readonly code: string;
  readonly detail: string;
  readonly edgeId?: string;
}

/** The complete assessment: derived status + rule results + findings. */
export interface CompatibilityAssessment {
  readonly status: CompatibilityStatus;
  readonly ruleResults: readonly AdmissionRuleResult[];
  readonly findings: readonly AdmissionFinding[];
  /** The static no-bypass findings the assessment reconciled against. */
  readonly staticFindings: readonly StaticNoBypassFinding[];
}

/** The owners that name EXTERNAL boundaries (program failure routing). */
const EXTERNAL_OWNERS = new Set(["provider", "operator"]);

/**
 * The status transition function: derive the assessment (status + rule
 * results + named findings) from an evidence record and an optional
 * discovered edge inventory.
 *
 * Deterministic precedence:
 *  1. BYPASS_DETECTED — any direct-provider edge disposition or any
 *     observed-passing egress violation (observe mode) is a detected
 *     bypass; it overrides everything else and can never coexist with
 *     COMPLETE;
 *  2. AI_EXECUTION_COMPLETE — all five admission rules satisfied AND no
 *     hard static coverage defect (a hidden edge or a missing inventory
 *     alone forbids it);
 *  3. BLOCKED — no proof progress at all, and every undelegated edge is
 *     not-run with an external owner (provider/operator boundary);
 *  4. PARTIAL — proof progress exists but admission is unmet;
 *  5. UNASSESSED — no progress, no external blocking: the proof has not
 *     meaningfully started.
 *
 * Pure and total: no environment, no clock, no I/O.
 */
export function evaluateCompatibility(
  record: CompatibilityEvidenceRecord,
  inventory: DiscoveredEdgeInventory | null = null,
): CompatibilityAssessment {
  const findings: AdmissionFinding[] = [];
  const staticFindings = reconcileExecutionGraph(record.graph, inventory);

  // ------------------------------------------------------------------
  // Rule 1 — every declared material edge delegated (or explicitly non-AI)
  // ------------------------------------------------------------------
  const rule1EdgeResults = record.graph.edges.map((edge) => {
    const disposition = dispositionOf(record, edge.edgeId);
    if (disposition === null) {
      findings.push({
        code: "EDGE_MISSING_DISPOSITION",
        edgeId: edge.edgeId,
        detail: `Declared material edge ${edge.edgeId} (${edge.component} → ${edge.surface}) carries no disposition in the evidence record — an omitted edge is a coverage defect, never silently out of scope.`,
      });
      return { edgeId: edge.edgeId, ok: false };
    }
    if (disposition.disposition === "delegated" || disposition.disposition === "non-ai") {
      return { edgeId: edge.edgeId, ok: true };
    }
    if (disposition.disposition === "direct-provider") {
      findings.push({
        code: "BYPASS_DIRECT_PROVIDER_EDGE",
        edgeId: edge.edgeId,
        detail: `Edge ${edge.edgeId} (${edge.component} → ${edge.surface}) executed on a direct external AI provider: ${disposition.observationBasis}. This is a bypass of the Zeck boundary.`,
      });
      return { edgeId: edge.edgeId, ok: false };
    }
    findings.push({
      code: "EDGE_NOT_DELEGATED",
      edgeId: edge.edgeId,
      detail: `Edge ${edge.edgeId} (${edge.component} → ${edge.surface}) is not delegated: not-run (${disposition.cause}; owner ${disposition.owner}).`,
    });
    return { edgeId: edge.edgeId, ok: false };
  });
  const rule1 = rule1EdgeResults.every((result) => result.ok);
  const ruleResults: AdmissionRuleResult[] = [
    {
      ruleId: "EVERY_DECLARED_EDGE_DELEGATED",
      satisfied: rule1,
      detail: rule1
        ? `All ${record.graph.edges.length} declared edges are delegated through Zeck (or explicitly reclassified non-AI with recorded justification).`
        : `Not every declared edge is delegated: ${rule1EdgeResults
            .filter((r) => !r.ok)
            .map((r) => r.edgeId)
            .join(", ")}.`,
    },
  ];

  // ------------------------------------------------------------------
  // Rule 2 — direct egress absent or provably blocked
  // ------------------------------------------------------------------
  const egress = record.egressObservation;
  let rule2 = false;
  if (egress.status === "observed-clean") {
    rule2 = egress.violations.length === 0;
    if (!rule2) {
      findings.push({
        code: "EGRESS_STATUS_INCONSISTENT",
        detail: "Egress observation claims observed-clean but records violations.",
      });
    }
  } else if (egress.status === "provably-blocked") {
    rule2 =
      egress.mode === "deny" &&
      egress.violations.length > 0 &&
      egress.violations.every((v) => v.blocked);
    if (!rule2) {
      findings.push({
        code: "EGRESS_STATUS_INCONSISTENT",
        detail:
          "Egress observation claims provably-blocked but the recorded violations do not prove it (deny mode with every violation blocked).",
      });
    }
  } else if (egress.status === "violations-detected") {
    findings.push({
      code: "BYPASS_EGRESS_VIOLATION",
      detail: `Direct AI-provider egress violations were observed passing during the proof (${egress.violations.map((v) => v.host).join(", ")}). Every passing violation is a detected bypass.`,
    });
  } else {
    findings.push({
      code: "EGRESS_NOT_RUN",
      detail:
        "The runtime direct-provider egress observation was not run — absence of egress is unproven, so admission rule 2 is unmet.",
    });
  }
  ruleResults.push({
    ruleId: "DIRECT_EGRESS_ABSENT_OR_BLOCKED",
    satisfied: rule2,
    detail: rule2
      ? `Direct AI-provider egress is ${egress.status === "provably-blocked" ? "provably blocked (deny harness active, every violation blocked)" : "absent (observed clean)"} during the proof.`
      : `Egress observation status: ${egress.status} (mode ${egress.mode}).`,
  });

  // ------------------------------------------------------------------
  // Rule 3 — the declared corpus remains functionally usable
  // ------------------------------------------------------------------
  const runtime = record.runtimeEvidence;
  const rule3 = runtime.corpusDeclared && runtime.corpusUsability === "verified";
  if (!runtime.corpusDeclared) {
    findings.push({
      code: "CORPUS_NOT_DECLARED",
      detail:
        "No representative corpus is declared for this proof — functional usability of the application is unproven, so admission rule 3 is unmet.",
    });
  } else if (runtime.corpusUsability !== "verified") {
    findings.push({
      code: `CORPUS_${runtime.corpusUsability.replace(/-/g, "_").toUpperCase()}`,
      detail: `The declared corpus is ${runtime.corpusUsability === "not-run" ? "not run" : "recorded as NOT functionally usable"} — admission rule 3 is unmet.`,
    });
  }
  ruleResults.push({
    ruleId: "CORPUS_FUNCTIONALLY_USABLE",
    satisfied: rule3,
    detail: rule3
      ? "The application remained functionally usable for the declared corpus during the proof."
      : `Corpus declared: ${runtime.corpusDeclared}; usability: ${runtime.corpusUsability}.`,
  });

  // ------------------------------------------------------------------
  // Rule 4 — Zeck execution records/evidence for every delegated edge
  // ------------------------------------------------------------------
  const tracesByEdge = new Map<string, ZeckTraceFact[]>();
  for (const trace of record.zeckTraces) {
    const existing = tracesByEdge.get(trace.edgeId) ?? [];
    existing.push(trace);
    tracesByEdge.set(trace.edgeId, existing);
  }
  let rule4 = true;
  let delegatedEdgeCount = 0;
  for (const disposition of record.dispositions) {
    if (disposition.disposition !== "delegated") {
      continue;
    }
    delegatedEdgeCount += 1;
    const traces = tracesByEdge.get(disposition.edgeId) ?? [];
    for (const executionId of disposition.zeckExecutionIds) {
      const trace = traces.find((candidate) => candidate.executionId === executionId);
      if (trace === undefined) {
        rule4 = false;
        findings.push({
          code: "ZECK_TRACE_MISSING",
          edgeId: disposition.edgeId,
          detail: `Delegated edge ${disposition.edgeId} declares Zeck execution ${executionId}, but no recorded trace fact correlates it — the execution must be read back through the executions public surface and recorded.`,
        });
        continue;
      }
      if (!trace.found) {
        rule4 = false;
        findings.push({
          code: "ZECK_TRACE_NOT_FOUND",
          edgeId: disposition.edgeId,
          detail: `Zeck execution ${executionId} (edge ${disposition.edgeId}) was not found through the executions public surface.`,
        });
        continue;
      }
      if (!trace.correlated) {
        rule4 = false;
        findings.push({
          code: "ZECK_TRACE_NOT_CORRELATED",
          edgeId: disposition.edgeId,
          detail: `Zeck execution ${executionId} (edge ${disposition.edgeId}) carries no durable evidence (ledger events + at least one verification result).`,
        });
      }
    }
    // At least one declared execution must have RESOLVED through Zeck
    // with verified evidence (terminal COMPLETED bound to a durable
    // PASS — the executions authority's own completion binding).
    const resolved = disposition.zeckExecutionIds.some((executionId) => {
      const trace = traces.find((candidate) => candidate.executionId === executionId);
      return (
        trace?.terminal === true &&
        trace?.status === "COMPLETED" &&
        (trace?.passingVerificationCount ?? 0) > 0
      );
    });
    if (!resolved) {
      rule4 = false;
      findings.push({
        code: "ZECK_TRACE_NOT_RESOLVED",
        edgeId: disposition.edgeId,
        detail: `Delegated edge ${disposition.edgeId} has no execution that resolved through Zeck with verified evidence (terminal COMPLETED bound to at least one durable PASS verification result).`,
      });
    }
  }
  ruleResults.push({
    ruleId: "ZECK_EVIDENCE_FOR_EVERY_DELEGATED_EDGE",
    satisfied: rule4,
    detail: rule4
      ? `All ${delegatedEdgeCount} delegated edge(s) correlate to Zeck execution records with durable evidence.`
      : "At least one delegated edge lacks a correlated Zeck execution record with durable evidence.",
  });

  // ------------------------------------------------------------------
  // Rule 5 — no fixture/mock/simulated path counted as external PASS
  // ------------------------------------------------------------------
  let rule5 = record.recordBasis === "live-proof";
  if (!rule5) {
    findings.push({
      code: "FIXTURE_RECORD",
      detail:
        "This evidence record is an honest FIXTURE (proof scaffolding, not a live proof) — a fixture record can never satisfy admission rule 5, regardless of its contents.",
    });
  }
  for (const disposition of record.dispositions) {
    if (disposition.disposition === "delegated" && disposition.evidenceBasis !== "live") {
      rule5 = false;
      findings.push({
        code: "FIXTURE_EVIDENCE_BASIS",
        edgeId: disposition.edgeId,
        detail: `Delegated edge ${disposition.edgeId} carries ${disposition.evidenceBasis} evidence — only live evidence counts as an external PASS (admission rule 5).`,
      });
    }
  }
  ruleResults.push({
    ruleId: "NO_FIXTURE_COUNTED_AS_EXTERNAL_PASS",
    satisfied: rule5,
    detail: rule5
      ? "Every delegated edge carries live Zeck evidence from a live proof record."
      : "At least one fixture/mock/simulated basis (or the record itself) is in play — not an external PASS.",
  });

  // ------------------------------------------------------------------
  // The coverage gate (the work order's omitted-edge invariant)
  // ------------------------------------------------------------------
  const hardCoverageDefect = hasHardCoverageDefect(staticFindings);
  for (const finding of staticFindings) {
    if (finding.kind === "UNDECLARED_EDGE" || finding.kind === "INVENTORY_MISSING") {
      findings.push({
        code: finding.kind,
        edgeId: finding.edgeId,
        detail: finding.detail,
      });
    }
  }

  // ------------------------------------------------------------------
  // Precedence: derive the status
  // ------------------------------------------------------------------
  const bypassDetected =
    findings.some(
      (finding) =>
        finding.code === "BYPASS_DIRECT_PROVIDER_EDGE" ||
        finding.code === "BYPASS_EGRESS_VIOLATION",
    ) || record.dispositions.some((d) => d.disposition === "direct-provider");
  const allRulesSatisfied = ruleResults.every((result) => result.satisfied);

  if (bypassDetected) {
    return { status: "BYPASS_DETECTED", ruleResults, findings, staticFindings };
  }
  if (allRulesSatisfied && !hardCoverageDefect) {
    return { status: "AI_EXECUTION_COMPLETE", ruleResults, findings, staticFindings };
  }

  const progress =
    delegatedEdgeCount > 0 ||
    runtime.corpusUsability === "verified" ||
    egress.status === "observed-clean" ||
    egress.status === "provably-blocked";
  const undelegatedEdges = record.graph.edges.filter((edge) => {
    const disposition = dispositionOf(record, edge.edgeId);
    return (
      disposition === null ||
      disposition.disposition === "not-run" ||
      disposition.disposition === "direct-provider"
    );
  });
  const everyUndelegatedExternallyBlocked =
    undelegatedEdges.every((edge) => {
      const disposition = dispositionOf(record, edge.edgeId);
      return (
        disposition !== null &&
        disposition.disposition === "not-run" &&
        EXTERNAL_OWNERS.has(disposition.owner.toLowerCase())
      );
    }) && undelegatedEdges.length > 0;

  if (!progress && everyUndelegatedExternallyBlocked) {
    return { status: "BLOCKED", ruleResults, findings, staticFindings };
  }
  if (progress) {
    return { status: "PARTIAL", ruleResults, findings, staticFindings };
  }
  return { status: "UNASSESSED", ruleResults, findings, staticFindings };
}
