/**
 * Simulated edge controller (edge integration adapter; WORK-029,
 * EDGE-002/AC-2/AC-5/AC-6).
 *
 * **HONESTY: this is a SIMULATED in-process local controller.** It models
 * the replaceable external edge/embodied substrate behind the
 * `EdgeControllerAdapter` seam: the held safety-envelope projection, the
 * local actuation journal, the local fail-safe refusals and the
 * deterministic reconciliation report. External controller behavior (a
 * real robot controller, a real industrial cell PLC, a real vehicle ECU,
 * real actuator hardware, real sensor buses) is **UNVERIFIED here** —
 * recorded as such in docs/work-items/WORK-029.md and pinned by the
 * architecture gate. The GOVERNED side (admission ordering, envelope
 * projection, keyed exactly-once external effects, stale-command local
 * rejection, reconnect convergence) is the contract a real adapter must
 * satisfy and is what the proofs verify.
 *
 * THE LOCAL CONTROL LOOP (the hard-real-time half) lives HERE, on the
 * device side — NEVER in the Zeck service: `autonomousTick` is driven by
 * the WORLD (the device's own clock), never by the integration. Zeck's
 * request/response path performs governance only (envelope projection,
 * one-shot command submission, reconciliation).
 *
 * The local fail-safe discipline (defense in depth — the actuator path is
 * behind TWO bound checks): a dispatched command is re-checked against
 * the HELD envelope (coverage + window), the staleness window and the
 * strictly-ascending sequence discipline BEFORE any actuation. A refusal
 * leaves ZERO actuator-path activity (the journal is the witness) and is
 * durably recorded in the local refusal list.
 *
 * The keyed external-effects journal (envelope projections keyed by
 * envelope+status; command dispatches keyed by command id) converges
 * re-submissions EXACTLY ONCE — the semantics the crash proofs require
 * (a real controller's idempotent submission endpoints deliver the same).
 */

import {
  edgeCommandFreshness,
  edgeEnvelopeCoversCommand,
} from "../domain/edge";
import type {
  EdgeActuatorChannel,
  EdgeReconciliationReport,
  EdgeSafetyEnvelopeContent,
} from "../domain/edge";
import type {
  EdgeCommandDispatch,
  EdgeControllerAdapter,
  EdgeDispatchAck,
} from "../ports/edge-controller";

interface SimulatedActuationEntry {
  readonly commandKey: string | null;
  readonly sequence: number | null;
  readonly channel: EdgeActuatorChannel;
  readonly magnitude: number;
  readonly actuationDigest: string;
  readonly occurredAt: string;
}

interface SimulatedRefusedEntry {
  readonly commandKey: string;
  readonly sequence: number | null;
  readonly reason: string;
}

interface SimulatedDeviceState {
  /** The envelope projections the device holds, keyed by envelope id. */
  readonly envelopes: Map<
    string,
    { status: "admitted" | "superseded" | "revoked"; contentDigest: string; content: EdgeSafetyEnvelopeContent }
  >;
  /** The envelope that currently governs the device (the latest admitted, un-revoked). */
  activeEnvelopeId: string | null;
  /** The executed actuation journal (commanded + autonomous), in order. */
  readonly journal: SimulatedActuationEntry[];
  /** The locally refused commands (never actuated — the fail-safe evidence). */
  readonly refused: SimulatedRefusedEntry[];
  /** The keyed external-effect acks: one submission per key, converged. */
  readonly dispatchAcks: Map<string, EdgeDispatchAck>;
  /** The applied envelope-projection keys. */
  readonly appliedKeys: Map<string, boolean>;
  /** Projections queued while the transport is down (applied on reconnect). */
  readonly pendingProjections: {
    readonly envelope: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly deviceId: string;
      readonly envelopeId: string;
      readonly status: "admitted" | "superseded" | "revoked";
      readonly contentDigest: string;
      readonly content: EdgeSafetyEnvelopeContent;
    };
    readonly idempotencyKey: string;
  }[];
}

export interface SimulatedEdgeControllerDeps {
  readonly controllerId: string;
  readonly now: () => Date;
  readonly digest: (input: string) => string;
}

export interface SimulatedEdgeController extends EdgeControllerAdapter {
  /** Drop the transport link (dispatches are refused; projections queue). */
  disconnect(): void;
  /** Restore the transport link and flush the queued envelope projections. */
  connect(): void;
  readonly connected: boolean;
  /**
   * THE LOCAL CONTROL LOOP (device-side; driven by the WORLD, never by
   * the Zeck service): the local controller actuates autonomously on its
   * own clock. Whether the actuation was within the pre-authorized
   * envelope is the GOVERNANCE classification (reconciliation); the
   * journal records what physically happened.
   */
  autonomousTick(deviceId: string, channel: EdgeActuatorChannel, magnitude: number): void;
  /** The local journal length (proof introspection). */
  journalLength(deviceId: string): number;
  /** The local refusal list (proof introspection). */
  refusedEntries(deviceId: string): readonly SimulatedRefusedEntry[];
  /** The controller's call journal (the zero-side-effect witness). */
  readonly callJournal: { readonly method: string; readonly at: string }[];
}

export function createSimulatedEdgeController(
  deps: SimulatedEdgeControllerDeps,
): SimulatedEdgeController {
  const devices = new Map<string, SimulatedDeviceState>();
  const callJournal: { method: string; at: string }[] = [];
  let connected = true;
  const now = () => deps.now().toISOString();

  const stateOf = (deviceId: string): SimulatedDeviceState => {
    const existing = devices.get(deviceId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: SimulatedDeviceState = {
      envelopes: new Map(),
      activeEnvelopeId: null,
      journal: [],
      refused: [],
      dispatchAcks: new Map(),
      appliedKeys: new Map(),
      pendingProjections: [],
    };
    devices.set(deviceId, fresh);
    return fresh;
  };

  const record = (method: string): void => {
    callJournal.push({ method, at: now() });
  };

  const applyProjection = (
    state: SimulatedDeviceState,
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
  ): { applied: boolean } => {
    if (state.appliedKeys.has(idempotencyKey)) {
      return { applied: false }; // converged replay — the projection happened exactly once
    }
    state.appliedKeys.set(idempotencyKey, true);
    state.envelopes.set(envelope.envelopeId, {
      status: envelope.status,
      contentDigest: envelope.contentDigest,
      content: envelope.content,
    });
    if (envelope.status === "admitted") {
      state.activeEnvelopeId = envelope.envelopeId;
    } else if (state.activeEnvelopeId === envelope.envelopeId) {
      state.activeEnvelopeId = null; // superseded/revoked: the held authority is withdrawn
    }
    return { applied: true };
  };

  return {
    controllerId: deps.controllerId,

    disconnect(): void {
      connected = false;
    },

    connect(): void {
      connected = true;
      // Flush the projections that queued while the link was down (the
      // transport queue a real controller rail delivers).
      for (const state of devices.values()) {
        for (const pending of state.pendingProjections) {
          applyProjection(state, pending.envelope, pending.idempotencyKey);
        }
        state.pendingProjections.length = 0;
      }
    },

    get connected() {
      return connected;
    },

    async applyEnvelope(envelope, idempotencyKey): Promise<{ readonly applied: boolean }> {
      record("applyEnvelope");
      const state = stateOf(envelope.deviceId);
      if (!connected) {
        // The link is down: the projection queues and applies on
        // reconnect (the device keeps executing ONLY within the envelope
        // it already holds).
        state.pendingProjections.push({ envelope, idempotencyKey });
        return { applied: false };
      }
      return applyProjection(state, envelope, idempotencyKey);
    },

    async dispatchCommand(
      dispatch: EdgeCommandDispatch,
      idempotencyKey: string,
    ): Promise<EdgeDispatchAck> {
      record("dispatchCommand");
      const state = stateOf(dispatch.deviceId);
      const converged = state.dispatchAcks.get(idempotencyKey);
      if (converged !== undefined) {
        return converged; // one submission per key — the keyed external effect
      }
      const refuse = (
        failureClass: "envelope-coverage" | "stale-command" | "out-of-order" | "transport-disconnected",
        message: string,
      ): EdgeDispatchAck => {
        const ack: EdgeDispatchAck = { outcome: "refused", failureClass, message };
        if (failureClass !== "transport-disconnected") {
          // The command ARRIVED and was refused locally (the fail-safe
          // evidence); a transport refusal never reached the controller.
          state.refused.push({
            commandKey: dispatch.commandKey,
            sequence: dispatch.sequence,
            reason: failureClass,
          });
        }
        state.dispatchAcks.set(idempotencyKey, ack);
        return ack;
      };
      if (!connected) {
        return refuse("transport-disconnected", "the device transport is disconnected");
      }
      // The LOCAL re-check of the HELD envelope (defense in depth: the
      // actuator path is behind TWO bound checks).
      const activeId = state.activeEnvelopeId;
      const held = activeId === null ? null : (state.envelopes.get(activeId) ?? null);
      if (
        held === null ||
        activeId !== dispatch.envelope.envelopeId ||
        held.contentDigest !== dispatch.envelope.contentDigest ||
        held.status !== "admitted"
      ) {
        return refuse(
          "envelope-coverage",
          "the device does not hold the command's safety envelope (or the envelope moved)",
        );
      }
      const coverage = edgeEnvelopeCoversCommand(
        { status: "admitted", content: held.content, commandCount: 0 },
        {
          channel: dispatch.channel as EdgeActuatorChannel,
          magnitude: dispatch.magnitude,
          notBefore: dispatch.notBefore,
          notAfter: dispatch.notAfter,
        },
        now(),
      );
      if (!coverage.covered) {
        return refuse("envelope-coverage", coverage.reason);
      }
      const freshness = edgeCommandFreshness(dispatch, now());
      if (freshness !== "fresh") {
        return refuse(
          "stale-command",
          freshness === "stale"
            ? "the command window expired before the local execution"
            : "the command window has not opened at the local execution time",
        );
      }
      // The sequence discipline: authoritative dispatches strictly ASCEND
      // (no out-of-order or duplicate local execution).
      let lastExecuted = 0;
      for (const entry of state.journal) {
        if (entry.sequence !== null && entry.sequence > lastExecuted) {
          lastExecuted = entry.sequence;
        }
      }
      if (dispatch.sequence <= lastExecuted) {
        return refuse(
          "out-of-order",
          `the local controller already executed sequence ${lastExecuted}; sequence ${dispatch.sequence} would regress the authoritative order`,
        );
      }
      // ACCEPTED: the actuation executes NOW (the local hard-real-time
      // path; the journal is the physical truth).
      const occurredAt = now();
      const actuationDigest = deps.digest(
        JSON.stringify({
          commandKey: dispatch.commandKey,
          sequence: dispatch.sequence,
          channel: dispatch.channel,
          magnitude: dispatch.magnitude,
          payloadDigest: dispatch.payloadDigest,
          occurredAt,
        }),
      );
      state.journal.push({
        commandKey: dispatch.commandKey,
        sequence: dispatch.sequence,
        channel: dispatch.channel as EdgeActuatorChannel,
        magnitude: dispatch.magnitude,
        actuationDigest,
        occurredAt,
      });
      const ack: EdgeDispatchAck = { outcome: "accepted", actuationDigest };
      state.dispatchAcks.set(idempotencyKey, ack);
      return ack;
    },

    async reconciliationReport(deviceId: string): Promise<EdgeReconciliationReport> {
      record("reconciliationReport");
      const state = stateOf(deviceId);
      const executed = state.journal.map((entry) => ({
        commandKey: entry.commandKey,
        sequence: entry.sequence,
        channel: entry.channel,
        magnitude: entry.magnitude,
        actuationDigest: entry.actuationDigest,
        occurredAt: entry.occurredAt,
      }));
      // The report is the deterministic FULL journal: the digest is
      // stable for an unchanged journal (reportedAt is the last physical
      // event, never the call time — convergence by digest).
      const reportedAt =
        state.journal.length > 0
          ? state.journal[state.journal.length - 1]?.occurredAt ?? "1970-01-01T00:00:00.000Z"
          : "1970-01-01T00:00:00.000Z";
      return {
        deviceId,
        executed,
        refused: state.refused.map((entry) => ({
          commandKey: entry.commandKey,
          sequence: entry.sequence,
          reason: entry.reason,
        })),
        reportedAt,
      };
    },

    lastExecutedSequence(deviceId: string): number {
      const state = stateOf(deviceId);
      let lastExecuted = 0;
      for (const entry of state.journal) {
        if (entry.sequence !== null && entry.sequence > lastExecuted) {
          lastExecuted = entry.sequence;
        }
      }
      return lastExecuted;
    },

    autonomousTick(deviceId: string, channel: EdgeActuatorChannel, magnitude: number): void {
      // THE DEVICE-SIDE LOOP: no service involvement (the discrimination
      // proof — the call journal stays empty of it).
      const state = stateOf(deviceId);
      const occurredAt = now();
      const actuationDigest = deps.digest(
        JSON.stringify({
          autonomous: true,
          channel,
          magnitude,
          occurredAt,
        }),
      );
      state.journal.push({
        commandKey: null,
        sequence: null,
        channel,
        magnitude,
        actuationDigest,
        occurredAt,
      });
    },

    journalLength(deviceId: string): number {
      return stateOf(deviceId).journal.length;
    },

    refusedEntries(deviceId: string): readonly SimulatedRefusedEntry[] {
      return [...stateOf(deviceId).refused];
    },

    callJournal,
  };
}
