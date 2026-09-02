/**
 * In-memory edge store (edge integration adapter; WORK-029).
 *
 * The migration-0024-faithful fake for the unit world: every arbitration
 * the SQL schema enforces physically (keyed convergence, gapless
 * sequences, terminal immutability, write-once bindings, monotonic
 * counters) is enforced HERE with the same semantics, so the unit suites
 * prove the same behavior the real-PG suites prove. Not durable — the
 * crash proofs at the unit level re-boot a fresh store over a surviving
 * seed; the real crash proofs run against the SQL store (real PG).
 */

import { PlatformError } from "../../../shared/errors";
import type {
  EdgeActuationEventRecord,
  EdgeApprovalRecord,
  EdgeCommandRecord,
  EdgeDeviceRecord,
  EdgeEnvelopeRecord,
  EdgeHealthReport,
  EdgeReconciliationRecord,
  EdgeSensorObservationRecord,
} from "../domain/edge";
import { isTerminalEdgeCommandStatus } from "../domain/edge";
import type {
  EdgeActuationEventInsertInput,
  EdgeActuationEventInsertOutcome,
  EdgeApprovalDecisionOutcome,
  EdgeApprovalInsertInput,
  EdgeApprovalInsertOutcome,
  EdgeCommandFinalizeInput,
  EdgeCommandInsertInput,
  EdgeCommandInsertOutcome,
  EdgeCommandLedgerBinding,
  EdgeDeviceInsertInput,
  EdgeDeviceInsertOutcome,
  EdgeDeviceRevokeInput,
  EdgeDeviceRevokeOutcome,
  EdgeEnvelopeInsertInput,
  EdgeEnvelopeInsertOutcome,
  EdgeEnvelopeRevokeInput,
  EdgeEnvelopeRevokeOutcome,
  EdgeEnvelopeSupersedeInput,
  EdgeHealthReportInsertInput,
  EdgeOperationBeginInput,
  EdgeOperationBeginOutcome,
  EdgeOperationRecord,
  EdgeReconciliationInsertInput,
  EdgeSensorObservationInsertInput,
  EdgeSensorObservationInsertOutcome,
  EdgeStore,
} from "../ports/edge-store";

/** A raw mutable row shape (the record contract is readonly at the seam). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class InMemoryEdgeStore implements EdgeStore {
  private readonly devices: Mutable<EdgeDeviceRecord>[] = [];
  private readonly healthReports: {
    id: string;
    applicationId: string;
    tenantId: string;
    deviceId: string;
    health: EdgeHealthReport;
    reportedAt: string;
  }[] = [];
  private readonly approvals: Mutable<EdgeApprovalRecord>[] = [];
  private readonly envelopes: Mutable<EdgeEnvelopeRecord>[] = [];
  private readonly commands: Mutable<EdgeCommandRecord>[] = [];
  private readonly actuationEvents: Mutable<EdgeActuationEventRecord>[] = [];
  private readonly sensorObservations: Mutable<EdgeSensorObservationRecord>[] = [];
  private readonly reconciliations: Mutable<EdgeReconciliationRecord>[] = [];
  private readonly operations: Mutable<EdgeOperationRecord>[] = [];

  // -- devices ---------------------------------------------------------------

  async insertDevice(input: EdgeDeviceInsertInput): Promise<EdgeDeviceInsertOutcome> {
    const existing = this.devices.find(
      (row) => row.applicationId === input.applicationId && row.deviceKey === input.deviceKey,
    );
    if (existing !== undefined) {
      return {
        status: "existing",
        record: { ...existing },
        fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
      };
    }
    const record: Mutable<EdgeDeviceRecord> = {
      id: input.deviceId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deviceKey: input.deviceKey,
      requestFingerprint: input.requestFingerprint,
      label: input.label,
      workloadClasses: [...input.workloadClasses] as EdgeDeviceRecord["workloadClasses"],
      capabilityAtoms: [...input.capabilityAtoms],
      controllerRef: input.controllerRef,
      status: "registered",
      health: null,
      lastCommandSequence: 0,
      lastDispatchedSequence: 0,
      createdAt: input.createdAt,
      revokedAt: null,
      revocationReason: null,
    };
    this.devices.push(record);
    return { status: "inserted", record: { ...record } };
  }

  async findDevice(applicationId: string, deviceId: string): Promise<EdgeDeviceRecord | null> {
    const row = this.devices.find(
      (entry) => entry.applicationId === applicationId && entry.id === deviceId,
    );
    return row === undefined ? null : { ...row };
  }

  async findDeviceByKey(
    applicationId: string,
    deviceKey: string,
  ): Promise<EdgeDeviceRecord | null> {
    const row = this.devices.find(
      (entry) => entry.applicationId === applicationId && entry.deviceKey === deviceKey,
    );
    return row === undefined ? null : { ...row };
  }

  async applyGuardedDeviceRevocation(
    input: EdgeDeviceRevokeInput,
  ): Promise<EdgeDeviceRevokeOutcome> {
    const row = this.requireDevice(input.applicationId, input.deviceId);
    if (row.status !== "registered") {
      return { status: "converged", record: { ...row } };
    }
    row.status = "revoked";
    row.revokedAt = input.revokedAt;
    row.revocationReason = input.reason;
    return { status: "revoked", record: { ...row } };
  }

  async insertHealthReport(input: EdgeHealthReportInsertInput): Promise<EdgeDeviceRecord> {
    const row = this.requireDevice(input.applicationId, input.deviceId);
    this.healthReports.push({
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      health: input.health,
      reportedAt: input.reportedAt,
    });
    row.health = input.health;
    return { ...row };
  }

  async listDevices(applicationId: string): Promise<readonly EdgeDeviceRecord[]> {
    return this.devices
      .filter((row) => row.applicationId === applicationId)
      .map((row) => ({ ...row }));
  }

  // -- approvals ---------------------------------------------------------------

  async insertApproval(input: EdgeApprovalInsertInput): Promise<EdgeApprovalInsertOutcome> {
    const existing = this.approvals.find(
      (row) => row.applicationId === input.applicationId && row.approvalKey === input.approvalKey,
    );
    if (existing !== undefined) {
      return { status: "existing", record: { ...existing } };
    }
    const record: Mutable<EdgeApprovalRecord> = {
      id: input.approvalId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      deviceId: input.deviceId,
      subjectKind: input.subjectKind as EdgeApprovalRecord["subjectKind"],
      subjectFingerprint: input.subjectFingerprint,
      policyBasis: input.policyBasis,
      status: "pending",
      approvalKey: input.approvalKey,
      requestedAt: input.requestedAt,
      decidedAt: null,
      approverId: null,
      decision: null,
      expiresAt: input.expiresAt,
      ledgerWaitSequence: null,
      ledgerResumeSequence: null,
    };
    this.approvals.push(record);
    return { status: "inserted", record: { ...record } };
  }

  async findApproval(
    applicationId: string,
    approvalId: string,
  ): Promise<EdgeApprovalRecord | null> {
    const row = this.approvals.find(
      (entry) => entry.applicationId === applicationId && entry.id === approvalId,
    );
    return row === undefined ? null : { ...row };
  }

  async findApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<EdgeApprovalRecord | null> {
    const row = this.approvals.find(
      (entry) => entry.applicationId === applicationId && entry.approvalKey === approvalKey,
    );
    return row === undefined ? null : { ...row };
  }

  async listPendingApprovalsForExecution(
    applicationId: string,
    executionId: string,
    excludeApprovalId?: string,
  ): Promise<readonly EdgeApprovalRecord[]> {
    return this.approvals
      .filter(
        (row) =>
          row.applicationId === applicationId &&
          row.executionId === executionId &&
          row.status === "pending" &&
          row.id !== excludeApprovalId,
      )
      .map((row) => ({ ...row }));
  }

  async applyApprovalDecision(input: EdgeApprovalDecisionOutcome): Promise<EdgeApprovalRecord> {
    const row = this.approvals.find(
      (entry) => entry.applicationId === input.applicationId && entry.id === input.approvalId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge approval ${input.approvalId} does not exist`,
      });
    }
    if (row.status !== "pending") {
      if (row.decision === input.decision && row.approverId === input.approverId) {
        return { ...row }; // converged replay of the same decision
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge approval ${row.id} is already decided (${row.status}); decisions are terminal-immutable`,
      });
    }
    row.status = input.decision;
    row.decision = input.decision;
    row.decidedAt = input.decidedAt;
    row.approverId = input.approverId;
    return { ...row };
  }

  async bindApprovalLedgerSequences(
    applicationId: string,
    approvalId: string,
    sequences: { readonly waitSequence?: number; readonly resumeSequence?: number },
  ): Promise<EdgeApprovalRecord> {
    const row = this.approvals.find(
      (entry) => entry.applicationId === applicationId && entry.id === approvalId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge approval ${approvalId} does not exist`,
      });
    }
    if (sequences.waitSequence !== undefined && row.ledgerWaitSequence === null) {
      row.ledgerWaitSequence = sequences.waitSequence;
    }
    if (sequences.resumeSequence !== undefined && row.ledgerResumeSequence === null) {
      row.ledgerResumeSequence = sequences.resumeSequence;
    }
    return { ...row };
  }

  // -- envelopes ---------------------------------------------------------------

  async insertEnvelope(input: EdgeEnvelopeInsertInput): Promise<EdgeEnvelopeInsertOutcome> {
    const existing = this.envelopes.find(
      (row) => row.applicationId === input.applicationId && row.envelopeKey === input.envelopeKey,
    );
    if (existing !== undefined) {
      return {
        status: "existing",
        record: { ...existing },
        fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
      };
    }
    const record: Mutable<EdgeEnvelopeRecord> = {
      id: input.envelopeId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      deviceId: input.deviceId,
      envelopeKey: input.envelopeKey,
      requestFingerprint: input.requestFingerprint,
      contentDigest: input.contentDigest,
      content: input.content,
      status: "admitted",
      admission: input.admission,
      supersedesEnvelopeId: input.supersedesEnvelopeId,
      supersededByEnvelopeId: null,
      commandCount: 0,
      createdAt: input.createdAt,
      supersededAt: null,
      revokedAt: null,
      revocationReason: null,
    };
    this.envelopes.push(record);
    return { status: "inserted", record: { ...record } };
  }

  async findEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    const row = this.envelopes.find(
      (entry) => entry.applicationId === applicationId && entry.id === envelopeId,
    );
    return row === undefined ? null : { ...row };
  }

  async findEnvelopeByKey(
    applicationId: string,
    envelopeKey: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    const row = this.envelopes.find(
      (entry) => entry.applicationId === applicationId && entry.envelopeKey === envelopeKey,
    );
    return row === undefined ? null : { ...row };
  }

  async findActiveEnvelopeForDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    const candidates = this.envelopes
      .filter(
        (row) =>
          row.applicationId === applicationId &&
          row.deviceId === deviceId &&
          row.status === "admitted",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const latest = candidates[0];
    return latest === undefined ? null : { ...latest };
  }

  async listEnvelopesByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeEnvelopeRecord[]> {
    return this.envelopes
      .filter((row) => row.applicationId === applicationId && row.deviceId === deviceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((row) => ({ ...row }));
  }

  async applyEnvelopeSupersede(input: EdgeEnvelopeSupersedeInput): Promise<EdgeEnvelopeRecord> {
    const row = this.requireEnvelope(input.applicationId, input.envelopeId);
    if (row.status === "superseded") {
      if (row.supersededByEnvelopeId === input.supersededByEnvelopeId) {
        return { ...row }; // converged
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge envelope ${row.id} is already superseded by a different admission; supersede links are write-once`,
      });
    }
    if (row.status !== "admitted") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge envelope ${row.id} is ${row.status}; only admitted envelopes are superseded`,
      });
    }
    row.status = "superseded";
    row.supersededByEnvelopeId = input.supersededByEnvelopeId;
    row.supersededAt = input.supersededAt;
    return { ...row };
  }

  async applyGuardedEnvelopeRevocation(
    input: EdgeEnvelopeRevokeInput,
  ): Promise<EdgeEnvelopeRevokeOutcome> {
    const row = this.requireEnvelope(input.applicationId, input.envelopeId);
    if (row.status === "revoked") {
      return { status: "converged", record: { ...row } };
    }
    if (row.status !== "admitted") {
      return {
        status: "rejected",
        reason: `the envelope is ${row.status} (only an admitted envelope can be revoked)`,
        record: { ...row },
      };
    }
    row.status = "revoked";
    row.revokedAt = input.revokedAt;
    row.revocationReason = input.reason;
    return { status: "revoked", record: { ...row } };
  }

  async bumpEnvelopeCommandCount(input: {
    readonly applicationId: string;
    readonly envelopeId: string;
    readonly increment: number;
  }): Promise<EdgeEnvelopeRecord> {
    const row = this.requireEnvelope(input.applicationId, input.envelopeId);
    row.commandCount += input.increment;
    return { ...row };
  }

  // -- commands ----------------------------------------------------------------

  async insertCommand(input: EdgeCommandInsertInput): Promise<EdgeCommandInsertOutcome> {
    const existing = this.commands.find(
      (row) => row.applicationId === input.applicationId && row.commandKey === input.commandKey,
    );
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        // Keyed convergence: a same-key/same-fingerprint insert lets the
        // arbiter deduplicate; a different fingerprint is key reuse.
        return {
          status: "existing",
          record: { ...existing },
          fingerprintMismatch: true,
        };
      }
      return { status: "existing", record: { ...existing }, fingerprintMismatch: false };
    }
    // The gapless authoritative sequence (INCLUDING denied requests).
    const count = this.commands.filter(
      (row) => row.applicationId === input.applicationId && row.deviceId === input.deviceId,
    ).length;
    if (input.sequence !== count + 1) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge device ${input.deviceId} command sequence must be gapless (expected ${count + 1}, got ${input.sequence})`,
        details: { guard: "ec_commands_sequence_gate" },
      });
    }
    const record: Mutable<EdgeCommandRecord> = {
      id: input.commandId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      deviceId: input.deviceId,
      envelopeId: input.envelopeId,
      commandKey: input.commandKey,
      requestFingerprint: input.requestFingerprint,
      sequence: input.sequence,
      commandKind: input.commandKind,
      effectClass: input.effectClass,
      channel: input.channel as EdgeCommandRecord["channel"],
      magnitude: input.magnitude,
      payloadDigest: input.payloadDigest,
      estimatedMicroUsd: input.estimatedMicroUsd,
      notBefore: input.notBefore,
      notAfter: input.notAfter,
      status: input.denialClass === null ? "authorized" : "denied",
      denialClass: input.denialClass,
      denialReason: input.denialReason,
      approvalId: input.approvalId,
      failureClass: null,
      failureMessage: null,
      dispatchDigest: null,
      usageMicroUsd: null,
      dispatchedAt: null,
      settledAt: null,
      reconciledAt: null,
      createdAt: input.requestedAt,
      ledgerRequestedSequence: null,
      ledgerResultSequence: null,
    };
    this.commands.push(record);
    // The AFTER-INSERT triggers: the device stream counter and the
    // envelope's command budget.
    const device = this.requireDevice(input.applicationId, input.deviceId);
    if (device.lastCommandSequence < input.sequence) {
      device.lastCommandSequence = input.sequence;
    }
    const envelope = this.requireEnvelope(input.applicationId, input.envelopeId);
    envelope.commandCount += 1;
    return { status: "claimed", record: { ...record } };
  }

  async finalizeCommand(input: EdgeCommandFinalizeInput): Promise<EdgeCommandRecord> {
    const row = this.commands.find(
      (entry) => entry.applicationId === input.applicationId && entry.id === input.commandId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${input.commandId} does not exist`,
      });
    }
    if (isTerminalEdgeCommandStatus(row.status)) {
      if (row.status === input.status) {
        return { ...row }; // converged replay of the same terminal outcome
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge command ${row.id} is terminal-immutable in status ${row.status}`,
        details: { guard: "ec_commands_lifecycle_guard" },
      });
    }
    const legal =
      (row.status === "authorized" &&
        (input.status === "dispatched" ||
          input.status === "failed" ||
          input.status === "invalidated")) ||
      (row.status === "dispatched" &&
        (input.status === "settled" || input.status === "failed" || input.status === "conflicted"));
    if (!legal) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge command ${row.id} cannot move from ${row.status} to ${input.status}`,
        details: { guard: "ec_commands_lifecycle_guard" },
      });
    }
    row.status = input.status;
    row.failureClass = input.failureClass;
    row.failureMessage = input.failureMessage;
    if (input.dispatchDigest !== null && row.dispatchDigest === null) {
      row.dispatchDigest = input.dispatchDigest;
    }
    row.usageMicroUsd = input.usageMicroUsd;
    if (input.dispatchedAt !== null && row.dispatchedAt === null) {
      row.dispatchedAt = input.dispatchedAt;
    }
    row.settledAt = input.settledAt;
    row.reconciledAt = input.reconciledAt;
    if (input.ledgerResultSequence !== null && row.ledgerResultSequence === null) {
      row.ledgerResultSequence = input.ledgerResultSequence;
    }
    if (row.status === "dispatched" || row.status === "settled") {
      const device = this.requireDevice(row.applicationId, row.deviceId);
      if (device.lastDispatchedSequence < row.sequence) {
        device.lastDispatchedSequence = row.sequence;
      }
    }
    return { ...row };
  }

  async bindCommandLedgerSequence(input: EdgeCommandLedgerBinding): Promise<EdgeCommandRecord> {
    const row = this.commands.find(
      (entry) => entry.applicationId === input.applicationId && entry.id === input.commandId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${input.commandId} does not exist`,
      });
    }
    if (input.phase === "requested" && row.ledgerRequestedSequence === null) {
      row.ledgerRequestedSequence = input.sequence;
    }
    if (input.phase === "result" && row.ledgerResultSequence === null) {
      row.ledgerResultSequence = input.sequence;
    }
    return { ...row };
  }

  async findCommand(applicationId: string, commandId: string): Promise<EdgeCommandRecord | null> {
    const row = this.commands.find(
      (entry) => entry.applicationId === applicationId && entry.id === commandId,
    );
    return row === undefined ? null : { ...row };
  }

  async findCommandByKey(
    applicationId: string,
    commandKey: string,
  ): Promise<EdgeCommandRecord | null> {
    const row = this.commands.find(
      (entry) => entry.applicationId === applicationId && entry.commandKey === commandKey,
    );
    return row === undefined ? null : { ...row };
  }

  async listCommandsByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeCommandRecord[]> {
    return this.commands
      .filter((row) => row.applicationId === applicationId && row.deviceId === deviceId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ ...row }));
  }

  async listCommandsByEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<readonly EdgeCommandRecord[]> {
    return this.commands
      .filter((row) => row.applicationId === applicationId && row.envelopeId === envelopeId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ ...row }));
  }

  async settleCommand(
    applicationId: string,
    commandId: string,
    settledAt: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord> {
    const row = this.commands.find(
      (entry) => entry.applicationId === applicationId && entry.id === commandId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${commandId} does not exist`,
      });
    }
    if (row.status === "settled") {
      return { ...row }; // settled EXACTLY ONCE (the convergence)
    }
    if (row.status !== "dispatched") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge command ${row.id} is ${row.status}; only dispatched commands settle`,
        details: { guard: "ec_commands_lifecycle_guard" },
      });
    }
    row.status = "settled";
    row.settledAt = settledAt;
    row.reconciledAt = reconciledAt;
    return { ...row };
  }

  async conflictCommand(
    applicationId: string,
    commandId: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord> {
    const row = this.commands.find(
      (entry) => entry.applicationId === applicationId && entry.id === commandId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${commandId} does not exist`,
      });
    }
    if (row.status === "conflicted") {
      return { ...row };
    }
    if (row.status !== "dispatched") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge command ${row.id} is ${row.status}; only dispatched commands conflict`,
        details: { guard: "ec_commands_lifecycle_guard" },
      });
    }
    row.status = "conflicted";
    row.reconciledAt = reconciledAt;
    return { ...row };
  }

  // -- actuation events ----------------------------------------------------------

  async insertActuationEvent(
    input: EdgeActuationEventInsertInput,
  ): Promise<EdgeActuationEventInsertOutcome> {
    const existing = this.actuationEvents.find(
      (row) =>
        row.applicationId === input.applicationId &&
        row.deviceId === input.deviceId &&
        row.actuationDigest === input.actuationDigest,
    );
    if (existing !== undefined) {
      return { status: "converged", record: { ...existing } };
    }
    const record: Mutable<EdgeActuationEventRecord> = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      commandKey: input.commandKey,
      sequence: input.sequence,
      actuationClass: input.actuationClass as EdgeActuationEventRecord["actuationClass"],
      violationKind: input.violationKind,
      channel:
        input.channel === null ? null : (input.channel as EdgeActuationEventRecord["channel"]),
      magnitude: input.magnitude,
      actuationDigest: input.actuationDigest,
      occurredAt: input.occurredAt,
      reconciledAt: input.reconciledAt,
      reconciliationId: input.reconciliationId,
    };
    this.actuationEvents.push(record);
    return { status: "inserted", record: { ...record } };
  }

  async listActuationEvents(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeActuationEventRecord[]> {
    return this.actuationEvents
      .filter((row) => row.applicationId === applicationId && row.deviceId === deviceId)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
      .map((row) => ({ ...row }));
  }

  // -- sensor observations ---------------------------------------------------------

  async insertSensorObservation(
    input: EdgeSensorObservationInsertInput,
  ): Promise<EdgeSensorObservationInsertOutcome> {
    const existing = this.sensorObservations.find(
      (row) =>
        row.applicationId === input.applicationId && row.observationKey === input.observationKey,
    );
    if (existing !== undefined) {
      if (existing.contentDigest !== input.contentDigest) {
        return {
          status: "conflict",
          reason: `sensor observation key ${input.observationKey} was already used with different content (key reuse)`,
        };
      }
      return { status: "converged", record: { ...existing } };
    }
    // The gapless per-device sequence (computed here, as the SQL store does).
    const count = this.sensorObservations.filter(
      (row) => row.applicationId === input.applicationId && row.deviceId === input.deviceId,
    ).length;
    const record: Mutable<EdgeSensorObservationRecord> = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      deviceId: input.deviceId,
      sequence: count + 1,
      observationKey: input.observationKey,
      observationType: input.observationType as EdgeSensorObservationRecord["observationType"],
      retention: input.retention as EdgeSensorObservationRecord["retention"],
      contentDigest: input.contentDigest,
      content: input.content,
      observedAt: input.observedAt,
      ledgerSequence: null,
    };
    this.sensorObservations.push(record);
    return { status: "inserted", record: { ...record } };
  }

  async bindSensorObservationLedgerSequence(
    applicationId: string,
    observationId: string,
    ledgerSequence: number,
  ): Promise<EdgeSensorObservationRecord> {
    const row = this.sensorObservations.find(
      (entry) => entry.applicationId === applicationId && entry.id === observationId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge sensor observation ${observationId} does not exist`,
      });
    }
    if (row.ledgerSequence === null) {
      row.ledgerSequence = ledgerSequence;
    }
    return { ...row };
  }

  async listSensorObservations(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeSensorObservationRecord[]> {
    return this.sensorObservations
      .filter((row) => row.applicationId === applicationId && row.deviceId === deviceId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ ...row }));
  }

  // -- reconciliations ----------------------------------------------------------

  async insertReconciliation(
    input: EdgeReconciliationInsertInput,
  ): Promise<EdgeReconciliationRecord> {
    const record: Mutable<EdgeReconciliationRecord> = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      reportDigest: input.reportDigest,
      status: input.status,
      confirmedCount: input.confirmedCount,
      autonomousCount: input.autonomousCount,
      violationCount: input.violationCount,
      settledCount: input.settledCount,
      reconciledAt: input.reconciledAt,
    };
    this.reconciliations.push(record);
    return { ...record };
  }

  async findReconciliationByDigest(
    applicationId: string,
    reportDigest: string,
  ): Promise<EdgeReconciliationRecord | null> {
    const row = this.reconciliations.find(
      (entry) => entry.applicationId === applicationId && entry.reportDigest === reportDigest,
    );
    return row === undefined ? null : { ...row };
  }

  async findConflictReconciliation(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeReconciliationRecord | null> {
    const conflicts = this.reconciliations
      .filter(
        (row) =>
          row.applicationId === applicationId &&
          row.deviceId === deviceId &&
          row.status === "conflict",
      )
      .sort((a, b) =>
        a.reconciledAt < b.reconciledAt ? 1 : a.reconciledAt > b.reconciledAt ? -1 : 0,
      );
    const latest = conflicts[0];
    return latest === undefined ? null : { ...latest };
  }

  // -- the durable operation state -------------------------------------------------

  async beginEdgeOperation(input: EdgeOperationBeginInput): Promise<EdgeOperationBeginOutcome> {
    const existing = this.operations.find(
      (row) => row.applicationId === input.applicationId && row.operationKey === input.operationKey,
    );
    if (existing !== undefined) {
      if (existing.status === "pending") {
        existing.attempts += 1; // a re-claim of a PENDING row is a retry
        existing.updatedAt = input.createdAt;
      }
      return { status: "existing", record: { ...existing } };
    }
    const record: Mutable<EdgeOperationRecord> = {
      id: input.operationId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deviceId: input.deviceId,
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
    this.operations.push(record);
    return { status: "begun", record: { ...record } };
  }

  async recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<EdgeOperationRecord> {
    const row = this.requireOperation(applicationId, operationKey);
    if (row.status === "pending") {
      row.stage = { ...stage };
      row.updatedAt = updatedAt;
    }
    return { ...row };
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<EdgeOperationRecord> {
    const row = this.requireOperation(applicationId, operationKey);
    if (row.status === "pending") {
      row.status = "completed";
      row.completedAt = completedAt;
      row.updatedAt = completedAt;
    }
    return { ...row };
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    updatedAt: string,
  ): Promise<EdgeOperationRecord> {
    const row = this.requireOperation(applicationId, operationKey);
    if (row.status === "pending") {
      row.status = "failed";
      row.failureReason = reason;
      row.updatedAt = updatedAt;
    }
    return { ...row };
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<EdgeOperationRecord | null> {
    const row = this.operations.find(
      (entry) => entry.applicationId === applicationId && entry.operationKey === operationKey,
    );
    return row === undefined ? null : { ...row };
  }

  // -- internal helpers ---------------------------------------------------------

  private requireDevice(applicationId: string, deviceId: string): Mutable<EdgeDeviceRecord> {
    const row = this.devices.find(
      (entry) => entry.applicationId === applicationId && entry.id === deviceId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge device ${deviceId} does not exist in application ${applicationId}`,
      });
    }
    return row;
  }

  private requireEnvelope(applicationId: string, envelopeId: string): Mutable<EdgeEnvelopeRecord> {
    const row = this.envelopes.find(
      (entry) => entry.applicationId === applicationId && entry.id === envelopeId,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge envelope ${envelopeId} does not exist in application ${applicationId}`,
      });
    }
    return row;
  }

  private requireOperation(
    applicationId: string,
    operationKey: string,
  ): Mutable<EdgeOperationRecord> {
    const row = this.operations.find(
      (entry) => entry.applicationId === applicationId && entry.operationKey === operationKey,
    );
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge operation ${operationKey} does not exist in application ${applicationId}`,
      });
    }
    return row;
  }
}
