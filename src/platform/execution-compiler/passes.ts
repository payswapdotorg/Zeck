/**
 * The transformation catalog implementations (platform
 * execution-compiler plane; WORK-050 / E1.1 charter stage 2).
 *
 * Every transformation is a PURE function of (variant, constraints,
 * digest): deterministic, idempotent under re-application guards, and
 * running under EXPLICIT PRECONDITIONS — each application site whose
 * preconditions do not hold records exactly one typed rejection code
 * (the closed `PRECONDITION_CHECK_CODES` vocabulary) and is NEVER
 * applied (fail closed per site). Structural transformations
 * (constant folding, dead-step elimination, CSE, verification anchor
 * materialization) and annotation transformations (memoization hooks,
 * safe parallelization, batching, result shaping, subgraph
 * decomposition, retry normalization, representation-ladder hooks —
 * hooks only, never live selection) all evolve the variant toward its
 * optimized form; the pipeline validates and proves equivalence after
 * every application.
 *
 * Semantics preservation, per pass, by construction:
 *
 *  - constant folding: replaces a statically-foldable pure step with a
 *    `retrieve` step carrying the EXACT closed-evaluator result
 *    (operation + inputs recorded verbatim alongside it — the unfold
 *    is mechanical). The core normalizes both forms to the same
 *    evaluated contribution;
 *  - dead-step elimination: removes only provably-pure,
 *    deterministic steps with no path to any observable point;
 *  - CSE: merges only structurally-identical deterministic
 *    value-pure steps with identical predecessor sets and NO shared
 *    successor (arity-preserving re-pointing);
 *  - verification insertion: materializes a TERMINAL step-level
 *    verification anchor into an explicit verify step carrying the
 *    strategy VERBATIM (never invented, never redefined — the
 *    verification authority owns it);
 *  - retry normalization: projects the canonical bounded retry
 *    parameters (verbatim values) as an annotation; an unbounded or
 *    nonconforming retry config is REJECTED (typed), never silently
 *    blessed;
 *  - every annotation pass: adds only the reserved compiler
 *    annotation key (never clobbering plan-owned config) and changes
 *    no plan-semantic field.
 */

import { canonicalJson } from "../execution-ir/canonical";
import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { IrDigestPort } from "../execution-ir/ir";
import type { CompilerPassId, PreconditionCheckCode } from "./catalog";
import { COMPILER_PASS_IDS, CompilerError } from "./catalog";
import {
  areMutuallyIndependent,
  COMPILER_ANNOTATION_KEY,
  evaluateFold,
  FOLDED_CONSTANT_KEY,
  indexVariant,
  parseFoldExpression,
  provablyDeadSteps,
  type VariantGraph,
} from "./semantics";
import type { IrVariantStep } from "./variant";
import { buildVariant, type ExecutionIrVariant, type VariantStepMaterial } from "./variant";

// ---------------------------------------------------------------------------
// Pass application contracts
// ---------------------------------------------------------------------------

/** One recorded per-site rejection (typed, bounded evidence). */
export interface SiteRejection {
  readonly check: PreconditionCheckCode;
  readonly stepId: string;
  readonly detail: string;
}

/** The bounded outcome of one pass application over one variant. */
export interface PassOutcome {
  readonly passId: CompilerPassId;
  readonly status: "applied" | "noop";
  /** The evolved variant (identical object when status is noop). */
  readonly output: ExecutionIrVariant;
  readonly sitesConsidered: number;
  readonly sitesApplied: number;
  readonly rejections: readonly SiteRejection[];
}

/** Everything a pass needs (pure inputs only). */
export interface PassInput {
  readonly variant: ExecutionIrVariant;
  readonly constraints: readonly OptimizationConstraint[];
  readonly digest: IrDigestPort;
  /** The accumulated pass-trace digest (provenance chaining). */
  readonly traceDigest: string;
}

const DETAIL_MAX = 300;

function siteDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/** Deterministic 12-hex id fragment from content (collision-checked). */
function stableIdFragment(seed: string, digest: IrDigestPort, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const hash = digest.sha256Hex(canonicalJson({ seed, attempt })).slice(0, 12);
    const candidate = `zc-${hash}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  // Deterministic exhaustion fallback (bounded): extend with the full
  // digest. Practically unreachable (2^48 space per attempt).
  return `zc-${digest.sha256Hex(seed).slice(0, 24)}`;
}

/**
 * Does this step's config already carry a blocking annotation for THIS
 * pass? Two rejection cases, both fail-closed:
 *
 *  - the config carries the reserved compiler-annotation key with
 *    PLAN-AUTHORED content (a non-object value, or an object holding
 *    any key outside the closed pass catalog): the compiler never
 *    touches plan-owned config — the site is rejected by EVERY pass;
 *  - the value is a compiler-stacked annotation map (all keys are pass
 *    ids) that already contains THIS pass's key: the per-pass
 *    idempotence guard (different passes may stack; a pass never
 *    re-applies over its own).
 */
function hasAnnotation(step: IrVariantStep, passId: CompilerPassId): boolean {
  if (step.config === undefined || !Object.hasOwn(step.config, COMPILER_ANNOTATION_KEY)) {
    return false;
  }
  const annotationMap = step.config[COMPILER_ANNOTATION_KEY];
  if (typeof annotationMap !== "object" || annotationMap === null || Array.isArray(annotationMap)) {
    return true;
  }
  const keys = Object.keys(annotationMap as Record<string, unknown>);
  const planAuthored = keys.some((key) => !(COMPILER_PASS_IDS as readonly string[]).includes(key));
  if (planAuthored) {
    return true;
  }
  return keys.includes(passId);
}

/** Annotate a step's config under the reserved key (order-stable). */
function annotateStep(
  step: IrVariantStep,
  passId: CompilerPassId,
  annotation: Record<string, unknown>,
): VariantStepMaterial {
  const existing = step.config ?? {};
  const prior = Object.hasOwn(existing, COMPILER_ANNOTATION_KEY)
    ? (existing[COMPILER_ANNOTATION_KEY] as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...prior, [passId]: annotation };
  return {
    id: step.id,
    stepClass: step.stepClass,
    ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
    ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
    config: { ...existing, [COMPILER_ANNOTATION_KEY]: merged },
    ...(step.verificationStrategy === undefined
      ? {}
      : { verificationStrategy: step.verificationStrategy }),
  };
}

/** The pass-trace digest extension (deterministic chaining). */
function extendTrace(
  traceDigest: string,
  record: Record<string, unknown>,
  digest: IrDigestPort,
): string {
  return digest.sha256Hex(canonicalJson({ prior: traceDigest, record }));
}

// ---------------------------------------------------------------------------
// Pass 1 — constant folding
// ---------------------------------------------------------------------------

const FOLDABLE_CLASSES: readonly IrVariantStep["stepClass"][] = [
  "transform",
  "run-algorithm",
  "compare",
];

/**
 * Constant folding: a statically-foldable step (pure-deterministic
 * class, no capability binding, no route, no verification strategy,
 * config an exact closed-expression shape the evaluator fully
 * understands) is replaced IN PLACE by a `retrieve` step carrying the
 * folded constant with the full unfold record (operation + inputs,
 * verbatim). Precondition failures are typed per-site rejections.
 */
export function applyConstantFolding(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;
  let considered = 0;

  for (const step of variant.steps) {
    considered += 1;
    if (!FOLDABLE_CLASSES.includes(step.stepClass)) {
      steps.push(step);
      continue;
    }
    if (step.capabilityId !== undefined) {
      rejections.push({
        check: "fold-capability-bound",
        stepId: step.id,
        detail: siteDetail("capability-bound steps' semantics are the capability authority's"),
      });
      steps.push(step);
      continue;
    }
    if (step.routeRef !== undefined) {
      rejections.push({
        check: "fold-route-bound",
        stepId: step.id,
        detail: siteDetail("steps carrying routes are not statically foldable"),
      });
      steps.push(step);
      continue;
    }
    if (step.verificationStrategy !== undefined) {
      rejections.push({
        check: "fold-strategy-bound",
        stepId: step.id,
        detail: siteDetail("verification-anchored steps are never folded (anchor preserved)"),
      });
      steps.push(step);
      continue;
    }
    let expression: ReturnType<typeof parseFoldExpression> = null;
    try {
      expression = parseFoldExpression(step.config);
    } catch (error) {
      rejections.push({
        check: "fold-input-unbounded",
        stepId: step.id,
        detail: siteDetail(String(error)),
      });
      steps.push(step);
      continue;
    }
    if (expression === null) {
      rejections.push({
        check: "fold-config-unparseable",
        stepId: step.id,
        detail: siteDetail("config is not a closed static fold expression"),
      });
      steps.push(step);
      continue;
    }
    let value: unknown;
    try {
      value = evaluateFold(expression.operation, expression.inputs, expression.fields);
    } catch (error) {
      rejections.push({
        check: "fold-input-unbounded",
        stepId: step.id,
        detail: siteDetail(String(error)),
      });
      steps.push(step);
      continue;
    }
    // The folded step: the precomputed constant plus the verbatim
    // unfold record (mechanically replayable equivalence evidence).
    steps.push({
      id: step.id,
      stepClass: "retrieve",
      config: {
        [FOLDED_CONSTANT_KEY]: {
          foldedFrom: step.stepClass,
          operation: expression.operation,
          ...(expression.fields === undefined ? {} : { fields: expression.fields }),
          inputs: expression.inputs,
          result: value,
        },
      },
    });
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "constant-folding",
      status: "noop",
      output: variant,
      sitesConsidered: considered,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "constant-folding", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "constant-folding",
    status: "applied",
    output,
    sitesConsidered: considered,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 — dead-step elimination
// ---------------------------------------------------------------------------

/**
 * Dead-step elimination: removes exactly the steps that are provably
 * pure, deterministic, unanchored and non-observable under the GOVERNING
 * observability contract — the constraint-conditioned reading (pure
 * unanchored terminal values are non-observable only when the governing
 * constraints carry the verification-anchor completion binding; without
 * it, terminal outputs are observable and the pass is a conservative
 * no-op). Anything not eliminable is a typed per-site rejection. The
 * elimination NEVER empties the plan (a would-empty elimination is
 * rejected as inadmissible — the variant requires ≥1 step).
 */
export function applyDeadStepElimination(input: PassInput): PassOutcome {
  const { variant, constraints, digest, traceDigest } = input;
  // The governing observability contract: is the frozen verification
  // completion binding ACTIVE in the governing constraint set? (A pure
  // function of the constraints — the pass's precondition input.)
  const verificationAnchorRequired = constraints.some(
    (constraint) =>
      constraint.kind === "verification" &&
      constraint.enforcement === "hard" &&
      (constraint.payload as { requiresVerificationAnchor?: boolean })
        .requiresVerificationAnchor === true,
  );
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const survivors: VariantStepMaterial[] = [];
  let applied = 0;
  // The provably-dead set under the governing contract (computed once).
  const dead = provablyDeadSteps(graph, verificationAnchorRequired);

  for (const step of variant.steps) {
    // An elimination candidate: pure + deterministic + unanchored.
    // Anything else is observable and always survives (recorded with
    // its typed reason — bounded per-site evidence, never silent).
    const candidate =
      step.sideEffectClass === "pure" &&
      step.computationType === "deterministic" &&
      step.verificationStrategy === undefined &&
      step.stepClass !== "verify";
    if (!candidate) {
      rejections.push({
        check: "dead-step-side-effecting",
        stepId: step.id,
        detail: siteDetail(
          `side-effect class ${step.sideEffectClass} / computation ${step.computationType}${step.verificationStrategy !== undefined ? " / verification-anchored" : ""} is observable`,
        ),
      });
      survivors.push(step);
      continue;
    }
    if (dead.has(step.id)) {
      applied += 1;
      continue;
    }
    rejections.push({
      check: "dead-step-reachable",
      stepId: step.id,
      detail: siteDetail(
        verificationAnchorRequired
          ? "the step is itself observable (terminal output or verification/effect/human point) or contributes transitively to one"
          : "terminal outputs are observable while no verification-anchor binding is active (the conservative reading)",
      ),
    });
    survivors.push(step);
  }

  // The would-empty guard: an elimination that removes EVERY step is
  // inadmissible (the variant requires at least one step — and a plan
  // whose every observable point is eliminable is constraint-inadmissible
  // anyway; the decision builder owns that rejection).
  if (applied > 0 && survivors.length === 0) {
    return {
      passId: "dead-step-elimination",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections: [
        ...rejections,
        ...variant.steps.map((step) => ({
          check: "dead-step-side-effecting" as const,
          stepId: step.id,
          detail: siteDetail(
            "the elimination would empty the plan (inadmissible — the variant requires at least one observable step)",
          ),
        })),
      ],
    };
  }

  if (applied === 0) {
    return {
      passId: "dead-step-elimination",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const removedIds = new Set(
    variant.steps.map((step) => step.id).filter((id) => !survivors.some((s) => s.id === id)),
  );
  const edges = variant.edges.filter(
    (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
  );
  const output = buildVariant(
    {
      source: variant,
      steps: survivors,
      edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "dead-step-elimination", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "dead-step-elimination",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 3 — common-subexpression reuse
// ---------------------------------------------------------------------------

interface CseClass {
  readonly key: string;
  readonly members: readonly IrVariantStep[];
}

/**
 * Common-subexpression reuse: merges structurally-identical
 * deterministic value-pure steps (identical class, capability, route,
 * canonical config and identical predecessor sets) that share NO
 * successor. The survivor is the member with the smallest id
 * (deterministic); successors of the removed duplicates are re-pointed
 * to the survivor. Arity is preserved by the no-shared-successor
 * precondition.
 */
export function applyCommonSubexpressionReuse(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const considered = variant.steps.length;

  // Candidate eligibility per step.
  const eligible = new Map<string, IrVariantStep>();
  for (const step of variant.steps) {
    if (step.stepClass === "verify") {
      rejections.push({
        check: "cse-verification-step",
        stepId: step.id,
        detail: siteDetail("verification steps are individually observable evidence"),
      });
      continue;
    }
    if (step.computationType !== "deterministic") {
      rejections.push({
        check: "cse-step-not-deterministic",
        stepId: step.id,
        detail: siteDetail("probabilistic steps are never merged (independent sampling)"),
      });
      continue;
    }
    if (step.sideEffectClass !== "pure" && step.sideEffectClass !== "sandboxed-compute") {
      rejections.push({
        check: "cse-step-not-value-pure",
        stepId: step.id,
        detail: siteDetail(`side-effect class ${step.sideEffectClass} is not value-pure`),
      });
      continue;
    }
    eligible.set(step.id, step);
  }

  // Group by structural identity: class + capability + route + config
  // (annotations stripped — never merged on annotations) + sorted
  // predecessor id set.
  const byPredKey = new Map<string, string[]>();
  for (const step of eligible.values()) {
    const preds = (graph.predecessors.get(step.id) ?? []).map((p) => p.id).sort();
    byPredKey.set(step.id, preds);
  }
  const classes = new Map<string, IrVariantStep[]>();
  for (const step of eligible.values()) {
    const key = canonicalJson({
      cls: step.stepClass,
      cap: step.capabilityId ?? null,
      route: step.routeRef ?? null,
      ...cfgFragment(step.config),
      preds: byPredKey.get(step.id) ?? [],
    });
    const bucket = classes.get(key) ?? [];
    bucket.push(step);
    classes.set(key, bucket);
  }

  const duplicateClasses: CseClass[] = [];
  for (const [key, members] of classes) {
    if (members.length < 2) {
      continue;
    }
    // No shared successor among the members (arity preservation).
    const successorOwners = new Map<string, string>();
    let shared = false;
    for (const member of [...members].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      for (const succ of graph.successors.get(member.id) ?? []) {
        const owner = successorOwners.get(succ.id);
        if (owner !== undefined && owner !== member.id) {
          shared = true;
          rejections.push({
            check: "cse-shared-successor",
            stepId: member.id,
            detail: siteDetail(`successor ${succ.id} is shared with ${owner}`),
          });
          break;
        }
        successorOwners.set(succ.id, member.id);
      }
      if (shared) {
        break;
      }
    }
    if (!shared) {
      duplicateClasses.push({ key, members });
    }
  }

  if (duplicateClasses.length === 0) {
    return {
      passId: "common-subexpression-reuse",
      status: "noop",
      output: variant,
      sitesConsidered: considered,
      sitesApplied: 0,
      rejections,
    };
  }

  const survivorByMember = new Map<string, string>();
  for (const cls of duplicateClasses) {
    const ordered = [...cls.members].sort((a, b) => (a.id < b.id ? -1 : 1));
    const survivor = ordered[0] as IrVariantStep;
    for (const member of ordered.slice(1)) {
      survivorByMember.set(member.id, survivor.id);
    }
  }
  const removedIds = new Set(survivorByMember.keys());
  const steps: VariantStepMaterial[] = variant.steps
    .filter((step) => !removedIds.has(step.id))
    .map((step) => step);
  const edges = variant.edges
    .filter((edge) => !removedIds.has(edge.to))
    .map((edge) => {
      const substitute = survivorByMember.get(edge.from);
      return substitute === undefined ? edge : { from: substitute, to: edge.to };
    });
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          {
            passId: "common-subexpression-reuse",
            classesMerged: duplicateClasses.length,
            sitesApplied: survivorByMember.size,
          },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "common-subexpression-reuse",
    status: "applied",
    output,
    sitesConsidered: considered,
    sitesApplied: survivorByMember.size,
    rejections,
  };
}

function stripCompilerKeys(
  config: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (config === undefined) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== COMPILER_ANNOTATION_KEY && key !== FOLDED_CONSTANT_KEY) {
      out[key] = value;
    }
  }
  return out;
}

/** The canonical config fragment for grouping keys (never `undefined`-valued). */
function cfgFragment(
  config: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const stripped = stripCompilerKeys(config);
  return stripped === undefined ? {} : { cfg: stripped };
}

// ---------------------------------------------------------------------------
// Pass 4 — verification insertion (terminal anchor materialization)
// ---------------------------------------------------------------------------

/**
 * Verification insertion — terminal anchor materialization: a TERMINAL
 * step carrying a step-level verificationStrategy gets an explicit
 * `verify` step observing its output, carrying the strategy VERBATIM
 * (moved off the step). The anchor binding (position, strategy) is
 * preserved exactly — the core's anchor list is unchanged; the
 * compiler never invents, redefines or quality-gates a strategy
 * (VERIFICATION-SEPARATION).
 */
export function applyVerificationInsertion(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  const newEdges: { from: string; to: string }[] = [];
  let applied = 0;

  for (const step of variant.steps) {
    if (step.verificationStrategy === undefined) {
      steps.push(step);
      continue;
    }
    if (step.stepClass === "verify") {
      rejections.push({
        check: "anchor-step-is-verify",
        stepId: step.id,
        detail: siteDetail("an explicit verify step is already materialized"),
      });
      steps.push(step);
      continue;
    }
    if (graph.successors.get(step.id)?.length !== 0) {
      rejections.push({
        check: "anchor-step-not-terminal",
        stepId: step.id,
        detail: siteDetail(
          "materialization is provable only for terminal steps (non-terminal re-binding changes downstream dataflow)",
        ),
      });
      steps.push(step);
      continue;
    }
    // Materialize: strip the step-level strategy, insert an explicit
    // verify sink directly after the step (deterministic position).
    const materializedId = stableIdFragment(
      canonicalJson({
        anchored: step.id,
        strategy: step.verificationStrategy,
        source: variant.sourceIrId,
      }),
      digest,
      new Set(variant.steps.map((s) => s.id)),
    );
    steps.push({
      id: step.id,
      stepClass: step.stepClass,
      ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
      ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
      ...(step.config === undefined ? {} : { config: step.config }),
    });
    steps.push({
      id: materializedId,
      stepClass: "verify",
      verificationStrategy: step.verificationStrategy,
    });
    newEdges.push({ from: step.id, to: materializedId });
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "verification-insertion",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: [...variant.edges, ...newEdges],
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "verification-insertion", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "verification-insertion",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 5 — retry normalization
// ---------------------------------------------------------------------------

/** The canonical bounded retry-parameter universe (verbatim values). */
const RETRY_MAX_RETRIES = 16;
const RETRY_MAX_BACKOFF_MS = 600000;

/**
 * Retry normalization: projects the canonical bounded retry parameters
 * (retries ∈ [0, 16], backoffMs ∈ [0, 600000] — values copied
 * VERBATIM from the step's own config) as the uniform compiler
 * annotation surface later stages consume. A retry config outside the
 * canonical bounded universe is REJECTED with a typed code (never
 * silently blessed, never silently rewritten — the executor owns
 * retry semantics; the compiler only normalizes the recorded surface).
 */
export function applyRetryNormalization(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  for (const step of variant.steps) {
    if (step.stepClass !== "retry") {
      steps.push(step);
      continue;
    }
    if (hasAnnotation(step, "retry-normalization")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      steps.push(step);
      continue;
    }
    const config = step.config ?? {};
    const keys = Object.keys(config).sort();
    const known = keys.every((key) => key === "retries" || key === "backoffMs");
    if (!known) {
      rejections.push({
        check: "retry-config-non-canonical",
        stepId: step.id,
        detail: siteDetail(
          "retry config carries keys outside the canonical {retries, backoffMs} surface",
        ),
      });
      steps.push(step);
      continue;
    }
    const annotation: Record<string, unknown> = {};
    if (Object.hasOwn(config, "retries")) {
      const retries = config.retries;
      if (
        typeof retries !== "number" ||
        !Number.isInteger(retries) ||
        retries < 0 ||
        retries > RETRY_MAX_RETRIES
      ) {
        rejections.push({
          check: "retry-config-non-canonical",
          stepId: step.id,
          detail: siteDetail("retries is outside the bounded canonical range [0, 16]"),
        });
        steps.push(step);
        continue;
      }
      annotation.retries = retries;
    }
    if (Object.hasOwn(config, "backoffMs")) {
      const backoffMs = config.backoffMs;
      if (
        typeof backoffMs !== "number" ||
        !Number.isInteger(backoffMs) ||
        backoffMs < 0 ||
        backoffMs > RETRY_MAX_BACKOFF_MS
      ) {
        rejections.push({
          check: "retry-config-non-canonical",
          stepId: step.id,
          detail: siteDetail("backoffMs is outside the bounded canonical range [0, 600000]"),
        });
        steps.push(step);
        continue;
      }
      annotation.backoffMs = backoffMs;
    }
    steps.push(annotateStep(step, "retry-normalization", annotation));
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "retry-normalization",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "retry-normalization", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "retry-normalization",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 6 — safe parallelization
// ---------------------------------------------------------------------------

/** Classes eligible for compiler-proven parallel groups. */
const PARALLEL_ELIGIBLE_CLASSES: readonly IrVariantStep["stepClass"][] = [
  "retrieve",
  "transform",
  "run-program",
  "run-algorithm",
  "parallel",
  "branch",
  "compare",
  "call-model",
  "generate",
  "call-agent",
];

/**
 * Safe parallelization: identifies maximal groups of mutually
 * INDEPENDENT steps (pairwise unreachable, eligible classes — no
 * external effects, no verification, no human interaction) and
 * records the independence proof as an annotation group (id =
 * deterministic digest over the sorted member semantics). The runtime
 * may execute an annotated group concurrently — the compiler's
 * contribution is the PROOF, never the execution.
 */
export function applySafeParallelization(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  // Deterministic grouping: group steps by (class, capability, route,
  // canonical config) — maximal same-shape candidate groups; annotate
  // when the members are pairwise unreachable.
  const groups = new Map<string, IrVariantStep[]>();
  for (const step of variant.steps) {
    if (hasAnnotation(step, "safe-parallelization")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      continue;
    }
    if (!PARALLEL_ELIGIBLE_CLASSES.includes(step.stepClass)) {
      rejections.push({
        check: "parallel-class-excluded",
        stepId: step.id,
        detail: siteDetail(
          `class ${step.stepClass} is excluded from compiler-proven parallel groups (external effects, verification and human interaction order are not provable)`,
        ),
      });
      continue;
    }
    const key = canonicalJson({
      cls: step.stepClass,
      cap: step.capabilityId ?? null,
      route: step.routeRef ?? null,
      ...cfgFragment(step.config),
    });
    const bucket = groups.get(key) ?? [];
    bucket.push(step);
    groups.set(key, bucket);
  }

  const annotated = new Map<string, Record<string, unknown>>();
  for (const [, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (members.length < 2) {
      continue;
    }
    const ordered = [...members].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ids = ordered.map((step) => step.id);
    if (!areMutuallyIndependent(ids, graph)) {
      for (const step of ordered) {
        rejections.push({
          check: "parallel-dependency-exists",
          stepId: step.id,
          detail: siteDetail("group members are not pairwise unreachable (no independence proof)"),
        });
      }
      continue;
    }
    const groupId = digest
      .sha256Hex(
        canonicalJson({ kind: "parallel-group", members: ids, source: variant.sourceIrId }),
      )
      .slice(0, 16);
    const annotation = { group: groupId, members: ids };
    for (const step of ordered) {
      annotated.set(step.id, annotation);
    }
  }

  for (const step of variant.steps) {
    const annotation = annotated.get(step.id);
    if (annotation === undefined) {
      steps.push(step);
      continue;
    }
    steps.push(annotateStep(step, "safe-parallelization", annotation));
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "safe-parallelization",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "safe-parallelization", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "safe-parallelization",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 7 — batching
// ---------------------------------------------------------------------------

/** Classes eligible for compiler-annotated batch groups. */
const BATCH_ELIGIBLE_CLASSES: readonly IrVariantStep["stepClass"][] = [
  "transform",
  "run-algorithm",
];

/**
 * Batching: identifies homogeneous, mutually independent deterministic
 * steps (same class, same capability binding, pairwise unreachable)
 * and records the batch group as an annotation (the runtime may
 * vectorize; the compiler's contribution is the homogeneity +
 * independence proof). Generative steps are excluded — batching model
 * calls changes each item's context, which is NOT provably
 * semantics-preserving.
 */
export function applyBatching(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  const groups = new Map<string, IrVariantStep[]>();
  for (const step of variant.steps) {
    if (hasAnnotation(step, "batching")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      continue;
    }
    if (!BATCH_ELIGIBLE_CLASSES.includes(step.stepClass)) {
      rejections.push({
        check: "batch-class-excluded",
        stepId: step.id,
        detail: siteDetail(
          `class ${step.stepClass} is excluded from batch groups (generative context and external effects are not provably batchable)`,
        ),
      });
      continue;
    }
    if (step.computationType !== "deterministic") {
      rejections.push({
        check: "batch-class-excluded",
        stepId: step.id,
        detail: siteDetail("non-deterministic steps are excluded from batch groups"),
      });
      continue;
    }
    const key = canonicalJson({
      cls: step.stepClass,
      cap: step.capabilityId ?? null,
      ...cfgFragment(step.config),
    });
    const bucket = groups.get(key) ?? [];
    bucket.push(step);
    groups.set(key, bucket);
  }

  const annotated = new Map<string, Record<string, unknown>>();
  for (const [, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (members.length < 2) {
      continue;
    }
    const ordered = [...members].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ids = ordered.map((step) => step.id);
    if (!areMutuallyIndependent(ids, graph)) {
      for (const step of ordered) {
        rejections.push({
          check: "batch-dependency-exists",
          stepId: step.id,
          detail: siteDetail("group members are not pairwise unreachable (no independence proof)"),
        });
      }
      continue;
    }
    const groupId = digest
      .sha256Hex(canonicalJson({ kind: "batch-group", members: ids, source: variant.sourceIrId }))
      .slice(0, 16);
    const annotation = { group: groupId, members: ids };
    for (const step of ordered) {
      annotated.set(step.id, annotation);
    }
  }

  for (const step of variant.steps) {
    const annotation = annotated.get(step.id);
    if (annotation === undefined) {
      steps.push(step);
      continue;
    }
    steps.push(annotateStep(step, "batching", annotation));
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "batching",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "batching", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "batching",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 8 — memoization hooks
// ---------------------------------------------------------------------------

/**
 * Memoization hooks: annotates deterministic, non-verification,
 * non-human steps whose outputs are consumed downstream (or are
 * terminal) with a memoization hook key — the content digest of the
 * step's canonical semantics plus its predecessor identities. The hook
 * is a DECISION POINT for the cache planner (WORK-052); this compiler
 * implements no cache, holds no cache state, and never reuses results
 * itself.
 */
export function applyMemoizationHooks(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  for (const step of variant.steps) {
    if (step.computationType === "human") {
      rejections.push({
        check: "memo-human-step",
        stepId: step.id,
        detail: siteDetail("human interaction is never a memoization hook"),
      });
      steps.push(step);
      continue;
    }
    if (step.computationType !== "deterministic") {
      rejections.push({
        check: "memo-step-not-deterministic",
        stepId: step.id,
        detail: siteDetail("probabilistic steps are never memoization hooks"),
      });
      steps.push(step);
      continue;
    }
    if (step.stepClass === "verify" || step.verificationStrategy !== undefined) {
      rejections.push({
        check: "memo-verification-step",
        stepId: step.id,
        detail: siteDetail(
          "verification evidence is never a memoization hook (freshness is the verification authority's)",
        ),
      });
      steps.push(step);
      continue;
    }
    if (hasAnnotation(step, "memoization-hooks")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      steps.push(step);
      continue;
    }
    const predecessors = (graph.predecessors.get(step.id) ?? []).map((p) => p.id).sort();
    const memoKey = digest.sha256Hex(
      canonicalJson({
        step: {
          cls: step.stepClass,
          ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
          ...(step.routeRef === undefined
            ? {}
            : { route: { provider: step.routeRef.provider, model: step.routeRef.model } }),
          ...cfgFragment(step.config),
        },
        preds: predecessors,
        source: variant.sourceIrId,
      }),
    );
    steps.push(annotateStep(step, "memoization-hooks", { memoKey }));
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "memoization-hooks",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "memoization-hooks", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "memoization-hooks",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 9 — subgraph decomposition
// ---------------------------------------------------------------------------

/**
 * Deterministic/probabilistic subgraph decomposition: annotates every
 * step with its subgraph membership — `deterministic` when the step
 * and its entire transitive ancestry are deterministic, else
 * `probabilistic` — plus the deterministic region's membership key.
 * The decomposition is recorded evidence for later representation
 * selection (the deterministic prefix is executable without inference);
 * the graph structure is untouched.
 */
export function applySubgraphDecomposition(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  // Transitive ancestry closure per step (memoized, deterministic).
  const ancestry = new Map<string, Set<string>>();
  const closureOf = (stepId: string, visiting: Set<string>): Set<string> => {
    const memo = ancestry.get(stepId);
    if (memo !== undefined) {
      return memo;
    }
    if (visiting.has(stepId)) {
      throw new CompilerError(
        "variant-invalid",
        "ancestry computation hit a cycle (variant is not a DAG)",
      );
    }
    visiting.add(stepId);
    const found = new Set<string>();
    for (const pred of graph.predecessors.get(stepId) ?? []) {
      found.add(pred.id);
      for (const member of closureOf(pred.id, visiting)) {
        found.add(member);
      }
    }
    visiting.delete(stepId);
    ancestry.set(stepId, found);
    return found;
  };

  const membership = new Map<string, "deterministic" | "probabilistic">();
  for (const step of variant.steps) {
    if (hasAnnotation(step, "subgraph-decomposition")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      continue;
    }
    const closure = closureOf(step.id, new Set());
    const allDeterministic =
      step.computationType === "deterministic" &&
      [...closure].every((id) => graph.stepsById.get(id)?.computationType === "deterministic");
    membership.set(step.id, allDeterministic ? "deterministic" : "probabilistic");
  }

  const deterministicMembers = [...membership.entries()]
    .filter(([, region]) => region === "deterministic")
    .map(([id]) => id)
    .sort();
  const regionKey = digest
    .sha256Hex(
      canonicalJson({
        kind: "subgraph-region",
        members: deterministicMembers,
        source: variant.sourceIrId,
      }),
    )
    .slice(0, 16);

  for (const step of variant.steps) {
    const region = membership.get(step.id);
    if (region === undefined) {
      steps.push(step);
      continue;
    }
    steps.push(
      annotateStep(step, "subgraph-decomposition", {
        region,
        ...(region === "deterministic" ? { regionKey } : {}),
      }),
    );
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "subgraph-decomposition",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "subgraph-decomposition", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "subgraph-decomposition",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Pass 10 — result shaping
// ---------------------------------------------------------------------------

/**
 * Result shaping: for a TERMINAL step whose observable output shape is
 * statically derivable — a folded constant that is an object, or a
 * terminal projection step (closed `project` expression over a known
 * field list) — records the result's field list as an annotation so
 * the executor can allocate a compact structured result. The result
 * VALUE is never changed (semantics preservation is annotation-only).
 */
export function applyResultShaping(input: PassInput): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const graph = indexVariant(variant);
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  for (const step of variant.steps) {
    const isTerminal = graph.successors.get(step.id)?.length === 0;
    if (!isTerminal) {
      if (step.stepClass === "transform" || step.stepClass === "retrieve") {
        rejections.push({
          check: "shape-step-not-terminal",
          stepId: step.id,
          detail: siteDetail("result shaping is provable only for terminal outputs"),
        });
      }
      steps.push(step);
      continue;
    }
    if (hasAnnotation(step, "result-shaping")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      steps.push(step);
      continue;
    }
    let fields: readonly string[] | null = null;
    // Case A: a folded constant object — the shape is the key set.
    const folded = foldedResult(step);
    if (
      folded !== undefined &&
      typeof folded === "object" &&
      folded !== null &&
      !Array.isArray(folded)
    ) {
      fields = Object.keys(folded).sort();
    }
    // Case B: a terminal projection — the shape is the projection list.
    if (fields === null && step.stepClass === "transform" && step.capabilityId === undefined) {
      const expression = parseFoldExpression(step.config);
      if (
        expression !== null &&
        expression.operation === "project" &&
        expression.fields !== undefined
      ) {
        fields = [...expression.fields].sort();
      }
    }
    if (fields === null) {
      rejections.push({
        check: "shape-not-derivable",
        stepId: step.id,
        detail: siteDetail("the terminal output shape is not statically derivable"),
      });
      steps.push(step);
      continue;
    }
    steps.push(annotateStep(step, "result-shaping", { fields }));
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "result-shaping",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "result-shaping", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "result-shaping",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

function foldedResult(step: IrVariantStep): unknown | undefined {
  if (
    step.stepClass === "retrieve" &&
    step.config !== undefined &&
    Object.hasOwn(step.config, FOLDED_CONSTANT_KEY)
  ) {
    const folded = (step.config as Record<string, unknown>)[FOLDED_CONSTANT_KEY];
    if (
      typeof folded === "object" &&
      folded !== null &&
      !Array.isArray(folded) &&
      Object.hasOwn(folded, "result")
    ) {
      return (folded as Record<string, unknown>).result;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pass 11 — representation-ladder hooks
// ---------------------------------------------------------------------------

/**
 * Representation-ladder hooks (model/effort selection hooks — HOOKS
 * ONLY): annotates every GENERATIVE step as a representation-selection
 * decision point carrying the SELECTION FACTS of the material
 * representation decision (selected candidate, representation class,
 * ladder rank, quality threshold) — never a live selection (the
 * routeRef is never changed; live model/provider/effort selection is
 * a later E1.1 stage). The decision record itself (the full WORK-049
 * evidence contract) is built by `decisions.ts` over the FINAL variant
 * — after this annotation — so the recorded candidates reference the
 * exact output identity.
 */
export function applyRepresentationLadderHooks(
  input: PassInput,
  selection: {
    readonly selectedCandidateId: string;
    readonly representationClass: string;
    readonly ladderRank: number;
    readonly qualityThreshold: number;
  } | null,
): PassOutcome {
  const { variant, digest, traceDigest } = input;
  const rejections: SiteRejection[] = [];
  const steps: VariantStepMaterial[] = [];
  let applied = 0;

  for (const step of variant.steps) {
    if (step.computationType !== "probabilistic") {
      // Non-generative steps are not model/effort selection points;
      // not a rejection — the pass scope is the generative boundary.
      steps.push(step);
      continue;
    }
    if (hasAnnotation(step, "representation-ladder-hooks")) {
      rejections.push({
        check: "annotation-already-present",
        stepId: step.id,
        detail: siteDetail("the step already carries a compiler annotation"),
      });
      steps.push(step);
      continue;
    }
    if (selection === null) {
      rejections.push({
        check: "ladder-no-claims",
        stepId: step.id,
        detail: siteDetail(
          "no representation claims were configured — the hook records no selection",
        ),
      });
      steps.push(step);
      continue;
    }
    steps.push(
      annotateStep(step, "representation-ladder-hooks", {
        hook: "representation-ladder",
        selectedCandidateId: selection.selectedCandidateId,
        representationClass: selection.representationClass,
        ladderRank: selection.ladderRank,
        qualityThreshold: selection.qualityThreshold,
      }),
    );
    applied += 1;
  }

  if (applied === 0) {
    return {
      passId: "representation-ladder-hooks",
      status: "noop",
      output: variant,
      sitesConsidered: variant.steps.length,
      sitesApplied: 0,
      rejections,
    };
  }
  const output = buildVariant(
    {
      source: variant,
      steps,
      edges: variant.edges,
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: extendTrace(
          traceDigest,
          { passId: "representation-ladder-hooks", sitesApplied: applied },
          digest,
        ),
      },
    },
    digest,
  );
  return {
    passId: "representation-ladder-hooks",
    status: "applied",
    output,
    sitesConsidered: variant.steps.length,
    sitesApplied: applied,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// The pass dispatcher (the closed catalog — nothing else is runnable)
// ---------------------------------------------------------------------------

const STRUCTURAL_PASSES: ReadonlyMap<CompilerPassId, (input: PassInput) => PassOutcome> = new Map([
  ["constant-folding", applyConstantFolding],
  ["dead-step-elimination", applyDeadStepElimination],
  ["common-subexpression-reuse", applyCommonSubexpressionReuse],
  ["verification-insertion", applyVerificationInsertion],
  ["retry-normalization", applyRetryNormalization],
  ["safe-parallelization", applySafeParallelization],
  ["batching", applyBatching],
  ["memoization-hooks", applyMemoizationHooks],
  ["subgraph-decomposition", applySubgraphDecomposition],
  ["result-shaping", applyResultShaping],
]);

export const LADDER_PASS_ID: CompilerPassId = "representation-ladder-hooks";

/** Is this pass id the ladder pass (needs the selection facts)? */
export function isLadderPass(passId: CompilerPassId): boolean {
  return passId === LADDER_PASS_ID;
}

/**
 * Run one NON-ladder catalog pass over the variant. The pass id MUST
 * be in the closed catalog and MUST NOT be the ladder pass (which
 * needs the selection facts — see the pipeline). Unknown ids fail
 * closed (no pass injection).
 */
export function runCatalogPass(passId: CompilerPassId, input: PassInput): PassOutcome {
  const implementation = STRUCTURAL_PASSES.get(passId);
  if (implementation === undefined) {
    throw new CompilerError(
      "compiler-config",
      "the pass requires its selection facts or is unknown",
      {
        passId,
      },
    );
  }
  return implementation(input);
}

/** The graph index re-exported for pass-adjacent consumers. */
export type { VariantGraph };
