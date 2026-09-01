/**
 * The execution-graph representation of a customer-selected codebase
 * subgraph (learning module domain; WORK-022 / DTR-005; ADR-0008,
 * ADR-0010).
 *
 * THE normalized analysis substrate (Work Order §6): a selected
 * subgraph is turned into an immutable graph whose nodes carry the
 * closed operation vocabulary —
 *
 *   function | dependency | model-call | deterministic | tool-call |
 *   data-access | network-call | external-side-effect |
 *   human-interaction | verification
 *
 * — plus the cost/latency observations and the FULL source provenance
 * (repository, revision, file, symbol, line range where supported).
 *
 * PROVENANCE IS IDENTITY (§16, M11/M12/M27/M28):
 *  - every node MUST carry provenance: repository, revision and file
 *    are MANDATORY (a finding without source provenance is
 *    unrepresentable — validation fails closed);
 *  - every node's provenance revision MUST equal the selection's
 *    source revision (evidence binding: stale or mixed revisions are
 *    rejected, never silently normalized — M28);
 *  - node ids are unique and edges reference only existing nodes (the
 *    original function/subgraph identity is preserved, never
 *    destroyed — M27);
 *  - analysis NEVER requires a whole repository (§7): the selection is
 *    exactly the user-selected nodes/edges.
 *
 * This file is pure domain: no side effects, no imports outside
 * `shared`, no execution of customer code (§5: READ customer-selected
 * code -> ANALYZE -> ADVISORY findings only).
 */

import { PlatformError } from "../../../shared/errors";

/** Frozen execution-graph schema version. */
export const EXECUTION_GRAPH_SCHEMA_VERSION = 1;

/** The closed node-kind vocabulary (Work Order §6). */
export const EXECUTION_GRAPH_NODE_KINDS = [
  "function",
  "dependency",
  "model-call",
  "deterministic",
  "tool-call",
  "data-access",
  "network-call",
  "external-side-effect",
  "human-interaction",
  "verification",
] as const;

export type ExecutionGraphNodeKind = (typeof EXECUTION_GRAPH_NODE_KINDS)[number];

export function isExecutionGraphNodeKind(value: string): value is ExecutionGraphNodeKind {
  return (EXECUTION_GRAPH_NODE_KINDS as readonly string[]).includes(value);
}

/** The closed edge-relation vocabulary. */
export const EXECUTION_GRAPH_EDGE_RELATIONS = ["calls", "feeds"] as const;

export type ExecutionGraphEdgeRelation = (typeof EXECUTION_GRAPH_EDGE_RELATIONS)[number];

/** Source provenance of one node (§6/§16 — identity, never dropped). */
export interface SourceProvenance {
  readonly repository: string;
  readonly revision: string;
  readonly file: string;
  /** Symbol/function identity where supported (§6). */
  readonly symbol?: string;
  /** Line/range where supported (§6). */
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/**
 * The observed behavior of one node (caller-supplied evidence — the
 * analysis is honest about what was actually OBSERVED; absent fields
 * are unknown, never invented).
 */
export interface NodeObservation {
  /** How many times this node was observed executing (>= 1 required). */
  readonly executionCount: number;
  /** Observed error/failure fraction in [0,1] (unknown when absent). */
  readonly errorRate?: number;
  /** Observed distinct inputs (unknown when absent). */
  readonly distinctInputCount?: number;
  /** Observed distinct outputs (unknown when absent). */
  readonly distinctOutputCount?: number;
  /** Whether every observed output was byte-identical (unknown when absent). */
  readonly constantOutput?: boolean;
  /** Verification observations covering this node (unknown when absent). */
  readonly verificationPassCount?: number;
  readonly verificationFailCount?: number;
  /** Input variability classification (the deterministicization evidence axis). */
  readonly inputVariability?: "low" | "moderate" | "high";
  /** Semantic complexity classification (the deterministicization evidence axis). */
  readonly semanticComplexity?: "low" | "moderate" | "high";
  /** Observed cost per invocation (integer micro-USD string; unknown when absent). */
  readonly observedCostMicroUsd?: string;
  /** Observed latency per invocation (ms; unknown when absent). */
  readonly observedLatencyMs?: number;
  /** Evidence references backing these observations (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
}

/** One node of the normalized execution graph. */
export interface ExecutionGraphNode {
  readonly nodeId: string;
  readonly kind: ExecutionGraphNodeKind;
  /** Human-facing label (e.g. the function name). */
  readonly label: string;
  readonly provenance: SourceProvenance;
  /** Observed behavior (Mandatory: no node without evidence). */
  readonly observation: NodeObservation;
}

/** One edge of the normalized execution graph. */
export interface ExecutionGraphEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: ExecutionGraphEdgeRelation;
}

/** The customer-selected subgraph (§7 — exactly the selection, nothing more). */
export interface SelectedSubgraph {
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly kind: string;
    readonly label: string;
    readonly provenance: {
      readonly repository?: string;
      readonly revision?: string;
      readonly file?: string;
      readonly symbol?: string;
      readonly lineStart?: number;
      readonly lineEnd?: number;
    };
    readonly observation: Record<string, unknown>;
  }[];
  readonly edges: readonly {
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly relation: string;
  }[];
}

/** The built execution graph (immutable analysis substrate). */
export interface ExecutionGraph {
  readonly repository: string;
  readonly revision: string;
  readonly nodes: readonly ExecutionGraphNode[];
  readonly edges: readonly ExecutionGraphEdge[];
  readonly schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  container: Record<string, unknown>,
  key: string,
  what: string,
  max = 512,
): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `${what} must be a non-empty string (1..${max} chars)`,
      details: { field: key },
    });
  }
  return value;
}

function optionalNonEmptyString(
  container: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = container[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `${what} must be a non-empty string when present`,
      details: { field: key },
    });
  }
  return value;
}

function optionalLine(container: Record<string, unknown>, key: string): number | undefined {
  const value = container[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `${key} must be a positive integer line number when present`,
      details: { field: key },
    });
  }
  return value;
}

/** Validate the closed node-observation shape (fail closed). */
function validateObservation(value: unknown, nodeId: string): NodeObservation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `node ${nodeId}: observation must be an object`,
    });
  }
  const observation = value;
  const executionCount = observation.executionCount;
  if (
    typeof executionCount !== "number" ||
    !Number.isInteger(executionCount) ||
    executionCount < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `node ${nodeId}: observation executionCount must be a positive integer (no evidence -> no analysis)`,
      details: { field: "executionCount" },
    });
  }
  for (const key of ["errorRate"] as const) {
    const rate = observation[key];
    if (rate !== undefined && (typeof rate !== "number" || rate < 0 || rate > 1)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: observation ${key} must be in [0,1] when present`,
      });
    }
  }
  for (const key of [
    "distinctInputCount",
    "distinctOutputCount",
    "verificationPassCount",
    "verificationFailCount",
    "observedLatencyMs",
  ] as const) {
    const count = observation[key];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: observation ${key} must be a non-negative integer when present`,
      });
    }
  }
  for (const key of ["inputVariability", "semanticComplexity"] as const) {
    const level = observation[key];
    if (
      level !== undefined &&
      (typeof level !== "string" || !["low", "moderate", "high"].includes(level))
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: observation ${key} must be 'low' | 'moderate' | 'high' when present`,
      });
    }
  }
  if (observation.constantOutput !== undefined && typeof observation.constantOutput !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `node ${nodeId}: observation constantOutput must be a boolean when present`,
    });
  }
  if (
    observation.observedCostMicroUsd !== undefined &&
    (typeof observation.observedCostMicroUsd !== "string" ||
      !/^\d{1,19}$/.test(observation.observedCostMicroUsd))
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `node ${nodeId}: observedCostMicroUsd must be an integer micro-USD string when present`,
    });
  }
  const evidenceRefs = observation.evidenceRefs;
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length === 0 ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `node ${nodeId}: observation evidenceRefs must be non-empty (M11: observations are evidence-backed)`,
      details: { field: "evidenceRefs" },
    });
  }
  // NOTE: absent observation axes are OMITTED (never written as
  // explicit `undefined`): the observation participates in the
  // analysis digest basis, and the canonical JSON universe rejects
  // undefined values — an observation must stay digest-stable.
  const observationOut: Record<string, unknown> = { executionCount };
  for (const key of [
    "errorRate",
    "distinctInputCount",
    "distinctOutputCount",
    "constantOutput",
    "verificationPassCount",
    "verificationFailCount",
    "inputVariability",
    "semanticComplexity",
    "observedCostMicroUsd",
    "observedLatencyMs",
  ] as const) {
    const value = observation[key];
    if (value !== undefined) {
      observationOut[key] = value;
    }
  }
  observationOut.evidenceRefs = [...evidenceRefs];
  return observationOut as unknown as NodeObservation;
}

/**
 * Build the normalized execution graph from a customer-selected
 * subgraph (§6/§7). Fail-closed validation: provenance is MANDATORY on
 * every node (M11/M12), revisions must match the selection's revision
 * (M28: stale/mixed revisions rejected), node ids unique, edges
 * reference existing nodes (M27: original identity preserved).
 */
export function buildExecutionGraph(
  selection: SelectedSubgraph & {
    readonly source: { readonly repository: string; readonly revision: string };
  },
): ExecutionGraph {
  const repository = requireNonEmptyString(
    selection.source as unknown as Record<string, unknown>,
    "repository",
    "selection source repository",
  );
  const revision = requireNonEmptyString(
    selection.source as unknown as Record<string, unknown>,
    "revision",
    "selection source revision",
  );
  if (!Array.isArray(selection.nodes) || selection.nodes.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "selected subgraph must carry at least one node (§7: the exact selection)",
    });
  }
  if (!Array.isArray(selection.edges)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "selected subgraph edges must be an array (may be empty)",
    });
  }
  if (selection.nodes.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "selected subgraph exceeds the bounded v1 size (<= 256 nodes — a documented bound, never silent truncation)",
      details: { nodes: selection.nodes.length },
    });
  }

  const seenNodeIds = new Set<string>();
  const nodes: ExecutionGraphNode[] = [];
  for (const raw of selection.nodes) {
    if (!isRecord(raw)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "subgraph node must be an object",
      });
    }
    const node = raw;
    const nodeId = requireNonEmptyString(node, "nodeId", "node id", 256);
    if (seenNodeIds.has(nodeId)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `duplicate node id ${nodeId} (M27: original identity must stay unique)`,
      });
    }
    seenNodeIds.add(nodeId);
    const kind = node.kind;
    if (typeof kind !== "string" || !isExecutionGraphNodeKind(kind)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: kind must be the closed execution-graph vocabulary`,
        details: { allowed: EXECUTION_GRAPH_NODE_KINDS },
      });
    }
    const label = requireNonEmptyString(node, "label", `node ${nodeId} label`, 256);

    const provenanceRaw = node.provenance;
    if (!isRecord(provenanceRaw)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: provenance is MANDATORY (M11/M12: source provenance never omitted)`,
      });
    }
    const nodeRepository = requireNonEmptyString(
      provenanceRaw,
      "repository",
      `node ${nodeId} provenance repository`,
    );
    const nodeRevision = requireNonEmptyString(
      provenanceRaw,
      "revision",
      `node ${nodeId} provenance revision`,
    );
    const file = requireNonEmptyString(
      provenanceRaw,
      "file",
      `node ${nodeId} provenance file`,
      512,
    );
    if (nodeRepository !== repository) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: provenance repository does not match the selection repository`,
        details: { expected: repository, got: nodeRepository },
      });
    }
    if (nodeRevision !== revision) {
      // M28: stale or mixed revisions are rejected — never normalized.
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: provenance revision does not match the selection revision (M28: stale/mixed revisions are rejected)`,
        details: { expected: revision, got: nodeRevision },
      });
    }
    const symbol = optionalNonEmptyString(
      provenanceRaw,
      "symbol",
      `node ${nodeId} provenance symbol`,
    );
    const lineStart = optionalLine(provenanceRaw, "lineStart");
    const lineEnd = optionalLine(provenanceRaw, "lineEnd");
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `node ${nodeId}: lineEnd must not precede lineStart`,
      });
    }
    const provenance: SourceProvenance = {
      repository: nodeRepository,
      revision: nodeRevision,
      file,
      ...(symbol === undefined ? {} : { symbol }),
      ...(lineStart === undefined ? {} : { lineStart }),
      ...(lineEnd === undefined ? {} : { lineEnd }),
    };
    nodes.push({
      nodeId,
      kind,
      label,
      provenance,
      observation: validateObservation(node.observation, nodeId),
    });
  }

  const edges: ExecutionGraphEdge[] = [];
  for (const raw of selection.edges) {
    if (!isRecord(raw)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "subgraph edge must be an object",
      });
    }
    const edge = raw;
    const fromNodeId = requireNonEmptyString(edge, "fromNodeId", "edge fromNodeId", 256);
    const toNodeId = requireNonEmptyString(edge, "toNodeId", "edge toNodeId", 256);
    const relation = edge.relation;
    if (
      typeof relation !== "string" ||
      !(EXECUTION_GRAPH_EDGE_RELATIONS as readonly string[]).includes(relation)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge relation must be 'calls' | 'feeds'",
        details: { allowed: EXECUTION_GRAPH_EDGE_RELATIONS },
      });
    }
    if (!seenNodeIds.has(fromNodeId) || !seenNodeIds.has(toNodeId)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `edge ${fromNodeId} -> ${toNodeId} references a node outside the selection (§7: the exact selection only)`,
      });
    }
    edges.push({ fromNodeId, toNodeId, relation: relation as ExecutionGraphEdgeRelation });
  }

  return {
    repository,
    revision,
    nodes,
    edges,
    schemaVersion: EXECUTION_GRAPH_SCHEMA_VERSION,
  };
}

/** Validate a built execution graph round-trip (fail closed). */
export function validateExecutionGraph(value: unknown): asserts value is ExecutionGraph {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "execution graph must be an object",
    });
  }
  const graph = value;
  requireNonEmptyString(graph, "repository", "graph repository");
  requireNonEmptyString(graph, "revision", "graph revision");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "graph nodes must be non-empty" });
  }
  for (const node of graph.nodes) {
    if (!isRecord(node) || typeof node.nodeId !== "string") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "graph node must carry a nodeId",
      });
    }
  }
  if (!Array.isArray(graph.edges)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "graph edges must be an array" });
  }
  if (graph.schemaVersion !== EXECUTION_GRAPH_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "graph schemaVersion must match the frozen execution-graph schema",
      details: { expected: EXECUTION_GRAPH_SCHEMA_VERSION },
    });
  }
}
