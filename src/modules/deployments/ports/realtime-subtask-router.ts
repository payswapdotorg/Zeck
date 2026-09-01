/**
 * Realtime subtask-router port (deployments module inbound seam;
 * WORK-024, MOD-007 — deterministic/hybrid turn routing).
 *
 * THE planner-consultation seam: the route class of a realtime turn
 * subtask (deterministic / hybrid / generative) is decided by THE
 * EXISTING PLANNER DECISION SURFACE, never inside the deployments
 * module and never by a hidden model dispatch. The shipped adapter
 * (`adapters/planner-subtask-router.ts`) consults the planning
 * module's public deterministic-sufficiency evaluation — the same
 * frozen decision the execution planner uses — so "generative
 * inference is unnecessary or excessive" is established by the
 * planner's own logic (semantic-reasoning requirement, capability
 * coverage, deterministic quality estimates).
 *
 * A DETERMINISTIC route means: no generative inference, no paid
 * dispatch, no budget reservation — the turn is served by deterministic
 * computation (MOD-007's "avoid unnecessary generative inference").
 * A HYBRID/GENERATIVE route means the paid path is admissible and the
 * FULL admission chain (policy → capability → budget → secret)
 * applies before any dispatch.
 */

import type { RealtimeRouteClass } from "../domain/realtime";

export interface RealtimeTurnRouteRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  /** The PINNED deployment plan version the session runs on. */
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly channelKind: string;
  /**
   * The turn's neutral subtask classification (the planner task kind:
   * data-retrieval/transformation/… for deterministic-eligible turns,
   * generation/interpretation/analysis/mixed for semantic turns). The
   * planner surface itself validates the kind (fail closed).
   */
  readonly subtaskKind: string;
  /** The pinned plan's required capabilities (the deployment declaration). */
  readonly requiredCapabilities: readonly string[];
  /** Bounded preview of the inbound turn (never raw media). */
  readonly turnPreview: string | null;
  /** ARTIFACT REFERENCE of the inbound media (never the media). */
  readonly turnPayloadRef: string | null;
}

export interface RealtimeTurnRoute {
  readonly routeClass: RealtimeRouteClass;
  /**
   * The planner's decision summary (machine-readable rationale codes —
   * the planning module's sufficiency vocabulary).
   */
  readonly decisionOutcome: "sufficient" | "uncertain" | "insufficient";
  readonly reasonCodes: readonly string[];
  /** Bounded rationale summary. */
  readonly rationale: string;
  /**
   * The estimated paid-inference cost in micro-USD for hybrid/generative
   * routes; null on deterministic routes (no paid dispatch).
   */
  readonly estimatedCostMicroUsd: string | null;
}

export interface RealtimeSubtaskRouter {
  routeTurn(request: RealtimeTurnRouteRequest): Promise<RealtimeTurnRoute>;
}
