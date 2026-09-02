/**
 * In-memory computer-use store (tools module adapter; WORK-027).
 *
 * The faithful unit-world implementation of the `ComputerUseStore` port —
 * the exact durable contract the SQL adapter implements over migration
 * 0023 (the WORK-028 in-memory-long-running-store discipline):
 *
 *  - per-key promise queues stand in for the physical UNIQUE-index
 *    arbitrations (session key, escalation (session, to-mode), action
 *    key, observation sequence, operation key) — true concurrency
 *    locking is owned by the real-PostgreSQL suites;
 *  - sessions: insert converges on (application, session key) with
 *    request-fingerprint arbitration; the identity core is immutable on
 *    every mutation path; guarded status moves (active -> terminal
 *    exactly once, duplicates converge); the escalation ladder only
 *    ascends; terminal rows are fully immutable;
 *  - escalations: append-only, gapless per-session sequence (denied
 *    rows included), convergence on the (session, to-mode) key;
 *  - actions: the keyed journal — insert converges on (session, action
 *    key) with input-digest arbitration, gapless per-session sequence
 *    INCLUDING denied requests, dispatching -> terminal exactly once,
 *    write-once ledger-sequence bindings;
 *  - observations: append-only, gapless, digest-arbitrated convergence
 *    (same sequence + same digest converges; different digest fails
 *    closed);
 *  - operations: the WORK-024 durable recoverable state — stable-key
 *    claim with fingerprint arbitration and monotonic attempts, the
 *    stage checkpoint writable only while PENDING, terminal rows
 *    immutable and convergent.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  ComputerUseActionRecord,
  ComputerUseEscalationRecord,
  ComputerUseObservationRecord,
  ComputerUseOperationRecord,
  ComputerUseSessionRecord,
} from "../domain/computer-use";
import {
  COMPUTER_USE_MODES,
  isComputerUseMode,
  isComputerUseSessionStatus,
  isTerminalComputerUseSessionStatus,
} from "../domain/computer-use";
import type {
  ComputerUseActionFinalizeInput,
  ComputerUseActionInsertInput,
  ComputerUseActionLedgerBinding,
  ComputerUseEscalationInsertInput,
  ComputerUseObservationInsertInput,
  ComputerUseSessionInsertInput,
  ComputerUseSessionPatch,
  ComputerUseSessionStatusMutation,
  ComputerUseStore,
} from "../ports/computer-use-store";

const MODE_INDEX: Readonly<Record<string, number>> = {
  deterministic: 0,
  browser: 1,
  desktop: 2,
};

export class InMemoryComputerUseStore implements ComputerUseStore {
  private readonly sessions = new Map<string, ComputerUseSessionRecord>();
  private readonly escalations = new Map<string, ComputerUseEscalationRecord>();
  private readonly actions = new Map<string, ComputerUseActionRecord>();
  private readonly observations = new Map<string, ComputerUseObservationRecord>();
  private readonly operations = new Map<string, ComputerUseOperationRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -- sessions ---------------------------------------------------------------

  private sessionBy(
    applicationId: string,
    predicate: (record: ComputerUseSessionRecord) => boolean,
  ): ComputerUseSessionRecord | null {
    for (const record of this.sessions.values()) {
      if (record.applicationId === applicationId && predicate(record)) {
        return record;
      }
    }
    return null;
  }

  async findSession(
    applicationId: string,
    sessionId: string,
  ): Promise<ComputerUseSessionRecord | null> {
    const record = this.sessions.get(sessionId);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }

  async findSessionByKey(
    applicationId: string,
    sessionKey: string,
  ): Promise<ComputerUseSessionRecord | null> {
    return this.sessionBy(applicationId, (record) => record.sessionKey === sessionKey);
  }

  async listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ComputerUseSessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (record) => record.applicationId === applicationId && record.executionId === executionId,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  insertSession(input: ComputerUseSessionInsertInput) {
    return this.queue(`ins|${input.applicationId}|${input.sessionKey}`, async () => {
      const existing = await this.findSessionByKey(input.applicationId, input.sessionKey);
      if (existing !== null) {
        return {
          status: "existing" as const,
          record: existing,
          fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
        };
      }
      if (!isComputerUseSessionStatus(input.denialClass === null ? "active" : "denied")) {
        throw new PlatformError({ code: "TOOL_ERROR", message: "invalid session status" });
      }
      if (!isComputerUseMode(input.initialMode)) {
        throw new PlatformError({
          code: "TOOL_ERROR",
          message: "initial mode must be a computer-use mode vocabulary value",
        });
      }
      const record: ComputerUseSessionRecord = {
        id: input.sessionId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        executionId: input.executionId,
        sessionKey: input.sessionKey,
        requestFingerprint: input.requestFingerprint,
        taskKind: input.taskKind as ComputerUseSessionRecord["taskKind"],
        status: input.denialClass === null ? "active" : "denied",
        initialMode: input.initialMode,
        currentMode: input.initialMode,
        routeEvidence: input.routeEvidence,
        admission: input.admission,
        modeContext: input.modeContext,
        environmentRef: null,
        environmentOpenedMode: null,
        denialClass: (input.denialClass ?? null) as ComputerUseSessionRecord["denialClass"],
        denialReason: input.denialReason ?? null,
        escalationCount: 0,
        usageMicroUsd: "0",
        requestedAt: input.createdAt,
        activatedAt: input.denialClass === null ? input.createdAt : null,
        terminalAt: null,
        terminalCause: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      this.sessions.set(record.id, record);
      return { status: "inserted" as const, record };
    });
  }

  patchSession(input: ComputerUseSessionPatch) {
    return this.queue(`ses|${input.applicationId}|${input.sessionId}`, async () => {
      const existing = await this.findSession(input.applicationId, input.sessionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (isTerminalComputerUseSessionStatus(existing.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session is terminal-immutable in ${existing.status}`,
          details: { guard: "cu_sessions_lifecycle_guard" },
        });
      }
      const nextMode = input.currentMode ?? existing.currentMode;
      const nextModeIndex = MODE_INDEX[nextMode] ?? -1;
      const currentModeIndex = MODE_INDEX[existing.currentMode] ?? -1;
      if (nextModeIndex < currentModeIndex) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session escalation ladder only ascends (${existing.currentMode} -> ${nextMode})`,
          details: { guard: "cu_sessions_lifecycle_guard" },
        });
      }
      const updated: ComputerUseSessionRecord = {
        ...existing,
        environmentRef: input.environmentRef,
        environmentOpenedMode:
          input.environmentOpenedMode as ComputerUseSessionRecord["environmentOpenedMode"],
        currentMode: (input.currentMode ??
          existing.currentMode) as ComputerUseSessionRecord["currentMode"],
        modeContext: input.currentEnvelope ?? existing.modeContext,
        escalationCount: input.escalationCount ?? existing.escalationCount,
        usageMicroUsd: input.usageMicroUsd ?? existing.usageMicroUsd,
        updatedAt: input.updatedAt,
      };
      this.sessions.set(updated.id, updated);
      return updated;
    });
  }

  applyGuardedSessionMutation(input: ComputerUseSessionStatusMutation) {
    return this.queue(`ses|${input.applicationId}|${input.sessionId}`, async () => {
      const existing = await this.findSession(input.applicationId, input.sessionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (existing.status === input.targetStatus) {
        return { status: "converged" as const, record: existing };
      }
      if (existing.status !== input.expectedStatus) {
        return {
          status: "rejected" as const,
          reason: `computer-use session is ${existing.status}; the guarded move expects ${input.expectedStatus}`,
          record: existing,
        };
      }
      const updated: ComputerUseSessionRecord = {
        ...existing,
        status: input.targetStatus,
        terminalAt: input.updatedAt,
        terminalCause: input.targetStatus,
        updatedAt: input.updatedAt,
      };
      this.sessions.set(updated.id, updated);
      return { status: "moved" as const, record: updated };
    });
  }

  // -- escalations --------------------------------------------------------------

  private escalationBy(
    applicationId: string,
    sessionId: string,
    toMode: string,
  ): ComputerUseEscalationRecord | null {
    for (const record of this.escalations.values()) {
      if (
        record.applicationId === applicationId &&
        record.sessionId === sessionId &&
        record.toMode === toMode
      ) {
        return record;
      }
    }
    return null;
  }

  async listEscalations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseEscalationRecord[]> {
    return [...this.escalations.values()]
      .filter((record) => record.applicationId === applicationId && record.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  insertEscalation(input: ComputerUseEscalationInsertInput) {
    return this.queue(`esc|${input.applicationId}|${input.sessionId}`, async () => {
      const existing = this.escalationBy(input.applicationId, input.sessionId, input.toMode);
      if (existing !== null) {
        return { status: "existing" as const, record: existing };
      }
      const session = await this.findSession(input.applicationId, input.sessionId);
      if (session === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (session.status !== "active") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session is ${session.status}; escalations require an active session`,
          details: { guard: "cu_escalations_sequence_gate" },
        });
      }
      const count = (await this.listEscalations(input.applicationId, input.sessionId)).length;
      if (input.sequence !== count + 1) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session escalation sequence must be gapless (expected ${count + 1}, got ${input.sequence})`,
          details: { guard: "cu_escalations_sequence_gate" },
        });
      }
      const record: ComputerUseEscalationRecord = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        executionId: session.executionId,
        sequence: input.sequence,
        fromMode: input.fromMode as ComputerUseEscalationRecord["fromMode"],
        toMode: input.toMode as ComputerUseEscalationRecord["toMode"],
        reasonCode: input.reasonCode,
        reasonDetail: input.reasonDetail,
        insufficiencyDigest: input.insufficiencyDigest,
        capabilityId: input.capabilityId,
        admittedAt: input.admittedAt,
        ledgerSequence: input.ledgerSequence,
      };
      this.escalations.set(record.id, record);
      return { status: "inserted" as const, record };
    });
  }

  // -- actions --------------------------------------------------------------------

  private actionBy(
    applicationId: string,
    sessionId: string,
    actionKey: string,
  ): ComputerUseActionRecord | null {
    for (const record of this.actions.values()) {
      if (
        record.applicationId === applicationId &&
        record.sessionId === sessionId &&
        record.actionKey === actionKey
      ) {
        return record;
      }
    }
    return null;
  }

  async listActions(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseActionRecord[]> {
    return [...this.actions.values()]
      .filter((record) => record.applicationId === applicationId && record.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async findActionByKey(
    applicationId: string,
    sessionId: string,
    actionKey: string,
  ): Promise<ComputerUseActionRecord | null> {
    return this.actionBy(applicationId, sessionId, actionKey);
  }

  insertAction(input: ComputerUseActionInsertInput) {
    return this.queue(`act|${input.applicationId}|${input.sessionId}`, async () => {
      const existing = this.actionBy(input.applicationId, input.sessionId, input.actionKey);
      if (existing !== null) {
        return {
          status: "existing" as const,
          record: existing,
          fingerprintMismatch: existing.inputDigest !== input.inputDigest,
        };
      }
      const session = await this.findSession(input.applicationId, input.sessionId);
      if (session === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (session.status !== "active") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session is ${session.status}; actions require an active session`,
          details: { guard: "cu_actions_sequence_gate" },
        });
      }
      const count = (await this.listActions(input.applicationId, input.sessionId)).length;
      if (input.sequence !== count + 1) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session action sequence must be gapless (expected ${count + 1}, got ${input.sequence})`,
          details: { guard: "cu_actions_sequence_gate" },
        });
      }
      const record: ComputerUseActionRecord = {
        id: input.actionId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        actionKey: input.actionKey,
        sequence: input.sequence,
        mode: input.mode as ComputerUseActionRecord["mode"],
        actionType: input.actionType as ComputerUseActionRecord["actionType"],
        target: input.target,
        sideEffect: input.sideEffect as ComputerUseActionRecord["sideEffect"],
        status: "dispatching",
        capabilityId: input.capabilityId,
        failureClass: null,
        failureMessage: null,
        inputDigest: input.inputDigest,
        resultDigest: null,
        usageMicroUsd: null,
        environmentRef: null,
        sandboxExecutionId: null,
        observationSequences: [],
        requestedAt: input.requestedAt,
        dispatchedAt: null,
        completedAt: null,
        durationMs: null,
        ledgerRequestedSequence: null,
        ledgerResultSequence: null,
      };
      this.actions.set(record.id, record);
      return { status: "claimed" as const, record };
    });
  }

  finalizeAction(input: ComputerUseActionFinalizeInput) {
    return this.queue(`actfin|${input.applicationId}|${input.actionId}`, async () => {
      const existing = this.actions.get(input.actionId);
      if (existing === undefined || existing.applicationId !== input.applicationId) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use action row disappeared (rows are never deleted)",
        });
      }
      if (existing.status !== "dispatching") {
        // Guarded first-writer-wins: converge on the committed outcome.
        return existing;
      }
      const updated: ComputerUseActionRecord = {
        ...existing,
        status: input.status,
        failureClass: input.failureClass,
        failureMessage: input.failureMessage,
        resultDigest: input.resultDigest,
        usageMicroUsd: input.usageMicroUsd,
        environmentRef: input.environmentRef,
        sandboxExecutionId: input.sandboxExecutionId,
        observationSequences: [...input.observationSequences],
        dispatchedAt: input.dispatchedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
        ...(input.ledgerResultSequence === null
          ? {}
          : { ledgerResultSequence: input.ledgerResultSequence }),
      };
      this.actions.set(updated.id, updated);
      return updated;
    });
  }

  bindActionLedgerSequence(input: ComputerUseActionLedgerBinding) {
    return this.queue(`actbind|${input.applicationId}|${input.actionId}`, async () => {
      const existing = this.actions.get(input.actionId);
      if (existing === undefined || existing.applicationId !== input.applicationId) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use action row disappeared (rows are never deleted)",
        });
      }
      const bound =
        input.phase === "requested"
          ? existing.ledgerRequestedSequence
          : existing.ledgerResultSequence;
      if (bound !== null) {
        // Write-once: the binding never moves; a re-bind converges.
        return existing;
      }
      const updated: ComputerUseActionRecord =
        input.phase === "requested"
          ? { ...existing, ledgerRequestedSequence: input.sequence }
          : { ...existing, ledgerResultSequence: input.sequence };
      this.actions.set(updated.id, updated);
      return updated;
    });
  }

  // -- observations -----------------------------------------------------------------

  private observationBy(
    applicationId: string,
    sessionId: string,
    sequence: number,
  ): ComputerUseObservationRecord | null {
    for (const record of this.observations.values()) {
      if (
        record.applicationId === applicationId &&
        record.sessionId === sessionId &&
        record.sequence === sequence
      ) {
        return record;
      }
    }
    return null;
  }

  async listObservations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseObservationRecord[]> {
    return [...this.observations.values()]
      .filter((record) => record.applicationId === applicationId && record.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  insertObservation(input: ComputerUseObservationInsertInput) {
    return this.queue(`obs|${input.applicationId}|${input.sessionId}`, async () => {
      const existing = this.observationBy(input.applicationId, input.sessionId, input.sequence);
      if (existing !== null) {
        if (existing.contentDigest === input.contentDigest) {
          return { status: "converged" as const, record: existing };
        }
        return {
          status: "conflict" as const,
          reason: `computer-use session observation sequence ${input.sequence} already exists with a different content digest (same key, different body)`,
        };
      }
      const session = await this.findSession(input.applicationId, input.sessionId);
      if (session === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (session.status !== "active") {
        return {
          status: "conflict" as const,
          reason: `computer-use session is ${session.status}; observations require an active session`,
        };
      }
      const count = (await this.listObservations(input.applicationId, input.sessionId)).length;
      if (input.sequence !== count + 1) {
        return {
          status: "conflict" as const,
          reason: `computer-use session observation sequence must be gapless (expected ${count + 1}, got ${input.sequence})`,
        };
      }
      const record: ComputerUseObservationRecord = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        sequence: input.sequence,
        observationType: input.observationType as ComputerUseObservationRecord["observationType"],
        mode: input.mode as ComputerUseObservationRecord["mode"],
        contentDigest: input.contentDigest,
        retention: input.retention as ComputerUseObservationRecord["retention"],
        redaction: input.redaction as ComputerUseObservationRecord["redaction"],
        content: input.content,
        artifactRef: input.artifactRef,
        capabilityId: input.capabilityId,
        actionId: input.actionId,
        observedAt: input.observedAt,
        ledgerSequence: input.ledgerSequence,
      };
      this.observations.set(record.id, record);
      return { status: "inserted" as const, record };
    });
  }

  // -- the durable operation state ------------------------------------------------------

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<ComputerUseOperationRecord | null> {
    for (const record of this.operations.values()) {
      if (record.applicationId === applicationId && record.operationKey === operationKey) {
        return record;
      }
    }
    return null;
  }

  beginComputerUseOperation(input: Parameters<ComputerUseStore["beginComputerUseOperation"]>[0]) {
    return this.queue(`op|${input.applicationId}|${input.operationKey}`, async () => {
      const existing = await this.findOperation(input.applicationId, input.operationKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "computer-use operation key was already used with a different request fingerprint",
            details: { operationId: existing.id },
          });
        }
        if (existing.status === "pending") {
          const bumped: ComputerUseOperationRecord = {
            ...existing,
            attempts: existing.attempts + 1,
            updatedAt: input.createdAt,
          };
          this.operations.set(bumped.id, bumped);
          return { status: "existing" as const, record: bumped };
        }
        return { status: "existing" as const, record: existing };
      }
      const record: ComputerUseOperationRecord = {
        id: input.operationId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        operationKind: input.operationKind,
        operationKey: input.operationKey,
        requestFingerprint: input.requestFingerprint,
        status: "pending",
        attempts: 1,
        stage: null,
        failureReason: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: null,
      };
      this.operations.set(record.id, record);
      return { status: "begun" as const, record };
    });
  }

  recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ) {
    return this.queue(`op|${applicationId}|${operationKey}`, async () => {
      const existing = await this.findOperation(applicationId, operationKey);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use operation row disappeared (rows are never deleted)",
        });
      }
      if (existing.status !== "pending") {
        // Terminal rows converge: the stage is frozen evidence.
        return existing;
      }
      const updated: ComputerUseOperationRecord = {
        ...existing,
        stage: { ...stage },
        updatedAt,
      };
      this.operations.set(updated.id, updated);
      return updated;
    });
  }

  private finishOperation(
    applicationId: string,
    operationKey: string,
    finalize: (record: ComputerUseOperationRecord) => ComputerUseOperationRecord,
  ) {
    return this.queue(`op|${applicationId}|${operationKey}`, async () => {
      const existing = await this.findOperation(applicationId, operationKey);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use operation row disappeared (rows are never deleted)",
        });
      }
      if (existing.status !== "pending") {
        return existing;
      }
      const updated = finalize(existing);
      this.operations.set(updated.id, updated);
      return updated;
    });
  }

  completeOperation(applicationId: string, operationKey: string, completedAt: string) {
    return this.finishOperation(applicationId, operationKey, (record) => ({
      ...record,
      status: "completed",
      completedAt,
      updatedAt: completedAt,
    }));
  }

  failOperation(applicationId: string, operationKey: string, reason: string, updatedAt: string) {
    return this.finishOperation(applicationId, operationKey, (record) => ({
      ...record,
      status: "failed",
      failureReason: reason,
      updatedAt,
    }));
  }
}

/** The frozen mode order (mirrors COMPUTER_USE_MODES; proof surface). */
export const IN_MEMORY_COMPUTER_USE_MODE_ORDER: readonly string[] = [...COMPUTER_USE_MODES];
