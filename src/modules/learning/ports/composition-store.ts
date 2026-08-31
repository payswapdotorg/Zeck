/**
 * The composition store port (learning module outbound; WORK-017).
 *
 * The durable boundary of tool-composition learning (migration 0010):
 *
 *  - `listTelemetry` — the SAME population read semantics as the
 *    learning store (scope-bound: application + tenant; window) — the
 *    composition advisor reads ONLY the immutable observation history
 *    (it can never fabricate or mutate evidence);
 *  - `insertRecommendationSet` — the append of a NEW immutable
 *    recommendation-set version (there is NO update path — M15's
 *    history-immutability half). Version arbitration is UNIQUE
 *    (application, set_version): a concurrent build that lands the
 *    same version surfaces as `IDEMPOTENCY_KEY_REUSED` (the service's
 *    convergence signal — the WORK-014 scorecard arbitration);
 *  - `getLatestRecommendationSet` / `getRecommendationSet` —
 *    versioned reads, scope-filtered (M25: cross-tenant rows are
 *    unreachable);
 *  - `appendActivation` — the append-only activation journal (the
 *    deployment state, DISTINCT from history by design — §21).
 *    Concurrent activations serialize through append arbitration
 *    (both land; the LATEST entry is the active pointer — §22);
 *  - `getActiveRecommendationSet` — the set pointed to by the latest
 *    activation entry within the scope (null when never activated);
 *  - `listActivations` — the activation history (evidence reads).
 *
 * The port is provider-neutral: no SQL, no driver types. It exposes NO
 * mutation of anything except the activation journal (which mutates
 * deployment state, never history) — there is no update/delete for
 * sets, telemetry or scorecards anywhere on this seam.
 */

import type {
  CompositionRecommendationSet,
  RecommendationSetActivation,
} from "../domain/composition-analysis";

export interface RecommendationSetScope {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface ActivationAppendOutcome {
  readonly activationId: string;
  /** True when an identical activation request was replayed. */
  readonly replayed: boolean;
}

export interface CompositionStore {
  /** The immutable telemetry population read (scope + window). */
  listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    /** Inclusive lower bound on recordedAt (RFC 3339), null = unbounded. */
    readonly recordedFrom: string | null;
    /** Inclusive upper bound on recordedAt (RFC 3339). */
    readonly recordedTo: string;
  }): Promise<readonly import("../domain/telemetry").ExecutionOutcomeTelemetry[]>;

  /**
   * Append a NEW immutable recommendation-set version. A taken
   * (application, set_version) fails with `IDEMPOTENCY_KEY_REUSED`
   * (the version-arbitration signal the service converges on). An
   * identical setId re-append converges (replay).
   */
  insertRecommendationSet(set: CompositionRecommendationSet): Promise<{ replayed: boolean }>;

  /** The latest recommendation-set version of a scope, or null. */
  getLatestRecommendationSet(
    scope: RecommendationSetScope,
  ): Promise<CompositionRecommendationSet | null>;

  /** A specific set by id within the scope, or null. */
  getRecommendationSet(
    scope: RecommendationSetScope,
    setId: string,
  ): Promise<CompositionRecommendationSet | null>;

  /**
   * Append an activation record (the deployment journal). The same
   * activationId converges (replay); different activations append and
   * serialize through journal order — the LATEST entry wins (§22).
   */
  appendActivation(activation: RecommendationSetActivation): Promise<ActivationAppendOutcome>;

  /** The set pointed to by the LATEST activation, or null. */
  getActiveRecommendationSet(
    scope: RecommendationSetScope,
  ): Promise<CompositionRecommendationSet | null>;

  /** The activation journal of the scope (oldest first — evidence). */
  listActivations(scope: RecommendationSetScope): Promise<readonly RecommendationSetActivation[]>;
}
