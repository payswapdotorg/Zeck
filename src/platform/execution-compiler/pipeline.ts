/**
 * The deterministic compilation pipeline (platform execution-compiler
 * plane; WORK-050 / E1.1 charter stage 2).
 *
 * `compileExecutionIr` is the single engine entry point: a PURE
 * function of (input IR, constraints, configuration, digest) that
 * transforms a governed, validated Execution IR into an optimized IR
 * VARIANT through the closed pass catalog, with:
 *
 *  - BOUNDED ITERATION: the ordered passes re-run while the previous
 *    round applied a change, at most `maxRounds` rounds; a budget
 *    exhausted WITH changes still applying fails closed
 *    (`pipeline-unbounded`) — no unbounded fixpoints, no silent
 *    truncation;
 *  - TOTAL OUTPUT VALIDATION: EVERY pass output is validated through
 *    the WORK-049 invariant rules (`validateExecutionIrVariant` —
 *    the closed 12-code vocabulary) before it can become the pipeline
 *    state; a transformation whose output violates the invariants
 *    fails the whole compilation (`variant-invalid`) — never emitted;
 *  - SEMANTICS-PRESERVATION PROOF: every pass output's semantic core
 *    digest must EQUAL the running input's (`equivalence-violation`
 *    otherwise) — the proof, never an assumption;
 *  - DETERMINISM: the same (IR, constraints, configuration, digest)
 *    always produce the same output variant, the same trace and the
 *    same decision records, byte-identical (including tie-breaking —
 *    all orderings are content-canonical, never environmental);
 *  - the material representation decision (when ladder claims are
 *    configured) recorded through the WORK-049 evidence contract;
 *  - the full bounded pass trace with per-site typed rejections,
 *    digest-chained into the output variant's provenance
 *    (`passTraceDigest`) — replayable by deterministic re-compilation.
 *
 * The pipeline holds NO state, implements NO store, creates NO
 * authority: decision records are returned as values; their durable
 * append is the caller's seam through the existing WORK-049 store.
 */

import { validateConstraintSet } from "../execution-ir/constraints";
import { representationLadderRank, selectCandidate } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { validateExecutionIr } from "../execution-ir/ir";
import type { CompileExecutionIrInput, CompilerPassId, RepresentationClaims } from "./catalog";
import { CompilerError, validatePipelineConfig } from "./catalog";
import { buildLadderDecision } from "./decisions";
import type { PassOutcome, SiteRejection } from "./passes";
import { applyRepresentationLadderHooks, isLadderPass, runCatalogPass } from "./passes";
import { verifySemanticsPreservation } from "./semantics";
import type { ExecutionIrVariant } from "./variant";
import { validateExecutionIrVariant, variantFromIr } from "./variant";

// ---------------------------------------------------------------------------
// The compilation trace (bounded, digest-chained)
// ---------------------------------------------------------------------------

/** One pass application record (bounded evidence, no payloads). */
export interface PassApplicationRecord {
  readonly round: number;
  readonly passId: CompilerPassId;
  readonly status: "applied" | "noop";
  readonly sitesConsidered: number;
  readonly sitesApplied: number;
  readonly rejections: readonly SiteRejection[];
}

/** The full compilation result. */
export interface CompilationResult {
  /** The validated, optimized output variant (the compiled IR). */
  readonly output: ExecutionIrVariant;
  /** The identity variant the compilation started from. */
  readonly inputVariant: ExecutionIrVariant;
  /** True when at least one transformation changed the IR. */
  readonly changed: boolean;
  /** The bounded pass-application trace, in execution order. */
  readonly trace: readonly PassApplicationRecord[];
  /** sha256 over the canonical trace form. */
  readonly traceDigest: string;
  /** The rounds actually executed (bounded by maxRounds). */
  readonly roundsExecuted: number;
  /** The material representation decision record (WORK-049 format). */
  readonly decisionRecord: OptimizationDecisionRecord | null;
  /** The ladder selection outcome evidence. */
  readonly ladderOutcome: "selected" | "no-admissible-candidate" | "no-claims";
  /** The semantic core digests (equal — the equivalence proof). */
  readonly semanticCore: {
    readonly inputDigest: string;
    readonly outputDigest: string;
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Compile a governed, validated Execution IR into an optimized IR
 * variant through the closed pass catalog. Pure and total (every
 * failure is a typed `CompilerError` or an `IrValidationError` naming
 * a closed-vocabulary invariant; nothing is emitted on failure).
 */
export function compileExecutionIr(input: CompileExecutionIrInput): CompilationResult {
  // 1. Validate the inputs (fail closed before anything runs).
  const ir = validateExecutionIr(input.ir, input.digest);
  const constraints = validateConstraintSet(input.constraints);
  validatePipelineConfig(input.config);
  const claims = input.config.representationClaims;
  if (claims !== undefined) {
    if (constraints.length === 0) {
      throw new CompilerError(
        "compiler-config",
        "representation claims require the governing constraints (a decision without its governing inputs is unprovenanced optimization)",
      );
    }
    if (input.decisionScope === undefined || input.recordedAt === undefined) {
      throw new CompilerError(
        "compiler-config",
        "representation claims require the decision scope and the explicit recordedAt input",
      );
    }
  }

  // 2. The identity variant (the untransformed starting state — its
  //    plan form is byte-identical to the IR's, so variantPlanId IS
  //    the governed planId: the faithful container proof).
  const inputVariant = variantFromIr(ir, input.digest);

  // 3. Bounded rounds over the ordered passes.
  const trace: PassApplicationRecord[] = [];
  let current = inputVariant;
  let changed = false;
  let round = 0;
  let converged = false;

  while (round < input.config.maxRounds && !converged) {
    round += 1;
    let roundChanged = false;
    // The ladder pass runs ONCE, in its configured position, with the
    // selection facts (the decision record is built over the FINAL
    // variant afterwards — see step 4). A second encounter (later
    // round) is a guarded no-op (annotation already present).
    let ladderHandled = false;

    for (const passId of input.config.passes) {
      let outcome: PassOutcome;
      if (isLadderPass(passId)) {
        if (ladderHandled) {
          continue;
        }
        ladderHandled = true;
        // Selection facts: when claims are configured, the SELECTION
        // is computed from the claims + threshold here (the record is
        // built after the final variant exists — the annotation never
        // references the record's identity, so no cycle; the record's
        // candidates reference the final variant's identity).
        const selection = ladderSelectionFacts(input);
        outcome = applyRepresentationLadderHooks(
          {
            variant: current,
            constraints,
            digest: input.digest,
            traceDigest: current.provenance.passTraceDigest,
          },
          selection,
        );
      } else {
        outcome = runCatalogPass(passId, {
          variant: current,
          constraints,
          digest: input.digest,
          traceDigest: current.provenance.passTraceDigest,
        });
      }

      if (outcome.status === "applied") {
        // Total output validation: the transformed variant must pass
        // EVERY WORK-049 invariant rule plus both identity digests.
        let validated: ExecutionIrVariant;
        try {
          validated = validateExecutionIrVariant(outcome.output, input.digest);
        } catch (error) {
          throw new CompilerError(
            "variant-invalid",
            "a transformation output failed the IR invariant validation",
            {
              passId,
              round,
              invariant: error instanceof Error ? error.message : String(error),
            },
          );
        }
        // Semantics-preservation proof: the semantic core digest must
        // be unchanged by the transformation.
        const verdict = verifySemanticsPreservation(current, validated, input.digest);
        if (!verdict.ok) {
          throw new CompilerError(
            "equivalence-violation",
            "a transformation output failed the semantics-preservation proof (semantic core digest or provenance chain drifted)",
            {
              passId,
              round,
              inputCoreDigest: verdict.inputCoreDigest,
              outputCoreDigest: verdict.outputCoreDigest,
            },
          );
        }
        current = validated;
        roundChanged = true;
        changed = true;
      }
      trace.push({
        round,
        passId,
        status: outcome.status,
        sitesConsidered: outcome.sitesConsidered,
        sitesApplied: outcome.sitesApplied,
        rejections: outcome.rejections,
      });
    }

    if (!roundChanged) {
      converged = true;
    } else if (round >= input.config.maxRounds) {
      // The budget was exhausted while transformations were still
      // applying — the fixpoint is NOT proven. Fail closed.
      throw new CompilerError(
        "pipeline-unbounded",
        "the bounded iteration budget was exhausted while transformations were still applying (convergence is not proven — nothing is emitted)",
        { maxRounds: input.config.maxRounds, lastRound: round },
      );
    }
  }
  if (!converged) {
    throw new CompilerError(
      "pipeline-unbounded",
      "the pipeline did not converge within the bounded budget",
      {
        maxRounds: input.config.maxRounds,
      },
    );
  }

  // 4. The material representation decision (claims configured):
  //    evaluated and recorded through the WORK-049 evidence contract
  //    over the FINAL variant. Below-threshold candidates are invalid
  //    (no record, typed ladder outcome — never a cheap-but-insufficient
  //    selection).
  let decisionRecord: CompilationResult["decisionRecord"] = null;
  let ladderOutcome: CompilationResult["ladderOutcome"] = "no-claims";
  if (claims !== undefined) {
    const decision = buildLadderDecision({
      ir,
      constraints,
      claims,
      qualityThreshold: input.config.qualityThreshold,
      variantIrId: current.variantIrId,
      inputIrId: ir.irId,
      changed,
      appliedPasses: trace
        .filter((entry) => entry.status === "applied")
        .map((entry) => entry.passId),
      traceDigest: current.provenance.passTraceDigest,
      applicationId: input.decisionScope?.applicationId ?? "",
      tenantId: input.decisionScope?.tenantId ?? "",
      ...(input.decisionScope?.executionId === undefined
        ? {}
        : { executionId: input.decisionScope.executionId }),
      recordedAt: input.recordedAt ?? "",
      digest: input.digest,
    });
    if (decision.decisionRecord !== null) {
      decisionRecord = decision.decisionRecord;
      ladderOutcome = "selected";
    } else {
      ladderOutcome = "no-admissible-candidate";
    }
  }

  // 5. The final equivalence re-verification (belt and braces: the
  //    same proof, once more over the whole compilation).
  const finalVerdict = verifySemanticsPreservation(inputVariant, current, input.digest);
  if (!finalVerdict.ok) {
    throw new CompilerError(
      "equivalence-violation",
      "the final output failed the semantics-preservation proof",
      {
        inputCoreDigest: finalVerdict.inputCoreDigest,
        outputCoreDigest: finalVerdict.outputCoreDigest,
      },
    );
  }

  return {
    output: current,
    inputVariant,
    changed,
    trace,
    traceDigest: current.provenance.passTraceDigest,
    roundsExecuted: round,
    decisionRecord,
    ladderOutcome,
    semanticCore: {
      inputDigest: finalVerdict.inputCoreDigest,
      outputDigest: finalVerdict.outputCoreDigest,
    },
  };
}

/**
 * The ladder selection facts (computed from the configured claims —
 * hooks only; the recorded facts ride the annotation, never a live
 * selection). Returns null when no claims are configured or no
 * candidate is admissible.
 */
function ladderSelectionFacts(input: CompileExecutionIrInput): {
  readonly selectedCandidateId: string;
  readonly representationClass: string;
  readonly ladderRank: number;
  readonly qualityThreshold: number;
} | null {
  const claims: RepresentationClaims | undefined = input.config.representationClaims;
  if (claims === undefined) {
    return null;
  }
  // The selection is over the CLAIMS ONLY at this point (the decision
  // record over the final variant follows in step 4): evaluate both
  // configured claims through the WORK-049 cost model.
  const selection = selectCandidate(
    [
      {
        candidateId: claims.base.candidateId,
        representationClass: claims.base.representationClass as CandidateRepresentationClass,
        claim: claims.base.claim,
      },
      {
        candidateId: claims.compiled.candidateId,
        representationClass: claims.compiled.representationClass as CandidateRepresentationClass,
        claim: claims.compiled.claim,
      },
    ],
    input.config.qualityThreshold,
  );
  const selected = selection.selected;
  if (selected === null) {
    return null;
  }
  return {
    selectedCandidateId: selected.candidateId,
    representationClass: selected.representationClass,
    ladderRank: representationLadderRank(selected.representationClass),
    qualityThreshold: input.config.qualityThreshold,
  };
}

type CandidateRepresentationClass = Parameters<
  typeof selectCandidate
>[0][number]["representationClass"];
