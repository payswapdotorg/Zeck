/**
 * The composition advisor service (learning module application;
 * WORK-017 / ADR-0005).
 *
 * THE OBSERVATIONAL tool-composition learning service:
 *
 * ```text
 *   generateRecommendationSet:
 *     validated tool facts (INPUT DATA, caller-supplied)
 *       ↓ store.listTelemetry — the immutable population (scope-bound)
 *     analyzeToolSequences (pure mining/evaluation/ranking)
 *       ↓ store.insertRecommendationSet — version-arbitrated append
 *     immutable versioned CompositionRecommendationSet
 *
 *   activateRecommendationSet / rollbackRecommendationSet:
 *     store.appendActivation — the append-only deployment journal
 *       (history is NEVER rewritten — rollback = activating a prior
 *       version, §21; concurrent activations serialize, §22)
 *
 *   consultRecommendations:
 *     the ACTIVE set's recommendations (scope-checked, task-class
 *     filtered) — the READ seam planning consumes (advisory evidence)
 * ```
 *
 * LEARNING-NONAUTHORITY (the frozen §10 invariant, preserved):
 * this service's deps are store + digest + id generator + clock ONLY —
 * the exact WORK-014 non-authoritative quartet. There is no policy
 * seam, no capability seam, no budget seam, no execution seam, no
 * verification seam and no tool-runtime seam here or anywhere in this
 * module (the architecture test pins the boundary; the discrimination
 * red-records prove mutated wirings are detected). A recommendation
 * can never authorize, dispatch or execute anything — it is recorded
 * evidence that the planner MAY consult.
 *
 * IDEMPOTENCY/CONCURRENCY (§22, the durable boundaries):
 *  - generation retries CONVERGE: the set carries a population
 *    fingerprint (digest over the population basis + the facts basis
 *    + the analysis version); regenerating with the SAME basis replays
 *    the latest set (no version churn, no history corruption);
 *  - duplicate generation is version-arbitrated: UNIQUE (application,
 *    set_version) — a concurrent winner is converged to by re-reading
 *    the durable record (the scorecard arbitration pattern);
 *  - activation is append-only and serialized: concurrent activations
 *    both land in the journal; the latest entry is the active pointer;
 *    only ONE active set exists at any time (the pointer is derived,
 *    never duplicated).
 *
 * ROLLBACK IS ACTIVATION, NEVER REWRITE (§21/M15): rolling back to a
 * prior set appends a 'rollback' activation of that set's id — the
 * historical sets and the historical activation entries remain
 * byte-identical (immutability is physical: migration 0010 triggers).
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type {
  CompositionRecommendationSet,
  CompositionRecommendationSignal,
  RecommendationSetActivation,
} from "../domain/composition-analysis";
import {
  analyzeToolSequences,
  COMPOSITION_ANALYSIS_VERSION,
  recommendationSetDigestBasis,
  signalFromRecommendation,
  validateCompositionRecommendationSet,
} from "../domain/composition-analysis";
import type { ToolFactCatalog } from "../domain/tool-facts";
import { validateToolFacts } from "../domain/tool-facts";
import type { CompositionStore } from "../ports/composition-store";
import type { DigestPort } from "../ports/digest";

export interface CompositionAdvisorDeps {
  readonly store: CompositionStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface GenerateRecommendationSetRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * The neutral tool facts (INPUT DATA — the caller's view of the
   * registered tools; validated fail-closed here). NOT a registry:
   * the learning module imports nothing and registers nothing.
   */
  readonly toolFacts: readonly unknown[];
}

export interface ActivateRecommendationSetRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly setId: string;
  readonly activatedBy: string;
  readonly reason: "initial" | "rollback" | "refresh";
}

export interface ConsultRecommendationsRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict to one task class (optional). */
  readonly taskClass?: string;
}

export interface CompositionAdvisor {
  /** Mine + evaluate + persist the next immutable recommendation set. */
  generateRecommendationSet(
    request: GenerateRecommendationSetRequest,
  ): Promise<{ set: CompositionRecommendationSet; replayed: boolean }>;
  /** Activate a set (append to the deployment journal). */
  activateRecommendationSet(
    request: ActivateRecommendationSetRequest,
  ): Promise<RecommendationSetActivation>;
  /**
   * Rollback: activate the PRIOR set (a plain 'rollback' activation —
   * history is untouched; §21).
   */
  rollbackRecommendationSet(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly toSetId: string;
    readonly activatedBy: string;
  }): Promise<RecommendationSetActivation>;
  /** The ACTIVE set's recommendations (the planning READ seam). */
  consultRecommendations(
    request: ConsultRecommendationsRequest,
  ): Promise<readonly CompositionRecommendationSignal[]>;
}

/** Maximum set-version build attempts before typed failure. */
const SET_VERSION_ATTEMPTS = 3;

export function createCompositionAdvisor(deps: CompositionAdvisorDeps): CompositionAdvisor {
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
        message: "applicationId and tenantId are required (tenant scope is never dropped, M25)",
      });
    }
  };

  /** The shared activation path (initial / rollback / refresh). */
  const activate = async (
    request: ActivateRecommendationSetRequest,
  ): Promise<RecommendationSetActivation> => {
    requireScope(request);
    const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
    const set = await deps.store.getRecommendationSet(scope, request.setId);
    if (set === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "recommendation set not found within the application scope",
        details: { setId: request.setId },
      });
    }
    // Content-derived activation identity: the same logical activation
    // request retries to the SAME id and converges in the journal; any
    // semantic difference appends a new entry.
    const activationId = digestOf({
      activationSchema: 1,
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      setId: request.setId,
      activatedBy: request.activatedBy,
      reason: request.reason,
    });
    const activation: RecommendationSetActivation = {
      activationId,
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      setId: request.setId,
      setVersion: set.setVersion,
      activatedAt: deps.now().toISOString(),
      activatedBy: request.activatedBy,
      reason: request.reason,
    };
    await deps.store.appendActivation(activation);
    return activation;
  };

  return {
    async generateRecommendationSet(request) {
      requireScope(request);
      const catalog: ToolFactCatalog = validateToolFacts(request.toolFacts);
      const computedAt = deps.now().toISOString();

      const population = await deps.store.listTelemetry({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        recordedFrom: null,
        recordedTo: computedAt,
      });
      if (population.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no telemetry population in scope (tool-composition learning requires observed evidence — evidence over claims)",
          details: { applicationId: request.applicationId },
        });
      }

      // The replay identity: the population basis + the facts basis +
      // the analysis version (regenerating on the SAME basis converges
      // — §22; a new population or new facts produce a new version).
      const populationFingerprint = digestOf({
        population: population.map((datum) => ({
          executionId: datum.executionId,
          taskClass: datum.taskClass,
          tools: [...datum.tools],
          outcome: datum.outcome,
          recordedAt: datum.recordedAt,
        })),
        factBasis: catalog.facts.map((fact) => [fact.toolId, fact.version]),
        analysisVersion: COMPOSITION_ANALYSIS_VERSION,
      });

      const previous = await deps.store.getLatestRecommendationSet({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      });
      if (previous !== null && previous.populationFingerprint === populationFingerprint) {
        // Same basis → converge on the durable set (no version churn).
        return { set: previous, replayed: true };
      }

      const recommendations = analyzeToolSequences(population, catalog);
      const nextVersion = (previous?.setVersion ?? 0) + 1;
      const windowFrom =
        population.reduce(
          (minimum, datum) => (datum.recordedAt < minimum ? datum.recordedAt : minimum),
          population[0]?.recordedAt ?? "",
        ) ?? null;

      let lastError: unknown;
      for (let attempt = 0; attempt < SET_VERSION_ATTEMPTS; attempt += 1) {
        const basis: Omit<CompositionRecommendationSet, "digest"> = {
          setId: deps.generateId(),
          setVersion: nextVersion,
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          analysisVersion: COMPOSITION_ANALYSIS_VERSION,
          telemetrySchemaVersion: population[0]?.schemaVersion ?? 1,
          populationFingerprint,
          evaluationWindowFrom: windowFrom,
          evaluationWindowTo: computedAt,
          totalPopulation: population.length,
          recommendations,
          generatedAt: computedAt,
        };
        const set: CompositionRecommendationSet = {
          ...basis,
          digest: digestOf(recommendationSetDigestBasis(basis)),
        };
        validateCompositionRecommendationSet(set);
        try {
          const outcome = await deps.store.insertRecommendationSet(set);
          return { set, replayed: outcome.replayed };
        } catch (error) {
          lastError = error;
          if (error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED") {
            // A concurrent build landed this version first: converge by
            // re-reading the durable winner (the scorecard pattern).
            const winner = await deps.store.getLatestRecommendationSet({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
            });
            if (winner !== null && winner.setVersion >= nextVersion) {
              return { set: winner, replayed: true };
            }
            continue;
          }
          throw error;
        }
      }
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "recommendation-set version arbitration did not converge",
        details: { attempts: SET_VERSION_ATTEMPTS },
        cause: lastError,
      });
    },

    async activateRecommendationSet(request) {
      return activate(request);
    },

    async rollbackRecommendationSet(request) {
      // ROLLBACK = activate the prior set with the 'rollback' reason —
      // an ordinary journal append. Historical sets and historical
      // activations are untouched (§21/M15).
      return activate({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        setId: request.toSetId,
        activatedBy: request.activatedBy,
        reason: "rollback",
      });
    },

    async consultRecommendations(request) {
      requireScope(request);
      const set = await deps.store.getActiveRecommendationSet({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      });
      if (set === null) {
        return [];
      }
      const recommendations =
        request.taskClass === undefined
          ? set.recommendations
          : set.recommendations.filter(
              (recommendation) => recommendation.context.taskClass === request.taskClass,
            );
      // Project each record into the consultation SIGNAL with its set
      // anchors (which immutable version produced it — the M13/M14
      // basis at the consumer seam). The projection validates: a
      // malformed record never crosses the READ seam.
      return recommendations.map((recommendation) =>
        signalFromRecommendation(recommendation, {
          setId: set.setId,
          setVersion: set.setVersion,
          analysisVersion: set.analysisVersion,
        }),
      );
    },
  };
}
