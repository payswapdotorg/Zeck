/**
 * Static no-bypass checks (ACR-006 §"Mandatory reinterpretation test" of
 * the target matrix; the proof program's battery step 10).
 *
 * THE MANDATORY REINTERPRETATION TEST, as code: compare
 *
 *   declared execution graph  vs  discovered edge inventory
 *
 * Any mismatch becomes a NAMED finding — never a silent out-of-scope.
 * The two defect classes this module makes structurally visible:
 *
 *  - UNDECLARED_EDGE: the discovery found an AI-execution edge the
 *    declared graph does not contain. This is the "hidden direct-provider
 *    edge": until the graph declares it (and the evidence record carries
 *    its disposition), no completeness claim over the declared graph can
 *    be trusted — the admission function treats an unresolved
 *    UNDECLARED_EDGE as a hard coverage defect (never COMPLETE).
 *  - INVENTORY_MISSING: no discovered inventory was produced at all.
 *    Missing evidence is not evidence of absence: the application stays
 *    unassessed on this axis and can never be COMPLETE against an
 *    inventory that does not exist.
 *
 * This reconciliation is PURE (declaration vs discovery, no environment).
 * It deliberately does NOT compare against runtime egress — that is the
 * runtime egress observation the evidence record carries (evidence.ts),
 * a separate axis with its own vocabulary.
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
} from "./execution-graph";

/** The static no-bypass finding classes (named, machine-readable). */
export const STATIC_FINDING_KINDS = [
  "UNDECLARED_EDGE",
  "INVENTORY_MISSING",
  "DECLARED_EDGE_UNDISCOVERED",
] as const;

export type StaticFindingKind = (typeof STATIC_FINDING_KINDS)[number];

/** One named static no-bypass finding. */
export interface StaticNoBypassFinding {
  readonly kind: StaticFindingKind;
  /** The edge the finding names (edge id; absent for inventory-level findings). */
  readonly edgeId?: string;
  /** The finding's human-readable statement (rendered verbatim). */
  readonly detail: string;
}

/**
 * Reconcile the declared graph against a discovered inventory.
 *
 *  - inventory === null ⇒ INVENTORY_MISSING (the missing-inventory
 *    defect: a proof without a discovery is a proof of nothing);
 *  - a discovered edge whose id is absent from the declared graph ⇒
 *    UNDECLARED_EDGE (the hidden-edge defect — matched by edge id AND by
 *    the component+surface+external chain, so a renamed-but-undeclared
 *    edge cannot hide behind an id change);
 *  - a declared edge the discovery did not find ⇒
 *    DECLARED_EDGE_UNDISCOVERED (an informational divergence: the edge
 *    stays declared (materiality is the integrator's assertion) but the
 *    divergence is named, never silently resolved).
 *
 * Pure and total: no filesystem, no clock, no environment.
 */
export function reconcileExecutionGraph(
  declared: ApplicationExecutionGraph,
  inventory: DiscoveredEdgeInventory | null,
): readonly StaticNoBypassFinding[] {
  if (inventory === null) {
    return [
      {
        kind: "INVENTORY_MISSING",
        detail:
          "No discovered edge inventory was produced for this pinned revision: the declared graph is unreconciled. Missing discovery is a coverage defect — completeness cannot be assessed against an inventory that does not exist.",
      },
    ];
  }
  const findings: StaticNoBypassFinding[] = [];
  const declaredById = new Map(declared.edges.map((edge) => [edge.edgeId, edge] as const));
  const discoveredByChain = new Set<string>(inventory.edges.map((edge) => edgeChainKey(edge)));
  for (const discovered of inventory.edges) {
    const declaredEdge = declaredById.get(discovered.edgeId) ?? null;
    const chainDeclared = discoveredById(declared, discovered);
    if (declaredEdge === null && chainDeclared === null) {
      findings.push({
        kind: "UNDECLARED_EDGE",
        edgeId: discovered.edgeId,
        detail: `Discovered AI-execution edge not declared in the application execution graph: ${discovered.component} → ${discovered.surface} → ${discovered.transport} → ${discovered.externalExecution} (discovered by ${inventory.source}). A hidden edge is a coverage defect until declared and dispositioned.`,
      });
    }
  }
  for (const edge of declared.edges) {
    if (
      !discoveredByChain.has(edgeChainKey(edge)) &&
      !inventory.edges.some((d) => d.edgeId === edge.edgeId)
    ) {
      findings.push({
        kind: "DECLARED_EDGE_UNDISCOVERED",
        edgeId: edge.edgeId,
        detail: `Declared edge was not found by the discovery (${inventory.source}): ${edge.component} → ${edge.surface}. The declaration stands (materiality is the integrator's assertion) and the divergence is named here — never silently resolved.`,
      });
    }
  }
  return findings;
}

/** The identity chain of an edge (component + surface + external execution). */
function edgeChainKey(edge: ExecutionGraphEdge): string {
  return `${edge.component}::${edge.surface}::${edge.externalExecution}`;
}

/** A declared edge matching the discovered edge's chain (id-insensitive). */
function discoveredById(
  declared: ApplicationExecutionGraph,
  discovered: ExecutionGraphEdge,
): ExecutionGraphEdge | null {
  const key = edgeChainKey(discovered);
  return declared.edges.find((edge) => edgeChainKey(edge) === key) ?? null;
}

/**
 * Does the finding set contain any HARD coverage defect (a finding that
 * alone forbids AI_EXECUTION_COMPLETE)? UNDECLARED_EDGE and
 * INVENTORY_MISSING are hard; DECLARED_EDGE_UNDISCOVERED is informational
 * (the declared edge still needs a disposition through the evidence
 * record — that axis is enforced there).
 */
export function hasHardCoverageDefect(findings: readonly StaticNoBypassFinding[]): boolean {
  return findings.some(
    (finding) => finding.kind === "UNDECLARED_EDGE" || finding.kind === "INVENTORY_MISSING",
  );
}
