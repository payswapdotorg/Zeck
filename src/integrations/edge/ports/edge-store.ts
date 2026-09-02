/**
 * Edge store port (edge integration outbound; WORK-029 — the durable
 * state of the governed edge fabric, migration 0024).
 *
 * The durable-state seam for devices (tenant-scoped, revocable), the
 * approval ledger, the immutable safety envelopes, the keyed command
 * journal, the append-only actuation/sensor provenance ledgers and the
 * DURABLE, RECOVERABLE OPERATION STATE. The arbitration contract (the
 * WORK-024/025/026/027/028 discipline):
 *
 *   - device registration converges on (application, device_key) with
 *     request-fingerprint arbitration (a same-key/different-body
 *     request fails closed — IDEMPOTENCY_KEY_REUSED); revocation is a
 *     GUARDED terminal mutation (first writer wins, duplicates
 *     converge; rows are never deleted);
 *   - approvals converge on (application, approval_key); the decision
 *     is the ONLY legal update (exactly-once, terminal-immutable);
 *   - envelope admission converges on (application, envelope_key)
 *     with fingerprint arbitration; the envelope CONTENT is immutable
 *     post-admission (the content digest is pinned at insert; the only
 *     stored moves are an authorized supersede — which writes the NEW
 *     row and links the old one — and an authorized revocation);
 *   - the command journal converges on (application, command_key)
 *     with fingerprint arbitration; the per-device sequence is GAPLESS
 *     and includes denied requests; dispatch ordering strictly
 *     ASCENDS the sequence (the out-of-order guard); ledger sequence
 *     bindings are write-once (NULL -> value, never moved); terminal
 *     statuses are fully immutable;
 *   - actuation events and sensor observations are APPEND-ONLY with
 *     convergence-aware duplicate discipline (an exact duplicate
 *     converges; a same-key/different-digest insert fails closed);
 *   - the DURABLE, RECOVERABLE OPERATION STATE (the WORK-024
 *     crash-safety standard): every governed edge side-effect
 *     operation owns ONE row with a PENDING → COMPLETED|FAILED
 *     machine. `beginEdgeOperation` converges on the physical UNIQUE
 *     (application, operation_key) and bumps `attempts` on re-claim;
 *     `completed`/`failed` are terminal-immutable; a crash between
 *     claim and completion leaves the row PENDING and a retry MUST
 *     resume it from the stage checkpoint;
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type {
  EdgeActuationEventRecord,
  EdgeApprovalDecisionInput,
  EdgeApprovalRecord,
  EdgeCommandEffectClass,
  EdgeCommandKind,
  EdgeCommandRecord,
  EdgeCommandStatus,
  EdgeDeviceRecord,
  EdgeDeviceStatus,
  EdgeEnvelopeRecord,
  EdgeEnvelopeStatus,
  EdgeHealthReport,
  EdgeReconciliationRecord,
  EdgeSensorObservationRecord,
} from "../domain/edge";

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface EdgeDeviceInsertInput {
  readonly deviceId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceKey: string;
  readonly requestFingerprint: string;
  readonly label: string;
  readonly workloadClasses: readonly string[];
  readonly capabilityAtoms: readonly string[];
  readonly controllerRef: string;
  readonly createdAt: string;
}

export type EdgeDeviceInsertOutcome =
  | { readonly status: "inserted"; readonly record: EdgeDeviceRecord }
  | {
      readonly status: "existing";
      readonly record: EdgeDeviceRecord;
      /** Set when the existing row's fingerprint differs (key reuse). */
      readonly fingerprintMismatch: boolean;
    };

export interface EdgeDeviceRevokeInput {
  readonly applicationId: string;
  readonly deviceId: string;
  readonly expectedStatus: EdgeDeviceStatus;
  readonly reason: string;
  readonly revokedAt: string;
}

export type EdgeDeviceRevokeOutcome =
  | { readonly status: "revoked"; readonly record: EdgeDeviceRecord }
  | { readonly status: "converged"; readonly record: EdgeDeviceRecord }
  | { readonly status: "rejected"; readonly reason: string; readonly record: EdgeDeviceRecord };

export interface EdgeHealthReportInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly health: EdgeHealthReport;
  readonly reportedAt: string;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface EdgeApprovalInsertInput {
  readonly approvalId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly subjectKind: string;
  readonly subjectFingerprint: string;
  readonly policyBasis: string;
  readonly approvalKey: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
}

export type EdgeApprovalInsertOutcome =
  | { readonly status: "inserted"; readonly record: EdgeApprovalRecord }
  | { readonly status: "existing"; readonly record: EdgeApprovalRecord };

export interface EdgeApprovalDecisionOutcome {
  readonly approvalId: string;
  readonly applicationId: string;
  readonly decision: EdgeApprovalDecisionInput["decision"];
  readonly approverId: string;
  readonly rationale: string;
  readonly decidedAt: string;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface EdgeEnvelopeInsertInput {
  readonly envelopeId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeKey: string;
  readonly requestFingerprint: string;
  readonly contentDigest: string;
  readonly content: EdgeEnvelopeRecord["content"];
  readonly admission: EdgeEnvelopeRecord["admission"];
  readonly supersedesEnvelopeId: string | null;
  readonly createdAt: string;
}

export type EdgeEnvelopeInsertOutcome =
  | { readonly status: "inserted"; readonly record: EdgeEnvelopeRecord }
  | {
      readonly status: "existing";
      readonly record: EdgeEnvelopeRecord;
      readonly fingerprintMismatch: boolean;
    };

export interface EdgeEnvelopeSupersedeInput {
  readonly applicationId: string;
  readonly envelopeId: string;
  readonly supersededByEnvelopeId: string;
  readonly supersededAt: string;
}

export interface EdgeEnvelopeRevokeInput {
  readonly applicationId: string;
  readonly envelopeId: string;
  readonly expectedStatus: EdgeEnvelopeStatus;
  readonly reason: string;
  readonly revokedAt: string;
}

export type EdgeEnvelopeRevokeOutcome =
  | { readonly status: "revoked"; readonly record: EdgeEnvelopeRecord }
  | { readonly status: "converged"; readonly record: EdgeEnvelopeRecord }
  | { readonly status: "rejected"; readonly reason: string; readonly record: EdgeEnvelopeRecord };

/** Increment the envelope's authorized-command counter (bounded by maxCommands). */
export interface EdgeEnvelopeCommandCountInput {
  readonly applicationId: string;
  readonly envelopeId: string;
  readonly increment: number;
}

// ---------------------------------------------------------------------------
// Commands (the keyed journal)
// ---------------------------------------------------------------------------

export interface EdgeCommandInsertInput {
  readonly commandId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly commandKey: string;
  readonly requestFingerprint: string;
  readonly sequence: number;
  readonly commandKind: EdgeCommandKind;
  readonly effectClass: EdgeCommandEffectClass;
  readonly channel: string;
  readonly magnitude: number;
  readonly payloadDigest: string;
  readonly estimatedMicroUsd: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly approvalId: string | null;
  readonly denialClass: string | null;
  readonly denialReason: string | null;
  readonly requestedAt: string;
}

export type EdgeCommandInsertOutcome =
  | { readonly status: "claimed"; readonly record: EdgeCommandRecord }
  | {
      readonly status: "existing";
      readonly record: EdgeCommandRecord;
      readonly fingerprintMismatch: boolean;
    };

export interface EdgeCommandFinalizeInput {
  readonly applicationId: string;
  readonly commandId: string;
  readonly status: Exclude<EdgeCommandStatus, "authorized" | "denied">;
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  readonly dispatchDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly ledgerResultSequence: number | null;
  readonly dispatchedAt: string | null;
  readonly settledAt: string | null;
  readonly reconciledAt: string | null;
}

/** The write-once ledger-sequence binding (NULL -> value; never moved). */
export interface EdgeCommandLedgerBinding {
  readonly applicationId: string;
  readonly commandId: string;
  readonly phase: "requested" | "result";
  readonly sequence: number;
}

// ---------------------------------------------------------------------------
// Actuation events (append-only reconciliation provenance)
// ---------------------------------------------------------------------------

export interface EdgeActuationEventInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string | null;
  readonly deviceId: string;
  readonly commandId: string | null;
  readonly commandKey: string | null;
  readonly sequence: number | null;
  readonly actuationClass: string;
  readonly violationKind: string | null;
  readonly channel: string | null;
  readonly magnitude: number | null;
  readonly actuationDigest: string;
  readonly occurredAt: string;
  readonly reconciledAt: string;
  readonly reconciliationId: string | null;
}

export type EdgeActuationEventInsertOutcome =
  | { readonly status: "inserted"; readonly record: EdgeActuationEventRecord }
  | { readonly status: "converged"; readonly record: EdgeActuationEventRecord };

// ---------------------------------------------------------------------------
// Sensor observations (append-only, sequence-gapless)
// ---------------------------------------------------------------------------

export interface EdgeSensorObservationInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly observationKey: string;
  readonly observationType: string;
  readonly retention: string;
  readonly contentDigest: string;
  readonly content: string | null;
  readonly observedAt: string;
}

export type EdgeSensorObservationInsertOutcome =
  | { readonly status: "inserted"; readonly record: EdgeSensorObservationRecord }
  | { readonly status: "converged"; readonly record: EdgeSensorObservationRecord }
  | { readonly status: "conflict"; readonly reason: string };

// ---------------------------------------------------------------------------
// Reconciliations
// ---------------------------------------------------------------------------

export interface EdgeReconciliationInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly reportDigest: string;
  readonly status: "converged" | "conflict";
  readonly confirmedCount: number;
  readonly autonomousCount: number;
  readonly violationCount: number;
  readonly settledCount: number;
  readonly reconciledAt: string;
}

// ---------------------------------------------------------------------------
// The durable, recoverable operation state (the WORK-024 standard)
// ---------------------------------------------------------------------------

export interface EdgeOperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Provenance references only (may be null for device-level operations). */
  readonly deviceId: string | null;
  /** Execution provenance (null only for device-register/device-revoke). */
  readonly executionId: string | null;
  readonly operationKind:
    | "device-register"
    | "device-revoke"
    | "health-report"
    | "envelope-admit"
    | "envelope-revoke"
    | "command-submit"
    | "approval-request"
    | "approval-decide"
    | "sensor-ingest"
    | "reconcile";
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

export interface EdgeOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceId: string | null;
  readonly executionId: string | null;
  readonly operationKind: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly status: "pending" | "completed" | "failed";
  readonly attempts: number;
  readonly stage: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type EdgeOperationBeginOutcome =
  | { readonly status: "begun"; readonly record: EdgeOperationRecord }
  | { readonly status: "existing"; readonly record: EdgeOperationRecord };

export interface EdgeStore {
  // -- devices ---------------------------------------------------------------
  insertDevice(input: EdgeDeviceInsertInput): Promise<EdgeDeviceInsertOutcome>;
  findDevice(applicationId: string, deviceId: string): Promise<EdgeDeviceRecord | null>;
  findDeviceByKey(applicationId: string, deviceKey: string): Promise<EdgeDeviceRecord | null>;
  applyGuardedDeviceRevocation(input: EdgeDeviceRevokeInput): Promise<EdgeDeviceRevokeOutcome>;
  insertHealthReport(input: EdgeHealthReportInsertInput): Promise<EdgeDeviceRecord>;
  listDevices(applicationId: string): Promise<readonly EdgeDeviceRecord[]>;

  // -- approvals ---------------------------------------------------------------
  insertApproval(input: EdgeApprovalInsertInput): Promise<EdgeApprovalInsertOutcome>;
  findApproval(applicationId: string, approvalId: string): Promise<EdgeApprovalRecord | null>;
  findApprovalByKey(applicationId: string, approvalKey: string): Promise<EdgeApprovalRecord | null>;
  /**
   * The PENDING approvals gating one execution (optionally excluding one
   * id). The multi-gate discipline: an execution may hold SEVERAL live
   * human gates at once and the executions lifecycle holds a single
   * WAITING_HUMAN state for all of them — resume fires only when the
   * LAST live gate closes (service-side liveness filter on expiresAt).
   */
  listPendingApprovalsForExecution(
    applicationId: string,
    executionId: string,
    excludeApprovalId?: string,
  ): Promise<readonly EdgeApprovalRecord[]>;
  applyApprovalDecision(input: EdgeApprovalDecisionOutcome): Promise<EdgeApprovalRecord>;
  /** The write-once ledger-sequence bindings (NULL -> value; never moved). */
  bindApprovalLedgerSequences(
    applicationId: string,
    approvalId: string,
    sequences: {
      readonly waitSequence?: number;
      readonly resumeSequence?: number;
    },
  ): Promise<EdgeApprovalRecord>;

  // -- envelopes ---------------------------------------------------------------
  insertEnvelope(input: EdgeEnvelopeInsertInput): Promise<EdgeEnvelopeInsertOutcome>;
  findEnvelope(applicationId: string, envelopeId: string): Promise<EdgeEnvelopeRecord | null>;
  findEnvelopeByKey(applicationId: string, envelopeKey: string): Promise<EdgeEnvelopeRecord | null>;
  findActiveEnvelopeForDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeEnvelopeRecord | null>;
  /** Every envelope that ever governed the device (reconciliation classification). */
  listEnvelopesByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeEnvelopeRecord[]>;
  applyEnvelopeSupersede(input: EdgeEnvelopeSupersedeInput): Promise<EdgeEnvelopeRecord>;
  applyGuardedEnvelopeRevocation(
    input: EdgeEnvelopeRevokeInput,
  ): Promise<EdgeEnvelopeRevokeOutcome>;
  bumpEnvelopeCommandCount(input: EdgeEnvelopeCommandCountInput): Promise<EdgeEnvelopeRecord>;

  // -- commands ----------------------------------------------------------------
  insertCommand(input: EdgeCommandInsertInput): Promise<EdgeCommandInsertOutcome>;
  finalizeCommand(input: EdgeCommandFinalizeInput): Promise<EdgeCommandRecord>;
  bindCommandLedgerSequence(input: EdgeCommandLedgerBinding): Promise<EdgeCommandRecord>;
  findCommand(applicationId: string, commandId: string): Promise<EdgeCommandRecord | null>;
  findCommandByKey(applicationId: string, commandKey: string): Promise<EdgeCommandRecord | null>;
  listCommandsByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeCommandRecord[]>;
  listCommandsByEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<readonly EdgeCommandRecord[]>;
  settleCommand(
    applicationId: string,
    commandId: string,
    settledAt: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord>;
  conflictCommand(
    applicationId: string,
    commandId: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord>;

  // -- actuation events ----------------------------------------------------------
  insertActuationEvent(
    input: EdgeActuationEventInsertInput,
  ): Promise<EdgeActuationEventInsertOutcome>;
  listActuationEvents(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeActuationEventRecord[]>;

  // -- sensor observations ---------------------------------------------------------
  insertSensorObservation(
    input: EdgeSensorObservationInsertInput,
  ): Promise<EdgeSensorObservationInsertOutcome>;
  /** The write-once ledger-sequence binding (NULL -> value; never moved). */
  bindSensorObservationLedgerSequence(
    applicationId: string,
    observationId: string,
    ledgerSequence: number,
  ): Promise<EdgeSensorObservationRecord>;
  listSensorObservations(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeSensorObservationRecord[]>;

  // -- reconciliations ----------------------------------------------------------
  insertReconciliation(input: EdgeReconciliationInsertInput): Promise<EdgeReconciliationRecord>;
  findReconciliationByDigest(
    applicationId: string,
    reportDigest: string,
  ): Promise<EdgeReconciliationRecord | null>;
  /** The device's latest CONFLICT reconciliation (the conflicted-device gate). */
  findConflictReconciliation(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeReconciliationRecord | null>;

  // -- the durable operation state -------------------------------------------------
  beginEdgeOperation(input: EdgeOperationBeginInput): Promise<EdgeOperationBeginOutcome>;
  /** Stage checkpoint (PENDING rows only; race-tolerant: terminal rows converge). */
  recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<EdgeOperationRecord>;
  completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<EdgeOperationRecord>;
  failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    updatedAt: string,
  ): Promise<EdgeOperationRecord>;
  findOperation(applicationId: string, operationKey: string): Promise<EdgeOperationRecord | null>;
}
