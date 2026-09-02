/**
 * Governed edge execution service (edge integration application; WORK-029,
 * EDGE-001/002/003).
 *
 * THE admission chain + governance boundary for edge, hard-latency and
 * physical/embodied substrates. Zeck is the governance/orchestration plane
 * here — NEVER the safety-critical control loop:
 *
 * ```text
 * device registration / revocation / health
 *   → pure validation
 *   → idempotent replay / crash recovery       (device key / operation key)
 *   → durable operation claim                  (the WORK-024 standard)
 *   → POLICY admission                         (REQUIRED seam — REAL engine)
 *   → durable row (tenant-scoped, revocable)
 *
 * envelope admission (the safety-critical pre-authorization)
 *   → pure validation
 *   → idempotent replay / crash recovery       (envelope key)
 *   → execution binding + device binding       (tenant-guarded reads)
 *   → CAPABILITY admission                     (device atoms — REAL registry)
 *   → HUMAN approval re-validation             (full binding chain)
 *   → durable operation claim
 *   → POLICY admission                         (REQUIRED seam)
 *   → supersede discipline (one active envelope; the OLD row is
 *     content-IMMUTABLE and only ever superseded by THIS new admission)
 *   → durable envelope row + ledger evidence
 *   → envelope PROJECTION to the local controller (the keyed external
 *     effect — the device's authority for disconnected continuation)
 *
 * command submission (the governed physical side effect)
 *   → pure validation
 *   → idempotent replay / crash recovery       (command key)
 *   → execution + device + envelope binding    (tenant-guarded reads)
 *   → conflicted-device gate                   (violations stop the stream)
 *   → durable operation claim
 *   → POLICY admission → CAPABILITY admission → HUMAN approval binding →
 *     STALENESS evaluation → ENVELOPE COVERAGE → BUDGET reservation
 *     (every refusal is a DURABLE denied row + failed operation +
 *     `tool-denied` ledger event + typed throw — BEFORE any external
 *     dispatch; the controller's actuator journal is the zero-side-effect
 *     witness)
 *   → durable command row (gapless per-device sequence INCLUDING denied
 *     requests) + ledger intent
 *   → ONE-SHOT dispatch to the external controller (keyed external
 *     effect; the local controller re-checks envelope coverage, the
 *     staleness window and the sequence discipline on the actuator path)
 *   → durable outcome (dispatched | failed) + ledger evidence
 *
 * sensor observation / reconciliation
 *   → the same claim-then-effect discipline; reconciliation is the
 *     deterministic, conflict-safe reconnect handshake: commanded
 *     actuations settle EXACTLY ONCE (key, digest, sequence), autonomous
 *     actuations confirm within the pre-authorized envelope bounds, and
 *     anything outside the authorization is a durable VIOLATION that
 *     fails the reconciliation closed (no further authoritative commands
 *     are dispatched to a conflicted device).
 * ```
 *
 * SECURITY ORDERING (AC-4/AC-5): every authority refusal (policy,
 * capability, budget, approval binding, envelope coverage, staleness)
 * occurs BEFORE the external dispatch. A crash between the durable claim
 * and the effect leaves the honest PENDING row; the retry resumes under
 * the SAME stable key and every external effect converges EXACTLY ONCE
 * (the C/P crash proofs).
 *
 * ARCHITECTURAL DISCRIMINATION (AC-2): this service performs governance
 * request/response work ONLY — one dispatch is ONE external submission,
 * never a loop. The hard-real-time control loop lives on the local
 * substrate behind the controller adapter (the port has no tick/schedule
 * surface; the projected envelope is the device's disconnected authority).
 */

import type { BudgetAuthority } from "../../../modules/budgets/public";
import { PlatformError } from "../../../shared/errors";
import type {
  EdgeActuationEventRecord,
  EdgeApprovalDecisionInput,
  EdgeApprovalRecord,
  EdgeApprovalRequestInput,
  EdgeCommandRecord,
  EdgeCommandRequest,
  EdgeCommandStatus,
  EdgeDeviceRecord,
  EdgeDeviceRegistrationRequest,
  EdgeEnvelopeAdmissionRequest,
  EdgeEnvelopeRecord,
  EdgeHealthReport,
  EdgePolicyEvidence,
  EdgeReconciliationReport,
  EdgeReportedActuation,
  EdgeSensorObservationInput,
  EdgeSensorObservationRecord,
} from "../domain/edge";
import {
  canonicalEdgeJson,
  EDGE_COMMAND_EFFECT_CLASS_BY_KIND,
  EDGE_TOOL_FACTS,
  edgeApprovalAuthorizes,
  edgeApprovalDecideOperationKey,
  edgeApprovalRequestOperationKey,
  edgeBudgetOperationId,
  edgeBudgetReleaseKey,
  edgeBudgetReserveKey,
  edgeBudgetSettleKey,
  edgeChannelAtom,
  edgeCommandDispatchExternalKey,
  edgeCommandFingerprint,
  edgeCommandFreshness,
  edgeCommandSubmitOperationKey,
  edgeDeviceFingerprint,
  edgeDeviceRegisterOperationKey,
  edgeDeviceRevokeOperationKey,
  edgeEnvelopeAdmitOperationKey,
  edgeEnvelopeCoversCommand,
  edgeEnvelopeFingerprint,
  edgeEnvelopeProjectExternalKey,
  edgeEnvelopeRevokeOperationKey,
  edgeLedgerEventKey,
  edgeReconcileOperationKey,
  edgeReconciliationReportDigest,
  edgeSensorIngestOperationKey,
  edgeSensorObservationFingerprint,
  validateEdgeApprovalDecision,
  validateEdgeApprovalRequest,
  validateEdgeCommandRequest,
  validateEdgeDeviceRegistration,
  validateEdgeEnvelopeRequest,
  validateEdgeHealthReport,
  validateEdgeSensorObservation,
} from "../domain/edge";
import type {
  EdgeCapabilityGate,
  EdgeCapabilityGateDecision,
  EdgePolicyAdmission,
} from "../ports/edge-admission";
import type { EdgeControllerAdapter } from "../ports/edge-controller";
import type { EdgeExecutionLedger } from "../ports/edge-ledger";
import type { EdgeStore } from "../ports/edge-store";

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

export interface EdgeServiceDeps {
  /** REQUIRED policy admission seam over the REAL policy engine — no default-allow exists. */
  readonly policy: EdgePolicyAdmission;
  /** REQUIRED capability admission seam over the REAL capabilities registry. */
  readonly capabilities: EdgeCapabilityGate;
  /**
   * Budget authority (WORK-004 surface). OPTIONAL at construction, but a
   * COSTED command (non-zero estimate) fails closed when no authority is
   * wired — costed physical work never executes unbudgeted.
   */
  readonly budgetAuthority?: BudgetAuthority;
  readonly store: EdgeStore;
  /** REQUIRED canonical execution ledger seam (provenance rides it). */
  readonly ledger: EdgeExecutionLedger;
  /** REQUIRED external controller seam (the replaceable local-substrate adapter). */
  readonly controller: EdgeControllerAdapter;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly digest: (input: string) => string;
}

export interface EdgeDeviceReceipt {
  readonly deviceId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly status: EdgeDeviceRecord["status"];
  readonly replayed: boolean;
}

export interface EdgeApprovalReceipt {
  readonly approvalId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly status: EdgeApprovalRecord["status"];
  readonly replayed: boolean;
}

export interface EdgeEnvelopeReceipt {
  readonly envelopeId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly status: EdgeEnvelopeRecord["status"];
  readonly contentDigest: string;
  readonly supersedesEnvelopeId: string | null;
  readonly replayed: boolean;
}

export interface EdgeCommandReceipt {
  readonly commandId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly commandKey: string;
  readonly sequence: number;
  readonly status: EdgeCommandStatus;
  readonly failureClass: string | null;
  readonly dispatchDigest: string | null;
  readonly replayed: boolean;
}

export interface EdgeReconciliationReceipt {
  readonly reconciliationId: string;
  readonly applicationId: string;
  readonly deviceId: string;
  readonly status: "converged" | "conflict";
  readonly replayed: boolean;
  readonly confirmedCount: number;
  readonly autonomousCount: number;
  readonly violationCount: number;
  readonly settledCount: number;
}

export interface EdgeService {
  registerDevice(
    request: EdgeDeviceRegistrationRequest,
    idempotencyKey: string,
  ): Promise<EdgeDeviceReceipt>;
  revokeDevice(
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeDeviceReceipt>;
  reportHealth(
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
      readonly health: EdgeHealthReport;
    },
    idempotencyKey: string,
  ): Promise<EdgeDeviceRecord>;

  requestApproval(
    request: EdgeApprovalRequestInput,
    idempotencyKey: string,
  ): Promise<EdgeApprovalReceipt>;
  decideApproval(
    input: EdgeApprovalDecisionInput,
    idempotencyKey: string,
  ): Promise<EdgeApprovalReceipt>;

  admitEnvelope(
    request: EdgeEnvelopeAdmissionRequest,
    idempotencyKey: string,
  ): Promise<EdgeEnvelopeReceipt>;
  revokeEnvelope(
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly envelopeId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeEnvelopeReceipt>;

  submitCommand(request: EdgeCommandRequest, idempotencyKey: string): Promise<EdgeCommandReceipt>;

  ingestSensorObservation(
    input: EdgeSensorObservationInput,
    idempotencyKey: string,
  ): Promise<EdgeSensorObservationRecord>;

  reconcile(
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeReconciliationReceipt>;

  getDevice(applicationId: string, deviceId: string): Promise<EdgeDeviceRecord | null>;
  listDevices(applicationId: string): Promise<readonly EdgeDeviceRecord[]>;
  getEnvelope(applicationId: string, envelopeId: string): Promise<EdgeEnvelopeRecord | null>;
  getApproval(applicationId: string, approvalId: string): Promise<EdgeApprovalRecord | null>;
  getCommand(applicationId: string, commandId: string): Promise<EdgeCommandRecord | null>;
  listCommandsByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeCommandRecord[]>;
  listCommandsByEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<readonly EdgeCommandRecord[]>;
  listActuationEvents(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeActuationEventRecord[]>;
  listSensorObservations(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeSensorObservationRecord[]>;
}

export function createEdgeService(deps: EdgeServiceDeps): EdgeService {
  const { policy, capabilities, store, ledger, controller } = deps;
  const budgetAuthority = deps.budgetAuthority;
  const iso = () => deps.now().toISOString();

  const requireKey = (idempotencyKey: string, what: string): void => {
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `${what} requires a non-empty printable idempotency key (max 200 chars)`,
      });
    }
  };

  const requireReason = (reason: string, what: string): void => {
    if (reason.length === 0 || reason.length > 500) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `${what} requires a bounded reason (1..500 chars)`,
      });
    }
  };

  // -----------------------------------------------------------------------
  // Ledger events (deterministic payloads; idempotent per stable key)
  // -----------------------------------------------------------------------

  const appendEvent = async (
    applicationId: string,
    executionId: string,
    actorId: string,
    tenantId: string,
    command: "tool-requested" | "tool-result" | "tool-denied",
    cause: string,
    reference: Readonly<Record<string, unknown>>,
    payload: Readonly<Record<string, unknown>>,
    key: string,
  ): Promise<number> => {
    const outcome = await ledger.recordStepEvent(
      {
        applicationId,
        executionId,
        actor: { actorId, tenantId },
        command,
        cause,
        reference,
        payload,
      },
      key,
    );
    return outcome.sequence;
  };

  // -----------------------------------------------------------------------
  // Shared binding reads (fail-closed; tenant scope is never dropped)
  // -----------------------------------------------------------------------

  const boundExecution = async (applicationId: string, executionId: string, tenantId: string) => {
    const execution = await ledger.getExecution(applicationId, executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId },
      });
    }
    if (execution.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no governed edge operation may bind to it`,
        details: { executionId, status: execution.status },
      });
    }
    return execution;
  };

  const boundDevice = async (
    applicationId: string,
    deviceId: string,
    tenantId: string,
  ): Promise<EdgeDeviceRecord> => {
    const device = await store.findDevice(applicationId, deviceId);
    if (device === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "edge device not found in this application (missing or owned by another application)",
        details: { deviceId },
      });
    }
    if (device.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "edge device belongs to a different tenant",
        details: { deviceId },
      });
    }
    if (device.status !== "registered") {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: `edge device is ${device.status}; revoked identities never govern work`,
        details: { deviceId, status: device.status },
      });
    }
    return device;
  };

  const boundApproval = async (
    applicationId: string,
    approvalId: string,
    tenantId: string,
  ): Promise<EdgeApprovalRecord> => {
    const approval = await store.findApproval(applicationId, approvalId);
    if (approval === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message:
          "edge approval not found in this application (missing or owned by another application)",
        details: { approvalId },
      });
    }
    if (approval.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "edge approval belongs to a different tenant",
        details: { approvalId },
      });
    }
    return approval;
  };

  /** The full human-approval binding re-validation (AC-4). */
  const approvalAuthorizesSubject = (
    approval: EdgeApprovalRecord,
    subject: {
      readonly subjectKind: "envelope" | "command";
      readonly subjectFingerprint: string;
      readonly executionId: string;
      readonly deviceId: string;
    },
    now: string,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
    if (!edgeApprovalAuthorizes(approval, now)) {
      return {
        ok: false,
        reason: `the bound approval is ${approval.status}${
          approval.expiresAt === null ? "" : ` (expires ${approval.expiresAt})`
        } — an approval decision is REQUIRED before any governed physical side effect`,
      };
    }
    if (approval.subjectKind !== subject.subjectKind) {
      return {
        ok: false,
        reason: `the approval gates a ${approval.subjectKind}, not a ${subject.subjectKind}`,
      };
    }
    if (approval.subjectFingerprint !== subject.subjectFingerprint) {
      return {
        ok: false,
        reason:
          "the approval is bound to a DIFFERENT subject fingerprint (an approval for one subject never authorizes another)",
      };
    }
    if (approval.executionId !== subject.executionId || approval.deviceId !== subject.deviceId) {
      return {
        ok: false,
        reason: "the approval is bound to a different execution/device pair",
      };
    }
    return { ok: true };
  };

  /**
   * The multi-gate discipline for the executions human-gate lifecycle.
   * An execution may hold SEVERAL live edge approvals at once (an
   * envelope admission AND a commanded physical write, or a re-request
   * after a denial); the executions lifecycle holds a single
   * WAITING_HUMAN state for ALL of them:
   *
   *   - `waitHuman` is applied only when the execution is NOT already
   *     waiting (a sibling gate already holds the state, or a crashed
   *     request already applied this very transition — both replay as a
   *     skip, never as a second illegal WAITING_HUMAN -> WAITING_HUMAN
   *     transition);
   *   - `resume` fires only when the decision being applied closed the
   *     LAST live gate: with any sibling live pending gate still open the
   *     execution STAYS WAITING_HUMAN (a partial resume would bypass a
   *     still-open human approval, which AC-4 forbids).
   */
  const shouldApplyWaitHuman = (execution: {
    readonly status: string;
  }): "apply" | "already-waiting" =>
    execution.status === "WAITING_HUMAN" ? "already-waiting" : "apply";

  const hasLiveSiblingGates = async (
    applicationId: string,
    executionId: string,
    excludeApprovalId: string,
  ): Promise<boolean> => {
    const pending = await store.listPendingApprovalsForExecution(
      applicationId,
      executionId,
      excludeApprovalId,
    );
    const now = iso();
    return pending.some(
      (approval) => approval.expiresAt === null || Date.parse(approval.expiresAt) > Date.parse(now),
    );
  };

  const policyAdmit = async (request: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly executionId: string | null;
    readonly toolFact: string;
    readonly controllerRef: string;
    readonly channels: readonly string[];
  }): Promise<EdgePolicyEvidence | null> => {
    const decision = await policy.admit(request);
    if (!decision.allowed) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `edge operation denied by the effective policy: ${decision.reason}`,
        details: { toolFact: request.toolFact, controllerRef: request.controllerRef },
      });
    }
    return decision.evidence ?? null;
  };

  /**
   * POLICY admission with the durable terminal outcome: a denial FAILS
   * the operation row (never a dangling PENDING) and rethrows typed —
   * every governed operation converges to completed|failed.
   */
  const policyAdmitOrFail = async (
    applicationId: string,
    operationKey: string,
    request: {
      readonly tenantId: string;
      readonly applicationId: string;
      readonly executionId: string | null;
      readonly toolFact: string;
      readonly controllerRef: string;
      readonly channels: readonly string[];
    },
  ): Promise<EdgePolicyEvidence | null> => {
    try {
      return await policyAdmit(request);
    } catch (error) {
      if (error instanceof PlatformError) {
        await failClaim(
          applicationId,
          operationKey,
          `POLICY_DENIED: ${error.message}`.slice(0, 512),
        );
      }
      throw error;
    }
  };

  const capabilityAdmit = async (
    requirementAtoms: readonly string[],
  ): Promise<EdgeCapabilityGateDecision> => {
    const decision = await capabilities.resolve({ requirementAtoms: [...requirementAtoms] });
    if (!decision.satisfied) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `edge capability requirements unmet: ${decision.unmet.join(", ")}`,
        details: { unmet: [...decision.unmet] },
      });
    }
    return decision;
  };

  // -----------------------------------------------------------------------
  // The durable operation discipline (claim → terminal outcome)
  // -----------------------------------------------------------------------

  const completeClaim = async (applicationId: string, operationKey: string): Promise<void> => {
    await store.completeOperation(applicationId, operationKey, iso());
  };

  const failClaim = async (
    applicationId: string,
    operationKey: string,
    reason: string,
  ): Promise<void> => {
    await store.failOperation(applicationId, operationKey, reason.slice(0, 512), iso());
  };

  /** Release one command's wallet hold (idempotent per key; never masks the canonical outcome). */
  const releaseCommandBudget = async (command: EdgeCommandRecord): Promise<void> => {
    if (budgetAuthority === undefined || BigInt(command.estimatedMicroUsd) === 0n) {
      // Only reserved (costed) commands carry a release obligation.
      return;
    }
    try {
      await budgetAuthority.release(
        {
          actorId: command.id,
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          operationId: edgeBudgetOperationId(command.id),
        },
        edgeBudgetReleaseKey(command.id),
      );
    } catch {
      // Release is idempotent per operation id; a failure here must not
      // mask the canonical outcome (reconciliation by key).
    }
  };

  // -----------------------------------------------------------------------
  // registerDevice
  // -----------------------------------------------------------------------

  const registerDevice = async (
    request: EdgeDeviceRegistrationRequest,
    idempotencyKey: string,
  ): Promise<EdgeDeviceReceipt> => {
    const requestCheck = validateEdgeDeviceRegistration(request);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    requireKey(idempotencyKey, "edge device registration");
    const fingerprint = edgeDeviceFingerprint(request);

    const existing = await store.findDeviceByKey(request.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different device registration",
          details: { deviceId: existing.id },
        });
      }
      return {
        deviceId: existing.id,
        applicationId: existing.applicationId,
        tenantId: existing.tenantId,
        status: existing.status,
        replayed: true,
      };
    }

    const operationKey = edgeDeviceRegisterOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      deviceId: null,
      executionId: null,
      operationKind: "device-register",
      operationKey,
      requestFingerprint: fingerprint,
      createdAt: iso(),
    });

    await policyAdmitOrFail(request.applicationId, operationKey, {
      tenantId: request.actor.tenantId,
      applicationId: request.applicationId,
      executionId: null,
      toolFact: EDGE_TOOL_FACTS.deviceRegister,
      controllerRef: request.controllerRef,
      channels: [],
    });

    const inserted = await store.insertDevice({
      deviceId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      deviceKey: idempotencyKey,
      requestFingerprint: fingerprint,
      label: request.label,
      workloadClasses: [...request.workloadClasses],
      capabilityAtoms: [...request.capabilityAtoms],
      controllerRef: request.controllerRef,
      createdAt: iso(),
    });
    if (inserted.status === "existing" && inserted.fingerprintMismatch) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "device key was already used with a different registration",
        details: { deviceId: inserted.record.id },
      });
    }
    await completeClaim(request.applicationId, operationKey);
    return {
      deviceId: inserted.record.id,
      applicationId: inserted.record.applicationId,
      tenantId: inserted.record.tenantId,
      status: inserted.record.status,
      replayed: inserted.status === "existing",
    };
  };

  /**
   * The envelope fail-safe of a revoked device identity: withdraw the
   * still-admitted envelope (fail-safe), invalidate every in-flight
   * authorized command under it (release the wallet holds) and project
   * the withdrawal to the local controller (keyed exactly-once).
   */
  const failSafeEnvelopeOfRevokedDevice = async (
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
      readonly reason: string;
    },
    active: EdgeEnvelopeRecord,
  ): Promise<void> => {
    const envelopeRevoked = await store.applyGuardedEnvelopeRevocation({
      applicationId: input.applicationId,
      envelopeId: active.id,
      expectedStatus: "admitted",
      reason: `device revoked: ${input.reason}`.slice(0, 500),
      revokedAt: iso(),
    });
    if (envelopeRevoked.status === "rejected") {
      return;
    }
    const inFlight = await store.listCommandsByEnvelope(input.applicationId, active.id);
    for (const command of inFlight) {
      if (command.status === "authorized") {
        const invalidated = await store.finalizeCommand({
          applicationId: input.applicationId,
          commandId: command.id,
          status: "invalidated",
          failureClass: "device-revoked",
          failureMessage: `the device identity was revoked before dispatch: ${input.reason}`.slice(
            0,
            512,
          ),
          dispatchDigest: null,
          usageMicroUsd: null,
          ledgerResultSequence: null,
          dispatchedAt: null,
          settledAt: null,
          reconciledAt: null,
        });
        await releaseCommandBudget(invalidated);
      }
    }
    await controller.applyEnvelope(
      {
        applicationId: input.applicationId,
        tenantId: active.tenantId,
        deviceId: active.deviceId,
        envelopeId: active.id,
        status: "revoked",
        contentDigest: active.contentDigest,
        content: active.content,
      },
      edgeEnvelopeProjectExternalKey(active.id, "revoked"),
    );
  };

  // -----------------------------------------------------------------------
  // revokeDevice
  // -----------------------------------------------------------------------

  const revokeDevice = async (
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeDeviceReceipt> => {
    requireReason(input.reason, "edge device revocation");
    requireKey(idempotencyKey, "edge device revocation");
    const found = await store.findDevice(input.applicationId, input.deviceId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "edge device not found in this application (missing or owned by another application)",
        details: { deviceId: input.deviceId },
      });
    }
    if (found.tenantId !== input.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "edge device belongs to a different tenant",
        details: { deviceId: input.deviceId },
      });
    }

    const operationKey = edgeDeviceRevokeOperationKey(idempotencyKey);
    if (found.status === "revoked") {
      // Converged replay (or the crash window between the device
      // revocation and the envelope fail-safe): withdraw any still-active
      // envelope — keyed, idempotent — and complete the operation.
      const active = await store.findActiveEnvelopeForDevice(input.applicationId, found.id);
      if (active !== null) {
        await failSafeEnvelopeOfRevokedDevice(input, active);
      }
      await store.beginEdgeOperation({
        operationId: deps.generateId(),
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        deviceId: found.id,
        executionId: null,
        operationKind: "device-revoke",
        operationKey,
        requestFingerprint: deps.digest(`${found.id}:${input.reason}`),
        createdAt: iso(),
      });
      await completeClaim(input.applicationId, operationKey);
      return {
        deviceId: found.id,
        applicationId: found.applicationId,
        tenantId: found.tenantId,
        status: found.status,
        replayed: true,
      };
    }
    const device = found;

    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: device.id,
      executionId: null,
      operationKind: "device-revoke",
      operationKey,
      requestFingerprint: deps.digest(`${device.id}:${input.reason}`),
      createdAt: iso(),
    });

    await policyAdmitOrFail(input.applicationId, operationKey, {
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: null,
      toolFact: EDGE_TOOL_FACTS.deviceRevoke,
      controllerRef: device.controllerRef,
      channels: [],
    });

    const revoked = await store.applyGuardedDeviceRevocation({
      applicationId: input.applicationId,
      deviceId: device.id,
      expectedStatus: "registered",
      reason: input.reason,
      revokedAt: iso(),
    });
    if (revoked.status === "rejected") {
      await failClaim(input.applicationId, operationKey, revoked.reason);
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge device revocation rejected: ${revoked.reason}`,
        details: { deviceId: device.id },
      });
    }

    // Revocation TIGHTENS: an admitted envelope fails safe with the
    // identity (the device's disconnected authority is withdrawn, the
    // withdrawal is projected to the local controller keyed, and every
    // in-flight authorized command under it is INVALIDATED before it
    // could ever dispatch — its wallet hold released).
    const active = await store.findActiveEnvelopeForDevice(input.applicationId, device.id);
    if (active !== null) {
      await failSafeEnvelopeOfRevokedDevice(input, active);
    }

    await completeClaim(input.applicationId, operationKey);
    return {
      deviceId: revoked.record.id,
      applicationId: revoked.record.applicationId,
      tenantId: revoked.record.tenantId,
      status: revoked.record.status,
      replayed: revoked.status === "converged",
    };
  };

  // -----------------------------------------------------------------------
  // reportHealth
  // -----------------------------------------------------------------------

  const reportHealth = async (
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
      readonly health: EdgeHealthReport;
    },
    idempotencyKey: string,
  ): Promise<EdgeDeviceRecord> => {
    const healthCheck = validateEdgeHealthReport(input.health);
    if (!healthCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: healthCheck.reason });
    }
    requireKey(idempotencyKey, "edge health report");
    const device = await boundDevice(input.applicationId, input.deviceId, input.actor.tenantId);

    const operationKey = `edge-op-health-report:${idempotencyKey}`;
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: device.id,
      executionId: null,
      operationKind: "health-report",
      operationKey,
      requestFingerprint: deps.digest(`${device.id}:${canonicalEdgeJson(input.health)}`),
      createdAt: iso(),
    });

    const record = await store.insertHealthReport({
      id: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: device.tenantId,
      deviceId: device.id,
      health: input.health,
      reportedAt: iso(),
    });
    await completeClaim(input.applicationId, operationKey);
    return record;
  };

  // -----------------------------------------------------------------------
  // requestApproval
  // -----------------------------------------------------------------------

  const requestApproval = async (
    request: EdgeApprovalRequestInput,
    idempotencyKey: string,
  ): Promise<EdgeApprovalReceipt> => {
    const requestCheck = validateEdgeApprovalRequest(request);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    requireKey(idempotencyKey, "edge approval request");

    const existing = await store.findApprovalByKey(request.applicationId, idempotencyKey);
    if (existing !== null) {
      // Crash-window convergence: a process that died between the insert
      // and the wait-human transition converges it here (keyed). The
      // multi-gate discipline: the transition is applied only when the
      // execution is NOT already waiting (this very wait already
      // happened, or a sibling gate holds the state — both replay as a
      // skip; the unbound sequence stays NULL and re-converges stably).
      if (existing.ledgerWaitSequence === null) {
        const executionNow = await ledger.getExecution(
          existing.applicationId,
          existing.executionId,
        );
        if (executionNow !== null && shouldApplyWaitHuman(executionNow) === "apply") {
          const wait = await ledger.waitHuman(
            {
              applicationId: existing.applicationId,
              tenantId: existing.tenantId,
              actorId: request.actor.actorId,
              executionId: existing.executionId,
              reason: `edge ${existing.subjectKind} approval ${existing.id}`,
              reference: { approvalId: existing.id, subjectKind: existing.subjectKind },
            },
            edgeLedgerEventKey(existing.id, "approval-wait-human"),
          );
          await store.bindApprovalLedgerSequences(existing.applicationId, existing.id, {
            waitSequence: wait.sequence,
          });
        }
      }
      return {
        approvalId: existing.id,
        applicationId: existing.applicationId,
        executionId: existing.executionId,
        deviceId: existing.deviceId,
        status: existing.status,
        replayed: true,
      };
    }

    const execution = await boundExecution(
      request.applicationId,
      request.executionId,
      request.actor.tenantId,
    );
    const device = await boundDevice(
      request.applicationId,
      request.deviceId,
      request.actor.tenantId,
    );

    const operationKey = edgeApprovalRequestOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      deviceId: device.id,
      executionId: request.executionId,
      operationKind: "approval-request",
      operationKey,
      requestFingerprint: deps.digest(
        `${request.executionId}:${request.deviceId}:${request.subjectFingerprint}`,
      ),
      createdAt: iso(),
    });

    const inserted = await store.insertApproval({
      approvalId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      deviceId: request.deviceId,
      subjectKind: request.subjectKind,
      subjectFingerprint: request.subjectFingerprint,
      policyBasis: request.policyBasis,
      approvalKey: idempotencyKey,
      requestedAt: iso(),
      expiresAt: request.expiresAt,
    });
    const record = inserted.record;

    // The human gate manifests on the executions lifecycle through the
    // PUBLIC transition surface (wait-human) — the ONLY way this
    // integration touches execution status. Multi-gate discipline: an
    // execution that is ALREADY waiting (a sibling gate, or this very
    // transition applied before a crash) holds the gated state for this
    // approval too — no second WAITING_HUMAN -> WAITING_HUMAN
    // transition is attempted.
    if (shouldApplyWaitHuman(execution) === "apply") {
      const wait = await ledger.waitHuman(
        {
          applicationId: request.applicationId,
          tenantId: request.actor.tenantId,
          actorId: request.actor.actorId,
          executionId: request.executionId,
          reason: `edge ${request.subjectKind} approval ${record.id}`,
          reference: { approvalId: record.id, subjectKind: request.subjectKind },
        },
        edgeLedgerEventKey(record.id, "approval-wait-human"),
      );
      await store.bindApprovalLedgerSequences(request.applicationId, record.id, {
        waitSequence: wait.sequence,
      });
    }

    await appendEvent(
      record.applicationId,
      record.executionId,
      request.actor.actorId,
      record.tenantId,
      "tool-requested",
      "edge-approval",
      { approvalId: record.id, subjectKind: record.subjectKind },
      {
        approvalId: record.id,
        phase: "approval-requested",
        subjectKind: record.subjectKind,
        policyBasis: record.policyBasis,
      },
      edgeLedgerEventKey(record.id, "approval-requested"),
    );

    await completeClaim(request.applicationId, operationKey);
    return {
      approvalId: record.id,
      applicationId: record.applicationId,
      executionId: record.executionId,
      deviceId: record.deviceId,
      status: record.status,
      replayed: inserted.status === "existing",
    };
  };

  // -----------------------------------------------------------------------
  // decideApproval
  // -----------------------------------------------------------------------

  const decideApproval = async (
    input: EdgeApprovalDecisionInput,
    idempotencyKey: string,
  ): Promise<EdgeApprovalReceipt> => {
    const decisionCheck = validateEdgeApprovalDecision(input);
    if (!decisionCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: decisionCheck.reason });
    }
    requireKey(idempotencyKey, "edge approval decision");

    const approval = await boundApproval(
      input.applicationId,
      input.approvalId,
      input.actor.tenantId,
    );
    if (isDecided(approval)) {
      if (approval.decision === input.decision && approval.approverId === input.approverId) {
        // Crash-window convergence: a process that died between the
        // decision and the resume transition converges it here (keyed).
        // Multi-gate discipline: the resume fires only when THIS
        // decision closed the last live gate AND the execution is still
        // waiting (a converged resume, a sibling gate still open, or a
        // terminal execution all replay as a stable skip).
        if (
          approval.ledgerResumeSequence === null &&
          !(await hasLiveSiblingGates(approval.applicationId, approval.executionId, approval.id))
        ) {
          const executionNow = await ledger.getExecution(
            approval.applicationId,
            approval.executionId,
          );
          if (executionNow !== null && executionNow.status === "WAITING_HUMAN") {
            const resume = await ledger.resume(
              {
                applicationId: approval.applicationId,
                tenantId: approval.tenantId,
                actorId: input.actor.actorId,
                executionId: approval.executionId,
                reason: `edge ${approval.subjectKind} approval ${approval.id} ${approval.decision}`,
                reference: { approvalId: approval.id, decision: approval.decision },
              },
              edgeLedgerEventKey(approval.id, "approval-resume"),
            );
            await store.bindApprovalLedgerSequences(approval.applicationId, approval.id, {
              resumeSequence: resume.sequence,
            });
          }
          await appendEvent(
            approval.applicationId,
            approval.executionId,
            input.actor.actorId,
            approval.tenantId,
            "tool-result",
            "edge-approval",
            {
              approvalId: approval.id,
              decision: approval.decision,
              approverId: approval.approverId,
            },
            {
              approvalId: approval.id,
              phase: "approval-decided",
              decision: approval.decision,
              approverId: approval.approverId,
              rationale: "replay-converged (the recorded decision)",
            },
            edgeLedgerEventKey(approval.id, "approval-decided"),
          );
        }
        return {
          approvalId: approval.id,
          applicationId: approval.applicationId,
          executionId: approval.executionId,
          deviceId: approval.deviceId,
          status: approval.status,
          replayed: true,
        };
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the edge approval is already decided (${approval.status}); an approval decision is terminal-immutable`,
        details: { approvalId: approval.id },
      });
    }

    const operationKey = edgeApprovalDecideOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: approval.deviceId,
      executionId: approval.executionId,
      operationKind: "approval-decide",
      operationKey,
      requestFingerprint: deps.digest(`${approval.id}:${input.decision}:${input.approverId}`),
      createdAt: iso(),
    });

    const decided = await store.applyApprovalDecision({
      approvalId: approval.id,
      applicationId: input.applicationId,
      decision: input.decision,
      approverId: input.approverId,
      rationale: input.rationale,
      decidedAt: iso(),
    });

    // Resume the gated execution through the PUBLIC transition surface —
    // but ONLY when this decision closed the LAST live gate on the
    // execution (multi-gate discipline): with a sibling live pending
    // approval still open the execution STAYS WAITING_HUMAN (a partial
    // resume would bypass a still-open human approval, which AC-4
    // forbids); and only when the execution is actually waiting (a
    // converged or terminal execution resumes nothing).
    const siblingGatesOpen = await hasLiveSiblingGates(
      input.applicationId,
      approval.executionId,
      approval.id,
    );
    const executionForResume = await ledger.getExecution(input.applicationId, approval.executionId);
    if (
      !siblingGatesOpen &&
      executionForResume !== null &&
      executionForResume.status === "WAITING_HUMAN"
    ) {
      const resume = await ledger.resume(
        {
          applicationId: input.applicationId,
          tenantId: input.actor.tenantId,
          actorId: input.actor.actorId,
          executionId: approval.executionId,
          reason: `edge ${approval.subjectKind} approval ${approval.id} ${input.decision}`,
          reference: { approvalId: approval.id, decision: input.decision },
        },
        edgeLedgerEventKey(approval.id, "approval-resume"),
      );
      await store.bindApprovalLedgerSequences(input.applicationId, approval.id, {
        resumeSequence: resume.sequence,
      });
    }

    await appendEvent(
      input.applicationId,
      approval.executionId,
      input.actor.actorId,
      input.actor.tenantId,
      "tool-result",
      "edge-approval",
      { approvalId: approval.id, decision: input.decision, approverId: input.approverId },
      {
        approvalId: approval.id,
        phase: "approval-decided",
        decision: input.decision,
        approverId: input.approverId,
        rationale: input.rationale.slice(0, 500),
      },
      edgeLedgerEventKey(approval.id, "approval-decided"),
    );

    await completeClaim(input.applicationId, operationKey);
    return {
      approvalId: decided.id,
      applicationId: decided.applicationId,
      executionId: decided.executionId,
      deviceId: decided.deviceId,
      status: decided.status,
      replayed: false,
    };
  };

  const isDecided = (approval: EdgeApprovalRecord): boolean =>
    approval.status === "approved" || approval.status === "denied" || approval.status === "expired";

  // -----------------------------------------------------------------------
  // admitEnvelope
  // -----------------------------------------------------------------------

  const admitEnvelope = async (
    request: EdgeEnvelopeAdmissionRequest,
    idempotencyKey: string,
  ): Promise<EdgeEnvelopeReceipt> => {
    const requestCheck = validateEdgeEnvelopeRequest(request);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    requireKey(idempotencyKey, "edge envelope admission");
    const fingerprint = edgeEnvelopeFingerprint(request);

    const existing = await store.findEnvelopeByKey(request.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different envelope admission",
          details: { envelopeId: existing.id },
        });
      }
      // Crash-window convergence: a process that died between the insert
      // and the supersede/projection converges them here (keyed).
      await convergeEnvelope(existing);
      return envelopeReceiptOf(existing, true);
    }

    await boundExecution(request.applicationId, request.executionId, request.actor.tenantId);
    const device = await boundDevice(
      request.applicationId,
      request.deviceId,
      request.actor.tenantId,
    );

    // CAPABILITY admission: the device's declared atoms resolve through
    // the REAL registry (evidence, never authority).
    const capabilityDecision = await capabilityAdmit(device.capabilityAtoms);

    // HUMAN approval re-validation over the FULL binding chain.
    const approval = await boundApproval(
      request.applicationId,
      request.approvalId,
      request.actor.tenantId,
    );
    const approvalCheck = approvalAuthorizesSubject(
      approval,
      {
        subjectKind: "envelope",
        subjectFingerprint: fingerprint,
        executionId: request.executionId,
        deviceId: request.deviceId,
      },
      iso(),
    );
    if (!approvalCheck.ok) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: `the safety envelope admission lacks a valid human approval: ${approvalCheck.reason}`,
        details: { approvalId: approval.id },
      });
    }

    const operationKey = edgeEnvelopeAdmitOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      deviceId: device.id,
      executionId: request.executionId,
      operationKind: "envelope-admit",
      operationKey,
      requestFingerprint: fingerprint,
      createdAt: iso(),
    });

    const policyEvidence = await policyAdmitOrFail(request.applicationId, operationKey, {
      tenantId: request.actor.tenantId,
      applicationId: request.applicationId,
      executionId: request.executionId,
      toolFact: EDGE_TOOL_FACTS.envelopeAdmit,
      controllerRef: device.controllerRef,
      channels: request.content.channels,
    });

    // The one-active-envelope discipline: an existing admitted envelope
    // must be superseded EXPLICITLY by this new authorized admission.
    const active = await store.findActiveEnvelopeForDevice(request.applicationId, device.id);
    if (request.supersedesEnvelopeId === null) {
      if (active !== null) {
        await failClaim(
          request.applicationId,
          operationKey,
          "an admitted envelope exists; a new admission must supersede it explicitly",
        );
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message:
            "the device already holds an admitted safety envelope; supersede it explicitly (a new authorized admission)",
          details: { deviceId: device.id, activeEnvelopeId: active.id },
        });
      }
    } else {
      const target = await store.findEnvelope(request.applicationId, request.supersedesEnvelopeId);
      if (target === null || target.deviceId !== device.id || target.status !== "admitted") {
        const reason =
          target === null
            ? "the envelope to supersede does not exist on this device"
            : target.deviceId !== device.id
              ? "the envelope to supersede belongs to a different device"
              : `the envelope to supersede is ${target.status} (only an admitted envelope can be superseded)`;
        await failClaim(request.applicationId, operationKey, reason);
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: reason,
          details: { envelopeId: request.supersedesEnvelopeId },
        });
      }
    }

    const contentDigest = deps.digest(canonicalEdgeJson(request.content));
    const inserted = await store.insertEnvelope({
      envelopeId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      deviceId: device.id,
      envelopeKey: idempotencyKey,
      requestFingerprint: fingerprint,
      contentDigest,
      content: request.content,
      admission: {
        policyEvidence,
        capabilitySatisfaction: capabilityDecision.satisfactions.join(",") || null,
        budgetOperationId: null,
        costCeilingMicroUsd: request.costCeilingMicroUsd,
        approvalId: approval.id,
      },
      supersedesEnvelopeId: request.supersedesEnvelopeId,
      createdAt: iso(),
    });
    if (inserted.status === "existing" && inserted.fingerprintMismatch) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "envelope key was already used with a different admission",
        details: { envelopeId: inserted.record.id },
      });
    }
    const record = inserted.record;

    await convergeEnvelope(record);

    await appendEvent(
      record.applicationId,
      record.executionId,
      request.actor.actorId,
      record.tenantId,
      "tool-requested",
      "edge-envelope",
      {
        envelopeId: record.id,
        deviceId: record.deviceId,
        contentDigest: record.contentDigest,
        channels: record.content.channels,
        disconnectedPolicy: record.content.disconnectedPolicy,
      },
      {
        envelopeId: record.id,
        phase: "envelope-admitted",
        contentDigest: record.contentDigest,
        maxCommands: record.content.maxCommands,
        costCeilingMicroUsd: record.admission.costCeilingMicroUsd,
        supersedesEnvelopeId: record.supersedesEnvelopeId,
      },
      edgeLedgerEventKey(record.id, "envelope-admitted"),
    );

    await completeClaim(request.applicationId, operationKey);
    return envelopeReceiptOf(record, inserted.status === "existing");
  };

  /**
   * Converge the supersede + projection of one admitted envelope (the
   * crash-window discipline: keyed, exactly-once external effects).
   */
  const convergeEnvelope = async (record: EdgeEnvelopeRecord): Promise<void> => {
    if (record.supersedesEnvelopeId !== null) {
      const target = await store.findEnvelope(record.applicationId, record.supersedesEnvelopeId);
      if (target !== null && target.status === "admitted") {
        await store.applyEnvelopeSupersede({
          applicationId: record.applicationId,
          envelopeId: target.id,
          supersededByEnvelopeId: record.id,
          supersededAt: iso(),
        });
        await controller.applyEnvelope(
          {
            applicationId: target.applicationId,
            tenantId: target.tenantId,
            deviceId: target.deviceId,
            envelopeId: target.id,
            status: "superseded",
            contentDigest: target.contentDigest,
            content: target.content,
          },
          edgeEnvelopeProjectExternalKey(target.id, "superseded"),
        );
      }
    }
    if (record.status === "admitted") {
      await controller.applyEnvelope(
        {
          applicationId: record.applicationId,
          tenantId: record.tenantId,
          deviceId: record.deviceId,
          envelopeId: record.id,
          status: "admitted",
          contentDigest: record.contentDigest,
          content: record.content,
        },
        edgeEnvelopeProjectExternalKey(record.id, "admitted"),
      );
    }
  };

  const envelopeReceiptOf = (
    record: EdgeEnvelopeRecord,
    replayed: boolean,
  ): EdgeEnvelopeReceipt => ({
    envelopeId: record.id,
    applicationId: record.applicationId,
    executionId: record.executionId,
    deviceId: record.deviceId,
    status: record.status,
    contentDigest: record.contentDigest,
    supersedesEnvelopeId: record.supersedesEnvelopeId,
    replayed,
  });

  // -----------------------------------------------------------------------
  // revokeEnvelope
  // -----------------------------------------------------------------------

  const revokeEnvelope = async (
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly envelopeId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeEnvelopeReceipt> => {
    requireReason(input.reason, "edge envelope revocation");
    requireKey(idempotencyKey, "edge envelope revocation");

    const envelope = await store.findEnvelope(input.applicationId, input.envelopeId);
    if (envelope === null || envelope.tenantId !== input.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "safety envelope not found in this application (missing or owned by another application)",
        details: { envelopeId: input.envelopeId },
      });
    }
    if (envelope.status !== "admitted") {
      // Terminal envelope: the revocation is converged evidence already.
      return envelopeReceiptOf(envelope, true);
    }
    const device = await store.findDevice(input.applicationId, envelope.deviceId);
    if (device === null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "the envelope's device no longer exists",
        details: { envelopeId: envelope.id },
      });
    }

    const operationKey = edgeEnvelopeRevokeOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: envelope.deviceId,
      executionId: envelope.executionId,
      operationKind: "envelope-revoke",
      operationKey,
      requestFingerprint: deps.digest(`${envelope.id}:${input.reason}`),
      createdAt: iso(),
    });

    await policyAdmitOrFail(input.applicationId, operationKey, {
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: envelope.executionId,
      toolFact: EDGE_TOOL_FACTS.envelopeRevoke,
      controllerRef: device.controllerRef,
      channels: envelope.content.channels,
    });

    const revoked = await store.applyGuardedEnvelopeRevocation({
      applicationId: input.applicationId,
      envelopeId: envelope.id,
      expectedStatus: "admitted",
      reason: input.reason,
      revokedAt: iso(),
    });
    if (revoked.status === "rejected") {
      await failClaim(input.applicationId, operationKey, revoked.reason);
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `envelope revocation rejected: ${revoked.reason}`,
        details: { envelopeId: envelope.id },
      });
    }

    // Fail-safe the in-flight authorized commands: they must NEVER
    // dispatch under a revoked envelope (their holds are released).
    const commands = await store.listCommandsByEnvelope(input.applicationId, envelope.id);
    for (const command of commands) {
      if (command.status === "authorized") {
        const invalidated = await store.finalizeCommand({
          applicationId: input.applicationId,
          commandId: command.id,
          status: "invalidated",
          failureClass: "envelope-revoked",
          failureMessage: `the safety envelope was revoked before dispatch: ${input.reason}`.slice(
            0,
            512,
          ),
          dispatchDigest: null,
          usageMicroUsd: null,
          ledgerResultSequence: null,
          dispatchedAt: null,
          settledAt: null,
          reconciledAt: null,
        });
        await releaseCommandBudget(invalidated);
      }
    }

    await controller.applyEnvelope(
      {
        applicationId: envelope.applicationId,
        tenantId: envelope.tenantId,
        deviceId: envelope.deviceId,
        envelopeId: envelope.id,
        status: "revoked",
        contentDigest: envelope.contentDigest,
        content: envelope.content,
      },
      edgeEnvelopeProjectExternalKey(envelope.id, "revoked"),
    );

    await appendEvent(
      envelope.applicationId,
      envelope.executionId,
      input.actor.actorId,
      envelope.tenantId,
      "tool-result",
      "edge-envelope",
      { envelopeId: envelope.id, deviceId: envelope.deviceId, status: "revoked" },
      {
        envelopeId: envelope.id,
        phase: "envelope-revoked",
        reason: input.reason.slice(0, 500),
      },
      edgeLedgerEventKey(envelope.id, "envelope-revoked"),
    );

    await completeClaim(input.applicationId, operationKey);
    return envelopeReceiptOf(revoked.record, revoked.status === "converged");
  };

  // -----------------------------------------------------------------------
  // submitCommand (the governed physical side effect)
  // -----------------------------------------------------------------------

  const submitCommand = async (
    request: EdgeCommandRequest,
    idempotencyKey: string,
  ): Promise<EdgeCommandReceipt> => {
    const requestCheck = validateEdgeCommandRequest(request);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    requireKey(idempotencyKey, "edge command submission");
    const fingerprint = edgeCommandFingerprint(request);
    const now = iso();
    const payloadDigest = deps.digest(canonicalEdgeJson(request.payload));

    // ----- 1. Idempotent replay / crash-recovery fast path. ---------------
    const existing = await store.findCommandByKey(request.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different command request",
          details: { commandId: existing.id },
        });
      }
      if (existing.status === "denied") {
        throw new PlatformError({
          code: denialCodeOf(existing.denialClass),
          message:
            `edge command was denied (${existing.denialClass}): ${existing.denialReason ?? ""}`.trim(),
          details: { commandId: existing.id, denialClass: existing.denialClass },
        });
      }
      if (existing.status === "authorized") {
        // Crash window between the durable insert and the dispatch: the
        // retry converges the ONE-SHOT dispatch under the SAME key.
        return dispatchCommand(existing, request.actor.actorId);
      }
      return commandReceiptOf(existing, true);
    }

    // ----- 2. Bindings (tenant-guarded, fail-closed). --------------------
    await boundExecution(request.applicationId, request.executionId, request.actor.tenantId);
    const device = await boundDevice(
      request.applicationId,
      request.deviceId,
      request.actor.tenantId,
    );
    const envelope = await store.findEnvelope(request.applicationId, request.envelopeId);
    if (envelope === null || envelope.tenantId !== request.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "safety envelope not found in this application (missing or owned by another application)",
        details: { envelopeId: request.envelopeId },
      });
    }
    if (envelope.deviceId !== device.id) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "the safety envelope belongs to a different device",
        details: { envelopeId: envelope.id, deviceId: device.id },
      });
    }
    const active = await store.findActiveEnvelopeForDevice(request.applicationId, device.id);
    if (active === null || active.id !== envelope.id) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "the command's envelope is not the device's admitted safety envelope (commands dispatch only under the ACTIVE pre-authorization)",
        details: { envelopeId: envelope.id, activeEnvelopeId: active?.id ?? null },
      });
    }

    // ----- 3. The conflicted-device gate (AC-6, fail-closed). ------------
    const conflict = await store.findConflictReconciliation(request.applicationId, device.id);
    const actuationHistory = await store.listActuationEvents(request.applicationId, device.id);
    if (
      conflict !== null ||
      actuationHistory.some((event) => event.actuationClass === "violation")
    ) {
      throw new PlatformError({
        code: "NON_CONVERGENT_EXTERNAL_EFFECT",
        message:
          "the device is CONFLICTED (a reconciliation recorded violations); no further authoritative commands are dispatched to it",
        details: { deviceId: device.id },
      });
    }

    // ----- 4. The durable operation claim (identity first). --------------
    const operationKey = edgeCommandSubmitOperationKey(idempotencyKey);
    const begun = await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      deviceId: device.id,
      executionId: request.executionId,
      operationKind: "command-submit",
      operationKey,
      requestFingerprint: fingerprint,
      createdAt: iso(),
    });
    // The crash-stable command identity: a retry of a PENDING operation
    // reuses the checkpointed command id, so the wallet reservation
    // (keyed by it) converges instead of orphaning (the WORK-027
    // stage-checkpoint discipline).
    const commandId = (begun.record.stage?.commandId as string | undefined) ?? deps.generateId();
    if (begun.record.stage?.commandId === undefined) {
      await store.recordOperationCheckpoint(
        request.applicationId,
        operationKey,
        { commandId },
        iso(),
      );
    }

    // ----- 5. POLICY admission (REQUIRED seam — a denial is a DURABLE
    // denied command row + failed operation + `tool-denied` ledger event
    // BEFORE any external dispatch; zero actuator-path activity). -------
    try {
      await policyAdmit({
        tenantId: request.actor.tenantId,
        applicationId: request.applicationId,
        executionId: request.executionId,
        toolFact: EDGE_TOOL_FACTS.commandSubmit,
        controllerRef: device.controllerRef,
        channels: [request.channel],
      });
    } catch (error) {
      if (error instanceof PlatformError) {
        await denyCommand(
          request,
          device,
          envelope,
          fingerprint,
          idempotencyKey,
          operationKey,
          "policy",
          "POLICY_DENIED",
          `the effective policy denied the command: ${error.message}`,
          null,
          payloadDigest,
          commandId,
        );
      }
      throw error;
    }

    // ----- 6. CAPABILITY admission (the channel atom, REAL registry —
    // same durable denial discipline). ----------------------------------
    try {
      await capabilityAdmit([edgeChannelAtom(request.channel)]);
    } catch (error) {
      if (error instanceof PlatformError) {
        await denyCommand(
          request,
          device,
          envelope,
          fingerprint,
          idempotencyKey,
          operationKey,
          "capability",
          "CAPABILITY_UNAVAILABLE",
          `the edge channel capability is unmet: ${error.message}`,
          null,
          payloadDigest,
          commandId,
        );
      }
      throw error;
    }

    // ----- 7. The human-approval discriminator (AC-4). --------------------
    const effectClass = EDGE_COMMAND_EFFECT_CLASS_BY_KIND[request.commandKind];
    let approvalId: string | null = null;
    if (effectClass === "physical-write") {
      if (request.approvalId === null || request.approvalId === undefined) {
        await denyCommand(
          request,
          device,
          envelope,
          fingerprint,
          idempotencyKey,
          operationKey,
          "approval",
          "AUTHORIZATION_DENIED",
          "a PHYSICAL-WRITE command requires a bound, approved human approval before any physical side effect",
          null,
          payloadDigest,
          commandId,
        );
      }
      const approval = await boundApproval(
        request.applicationId,
        request.approvalId as string,
        request.actor.tenantId,
      );
      const approvalCheck = approvalAuthorizesSubject(
        approval,
        {
          subjectKind: "command",
          subjectFingerprint: fingerprint,
          executionId: request.executionId,
          deviceId: request.deviceId,
        },
        now,
      );
      if (!approvalCheck.ok) {
        await denyCommand(
          request,
          device,
          envelope,
          fingerprint,
          idempotencyKey,
          operationKey,
          "approval",
          "AUTHORIZATION_DENIED",
          `the physical side effect lacks a valid human approval: ${approvalCheck.reason}`,
          approval.id,
          payloadDigest,
          commandId,
        );
      }
      approvalId = approval.id;
    } else if (request.approvalId !== null && request.approvalId !== undefined) {
      approvalId = request.approvalId;
    }

    // ----- 8. STALENESS evaluation (AC-5). --------------------------------
    const freshness = edgeCommandFreshness(request, now);
    if (freshness !== "fresh") {
      await denyCommand(
        request,
        device,
        envelope,
        fingerprint,
        idempotencyKey,
        operationKey,
        "stale",
        "AUTHORIZATION_DENIED",
        freshness === "stale"
          ? "the command is STALE (its window has expired); stale commands never reach the actuator path"
          : "the command window has not opened yet (too early); it cannot be admitted now",
        approvalId,
        payloadDigest,
        commandId,
      );
    }

    // ----- 9. ENVELOPE COVERAGE (pure, fail-closed — AC-2/AC-4). ---------
    const coverage = edgeEnvelopeCoversCommand(envelope, request, now);
    if (!coverage.covered) {
      await denyCommand(
        request,
        device,
        envelope,
        fingerprint,
        idempotencyKey,
        operationKey,
        "envelope",
        "AUTHORIZATION_DENIED",
        `the command is outside the pre-authorized safety envelope: ${coverage.reason}`,
        approvalId,
        payloadDigest,
        commandId,
      );
    }

    // ----- 10. BUDGET admission (the envelope scope + the wallet hold). --
    const envelopeCeilingOk = await withinEnvelopeBudget(envelope, request.estimatedMicroUsd);
    if (!envelopeCeilingOk) {
      await denyCommand(
        request,
        device,
        envelope,
        fingerprint,
        idempotencyKey,
        operationKey,
        "budget",
        "BUDGET_EXCEEDED",
        `the command estimate exceeds the envelope's cost ceiling (${envelope.admission.costCeilingMicroUsd} micro-USD)`,
        approvalId,
        payloadDigest,
        commandId,
      );
    }
    if (BigInt(request.estimatedMicroUsd) > 0n && budgetAuthority === undefined) {
      await denyCommand(
        request,
        device,
        envelope,
        fingerprint,
        idempotencyKey,
        operationKey,
        "budget",
        "BUDGET_EXCEEDED",
        "costed edge commands never execute unbudgeted (no budget authority is wired)",
        approvalId,
        payloadDigest,
        commandId,
      );
    }

    // ----- 11. The wallet reservation (keyed by the crash-stable command
    // identity) then the durable command row (identity + sequence). ----
    if (BigInt(request.estimatedMicroUsd) > 0n && budgetAuthority !== undefined) {
      try {
        await budgetAuthority.reserve(
          {
            actorId: request.actor.actorId,
            applicationId: request.applicationId,
            tenantId: request.actor.tenantId,
            executionId: request.executionId,
            operationId: edgeBudgetOperationId(commandId),
            amountMicroUsd: request.estimatedMicroUsd,
          },
          edgeBudgetReserveKey(commandId),
        );
      } catch (error) {
        if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
          await denyCommand(
            request,
            device,
            envelope,
            fingerprint,
            idempotencyKey,
            operationKey,
            "budget",
            "BUDGET_EXCEEDED",
            `the wallet refused the reservation: ${error.message}`,
            approvalId,
            payloadDigest,
            commandId,
          );
        }
        throw error;
      }
    }
    const inserted = await store.insertCommand({
      commandId,
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      deviceId: device.id,
      envelopeId: envelope.id,
      commandKey: idempotencyKey,
      requestFingerprint: fingerprint,
      sequence: device.lastCommandSequence + 1,
      commandKind: request.commandKind,
      effectClass,
      channel: request.channel,
      magnitude: request.magnitude,
      payloadDigest,
      estimatedMicroUsd: request.estimatedMicroUsd,
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: now,
    });
    if (inserted.status === "existing" && inserted.fingerprintMismatch) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "command key was already used with a different request",
        details: { commandId: inserted.record.id },
      });
    }
    const record = inserted.record;

    const requestedSequence = await appendEvent(
      record.applicationId,
      record.executionId,
      request.actor.actorId,
      record.tenantId,
      "tool-requested",
      "edge-command",
      {
        commandId: record.id,
        deviceId: record.deviceId,
        envelopeId: record.envelopeId,
        commandKind: record.commandKind,
        effectClass: record.effectClass,
        channel: record.channel,
        sequence: record.sequence,
      },
      {
        commandId: record.id,
        phase: "command-requested",
        sequence: record.sequence,
        effectClass: record.effectClass,
        magnitude: record.magnitude,
        estimatedMicroUsd: record.estimatedMicroUsd,
      },
      edgeLedgerEventKey(record.id, "command-requested"),
    );
    await store.bindCommandLedgerSequence({
      applicationId: record.applicationId,
      commandId: record.id,
      phase: "requested",
      sequence: requestedSequence,
    });

    // ----- 12. The ONE-SHOT dispatch (keyed external effect). -------------
    return dispatchCommand(
      (await store.findCommand(request.applicationId, record.id)) ?? record,
      request.actor.actorId,
    );
  };

  /** The envelope-scoped budget bound: accumulated estimates <= the ceiling. */
  const withinEnvelopeBudget = async (
    envelope: EdgeEnvelopeRecord,
    estimateMicroUsd: string,
  ): Promise<boolean> => {
    const ceiling = envelope.admission.costCeilingMicroUsd;
    if (ceiling === "0") {
      return BigInt(estimateMicroUsd) === 0n;
    }
    const commands = await store.listCommandsByEnvelope(envelope.applicationId, envelope.id);
    let accumulated = 0n;
    for (const command of commands) {
      if (command.status !== "denied" && command.status !== "invalidated") {
        accumulated += BigInt(command.estimatedMicroUsd);
      }
    }
    return accumulated + BigInt(estimateMicroUsd) <= BigInt(ceiling);
  };

  /**
   * Journal-then-fail (the denial discipline): a durable DENIED command
   * row (the actuator-path denial evidence — AC-5), the failed operation,
   * the `tool-denied` ledger event and the typed throw. ZERO actuator-path
   * activity ever happened (the controller journal is the witness).
   */
  const denyCommand = async (
    request: EdgeCommandRequest,
    device: EdgeDeviceRecord,
    envelope: EdgeEnvelopeRecord,
    fingerprint: string,
    idempotencyKey: string,
    operationKey: string,
    denialClass: string,
    code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE" | "AUTHORIZATION_DENIED",
    reason: string,
    approvalId: string | null,
    payloadDigest: string,
    commandId?: string,
  ): Promise<never> => {
    const inserted = await store.insertCommand({
      commandId: commandId ?? deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      deviceId: device.id,
      envelopeId: envelope.id,
      commandKey: idempotencyKey,
      requestFingerprint: fingerprint,
      sequence: device.lastCommandSequence + 1,
      commandKind: request.commandKind,
      effectClass: EDGE_COMMAND_EFFECT_CLASS_BY_KIND[request.commandKind],
      channel: request.channel,
      magnitude: request.magnitude,
      payloadDigest,
      estimatedMicroUsd: request.estimatedMicroUsd,
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass,
      denialReason: reason.slice(0, 500),
      requestedAt: iso(),
    });
    const record = inserted.record;
    if (inserted.status === "claimed") {
      await appendEvent(
        record.applicationId,
        record.executionId,
        request.actor.actorId,
        record.tenantId,
        "tool-denied",
        "edge-command",
        { commandId: record.id, deviceId: record.deviceId, denialClass, code },
        { denied: true, denialClass, code, reason: reason.slice(0, 500) },
        edgeLedgerEventKey(record.id, "command-denied"),
      );
    }
    await failClaim(request.applicationId, operationKey, `${code}: ${reason}`.slice(0, 512));
    throw new PlatformError({
      code,
      message: `edge command denied (${denialClass}): ${reason}`,
      details: { commandId: record.id, denialClass, reason },
    });
  };

  /**
   * The ONE-SHOT dispatch: submit the authorized command to the external
   * controller under its stable key and finalize the durable outcome.
   * Keyed exactly-once: a re-dispatch of the same command converges on the
   * controller's journal and the durable row moves exactly once.
   */
  const dispatchCommand = async (
    record: EdgeCommandRecord,
    actorId: string,
  ): Promise<EdgeCommandReceipt> => {
    const envelope = await store.findEnvelope(record.applicationId, record.envelopeId);
    if (envelope === null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "the command's envelope no longer exists",
        details: { commandId: record.id },
      });
    }
    const ack = await controller.dispatchCommand(
      {
        applicationId: record.applicationId,
        tenantId: record.tenantId,
        executionId: record.executionId,
        deviceId: record.deviceId,
        commandId: record.id,
        commandKey: record.commandKey,
        sequence: record.sequence,
        commandKind: record.commandKind,
        effectClass: record.effectClass,
        channel: record.channel,
        magnitude: record.magnitude,
        payloadDigest: record.payloadDigest,
        notBefore: record.notBefore,
        notAfter: record.notAfter,
        envelope: {
          envelopeId: envelope.id,
          contentDigest: envelope.contentDigest,
          content: envelope.content,
        },
      },
      edgeCommandDispatchExternalKey(record.id),
    );
    if (ack.outcome === "accepted") {
      const finalized = await store.finalizeCommand({
        applicationId: record.applicationId,
        commandId: record.id,
        status: "dispatched",
        failureClass: null,
        failureMessage: null,
        dispatchDigest: ack.actuationDigest,
        usageMicroUsd: record.estimatedMicroUsd,
        ledgerResultSequence: null,
        dispatchedAt: iso(),
        settledAt: null,
        reconciledAt: null,
      });
      const resultSequence = await appendEvent(
        finalized.applicationId,
        finalized.executionId,
        actorId,
        finalized.tenantId,
        "tool-result",
        "edge-command",
        {
          commandId: finalized.id,
          deviceId: finalized.deviceId,
          dispatchDigest: ack.actuationDigest,
        },
        {
          commandId: finalized.id,
          phase: "command-dispatched",
          sequence: finalized.sequence,
          dispatchDigest: ack.actuationDigest,
        },
        edgeLedgerEventKey(finalized.id, "command-dispatched"),
      );
      await store.bindCommandLedgerSequence({
        applicationId: finalized.applicationId,
        commandId: finalized.id,
        phase: "result",
        sequence: resultSequence,
      });
      return commandReceiptOf(finalized, false);
    }
    // The LOCAL controller refused the dispatch (fail-safe: envelope
    // coverage / staleness / sequence discipline / transport). The command
    // NEVER actuated — the durable failure is the evidence and the wallet
    // hold is released (keyed).
    const failed = await store.finalizeCommand({
      applicationId: record.applicationId,
      commandId: record.id,
      status: "failed",
      failureClass: ack.failureClass,
      failureMessage: ack.message.slice(0, 512),
      dispatchDigest: null,
      usageMicroUsd: null,
      ledgerResultSequence: null,
      dispatchedAt: null,
      settledAt: null,
      reconciledAt: null,
    });
    await releaseCommandBudget(failed);
    await appendEvent(
      failed.applicationId,
      failed.executionId,
      actorId,
      failed.tenantId,
      "tool-result",
      "edge-command",
      { commandId: failed.id, deviceId: failed.deviceId, failureClass: ack.failureClass },
      {
        commandId: failed.id,
        phase: "command-refused",
        failureClass: ack.failureClass,
        reason: ack.message.slice(0, 500),
      },
      edgeLedgerEventKey(failed.id, "command-refused"),
    );
    return commandReceiptOf(failed, false);
  };

  const denialCodeOf = (
    denialClass: string | null,
  ): "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE" | "AUTHORIZATION_DENIED" => {
    switch (denialClass) {
      case "policy":
        return "POLICY_DENIED";
      case "budget":
        return "BUDGET_EXCEEDED";
      case "capability":
        return "CAPABILITY_UNAVAILABLE";
      default:
        return "AUTHORIZATION_DENIED";
    }
  };

  const commandReceiptOf = (record: EdgeCommandRecord, replayed: boolean): EdgeCommandReceipt => ({
    commandId: record.id,
    applicationId: record.applicationId,
    executionId: record.executionId,
    deviceId: record.deviceId,
    envelopeId: record.envelopeId,
    commandKey: record.commandKey,
    sequence: record.sequence,
    status: record.status,
    failureClass: record.failureClass,
    dispatchDigest: record.dispatchDigest,
    replayed,
  });

  // -----------------------------------------------------------------------
  // ingestSensorObservation
  // -----------------------------------------------------------------------

  const ingestSensorObservation = async (
    input: EdgeSensorObservationInput,
    idempotencyKey: string,
  ): Promise<EdgeSensorObservationRecord> => {
    const requestCheck = validateEdgeSensorObservation(input);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    requireKey(idempotencyKey, "edge sensor observation");
    const fingerprint = edgeSensorObservationFingerprint(input);
    const contentDigest = deps.digest(input.content ?? "");

    await boundExecution(input.applicationId, input.executionId, input.actor.tenantId);
    const device = await boundDevice(input.applicationId, input.deviceId, input.actor.tenantId);

    const operationKey = edgeSensorIngestOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: device.id,
      executionId: input.executionId,
      operationKind: "sensor-ingest",
      operationKey,
      requestFingerprint: fingerprint,
      createdAt: iso(),
    });

    await policyAdmit({
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: input.executionId,
      toolFact: EDGE_TOOL_FACTS.sensorIngest,
      controllerRef: device.controllerRef,
      channels: [],
    });

    const outcome = await store.insertSensorObservation({
      id: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      executionId: input.executionId,
      deviceId: device.id,
      sequence: 0,
      observationKey: idempotencyKey,
      observationType: input.observationType,
      retention: input.retention,
      contentDigest,
      content: input.content,
      observedAt: input.observedAt,
    });
    if (outcome.status === "conflict") {
      await failClaim(input.applicationId, operationKey, outcome.reason);
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: `sensor observation rejected: ${outcome.reason}`,
      });
    }
    const record = outcome.record;

    const ledgerSequence = await appendEvent(
      record.applicationId,
      record.executionId,
      input.actor.actorId,
      record.tenantId,
      "tool-result",
      "edge-sensor",
      {
        observationId: record.id,
        deviceId: record.deviceId,
        observationType: record.observationType,
      },
      {
        observationId: record.id,
        phase: "sensor-observed",
        sequence: record.sequence,
        observationType: record.observationType,
        retention: record.retention,
        contentDigest: record.contentDigest,
      },
      edgeLedgerEventKey(record.id, "sensor-observed"),
    );
    await store.bindSensorObservationLedgerSequence(
      record.applicationId,
      record.id,
      ledgerSequence,
    );

    await completeClaim(input.applicationId, operationKey);
    return record;
  };

  // -----------------------------------------------------------------------
  // reconcile (the deterministic, conflict-safe reconnect handshake)
  // -----------------------------------------------------------------------

  const reconcile = async (
    input: {
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly deviceId: string;
    },
    idempotencyKey: string,
  ): Promise<EdgeReconciliationReceipt> => {
    requireKey(idempotencyKey, "edge reconciliation");
    const device = await store.findDevice(input.applicationId, input.deviceId);
    if (device === null || device.tenantId !== input.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "edge device not found in this application (missing or owned by another application)",
        details: { deviceId: input.deviceId },
      });
    }

    const operationKey = edgeReconcileOperationKey(idempotencyKey);
    await store.beginEdgeOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      deviceId: device.id,
      executionId: null,
      operationKind: "reconcile",
      operationKey,
      requestFingerprint: deps.digest(`${device.id}:${idempotencyKey}`),
      createdAt: iso(),
    });

    await policyAdmit({
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: null,
      toolFact: EDGE_TOOL_FACTS.reconcile,
      controllerRef: device.controllerRef,
      channels: [],
    });

    // The local controller reports its journal (the reconnect handshake).
    const report = await controller.reconciliationReport(device.id);
    const reportDigest = edgeReconciliationReportDigest(report);

    const existing = await store.findReconciliationByDigest(input.applicationId, reportDigest);
    if (existing !== null) {
      await completeClaim(input.applicationId, operationKey);
      return {
        reconciliationId: existing.id,
        applicationId: existing.applicationId,
        deviceId: existing.deviceId,
        status: existing.status,
        replayed: true,
        confirmedCount: existing.confirmedCount,
        autonomousCount: existing.autonomousCount,
        violationCount: existing.violationCount,
        settledCount: existing.settledCount,
      };
    }

    const outcome = await processReconciliationReport(device, report, input.actor);

    const reconciliation = await store.insertReconciliation({
      id: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: device.tenantId,
      deviceId: device.id,
      reportDigest,
      status: outcome.status,
      confirmedCount: outcome.confirmedCount,
      autonomousCount: outcome.autonomousCount,
      violationCount: outcome.violationCount,
      settledCount: outcome.settledCount,
      reconciledAt: iso(),
    });

    // The summary evidence rides the device's active execution binding
    // when one exists (subordinate provenance; executions owns status).
    const active = await store.findActiveEnvelopeForDevice(input.applicationId, device.id);
    if (active !== null && (outcome.violationCount > 0 || outcome.settledCount > 0)) {
      await appendEvent(
        input.applicationId,
        active.executionId,
        input.actor.actorId,
        device.tenantId,
        "tool-result",
        "edge-reconciliation",
        { reconciliationId: reconciliation.id, deviceId: device.id, status: outcome.status },
        {
          reconciliationId: reconciliation.id,
          phase: "reconciled",
          status: outcome.status,
          confirmedCount: outcome.confirmedCount,
          autonomousCount: outcome.autonomousCount,
          violationCount: outcome.violationCount,
          settledCount: outcome.settledCount,
        },
        edgeLedgerEventKey(reconciliation.id, "reconciled"),
      );
    }

    await completeClaim(input.applicationId, operationKey);
    return {
      reconciliationId: reconciliation.id,
      applicationId: reconciliation.applicationId,
      deviceId: reconciliation.deviceId,
      status: reconciliation.status,
      replayed: false,
      confirmedCount: outcome.confirmedCount,
      autonomousCount: outcome.autonomousCount,
      violationCount: outcome.violationCount,
      settledCount: outcome.settledCount,
    };
  };

  /**
   * The deterministic reconciliation core (AC-6): commanded actuations
   * settle EXACTLY ONCE (key, digest, sequence); autonomous actuations
   * confirm within the pre-authorized envelope bounds; anything else is a
   * durable VIOLATION that fails the reconciliation closed.
   */
  const processReconciliationReport = async (
    device: EdgeDeviceRecord,
    report: EdgeReconciliationReport,
    actor: { readonly actorId: string; readonly tenantId: string },
  ): Promise<{
    readonly status: "converged" | "conflict";
    readonly confirmedCount: number;
    readonly autonomousCount: number;
    readonly violationCount: number;
    readonly settledCount: number;
  }> => {
    let confirmedCount = 0;
    let autonomousCount = 0;
    let violationCount = 0;
    let settledCount = 0;
    let conflict = false;
    let executedMaxSequence = 0;

    // The envelopes that ever governed this device (classification input).
    const governedEnvelopes = await store.listEnvelopesByDevice(device.applicationId, device.id);

    for (const entry of report.executed) {
      if (entry.commandKey !== null) {
        // ---- a COMMANDED actuation --------------------------------
        const command = await store.findCommandByKey(device.applicationId, entry.commandKey);
        if (command === null) {
          violationCount += 1;
          conflict = true;
          await recordViolation(device, entry, null, "unauthorized-command", actor);
          continue;
        }
        if (entry.sequence === null || entry.sequence !== command.sequence) {
          violationCount += 1;
          conflict = true;
          await recordViolation(device, entry, command, "out-of-order", actor);
          continue;
        }
        if (entry.sequence <= executedMaxSequence) {
          // A duplicate execution of an already-executed command (the
          // duplicate-authoritative-command case — AC-6).
          violationCount += 1;
          conflict = true;
          await recordViolation(device, entry, command, "out-of-order", actor);
          continue;
        }
        executedMaxSequence = entry.sequence;
        if (command.dispatchDigest !== null && command.dispatchDigest !== entry.actuationDigest) {
          violationCount += 1;
          conflict = true;
          await recordViolation(device, entry, command, "digest-mismatch", actor);
          continue;
        }
        if (command.status === "settled") {
          // Already reconciled exactly once: converged duplicate report
          // entry (the journal re-report), NOT a new settlement.
          confirmedCount += 1;
          continue;
        }
        if (command.status === "denied" || command.status === "invalidated") {
          // The local substrate executed a command the governance plane
          // refused: an unauthorized execution.
          violationCount += 1;
          conflict = true;
          await recordViolation(device, entry, command, "unauthorized-command", actor);
          continue;
        }
        // Converge the crash window (dispatch happened, the finalize did
        // not): the controller journal is the truth — the command settles
        // EXACTLY ONCE with its actuation provenance row.
        if (command.status === "authorized") {
          const dispatched = await store.finalizeCommand({
            applicationId: command.applicationId,
            commandId: command.id,
            status: "dispatched",
            failureClass: null,
            failureMessage: null,
            dispatchDigest: entry.actuationDigest,
            usageMicroUsd: command.estimatedMicroUsd,
            ledgerResultSequence: null,
            dispatchedAt: entry.occurredAt,
            settledAt: null,
            reconciledAt: null,
          });
          const settled = await store.settleCommand(
            dispatched.applicationId,
            dispatched.id,
            entry.occurredAt,
            iso(),
          );
          await settleCommandBudget(settled);
          settledCount += 1;
          confirmedCount += 1;
          await insertActuationEvidence(device, entry, {
            actuationClass: "commanded",
            commandId: settled.id,
            commandKey: settled.commandKey,
            sequence: settled.sequence,
            violationKind: null,
            executionId: settled.executionId,
          });
          continue;
        }
        // The dispatched command settles EXACTLY ONCE.
        const settled = await store.settleCommand(
          command.applicationId,
          command.id,
          entry.occurredAt,
          iso(),
        );
        await settleCommandBudget(settled);
        settledCount += 1;
        confirmedCount += 1;
        await insertActuationEvidence(device, entry, {
          actuationClass: "commanded",
          commandId: settled.id,
          commandKey: settled.commandKey,
          sequence: settled.sequence,
          violationKind: null,
          executionId: settled.executionId,
        });
        continue;
      }

      // ---- an AUTONOMOUS (command-less) actuation: envelope ----------
      const classification = classifyAutonomousActuation(governedEnvelopes, entry, report.executed);
      if (classification.within) {
        autonomousCount += 1;
        await insertActuationEvidence(device, entry, {
          actuationClass: "envelope-autonomous",
          commandId: null,
          commandKey: null,
          sequence: null,
          violationKind: null,
          executionId: classification.executionId,
        });
      } else {
        violationCount += 1;
        conflict = true;
        await recordViolation(device, entry, null, "out-of-envelope", actor);
      }
    }

    // ---- the locally REFUSED commands (the fail-safe evidence) --------
    for (const refusal of report.refused) {
      const command = await store.findCommandByKey(device.applicationId, refusal.commandKey);
      if (command === null || command.status !== "dispatched") {
        continue; // converged or unknown — no durable move
      }
      const failed = await store.finalizeCommand({
        applicationId: command.applicationId,
        commandId: command.id,
        status: "failed",
        failureClass: `local-refusal:${refusal.reason}`.slice(0, 200),
        failureMessage: `the local controller refused the command: ${refusal.reason}`.slice(0, 512),
        dispatchDigest: null,
        usageMicroUsd: null,
        ledgerResultSequence: null,
        dispatchedAt: command.dispatchedAt,
        settledAt: null,
        reconciledAt: null,
      });
      await releaseCommandBudget(failed);
      confirmedCount += 1;
    }

    return {
      status: conflict ? "conflict" : "converged",
      confirmedCount,
      autonomousCount,
      violationCount,
      settledCount,
    };
  };

  /**
   * Classify one autonomous actuation against the device's envelopes: it
   * is WITHIN the pre-authorization only if some envelope that governed
   * the device at the time covers it (channel, magnitude, window, rate,
   * and the disconnected-continuation policy).
   */
  const classifyAutonomousActuation = (
    envelopes: readonly EdgeEnvelopeRecord[],
    entry: EdgeReportedActuation,
    journal: readonly EdgeReportedActuation[],
  ): { readonly within: boolean; readonly executionId: string | null } => {
    for (const envelope of envelopes) {
      if (envelope.content.disconnectedPolicy !== "continue-within-envelope") {
        continue;
      }
      const authorityEnd = envelope.supersededAt ?? envelope.revokedAt ?? envelope.content.notAfter;
      const occurredAt = Date.parse(entry.occurredAt);
      if (
        Number.isNaN(occurredAt) ||
        occurredAt < Date.parse(envelope.content.notBefore) ||
        occurredAt >= Date.parse(envelope.content.notAfter) ||
        occurredAt >= Date.parse(authorityEnd)
      ) {
        continue;
      }
      if (!envelope.content.channels.includes(entry.channel)) {
        continue;
      }
      const bounds = envelope.content.magnitudeBounds[entry.channel];
      if (bounds === undefined || entry.magnitude < bounds[0] || entry.magnitude > bounds[1]) {
        continue;
      }
      // The per-channel rate bound (actuations per trailing minute in
      // the reported journal — the deterministic, report-local check).
      const rate = envelope.content.rateBoundsPerMinute[entry.channel];
      if (rate !== undefined) {
        const minuteStart = occurredAt - 60_000;
        const sameChannel = journal.filter(
          (other) =>
            other.channel === entry.channel &&
            Date.parse(other.occurredAt) >= minuteStart &&
            Date.parse(other.occurredAt) <= occurredAt,
        );
        if (sameChannel.length > rate) {
          continue;
        }
      }
      return { within: true, executionId: envelope.executionId };
    }
    return { within: false, executionId: null };
  };

  const recordViolation = async (
    device: EdgeDeviceRecord,
    entry: EdgeReportedActuation,
    command: EdgeCommandRecord | null,
    violationKind: string,
    actor: { readonly actorId: string; readonly tenantId: string },
  ): Promise<void> => {
    await insertActuationEvidence(device, entry, {
      actuationClass: "violation",
      commandId: command?.id ?? null,
      commandKey: command?.commandKey ?? entry.commandKey,
      sequence: entry.sequence,
      violationKind,
      executionId: command?.executionId ?? null,
    });
    if (command !== null && command.status === "dispatched") {
      // Only a dispatched row may conflict; terminal rows (denied /
      // settled / invalidated / conflicted) are immutable — the violation
      // evidence is the append-only actuation event + the conflict
      // reconciliation, never a row mutation.
      await store.conflictCommand(command.applicationId, command.id, iso());
      await releaseCommandBudget(command);
    }
    // The violation evidence rides the bound execution when one exists.
    const executionId = command?.executionId ?? null;
    if (executionId !== null) {
      await appendEvent(
        device.applicationId,
        executionId,
        actor.actorId,
        device.tenantId,
        "tool-result",
        "edge-reconciliation",
        { deviceId: device.id, violationKind, commandId: command?.id ?? null },
        {
          deviceId: device.id,
          phase: "violation-recorded",
          violationKind,
          commandId: command?.id ?? null,
          actuationDigest: entry.actuationDigest,
        },
        edgeLedgerEventKey(`${device.id}:${entry.actuationDigest}`, "violation"),
      );
    }
  };

  const insertActuationEvidence = async (
    device: EdgeDeviceRecord,
    entry: EdgeReportedActuation,
    classification: {
      readonly actuationClass: string;
      readonly commandId: string | null;
      readonly commandKey: string | null;
      readonly sequence: number | null;
      readonly violationKind: string | null;
      readonly executionId: string | null;
    },
  ): Promise<void> => {
    await store.insertActuationEvent({
      id: deps.generateId(),
      applicationId: device.applicationId,
      tenantId: device.tenantId,
      executionId: classification.executionId,
      deviceId: device.id,
      commandId: classification.commandId,
      commandKey: classification.commandKey,
      sequence: classification.sequence,
      actuationClass: classification.actuationClass,
      violationKind: classification.violationKind,
      channel: entry.channel,
      magnitude: entry.magnitude,
      actuationDigest: entry.actuationDigest,
      occurredAt: entry.occurredAt,
      reconciledAt: iso(),
      reconciliationId: null,
    });
  };

  /** Settle one settled command's wallet hold EXACTLY ONCE (keyed). */
  const settleCommandBudget = async (command: EdgeCommandRecord): Promise<void> => {
    if (budgetAuthority === undefined || command.usageMicroUsd === null) {
      return;
    }
    if (command.usageMicroUsd === "0") {
      return;
    }
    try {
      await budgetAuthority.settle(
        {
          actorId: command.id,
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          operationId: edgeBudgetOperationId(command.id),
          actualAmountMicroUsd: command.usageMicroUsd,
        },
        edgeBudgetSettleKey(command.id),
      );
    } catch {
      // Settle is idempotent per key; a failure here must not mask the
      // canonical settlement (reconciliation by key).
    }
  };

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  return {
    registerDevice,
    revokeDevice,
    reportHealth,
    requestApproval,
    decideApproval,
    admitEnvelope,
    revokeEnvelope,
    submitCommand,
    ingestSensorObservation,
    reconcile,
    getDevice: (applicationId, deviceId) => store.findDevice(applicationId, deviceId),
    listDevices: (applicationId) => store.listDevices(applicationId),
    getEnvelope: (applicationId, envelopeId) => store.findEnvelope(applicationId, envelopeId),
    getApproval: (applicationId, approvalId) => store.findApproval(applicationId, approvalId),
    getCommand: (applicationId, commandId) => store.findCommand(applicationId, commandId),
    listCommandsByDevice: (applicationId, deviceId) =>
      store.listCommandsByDevice(applicationId, deviceId),
    listCommandsByEnvelope: (applicationId, envelopeId) =>
      store.listCommandsByEnvelope(applicationId, envelopeId),
    listActuationEvents: (applicationId, deviceId) =>
      store.listActuationEvents(applicationId, deviceId),
    listSensorObservations: (applicationId, deviceId) =>
      store.listSensorObservations(applicationId, deviceId),
  };
}
