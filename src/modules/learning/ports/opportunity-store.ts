/**
 * Opportunity store port (learning module outbound; WORK-022).
 *
 * The durable seam of the codebase-opportunity analysis: analyses,
 * findings, evaluation prompts, evaluation ratings and finding
 * transitions (migration 0016).
 *
 * THE WRITTEN SHAPES (the physical twins live in the SQL migration):
 *  - analyses are immutable, ONE per analysis execution (UNIQUE
 *    execution_id — the Analysis-is-an-Execution binding), with
 *    repository/revision provenance;
 *  - findings are inserted in state 'advisory' only; the ONLY state
 *    write is the forward transition append (rating / verified-
 *    equivalence — the domain validates, the SQL trigger enforces);
 *  - prompts satisfy the strict value-of-information inequality
 *    PHYSICALLY (gain > friction threshold — M24);
 *  - ratings are immutable preference-only evidence;
 *  - there is NO delete surface and NO history rewrite surface.
 *
 * Every read is scope-filtered (application + tenant): cross-tenant /
 * cross-application rows are unreachable (M1/M26).
 */

import type { EvaluationRatingRecord } from "../domain/evaluation-rating";
import type { FindingTransitionRecord } from "../domain/finding-transitions";
import type { EvaluationPrompt } from "../domain/human-evaluation";
import type { OpportunityAnalysis, OpportunityFinding } from "../domain/opportunity-analysis";

export interface OpportunityScope {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface AnalysisInsertOutcome {
  readonly analysisId: string;
  readonly replayed: boolean;
}

export interface FindingInsertOutcome {
  readonly findingId: string;
  readonly replayed: boolean;
}

export interface RatingInsertOutcome {
  readonly ratingId: string;
  readonly replayed: boolean;
}

export interface TransitionAppendOutcome {
  readonly transitionId: string;
  readonly replayed: boolean;
}

export interface OpportunityStore {
  /** Insert one immutable analysis (converges on the execution binding). */
  insertAnalysis(
    analysis: OpportunityAnalysis,
    fingerprint: string,
  ): Promise<AnalysisInsertOutcome>;

  /** Read one analysis (scope-checked — cross-tenant returns null). */
  getAnalysis(scope: OpportunityScope, analysisId: string): Promise<OpportunityAnalysis | null>;

  /** List the scope's analyses (newest first). */
  listAnalyses(scope: OpportunityScope): Promise<readonly OpportunityAnalysis[]>;

  /** Read the analysis bound to one analysis execution (the idempotency anchor). */
  getAnalysisByExecution(
    scope: OpportunityScope,
    executionId: string,
  ): Promise<OpportunityAnalysis | null>;

  /** Insert one finding (state 'advisory'; converges on the finding id). */
  insertFinding(finding: OpportunityFinding): Promise<FindingInsertOutcome>;

  /** Read one finding (scope-checked). */
  getFinding(scope: OpportunityScope, findingId: string): Promise<OpportunityFinding | null>;

  /** List an analysis's findings. */
  listFindings(scope: OpportunityScope, analysisId: string): Promise<readonly OpportunityFinding[]>;

  /** Insert one evaluation prompt (immutable append). */
  insertPrompt(prompt: EvaluationPrompt): Promise<{ readonly replayed: boolean }>;

  /** List an analysis's prompts. */
  listPrompts(scope: OpportunityScope, analysisId: string): Promise<readonly EvaluationPrompt[]>;

  /** Insert one immutable evaluation rating (converges on the rating identity). */
  insertEvaluationRating(
    rating: EvaluationRatingRecord,
    fingerprint: string,
  ): Promise<RatingInsertOutcome>;

  /** List an analysis's ratings. */
  listRatings(
    scope: OpportunityScope,
    analysisId: string,
  ): Promise<readonly EvaluationRatingRecord[]>;

  /**
   * Append the finding-transition journal row AND advance the finding
   * state (one operation — the store keeps them coupled exactly like
   * the SQL trigger couples them).
   */
  appendFindingTransition(transition: FindingTransitionRecord): Promise<TransitionAppendOutcome>;

  /** List a finding's transition history. */
  listFindingTransitions(
    scope: OpportunityScope,
    findingId: string,
  ): Promise<readonly FindingTransitionRecord[]>;
}
