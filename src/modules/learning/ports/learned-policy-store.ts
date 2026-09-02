/**
 * The learned-policy store port (learning module outbound; WORK-020).
 *
 * The durable boundary of the learned planning-policy axis (migration
 * 0017):
 *
 *  - `listTelemetry` — the SAME population read semantics as the
 *    learning store (scope-bound: application + tenant; window) — the
 *    policy generation reads ONLY the immutable observation history
 *    (it can never fabricate or mutate evidence);
 *  - `getLatestScorecard` — the LATEST versioned scorecard of a scope
 *    (the evaluation basis — the evaluation is bound to the EXACT
 *    scorecard version consulted);
 *  - `insertLearnedPolicy` — the append of a NEW immutable policy
 *    version (there is NO update path — history is physical). Version
 *    arbitration is UNIQUE (application, policy_version): a concurrent
 *    build that lands the same version surfaces as
 *    `IDEMPOTENCY_KEY_REUSED` (the service's convergence signal — the
 *    scorecard/recommendation-set arbitration pattern); an identical
 *    policyId re-append converges (replay);
 *  - `getLatestLearnedPolicy` / `getLearnedPolicy` — versioned reads,
 *    scope-filtered;
 *  - `insertLearnedPolicyEvaluation` — the append of an immutable
 *    shadow/canary evaluation record (content-derived identity
 *    converges on the PRIMARY KEY);
 *  - `getLearnedPolicyEvaluation` / `listLearnedPolicyEvaluations` —
 *    the revision-bound evidence reads;
 *  - `appendLearnedPolicyPublication` — the append-only publication
 *    journal (the deployment state, DISTINCT from history by design).
 *    Concurrent publications serialize through journal order (both
 *    land; the LATEST entry is the active pointer); the same
 *    publicationId converges (replay);
 *  - `getActiveLearnedPolicyPublication` / `listLearnedPolicyPublications`
 *    — the active-pointer and journal reads (evidence).
 *
 * Every read/write is tenant-scoped: the caller supplies the scope and
 * the store NEVER returns rows outside it (enforced physically by the
 * composite FKs and scoped queries of migration 0017).
 *
 * The port is provider-neutral: no SQL, no driver types. It exposes NO
 * mutation of anything except the publication journal (which mutates
 * deployment state, never history) — there is no update/delete for
 * policy versions, evaluations or scorecards anywhere on this seam.
 */

import type {
  EvaluationScorecardLike,
  LearnedPlanningPolicy,
  LearnedPolicyEvaluation,
  LearnedPolicyPublication,
} from "../domain/learned-planning-policy";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";

export interface LearnedPolicyScope {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface PublicationAppendOutcome {
  readonly publicationId: string;
  /** True when an identical publication request was replayed. */
  readonly replayed: boolean;
}

export interface EvaluationAppendOutcome {
  readonly evaluationId: string;
  /** True when an identical evaluation request was replayed. */
  readonly replayed: boolean;
}

export interface LearnedPolicyStore {
  /** The immutable telemetry population read (scope + window). */
  listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    /** Inclusive lower bound on recordedAt (RFC 3339), null = unbounded. */
    readonly recordedFrom: string | null;
    /** Inclusive upper bound on recordedAt (RFC 3339). */
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]>;

  /** The latest scorecard version of a scope (the evaluation basis), or null. */
  getLatestScorecard(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly definitionId: string;
  }): Promise<EvaluationScorecardLike | null>;

  /**
   * Append a NEW immutable learned-policy version. A taken
   * (application, policy_version) fails with `IDEMPOTENCY_KEY_REUSED`
   * (the version-arbitration signal the service converges on). An
   * identical policyId re-append converges (replay).
   */
  insertLearnedPolicy(policy: LearnedPlanningPolicy): Promise<{ replayed: boolean }>;

  /** The latest policy version of a scope, or null. */
  getLatestLearnedPolicy(scope: LearnedPolicyScope): Promise<LearnedPlanningPolicy | null>;

  /** A specific policy version by id within the scope, or null. */
  getLearnedPolicy(
    scope: LearnedPolicyScope,
    policyId: string,
  ): Promise<LearnedPlanningPolicy | null>;

  /**
   * Append an immutable evaluation record. The same evaluationId
   * converges (replay — content-derived identity).
   */
  insertLearnedPolicyEvaluation(
    evaluation: LearnedPolicyEvaluation,
  ): Promise<EvaluationAppendOutcome>;

  /** A specific evaluation by id within the scope, or null. */
  getLearnedPolicyEvaluation(
    scope: LearnedPolicyScope,
    evaluationId: string,
  ): Promise<LearnedPolicyEvaluation | null>;

  /** The evaluation records of a policy version within the scope (newest first). */
  listLearnedPolicyEvaluations(
    scope: LearnedPolicyScope,
    policyId: string,
  ): Promise<readonly LearnedPolicyEvaluation[]>;

  /**
   * Append a publication entry (the deployment journal). The same
   * publicationId converges (replay); different publications append and
   * serialize through journal order — the LATEST entry wins (the
   * single active pointer).
   */
  appendLearnedPolicyPublication(
    publication: LearnedPolicyPublication,
  ): Promise<PublicationAppendOutcome>;

  /** The publication pointed to by the LATEST journal entry, or null. */
  getActiveLearnedPolicyPublication(
    scope: LearnedPolicyScope,
  ): Promise<LearnedPolicyPublication | null>;

  /** The publication journal of the scope (oldest first — evidence). */
  listLearnedPolicyPublications(
    scope: LearnedPolicyScope,
  ): Promise<readonly LearnedPolicyPublication[]>;
}
