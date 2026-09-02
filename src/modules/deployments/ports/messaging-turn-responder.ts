/**
 * Messaging turn-responder port (deployments module inbound seam;
 * WORK-025, MOD-008/MOD-009).
 *
 * The seam where the DEPLOYED AGENT'S reply handling plugs into the
 * messaging conversation fabric: given the admitted inbound message
 * (its planner-decided route class), the responder produces the
 * outbound reply frame the rail sends to the participant. The
 * deployments module owns the CONVERSATION fabric (identity,
 * admission, idempotency, ordering evidence, provenance, delivery) —
 * NOT the reply content:
 *
 *   - a DETERMINISTIC route responder runs deterministic computation
 *     only (a menu handler, a scripted flow, a retrieval lookup — no
 *     generative inference, no paid dispatch);
 *   - a HYBRID/GENERATIVE route responder may perform inference, which
 *     the conversation fabric has already admitted (policy →
 *     capability → budget reservation → secret mediation) BEFORE this
 *     seam is invoked — there is NO hidden model dispatch path: the
 *     budget reservation happened upstream and its id rides the
 *     request;
 *   - the responder returns ARTIFACT REFERENCES + a bounded preview
 *     (payload + attachments) — raw payload bytes never enter the
 *     conversation fabric or the execution ledger (lineage references
 *     only; the work order's "large attachments through artifact/
 *     object references" rule).
 *
 * Composition supplies the implementation (the deployed agent's reply
 * handler); this work order's tests use recording fakes that document
 * the contract. A production adapter over the planning/models agent
 * runtime is future work outside this work order's declared surfaces
 * and is recorded as a limitation in docs/work-items/WORK-025.md.
 */

import type { MessagingRouteClass } from "../domain/messaging";

export interface MessagingTurnResponderRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly channelKind: string;
  /** The neutral thread reference the reply posts into. */
  readonly threadRef: string | null;
  /**
   * The turn's STABLE idempotency key (the conversation-scoped inbound
   * event key — the fabric's turn-reply operation key rides the seam):
   * a production responder that performs paid inference uses it to
   * converge the inference (exactly one paid dispatch per turn across
   * crashes and retries). The fabric checkpoints the response BEFORE
   * the rail send, so a crash-recovery of the send never re-invokes
   * this seam; the residual crash window (mid-respond, before the
   * checkpoint) is bounded by THIS key's contract.
   */
  readonly turnKey: string;
  /** The planner-decided route class (deterministic/hybrid/generative). */
  readonly routeClass: MessagingRouteClass;
  /** Bounded preview of the inbound message (never raw payload). */
  readonly turnPreview: string | null;
  /** ARTIFACT REFERENCE of the inbound message payload (never the bytes). */
  readonly turnPayloadRef: string | null;
  /** The inbound message's attachment artifact references. */
  readonly turnAttachments: readonly string[];
  /** The budget reservation id when the route reserved (paid routes only). */
  readonly reservationId: string | null;
  /** The mediated channel-credential grant reference (opaque, never a value). */
  readonly channelGrantRef: string;
}

export interface MessagingTurnResponse {
  /** ARTIFACT REFERENCE of the reply payload (never the bytes). */
  readonly responseRef: string | null;
  /** Bounded text preview of the reply (never raw payload, never secrets). */
  readonly responsePreview: string;
  /** Attachment artifact references (bounded; never embedded binary data). */
  readonly responseAttachments: readonly string[];
  /**
   * The responder's actual paid usage in micro-USD ("0" when the route
   * consumed no paid inference — deterministic routes MUST report "0").
   */
  readonly actualCostMicroUsd: string;
}

export interface MessagingTurnResponder {
  respond(request: MessagingTurnResponderRequest): Promise<MessagingTurnResponse>;
}
