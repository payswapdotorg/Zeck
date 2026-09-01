/**
 * In-memory opportunity store (learning module adapter; WORK-022).
 *
 * Reference-semantics twin of `SqlOpportunityStore` (migration 0016):
 * faithful to the durable contract the SQL adapter implements —
 * immutable rows (no rewrite surface), the insert-state guard
 * (findings are born advisory), the forward-only evidence-gated state
 * transitions, the rating identity convergence (same fingerprint
 * replays; conflicts fail closed `IDEMPOTENCY_KEY_REUSED`) and the
 * analysis execution-binding arbitration.
 *
 * True concurrency cannot be simulated here — the real-PostgreSQL
 * suites own those proofs (the WORK-014/WORK-017 precedent).
 */

import { PlatformError } from "../../../shared/errors";
import type { EvaluationRatingRecord } from "../domain/evaluation-rating";
import type { FindingTransitionRecord } from "../domain/finding-transitions";
import type { EvaluationPrompt } from "../domain/human-evaluation";
import type { OpportunityAnalysis, OpportunityFinding } from "../domain/opportunity-analysis";
import type { OpportunityScope, OpportunityStore } from "../ports/opportunity-store";

export interface InMemoryOpportunityStore extends OpportunityStore {
  /** Direct row access for test assertions only. */
  readonly rows: {
    readonly analyses: readonly OpportunityAnalysis[];
    readonly findings: readonly OpportunityFinding[];
    readonly prompts: readonly EvaluationPrompt[];
    readonly ratings: readonly EvaluationRatingRecord[];
    readonly transitions: readonly FindingTransitionRecord[];
  };
}

export function createInMemoryOpportunityStore(): InMemoryOpportunityStore {
  const analyses = new Map<string, OpportunityAnalysis>();
  const analysesByExecution = new Map<string, string>();
  const analysisFingerprints = new Map<string, string>();
  const findings = new Map<string, OpportunityFinding>();
  const prompts = new Map<string, EvaluationPrompt>();
  const ratings = new Map<string, EvaluationRatingRecord>();
  const ratingFingerprints = new Map<string, string>();
  const transitions = new Map<string, FindingTransitionRecord>();

  const scopeOf = (record: { applicationId: string; tenantId: string }): string =>
    `${record.applicationId}:${record.tenantId}`;

  const scopeMatches = (
    record: { applicationId: string; tenantId: string },
    scope: OpportunityScope,
  ): boolean => scopeOf(record) === `${scope.applicationId}:${scope.tenantId}`;

  return {
    rows: {
      get analyses(): readonly OpportunityAnalysis[] {
        return [...analyses.values()];
      },
      get findings(): readonly OpportunityFinding[] {
        return [...findings.values()];
      },
      get prompts(): readonly EvaluationPrompt[] {
        return [...prompts.values()];
      },
      get ratings(): readonly EvaluationRatingRecord[] {
        return [...ratings.values()];
      },
      get transitions(): readonly FindingTransitionRecord[] {
        return [...transitions.values()];
      },
    },

    async insertAnalysis(analysis, fingerprint) {
      const existingId = analysesByExecution.get(`${scopeOf(analysis)}:${analysis.executionId}`);
      if (existingId === undefined) {
        analyses.set(analysis.analysisId, analysis);
        analysesByExecution.set(
          `${scopeOf(analysis)}:${analysis.executionId}`,
          analysis.analysisId,
        );
        analysisFingerprints.set(analysis.analysisId, fingerprint);
        return { analysisId: analysis.analysisId, replayed: false };
      }
      const existing = analyses.get(existingId);
      if (existing !== undefined && analysisFingerprints.get(existingId) === fingerprint) {
        return { analysisId: existingId, replayed: true };
      }
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "the analysis execution already carries a DIFFERENT analysis (the execution binding is one authoritative analysis)",
        details: { executionId: analysis.executionId },
      });
    },

    async getAnalysis(scope, analysisId) {
      const analysis = analyses.get(analysisId);
      return analysis !== undefined && scopeMatches(analysis, scope) ? analysis : null;
    },

    async getAnalysisByExecution(scope, executionId) {
      const id = analysesByExecution.get(`${scope.applicationId}:${scope.tenantId}:${executionId}`);
      const analysis = id === undefined ? undefined : analyses.get(id);
      return analysis !== undefined && scopeMatches(analysis, scope) ? analysis : null;
    },

    async listAnalyses(scope) {
      return [...analyses.values()]
        .filter((analysis) => scopeMatches(analysis, scope))
        .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
    },

    async insertFinding(finding) {
      // The insert-state guard (the migration trigger twin): findings
      // are born advisory only.
      if (finding.state !== "advisory") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `findings are born advisory only (state ${finding.state} is not insertable)`,
        });
      }
      const replayed = findings.has(finding.findingId);
      findings.set(finding.findingId, finding);
      return { findingId: finding.findingId, replayed };
    },

    async getFinding(scope, findingId) {
      const finding = findings.get(findingId);
      return finding !== undefined && scopeMatches(finding, scope) ? finding : null;
    },

    async listFindings(scope, analysisId) {
      return [...findings.values()]
        .filter((finding) => scopeMatches(finding, scope) && finding.analysisId === analysisId)
        .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
    },

    async insertPrompt(prompt) {
      const replayed = prompts.has(prompt.promptId);
      prompts.set(prompt.promptId, prompt);
      return { replayed };
    },

    async listPrompts(scope, analysisId) {
      return [...prompts.values()]
        .filter((prompt) => scopeMatches(prompt, scope) && prompt.analysisId === analysisId)
        .sort((a, b) => (a.emittedAt < b.emittedAt ? -1 : 1));
    },

    async insertEvaluationRating(rating, fingerprint) {
      const identity = `${rating.findingId}:${rating.rater}:${rating.questionKind}`;
      const existing = ratings.get(identity);
      if (existing === undefined) {
        ratings.set(identity, rating);
        ratingFingerprints.set(identity, fingerprint);
        return { ratingId: rating.ratingId, replayed: false };
      }
      if (ratingFingerprints.get(identity) === fingerprint) {
        return { ratingId: existing.ratingId, replayed: true };
      }
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "the rater already answered this question for this finding (immutable evidence — a conflicting re-rating fails closed)",
        details: { findingId: rating.findingId, rater: rating.rater },
      });
    },

    async listRatings(scope, analysisId) {
      return [...ratings.values()]
        .filter((rating) => scopeMatches(rating, scope) && rating.analysisId === analysisId)
        .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
    },

    async appendFindingTransition(transition) {
      const replayed = transitions.has(transition.transitionId);
      transitions.set(transition.transitionId, transition);
      if (replayed) {
        return { transitionId: transition.transitionId, replayed: true };
      }
      // The forward-only guarded state advance (the migration trigger
      // twin): the journal row must exist (it does — just appended)
      // and the edge must be a legal single-step forward edge.
      const finding = findings.get(transition.findingId);
      if (finding === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "transition finding does not exist",
        });
      }
      const legal =
        (finding.state === "advisory" && transition.toState === "candidate") ||
        (finding.state === "candidate" && transition.toState === "verified");
      if (!legal || finding.state !== transition.fromState) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `illegal finding state advance ${finding.state} -> ${transition.toState} (forward single-step only)`,
        });
      }
      findings.set(transition.findingId, { ...finding, state: transition.toState });
      return { transitionId: transition.transitionId, replayed: false };
    },

    async listFindingTransitions(scope, findingId) {
      return [...transitions.values()]
        .filter(
          (transition) => scopeMatches(transition, scope) && transition.findingId === findingId,
        )
        .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
    },
  };
}
