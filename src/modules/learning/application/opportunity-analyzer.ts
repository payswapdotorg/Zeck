/**
 * The opportunity analyzer service (learning module application;
 * WORK-022 / DTR-005, HUM-001..003; ADR-0008, ADR-0010).
 *
 * THE ADVISORY analysis service:
 *
 * ```text
 *   analyzeSubgraph:
 *     customer-selected subgraph (validated, provenance-pinned)
 *       -> buildExecutionGraph (§6 normalized representation)
 *       -> detectOpportunities (§8 classes, §9 evidence rules)
 *       -> classify confidence (§15/M13) + honest impact (§11/M22/M23)
 *       -> decideEvaluationPrompts (§12/§13 value of information)
 *       -> persist analysis + findings + prompts (immutable, tenant-
 *          scoped, execution-bound)
 *
 *   recordEvaluationRating:
 *     a human/developer rating on a finding pair — immutable
 *     evaluation evidence bound to the analysis execution + the
 *     analyzed source revision (§14; M9/M10/M27/M28)
 *
 *   advanceFinding:
 *     the ONLY state write: advisory -> candidate (rating evidence) ->
 *     verified (verified-equivalence evidence) — single-step forward,
 *     never promoted here (§18)
 * ```
 *
 * LEARNING-NONAUTHORITY (the frozen §10 invariant, preserved): this
 * service's deps are store + digest + id generator + clock ONLY — the
 * exact WORK-014 non-authoritative quartet. There is no policy seam,
 * no capability seam, no budget seam, no execution seam, no sandbox
 * seam and no dispatch surface here or anywhere in this module. THE
 * ANALYSIS EXECUTION GOVERNANCE LIVES OUTSIDE: "Analysis is an
 * Execution" is enforced by the API composition (src/api/routes/
 * codebase-analysis.ts), which routes every analysis through the
 * executions authority's public create/transition contract (policy
 * admission through the REQUIRED authorization port) BEFORE this
 * service touches anything. This service CANNOT execute customer
 * code, CANNOT access repositories itself (the subgraph is
 * caller-supplied, read-only data), CANNOT mutate anything outside
 * its own immutable evidence tables.
 *
 * IDEMPOTENCY (§10 discipline): the analysis durable identity is the
 * analysis EXECUTION binding (UNIQUE execution_id — migration 0016):
 * retries with the same request basis CONVERGE (replayed); the same
 * execution with a DIFFERENT analysis fingerprint fails closed
 * (`IDEMPOTENCY_KEY_REUSED`). Rating identity is
 * (finding_id, rater, question_kind): duplicates converge, conflicts
 * fail closed.
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type { EvaluationRatingRecord } from "../domain/evaluation-rating";
import {
  evaluationRatingFingerprintBasis,
  validateEvaluationRating,
} from "../domain/evaluation-rating";
import type { SelectedSubgraph } from "../domain/execution-graph";
import { buildExecutionGraph, type ExecutionGraph } from "../domain/execution-graph";
import type { FindingTransitionRecord } from "../domain/finding-transitions";
import {
  FINDING_TRANSITION_SCHEMA_VERSION,
  validateFindingTransition,
  validateFindingTransitionRecord,
} from "../domain/finding-transitions";
import type { EvaluationPrompt } from "../domain/human-evaluation";
import {
  DEFAULT_FRICTION_CONFIG,
  decideEvaluationPrompts,
  EVALUATION_PROMPT_SCHEMA_VERSION,
  type FrictionConfig,
  validateEvaluationPrompt,
} from "../domain/human-evaluation";
import type { OpportunityAnalysis, OpportunityFinding } from "../domain/opportunity-analysis";
import {
  buildFindings,
  OPPORTUNITY_ANALYSIS_SCHEMA_VERSION,
  OPPORTUNITY_ANALYSIS_VERSION,
  opportunityAnalysisDigestBasis,
  validateOpportunityFinding,
} from "../domain/opportunity-analysis";
import type { DigestPort } from "../ports/digest";
import type { OpportunityStore } from "../ports/opportunity-store";

export interface OpportunityAnalyzerDeps {
  readonly store: OpportunityStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface AnalyzeSubgraphRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * The analysis EXECUTION id (MANDATORY): the executions authority
   * created and policy-admitted this execution BEFORE the analysis
   * runs (Analysis is an Execution — the route composes the
   * authorities; M2/M26).
   */
  readonly executionId: string;
  /** The selected source (repository + revision — M11/M12). */
  readonly source: { readonly repository: string; readonly revision: string };
  /** The customer-selected subgraph (§7 — exactly the selection). */
  readonly subgraph: SelectedSubgraph;
  /** The friction configuration (defaults when absent — §13). */
  readonly friction?: {
    readonly userFrictionThreshold?: number;
    readonly maxPrompts?: number;
  };
}

export type RecordEvaluationRatingInput = Omit<EvaluationRatingRecord, "ratingId" | "recordedAt">;

export interface AdvanceFindingRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly findingId: string;
  readonly toState: string;
  readonly evidenceKind: string;
  readonly evidenceRefs: readonly string[];
  readonly verifiedEquivalence?: unknown;
  readonly requestedBy: string;
}

export interface ConsultOpportunitySignalsRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict to one repository (optional). */
  readonly repository?: string;
  /** Restrict to one opportunity class (optional). */
  readonly class?: string;
  readonly analysisId?: string;
}

/**
 * The READ-seam projection: a finding as a validated non-authoritative
 * signal carrying its full version/provenance anchors (M11/M12/M13 —
 * the consumer-side boundary twin of the composition signals).
 */
export interface OpportunitySignal {
  readonly signalClass: "non-authoritative-opportunity-finding";
  readonly findingId: string;
  readonly analysisId: string;
  readonly analysisVersion: number;
  readonly class: OpportunityFinding["class"];
  readonly state: OpportunityFinding["state"];
  readonly confidenceLevel: string;
  readonly population: number;
  readonly repository: string;
  readonly revision: string;
  readonly targetNodeIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly costImpactBasis: string;
  readonly latencyImpactBasis: string;
  readonly deterministicEquivalencePotential: string;
}

export interface OpportunityAnalyzer {
  analyzeSubgraph(request: AnalyzeSubgraphRequest): Promise<{
    readonly analysis: OpportunityAnalysis;
    readonly findings: readonly OpportunityFinding[];
    readonly prompts: readonly EvaluationPrompt[];
    readonly replayed: boolean;
  }>;
  getAnalysis(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly analysisId: string;
  }): Promise<{
    readonly analysis: OpportunityAnalysis;
    readonly findings: readonly OpportunityFinding[];
    readonly prompts: readonly EvaluationPrompt[];
    readonly ratings: readonly EvaluationRatingRecord[];
  }>;
  recordEvaluationRating(input: RecordEvaluationRatingInput): Promise<{
    readonly ratingId: string;
    readonly findingId: string;
    readonly replayed: boolean;
    readonly fingerprint: string;
    readonly answer: EvaluationRatingRecord["answer"];
  }>;
  advanceFinding(request: AdvanceFindingRequest): Promise<{
    readonly transition: FindingTransitionRecord;
    readonly replayed: boolean;
  }>;
  consultOpportunitySignals(
    request: ConsultOpportunitySignalsRequest,
  ): Promise<readonly OpportunitySignal[]>;
}

export function createOpportunityAnalyzer(deps: OpportunityAnalyzerDeps): OpportunityAnalyzer {
  const digestOf = (value: unknown): string => deps.digest.sha256Hex(canonicalJson(value));

  const requireScope = (request: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): void => {
    if (
      typeof request.applicationId !== "string" ||
      request.applicationId.length === 0 ||
      typeof request.tenantId !== "string" ||
      request.tenantId.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "applicationId and tenantId are required (tenant scope is never dropped, M26)",
      });
    }
  };

  const resolveFriction = (request: AnalyzeSubgraphRequest): FrictionConfig => {
    const threshold =
      request.friction?.userFrictionThreshold ?? DEFAULT_FRICTION_CONFIG.userFrictionThreshold;
    const maxPrompts = request.friction?.maxPrompts ?? DEFAULT_FRICTION_CONFIG.maxPrompts;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "userFrictionThreshold must be a number in (0,1)",
        details: { got: threshold },
      });
    }
    if (!Number.isInteger(maxPrompts) || maxPrompts < 1 || maxPrompts > 64) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "maxPrompts must be an integer in [1,64]",
        details: { got: maxPrompts },
      });
    }
    return { userFrictionThreshold: threshold, maxPrompts };
  };

  return {
    async analyzeSubgraph(request) {
      requireScope(request);
      if (typeof request.executionId !== "string" || request.executionId.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "executionId is required: an analysis is bound to an executions-authority execution (Analysis is an Execution — M2/M26)",
        });
      }
      const friction = resolveFriction(request);
      const graph: ExecutionGraph = buildExecutionGraph({
        ...request.subgraph,
        source: request.source,
      });
      const recordedAt = deps.now().toISOString();
      const analysisId = deps.generateId();

      const findings = buildFindings({
        analysisId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        graph,
        generateFindingId: deps.generateId,
        recordedAt,
      });
      const promptDrafts = decideEvaluationPrompts(findings, friction);
      const prompts: EvaluationPrompt[] = promptDrafts.map((draft) => {
        const prompt: EvaluationPrompt = {
          promptId: deps.generateId(),
          analysisId,
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          findingId: draft.findingId,
          questionKind: draft.questionKind,
          question: draft.question,
          expectedInformationGain: draft.expectedInformationGain,
          userFrictionThreshold: draft.userFrictionThreshold,
          basis: [...draft.basis],
          emittedAt: recordedAt,
          schemaVersion: EVALUATION_PROMPT_SCHEMA_VERSION,
        };
        validateEvaluationPrompt(prompt);
        return prompt;
      });

      const analysisBasis: Omit<OpportunityAnalysis, "digest"> = {
        analysisId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        executionId: request.executionId,
        repository: graph.repository,
        revision: graph.revision,
        analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
        graph,
        friction,
        findingCount: findings.length,
        promptCount: prompts.length,
        recordedAt,
        schemaVersion: OPPORTUNITY_ANALYSIS_SCHEMA_VERSION,
      };
      const analysis: OpportunityAnalysis = {
        ...analysisBasis,
        digest: digestOf(opportunityAnalysisDigestBasis(analysisBasis)),
      };

      // The replay identity: the analysis basis (execution binding +
      // source + subgraph + ruleset version + friction).
      const fingerprint = digestOf({
        executionId: request.executionId,
        repository: request.source.repository,
        revision: request.source.revision,
        subgraphDigest: digestOf({
          nodes: graph.nodes.map((node) => ({
            nodeId: node.nodeId,
            kind: node.kind,
            provenance: { ...node.provenance },
            observation: { ...node.observation },
          })),
          edges: graph.edges.map((edge) => ({ ...edge })),
        }),
        analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
        friction,
      });

      for (const finding of findings) {
        validateOpportunityFinding(finding);
      }

      const outcome = await deps.store.insertAnalysis(analysis, fingerprint);
      if (outcome.replayed) {
        // Converge on the durable record for this analysis execution.
        const existing = await deps.store.getAnalysisByExecution(
          { applicationId: request.applicationId, tenantId: request.tenantId },
          request.executionId,
        );
        if (existing === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "analysis replay could not re-read the durable record",
          });
        }
        const existingFindings = await deps.store.listFindings(
          { applicationId: request.applicationId, tenantId: request.tenantId },
          existing.analysisId,
        );
        const existingPrompts = await deps.store.listPrompts(
          { applicationId: request.applicationId, tenantId: request.tenantId },
          existing.analysisId,
        );
        return {
          analysis: existing,
          findings: existingFindings,
          prompts: existingPrompts,
          replayed: true,
        };
      }

      for (const finding of findings) {
        await deps.store.insertFinding(finding);
      }
      for (const prompt of prompts) {
        await deps.store.insertPrompt(prompt);
      }
      return { analysis, findings, prompts, replayed: false };
    },

    async getAnalysis(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const analysis = await deps.store.getAnalysis(scope, request.analysisId);
      if (analysis === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "analysis not found within the application scope",
          details: { analysisId: request.analysisId },
        });
      }
      const [findings, prompts, ratings] = await Promise.all([
        deps.store.listFindings(scope, request.analysisId),
        deps.store.listPrompts(scope, request.analysisId),
        deps.store.listRatings(scope, request.analysisId),
      ]);
      return { analysis, findings, prompts, ratings };
    },

    async recordEvaluationRating(input) {
      requireScope(input);
      const rating: EvaluationRatingRecord = {
        ...input,
        ratingId: deps.generateId(),
        recordedAt: deps.now().toISOString(),
      };
      validateEvaluationRating(rating);
      const scope = {
        applicationId: rating.applicationId,
        tenantId: rating.tenantId,
      };
      // M27: the rating must bind to a REAL finding of THIS scope, and
      // the analysis/execution/context must match that finding.
      const finding = await deps.store.getFinding(scope, rating.findingId);
      if (finding === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "rating findingId does not resolve within the application scope (M27: wrong function/subgraph association is rejected)",
          details: { findingId: rating.findingId },
        });
      }
      if (finding.analysisId !== rating.analysisId) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "rating analysisId does not match the finding's analysis (M27)",
        });
      }
      const analysis = await deps.store.getAnalysis(scope, rating.analysisId);
      if (analysis === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "rating analysisId does not resolve within the application scope",
        });
      }
      if (analysis.executionId !== rating.executionId) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "rating executionId must be the analysis execution (ratings are attributable to the analyzed execution — §14)",
          details: { expected: analysis.executionId },
        });
      }
      if (rating.sourceRevision !== finding.provenance.revision) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "rating sourceRevision does not match the finding's analyzed revision (M28: stale revisions are rejected)",
          details: { expected: finding.provenance.revision, got: rating.sourceRevision },
        });
      }
      if (rating.context.repository !== finding.provenance.repository) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "rating context repository does not match the finding's repository (M27)",
        });
      }
      if (
        rating.counterpartFindingId !== null &&
        rating.counterpartFindingId === rating.findingId
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "rating counterpart must differ from the rated finding (a real candidate pair)",
        });
      }
      const fingerprint = digestOf(evaluationRatingFingerprintBasis(rating));
      const outcome = await deps.store.insertEvaluationRating(rating, fingerprint);
      return {
        ratingId: outcome.ratingId,
        findingId: rating.findingId,
        replayed: outcome.replayed,
        fingerprint,
        answer: rating.answer,
      };
    },

    async advanceFinding(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const finding = await deps.store.getFinding(scope, request.findingId);
      if (finding === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "finding not found within the application scope",
          details: { findingId: request.findingId },
        });
      }
      // The content-derived transition identity (the activation-journal
      // pattern): the same logical transition retries to the SAME id
      // and converges — idempotent by construction. The retry check
      // happens BEFORE the state legality validation because a replay
      // observes the finding ALREADY advanced to the target state (the
      // durable outcome the retry returns — exactly the executions
      // "replays re-read the current row" discipline).
      const transitionIdentity = (
        toState: string,
        evidenceKind: string,
        evidenceRefs: readonly string[],
        verifiedEquivalence: unknown,
        requestedBy: string,
      ): string =>
        digestOf({
          transitionSchema: FINDING_TRANSITION_SCHEMA_VERSION,
          findingId: finding.findingId,
          toState,
          evidenceKind,
          evidenceRefs: [...evidenceRefs],
          verifiedEquivalence: verifiedEquivalence ?? null,
          requestedBy,
        });
      const replayKey = transitionIdentity(
        request.toState,
        request.evidenceKind,
        request.evidenceRefs,
        request.verifiedEquivalence ?? null,
        request.requestedBy,
      );
      const existingRows = await deps.store.listFindingTransitions(scope, finding.findingId);
      const durable = existingRows.find((row) => row.transitionId === replayKey);
      if (durable !== undefined) {
        return { transition: durable, replayed: true };
      }
      // Rating evidence must RESOLVE to stored ratings on THIS finding
      // (M9/M16: fabricated evidence refs are rejected — a transition
      // cites real recorded evidence only).
      if (request.evidenceKind === "rating") {
        const analysisRatings = await deps.store.listRatings(scope, finding.analysisId);
        const findingRatingIds = new Set(
          analysisRatings
            .filter((candidate) => candidate.findingId === finding.findingId)
            .map((candidate) => candidate.ratingId),
        );
        const missing = request.evidenceRefs.filter((ref) => !findingRatingIds.has(ref));
        if (missing.length > 0) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "rating evidence references must resolve to recorded ratings on this finding (M16: evidence is never fabricated)",
            details: { missing },
          });
        }
      }
      const validated = validateFindingTransition({
        finding,
        toState: request.toState,
        evidenceKind: request.evidenceKind,
        evidenceRefs: request.evidenceRefs,
        verifiedEquivalence: request.verifiedEquivalence,
        requestedBy: request.requestedBy,
      });
      const transitionId = transitionIdentity(
        validated.toState,
        validated.evidenceKind,
        validated.evidenceRefs,
        validated.verifiedEquivalence,
        validated.requestedBy,
      );
      const transition: FindingTransitionRecord = {
        ...validated,
        transitionId,
        recordedAt: deps.now().toISOString(),
        schemaVersion: FINDING_TRANSITION_SCHEMA_VERSION,
      };
      validateFindingTransitionRecord(transition);
      const outcome = await deps.store.appendFindingTransition(transition);
      if (outcome.replayed) {
        const rows = await deps.store.listFindingTransitions(scope, finding.findingId);
        const row = rows.find((candidate) => candidate.transitionId === transitionId);
        if (row !== undefined) {
          return { transition: row, replayed: true };
        }
      }
      return { transition, replayed: false };
    },

    async consultOpportunitySignals(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const analysisId = request.analysisId;
      let analyses: readonly OpportunityAnalysis[];
      if (analysisId !== undefined) {
        const single = await deps.store.getAnalysis(scope, analysisId);
        analyses = single === null ? [] : [single];
      } else {
        analyses = await deps.store.listAnalyses(scope);
      }
      const signals: OpportunitySignal[] = [];
      for (const analysis of analyses) {
        if (request.repository !== undefined && analysis.repository !== request.repository) {
          continue;
        }
        const findings = await deps.store.listFindings(scope, analysis.analysisId);
        for (const finding of findings) {
          if (request.class !== undefined && finding.class !== request.class) {
            continue;
          }
          validateOpportunityFinding(finding);
          signals.push({
            signalClass: "non-authoritative-opportunity-finding",
            findingId: finding.findingId,
            analysisId: finding.analysisId,
            analysisVersion: analysis.analysisVersion,
            class: finding.class,
            state: finding.state,
            confidenceLevel: finding.confidence.level,
            population: finding.confidence.population,
            repository: finding.provenance.repository,
            revision: finding.provenance.revision,
            targetNodeIds: [...finding.targetNodeIds],
            reasonCodes: [...finding.reasonCodes],
            evidenceRefs: [...finding.evidenceRefs],
            costImpactBasis: finding.costImpact.basis,
            latencyImpactBasis: finding.latencyImpact.basis,
            deterministicEquivalencePotential: finding.deterministicEquivalence.potential,
          });
        }
      }
      return signals;
    },
  };
}
