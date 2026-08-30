/**
 * Execution service (executions module application; WORK-006, API-003).
 *
 * THE single write path of the execution state machine
 * (`IMPLEMENTATION.md` §5: "/executions alone owns the execution state
 * machine. No other module may write execution status directly."):
 *
 *   - `createExecution` is the only birth path: it validates the
 *     provider-selection-free input, asserts application/environment tenant
 *     scope, and commits the CREATED row + the sequence-1 creation envelope
 *     in ONE transaction with the idempotency record;
 *   - `transition` is the only status mutation: legality is re-derived from
 *     the row locked FOR UPDATE (never from a pre-lock read — the WORK-002
 *     discipline), authority seams are consulted BEFORE any write (policy
 *     admission on `authorize` via the required `ExecutionAuthorizationPort`
 *     seam — implemented by the WORK-007 policy engine, which produces the
 *     durable admission evidence recorded on the authorize envelope and,
 *     on denial, the `execution.policy-denied` ledger record + typed
 *     `POLICY_DENIED`; budget reservation on `start` via the
 *     optional `BudgetAuthority` seam exported by WORK-004 — accounting is
 *     never reimplemented here), and the envelope + row update commit
 *     atomically with the idempotency record (crash-atomicity).
 *
 * Idempotency (API-003): every mutating request carries a caller key;
 * arbitration mirrors the auth/applications/connections/budgets ledgers —
 * same (applicationId, operationName, idempotencyKey, requestFingerprint)
 * replays the SAME durable outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge on one
 * durable identity via PostgreSQL uniqueness/transactional arbitration.
 * Replays re-read the CURRENT row, so a retry at any non-terminal state
 * returns the current durable outcome — never a second execution, never a
 * duplicated event, never an illegal rewind. Terminal states are final:
 * no command is legal from them (and migration 0004 makes the rows
 * physically immutable).
 *
 * Completion binding: `pass` requires at least one PASS verification
 * result, inserts the durable verification rows, and binds their ids on
 * the COMPLETED row — physically CHECK/trigger-enforced on top of this
 * service guard (no provider-success or planner-success shortcut).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { BudgetAuthority } from "../../budgets/public";
import type { EventEnvelope } from "../domain/event";
import {
  eventTypeFor,
  PLANNING_DECISION_EVENT_TYPE,
  POLICY_DENIED_EVENT_TYPE,
} from "../domain/event";
import type {
  ExecutionActor,
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionRecord,
} from "../domain/execution";
import { CREATE_INPUT_KEYS, FORBIDDEN_INPUT_KEYS } from "../domain/execution";
import type { ExecutionCommand } from "../domain/state-machine";
import { EXECUTION_COMMANDS, isExecutionCommand, nextState } from "../domain/state-machine";
import type { VerificationResultInput, VerificationResultRecord } from "../domain/verification";
import type { AdmissionEvidence, ExecutionAuthorizationPort } from "../ports/authorization";
import {
  canonicalFingerprint,
  type ExecutionsIdempotencyPort,
  type ExecutionsTx,
} from "../ports/execution-idempotency";
import type { ExecutionStore } from "../ports/execution-store";

// ---------------------------------------------------------------------------
// Commands and outcomes
// ---------------------------------------------------------------------------

export interface ExecutionCommandScope {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

interface TransitionCommon extends ExecutionCommandScope {
  readonly executionId: string;
  /** Why the transition is happening (provenance cause). */
  readonly reason?: string;
}

export type ExecutionTransitionCommand = TransitionCommon &
  (
    | { readonly command: "authorize" }
    | { readonly command: "plan" | "queue" | "verify" | "replan" | "resume" }
    | {
        readonly command: "wait-tool" | "wait-user" | "wait-human";
      }
    | {
        readonly command: "start";
        /**
         * Dispatch boundary facts: when a billable estimate is present and a
         * budget authority is wired, the reservation happens BEFORE the
         * transition commits (admission precedes dispatch).
         */
        readonly dispatch?: {
          readonly operationId: string;
          readonly amountMicroUsd: string;
          readonly userId?: string;
        };
      }
    | {
        readonly command: "pass";
        /** At least one PASS result is required to complete. */
        readonly verificationResults: readonly VerificationResultInput[];
      }
    | {
        readonly command: "fail" | "cancel" | "expire";
        /** Optional verification observations recorded with the failure. */
        readonly verificationResults?: readonly VerificationResultInput[];
      }
  );

export interface AppliedTransition {
  readonly from: string;
  readonly to: string;
  readonly sequence: number;
}

export interface TransitionOutcome {
  readonly execution: ExecutionRecord;
  readonly applied: AppliedTransition;
  readonly replayed: boolean;
}

export interface ExecutionService {
  createExecution(
    input: ExecutionCreateInput,
    idempotencyKey: string,
    actor: ExecutionActor,
  ): Promise<ExecutionReceipt>;
  transition(
    command: ExecutionTransitionCommand,
    idempotencyKey: string,
  ): Promise<TransitionOutcome>;
  /**
   * DURABLY record a planning decision (WORK-009): the planner's full
   * decision is appended as a `planning.decision-recorded` envelope while
   * the execution is in a planning phase (PLANNING/REPLANNING) — the same
   * single write path (append + identity-preserving sequence advance in
   * ONE transaction with the idempotency record). The planning module
   * owns decision semantics; this ledger owns durability.
   */
  recordPlanningDecision(
    input: RecordPlanningDecisionInput,
    idempotencyKey: string,
  ): Promise<PlanningDecisionRecordOutcome>;

  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
  listEvents(applicationId: string, executionId: string): Promise<readonly EventEnvelope[]>;
  listVerificationResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]>;
}

export interface ExecutionServiceDeps {
  /** Root store for queries; mutations receive the transaction-bound store. */
  readonly store: ExecutionStore;
  readonly idempotency: ExecutionsIdempotencyPort;
  /** REQUIRED policy-admission seam (no default-allow exists; WORK-007 implements). */
  readonly authorization: ExecutionAuthorizationPort;
  /** OPTIONAL budget seam (WORK-004 `BudgetAuthority`): consulted at dispatch. */
  readonly budgetAuthority?: BudgetAuthority;
  readonly generateId: () => string;
  readonly now: () => Date;
}

const CREATE_OPERATION = "executions.create";
const TRANSITION_OPERATION = "executions.transition";
const PLANNING_DECISION_OPERATION = "executions.record-planning-decision";

/**
 * Input of `recordPlanningDecision` (WORK-009): the ledger's STRUCTURAL
 * guard — the planning module owns the rich typed validation of the
 * decision payload itself (`validatePlanningDecision` in planning) and
 * hands over the validated record; this module validates the envelope
 * essentials (identity, plan binding, state, tenant scope) exactly like
 * it validates the create input shape.
 */
export interface RecordPlanningDecisionInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly actorId: string;
  /** The planning decision's own durable identity (planning-derived). */
  readonly decisionId: string;
  /** The selected plan's content-addressed identity (planning-derived). */
  readonly planId: string;
  /** Prior decision this record replaces (replanning), when present. */
  readonly replanOf?: string;
  /** The FULL validated planning decision record (planning-owned shape). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PlanningDecisionRecordOutcome {
  readonly executionId: string;
  readonly decisionId: string;
  /** The ledger sequence the decision envelope landed on. */
  readonly sequence: number;
  /** True when idempotent arbitration replayed the durable decision. */
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  const { store, idempotency, authorization, budgetAuthority, generateId, now } = deps;

  const iso = () => now().toISOString();

  const receiptOf = (row: ExecutionRecord, replayed: boolean): ExecutionReceipt => ({
    executionId: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    environmentId: row.environmentId,
    status: row.status,
    lastEventSequence: row.lastEventSequence,
    verificationRefs: row.verificationRefs,
    createdAt: row.createdAt,
    terminalAt: row.terminalAt,
    replayed,
  });

  // ----- create -----------------------------------------------------------

  const validateCreateInput = (input: ExecutionCreateInput): void => {
    if (!isUuid(input.applicationId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "create input requires a valid applicationId",
      });
    }
    if (input.environmentId !== undefined && !isUuid(input.environmentId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "environmentId must be a valid uuid when present",
      });
    }
    const task = input.task;
    if (
      task === null ||
      typeof task !== "object" ||
      Array.isArray(task) ||
      Object.keys(task).length === 0
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "create input requires a non-empty task object",
      });
    }
    if (
      input.inputArtifactRefs !== undefined &&
      (!Array.isArray(input.inputArtifactRefs) ||
        input.inputArtifactRefs.some((ref) => typeof ref !== "string"))
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "inputArtifactRefs must be an array of artifact reference strings",
      });
    }
    const constraints = input.constraints;
    if (constraints !== undefined) {
      if (constraints === null || typeof constraints !== "object" || Array.isArray(constraints)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "constraints must be an object when present",
        });
      }
      const cost = constraints.maxCostMicroUsd;
      if (cost !== undefined && !/^\d{1,19}$/.test(cost)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "maxCostMicroUsd must be an integer micro-USD string (no floats)",
        });
      }
      const latency = constraints.maxLatencyMs;
      if (latency !== undefined && (!Number.isInteger(latency) || latency < 0)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "maxLatencyMs must be a non-negative integer",
        });
      }
    }
    if (
      input.metadata !== undefined &&
      (input.metadata === null ||
        typeof input.metadata !== "object" ||
        Array.isArray(input.metadata))
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "metadata must be an object when present",
      });
    }
    const inputKeys = Object.keys(input as unknown as Record<string, unknown>);
    for (const key of inputKeys) {
      if (!CREATE_INPUT_KEYS.includes(key)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: FORBIDDEN_INPUT_KEYS.includes(key)
            ? `provider selection is forbidden in the public create contract (rejected field: ${key})`
            : `unknown create input field: ${key}`,
          details: { field: key },
        });
      }
    }
  };

  const createExecution = async (
    input: ExecutionCreateInput,
    idempotencyKey: string,
    actor: ExecutionActor,
  ): Promise<ExecutionReceipt> => {
    validateCreateInput(input);

    const fingerprint = canonicalFingerprint([
      CREATE_OPERATION,
      input.applicationId,
      input.environmentId ?? null,
      input.task,
      input.inputArtifactRefs ?? [],
      input.constraints ?? null,
      input.metadata ?? null,
      input.userId ?? "",
    ]);

    const work = async (tx: ExecutionsTx): Promise<{ executionId: string }> => {
      // Scope assertion BEFORE any durable write.
      const application = await tx.store.findApplication(input.applicationId);
      if (application === null) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "unknown application: executions may only be created for existing applications",
          details: { applicationId: input.applicationId },
        });
      }
      if (application.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "application belongs to a different tenant",
          details: { applicationId: input.applicationId },
        });
      }
      if (input.environmentId !== undefined) {
        const environment = await tx.store.findEnvironment(input.environmentId);
        if (environment === null || environment.applicationId !== input.applicationId) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: "environment does not belong to the target application",
            details: { environmentId: input.environmentId },
          });
        }
      }

      // ExecutionId: UUIDv7 created exactly once for the accepted logical
      // execution — arbitration guarantees exactly one first writer.
      const executionId = generateId();
      const createdAt = iso();
      await tx.store.insertExecution({
        id: executionId,
        applicationId: input.applicationId,
        tenantId: actor.tenantId,
        environmentId: input.environmentId ?? null,
        userId: input.userId ?? "",
        task: { ...input.task },
        inputArtifactRefs: [...(input.inputArtifactRefs ?? [])],
        constraints: input.constraints === undefined ? null : { ...input.constraints },
        metadata: input.metadata === undefined ? {} : { ...input.metadata },
        requestFingerprint: fingerprint,
        now: createdAt,
      });
      await tx.store.appendEvent({
        eventId: generateId(),
        executionId,
        applicationId: input.applicationId,
        tenantId: actor.tenantId,
        sequence: 1,
        type: eventTypeFor("create"),
        command: "create",
        actor,
        cause: undefined,
        reference: {
          inputArtifactRefs: [...(input.inputArtifactRefs ?? [])],
          environmentId: input.environmentId ?? null,
          userId: input.userId ?? "",
        },
        payload: { status: "CREATED", task: input.task },
        occurredAt: createdAt,
      });
      return { executionId };
    };

    const { outcome, replayed } = await idempotency.arbitrate(
      { actorId: actor.actorId, applicationId: input.applicationId },
      CREATE_OPERATION,
      idempotencyKey,
      fingerprint,
      work,
    );

    // Replay re-reads the CURRENT durable row: a retried create at any
    // (non-)terminal state returns the same identity + current status —
    // never a second execution, never a rewind.
    const row = await store.getExecution(input.applicationId, outcome.executionId);
    if (row === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "created execution row disappeared (rows are never deleted)",
      });
    }
    return receiptOf(row, replayed);
  };

  // ----- transition -------------------------------------------------------

  const commandSpecificFingerprintParts = (
    command: ExecutionTransitionCommand,
  ): readonly unknown[] => {
    const extras: Record<string, unknown> = {};
    if ("dispatch" in command && command.dispatch !== undefined) {
      extras.dispatch = command.dispatch;
    }
    if ("verificationResults" in command && command.verificationResults !== undefined) {
      extras.verificationResults = command.verificationResults;
    }
    if (command.reason !== undefined) {
      extras.reason = command.reason;
    }
    return ["executions.transition", command.executionId, command.command, extras];
  };

  const transition = async (
    commandInput: ExecutionTransitionCommand,
    idempotencyKey: string,
  ): Promise<TransitionOutcome> => {
    const command = commandInput;
    if (!isExecutionCommand(command.command)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `unknown transition command ${String(command.command)}`,
        details: { command: command.command },
      });
    }
    const fingerprint = canonicalFingerprint(commandSpecificFingerprintParts(command));

    const work = async (
      tx: ExecutionsTx,
    ): Promise<{
      executionId: string;
      from: string;
      to: string;
      sequence: number;
      denied?: { readonly reason: string };
    }> => {
      // 1. Lock and re-derive: legality ALWAYS comes from the locked row.
      const locked = await tx.store.lockExecution(command.applicationId, command.executionId);
      if (locked === null) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message:
            "execution not found in this application (missing or owned by another application)",
          details: { executionId: command.executionId },
        });
      }
      if (locked.tenantId !== command.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "execution belongs to a different tenant",
          details: { executionId: command.executionId },
        });
      }

      const from = locked.status;
      const to = nextState(from, command.command); // throws INVALID_STATE_TRANSITION

      // 2. Authority seams — consulted BEFORE any state write.
      let admissionEvidence: AdmissionEvidence | undefined;
      if (command.command === "authorize") {
        const decision = await authorization.evaluate({
          execution: locked,
          actorId: command.actorId,
        });
        if (!decision.allowed) {
          // POLICY admission denial (WORK-007): the execution cannot pass
          // CREATED, and the denial is DURABLE — journal-then-fail (the
          // WORK-003 dispatch-journal precedent): append the
          // `execution.policy-denied` envelope carrying the denial reason +
          // effective-policy evidence, advance the ledger sequence through
          // the SAME single write path (status write is the identity-
          // preserving CREATED→CREATED sequence advance), then fail with
          // typed `POLICY_DENIED` AFTER the record commits. The idempotency
          // record stores the denial outcome, so a same-key retry replays
          // the same typed denial without a second envelope.
          const denialSequence = locked.lastEventSequence + 1;
          const deniedAt = iso();
          const denialReason = decision.reason ?? "policy admission denied the transition";
          await tx.store.appendEvent({
            eventId: generateId(),
            executionId: command.executionId,
            applicationId: command.applicationId,
            tenantId: locked.tenantId,
            sequence: denialSequence,
            type: POLICY_DENIED_EVENT_TYPE,
            command: "authorize",
            actor: { actorId: command.actorId, tenantId: command.tenantId },
            cause: "policy-denied",
            reference: {
              denied: true,
              reason: denialReason,
              ...(decision.evidence === undefined ? {} : { policy: decision.evidence }),
            },
            payload: { from, to: from, denied: true, reason: denialReason },
            occurredAt: deniedAt,
          });
          await tx.store.updateExecutionForTransition({
            executionId: command.executionId,
            applicationId: command.applicationId,
            nextStatus: from, // stays CREATED — dispatch remains impossible
            nextSequence: denialSequence,
            verificationRefs: [],
            now: deniedAt,
          });
          return {
            executionId: command.executionId,
            from,
            to: from,
            sequence: denialSequence,
            denied: { reason: denialReason },
          };
        }
        admissionEvidence = decision.evidence;
      }
      let reservationId: string | null = null;
      if (command.command === "start" && command.dispatch !== undefined) {
        const dispatch = command.dispatch;
        if (dispatch.operationId === "" || !/^\d{1,19}$/.test(dispatch.amountMicroUsd)) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "dispatch requires a non-empty operationId and an integer micro-USD amount",
          });
        }
        if (budgetAuthority !== undefined) {
          // Admission precedes dispatch: the reservation is placed BEFORE the
          // transition commits. The budgets module owns arbitration/idempotency
          // of the reservation itself (same key retried => same reservation).
          const reserved = await budgetAuthority.reserve(
            {
              actorId: command.actorId,
              applicationId: command.applicationId,
              tenantId: locked.tenantId,
              executionId: command.executionId,
              operationId: dispatch.operationId,
              userId: dispatch.userId ?? locked.userId ?? "",
              amountMicroUsd: dispatch.amountMicroUsd,
            },
            idempotencyKey,
          );
          reservationId = reserved.reservation.id;
        }
      }

      // 3. Verification binding for the completion edge (+ optional records
      //    on fail). A pass without at least one PASS result never writes.
      const verificationRefs: string[] = [];
      if ("verificationResults" in command && command.verificationResults !== undefined) {
        const results = command.verificationResults;
        if (command.command === "pass" && !results.some((r) => r.status === "PASS")) {
          throw new PlatformError({
            code: "VERIFICATION_FAILED",
            message:
              "completion requires at least one PASS verification result (no provider-success or planner-success shortcut)",
            details: { results: results.length },
          });
        }
        for (const result of results) {
          const id = generateId();
          await tx.store.insertVerificationResult({
            id,
            executionId: command.executionId,
            applicationId: command.applicationId,
            tenantId: locked.tenantId,
            criterionId: result.criterionId,
            strategy: result.strategy,
            status: result.status,
            evidence: [...(result.evidence ?? [])],
            recordedBy: result.recordedBy,
          });
          verificationRefs.push(id);
        }
      }
      if (command.command === "pass" && verificationRefs.length === 0) {
        throw new PlatformError({
          code: "VERIFICATION_FAILED",
          message: "the pass command requires verificationResults",
        });
      }

      // 4. Append the envelope, then apply the row transition — one
      //    transaction, exactly one event, sequence = last + 1 (gapless).
      //    The verification BINDING on the row exists iff the execution
      //    COMPLETED (migration 0004 `executions_verification_binding_shape`:
      //    refs on a non-COMPLETED row are unrepresentable): a `fail`
      //    records its verification rows + envelope references, but the
      //    ROW binding stays empty (WORK-009 fix for the latent
      //    fail-with-results constraint violation on real PostgreSQL —
      //    the in-memory fake could not surface it).
      const sequence = locked.lastEventSequence + 1;
      const occurredAt = iso();
      await tx.store.appendEvent({
        eventId: generateId(),
        executionId: command.executionId,
        applicationId: command.applicationId,
        tenantId: locked.tenantId,
        sequence,
        type: eventTypeFor(command.command),
        command: command.command,
        actor: { actorId: command.actorId, tenantId: command.tenantId },
        cause: command.reason ?? undefined,
        reference: {
          ...(admissionEvidence === undefined ? {} : { policy: admissionEvidence }),
          ...(reservationId === null ? {} : { reservationId }),
          ...(verificationRefs.length === 0 ? {} : { verificationResultIds: verificationRefs }),
        },
        payload: { from, to },
        occurredAt,
      });
      const updated = await tx.store.updateExecutionForTransition({
        executionId: command.executionId,
        applicationId: command.applicationId,
        nextStatus: to,
        nextSequence: sequence,
        verificationRefs: to === "COMPLETED" ? verificationRefs : [],
        now: occurredAt,
      });
      return { executionId: updated.id, from, to, sequence };
    };

    const { outcome, replayed } = await idempotency.arbitrate(
      { actorId: command.actorId, applicationId: command.applicationId },
      TRANSITION_OPERATION,
      idempotencyKey,
      fingerprint,
      work,
    );

    // A durably-recorded policy denial surfaces as the typed canonical
    // error AFTER its ledger record committed (journal-then-fail).
    if (outcome.denied !== undefined) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "policy admission denied the authorize transition (durable denial evidence recorded)",
        details: {
          reason: outcome.denied.reason,
          executionId: outcome.executionId,
          sequence: outcome.sequence,
        },
      });
    }

    const row = await store.getExecution(command.applicationId, outcome.executionId);
    if (row === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "transitioned execution row disappeared (rows are never deleted)",
      });
    }
    return { execution: row, applied: outcome, replayed };
  };

  // ----- planning decision (WORK-009) --------------------------------------

  const validatePlanningDecisionInput = (input: RecordPlanningDecisionInput): void => {
    if (!isUuid(input.applicationId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a valid applicationId",
      });
    }
    if (!isUuid(input.executionId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a valid executionId",
      });
    }
    if (typeof input.tenantId !== "string" || input.tenantId.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a non-empty tenantId",
      });
    }
    if (typeof input.actorId !== "string" || input.actorId.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a non-empty actorId",
      });
    }
    if (typeof input.decisionId !== "string" || input.decisionId.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a non-empty decisionId",
      });
    }
    if (typeof input.planId !== "string" || input.planId.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision requires a non-empty planId (the selected plan binding)",
      });
    }
    if (
      input.replanOf !== undefined &&
      (typeof input.replanOf !== "string" || input.replanOf.length === 0)
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planning decision replanOf must be a non-empty string when present",
      });
    }
    if (
      input.payload === null ||
      typeof input.payload !== "object" ||
      Array.isArray(input.payload) ||
      Object.keys(input.payload).length === 0
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "planning decision requires a non-empty payload object (the validated decision record)",
      });
    }
  };

  const recordPlanningDecision = async (
    input: RecordPlanningDecisionInput,
    idempotencyKey: string,
  ): Promise<PlanningDecisionRecordOutcome> => {
    validatePlanningDecisionInput(input);

    const fingerprint = canonicalFingerprint([
      PLANNING_DECISION_OPERATION,
      input.executionId,
      input.applicationId,
      input.decisionId,
      input.planId,
      input.replanOf ?? null,
    ]);

    const work = async (tx: ExecutionsTx): Promise<PlanningDecisionRecordOutcome> => {
      // 1. Lock and re-derive: scope + state legality ALWAYS from the
      //    locked row (the WORK-002 discipline).
      const locked = await tx.store.lockExecution(input.applicationId, input.executionId);
      if (locked === null) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message:
            "execution not found in this application (missing or owned by another application)",
          details: { executionId: input.executionId },
        });
      }
      if (locked.tenantId !== input.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "execution belongs to a different tenant",
          details: { executionId: input.executionId },
        });
      }

      // 2. Planning decisions are legal ONLY while the execution is in a
      //    planning phase — no second state machine, no out-of-phase
      //    journaling, zero writes on violation.
      if (locked.status !== "PLANNING" && locked.status !== "REPLANNING") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message:
            "planning decisions may only be recorded while the execution is PLANNING or REPLANNING",
          details: { executionId: input.executionId, status: locked.status },
        });
      }

      // 3. Append the decision envelope + identity-preserving sequence
      //    advance — ONE transaction, exactly one event, sequence =
      //    last + 1 (gapless; the policy-denied journal precedent).
      const sequence = locked.lastEventSequence + 1;
      const occurredAt = iso();
      await tx.store.appendEvent({
        eventId: generateId(),
        executionId: input.executionId,
        applicationId: input.applicationId,
        tenantId: locked.tenantId,
        sequence,
        type: PLANNING_DECISION_EVENT_TYPE,
        command: "plan",
        actor: { actorId: input.actorId, tenantId: input.tenantId },
        cause: "planning-decision",
        reference: {
          decisionId: input.decisionId,
          planId: input.planId,
          ...(input.replanOf === undefined ? {} : { replanOf: input.replanOf }),
        },
        payload: input.payload,
        occurredAt,
      });
      await tx.store.updateExecutionForTransition({
        executionId: input.executionId,
        applicationId: input.applicationId,
        nextStatus: locked.status, // identity-preserving advance
        nextSequence: sequence,
        verificationRefs: [],
        now: occurredAt,
      });
      return {
        executionId: input.executionId,
        decisionId: input.decisionId,
        sequence,
        replayed: false,
      };
    };

    const { outcome, replayed } = await idempotency.arbitrate(
      { actorId: input.actorId, applicationId: input.applicationId },
      PLANNING_DECISION_OPERATION,
      idempotencyKey,
      fingerprint,
      work,
    );
    return { ...outcome, replayed };
  };

  return {
    createExecution,
    transition,
    recordPlanningDecision,
    async getExecution(applicationId, executionId) {
      return store.getExecution(applicationId, executionId);
    },
    async listEvents(applicationId, executionId) {
      return store.listEvents(applicationId, executionId);
    },
    async listVerificationResults(applicationId, executionId) {
      return store.listVerificationResults(applicationId, executionId);
    },
  };
}

export type { ExecutionCommand };
/** Re-exported for consumers constructing command validation locally. */
export { EXECUTION_COMMANDS as EXECUTION_TRANSITION_COMMANDS };
