/**
 * Messaging subtask-router port (deployments module inbound seam;
 * WORK-025 — deterministic/hybrid reply routing).
 *
 * THE planner-consultation seam: the route class of a messaging reply
 * subtask (deterministic / hybrid / generative) is decided by THE
 * EXISTING PLANNER DECISION SURFACE, never inside the deployments
 * module and never by a hidden model dispatch. The shipped adapter
 * (`adapters/planner-messaging-subtask-router.ts`) consults the
 * planning module's public deterministic-sufficiency evaluation — the
 * same frozen decision the execution planner and the realtime router
 * use — so "generative inference is unnecessary or excessive" is
 * established by the planner's own logic.
 *
 * A DETERMINISTIC route means: no generative inference, no paid
 * dispatch, no budget reservation — the reply is served by
 * deterministic computation. A HYBRID/GENERATIVE route means the paid
 * path is admissible and the FULL admission chain (policy →
 * capability → budget → secret) applies before any dispatch.
 */

import type { MessagingRouteClass } from "../domain/messaging";

export interface MessagingTurnRouteRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  /** The PINNED deployment plan version the conversation runs on. */
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
  /** Bounded preview of the inbound message (never raw payload). */
  readonly turnPreview: string | null;
  /** ARTIFACT REFERENCE of the inbound message (never the bytes). */
  readonly turnPayloadRef: string | null;
}

export interface MessagingTurnRoute {
  readonly routeClass: MessagingRouteClass;
  /**
   * The planner's decision summary (machine-readable rationale codes —
   * the planning module's sufficiency vocabulary).
   */
  readonly decisionOutcome: "sufficient" | "uncertain" | "insufficient";
  readonly reasonCodes: readonly string[];
  /** Bounded rationale summary. */
  readonly rationale: string;
  /**
   * The estimated paid-inference cost in micro-USD for hybrid/
   * generative routes; null on deterministic routes (no paid
   * dispatch).
   */
  readonly estimatedCostMicroUsd: string | null;
}

export interface MessagingSubtaskRouter {
  routeTurn(request: MessagingTurnRouteRequest): Promise<MessagingTurnRoute>;
}
