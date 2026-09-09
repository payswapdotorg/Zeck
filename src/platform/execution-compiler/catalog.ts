/**
 * The deterministic Execution Compiler catalog (platform
 * execution-compiler plane; WORK-050 / E1.1 charter stage 2 — ADR-0019,
 * ADR-0020).
 *
 * This plane is the SINGLE optimization mechanism ADR-0020 designates:
 * the engine that transforms a governed, validated Execution IR
 * (WORK-049) into an optimized IR VARIANT using only
 * semantics-preserving transformations under explicit, recorded
 * preconditions. It BUILDS ON the WORK-049 foundation (IR, constraints,
 * cost model, decision records) — it re-implements nothing, forks
 * nothing, and creates no new authority, state machine or durable
 * store: the only durable surface it participates in is the WORK-049
 * decision-record store, as the legitimate decision-record AUTHOR the
 * foundation anticipated (records are BUILT here, purely; durable
 * appends happen through the existing store at the caller's seam).
 *
 * Closed vocabularies in this module:
 *
 *  - `COMPILER_PASS_IDS` — the eleven catalogued transformations of the
 *    E1.1 charter stage 2. The pipeline composes EXACTLY these; a
 *    configuration naming anything else is rejected (no pass injection).
 *  - `COMPILER_INVARIANT_CODES` — the typed, bounded compilation-level
 *    failure vocabulary (fail-closed pipeline errors).
 *  - `PRECONDITION_CHECK_CODES` — the typed, bounded per-site rejection
 *    vocabulary: every pass-application site whose preconditions do not
 *    hold records exactly one of these (recorded, never silently
 *    skipped, never silently applied).
 *  - `FOLD_OPERATIONS` lives in `semantics.ts` (the closed constant
 *    evaluator universe) — kept beside the equivalence machinery it
 *    anchors.
 *
 * Determinism (architecture invariant 5): every value in this plane is
 * a pure function of (input IR, constraints, configuration, injected
 * digest port). No clock, no randomness, no ambient state. The
 * recordedAt of any decision record is an explicit INPUT.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { CostClaim } from "../execution-ir/cost-model";
import { validateCostClaim } from "../execution-ir/cost-model";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";

// ---------------------------------------------------------------------------
// The transformation catalog (closed)
// ---------------------------------------------------------------------------

/**
 * The closed pass catalog of the E1.1 charter stage 2. Order in a
 * pipeline configuration is CALLER-CHOSEN and explicit; duplicate ids
 * are rejected (an ambiguous ordering is a non-determinism hazard).
 */
export const COMPILER_PASS_IDS = [
  "constant-folding",
  "dead-step-elimination",
  "common-subexpression-reuse",
  "verification-insertion",
  "retry-normalization",
  "safe-parallelization",
  "batching",
  "memoization-hooks",
  "subgraph-decomposition",
  "result-shaping",
  "representation-ladder-hooks",
] as const;
export type CompilerPassId = (typeof COMPILER_PASS_IDS)[number];

/** The canonical default pipeline order (deterministic, all passes). */
export const DEFAULT_PIPELINE_PASSES: readonly CompilerPassId[] = [
  "constant-folding",
  "dead-step-elimination",
  "common-subexpression-reuse",
  "verification-insertion",
  "retry-normalization",
  "safe-parallelization",
  "batching",
  "memoization-hooks",
  "subgraph-decomposition",
  "result-shaping",
  "representation-ladder-hooks",
];

// ---------------------------------------------------------------------------
// Compilation-level invariant codes (typed, bounded, fail-closed)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of pipeline-level compilation failures. Each
 * one fails the WHOLE compilation closed (no output is emitted):
 *
 *  - `compiler-config` — the pipeline configuration is invalid (unknown
 *    pass, duplicate pass, unbounded rounds, unbounded or unattributed
 *    representation claims, claims without governing constraints);
 *  - `variant-invalid` — a transformation output failed IR variant
 *    validation (the WORK-049 invariant rules over the closed 12-code
 *    vocabulary — the per-error code rides in the details);
 *  - `equivalence-violation` — a transformation output failed the
 *    semantics-preservation proof (semantic core digest or anchor
 *    bindings drifted);
 *  - `pipeline-unbounded` — the bounded iteration budget was exhausted
 *    while transformations were still applying (no unbounded fixpoints:
 *    convergence must be proven within the bound or nothing is emitted);
 *  - `decision-invalid` — the representation decision record failed its
 *    own total validation (never emitted unvalidated).
 */
export const COMPILER_INVARIANT_CODES = [
  "compiler-config",
  "variant-invalid",
  "equivalence-violation",
  "pipeline-unbounded",
  "decision-invalid",
] as const;
export type CompilerInvariantCode = (typeof COMPILER_INVARIANT_CODES)[number];

// ---------------------------------------------------------------------------
// Per-site precondition rejections (typed, bounded, recorded)
// ---------------------------------------------------------------------------

/**
 * The closed per-site rejection vocabulary: exactly one code per
 * rejected transformation-application site. Recorded in the pass trace
 * as bounded evidence; the site is NEVER applied when its check fails.
 */
export const PRECONDITION_CHECK_CODES = [
  // constant-folding
  "step-class-not-foldable",
  "fold-capability-bound",
  "fold-route-bound",
  "fold-strategy-bound",
  "fold-config-unparseable",
  "fold-operation-unknown",
  "fold-input-unbounded",
  // dead-step-elimination
  "dead-step-side-effecting",
  "dead-step-reachable",
  // common-subexpression-reuse
  "cse-step-not-deterministic",
  "cse-step-not-value-pure",
  "cse-verification-step",
  "cse-shared-successor",
  "cse-predecessor-mismatch",
  // verification-insertion (terminal anchor materialization)
  "anchor-strategy-absent",
  "anchor-step-not-terminal",
  "anchor-step-is-verify",
  "annotation-already-present",
  // retry-normalization
  "retry-config-non-canonical",
  // safe-parallelization
  "parallel-class-excluded",
  "parallel-dependency-exists",
  // batching
  "batch-class-excluded",
  "batch-capability-mismatch",
  "batch-dependency-exists",
  // memoization-hooks
  "memo-step-not-deterministic",
  "memo-verification-step",
  "memo-human-step",
  // result-shaping
  "shape-step-not-terminal",
  "shape-not-derivable",
  // representation-ladder-hooks
  "ladder-step-not-generative",
  "ladder-no-claims",
  "ladder-no-admissible-candidate",
] as const;
export type PreconditionCheckCode = (typeof PRECONDITION_CHECK_CODES)[number];

// ---------------------------------------------------------------------------
// The typed, bounded compiler error
// ---------------------------------------------------------------------------

const DETAIL_LIMIT = 300;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/**
 * The fail-closed compilation error: `invariant` names the closed
 * vocabulary code; `details` carries only bounded scalar evidence.
 */
export class CompilerError extends Error {
  readonly invariant: CompilerInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: CompilerInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "CompilerError";
    this.invariant = invariant;
    const boundedDetails: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
      }
    }
    this.details = Object.freeze(boundedDetails);
  }
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * A representation-ladder candidate claim pair (hooks only — the
 * compiler records the decision; it NEVER performs live model/provider
 * selection, which is a later E1.1 stage).
 */
export interface RepresentationClaims {
  /** The base (untransformed governed plan) representation. */
  readonly base: {
    readonly candidateId: string;
    readonly representationClass: string;
    readonly claim: CostClaim;
  };
  /** The compiled variant representation. */
  readonly compiled: {
    readonly candidateId: string;
    readonly representationClass: string;
    readonly claim: CostClaim;
  };
}

/** The hard upper bound on pipeline rounds (no unbounded fixpoints). */
export const MAX_PIPELINE_ROUNDS_HARD = 16;

/** The default round bound (convergence must be proven inside it). */
export const DEFAULT_MAX_PIPELINE_ROUNDS = 4;

export interface CompilerPipelineConfig {
  /** Explicit ordered pass list from the closed catalog. */
  readonly passes: readonly CompilerPassId[];
  /**
   * Bounded re-round budget: the pipeline re-runs the ordered passes
   * while the previous round applied a change, AT MOST this many
   * rounds. Exhausted-with-changes fails closed (`pipeline-unbounded`).
   */
  readonly maxRounds: number;
  /**
   * Representation-ladder claims for the material decision. Absent ⇒
   * the ladder pass records `ladder-no-claims` and emits no decision
   * record (no material decision occurred). Present ⇒ exactly one
   * WORK-049-format decision record is built with bounded, attributed
   * claims for base and compiled representations.
   */
  readonly representationClaims?: RepresentationClaims;
  /**
   * The assurance threshold the ladder selection is evaluated against
   * (quality-preserving economics — a cheaper claim below the
   * threshold is invalid, never merely more expensive).
   */
  readonly qualityThreshold: number;
}

export interface CompileExecutionIrInput {
  /** The governed, validated Execution IR (re-validated here). */
  readonly ir: ExecutionIr;
  /**
   * The governing constraint set (validated; NON-EMPTY when
   * representation claims are configured — a decision without its
   * governing inputs is unprovenanced optimization and is rejected).
   */
  readonly constraints: readonly OptimizationConstraint[];
  readonly config: CompilerPipelineConfig;
  /** The injected digest port (sha256, lowercase hex). */
  readonly digest: IrDigestPort;
  /**
   * Decision-record scope. Required when representation claims are
   * configured (the record's identity anchors).
   */
  readonly decisionScope?: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId?: string;
  };
  /**
   * The explicit recorded-at instant for any decision record — an
   * INPUT, never ambient time (determinism: the same inputs always
   * produce the same records, byte-identical).
   */
  readonly recordedAt?: string;
}

const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Total, deterministic validation of a pipeline configuration.
 * Fail-closed on: unknown pass ids, duplicate pass ids (ambiguous
 * ordering — a determinism hazard), unbounded round budgets, malformed
 * or unbounded/unattributed representation claims, and an invalid
 * quality threshold.
 */
export function validatePipelineConfig(config: CompilerPipelineConfig): void {
  if (!Array.isArray(config.passes) || config.passes.length === 0) {
    throw new CompilerError(
      "compiler-config",
      "the pipeline requires a non-empty ordered pass list",
    );
  }
  const seen = new Set<string>();
  for (const passId of config.passes) {
    if (!(COMPILER_PASS_IDS as readonly string[]).includes(passId)) {
      throw new CompilerError(
        "compiler-config",
        "the pipeline names a pass outside the closed catalog",
        {
          passId: bounded(passId),
        },
      );
    }
    if (seen.has(passId)) {
      // A duplicated pass makes the effective ordering ambiguous —
      // rejected as a non-determinism hazard, never silently deduped.
      throw new CompilerError("compiler-config", "the pipeline must not repeat a pass", {
        passId: bounded(passId),
      });
    }
    seen.add(passId);
  }
  if (
    !Number.isInteger(config.maxRounds) ||
    config.maxRounds < 1 ||
    config.maxRounds > MAX_PIPELINE_ROUNDS_HARD
  ) {
    throw new CompilerError("compiler-config", "maxRounds must be an integer in [1, 16]", {
      maxRounds: config.maxRounds as number,
    });
  }
  if (
    !Number.isFinite(config.qualityThreshold) ||
    config.qualityThreshold < 0 ||
    config.qualityThreshold > 1
  ) {
    throw new CompilerError("compiler-config", "qualityThreshold must be a probability in [0, 1]");
  }
  if (config.representationClaims !== undefined) {
    const { base, compiled } = config.representationClaims;
    for (const [side, candidate] of [
      ["base", base],
      ["compiled", compiled],
    ] as const) {
      if (typeof candidate.candidateId !== "string" || !CANDIDATE_ID.test(candidate.candidateId)) {
        throw new CompilerError(
          "compiler-config",
          `the ${side} ladder candidateId must be a lowercase slug`,
          {
            candidateId: bounded(candidate.candidateId),
          },
        );
      }
      if (
        typeof candidate.representationClass !== "string" ||
        candidate.representationClass.length === 0
      ) {
        throw new CompilerError(
          "compiler-config",
          `the ${side} ladder representationClass must be bounded`,
          {
            representationClass: bounded(candidate.representationClass),
          },
        );
      }
      // Bounded + attributed or the claim does not exist (WORK-049 rule).
      validateCostClaim(candidate.claim);
    }
    if (base.candidateId === compiled.candidateId) {
      throw new CompilerError("compiler-config", "ladder candidate ids must be distinct");
    }
  }
}
