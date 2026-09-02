/**
 * In-memory realtime store (deployments module adapter; WORK-024).
 *
 * The test/world implementation of the `RealtimeStore` port with the
 * SAME arbitration contract as the SQL store (migration 0018):
 * idempotent session creation, guarded session mutations, the
 * append-only channel journal as the inbound idempotency ledger, and
 * the stale-callback freshness guard.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  RealtimeChannelKind,
  RealtimeEventDirection,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeRouteClass,
  RealtimeSessionRecord,
  RealtimeSessionStatus,
} from "../domain/realtime";
import { canTransitionRealtimeSession, isTerminalRealtimeSessionStatus } from "../domain/realtime";
import type {
  RealtimeEventAppendInput,
  RealtimeEventAppendOutcome,
  RealtimeSessionInsertInput,
  RealtimeSessionInsertOutcome,
  RealtimeSessionMutation,
  RealtimeSessionMutationOutcome,
  RealtimeStore,
} from "../ports/realtime-store";

interface MemoryRealtimeSession {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly channelKind: string;
  channelSessionRef: string;
  channelEpoch: number;
  readonly callerRef: string | null;
  status: RealtimeSessionStatus;
  readonly creationFingerprint: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export class InMemoryRealtimeStore implements RealtimeStore {
  private readonly sessions = new Map<string, MemoryRealtimeSession>();
  private readonly sessionEvents = new Map<string, RealtimeEventRecord[]>();
  private readonly eventsByLogicalKey = new Map<string, RealtimeEventRecord>();
  private seq = 0;

  async insertSession(input: RealtimeSessionInsertInput): Promise<RealtimeSessionInsertOutcome> {
    const sessionKey = `${input.applicationId}:${input.idempotencyKey}`;
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      if (existing.creationFingerprint !== input.creationFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "realtime session idempotency key already exists with a different creation fingerprint",
          details: { sessionId: existing.id },
        });
      }
      return { status: "converged", sessionId: existing.id };
    }
    for (const session of this.sessions.values()) {
      if (
        session.applicationId === input.applicationId &&
        session.channelSessionRef === input.channelSessionRef &&
        session.channelEpoch === input.channelEpoch
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the rail channel reference is already bound to another realtime session",
          details: { channelSessionRef: input.channelSessionRef },
        });
      }
    }
    const session: MemoryRealtimeSession = {
      id: input.sessionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deploymentId: input.deploymentId,
      pinnedPlanId: input.pinnedPlanId,
      pinnedPlanVersion: input.pinnedPlanVersion,
      executionId: input.executionId,
      channelKind: input.channelKind,
      channelSessionRef: input.channelSessionRef,
      channelEpoch: input.channelEpoch,
      callerRef: input.callerRef,
      status: "live",
      creationFingerprint: input.creationFingerprint,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      closedAt: null,
    };
    this.sessions.set(sessionKey, session);
    this.sessionEvents.set(session.id, []);
    return { status: "created", sessionId: session.id };
  }

  async findSession(applicationId: string, sessionId: string) {
    for (const session of this.sessions.values()) {
      if (session.applicationId === applicationId && session.id === sessionId) {
        return this.toRecord(session);
      }
    }
    return null;
  }

  async findSessionByStartKey(applicationId: string, idempotencyKey: string) {
    const sessionKey = `${applicationId}:${idempotencyKey}`;
    const session = this.sessions.get(sessionKey);
    return session === undefined ? null : this.toRecord(session);
  }

  async findSessionByChannel(
    applicationId: string,
    channelSessionRef: string,
    channelEpoch: number,
  ) {
    for (const session of this.sessions.values()) {
      if (
        session.applicationId === applicationId &&
        session.channelSessionRef === channelSessionRef &&
        session.channelEpoch === channelEpoch
      ) {
        return this.toRecord(session);
      }
    }
    return null;
  }

  async applyGuardedSessionMutation(
    input: RealtimeSessionMutation,
  ): Promise<RealtimeSessionMutationOutcome> {
    const session = this.findMutable(input.applicationId, input.sessionId);
    if (input.expectedStatus !== session.status) {
      // A concurrent duplicate already committed the same logical
      // mutation: converge on the committed row when the target state
      // is what we intended; otherwise surface the disagreement.
      if (input.toStatus === session.status) {
        return { status: "converged", session: this.toRecord(session) };
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} is ${session.status}; the guarded move expected ${input.expectedStatus}`,
      });
    }
    if (isTerminalRealtimeSessionStatus(session.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} is terminal-immutable (${session.status})`,
      });
    }
    if (!canTransitionRealtimeSession(session.status, input.toStatus)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} cannot move from ${session.status} to ${input.toStatus}`,
      });
    }
    if (
      input.expectedChannelRef !== null &&
      input.expectedChannelEpoch !== null &&
      (input.expectedChannelRef !== session.channelSessionRef ||
        input.expectedChannelEpoch !== session.channelEpoch)
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "the session's current channel coordinates changed concurrently (reattach guard)",
      });
    }
    // The migration trigger's twins: the channel epoch is MONOTONIC and a
    // channel reference cannot change without advancing the epoch
    // (COALESCE semantics — a null target keeps the current value, exactly
    // like the SQL guarded UPDATE).
    const effectiveChannelRef = input.toChannelRef ?? session.channelSessionRef;
    const effectiveChannelEpoch = input.toChannelEpoch ?? session.channelEpoch;
    if (effectiveChannelEpoch < session.channelEpoch) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} channel epoch must not regress (${session.channelEpoch} -> ${effectiveChannelEpoch})`,
      });
    }
    if (
      effectiveChannelEpoch === session.channelEpoch &&
      effectiveChannelRef !== session.channelSessionRef
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} cannot change channel reference without advancing the epoch`,
      });
    }
    if (input.toChannelRef !== null || input.toChannelEpoch !== null) {
      session.channelSessionRef = effectiveChannelRef;
      session.channelEpoch = effectiveChannelEpoch;
    }
    session.status = input.toStatus;
    session.updatedAt = input.closedAt ?? session.updatedAt;
    session.closedAt = input.closedAt ?? session.closedAt;
    return { status: "applied", session: this.toRecord(session) };
  }

  async appendChannelEvent(input: RealtimeEventAppendInput): Promise<RealtimeEventAppendOutcome> {
    const session = this.findMutable(input.applicationId, input.sessionId);
    if (input.executionId !== null && input.executionId !== session.executionId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "realtime event execution provenance does not match the session's execution identity",
      });
    }
    // The stale-callback guard (the migration trigger's twin): an
    // inbound event must arrive on the session's CURRENT channel
    // coordinates.
    if (
      input.direction === "inbound" &&
      (input.channelSessionRef !== session.channelSessionRef ||
        input.channelEpoch !== session.channelEpoch)
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `stale realtime callback rejected: event on channel ${input.channelSessionRef} epoch ${input.channelEpoch} but session ${input.sessionId} currently holds channel ${session.channelSessionRef} epoch ${session.channelEpoch}`,
      });
    }
    if (isTerminalRealtimeSessionStatus(session.status) && input.direction === "inbound") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `realtime session ${input.sessionId} is terminal (${session.status}); inbound events are rejected`,
      });
    }
    const logicalKey = `${input.applicationId}:${input.sessionId}:${input.eventKey}`;
    const existing = this.eventsByLogicalKey.get(logicalKey);
    if (existing !== undefined) {
      if (existing.bodyDigest !== input.bodyDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "realtime event key already exists with a different body",
          details: { eventKey: input.eventKey },
        });
      }
      return { status: "converged", event: existing };
    }
    this.seq += 1;
    const record: RealtimeEventRecord = {
      id: input.eventId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      deploymentId: input.deploymentId,
      kind: input.kind,
      direction: input.direction,
      eventKey: input.eventKey,
      channelSessionRef: input.channelSessionRef,
      channelEpoch: input.channelEpoch,
      executionId: input.executionId,
      ledgerSequence: input.ledgerSequence,
      routeClass: input.routeClass,
      cause: input.cause,
      payloadRef: input.payloadRef,
      payloadPreview: input.payloadPreview,
      actorId: input.actorId,
      eventSeq: this.seq,
      bodyDigest: input.bodyDigest,
      createdAt: input.createdAt,
    };
    this.eventsByLogicalKey.set(logicalKey, record);
    const journal = this.sessionEvents.get(input.sessionId);
    if (journal !== undefined) {
      journal.push(record);
    }
    return { status: "appended", event: record };
  }

  async listEvents(applicationId: string, sessionId: string) {
    return [...(this.sessionEvents.get(sessionId) ?? [])]
      .filter((event) => event.applicationId === applicationId)
      .sort((a, b) => a.eventSeq - b.eventSeq);
  }

  private findMutable(applicationId: string, sessionId: string): MemoryRealtimeSession {
    for (const session of this.sessions.values()) {
      if (session.applicationId === applicationId && session.id === sessionId) {
        return session;
      }
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `realtime session ${sessionId} not found in this application`,
    });
  }

  private toRecord(session: MemoryRealtimeSession): RealtimeSessionRecord {
    return {
      ...session,
      channelKind: session.channelKind as RealtimeChannelKind,
      creationFingerprint: session.creationFingerprint,
    };
  }
}

// Re-exported for the adapter barrel's typed consumers.
export type { RealtimeEventDirection, RealtimeEventKind, RealtimeRouteClass };
