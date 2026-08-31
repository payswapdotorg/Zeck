/**
 * In-memory composition store (learning module adapter; WORK-017).
 *
 * The reference implementation of the `CompositionStore` port: mirrors
 * the EXACT durable semantics of the SQL store (migration 0010) so
 * unit tests prove the same invariants the real-PostgreSQL suites
 * prove physically:
 *
 *  - the telemetry population is read through the LEARNING store's
 *    read seam (the same physical history the SQL store reads — the
 *    composition axis owns NO second population);
 *  - recommendation sets are append-only BY VERSION with UNIQUE
 *    (application, set_version) arbitration — a taken version fails
 *    with `IDEMPOTENCY_KEY_REUSED` (the service's convergence
 *    signal); a re-append of the SAME setId converges (replay);
 *    rows are never mutated or deleted (M15's history half);
 *  - the activation journal is append-only: the same activationId
 *    converges (replay); the LATEST entry per scope is the active
 *    pointer (§22 — concurrent appends serialize by journal order);
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant rows are unreachable (M25).
 */

import { PlatformError } from "../../../shared/errors";
import type {
  CompositionRecommendationSet,
  RecommendationSetActivation,
} from "../domain/composition-analysis";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  ActivationAppendOutcome,
  CompositionStore,
  RecommendationSetScope,
} from "../ports/composition-store";
import type { LearningStore } from "../ports/learning-store";

export interface InMemoryCompositionStore extends CompositionStore {
  /** Test/inspection helper: the durable set count. */
  readonly setCount: () => number;
  /** Test/inspection helper: the activation journal length. */
  readonly activationCount: () => number;
}

/** The telemetry population read seam the store delegates to. */
export type TelemetrySource = Pick<LearningStore, "listTelemetry">;

export function createInMemoryCompositionStore(
  telemetrySource?: TelemetrySource,
): InMemoryCompositionStore {
  const setsByApplication = new Map<string, CompositionRecommendationSet[]>();
  const setsById = new Map<string, CompositionRecommendationSet>();
  const activationsByApplication = new Map<string, RecommendationSetActivation[]>();
  const activationIds = new Set<string>();

  const setsOf = (applicationId: string): CompositionRecommendationSet[] => {
    let list = setsByApplication.get(applicationId);
    if (list === undefined) {
      list = [];
      setsByApplication.set(applicationId, list);
    }
    return list;
  };

  const activationsOf = (applicationId: string): RecommendationSetActivation[] => {
    let list = activationsByApplication.get(applicationId);
    if (list === undefined) {
      list = [];
      activationsByApplication.set(applicationId, list);
    }
    return list;
  };

  const listTelemetry = async (query: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly recordedFrom: string | null;
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]> => {
    if (telemetrySource === undefined) {
      return [];
    }
    return telemetrySource.listTelemetry(query);
  };

  return {
    setCount: () => setsById.size,
    activationCount: () =>
      [...activationsByApplication.values()].reduce((sum, list) => sum + list.length, 0),

    async listTelemetry(query) {
      return listTelemetry(query);
    },

    async insertRecommendationSet(set) {
      const existingById = setsById.get(set.setId);
      if (existingById !== undefined) {
        return { replayed: true };
      }
      const list = setsOf(set.applicationId);
      if (list.some((existing) => existing.setVersion === set.setVersion)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "recommendation set version already exists (version arbitration)",
          details: { applicationId: set.applicationId, setVersion: set.setVersion },
        });
      }
      list.push(set);
      setsById.set(set.setId, set);
      return { replayed: false };
    },

    async getLatestRecommendationSet(scope: RecommendationSetScope) {
      const list = setsOf(scope.applicationId).filter((set) => set.tenantId === scope.tenantId);
      if (list.length === 0) {
        return null;
      }
      return list.reduce((latest, set) => (set.setVersion > latest.setVersion ? set : latest));
    },

    async getRecommendationSet(scope: RecommendationSetScope, setId: string) {
      const found = setsById.get(setId);
      if (
        found === undefined ||
        found.applicationId !== scope.applicationId ||
        found.tenantId !== scope.tenantId
      ) {
        return null;
      }
      return found;
    },

    async appendActivation(activation) {
      if (activationIds.has(activation.activationId)) {
        const outcome: ActivationAppendOutcome = {
          activationId: activation.activationId,
          replayed: true,
        };
        return outcome;
      }
      activationIds.add(activation.activationId);
      activationsOf(activation.applicationId).push(activation);
      return { activationId: activation.activationId, replayed: false };
    },

    async getActiveRecommendationSet(scope: RecommendationSetScope) {
      const journal = activationsOf(scope.applicationId).filter(
        (activation) => activation.tenantId === scope.tenantId,
      );
      const latest = journal[journal.length - 1];
      if (latest === undefined) {
        return null;
      }
      return setsById.get(latest.setId) ?? null;
    },

    async listActivations(scope: RecommendationSetScope) {
      return activationsOf(scope.applicationId)
        .filter((activation) => activation.tenantId === scope.tenantId)
        .map((activation) => ({ ...activation }));
    },
  };
}
