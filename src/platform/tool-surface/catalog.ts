/**
 * The tool-surface representation catalog (platform tool-surface plane;
 * WORK-051 / E1.1 charter stage 3 — ADR-0019 §5, ADR-0020).
 *
 * The tool surface is DERIVED, never negotiated: the plan's declared
 * tool needs plus capability/policy facts plus configuration determine
 * it deterministically (architecture invariant 1 of this Work Order).
 * This module is the CLOSED DATA catalog that derivation selects from:
 *
 *  - `TOOL_REPRESENTATIONS` — the closed seven-representation set of
 *    ADR-0019 §5 (direct typed tool, deferred/discoverable tool, CLI,
 *    script, code API, MCP adapter, competence reference). The set is
 *    CLOSED AND TYPED: an invented representation is unrepresentable
 *    (validation rejects anything outside the frozen vocabulary —
 *    discrimination-proven). MCP is ONE representation among the set,
 *    NEVER required: it participates only when BOTH a binding exists
 *    AND the adapter is explicitly enabled (fail-closed otherwise,
 *    never a universal dependency);
 *  - the frozen per-representation RANK TRIPLE (context cost,
 *    orchestration cost, failure surface) — the deterministic,
 *    recorded preference evidence for the canonical selection order;
 *  - `SELECTION_ORDER` — the canonical representation preference order
 *    (lexicographic over the rank triple, then the representation id):
 *    the first admissible representation in this order is selected for
 *    every need — no negotiation, no scoring, no ambient input;
 *  - `REPRESENTATION_PRECONDITION_CODES` / `TOOL_SURFACE_INVARIANT_CODES`
 *    — the closed, typed, bounded vocabularies of per-representation
 *    selection rejections and derivation-level fail-closed errors;
 *  - `ToolSurfaceConfig` — the bounded, caller-provided configuration:
 *    per-tool materializable representation bindings (the DATA the
 *    selection conditions on) + the MCP adapter enablement + the
 *    programmatic-execution availability. The catalog is DATA ONLY:
 *    decisions remain compiler/seam-owned (no tool-routing authority
 *    exists here — architecture invariant 8).
 *
 * Determinism (architecture invariant 7): every value in this plane is
 * a pure function of its inputs. No clock, no randomness, no ambient
 * state, no I/O.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";

// ---------------------------------------------------------------------------
// The closed representation set (ADR-0019 §5)
// ---------------------------------------------------------------------------

/**
 * The seven tool representations, exactly as ADR-0019 §5 names them.
 * The vocabulary is CLOSED: `deriveToolSurface` selects from exactly
 * these, `validateToolSurface` rejects any other, and the architecture
 * boundary tests pin the set against the ADR text.
 */
export const TOOL_REPRESENTATIONS = [
  "direct",
  "deferred",
  "cli",
  "script",
  "code",
  "mcp",
  "competence",
] as const;
export type ToolRepresentation = (typeof TOOL_REPRESENTATIONS)[number];

export function isToolRepresentation(value: unknown): value is ToolRepresentation {
  return typeof value === "string" && (TOOL_REPRESENTATIONS as readonly string[]).includes(value);
}

/**
 * The frozen per-representation rank triple — the recorded, deterministic
 * preference evidence (lower is better; the ranks are frozen DATA, never
 * tuned at runtime):
 *
 *  - contextCost: how much model/plan context the representation consumes
 *    upfront (typed schema → reference → API call → argv marshalling →
 *    script content → protocol session + tool listing → runtime discovery);
 *  - orchestrationCost: how much orchestration machinery stands between
 *    the plan and the tool (none → proven artifact → import → argv →
 *    script materialization → adapter session → discovery round-trip);
 *  - failureSurface: how many distinct failure modes the representation
 *    adds (typed validation → evidence-bound reference → code binding →
 *    process exit → script drift → adapter protocol → discovery miss).
 */
export interface RepresentationRanks {
  readonly contextCost: number;
  readonly orchestrationCost: number;
  readonly failureSurface: number;
}

const REPRESENTATION_RANKS: Readonly<Record<ToolRepresentation, RepresentationRanks>> = {
  direct: { contextCost: 0, orchestrationCost: 0, failureSurface: 0 },
  competence: { contextCost: 1, orchestrationCost: 0, failureSurface: 1 },
  code: { contextCost: 2, orchestrationCost: 1, failureSurface: 2 },
  cli: { contextCost: 3, orchestrationCost: 2, failureSurface: 3 },
  script: { contextCost: 4, orchestrationCost: 3, failureSurface: 4 },
  mcp: { contextCost: 5, orchestrationCost: 4, failureSurface: 5 },
  deferred: { contextCost: 6, orchestrationCost: 5, failureSurface: 6 },
};

export function representationRanks(representation: ToolRepresentation): RepresentationRanks {
  return REPRESENTATION_RANKS[representation];
}

/**
 * The canonical selection order: lexicographic over the rank triple,
 * then the representation id — fully deterministic, fully recorded.
 * Derivation always selects the FIRST ADMISSIBLE representation in
 * this order for a need; the order never depends on the environment.
 */
export const SELECTION_ORDER: readonly ToolRepresentation[] = [...TOOL_REPRESENTATIONS]
  .map((representation) => ({
    representation,
    ranks: REPRESENTATION_RANKS[representation],
  }))
  .sort(
    (a, b) =>
      a.ranks.contextCost - b.ranks.contextCost ||
      a.ranks.orchestrationCost - b.ranks.orchestrationCost ||
      a.ranks.failureSurface - b.ranks.failureSurface ||
      (a.representation < b.representation ? -1 : a.representation > b.representation ? 1 : 0),
  )
  .map((entry) => entry.representation);

/** The canonical selection-order basis recorded on every binding. */
export const SELECTION_ORDER_BASIS = `first-admissible-in-canonical-order(${SELECTION_ORDER.join(
  ">",
)})`;

// ---------------------------------------------------------------------------
// Closed vocabularies: precondition codes + invariant codes
// ---------------------------------------------------------------------------

/**
 * The closed per-representation selection-rejection vocabulary. Exactly
 * one code is recorded per NON-SELECTED representation (bounded evidence;
 * nothing is silently skipped):
 *
 *  - `binding-absent` — the configuration carries no binding of this
 *    representation for the tool (the representation is not
 *    materializable for this need);
 *  - `mcp-adapter-disabled` — an MCP binding exists but the MCP adapter
 *    is not enabled in the configuration (MCP is never required: the
 *    selection moves on to the next representation);
 *  - `lower-canonical-rank` — the representation is admissible but
 *    ranked AFTER the selected one in the canonical selection order
 *    (an admissible representation is never "rejected" — it lost the
 *    deterministic preference, which is itself recorded evidence).
 */
export const REPRESENTATION_PRECONDITION_CODES = [
  "binding-absent",
  "mcp-adapter-disabled",
  "lower-canonical-rank",
] as const;
export type RepresentationPreconditionCode = (typeof REPRESENTATION_PRECONDITION_CODES)[number];

export function isRepresentationPreconditionCode(
  value: unknown,
): value is RepresentationPreconditionCode {
  return (
    typeof value === "string" &&
    (REPRESENTATION_PRECONDITION_CODES as readonly string[]).includes(value)
  );
}

/**
 * The closed derivation-level invariant vocabulary (typed, bounded,
 * fail-closed). Every derivation failure names exactly one code:
 *
 *  - `surface-config` — the tool-surface configuration is invalid;
 *  - `need-shape` — an extracted tool need is structurally invalid
 *    (e.g. a call-tool step without a capability-bound tool identity);
 *  - `capability-condition` — a need's tool capability is unsatisfied
 *    in the governing capability facts (fail closed; the derivation can
 *    never widen, grant or bypass a capability);
 *  - `policy-condition` — a need's tool is denied by the governing
 *    policy tool restrictions (fail closed; no representation may
 *    bypass policy);
 *  - `no-admissible-representation` — no representation is
 *    materializable for a need (all seven rejected with recorded codes);
 *  - `programmatic-spec` — a plan-declared programmatic spec is invalid
 *    (closed vocabulary/bounds violated — never silently degraded);
 *  - `surface-shape` — a tool-surface value failed validation;
 *  - `surface-identity-mismatch` — the surface content does not digest
 *    to the claimed `surfaceId`;
 *  - `surface-provenance` — the surface provenance is outside the
 *    closed vocabulary;
 *  - `surface-non-minimal` — the surface carries bindings beyond the
 *    plan's declared tool needs (minimality is proven, not claimed);
 *  - `derivation-mismatch` — a deterministic re-derivation produced a
 *    different surface (drift detected).
 */
export const TOOL_SURFACE_INVARIANT_CODES = [
  "surface-config",
  "need-shape",
  "capability-condition",
  "policy-condition",
  "no-admissible-representation",
  "programmatic-spec",
  "surface-shape",
  "surface-identity-mismatch",
  "surface-provenance",
  "surface-non-minimal",
  "derivation-mismatch",
] as const;
export type ToolSurfaceInvariantCode = (typeof TOOL_SURFACE_INVARIANT_CODES)[number];

const DETAIL_LIMIT = 200;

function boundedDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/**
 * The typed, bounded tool-surface error. `invariant` names the closed
 * vocabulary code; `details` carries only bounded scalar evidence
 * (payloads are never echoed wholesale).
 */
export class ToolSurfaceError extends Error {
  readonly invariant: ToolSurfaceInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: ToolSurfaceInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "ToolSurfaceError";
    this.invariant = invariant;
    const bounded: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        bounded[key] = typeof value === "string" ? boundedDetail(value) : value;
      }
    }
    this.details = Object.freeze(bounded);
  }
}

export function rejectSurface(
  invariant: ToolSurfaceInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new ToolSurfaceError(invariant, message, details);
}

// ---------------------------------------------------------------------------
// The tool-surface configuration (bounded, caller-provided DATA)
// ---------------------------------------------------------------------------

/**
 * The per-tool materializable representations. Each present key is the
 * DATA FACT that this representation is materializable for the tool,
 * with the bounded materialization reference the surface records.
 * A binding with ZERO representations is shape-invalid (a binding
 * exists to make at least one representation available).
 */
export interface ToolRepresentationBinding {
  readonly toolId: string;
  readonly representations: {
    /** A registered typed tool contract exists (schema-bound I/O). */
    readonly direct?: { readonly typed: true };
    /** The tool is discoverable through the deferred tool catalog. */
    readonly deferred?: { readonly discoverable: true };
    /** A CLI command binding exists. */
    readonly cli?: { readonly command: string };
    /** A script artifact binding exists. */
    readonly script?: { readonly scriptRef: string };
    /** A code API binding exists. */
    readonly code?: { readonly api: string };
    /** An MCP adapter binding exists (participates ONLY when enabled). */
    readonly mcp?: { readonly server: string };
    /** A verified competence reference binding exists. */
    readonly competence?: { readonly competenceRef: string };
  };
}

/** Hard bounds on the configuration (bounded data, fail-closed). */
export const TOOL_SURFACE_CONFIG_BOUNDS = {
  maxBindings: 64,
  maxBindingRefLength: 200,
} as const;

export interface ToolSurfaceConfig {
  readonly configSchema: 1;
  /**
   * MCP adapter enablement. FALSE by construction when absent: MCP is
   * ONE representation among the closed set and is NEVER required — an
   * mcp binding with the adapter disabled records a typed rejection and
   * the selection moves on (no universal MCP dependency).
   */
  readonly mcpEnabled: boolean;
  /**
   * Bounded programmatic-execution availability. When false, declared
   * mechanical work is recorded as `disabled` (an honest decision, not
   * a silent degradation); the plan still executes through its normal
   * path.
   */
  readonly programmaticEnabled: boolean;
  readonly bindings: readonly ToolRepresentationBinding[];
}

const TOOL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBindingRef(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    rejectSurface("surface-config", `${what} must be a non-empty string`, {
      got: boundedDetail(value),
    });
  }
  if (value.length > TOOL_SURFACE_CONFIG_BOUNDS.maxBindingRefLength) {
    rejectSurface("surface-config", `${what} exceeds the bounded reference length`, {
      length: value.length,
      max: TOOL_SURFACE_CONFIG_BOUNDS.maxBindingRefLength,
    });
  }
  if (/[\r\n\0]/.test(value)) {
    rejectSurface("surface-config", `${what} must not carry control characters`);
  }
  return value;
}

/**
 * Total, deterministic validation of a tool-surface configuration.
 * Fail-closed on: wrong schema, unbounded binding count, malformed or
 * duplicate tool ids, zero-representation bindings, malformed
 * materialization references, unknown representation keys.
 */
export function validateToolSurfaceConfig(value: unknown): ToolSurfaceConfig {
  if (!isRecord(value)) {
    rejectSurface("surface-config", "the tool-surface configuration must be an object");
  }
  if (value.configSchema !== 1) {
    rejectSurface("surface-config", "the tool-surface configuration schema must be 1", {
      got: boundedDetail(value.configSchema),
    });
  }
  if (typeof value.mcpEnabled !== "boolean") {
    rejectSurface("surface-config", "mcpEnabled must be a boolean");
  }
  if (typeof value.programmaticEnabled !== "boolean") {
    rejectSurface("surface-config", "programmaticEnabled must be a boolean");
  }
  if (!Array.isArray(value.bindings)) {
    rejectSurface("surface-config", "bindings must be an array");
  }
  if (value.bindings.length > TOOL_SURFACE_CONFIG_BOUNDS.maxBindings) {
    rejectSurface("surface-config", "the binding set exceeds the bounded size", {
      count: value.bindings.length,
      max: TOOL_SURFACE_CONFIG_BOUNDS.maxBindings,
    });
  }
  const seen = new Set<string>();
  const bindings: ToolRepresentationBinding[] = [];
  for (const entry of value.bindings) {
    if (!isRecord(entry)) {
      rejectSurface("surface-config", "each binding must be an object");
    }
    if (typeof entry.toolId !== "string" || !TOOL_ID.test(entry.toolId)) {
      rejectSurface("surface-config", "binding toolId must be a lowercase tool slug", {
        got: boundedDetail(entry.toolId),
      });
    }
    if (seen.has(entry.toolId)) {
      rejectSurface("surface-config", "binding tool ids must be unique", {
        toolId: boundedDetail(entry.toolId),
      });
    }
    seen.add(entry.toolId);
    if (!isRecord(entry.representations)) {
      rejectSurface(
        "surface-config",
        `binding for ${entry.toolId} requires a representations object`,
      );
    }
    const reps = entry.representations;
    let count = 0;
    const representations: {
      direct?: { typed: true };
      deferred?: { discoverable: true };
      cli?: { command: string };
      script?: { scriptRef: string };
      code?: { api: string };
      mcp?: { server: string };
      competence?: { competenceRef: string };
    } = {};
    if (reps.direct !== undefined) {
      if (!isRecord(reps.direct) || reps.direct.typed !== true) {
        rejectSurface("surface-config", `binding ${entry.toolId} direct must be {typed: true}`);
      }
      representations.direct = { typed: true };
      count += 1;
    }
    if (reps.deferred !== undefined) {
      if (!isRecord(reps.deferred) || reps.deferred.discoverable !== true) {
        rejectSurface(
          "surface-config",
          `binding ${entry.toolId} deferred must be {discoverable: true}`,
        );
      }
      representations.deferred = { discoverable: true };
      count += 1;
    }
    if (reps.cli !== undefined) {
      if (!isRecord(reps.cli)) {
        rejectSurface("surface-config", `binding ${entry.toolId} cli must be an object`);
      }
      representations.cli = { command: validateBindingRef(reps.cli.command, "cli.command") };
      count += 1;
    }
    if (reps.script !== undefined) {
      if (!isRecord(reps.script)) {
        rejectSurface("surface-config", `binding ${entry.toolId} script must be an object`);
      }
      representations.script = {
        scriptRef: validateBindingRef(reps.script.scriptRef, "script.scriptRef"),
      };
      count += 1;
    }
    if (reps.code !== undefined) {
      if (!isRecord(reps.code)) {
        rejectSurface("surface-config", `binding ${entry.toolId} code must be an object`);
      }
      representations.code = { api: validateBindingRef(reps.code.api, "code.api") };
      count += 1;
    }
    if (reps.mcp !== undefined) {
      if (!isRecord(reps.mcp)) {
        rejectSurface("surface-config", `binding ${entry.toolId} mcp must be an object`);
      }
      representations.mcp = { server: validateBindingRef(reps.mcp.server, "mcp.server") };
      count += 1;
    }
    if (reps.competence !== undefined) {
      if (!isRecord(reps.competence)) {
        rejectSurface("surface-config", `binding ${entry.toolId} competence must be an object`);
      }
      representations.competence = {
        competenceRef: validateBindingRef(
          reps.competence.competenceRef,
          "competence.competenceRef",
        ),
      };
      count += 1;
    }
    if (count === 0) {
      rejectSurface("surface-config", `binding ${entry.toolId} carries zero representations`, {
        toolId: boundedDetail(entry.toolId),
      });
    }
    // Any key outside the closed representation vocabulary is rejected
    // (a binding shape the catalog cannot interpret is fail-closed).
    const legal = new Set<string>(TOOL_REPRESENTATIONS);
    for (const key of Object.keys(reps)) {
      if (!legal.has(key)) {
        rejectSurface(
          "surface-config",
          `binding ${entry.toolId} carries an unknown representation`,
          {
            representation: boundedDetail(key),
          },
        );
      }
    }
    bindings.push({ toolId: entry.toolId, representations });
  }
  return {
    configSchema: 1,
    mcpEnabled: value.mcpEnabled,
    programmaticEnabled: value.programmaticEnabled,
    bindings,
  };
}

// ---------------------------------------------------------------------------
// Read-only capability/policy conditioning helpers (constraint mirrors)
// ---------------------------------------------------------------------------

/**
 * The read-only capability facts derived from the governing constraint
 * set: exactly the satisfied/unmet capability ids the capability
 * authority produced at planning time (mirrored through the WORK-049
 * constraint contract — never re-derived, never widened here).
 */
export interface CapabilityConditioningFacts {
  readonly satisfiedIds: ReadonlySet<string>;
  readonly unmetIds: ReadonlySet<string>;
  /** True when at least one capability constraint was given. */
  readonly present: boolean;
}

/**
 * Read the capability conditioning facts from the governing constraint
 * set (READ-ONLY consultation: the constraints are input values; this
 * function never mutates them and can never widen, grant or bypass a
 * capability — it only READS what the capability authority captured).
 */
export function capabilityFactsFromConstraints(
  constraints: readonly OptimizationConstraint[],
): CapabilityConditioningFacts {
  const satisfiedIds = new Set<string>();
  const unmetIds = new Set<string>();
  let present = false;
  for (const constraint of constraints) {
    if (constraint.kind !== "capability") {
      continue;
    }
    present = true;
    const payload = constraint.payload as { satisfiedIds?: unknown; unmetIds?: unknown };
    if (Array.isArray(payload.satisfiedIds)) {
      for (const id of payload.satisfiedIds) {
        if (typeof id === "string") {
          satisfiedIds.add(id);
        }
      }
    }
    if (Array.isArray(payload.unmetIds)) {
      for (const id of payload.unmetIds) {
        if (typeof id === "string") {
          unmetIds.add(id);
        }
      }
    }
  }
  return { satisfiedIds, unmetIds, present };
}

/**
 * The read-only policy tool-eligibility view over the governing
 * constraint set: the union of the tool allow/deny lists across the
 * policy-sourced constraints (mirrors the planner's own composition
 * policy semantics: no allowlist ⇒ allowed; a non-empty allowlist
 * excludes unlisted tools; a denylist always denies).
 */
export interface PolicyToolFacts {
  readonly allowedTools: ReadonlySet<string>;
  readonly deniedTools: ReadonlySet<string>;
  readonly present: boolean;
}

export function policyToolFactsFromConstraints(
  constraints: readonly OptimizationConstraint[],
): PolicyToolFacts {
  const allowedTools = new Set<string>();
  const deniedTools = new Set<string>();
  let present = false;
  for (const constraint of constraints) {
    if (constraint.kind !== "policy") {
      continue;
    }
    const payload = constraint.payload as {
      tool?: { allowedTools?: unknown; deniedTools?: unknown };
    };
    if (payload.tool === undefined) {
      continue;
    }
    present = true;
    if (Array.isArray(payload.tool.allowedTools)) {
      for (const id of payload.tool.allowedTools) {
        if (typeof id === "string") {
          allowedTools.add(id);
        }
      }
    }
    if (Array.isArray(payload.tool.deniedTools)) {
      for (const id of payload.tool.deniedTools) {
        if (typeof id === "string") {
          deniedTools.add(id);
        }
      }
    }
  }
  return { allowedTools, deniedTools, present };
}

/**
 * The tool-eligibility verdict under the planner's own composition
 * semantics (READ-ONLY: decided exactly by the given policy facts).
 */
export function toolAllowedByPolicyFacts(
  toolId: string,
  facts: PolicyToolFacts,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (facts.deniedTools.has(toolId)) {
    return { allowed: false, reason: "the tool is denied by the governing policy restriction set" };
  }
  if (facts.allowedTools.size > 0 && !facts.allowedTools.has(toolId)) {
    return {
      allowed: false,
      reason: "the tool is outside the governing policy tool allowlist",
    };
  }
  return { allowed: true };
}
