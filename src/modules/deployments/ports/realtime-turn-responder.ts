/**
 * Realtime turn-responder port (deployments module inbound seam;
 * WORK-024, MOD-006/MOD-007).
 *
 * The seam where the DEPLOYED AGENT'S turn handling plugs into the
 * realtime session fabric: given the admitted turn (its planner-decided
 * route class), the responder produces the response frame the rail
 * delivers to the caller. The deployments module owns the SESSION
 * fabric (identity, admission, idempotency, provenance, delivery) —
 * NOT the response content:
 *
 *   - a DETERMINISTIC route responder runs deterministic computation
 *     only (a menu handler, a scripted flow, a retrieval lookup — no
 *     generative inference, no paid dispatch, MOD-007);
 *   - a HYBRID/GENERATIVE route responder may perform inference, which
 *     the session fabric has already admitted (policy → capability →
 *     budget reservation → secret mediation) BEFORE this seam is
 *     invoked — there is NO hidden model dispatch path: the budget
 *     reservation happened upstream and its id rides the request;
 *   - the responder returns ARTIFACT REFERENCES + a bounded preview —
 *     raw response media never enters the session fabric or the
 *     execution ledger (lineage references only).
 *
 * Composition supplies the implementation (the deployed agent's turn
 * handler); this work order's tests use recording fakes that document
 * the contract. A production adapter over the planning/models agent
 * runtime is future work outside this work order's declared surfaces
 * and is recorded as a limitation in docs/work-items/WORK-024.md.
 */

import type { RealtimeRouteClass } from "../domain/realtime";

export interface RealtimeTurnResponderRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly channelKind: string;
  /** The planner-decided route class (deterministic/hybrid/generative). */
  readonly routeClass: RealtimeRouteClass;
  /** Bounded preview of the inbound turn (never raw media). */
  readonly turnPreview: string | null;
  /** ARTIFACT REFERENCE of the inbound media (never the media). */
  readonly turnPayloadRef: string | null;
  /** The budget reservation id when the route reserved (paid routes only). */
  readonly reservationId: string | null;
  /** The mediated channel-credential grant reference (opaque, never a value). */
  readonly channelGrantRef: string;
}

export interface RealtimeTurnResponse {
  /** ARTIFACT REFERENCE of the response media (never the bytes). */
  readonly responseRef: string | null;
  /** Bounded text preview of the response (never raw media, never secrets). */
  readonly responsePreview: string;
  /**
   * The responder's actual paid usage in micro-USD ("0" when the route
   * consumed no paid inference — deterministic routes MUST report "0").
   */
  readonly actualCostMicroUsd: string;
}

export interface RealtimeTurnResponder {
  respond(request: RealtimeTurnResponderRequest): Promise<RealtimeTurnResponse>;
}
