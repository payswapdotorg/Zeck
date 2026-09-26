/**
 * The Application Execution Graph (ACR-006 §1): for a pinned application
 * revision, every material AI-execution edge as
 *
 *   application component → execution surface → transport/adapter → external AI execution
 *
 * An edge is MATERIAL when the application would otherwise make a
 * provider/model/AI-service execution decision or invoke an AI service
 * directly (ACR-006's materiality rule). Materiality is a DECLARED fact
 * of the inventory: the graph records the edges the integration asserts
 * are material, and the static reconciliation (no-bypass.ts) makes any
 * discovered-but-undeclared edge a named coverage defect — an omitted
 * material edge is visible, never silently out of scope.
 *
 * This is a DECLARATION surface, not an execution authority: the graph
 * describes edges; it never executes them, never chooses providers,
 * never plans routes (the platform's execution chain owns all of that).
 */

import type { ExecutionSurface } from "./execution-surfaces";
import { isExecutionSurface } from "./execution-surfaces";

/** One material AI-execution edge of a pinned application. */
export interface ExecutionGraphEdge {
  /**
   * Stable edge identity within the graph (the disposition, the Zeck
   * trace correlation and the findings all reference edges by this id).
   */
  readonly edgeId: string;
  /** The application component that originates the edge (opaque name). */
  readonly component: string;
  /** The ACR-006 execution surface the edge terminates in. */
  readonly surface: ExecutionSurface;
  /** The transport/adapter the application uses at this edge (opaque name). */
  readonly transport: string;
  /**
   * The external AI execution the edge terminates in when undelegated
   * (opaque neutral string — a provider/service NAME at most, never a
   * credential, never a selection).
   */
  readonly externalExecution: string;
  /**
   * Why this edge is material (the declared materiality basis — an
   * omitted basis is a validation issue, not an assumption).
   */
  readonly materiality: string;
}

/** The declared execution graph of one pinned application revision. */
export interface ApplicationExecutionGraph {
  readonly edges: readonly ExecutionGraphEdge[];
}

/**
 * A discovered edge inventory: the STATIC discovery's view of the
 * application's AI-execution edges (source-code seam analysis, config
 * analysis, runtime observation — whatever produced it, named in
 * `source`). Reconciliation (no-bypass.ts) compares this against the
 * declared graph; an inventory that was never produced is itself a
 * named defect (the missing-inventory case), never a silent pass.
 */
export interface DiscoveredEdgeInventory {
  /** What produced this inventory (opaque provenance string). */
  readonly source: string;
  /** The discovered edges (same shape as declared edges). */
  readonly edges: readonly ExecutionGraphEdge[];
}

/** A graph validation issue (fail-closed, machine-readable). */
export interface GraphValidationIssue {
  readonly edgeId?: string;
  readonly field: string;
  readonly issue: string;
}

/** Validate an execution graph edge (structure, surface vocabulary, ids). */
export function validateExecutionGraphEdge(edge: unknown): readonly GraphValidationIssue[] {
  if (typeof edge !== "object" || edge === null) {
    return [{ field: "edge", issue: "edge must be an object" }];
  }
  const record = edge as Record<string, unknown>;
  const issues: GraphValidationIssue[] = [];
  if (typeof record.edgeId !== "string" || record.edgeId.trim().length === 0) {
    issues.push({ field: "edgeId", issue: "edge id is mandatory" });
  }
  if (typeof record.component !== "string" || record.component.trim().length === 0) {
    issues.push({ field: "component", issue: "edge component is mandatory" });
  }
  if (!isExecutionSurface(record.surface)) {
    issues.push({
      field: "surface",
      issue: "edge surface must be one of the ACR-006 execution surfaces",
    });
  }
  if (typeof record.transport !== "string" || record.transport.trim().length === 0) {
    issues.push({ field: "transport", issue: "edge transport/adapter is mandatory" });
  }
  if (
    typeof record.externalExecution !== "string" ||
    record.externalExecution.trim().length === 0
  ) {
    issues.push({ field: "externalExecution", issue: "edge external execution is mandatory" });
  }
  if (typeof record.materiality !== "string" || record.materiality.trim().length === 0) {
    issues.push({ field: "materiality", issue: "edge materiality basis is mandatory" });
  }
  return issues;
}

/** Validate a declared execution graph (every edge + id uniqueness). */
export function validateExecutionGraph(graph: unknown): readonly GraphValidationIssue[] {
  if (
    typeof graph !== "object" ||
    graph === null ||
    !Array.isArray((graph as { edges?: unknown }).edges)
  ) {
    return [{ field: "graph", issue: "execution graph must carry an edges array" }];
  }
  const edges = (graph as { edges: unknown[] }).edges;
  const issues: GraphValidationIssue[] = [];
  if (edges.length === 0) {
    issues.push({
      field: "graph.edges",
      issue:
        "a material-edge inventory must declare at least one edge (an empty graph asserts the application contains no AI execution — declare that explicitly via a non-AI reclassification finding, never by omission)",
    });
  }
  const seen = new Set<string>();
  for (const edge of edges) {
    for (const issue of validateExecutionGraphEdge(edge)) {
      issues.push(issue);
    }
    const edgeId = (edge as { edgeId?: unknown })?.edgeId;
    if (typeof edgeId === "string") {
      if (seen.has(edgeId)) {
        issues.push({ edgeId, field: "edgeId", issue: "duplicate edge id in the declared graph" });
      }
      seen.add(edgeId);
    }
  }
  return issues;
}

/** Validate a discovered inventory with the same edge discipline. */
export function validateDiscoveredInventory(inventory: unknown): readonly GraphValidationIssue[] {
  if (typeof inventory !== "object" || inventory === null) {
    return [{ field: "inventory", issue: "discovered inventory must be an object" }];
  }
  const record = inventory as { source?: unknown; edges?: unknown };
  const issues: GraphValidationIssue[] = [];
  if (typeof record.source !== "string" || record.source.trim().length === 0) {
    issues.push({ field: "inventory.source", issue: "inventory provenance source is mandatory" });
  }
  if (record.edges !== undefined) {
    issues.push(...validateExecutionGraph({ edges: record.edges }));
  } else {
    issues.push({ field: "inventory.edges", issue: "inventory must carry its discovered edges" });
  }
  return issues;
}

/** Look up a declared edge by id (null when absent). */
export function edgeById(
  graph: ApplicationExecutionGraph,
  edgeId: string,
): ExecutionGraphEdge | null {
  return graph.edges.find((edge) => edge.edgeId === edgeId) ?? null;
}
