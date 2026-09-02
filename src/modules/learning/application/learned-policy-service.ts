/**
 * The learned-policy service (learning module application; WORK-020 /
 * LRN-002, `spec/architecture.md` §2.11/§19).
 *
 * THE OBSERVATIONAL learned planning-policy lifecycle service:
 *
 * ```text
 *   generateLearnedPolicy:
 *     store.listTelemetry — the immutable population (scope-bound)
 *       ↓ mineLearnedRoutePreferences (pure mining/ranking)
 *       ↓ store.insertLearnedPolicy — version-arbitrated append
 *     immutable versioned LearnedPlanningPolicy
 *
 *   evaluateLearnedPolicy (shadow | canary):
 *     store.getLatestScorecard — the EXACT evidence basis
 *       ↓ evaluateLearnedPolicyAgainstScorecard (pure, honest)
 *       ↓ store.insertLearnedPolicyEvaluation — immutable record
 *     revision-bound evaluation evidence (metrics + verdict)
 *
 *   publishLearnedPolicy (canary | promoted) / rollbackLearnedPolicy:
 *     the evidence gate: every referenced evaluation record is loaded,
 *     policy-version-matched AND digest-verified (revision-bound);
 *     canary requires a completed shadow evaluation, promoted requires
 *     shadow + canary — shadow/canary BEFORE promotion is structural
 *       ↓ store.appendLearnedPolicyPublication — append-only journal
 *     the deployment state (the explicit publication step)
 *
 *   consultLearnedPolicy:
 *     the ACTIVE publication's policy projection — the READ seam the
 *     planning module consumes (advisory evidence, never authority)
 * ```
 *
 * LEARNING-NONAUTHORITY (the frozen §10 invariant, preserved): this
 * service's deps are store + digest + id generator + clock ONLY — the
 * non-authoritative quartet. There is no policy seam, no capability
 * seam, no budget seam, no execution seam, no verification seam and no
 * route-explorer seam here or anywhere in this module (the
 * architecture test pins the boundary; the discrimination red-records
 * prove mutated wirings are detected). A learned policy artifact can
 * never authorize, dispatch or execute anything — it is recorded
 * evidence plus a deployment journal that ONLY the explicit
 * publication action advances.
 *
 * IDEMPOTENCY/CONCURRENCY (the durable boundaries):
 *  - generation retries CONVERGE: the artifact carries a population
 *    fingerprint (digest over the population basis + the analysis
 *    version); regenerating with the SAME basis replays the latest
 *    version (no version churn, no history corruption);
 *  - duplicate generation is version-arbitrated: UNIQUE (application,
 *    policy_version) — a concurrent winner is converged to by
 *    re-reading the durable record (the scorecard/recommendation-set
 *    arbitration pattern);
 *  - evaluation retries CONVERGE: the evaluation identity is
 *    content-derived (policy version + kind + basis + canary binding);
 *  - publication is append-only and serialized: concurrent
 *    publications both land in the journal; the latest entry is the
 *    active pointer; only ONE active publication exists at any time
 *    (the pointer is derived, never duplicated); the same publication
 *    request converges on the content-derived publicationId.
 *
 * ROLLBACK IS PUBLICATION, NEVER REWRITE: rolling back to a prior
 * version appends a 'rollback' publication of that version's most
 * recent journal mode — the historical policy versions, evaluations
 * and prior journal entries remain byte-identical (immutability is
 * physical: migration 0017 triggers). The artifact's own rollback
 * metadata names the exact prior version + digest, so the rollback
 * target is deterministic.
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type {
  EvaluationScorecardLike,
  LearnedPlanningPolicy,
  LearnedPolicyEvaluation,
  LearnedPolicyEvaluationKind,
  LearnedPolicyPublication,
  LearnedPolicyPublicationMode,
  PublicationEvidenceReference,
} from "../domain/learned-planning-policy";
import {
  evaluateLearnedPolicyAgainstScorecard,
  LEARNED_POLICY_ANALYSIS_VERSION,
  learnedPolicyDigestBasis,
  learnedPolicyEvaluationDigestBasis,
  mineLearnedRoutePreferences,
  validateLearnedPlanningPolicy,
  validateLearnedPolicyEvaluation,
  validateLearnedPolicyPublication,
} from "../domain/learned-planning-policy";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type { DigestPort } from "../ports/digest";
import type { LearnedPolicyScope, LearnedPolicyStore } from "../ports/learned-policy-store";

export interface LearnedPolicyServiceDeps {
  readonly store: LearnedPolicyStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface GenerateLearnedPolicyRequest {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface EvaluateLearnedPolicyRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly policyId: string;
  /** shadow = pre-publication; canary = evaluation of a policy that ran in canary. */
  readonly evaluationClass: LearnedPolicyEvaluationKind;
}

export interface PublishLearnedPolicyRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly publicationMode: LearnedPolicyPublicationMode;
  readonly publishedBy: string;
  /** The evaluation evidence referenced by this publication (revision-bound ids). */
  readonly evaluationEvidence: readonly { readonly evaluationId: string }[];
  readonly publicationReason?: "initial" | "refresh";
}

export interface RollbackLearnedPolicyRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The prior policy version to roll back to (deterministic target). */
  readonly toPolicyId: string;
  readonly publishedBy: string;
}

export interface ConsultLearnedPolicyRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict the projected preferences to one task class (optional). */
  readonly taskClass?: string;
}

/** The projection of the ACTIVE publication: the policy + the journal entry. */
export interface ActiveLearnedPolicyView {
  readonly policy: LearnedPlanningPolicy;
  readonly publication: LearnedPolicyPublication;
}

export interface LearnedPolicyService {
  /** Mine + persist the next immutable learned-policy version. */
  generateLearnedPolicy(
    request: GenerateLearnedPolicyRequest,
  ): Promise<{ policy: LearnedPlanningPolicy; replayed: boolean }>;
  /** Evaluate a policy version against the latest scorecard evidence. */
  evaluateLearnedPolicy(
    request: EvaluateLearnedPolicyRequest,
  ): Promise<{ evaluation: LearnedPolicyEvaluation; replayed: boolean }>;
  /** The explicit publication step (the evidence-gated journal append). */
  publishLearnedPolicy(request: PublishLearnedPolicyRequest): Promise<LearnedPolicyPublication>;
  /** Rollback: publish a prior version (an ordinary journal append). */
  rollbackLearnedPolicy(request: RollbackLearnedPolicyRequest): Promise<LearnedPolicyPublication>;
  /** The ACTIVE publication's projection (the READ seam). */
  consultLearnedPolicy(
    request: ConsultLearnedPolicyRequest,
  ): Promise<ActiveLearnedPolicyView | null>;
}

/** Maximum policy-version build attempts before typed failure. */
const POLICY_VERSION_ATTEMPTS = 3;

/** The route-outcome aggregation definition the evaluation consults by default. */
const DEFAULT_ROUTE_DEFINITION = "route-outcome-by-task-class";

export function createLearnedPolicyService(deps: LearnedPolicyServiceDeps): LearnedPolicyService {
  const digestOf = (value: unknown): string => deps.digest.sha256Hex(canonicalJson(value));

  const requireScope = (request: { applicationId: string; tenantId: string }): void => {
    if (
      typeof request.applicationId !== "string" ||
      request.applicationId.length === 0 ||
      typeof request.tenantId !== "string" ||
      request.tenantId.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "applicationId and tenantId are required (tenant scope is never dropped)",
      });
    }
  };

  /** Digest-verify a durable evaluation record against a reference. */
  const verifyEvidence = (
    scope: LearnedPolicyScope,
    policyId: string,
    policyVersion: number,
    reference: { readonly evaluationId: string },
  ): Promise<LearnedPolicyEvaluation> =>
    deps.store.getLearnedPolicyEvaluation(scope, reference.evaluationId).then((evaluation) => {
      if (evaluation === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "publication evidence references an evaluation that does not exist within the application scope (fail closed)",
          details: { evaluationId: reference.evaluationId },
        });
      }
      if (evaluation.policyId !== policyId || evaluation.policyVersion !== policyVersion) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "publication evidence must reference evaluations of the EXACT policy version being published (revision-bound evidence)",
          details: {
            evaluationId: evaluation.evaluationId,
            evaluationPolicyId: evaluation.policyId,
            evaluationPolicyVersion: evaluation.policyVersion,
            publishedPolicyId: policyId,
            publishedPolicyVersion: policyVersion,
          },
        });
      }
      if (evaluation.status === "insufficient-evidence") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "publication evidence must reference evaluations that produced an evidence basis ('evaluated' or 'inconclusive' — an insufficient-evidence record proves nothing and never gates a publication)",
          details: { evaluationId: evaluation.evaluationId, status: evaluation.status },
        });
      }
      return evaluation;
    });

  return {
    async generateLearnedPolicy(request) {
      requireScope(request);
      const scope: LearnedPolicyScope = {
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const generatedAt = deps.now().toISOString();

      const population: readonly ExecutionOutcomeTelemetry[] = await deps.store.listTelemetry({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        recordedFrom: null,
        recordedTo: generatedAt,
      });
      if (population.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no telemetry population in scope (learned planning policies require observed evidence — evidence over claims)",
          details: { applicationId: request.applicationId },
        });
      }

      // The replay identity: the population basis + the analysis
      // version (regenerating on the SAME basis converges; a new
      // population produces a new version).
      const populationFingerprint = digestOf({
        population: population.map((datum) => ({
          executionId: datum.executionId,
          taskClass: datum.taskClass,
          routes: datum.routes.map((route) => `${route.provider}/${route.model}`),
          outcome: datum.outcome,
          costMicroUsd: datum.costMicroUsd,
          latencyMs: datum.latencyMs,
          recordedAt: datum.recordedAt,
        })),
        analysisVersion: LEARNED_POLICY_ANALYSIS_VERSION,
      });

      const previous = await deps.store.getLatestLearnedPolicy(scope);
      if (previous !== null && previous.populationFingerprint === populationFingerprint) {
        // Same basis → converge on the durable version (no churn).
        return { policy: previous, replayed: true };
      }

      const preferences = mineLearnedRoutePreferences(population);
      if (preferences.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no task class meets the population floor for any route subject (honest evidence is absent — an empty learned policy is unrepresentable)",
          details: { population: population.length, minimumPopulation: 5 },
        });
      }

      const windowFrom =
        population.reduce(
          (minimum, datum) => (datum.recordedAt < minimum ? datum.recordedAt : minimum),
          population[0]?.recordedAt ?? "",
        ) ?? null;
      const nextVersion = (previous?.policyVersion ?? 0) + 1;

      let lastError: unknown;
      for (let attempt = 0; attempt < POLICY_VERSION_ATTEMPTS; attempt += 1) {
        const basis: Omit<LearnedPlanningPolicy, "digest"> = {
          policyClass: "non-authoritative-learned-planning-policy",
          policyId: deps.generateId(),
          policyVersion: nextVersion,
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          analysisVersion: LEARNED_POLICY_ANALYSIS_VERSION,
          telemetrySchemaVersion: population[0]?.schemaVersion ?? 1,
          populationFingerprint,
          totalPopulation: population.length,
          evaluationWindowFrom: windowFrom,
          evaluationWindowTo: generatedAt,
          preferences,
          rollback: {
            rollbackToPolicyVersion: previous?.policyVersion ?? null,
            priorPolicyDigest: previous?.digest ?? null,
            note:
              previous === null
                ? "first generated version — no prior version to roll back to"
                : `deterministic rollback target: version ${previous.policyVersion} (digest ${previous.digest})`,
          },
          generatedAt,
          policySchemaVersion: 1,
        };
        const policy: LearnedPlanningPolicy = {
          ...basis,
          digest: digestOf(learnedPolicyDigestBasis(basis)),
        };
        validateLearnedPlanningPolicy(policy);
        try {
          const outcome = await deps.store.insertLearnedPolicy(policy);
          return { policy, replayed: outcome.replayed };
        } catch (error) {
          lastError = error;
          if (error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED") {
            // A concurrent build landed this version first: converge by
            // re-reading the durable winner (the arbitration pattern).
            const winner = await deps.store.getLatestLearnedPolicy(scope);
            if (winner !== null && winner.policyVersion >= nextVersion) {
              return { policy: winner, replayed: true };
            }
            continue;
          }
          throw error;
        }
      }
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned-policy version arbitration did not converge",
        details: { attempts: POLICY_VERSION_ATTEMPTS },
        cause: lastError,
      });
    },

    async evaluateLearnedPolicy(request) {
      requireScope(request);
      const scope: LearnedPolicyScope = {
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const policy = await deps.store.getLearnedPolicy(scope, request.policyId);
      if (policy === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "learned planning policy not found within the application scope",
          details: { policyId: request.policyId },
        });
      }

      // A canary evaluation requires the policy version to have RAN in
      // canary: a durable canary publication of this EXACT version must
      // exist in the journal (fail closed otherwise — you cannot
      // evaluate a canary that never ran).
      let canaryBinding: { publicationId: string; publishedAt: string } | null = null;
      if (request.evaluationClass === "canary") {
        const journal = await deps.store.listLearnedPolicyPublications(scope);
        const canaryPublication = [...journal]
          .reverse()
          .find(
            (entry) =>
              entry.publicationMode === "canary" &&
              entry.policyId === policy.policyId &&
              entry.policyVersion === policy.policyVersion,
          );
        if (canaryPublication === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "a canary evaluation requires a durable canary publication of this exact policy version (the ran-in-canary proof — fail closed)",
            details: { policyId: policy.policyId, policyVersion: policy.policyVersion },
          });
        }
        canaryBinding = {
          publicationId: canaryPublication.publicationId,
          publishedAt: canaryPublication.publishedAt,
        };
      }

      const scorecard: EvaluationScorecardLike | null = await deps.store.getLatestScorecard({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        definitionId: DEFAULT_ROUTE_DEFINITION,
      });
      if (request.evaluationClass === "canary" && scorecard === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "a canary evaluation requires a durable scorecard basis to observe outcomes (fail closed — never a guessed verdict)",
          details: { applicationId: request.applicationId },
        });
      }

      const outcome = evaluateLearnedPolicyAgainstScorecard(policy, scorecard);
      const evaluatedAt = deps.now().toISOString();
      // Content-derived identity: the same logical evaluation (policy
      // version + kind + basis + canary binding) retries to the SAME
      // id and converges; a newer scorecard basis produces a new row.
      const evaluationId = digestOf({
        evaluationSchema: 1,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        evaluationClass: request.evaluationClass,
        basis: outcome.basis,
        canaryBinding,
      });
      const evaluation: LearnedPolicyEvaluation = {
        evaluationId,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        evaluationClass: request.evaluationClass,
        status: outcome.status,
        verdict: outcome.verdict,
        metrics: outcome.metrics,
        comparison: outcome.comparison,
        basis: outcome.basis,
        canaryBinding,
        evidenceRefs: [...outcome.evidenceRefs],
        sourceExecutionIds: [...outcome.sourceExecutionIds],
        evaluatedAt,
        schemaVersion: 1,
      };
      validateLearnedPolicyEvaluation(evaluation);
      const appendOutcome = await deps.store.insertLearnedPolicyEvaluation(evaluation);
      return { evaluation, replayed: appendOutcome.replayed };
    },

    async publishLearnedPolicy(request) {
      requireScope(request);
      const scope: LearnedPolicyScope = {
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const policy = await deps.store.getLearnedPolicy(scope, request.policyId);
      if (policy === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "learned planning policy not found within the application scope",
          details: { policyId: request.policyId },
        });
      }
      if (request.publishedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "publication requires a non-empty publishedBy actor",
        });
      }

      // The evidence gate: every reference is loaded, version-matched,
      // digest-verified and status-qualified (revision-bound evidence).
      const verified: PublicationEvidenceReference[] = [];
      for (const reference of request.evaluationEvidence) {
        const evaluation = await verifyEvidence(
          scope,
          policy.policyId,
          policy.policyVersion,
          reference,
        );
        verified.push({
          evaluationId: evaluation.evaluationId,
          evaluationClass: evaluation.evaluationClass,
          evaluationDigest: digestOf(learnedPolicyEvaluationDigestBasis(evaluation)),
          evaluatedAt: evaluation.evaluatedAt,
        });
      }
      if (verified.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "publication requires explicit evaluation evidence (an unevaluated learned optimization is never publishable)",
          details: { policyId: policy.policyId },
        });
      }

      // The mode gates (shadow/canary BEFORE promotion — structural):
      //  - canary requires at least one completed SHADOW evaluation;
      //  - promoted requires BOTH a shadow AND a canary evaluation.
      const classes = new Set(verified.map((reference) => reference.evaluationClass));
      if (request.publicationMode === "canary" && !classes.has("shadow")) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "a canary publication requires a completed shadow evaluation of this exact policy version (shadow runs before canary)",
          details: { policyId: policy.policyId },
        });
      }
      if (
        request.publicationMode === "promoted" &&
        !(classes.has("shadow") && classes.has("canary"))
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "a promoted publication requires BOTH a shadow and a canary evaluation of this exact policy version (shadow/canary before promotion)",
          details: { policyId: policy.policyId },
        });
      }

      const publishedAt = deps.now().toISOString();
      // Content-derived identity: the same logical publication request
      // retries to the SAME id and converges in the journal; any
      // semantic difference appends a new entry.
      const publicationId = digestOf({
        publicationSchema: 1,
        applicationId: request.applicationId,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        publicationMode: request.publicationMode,
        publicationReason: request.publicationReason ?? "initial",
        publishedBy: request.publishedBy,
        evaluationEvidence: verified,
      });
      const publication: LearnedPolicyPublication = {
        publicationId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        publicationMode: request.publicationMode,
        publicationReason: request.publicationReason ?? "initial",
        evaluationEvidence: verified,
        publishedAt,
        publishedBy: request.publishedBy,
        publicationSchemaVersion: 1,
      };
      validateLearnedPolicyPublication(publication);
      await deps.store.appendLearnedPolicyPublication(publication);
      return publication;
    },

    async rollbackLearnedPolicy(request) {
      requireScope(request);
      const scope: LearnedPolicyScope = {
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const target = await deps.store.getLearnedPolicy(scope, request.toPolicyId);
      if (target === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "rollback target not found within the application scope (the deterministic rollback target must be a durable version)",
          details: { policyId: request.toPolicyId },
        });
      }
      const journal = await deps.store.listLearnedPolicyPublications(scope);
      // DETERMINISTIC TARGET: the most recent journal entry of the
      // target version (its mode and evidence are reused verbatim —
      // the rollback restores exactly what was there before).
      const lastOfTarget = [...journal]
        .reverse()
        .find(
          (entry) =>
            entry.policyId === target.policyId && entry.policyVersion === target.policyVersion,
        );
      if (lastOfTarget === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "cannot roll back to a version that was never published (the rollback target must have a prior publication)",
          details: { policyId: target.policyId, policyVersion: target.policyVersion },
        });
      }

      const publishedAt = deps.now().toISOString();
      const publicationId = digestOf({
        publicationSchema: 1,
        applicationId: request.applicationId,
        policyId: target.policyId,
        policyVersion: target.policyVersion,
        publicationMode: lastOfTarget.publicationMode,
        publicationReason: "rollback",
        publishedBy: request.publishedBy,
        evaluationEvidence: lastOfTarget.evaluationEvidence,
      });
      const publication: LearnedPolicyPublication = {
        publicationId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        policyId: target.policyId,
        policyVersion: target.policyVersion,
        publicationMode: lastOfTarget.publicationMode,
        publicationReason: "rollback",
        evaluationEvidence: lastOfTarget.evaluationEvidence.map((reference) => ({ ...reference })),
        publishedAt,
        publishedBy: request.publishedBy,
        publicationSchemaVersion: 1,
      };
      validateLearnedPolicyPublication(publication);
      await deps.store.appendLearnedPolicyPublication(publication);
      return publication;
    },

    async consultLearnedPolicy(request) {
      requireScope(request);
      const scope: LearnedPolicyScope = {
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const publication = await deps.store.getActiveLearnedPolicyPublication(scope);
      if (publication === null) {
        return null;
      }
      const policy = await deps.store.getLearnedPolicy(scope, publication.policyId);
      if (policy === null) {
        // The journal pointer references a missing version — fail
        // closed rather than silently degrading (physically
        // unreachable through migration 0017's composite FK).
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the active publication points at a missing learned policy version (fail closed)",
          details: { publicationId: publication.publicationId, policyId: publication.policyId },
        });
      }
      validateLearnedPolicyPublication(publication);
      validateLearnedPlanningPolicy(policy);
      const projectedPolicy: LearnedPlanningPolicy =
        request.taskClass === undefined
          ? policy
          : {
              ...policy,
              preferences: policy.preferences.filter(
                (preference) => preference.taskClass === request.taskClass,
              ),
            };
      // A task-class projection of a policy whose only preferences
      // belong to other classes is an EMPTY consultation — the caller
      // receives the view and observes zero applicable preferences
      // (honest absence, never a fabricated default).
      return { policy: projectedPolicy, publication };
    },
  };
}
