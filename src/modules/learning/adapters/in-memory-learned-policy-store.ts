/**
 * In-memory learned-policy store (learning module adapter; WORK-020).
 *
 * The reference implementation of the `LearnedPolicyStore` port:
 * mirrors the EXACT durable semantics of the SQL store (migration
 * 0017) so unit tests prove the same invariants the real-PostgreSQL
 * suites prove physically:
 *
 *  - the telemetry population and the scorecard basis are read through
 *    the LEARNING store's read seams (the same physical history the
 *    SQL store reads — the learned-policy axis owns NO second
 *    population and NO second scorecard);
 *  - policy versions are append-only BY VERSION with UNIQUE
 *    (application, policy_version) arbitration — a taken version fails
 *    with `IDEMPOTENCY_KEY_REUSED` (the service's convergence signal);
 *    a re-append of the SAME policyId converges (replay); rows are
 *    never mutated or deleted (history is physical);
 *  - evaluation records are append-only: the same evaluationId
 *    converges (replay — content-derived identity);
 *  - the publication journal is append-only: the same publicationId
 *    converges (replay); the LATEST entry per scope is the active
 *    pointer (concurrent appends serialize by journal order);
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant rows are unreachable.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  LearnedPlanningPolicy,
  LearnedPolicyEvaluation,
  LearnedPolicyPublication,
} from "../domain/learned-planning-policy";
import type {
  EvaluationAppendOutcome,
  LearnedPolicyScope,
  LearnedPolicyStore,
  PublicationAppendOutcome,
} from "../ports/learned-policy-store";
import type { LearningStore } from "../ports/learning-store";

export interface InMemoryLearnedPolicyStore extends LearnedPolicyStore {
  /** Test/inspection helper: the durable policy-version count. */
  readonly policyCount: () => number;
  /** Test/inspection helper: the evaluation-record count. */
  readonly evaluationCount: () => number;
  /** Test/inspection helper: the publication journal length. */
  readonly publicationCount: () => number;
}

/** The read seams of the learning store this adapter delegates to. */
export type LearningReadSource = Pick<LearningStore, "listTelemetry" | "getLatestScorecard">;

export function createInMemoryLearnedPolicyStore(
  learningSource?: LearningReadSource,
): InMemoryLearnedPolicyStore {
  const policiesByApplication = new Map<string, LearnedPlanningPolicy[]>();
  const policiesById = new Map<string, LearnedPlanningPolicy>();
  const evaluationsById = new Map<string, LearnedPolicyEvaluation>();
  const publicationsByApplication = new Map<string, LearnedPolicyPublication[]>();

  const policiesOf = (applicationId: string): LearnedPlanningPolicy[] => {
    let list = policiesByApplication.get(applicationId);
    if (list === undefined) {
      list = [];
      policiesByApplication.set(applicationId, list);
    }
    return list;
  };

  const publicationsOf = (applicationId: string): LearnedPolicyPublication[] => {
    let list = publicationsByApplication.get(applicationId);
    if (list === undefined) {
      list = [];
      publicationsByApplication.set(applicationId, list);
    }
    return list;
  };

  return {
    policyCount: () => policiesById.size,
    evaluationCount: () => evaluationsById.size,
    publicationCount: () =>
      [...publicationsByApplication.values()].reduce((sum, list) => sum + list.length, 0),

    async listTelemetry(query) {
      if (learningSource === undefined) {
        return [];
      }
      return learningSource.listTelemetry(query);
    },

    async getLatestScorecard(scope) {
      if (learningSource === undefined) {
        return null;
      }
      return learningSource.getLatestScorecard({
        applicationId: scope.applicationId,
        tenantId: scope.tenantId,
        definitionId: scope.definitionId,
      });
    },

    async insertLearnedPolicy(policy) {
      const existingById = policiesById.get(policy.policyId);
      if (existingById !== undefined) {
        return { replayed: true };
      }
      const list = policiesOf(policy.applicationId);
      if (list.some((existing) => existing.policyVersion === policy.policyVersion)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "learned policy version already exists (version arbitration)",
          details: { applicationId: policy.applicationId, policyVersion: policy.policyVersion },
        });
      }
      list.push(policy);
      policiesById.set(policy.policyId, policy);
      return { replayed: false };
    },

    async getLatestLearnedPolicy(scope: LearnedPolicyScope) {
      const list = policiesOf(scope.applicationId).filter(
        (policy) => policy.tenantId === scope.tenantId,
      );
      if (list.length === 0) {
        return null;
      }
      return list.reduce((latest, policy) =>
        policy.policyVersion > latest.policyVersion ? policy : latest,
      );
    },

    async getLearnedPolicy(scope: LearnedPolicyScope, policyId: string) {
      const found = policiesById.get(policyId);
      if (
        found === undefined ||
        found.applicationId !== scope.applicationId ||
        found.tenantId !== scope.tenantId
      ) {
        return null;
      }
      return found;
    },

    async insertLearnedPolicyEvaluation(evaluation) {
      const existing = evaluationsById.get(evaluation.evaluationId);
      if (existing !== undefined) {
        const outcome: EvaluationAppendOutcome = {
          evaluationId: evaluation.evaluationId,
          replayed: true,
        };
        return outcome;
      }
      evaluationsById.set(evaluation.evaluationId, evaluation);
      return { evaluationId: evaluation.evaluationId, replayed: false };
    },

    async getLearnedPolicyEvaluation(scope: LearnedPolicyScope, evaluationId: string) {
      const found = evaluationsById.get(evaluationId);
      if (
        found === undefined ||
        found.applicationId !== scope.applicationId ||
        found.tenantId !== scope.tenantId
      ) {
        return null;
      }
      return found;
    },

    async listLearnedPolicyEvaluations(scope: LearnedPolicyScope, policyId: string) {
      return [...evaluationsById.values()]
        .filter(
          (evaluation) =>
            evaluation.applicationId === scope.applicationId &&
            evaluation.tenantId === scope.tenantId &&
            evaluation.policyId === policyId,
        )
        .sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1));
    },

    async appendLearnedPolicyPublication(publication) {
      const journal = publicationsOf(publication.applicationId);
      if (journal.some((existing) => existing.publicationId === publication.publicationId)) {
        const outcome: PublicationAppendOutcome = {
          publicationId: publication.publicationId,
          replayed: true,
        };
        return outcome;
      }
      journal.push(publication);
      return { publicationId: publication.publicationId, replayed: false };
    },

    async getActiveLearnedPolicyPublication(scope: LearnedPolicyScope) {
      const journal = publicationsOf(scope.applicationId).filter(
        (publication) => publication.tenantId === scope.tenantId,
      );
      const latest = journal[journal.length - 1];
      return latest === undefined ? null : latest;
    },

    async listLearnedPolicyPublications(scope: LearnedPolicyScope) {
      return publicationsOf(scope.applicationId)
        .filter((publication) => publication.tenantId === scope.tenantId)
        .map((publication) => ({ ...publication }));
    },
  };
}
