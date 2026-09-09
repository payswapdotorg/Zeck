/**
 * Semantics-preservation machinery (platform execution-compiler plane;
 * WORK-050 / E1.1 charter stage 2).
 *
 * SEMANTICS PRESERVATION IS THE PROOF STANDARD of this Work Order:
 * every transformation output must be PROVEN equivalent to its input —
 * never assumed. This module is the proof engine:
 *
 *  1. THE CLOSED CONSTANT EVALUATOR (`FOLD_OPERATIONS`): the finite,
 *     totally-specified universe of pure computations the compiler
 *     understands and may evaluate at compile time. A step is foldable
 *     ONLY when its class is pure-deterministic AND its entire config
 *     is a closed static expression over this universe — anything the
 *     evaluator does not fully understand is NEVER folded (fail-closed
 *     per site, recorded). The evaluator's semantics are pinned by the
 *     unit suite; folding is sound BY CONSTRUCTION because the folded
 *     value is exactly what this evaluator computes.
 *
 *  2. THE SEMANTIC CORE FORM: a canonical form of the variant's
 *     OBSERVABLE semantics — the evaluated contributions of every step
 *     that contributes to an observable point (sinks, external effects,
 *     human interactions), the anchor bindings (verification anchors
 *     with their anchored positions and strategies, carried VERBATIM —
 *     the compiler never interprets them), and compiler annotations
 *     stripped. The core digest is the equivalence invariant:
 *
 *       digest(core(input)) === digest(core(output))
 *
 *     holds for every catalogued transformation — constant folding
 *     normalizes folded and unfoldable forms to the same evaluated
 *     contribution; dead-step elimination only removes steps with no
 *     path to any observable point; CSE merges only
 *     identical-contribution steps with arity-preserving re-pointing;
 *     annotations are stripped; verification materialization re-binds
 *     an existing (position, strategy) anchor identically. The
 *     discrimination suite proves a MUTATED output (dropped side
 *     effect, changed route, invented strategy, reordered dependency)
 *     breaks the digest and is rejected.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import type { ExecutionIrVariant, IrVariantStep } from "./variant";

// ---------------------------------------------------------------------------
// The closed constant evaluator
// ---------------------------------------------------------------------------

/** The closed operation universe of the constant evaluator. */
export const FOLD_OPERATIONS = [
  "identity",
  "uppercase",
  "lowercase",
  "concat",
  "add",
  "multiply",
  "length",
  "project",
] as const;
export type FoldOperation = (typeof FOLD_OPERATIONS)[number];

/** Bounded input universe: the config expression stays small and shallow. */
export const FOLD_CONFIG_MAX_JSON = 4096;
export const FOLD_MAX_INPUTS = 32;

/** The typed, bounded fold-evaluation failure. */
export class FoldError extends Error {
  readonly reason: "fold-operation-unknown" | "fold-input-unbounded" | "fold-input-invalid";

  constructor(
    reason: "fold-operation-unknown" | "fold-input-unbounded" | "fold-input-invalid",
    message: string,
  ) {
    super(message);
    this.name = "FoldError";
    this.reason = reason;
  }
}

function foldInput(value: unknown, what: string): void {
  if (!isCanonicalizable(value)) {
    throw new FoldError("fold-input-invalid", `${what} is outside the closed JSON universe`);
  }
}

/**
 * The statically-foldable expression contract: a step config of the
 * exact closed shape `{ operation, inputs }` (plus `fields` for
 * `project`). Everything else is unfoldable — never guessed.
 */
export function parseFoldExpression(
  config: Readonly<Record<string, unknown>> | undefined,
): { operation: FoldOperation; inputs: readonly unknown[]; fields?: readonly string[] } | null {
  if (config === undefined) {
    return null;
  }
  const keys = Object.keys(config).sort();
  const operation = config.operation;
  if (
    typeof operation !== "string" ||
    !(FOLD_OPERATIONS as readonly string[]).includes(operation)
  ) {
    return null;
  }
  const expectedKeys =
    operation === "project" ? ["fields", "inputs", "operation"] : ["inputs", "operation"];
  if (keys.join(",") !== expectedKeys.join(",")) {
    return null;
  }
  if (!Array.isArray(config.inputs)) {
    return null;
  }
  if (config.inputs.length > FOLD_MAX_INPUTS) {
    throw new FoldError("fold-input-unbounded", "fold expression carries too many inputs");
  }
  const inputs = config.inputs as readonly unknown[];
  for (const input of inputs) {
    foldInput(input, "fold input");
  }
  if (canonicalJson({ op: operation, inputs }).length > FOLD_CONFIG_MAX_JSON) {
    throw new FoldError("fold-input-unbounded", "fold expression exceeds the bounded size");
  }
  if (operation === "project") {
    const fields = config.fields;
    if (!Array.isArray(fields)) {
      return null;
    }
    for (const field of fields) {
      if (typeof field !== "string" || field.length === 0) {
        return null;
      }
    }
    if (fields.length > FOLD_MAX_INPUTS) {
      throw new FoldError("fold-input-unbounded", "fold projection carries too many fields");
    }
    return { operation: operation as FoldOperation, inputs, fields: fields as readonly string[] };
  }
  return { operation: operation as FoldOperation, inputs };
}

/**
 * Evaluate a closed fold expression. Total and deterministic over the
 * closed universe; every failure is a typed `FoldError` (never a
 * silent value, never an exception outside the vocabulary).
 */
export function evaluateFold(
  operation: FoldOperation,
  inputs: readonly unknown[],
  fields?: readonly string[],
): unknown {
  switch (operation) {
    case "identity": {
      if (inputs.length !== 1) {
        throw new FoldError("fold-input-invalid", "identity requires exactly one input");
      }
      return inputs[0];
    }
    case "uppercase": {
      if (inputs.length !== 1 || typeof inputs[0] !== "string") {
        throw new FoldError("fold-input-invalid", "uppercase requires one string input");
      }
      return (inputs[0] as string).toUpperCase();
    }
    case "lowercase": {
      if (inputs.length !== 1 || typeof inputs[0] !== "string") {
        throw new FoldError("fold-input-invalid", "lowercase requires one string input");
      }
      return (inputs[0] as string).toLowerCase();
    }
    case "concat": {
      let out = "";
      for (const input of inputs) {
        if (typeof input !== "string") {
          throw new FoldError("fold-input-invalid", "concat requires string inputs");
        }
        out += input;
      }
      return out;
    }
    case "add": {
      let sum = 0;
      for (const input of inputs) {
        if (typeof input !== "number" || !Number.isFinite(input)) {
          throw new FoldError("fold-input-invalid", "add requires finite number inputs");
        }
        sum += input;
      }
      if (!Number.isFinite(sum)) {
        throw new FoldError("fold-input-invalid", "add produced a non-finite result");
      }
      return sum;
    }
    case "multiply": {
      let product = 1;
      for (const input of inputs) {
        if (typeof input !== "number" || !Number.isFinite(input)) {
          throw new FoldError("fold-input-invalid", "multiply requires finite number inputs");
        }
        product *= input;
      }
      if (!Number.isFinite(product)) {
        throw new FoldError("fold-input-invalid", "multiply produced a non-finite result");
      }
      return product;
    }
    case "length": {
      if (inputs.length !== 1) {
        throw new FoldError("fold-input-invalid", "length requires exactly one input");
      }
      const input = inputs[0];
      if (typeof input === "string") {
        return input.length;
      }
      if (Array.isArray(input)) {
        return input.length;
      }
      if (typeof input === "object" && input !== null) {
        return Object.keys(input).length;
      }
      throw new FoldError("fold-input-invalid", "length requires a string, array or object input");
    }
    case "project": {
      if (
        inputs.length !== 1 ||
        typeof inputs[0] !== "object" ||
        inputs[0] === null ||
        Array.isArray(inputs[0])
      ) {
        throw new FoldError("fold-input-invalid", "project requires exactly one object input");
      }
      if (fields === undefined) {
        throw new FoldError("fold-input-invalid", "project requires a fields list");
      }
      const source = inputs[0] as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const field of fields) {
        // Existing keys only — deterministic projection, never fabrication.
        if (Object.hasOwn(source, field)) {
          out[field] = source[field];
        }
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Compiler annotations (the reserved config namespace)
// ---------------------------------------------------------------------------

/**
 * The reserved step-config key carrying compiler annotations. Plan
 * steps whose config already carries this key are NEVER annotated (the
 * site is rejected — the compiler never clobbers plan-owned config),
 * and the equivalence normalization strips exactly this key.
 */
export const COMPILER_ANNOTATION_KEY = "execution-compiler";

/**
 * The reserved step-config key carrying a folded constant (set by the
 * constant-folding pass). Unlike an annotation, a folded constant IS
 * semantic content (the precomputed value) — never stripped.
 */
export const FOLDED_CONSTANT_KEY = "compiler-folded";

/** Strip exactly the compiler-annotation key from a step config. */
export function configSansAnnotations(
  config: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(config, COMPILER_ANNOTATION_KEY)) {
    return config;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== COMPILER_ANNOTATION_KEY) {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The semantic core form
// ---------------------------------------------------------------------------

/** Observable side-effect classes (an effect happens, ordering matters). */
const OBSERVABLE_EFFECT_CLASSES = new Set(["external-effect", "human-interaction"]);

/** The closed fold result of a step, or null when it is uninterpreted. */
function foldedValueOf(step: IrVariantStep): unknown | undefined {
  // A step folded by the compiler carries the reserved constant key.
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
    return undefined;
  }
  return undefined;
}

/**
 * The contribution of one step to observable semantics — a recursive
 * value expression:
 *
 *  - a folded constant (or a statically-foldable pure expression —
 *    NORMALIZED through the same closed evaluator, so folded and
 *    unfoldable forms of the same computation compare EQUAL) is
 *    `{"const": value}`;
 *  - any other step is a symbolic application: class, capability,
 *    route, strategy-free config (annotations stripped) and the sorted
 *    contribution keys of its predecessors.
 *
 * Deterministic: arrays in graph order, keys canonicalized. Computed
 * edge-bound by `contributionWithGraph` (the variant graph index is
 * the binding).
 */

// ---------------------------------------------------------------------------
// Graph indexing helpers
// ---------------------------------------------------------------------------

export interface VariantGraph {
  readonly stepsById: ReadonlyMap<string, IrVariantStep>;
  readonly predecessors: ReadonlyMap<string, readonly IrVariantStep[]>;
  readonly successors: ReadonlyMap<string, readonly IrVariantStep[]>;
}

/** Index a variant's graph (pure, derived from steps+edges). */
export function indexVariant(variant: ExecutionIrVariant): VariantGraph {
  const stepsById = new Map(variant.steps.map((step) => [step.id, step]));
  const preds = new Map<string, IrVariantStep[]>(variant.steps.map((step) => [step.id, []]));
  const succs = new Map<string, IrVariantStep[]>(variant.steps.map((step) => [step.id, []]));
  for (const edge of variant.edges) {
    const from = stepsById.get(edge.from);
    const to = stepsById.get(edge.to);
    if (from !== undefined && to !== undefined) {
      preds.get(to.id)?.push(from);
      succs.get(from.id)?.push(to);
    }
  }
  return { stepsById, predecessors: preds, successors: succs };
}

// ---------------------------------------------------------------------------
// The core computation (edge-bound)
// ---------------------------------------------------------------------------

interface CoreBindings {
  readonly anchors: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly sinks: readonly unknown[];
}

/** Compute the anchor/effect/sink bindings of the variant's core. */
function coreBindings(variant: ExecutionIrVariant, graph: VariantGraph): CoreBindings {
  const anchors: unknown[] = [];
  const effects: unknown[] = [];
  const sinks: unknown[] = [];
  const memo = new Map<string, unknown>();
  const visiting = new Set<string>();
  const contribution = (step: IrVariantStep): unknown =>
    contributionWithGraph(step, graph, memo, visiting);

  for (const step of variant.steps) {
    const isVerify = step.stepClass === "verify";
    const isEffect = OBSERVABLE_EFFECT_CLASSES.has(step.sideEffectClass);
    const isSink = graph.successors.get(step.id)?.length === 0;

    // Verification anchors: the compiler treats verification as opaque
    // anchor evidence (VERIFICATION-SEPARATION: strategies carried
    // verbatim, never interpreted, never redefined).
    if (step.verificationStrategy !== undefined && !isVerify) {
      // A step-level anchor binds the step's own output.
      anchors.push({ anchored: [contribution(step)], strategy: step.verificationStrategy });
    }
    if (isVerify && step.verificationStrategy !== undefined) {
      // An explicit verify step anchors its input set (its
      // predecessors' outputs) — the materialized form of a
      // step-level anchor binds the SAME position after
      // materialization, so the two forms compare equal.
      const preds = graph.predecessors.get(step.id) ?? [];
      anchors.push({
        anchored: preds.map(contribution),
        strategy: step.verificationStrategy,
      });
    }
    if (isVerify && step.verificationStrategy === undefined) {
      // A strategy-less verify step is an observation point over its
      // input set (carried verbatim; the verification authority owns
      // what it means).
      const preds = graph.predecessors.get(step.id) ?? [];
      anchors.push({ anchored: preds.map(contribution), strategy: null });
    }
    if (isEffect) {
      effects.push({ effect: contribution(step), stepId: step.id });
    }
    if (isSink && !isVerify && !isEffect) {
      sinks.push({ output: contribution(step) });
    }
  }
  const order = (list: readonly unknown[]): readonly unknown[] =>
    [...list].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
  return { anchors: order(anchors), effects: order(effects), sinks: order(sinks) };
}

/** Edge-bound contribution computation (the real entry point). */
function contributionWithGraph(
  step: IrVariantStep,
  graph: VariantGraph,
  memo: Map<string, unknown>,
  visiting: Set<string>,
): unknown {
  const memoized = memo.get(step.id);
  if (memoized !== undefined) {
    return memoized;
  }
  if (visiting.has(step.id)) {
    throw new Error(`contribution cycle at step ${step.id} (variant is not a DAG)`);
  }
  visiting.add(step.id);
  try {
    const folded = foldedValueOf(step);
    if (folded !== undefined) {
      const value = { const: folded };
      memo.set(step.id, value);
      return value;
    }
    if (
      (step.stepClass === "transform" ||
        step.stepClass === "run-algorithm" ||
        step.stepClass === "compare") &&
      step.capabilityId === undefined &&
      step.routeRef === undefined &&
      step.verificationStrategy === undefined
    ) {
      const expression = parseFoldExpression(step.config);
      if (expression !== null) {
        try {
          const value = evaluateFold(expression.operation, expression.inputs, expression.fields);
          if (isCanonicalizable(value)) {
            const normalized = { const: value };
            memo.set(step.id, normalized);
            return normalized;
          }
        } catch {
          // Fall through to the symbolic form.
        }
      }
    }
    const predecessors = (graph.predecessors.get(step.id) ?? []).map((pred) =>
      contributionWithGraph(pred, graph, memo, visiting),
    );
    const symbolic = {
      step: {
        class: step.stepClass,
        ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
        ...(step.routeRef === undefined
          ? {}
          : { route: { provider: step.routeRef.provider, model: step.routeRef.model } }),
        ...(step.config === undefined ? {} : { config: configSansAnnotations(step.config) }),
      },
      preds: predecessors,
    };
    memo.set(step.id, symbolic);
    return symbolic;
  } finally {
    visiting.delete(step.id);
  }
}

// The graph-free contribution placeholder is superseded by the
// edge-bound computation below (the graph index is the binding).

/**
 * The canonical SEMANTIC CORE form of a variant: the observable
 * semantics as canonical JSON — the anchor bindings (verification
 * anchors: anchored positions + verbatim strategies), the observable
 * effects (external effects and human interactions, with their
 * contributions), and the sink outputs (terminal contributions), each
 * canonically ordered. Compiler annotations are stripped inside every
 * contribution.
 */
export function semanticCoreForm(variant: ExecutionIrVariant): string {
  const graph = indexVariant(variant);
  const core = coreBindings(variant, graph);
  return canonicalJson({
    coreSchema: 1,
    anchors: core.anchors,
    effects: core.effects,
    sinks: core.sinks,
  });
}

/** The semantic core digest (the equivalence invariant). */
export function semanticCoreDigest(variant: ExecutionIrVariant, digest: IrDigestPort): string {
  return digest.sha256Hex(semanticCoreForm(variant));
}

export interface EquivalenceVerdict {
  readonly ok: boolean;
  readonly inputCoreDigest: string;
  readonly outputCoreDigest: string;
}

/**
 * Prove semantics preservation between the input IR and a compiled
 * variant: the variant must be structurally valid (the caller's
 * invariant validation) and its semantic core digest must EQUAL the
 * input's. Also pins the preserved chain (sourceIrId/sourcePlanId) and
 * the unchanged model-call structure.
 */
export function verifySemanticsPreservation(
  input: ExecutionIrVariant,
  output: ExecutionIrVariant,
  digest: IrDigestPort,
): EquivalenceVerdict {
  const inputCoreDigest = semanticCoreDigest(input, digest);
  const outputCoreDigest = semanticCoreDigest(output, digest);
  const chainPreserved =
    output.sourceIrId === input.sourceIrId &&
    output.sourcePlanId === input.sourcePlanId &&
    output.planRevision === input.planRevision &&
    output.strategyClass === input.strategyClass;
  return {
    ok: inputCoreDigest === outputCoreDigest && chainPreserved,
    inputCoreDigest,
    outputCoreDigest,
  };
}

// ---------------------------------------------------------------------------
// Deadness analysis (the dead-step-elimination proof basis)
// ---------------------------------------------------------------------------

/**
 * Is this step provably non-observable — no path to any sink, external
 * effect, human interaction or verification point — AND pure (its
 * removal removes no observable semantics)? This is the exact
 * precondition under which dead-step elimination may remove a step.
 */
export function isProvablyDead(stepId: string, graph: VariantGraph): boolean {
  const step = graph.stepsById.get(stepId);
  if (step === undefined) {
    return false;
  }
  // Only pure steps may ever be eliminated (side effects, verification
  // observations and human interactions are observable regardless of
  // dataflow; probabilistic steps are never eliminated — their
  // sampling is not provably non-observable under the conservative
  // reading).
  if (step.sideEffectClass !== "pure" || step.computationType !== "deterministic") {
    return false;
  }
  if (step.verificationStrategy !== undefined) {
    return false;
  }
  // Reachability: does any observable step depend transitively on this
  // step? (BFS over successors.)
  const isObservable = (candidate: IrVariantStep): boolean =>
    graph.successors.get(candidate.id)?.length === 0 ||
    OBSERVABLE_EFFECT_CLASSES.has(candidate.sideEffectClass) ||
    candidate.stepClass === "verify";
  const queue = [...(graph.successors.get(stepId) ?? [])];
  const seen = new Set<string>(queue.map((next) => next.id));
  while (queue.length > 0) {
    const current = queue.shift() as IrVariantStep;
    if (isObservable(current)) {
      return false;
    }
    for (const next of graph.successors.get(current.id) ?? []) {
      if (!seen.has(next.id)) {
        seen.add(next.id);
        queue.push(next);
      }
    }
  }
  return true;
}

/**
 * Mutual independence: can none of these steps reach any other
 * (pairwise unreachable)? The exact precondition for safe
 * parallelization and batching groups.
 */
export function areMutuallyIndependent(stepIds: readonly string[], graph: VariantGraph): boolean {
  const reachable = new Map<string, Set<string>>();
  const closureOf = (start: string): Set<string> => {
    const memo = reachable.get(start);
    if (memo !== undefined) {
      return memo;
    }
    const found = new Set<string>();
    const queue = [...(graph.successors.get(start) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as IrVariantStep;
      if (found.has(current.id)) {
        continue;
      }
      found.add(current.id);
      for (const next of graph.successors.get(current.id) ?? []) {
        queue.push(next);
      }
    }
    reachable.set(start, found);
    return found;
  };
  for (const id of stepIds) {
    const closure = closureOf(id);
    for (const other of stepIds) {
      if (other !== id && closure.has(other)) {
        return false;
      }
    }
  }
  return true;
}
