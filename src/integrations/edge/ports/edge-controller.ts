/**
 * Edge controller port (edge integration outbound; WORK-029,
 * EDGE-002/AC-2/AC-6).
 *
 * THE replaceable-adapter seam for external edge/embodied controllers —
 * the LOCAL substrate that owns hard real time. The port's shape makes
 * the architectural discrimination unrepresentable to violate:
 *
 *   - it carries EXACTLY three transport surfaces: `applyEnvelope`
 *     (project the pre-authorized safety envelope to the device — the
 *     disconnected continuation authority), `dispatchCommand` (one
 *     governed command submission) and `reconciliationReport` (the
 *     reconnect handshake: what the local controller executed);
 *   - it has NO loop/scheduling/tick surface: Zeck NEVER drives and is
 *     never part of the local control loop. The local controller runs
 *     its own hard-real-time loop against the envelope it holds; the
 *     simulated adapter's local loop is exercised by the WORLD (the
 *     device side), never by this service;
 *   - it holds NO authority: policy/capability/budget/human admission
 *     happen in their authorities BEFORE anything reaches this seam;
 *     the controller may only REFUSE (fail-safe) — never authorize.
 *
 * The LOCAL side re-checks the envelope bounds, the sequence
 * discipline and the staleness window on the actuator path (defense in
 * depth): a command that arrives stale, out-of-order or outside the
 * projected envelope is refused locally and NEVER actuates.
 *
 * Concrete controllers (robots, industrial cells, vehicle ECUs …)
 * implement this seam behind their own adapters; no vendor SDK crosses
 * the integration boundary (`controllerRef` is opaque).
 */

import type {
  EdgeCommandEffectClass,
  EdgeCommandKind,
  EdgeReportedActuation,
  EdgeReconciliationReport,
  EdgeSafetyEnvelopeContent,
} from "../domain/edge";

/** The governed command dispatch (Zeck → the local controller). */
export interface EdgeCommandDispatch {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly commandId: string;
  readonly commandKey: string;
  /** The authoritative sequence (strictly ascending dispatch order). */
  readonly sequence: number;
  readonly commandKind: EdgeCommandKind;
  readonly effectClass: EdgeCommandEffectClass;
  readonly channel: string;
  readonly magnitude: number;
  readonly payloadDigest: string;
  readonly notBefore: string;
  readonly notAfter: string;
  /**
   * The admitted safety envelope snapshot the command rides under —
   * the LOCAL controller's authority for executing this command while
   * disconnected (the bound it enforces on the actuator path).
   */
  readonly envelope: {
    readonly envelopeId: string;
    readonly contentDigest: string;
    readonly content: EdgeSafetyEnvelopeContent;
  };
}

export type EdgeDispatchAck =
  | {
      readonly outcome: "accepted";
      /** The local controller's journal digest for the accepted command. */
      readonly actuationDigest: string;
    }
  | {
      readonly outcome: "refused";
      readonly failureClass:
        | "envelope-coverage"
        | "stale-command"
        | "out-of-order"
        | "transport-disconnected";
      readonly message: string;
    };

export interface EdgeControllerAdapter {
  /** The neutral controller identity (never a vendor SDK). */
  readonly controllerId: string;
  /**
   * Project one envelope state to the local controller (keyed
   * exactly-once external effect per envelope+status: admitted |
   * superseded | revoked). The controller stores the envelope as its
   * local pre-authorization for disconnected continuation.
   */
  applyEnvelope(
    envelope: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly deviceId: string;
      readonly envelopeId: string;
      readonly status: "admitted" | "superseded" | "revoked";
      readonly contentDigest: string;
      readonly content: EdgeSafetyEnvelopeContent;
    },
    idempotencyKey: string,
  ): Promise<{ readonly applied: boolean }>;
  /**
   * Submit one governed command (keyed exactly-once external effect
   * per command id). The local controller re-checks the envelope
   * coverage, the staleness window and the sequence discipline BEFORE
   * any actuation — a refusal leaves ZERO actuator-path activity.
   */
  dispatchCommand(dispatch: EdgeCommandDispatch, idempotencyKey: string): Promise<EdgeDispatchAck>;
  /**
   * The reconnect handshake: the local controller's report of what it
   * executed (commanded actuations, autonomous within-envelope
   * actuations, violations and locally-refused commands) since the
   * beginning (deterministic full-journal report; reconciliation
   * converges by digest).
   */
  reconciliationReport(deviceId: string): Promise<EdgeReconciliationReport>;
  /**
   * The local controller's last executed actuation sequence witness
   * (used by the sequencing proof helpers; read-only, no authority).
   */
  lastExecutedSequence(deviceId: string): number;
}

export type { EdgeReportedActuation };
