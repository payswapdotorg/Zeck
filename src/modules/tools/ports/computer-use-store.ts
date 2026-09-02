/**
 * Computer-use store port (tools module outbound; WORK-027,
 * CUI-001/002/003 — the durable state of the computer-use fabric).
 *
 * The durable-state seam for computer-use sessions (the closed
 * subordinate lifecycle), the append-only ESCALATION ledger, the
 * sequence-gapless append-only OBSERVATION ledger, the keyed ACTION
 * journal and the DURABLE, RECOVERABLE OPERATION STATE (migration 0023).
 * The arbitration contract (the WORK-024/025/026/028 discipline):
 *
 *   - session creation converges on (application, session key) with
 *     request-fingerprint arbitration (a same-key/different-body request
 *     fails closed — IDEMPOTENCY_KEY_REUSED);
 *   - session mutations are GUARDED: the expected current status
 *     arbitrates concurrent duplicates — first writer wins, a duplicate
 *     converges on the committed row; the identity core (tenant/
 *     execution/session key/fingerprint/initial mode) is immutable on
 *     every UPDATE path; terminal statuses are fully immutable;
 *   - the escalation ledger is APPEND-ONLY with a gapless per-session
 *     sequence and converges on the physical UNIQUE (application,
 *     session, escalation_key);
 *   - the observation ledger is APPEND-ONLY with a gapless per-session
 *     sequence (convergence-aware: an exact duplicate — same sequence,
 *     same content digest — lets the UNIQUE deduplicate it; a
 *     same-sequence/different-digest insert fails closed) and the
 *     observation BODY digest is computed over the canonical key-sorted
 *     form (jsonb does not preserve key order — the WORK-026 lesson);
 *   - the action journal converges on the physical UNIQUE (application,
 *     session, action key) with request-fingerprint arbitration;
 *   - the DURABLE, RECOVERABLE OPERATION STATE (the WORK-024
 *     crash-safety standard): every governed computer-use side-effect
 *     operation owns ONE row with a PENDING → COMPLETED|FAILED machine.
 *     `beginComputerUseOperation` converges on the physical UNIQUE
 *     (application, operation_key) and bumps `attempts` on re-claim;
 *     `completed`/`failed` are terminal-immutable; a crash between claim
 *     and completion leaves the row PENDING and a retry MUST resume it
 *     from the stage checkpoint;
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type {
  ComputerUseActionRecord,
  ComputerUseEscalationRecord,
  ComputerUseObservationRecord,
  ComputerUseOperationKind,
  ComputerUseOperationRecord,
  ComputerUseRouteEvidence,
  ComputerUseSessionRecord,
  ComputerUseSessionStatus,
} from "../domain/computer-use";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ComputerUseSessionInsertInput {
  readonly sessionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sessionKey: string;
  readonly requestFingerprint: string;
  readonly taskKind: string;
  readonly initialMode: string;
  readonly routeEvidence: ComputerUseRouteEvidence;
  readonly admission: ComputerUseSessionRecord["admission"];
  readonly modeContext: ComputerUseSessionRecord["modeContext"];
  readonly denialClass: string | null;
  readonly denialReason: string | null;
  readonly createdAt: string;
}

export type ComputerUseSessionInsertOutcome =
  | { readonly status: "inserted"; readonly record: ComputerUseSessionRecord }
  | {
      readonly status: "existing";
      readonly record: ComputerUseSessionRecord;
      /** Set when the existing row's fingerprint differs (key reuse). */
      readonly fingerprintMismatch: boolean;
    };

export interface ComputerUseSessionStatusMutation {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly expectedStatus: ComputerUseSessionStatus;
  readonly targetStatus: ComputerUseSessionStatus;
  readonly terminalCause: string | null;
  readonly updatedAt: string;
}

export type ComputerUseSessionMutationOutcome =
  | { readonly status: "moved"; readonly record: ComputerUseSessionRecord }
  | {
      readonly status: "converged";
      readonly record: ComputerUseSessionRecord;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly record: ComputerUseSessionRecord;
    };

export interface ComputerUseSessionPatch {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly environmentRef: string | null;
  readonly environmentOpenedMode: string | null;
  readonly currentMode?: string;
  readonly currentCapabilityId?: string;
  readonly currentEnvelope?: ComputerUseSessionRecord["modeContext"];
  readonly escalationCount?: number;
  readonly usageMicroUsd?: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Escalations (append-only)
// ---------------------------------------------------------------------------

export interface ComputerUseEscalationInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly fromMode: string;
  readonly toMode: string;
  readonly reasonCode: string;
  readonly reasonDetail: string;
  readonly insufficiencyDigest: string;
  readonly capabilityId: string;
  readonly admittedAt: string;
  readonly ledgerSequence: number | null;
}

export type ComputerUseEscalationInsertOutcome =
  | { readonly status: "inserted"; readonly record: ComputerUseEscalationRecord }
  | { readonly status: "existing"; readonly record: ComputerUseEscalationRecord };

// ---------------------------------------------------------------------------
// Actions (the keyed journal)
// ---------------------------------------------------------------------------

export interface ComputerUseActionInsertInput {
  readonly actionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly actionKey: string;
  readonly sequence: number;
  readonly mode: string;
  readonly actionType: string;
  readonly target: string;
  readonly sideEffect: string;
  readonly capabilityId: string;
  readonly inputDigest: string;
  readonly requestedAt: string;
}

export type ComputerUseActionInsertOutcome =
  | { readonly status: "claimed"; readonly record: ComputerUseActionRecord }
  | {
      readonly status: "existing";
      readonly record: ComputerUseActionRecord;
      readonly fingerprintMismatch: boolean;
    };

export interface ComputerUseActionFinalizeInput {
  readonly applicationId: string;
  readonly actionId: string;
  readonly status: "succeeded" | "failed" | "denied";
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  readonly resultDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly environmentRef: string | null;
  readonly sandboxExecutionId: string | null;
  readonly observationSequences: readonly number[];
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly ledgerResultSequence: number | null;
}

// ---------------------------------------------------------------------------
// Observations (append-only, sequence-gapless, digest-protected)
// ---------------------------------------------------------------------------

export interface ComputerUseObservationInsertInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly observationType: string;
  readonly mode: string;
  readonly contentDigest: string;
  readonly retention: string;
  readonly redaction: string;
  readonly content: string | null;
  readonly artifactRef: string | null;
  readonly capabilityId: string;
  readonly actionId: string | null;
  readonly observedAt: string;
  readonly ledgerSequence: number | null;
}

export type ComputerUseObservationInsertOutcome =
  | { readonly status: "inserted"; readonly record: ComputerUseObservationRecord }
  | {
      readonly status: "converged";
      readonly record: ComputerUseObservationRecord;
    }
  | { readonly status: "conflict"; readonly reason: string };

// ---------------------------------------------------------------------------
// The durable, recoverable operation state (the WORK-024 standard)
// ---------------------------------------------------------------------------

export interface ComputerUseOperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Provenance reference only (FK-less by design): may precede the session row. */
  readonly sessionId: string | null;
  readonly executionId: string;
  readonly operationKind: ComputerUseOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

export type ComputerUseOperationBeginOutcome =
  | { readonly status: "begun"; readonly record: ComputerUseOperationRecord }
  | { readonly status: "existing"; readonly record: ComputerUseOperationRecord };

export interface ComputerUseStore {
  // -- sessions -------------------------------------------------------------
  insertSession(input: ComputerUseSessionInsertInput): Promise<ComputerUseSessionInsertOutcome>;
  findSession(applicationId: string, sessionId: string): Promise<ComputerUseSessionRecord | null>;
  findSessionByKey(applicationId: string, sessionKey: string): Promise<ComputerUseSessionRecord | null>;
  patchSession(input: ComputerUseSessionPatch): Promise<ComputerUseSessionRecord>;
  applyGuardedSessionMutation(
    input: ComputerUseSessionStatusMutation,
  ): Promise<ComputerUseSessionMutationOutcome>;
  /** The sessions of one execution (the trajectory's session axis). */
  listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ComputerUseSessionRecord[]>;

  // -- escalations ----------------------------------------------------------
  insertEscalation(input: ComputerUseEscalationInsertInput): Promise<ComputerUseEscalationInsertOutcome>;
  listEscalations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseEscalationRecord[]>;

  // -- actions --------------------------------------------------------------
  insertAction(input: ComputerUseActionInsertInput): Promise<ComputerUseActionInsertOutcome>;
  finalizeAction(input: ComputerUseActionFinalizeInput): Promise<ComputerUseActionRecord>;
  findActionByKey(
    applicationId: string,
    sessionId: string,
    actionKey: string,
  ): Promise<ComputerUseActionRecord | null>;
  listActions(applicationId: string, sessionId: string): Promise<readonly ComputerUseActionRecord[]>;

  // -- observations ---------------------------------------------------------
  insertObservation(
    input: ComputerUseObservationInsertInput,
  ): Promise<ComputerUseObservationInsertOutcome>;
  listObservations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseObservationRecord[]>;

  // -- the durable operation state -------------------------------------------
  beginComputerUseOperation(
    input: ComputerUseOperationBeginInput,
  ): Promise<ComputerUseOperationBeginOutcome>;
  /** Stage checkpoint (PENDING rows only; race-tolerant: terminal rows converge). */
  recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<ComputerUseOperationRecord>;
  completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<ComputerUseOperationRecord>;
  failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    updatedAt: string,
  ): Promise<ComputerUseOperationRecord>;
  findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<ComputerUseOperationRecord | null>;
}
