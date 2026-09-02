/**
 * Training service (sandbox module application; WORK-030,
 * ACC-001/ACC-002/ACC-003).
 *
 * THE admission chain + execution boundary for every governed training,
 * fine-tuning, large-batch-inference and evaluation workload. The
 * training workload is an execution ENVIRONMENT participant, never a
 * second execution system: identity/tenant resolution and evidence ride
 * the executions module's ledger through the REQUIRED seam (the
 * EXISTING step-event vocabulary); policy, capability and budget
 * decisions happen in THEIR authorities through REQUIRED seams; the
 * frozen dispatch sequence governs:
 *
 * ```text
 * request
 *   → identity/tenant + execution binding       (executions ledger read)
 *   → substrate resolution                      (the neutral capability/
 *                                                resource contract match
 *                                                against substrate CLAIMS
 *                                                in the capabilities
 *                                                registry — ACC-002)
 *   → POLICY admission                          (REQUIRED seam)
 *   → CAPABILITY admission                      (REQUIRED seam — the
 *                                                accelerator-class claim)
 *   → BUDGET/resource admission                 (the REAL budgets
 *                                                authority: reserve the
 *                                                explicit estimate —
 *                                                BEFORE any paid compute
 *                                                allocation)
 *   → durable admission bundle                  (workload row + immutable
 *                                                runtime metadata +
 *                                                sandbox-admitted event)
 *   → [dispatch] runtime resolution             (adapterRef → substrate
 *                                                adapter; unwired fails
 *                                                closed)
 *   → PAID accelerator allocation               (stable allocation key —
 *                                                AFTER the reservation)
 *   → long-running execution                    (checkpoints emitted
 *                                                write-once, content/
 *                                                lineage-addressable)
 *   → durable evidence                          (outcome finalization +
 *                                                budget settle/release +
 *                                                sandbox-completed event)
 * ```
 *
 * CRASH SAFETY (the WORK-024/026/028 standard): every side-effecting
 * operation (submission, allocation, run, checkpoint emission,
 * cancellation, resume, retry, output publication, release) is a
 * DURABLE, RECOVERABLE OPERATION (PENDING -> COMPLETED | FAILED, stable
 * key, monotonic attempts, stage checkpoint). A crash between the
 * allocation claim and the outcome leaves the honest `running` row
 * with a durable allocation; the recovery path (resume) re-drives the
 * operation through the SAME stable keys — exactly one paid allocation
 * and one substrate run per (workload, attempt), checkpoint writes
 * converging on their content identities, budget settled/released
 * exactly once per operation id.
 *
 * VERIFICATION BEFORE RELEASE (ACC-003): compute completion NEVER
 * implies model-release verification. The release dimension of a
 * workload row is null until — and only until — the
 * `verifyAndReleaseWorkload` operation consults the verification
 * authority (through the REQUIRED gate seam) and receives a PASS
 * verdict. A completed-but-unverified workload is a durable,
 * inspectable non-release; a FAILED workload can never release (the
 * operation requires the completed state).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { BudgetAuthority } from "../../budgets/public";
import { validateSandboxTask } from "../domain/sandbox";
import type {
  TrainingCheckpointContents,
  TrainingCheckpointRecord,
  TrainingCreateInput,
  TrainingFailureClass,
  TrainingWorkloadRecord,
  TrainingWorkloadSpec,
} from "../domain/workload";
import {
  isTerminalTrainingStatus,
  TRAINING_KEY_PATTERN,
  trainingCheckpointIdentity,
  trainingMaterialChangeBetween,
  trainingOperationKey,
  trainingRequestFingerprint,
  validateTrainingCheckpointContents,
  validateTrainingWorkloadSpec,
} from "../domain/workload";
import type {
  AcceleratorRuntimeRegistry,
  AcceleratorSubstrateCatalog,
  TrainingRunObservation,
} from "../ports/accelerator-substrate";
import type { SandboxCapabilityResolution } from "../ports/sandbox-capability-gate";
import type { TrainingAdmission } from "../ports/training-admission";
import type { TrainingExecutionLedger, TrainingStepEventCommand } from "../ports/training-ledger";
import type { TrainingStore } from "../ports/training-store";
import type { TrainingVerificationGate } from "../ports/training-verification";

export interface TrainingServiceDeps {
  readonly store: TrainingStore;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly admission: TrainingAdmission;
  /** REQUIRED substrate catalog seam (the capability/resource contract). */
  readonly substrates: AcceleratorSubstrateCatalog;
  /** REQUIRED capability authority seam — no default/skip exists by design. */
  readonly capabilities: SandboxCapabilityResolution;
  /**
   * Budget authority (the REAL budgets authority surface). Training is
   * ALWAYS paid compute (a zero estimate is inadmissible at validation),
   * so this seam is REQUIRED — costed compute never executes unbudgeted.
   */
  readonly budgetAuthority: BudgetAuthority;
  /** REQUIRED canonical execution event path — no no-op implementation exists. */
  readonly ledger: TrainingExecutionLedger;
  /** The accelerator runtime registry (adapterRef -> substrate adapter). */
  readonly runtimes: AcceleratorRuntimeRegistry;
  /** REQUIRED verification gate — the release authority seam (ACC-003). */
  readonly verification: TrainingVerificationGate;
  /** The digest function (checkpoint identity: content/lineage addressable). */
  readonly digest: (input: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** The run lease duration (default 15 minutes). */
  readonly leaseDurationMs?: number;
}

export interface TrainingActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface TrainingService {
  submitWorkload(
    input: TrainingCreateInput & { readonly secretRefs?: readonly string[] },
    idempotencyKey: string,
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  dispatchWorkload(
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  emitCheckpoint(
    input: {
      readonly applicationId: string;
      readonly workloadId: string;
      readonly contents: Omit<
        TrainingCheckpointContents,
        | "executionId"
        | "workloadId"
        | "workloadKey"
        | "substrateId"
        | "resourceClass"
        | "recordedBy"
      >;
    },
    actor: TrainingActor,
  ): Promise<TrainingCheckpointRecord>;
  cancelWorkload(
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  resumeWorkload(
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  retryWorkload(
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  verifyAndReleaseWorkload(
    input: {
      readonly applicationId: string;
      readonly workloadId: string;
      readonly criteria: readonly { readonly criterionId: string; readonly version: number }[];
      readonly evidenceRefs: readonly string[];
    },
    idempotencyKey: string,
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord>;
  getWorkload(applicationId: string, workloadId: string): Promise<TrainingWorkloadRecord | null>;
  getCheckpointByIdentity(
    applicationId: string,
    contentDigest: string,
  ): Promise<TrainingCheckpointRecord | null>;
  listWorkloadsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly TrainingWorkloadRecord[]>;
}

/** Whether an error is the canonical idempotency key-reuse rejection. */
function isIdempotencyReuse(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED";
}

export function createTrainingService(deps: TrainingServiceDeps): TrainingService {
  const {
    store,
    admission,
    substrates,
    capabilities,
    budgetAuthority,
    ledger,
    runtimes,
    verification,
    digest,
  } = deps;
  const iso = () => deps.now().toISOString();
  const leaseDurationMs = deps.leaseDurationMs ?? 15 * 60 * 1000;
  /** The deterministic run-worker identity of one workload. */
  const workerIdOf = (workloadKey: string): string => `training-worker:${workloadKey}`;

  /**
   * Release the run lease ONLY when a lease row exists (a workload
   * cancelled before allocation, or failed before lease acquisition,
   * has no lease — a review-found defect made those paths crash on a
   * lease-less release; the tails now release conditionally).
   */
  const releaseLeaseIfPresent = async (
    applicationId: string,
    workloadId: string,
    cause: string,
  ): Promise<void> => {
    const lease = await store.findTrainingRunLease(applicationId, workloadId);
    if (lease !== null) {
      await store.releaseTrainingRunLease({ applicationId, workloadId, cause, now: iso() });
    }
  };

  /**
   * THE FINALIZATION-TAIL RECONCILIATION (the crash-recovery discipline):
   * complete the allocation operation, release the run lease, release
   * the substrate allocation and settle (completed) or release
   * (failed/cancelled) the budget reservation — every step idempotent
   * per its stable key, so a process that died between the terminal row
   * transition and the tail is reconciled by the NEXT replay of the
   * terminal outcome (a review-found gap: the early returns previously
   * replayed the row WITHOUT re-driving the tail, leaking the paid
   * reservation).
   */
  const reconcileFinalizedTails = async (
    record: TrainingWorkloadRecord,
    mode: "completed" | "failed" | "cancelled",
  ): Promise<void> => {
    const allocationKey = trainingOperationKey(
      "allocate",
      `${record.workloadKey}:attempt:${record.attempts}`,
    );
    // 1. The allocation operation row (pending -> terminal; skipped
    //    when absent — a lease-less pre-allocation path).
    const operation = await store.findTrainingOperation(record.applicationId, allocationKey);
    if (operation !== null && operation.status === "pending") {
      await store.completeTrainingOperation({
        applicationId: record.applicationId,
        operationKey: allocationKey,
        ...(mode === "completed" ? {} : { failureReason: `workload ${mode}` }),
        now: iso(),
      });
    }
    // 2. The run lease (one-way release; only when a live row exists).
    await releaseLeaseIfPresent(
      record.applicationId,
      record.id,
      mode === "completed" ? "run-completed" : mode === "failed" ? "run-failed" : "cancelled",
    );
    // 3. The substrate allocation (keyed, exactly-once release).
    await runtimeOf(record)?.release(allocationKey);
    // 4. The budget tail (settle on completion; release otherwise) —
    //    idempotent per operation id.
    const budgetOperationId = record.budgetOperationId;
    if (budgetOperationId !== null) {
      try {
        if (mode === "completed" && record.status === "completed") {
          await budgetAuthority.settle(
            {
              actorId: record.id,
              applicationId: record.applicationId,
              tenantId: record.tenantId,
              operationId: budgetOperationId,
              actualAmountMicroUsd: record.usageMicroUsd ?? "0",
            },
            `training-settle:${budgetOperationId}`,
          );
        } else {
          await budgetAuthority.release(
            {
              actorId: record.id,
              applicationId: record.applicationId,
              tenantId: record.tenantId,
              operationId: budgetOperationId,
            },
            `training-release:${budgetOperationId}`,
          );
        }
      } catch {
        // Settle/release is idempotent per operationId; a failure here
        // must not erase the durable outcome (replayed on the next
        // terminal replay).
      }
    }
  };

  /** The budget operation id of one workload attempt (stable per attempt). */
  const budgetOperationIdFor = (workloadKey: string, attempt: number): string =>
    attempt === 1
      ? `training-workload:${workloadKey}`
      : `training-workload:${workloadKey}:attempt:${attempt}`;

  /**
   * Append one training step event on the canonical ledger. Payloads are
   * DETERMINISTIC per logical workload (no timing values) so retries
   * replay the SAME envelope instead of colliding on the idempotency key.
   */
  const appendLedgerEvent = async (
    record: TrainingWorkloadRecord,
    command: TrainingStepEventCommand,
    extraPayload: Readonly<Record<string, unknown>>,
    options: { readonly bind?: "admitted" | "completed" } = {},
  ) => {
    const outcome = await ledger.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.executionId,
        actor: {
          // The workload's own durable identity is the provenance actor.
          actorId: record.id,
          tenantId: record.tenantId,
        },
        command,
        cause: "training-workload",
        reference: {
          workloadId: record.id,
          workloadKey: record.workloadKey,
          executionId: record.executionId,
          workloadKind: record.runtimeMetadata.workloadKind,
          ...(record.runtimeMetadata.substrate === null
            ? {}
            : { substrate: record.runtimeMetadata.substrate }),
          ...(record.budgetOperationId === null
            ? {}
            : { budgetOperationId: record.budgetOperationId }),
        },
        payload: {
          workloadId: record.id,
          workloadKey: record.workloadKey,
          workloadKind: record.runtimeMetadata.workloadKind,
          status: record.status,
          attempt: record.attempts,
          ...extraPayload,
        },
      },
      `${record.id}:${command}`,
    );
    if (options.bind !== undefined) {
      await store.bindWorkloadLedgerSequence({
        applicationId: record.applicationId,
        workloadKey: record.workloadKey,
        phase: options.bind,
        sequence: outcome.sequence,
      });
    }
    return outcome;
  };

  /** Journal-then-fail denial: durable denied row + ledger envelope + typed error. */
  const denyWorkload = async (
    applicationId: string,
    tenantId: string,
    executionId: string,
    spec: TrainingWorkloadSpec,
    fingerprint: string,
    idempotencyKey: string,
    denialClass: "policy" | "budget" | "capability",
    code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE",
    reason: string,
    substrate: TrainingWorkloadRecord["runtimeMetadata"]["substrate"],
  ): Promise<never> => {
    const workloadId = deps.generateId();
    const metadata = {
      workloadKind: spec.workloadKind,
      task: spec.task,
      resource: spec.resource,
      lineage: spec.lineage,
      checkpointIntervalSteps: spec.checkpointIntervalSteps,
      maxRetryAttempts: spec.maxRetryAttempts,
      substrate,
      policyEvidence: null,
      capabilitySatisfaction: null,
      budgetOperationId: null,
    };
    const claim = await store.insertWorkload({
      id: workloadId,
      applicationId,
      tenantId,
      executionId,
      workloadKey: idempotencyKey,
      requestFingerprint: fingerprint,
      workloadKind: spec.workloadKind,
      status: "denied",
      runtimeMetadata: metadata,
      denialClass,
      denialCode: code,
      denialReason: reason,
      budgetOperationId: null,
      createdAt: iso(),
    });
    if (claim.claimed) {
      // Denied rows are insert-only terminal rows: replays converge
      // without a second envelope because the event append is idempotent
      // per key.
      await appendLedgerEvent(
        claim.record,
        "sandbox-denied",
        { denied: true, denialClass, code, reason },
        { bind: undefined },
      );
    }
    throw new PlatformError({
      code,
      message: `training workload admission denied (${denialClass}): ${reason}`,
      details: {
        workloadId: claim.record.id,
        denialClass,
        reason,
      },
    });
  };

  /** Replay a committed record as the caller-visible outcome. */
  const replayOutcome = (record: TrainingWorkloadRecord): TrainingWorkloadRecord => {
    if (record.status === "denied") {
      // Journal-then-fail: the denial is durable; the same logical
      // request replays the same typed canonical denial.
      throw new PlatformError({
        code: record.denialCode ?? "SANDBOX_ERROR",
        message:
          `training workload admission was denied (${record.denialClass}): ${record.denialReason ?? ""}`.trim(),
        details: {
          workloadId: record.id,
          denialClass: record.denialClass,
          reason: record.denialReason,
        },
      });
    }
    return record;
  };

  // =========================================================================
  // SUBMISSION — the admission chain (budget BEFORE paid allocation)
  // =========================================================================
  const submitWorkload = async (
    input: TrainingCreateInput & { readonly secretRefs?: readonly string[] },
    idempotencyKey: string,
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    // ----- 0. Pure request validation (no durable writes, no authority
    // calls; failures never claim the idempotency key). ---------------------
    if (!isUuid(input?.executionId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload submission requires a valid executionId (the parent execution)",
      });
    }
    if (!isUuid(actor.actorId) || !isUuid(actor.tenantId) || !isUuid(actor.applicationId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload submission requires a server-derived actor scope",
      });
    }
    if (typeof idempotencyKey !== "string" || !TRAINING_KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message:
          "training workload submission requires a non-empty printable idempotency key (max 200 chars)",
      });
    }
    const taskCheck = validateSandboxTask(input?.spec?.task);
    if (!taskCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid training task: ${taskCheck.reason}`,
      });
    }
    const specCheck = validateTrainingWorkloadSpec(input?.spec);
    if (!specCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid training workload specification: ${specCheck.issues
          .map((issue) => `${issue.field} ${issue.reason}`)
          .join("; ")}`,
      });
    }
    const spec: TrainingWorkloadSpec = input.spec;

    const fingerprint = trainingRequestFingerprint(
      actor.applicationId,
      input.executionId,
      actor.actorId,
      {
        executionId: input.executionId,
        spec,
      },
    );

    // ----- 1. Idempotent replay fast path. -----------------------------------
    const existing = await store.findWorkloadByKey(actor.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { workloadId: existing.id },
        });
      }
      if (existing.status === "admitted" && existing.ledgerAdmittedSequence === null) {
        // A prior submission crashed between the bundle and the envelope:
        // repair the admitted envelope binding, then replay.
        const appended = await appendLedgerEvent(
          existing,
          "sandbox-admitted",
          admittedPayload(existing),
        );
        await store.bindWorkloadLedgerSequence({
          applicationId: existing.applicationId,
          workloadKey: existing.workloadKey,
          phase: "admitted",
          sequence: appended.sequence,
        });
      }
      return replayOutcome(
        (await store.findWorkloadByKey(actor.applicationId, idempotencyKey)) ?? existing,
      );
    }

    // ----- 2. Identity/tenant + execution binding. ---------------------------
    const execution = await ledger.getExecution(actor.applicationId, input.executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId: input.executionId },
      });
    }
    if (execution.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId: input.executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no training workload may be admitted on it`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }

    // ----- 3. Substrate RESOLUTION (the provider-neutral capability/resource
    // contract match — ACC-002). A missing substrate fails closed. -----------
    const selection =
      (await substrates.select(
        actor.applicationId,
        spec.workloadKind,
        spec.resource.accelerator,
      )) ??
      (await denyWorkload(
        actor.applicationId,
        execution.tenantId,
        input.executionId,
        spec,
        fingerprint,
        idempotencyKey,
        "capability",
        "CAPABILITY_UNAVAILABLE",
        `no available accelerator substrate satisfies the requested capability/resource contract (class ${spec.resource.accelerator.acceleratorClass}, ${spec.resource.accelerator.deviceCount} devices, ${spec.resource.accelerator.perDeviceMemoryMiB} MiB per device)`,
        null,
      ));
    const substrate = {
      substrateId: selection.substrateId,
      version: selection.version,
      adapterRef: selection.adapterRef,
      digest: selection.digest,
      executionCapabilityId: selection.executionCapabilityId,
    };

    // ----- 4. POLICY admission (the gate — before anything paid). -----------
    const decision = await admission.admit({
      tenantId: execution.tenantId,
      applicationId: actor.applicationId,
      executionId: input.executionId,
      workloadKind: spec.workloadKind,
      acceleratorClass: spec.resource.accelerator.acceleratorClass,
      estimatedCostMicroUsd: spec.resource.estimatedCostMicroUsd,
      secretRefs: input.secretRefs ?? [],
    });
    if (!decision.allowed) {
      await denyWorkload(
        actor.applicationId,
        execution.tenantId,
        input.executionId,
        spec,
        fingerprint,
        idempotencyKey,
        "policy",
        "POLICY_DENIED",
        decision.reason,
        substrate,
      );
    }
    const policyEvidence =
      "evidence" in decision && decision.evidence !== undefined ? decision.evidence : null;

    // ----- 5. CAPABILITY admission (the capabilities authority). ------------
    const capabilityProfile = {
      requirements: [
        {
          id: selection.executionCapabilityId,
          kind: "runtime" as const,
          ...(spec.resource.accelerator.minVersion === undefined
            ? {}
            : { minVersion: spec.resource.accelerator.minVersion }),
        },
      ],
    };
    const resolution = await capabilities.resolve(capabilityProfile);
    if (!resolution.satisfied) {
      const unmet = resolution.unmet
        .map((entry) => `${entry.requirementId}(${entry.reason})`)
        .join(", ");
      await denyWorkload(
        actor.applicationId,
        execution.tenantId,
        input.executionId,
        spec,
        fingerprint,
        idempotencyKey,
        "capability",
        "CAPABILITY_UNAVAILABLE",
        `accelerator substrate capability requirement cannot be satisfied: ${unmet}`,
        substrate,
      );
    }
    const satisfaction = resolution.satisfied ? resolution.satisfactions[0] : undefined;
    const capabilitySatisfaction =
      satisfaction === undefined
        ? null
        : `${satisfaction.claimId}@${satisfaction.claimVersion} (${satisfaction.evidenceKind}:${satisfaction.evidenceReference})`;

    // ----- 6. BUDGET/resource admission (the REAL authority — BEFORE any
    // paid compute allocation; training is always costed). ------------------
    const budgetOperationId = budgetOperationIdFor(idempotencyKey, 1);
    try {
      await budgetAuthority.reserve(
        {
          actorId: actor.actorId,
          applicationId: actor.applicationId,
          tenantId: execution.tenantId,
          executionId: input.executionId,
          operationId: budgetOperationId,
          userId: execution.userId ?? "",
          amountMicroUsd: spec.resource.estimatedCostMicroUsd,
        },
        `training-reserve:${budgetOperationId}`,
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
        await denyWorkload(
          actor.applicationId,
          execution.tenantId,
          input.executionId,
          spec,
          fingerprint,
          idempotencyKey,
          "budget",
          "BUDGET_EXCEEDED",
          error.message,
          substrate,
        );
      }
      throw error;
    }

    // ----- 7. Durable admission bundle (ONE identity, immutable metadata). --
    const workloadId = deps.generateId();
    const metadata = {
      workloadKind: spec.workloadKind,
      task: spec.task,
      resource: spec.resource,
      lineage: spec.lineage,
      checkpointIntervalSteps: spec.checkpointIntervalSteps,
      maxRetryAttempts: spec.maxRetryAttempts,
      substrate,
      policyEvidence,
      capabilitySatisfaction,
      budgetOperationId,
    };
    const claim = await store.insertWorkload({
      id: workloadId,
      applicationId: actor.applicationId,
      tenantId: execution.tenantId,
      executionId: input.executionId,
      workloadKey: idempotencyKey,
      requestFingerprint: fingerprint,
      workloadKind: spec.workloadKind,
      status: "admitted",
      runtimeMetadata: metadata,
      denialClass: null,
      denialCode: null,
      denialReason: null,
      budgetOperationId,
      createdAt: iso(),
    });
    if (!claim.claimed) {
      // A concurrent duplicate owns the key: converge on its committed state.
      return replayOutcome(claim.record);
    }
    let record = claim.record;

    // ----- 8. Ledger admission evidence (idempotent per workload identity). -
    const appended = await appendLedgerEvent(record, "sandbox-admitted", admittedPayload(record));
    record =
      (await store.bindWorkloadLedgerSequence({
        applicationId: record.applicationId,
        workloadKey: record.workloadKey,
        phase: "admitted",
        sequence: appended.sequence,
      })) ?? record;
    return record;
  };

  const admittedPayload = (record: TrainingWorkloadRecord): Readonly<Record<string, unknown>> => ({
    workloadKind: record.runtimeMetadata.workloadKind,
    resource: record.runtimeMetadata.resource,
    lineage: record.runtimeMetadata.lineage,
    substrate: record.runtimeMetadata.substrate,
    policyEvidence: record.runtimeMetadata.policyEvidence,
    capabilitySatisfaction: record.runtimeMetadata.capabilitySatisfaction,
    budgetOperationId: record.runtimeMetadata.budgetOperationId,
  });

  // =========================================================================
  // DISPATCH — the allocation (paid, after the reservation) + the run
  // =========================================================================
  const dispatchWorkload = async (
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    if (!isUuid(input?.applicationId) || !isUuid(input?.workloadId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload dispatch requires applicationId and workloadId",
      });
    }
    if (!isUuid(actor.actorId) || !isUuid(actor.tenantId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload dispatch requires a server-derived actor scope",
      });
    }

    // ----- 1. Scope-guarded resolution. --------------------------------------
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "training workload not found in this application (missing or owned by another application)",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (found.status === "denied") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "a denied training workload cannot be dispatched",
        details: { workloadId: found.id },
      });
    }
    if (isTerminalTrainingStatus(found.status) || found.status === "failed") {
      // completed/failed/cancelled: the FIRST dispatch's outcome IS the
      // durable outcome — every later dispatch replays it (no
      // re-execution of paid compute) AND reconciles the finalization
      // tail (idempotent per stable key — a process that died between
      // the terminal transition and the tail is recovered here).
      await reconcileFinalizedTails(
        found,
        found.status === "completed"
          ? "completed"
          : found.status === "failed"
            ? "failed"
            : "cancelled",
      );
      return found;
    }
    if (found.status === "running") {
      // An honest crash state: the recovery path is resumeWorkload
      // (lease + materiality discipline), never a silent re-dispatch.
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "the workload is already dispatching/running (a prior dispatch's outcome is unknown); use resumeWorkload to recover it through the lease/materiality discipline",
        details: { workloadId: found.id, status: found.status },
      });
    }

    // ----- 2. The durable allocation intent (one-shot admitted -> allocating;
    // a re-drive of an `allocating` row converges through the same key). ----
    const allocationKey = trainingOperationKey(
      "allocate",
      `${found.workloadKey}:attempt:${found.attempts}`,
    );
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "allocate",
      operationKey: allocationKey,
      requestFingerprint: `allocate:${found.workloadKey}:${found.attempts}`,
      createdAt: iso(),
    });
    let record = found;
    if (found.status === "admitted") {
      const transitioning = await store.transitionWorkload({
        applicationId: found.applicationId,
        workloadKey: found.workloadKey,
        to: "allocating",
        now: iso(),
      });
      if (!transitioning.claimed) {
        const concurrent = transitioning.record;
        if (isTerminalTrainingStatus(concurrent.status) || concurrent.status === "failed") {
          return concurrent; // a concurrent dispatcher finalized first — replay it
        }
      }
      record = transitioning.record;
    }

    // ----- 3. Runtime resolution from the IMMUTABLE admitted snapshot. ------
    return allocateAndRun(record, allocationKey);
  };

  /** The allocation (PAID, after the reservation) + run start + drive. */
  const allocateAndRun = async (
    record: TrainingWorkloadRecord,
    allocationKey: string,
  ): Promise<TrainingWorkloadRecord> => {
    const metadata = record.runtimeMetadata;
    if (metadata.substrate === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message:
          "the admitted snapshot carries no substrate selection; the workload cannot dispatch",
        details: { workloadId: record.id },
      });
    }
    const runtime = runtimes.runtimeFor(metadata.substrate.adapterRef);
    if (runtime === null) {
      // Unwired substrate: fail closed — the reservation must not leak.
      return finalizeFailure(record, {
        failureClass: "substrate-unavailable",
        message: `no accelerator runtime is wired for adapter ref "${metadata.substrate.adapterRef}"; the workload fails closed rather than allocating ungoverned compute`,
      });
    }

    // ----- THE PAID ALLOCATION (after the reservation; stable key). ---------
    const allocation = await runtime.allocate(metadata.resource.accelerator, allocationKey, {
      applicationId: record.applicationId,
      tenantId: record.tenantId,
    });
    record = await store.bindWorkloadAllocation({
      applicationId: record.applicationId,
      workloadKey: record.workloadKey,
      allocationId: allocation.allocationId,
      substrateId: metadata.substrate.substrateId,
      adapterRef: metadata.substrate.adapterRef,
      allocatedAt: iso(),
    });

    // ----- The run lease (single-owner, monotonic epochs) + run start. ------
    await store.acquireTrainingRunLease({
      applicationId: record.applicationId,
      workloadId: record.id,
      tenantId: record.tenantId,
      ownerId: workerIdOf(record.workloadKey),
      now: iso(),
      leaseDurationMs,
    });
    if (record.status === "allocating") {
      const running = await store.transitionWorkload({
        applicationId: record.applicationId,
        workloadKey: record.workloadKey,
        to: "running",
        now: iso(),
      });
      record = running.record;
    }
    return driveRun(record, allocationKey);
  };

  /** The long-running execution: the keyed substrate run → checkpoints → finalize. */
  const driveRun = async (
    record: TrainingWorkloadRecord,
    allocationKey: string,
  ): Promise<TrainingWorkloadRecord> => {
    const metadata = record.runtimeMetadata;
    const runtime =
      metadata.substrate === null ? null : runtimes.runtimeFor(metadata.substrate.adapterRef);
    if (runtime === null) {
      return finalizeFailure(record, {
        failureClass: "substrate-unavailable",
        message: "the accelerator runtime is not wired for the admitted substrate",
      });
    }
    const runKey = trainingOperationKey("run", `${record.workloadKey}:attempt:${record.attempts}`);
    const resumeRefs =
      record.lastCheckpointIdentity === null ? [] : [record.lastCheckpointIdentity];
    const runSpec = {
      workloadId: record.id,
      workloadKey: record.workloadKey,
      applicationId: record.applicationId,
      tenantId: record.tenantId,
      executionId: record.executionId,
      workloadKind: metadata.workloadKind,
      task: metadata.task,
      resource: metadata.resource,
      lineageRefs: {
        datasetRefs: [...metadata.lineage.datasetRefs],
        codeRefs: [...metadata.lineage.codeRefs],
        configRefs: [...metadata.lineage.configRefs],
        checkpointRefs: [...metadata.lineage.checkpointRefs, ...resumeRefs],
        parentOutputRefs: [...metadata.lineage.parentOutputRefs],
      },
      resumeCheckpointRefs: resumeRefs,
      checkpointIntervalSteps: metadata.checkpointIntervalSteps,
      attempt: record.attempts,
    };
    let observation: TrainingRunObservation;
    try {
      observation = await runtime.run(runSpec, runKey);
    } catch (error) {
      observation = {
        outcome: "workload-failed",
        stepsCompleted: 0,
        checkpoints: [],
        output: null,
        usageMicroUsd: "0",
        failure: {
          failureClass: "substrate-error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }

    // The emitted checkpoints (write-once, identity-addressed).
    for (const emitted of observation.checkpoints) {
      await recordCheckpointInternal(
        record,
        {
          checkpointSequence: emitted.checkpointSequence,
          stepPosition: emitted.stepPosition,
          metricsDigest: emitted.metricsDigest,
          lineage: {
            datasetRefs: [...(emitted.lineage.datasetRefs ?? [])],
            codeRefs: [...(emitted.lineage.codeRefs ?? [])],
            configRefs: [...(emitted.lineage.configRefs ?? [])],
            checkpointRefs: [...(emitted.lineage.checkpointRefs ?? [])],
            parentOutputRefs: [...(emitted.lineage.parentOutputRefs ?? [])],
          },
        },
        workerIdOf(record.workloadKey),
      );
    }

    if (observation.outcome === "workload-completed") {
      return finalizeSuccess(record, observation);
    }
    return finalizeFailure(record, {
      failureClass: observation.failure?.failureClass ?? "workload-failure",
      message: observation.failure?.message ?? "the substrate reported a failed run",
    });
  };

  /** The worker-emitted checkpoint facts (the service binds the identity core). */
  type EmittedCheckpointFacts = {
    readonly checkpointSequence: number;
    readonly stepPosition: number;
    readonly metricsDigest: string;
    readonly lineage: TrainingCheckpointContents["lineage"];
  };

  /** Record one emitted checkpoint (write-once; identity = content digest). */
  const recordCheckpointInternal = async (
    record: TrainingWorkloadRecord,
    emitted: EmittedCheckpointFacts,
    recordedBy: string,
  ): Promise<TrainingCheckpointRecord> => {
    const contents: TrainingCheckpointContents = {
      executionId: record.executionId,
      workloadId: record.id,
      workloadKey: record.workloadKey,
      checkpointSequence: emitted.checkpointSequence,
      stepPosition: emitted.stepPosition,
      lineage: emitted.lineage,
      metricsDigest: emitted.metricsDigest,
      substrateId: record.runtimeMetadata.substrate?.substrateId ?? "unresolved",
      resourceClass: resourceClassOf(record),
      recordedBy,
    };
    validateTrainingCheckpointContents(contents);
    const identity = trainingCheckpointIdentity(contents, digest);
    const operationKey = trainingOperationKey(
      "checkpoint",
      `${record.workloadKey}:seq:${contents.checkpointSequence}`,
    );
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: record.applicationId,
      tenantId: record.tenantId,
      executionId: record.executionId,
      workloadId: record.id,
      operationKind: "checkpoint",
      operationKey,
      requestFingerprint: `checkpoint:${identity}`,
      createdAt: iso(),
    });
    const claim = await store.insertTrainingCheckpoint({
      id: deps.generateId(),
      applicationId: record.applicationId,
      tenantId: record.tenantId,
      executionId: record.executionId,
      workloadId: record.id,
      workloadKey: record.workloadKey,
      contents,
      contentDigest: identity,
      createdAt: iso(),
    });
    if (claim.claimed) {
      try {
        await appendLedgerEvent(
          record,
          "checkpoint-recorded",
          {
            checkpointIdentity: identity,
            checkpointSequence: contents.checkpointSequence,
            stepPosition: contents.stepPosition,
            metricsDigest: contents.metricsDigest,
          },
          { bind: undefined },
        );
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
      }
    }
    await store.bindWorkloadResumePoint({
      applicationId: record.applicationId,
      workloadKey: record.workloadKey,
      checkpointIdentity: identity,
    });
    return claim.record;
  };

  /** The neutral resource class string of a workload (audit vocabulary). */
  const resourceClassOf = (record: TrainingWorkloadRecord): string =>
    `${record.runtimeMetadata.resource.accelerator.acceleratorClass}:${record.runtimeMetadata.resource.accelerator.deviceCount}x${record.runtimeMetadata.resource.replicaCount}`;

  /** The success tail: output adoption + completion + settle + evidence. */
  const finalizeSuccess = async (
    record: TrainingWorkloadRecord,
    observation: TrainingRunObservation,
  ): Promise<TrainingWorkloadRecord> => {
    // Ledger completion evidence FIRST (deterministic payload; idempotent
    // per workload identity): appending before the row finalizes keeps
    // the binding writable and makes a terminal row WITHOUT its
    // completion event unreachable — a crash after the event leaves the
    // row honestly `running`.
    let completedSequence: number | null = null;
    const current =
      (await store.findWorkloadByKey(record.applicationId, record.workloadKey)) ?? record;
    if (current.ledgerCompletedSequence === null) {
      try {
        const appended = await appendLedgerEvent(current, "sandbox-completed", {
          outcomeClass: "workload-completed",
          status: "completed",
          stepsCompleted: observation.stepsCompleted,
          outputArtifactDigest: observation.output?.contentDigest ?? null,
          usageMicroUsd: observation.usageMicroUsd,
        });
        completedSequence = appended.sequence;
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
        // The winner's envelope already recorded this logical completion.
      }
    } else {
      completedSequence = current.ledgerCompletedSequence;
    }

    const withOutput =
      observation.output !== null
        ? await store.bindWorkloadOutput({
            applicationId: record.applicationId,
            workloadKey: record.workloadKey,
            outputArtifactDigest: observation.output.contentDigest,
            outputDescriptor: observation.output.descriptor,
          })
        : record;
    const finalized = await store.transitionWorkload({
      applicationId: record.applicationId,
      workloadKey: record.workloadKey,
      to: "completed",
      now: iso(),
      completion: {
        outputArtifactDigest: withOutput.outputArtifactDigest,
        outputDescriptor: withOutput.outputDescriptor,
        usageMicroUsd: observation.usageMicroUsd,
        completedLedgerSequence: completedSequence,
      },
    });
    const final = finalized.record;

    // The finalization tail: the allocation operation completion + run
    // lease release + substrate release + budget settlement — every
    // step idempotent per stable key (reconciled by terminal replays).
    await reconcileFinalizedTails(final, "completed");
    return final;
  };

  /** The failure tail: durable failure + release the reservation + lease. */
  const finalizeFailure = async (
    record: TrainingWorkloadRecord,
    failure: { readonly failureClass: TrainingFailureClass; readonly message: string },
  ): Promise<TrainingWorkloadRecord> => {
    const current =
      (await store.findWorkloadByKey(record.applicationId, record.workloadKey)) ?? record;
    if (current.ledgerCompletedSequence === null) {
      try {
        await appendLedgerEvent(current, "sandbox-completed", {
          outcomeClass: "workload-failed",
          status: "failed",
          failureClass: failure.failureClass,
          failureMessage: failure.message,
        });
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
      }
    }
    const finalized = await store.transitionWorkload({
      applicationId: record.applicationId,
      workloadKey: record.workloadKey,
      to: "failed",
      now: iso(),
      failure: {
        failureClass: failure.failureClass,
        failureMessage: failure.message,
      },
    });
    const final = finalized.record;
    await reconcileFinalizedTails(final, "failed");
    return final;
  };

  const runtimeOf = (record: TrainingWorkloadRecord) => {
    const adapterRef = record.runtimeMetadata.substrate?.adapterRef;
    return adapterRef === undefined || adapterRef === null ? null : runtimes.runtimeFor(adapterRef);
  };

  // =========================================================================
  // CHECKPOINT EMISSION — the worker-driven protocol (public seam)
  // =========================================================================
  const emitCheckpoint = async (
    input: {
      readonly applicationId: string;
      readonly workloadId: string;
      readonly contents: Omit<
        TrainingCheckpointContents,
        "executionId" | "workloadId" | "workloadKey"
      >;
    },
    actor: TrainingActor,
  ): Promise<TrainingCheckpointRecord> => {
    if (!isUuid(input?.applicationId) || !isUuid(input?.workloadId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training checkpoint emission requires applicationId and workloadId",
      });
    }
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload not found in this application",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (found.status !== "running") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `checkpoints are only emitted by a RUNNING workload (status: ${found.status})`,
        details: { workloadId: found.id, status: found.status },
      });
    }
    return recordCheckpointInternal(found, input.contents, actor.actorId);
  };

  // =========================================================================
  // CANCELLATION — the governed interruption
  // =========================================================================
  const cancelWorkload = async (
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload not found in this application",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (isTerminalTrainingStatus(found.status)) {
      return found; // cancelled/completed/denied: the durable outcome replays
    }
    if (found.status === "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "a failed workload is retired through retry, not cancellation",
        details: { workloadId: found.id, status: found.status },
      });
    }

    // Durable interruption evidence FIRST (journal-then-act).
    const cancelKey = trainingOperationKey("cancel", found.workloadKey);
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "cancel",
      operationKey: cancelKey,
      requestFingerprint: `cancel:${found.workloadKey}`,
      createdAt: iso(),
    });
    try {
      await appendLedgerEvent(found, "interruption-requested", {
        reason: "operator cancellation",
        status: found.status,
      });
    } catch (error) {
      if (!isIdempotencyReuse(error)) {
        throw error;
      }
    }

    // Release the substrate allocation (stable key; exactly once).
    await runtimeOf(found)?.release(
      trainingOperationKey("allocate", `${found.workloadKey}:attempt:${found.attempts}`),
    );
    const cancelled = await store.transitionWorkload({
      applicationId: found.applicationId,
      workloadKey: found.workloadKey,
      to: "cancelled",
      now: iso(),
    });
    const final = cancelled.record;
    // The cancellation tail: allocation release + lease release + the
    // unspent-reservation refund — all idempotent per stable key
    // (reconciled by terminal replays after a crash).
    await reconcileFinalizedTails(final, "cancelled");
    await store.completeTrainingOperation({
      applicationId: found.applicationId,
      operationKey: cancelKey,
      now: iso(),
    });
    return final;
  };

  // =========================================================================
  // RESUME — the crash-recovery path (lease + materiality discipline)
  // =========================================================================
  const resumeWorkload = async (
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload not found in this application",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (isTerminalTrainingStatus(found.status) || found.status === "failed") {
      // Terminal outcomes replay (resume never resurrects) — and the
      // replay reconciles the finalization tail (crash recovery).
      await reconcileFinalizedTails(
        found,
        found.status === "completed"
          ? "completed"
          : found.status === "failed"
            ? "failed"
            : "cancelled",
      );
      return found;
    }
    if (found.status !== "allocating" && found.status !== "running") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `resume applies to an allocating/running workload (status: ${found.status})`,
        details: { workloadId: found.id, status: found.status },
      });
    }

    const resumeKey = trainingOperationKey(
      "resume",
      `${found.workloadKey}:attempt:${found.attempts}`,
    );
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "resume",
      operationKey: resumeKey,
      requestFingerprint: `resume:${found.workloadKey}:${found.attempts}`,
      createdAt: iso(),
    });

    // THE LEASE DISCIPLINE: a LIVE lease means a worker may still own the
    // run — resume fails closed (the crashed worker's lease lapses by
    // expiry; a live foreign owner is never superseded silently).
    const lease = await store.findTrainingRunLease(found.applicationId, found.id);
    if (lease !== null && lease.releasedAt === null && lease.expiresAt > iso()) {
      try {
        await appendLedgerEvent(found, "resume-denied", {
          reason: "a live run lease is held; lease conflicts fail closed",
        });
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the run lease is live until ${lease.expiresAt} (owner ${lease.ownerId}); resume fails closed until the lease lapses`,
        details: { workloadId: found.id, ownerId: lease.ownerId, expiresAt: lease.expiresAt },
      });
    }

    // THE MATERIALITY RULE: an UNCHANGED resume (a crash-recovery retry
    // of the same admitted facts) skips re-admission and resumes from
    // the checkpoint; a MATERIALLY CHANGED resume re-enters the CURRENT
    // admission controls.
    if (found.lastCheckpointIdentity !== null) {
      const checkpoint = await store.findTrainingCheckpointByIdentity(
        found.applicationId,
        found.lastCheckpointIdentity,
      );
      if (checkpoint !== null) {
        const facts = {
          workloadKind: found.runtimeMetadata.workloadKind,
          substrateId: found.runtimeMetadata.substrate?.substrateId ?? "",
          resourceClass: resourceClassOf(found),
          estimatedCostMicroUsd: found.runtimeMetadata.resource.estimatedCostMicroUsd,
          requiredCapabilities: found.runtimeMetadata.substrate?.executionCapabilityId
            ? [found.runtimeMetadata.substrate.executionCapabilityId]
            : [],
        };
        const changed = trainingMaterialChangeBetween(checkpoint.contents, facts);
        if (changed.length > 0) {
          const decision = await admission.admit({
            tenantId: found.tenantId,
            applicationId: found.applicationId,
            executionId: found.executionId,
            workloadKind: facts.workloadKind,
            acceleratorClass: found.runtimeMetadata.resource.accelerator.acceleratorClass,
            estimatedCostMicroUsd: facts.estimatedCostMicroUsd,
            secretRefs: [],
          });
          if (!decision.allowed) {
            try {
              await appendLedgerEvent(found, "resume-denied", {
                reason: decision.reason,
                changedDimensions: [...changed],
              });
            } catch (error) {
              if (!isIdempotencyReuse(error)) {
                throw error;
              }
            }
            throw new PlatformError({
              code: "POLICY_DENIED",
              message: `a materially changed resume was denied by the policy authority: ${decision.reason}`,
              details: { workloadId: found.id, changedDimensions: [...changed] },
            });
          }
        }
      }
    }

    // Re-acquire the lease at the next epoch (the crashed worker is
    // superseded — its (owner, epoch) pair never matches again).
    await store.acquireTrainingRunLease({
      applicationId: found.applicationId,
      workloadId: found.id,
      tenantId: found.tenantId,
      ownerId: workerIdOf(found.workloadKey),
      now: iso(),
      leaseDurationMs,
    });
    try {
      await appendLedgerEvent(found, "resume-recorded", {
        attempt: found.attempts,
        resumeCheckpointIdentity: found.lastCheckpointIdentity,
      });
    } catch (error) {
      if (!isIdempotencyReuse(error)) {
        throw error;
      }
    }
    await store.completeTrainingOperation({
      applicationId: found.applicationId,
      operationKey: resumeKey,
      now: iso(),
    });

    // The re-drive: for an `allocating` row, the allocation converges
    // through the same stable attempt key; a `running` row re-runs with
    // the same run key (the substrate's keyed idempotency ledger) from
    // the durable resume point. Either path lands exactly one paid
    // allocation and one run per (workload, attempt).
    const allocationKey = trainingOperationKey(
      "allocate",
      `${found.workloadKey}:attempt:${found.attempts}`,
    );
    // Re-arm the durable allocation intent under the SAME stable key
    // (convergent when the original dispatch already claimed it — and
    // self-sufficient when the resume is the first re-drive, so the
    // completion tail always finds its operation row).
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "allocate",
      operationKey: allocationKey,
      requestFingerprint: `allocate:${found.workloadKey}:${found.attempts}`,
      createdAt: iso(),
    });
    if (found.status === "allocating") {
      return allocateAndRun(found, allocationKey);
    }
    return driveRun(found, allocationKey);
  };

  // =========================================================================
  // RETRY — the failed-workload re-arm (fresh budget admission per attempt)
  // =========================================================================
  const retryWorkload = async (
    input: { readonly applicationId: string; readonly workloadId: string },
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload not found in this application",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (found.status !== "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `only a FAILED workload can retry (status: ${found.status})`,
        details: { workloadId: found.id, status: found.status },
      });
    }
    if (found.attempts > found.runtimeMetadata.maxRetryAttempts) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `the workload exhausted its retry ladder (${found.runtimeMetadata.maxRetryAttempts} retries)`,
        details: { workloadId: found.id, attempts: found.attempts },
      });
    }

    const retryKey = trainingOperationKey(
      "retry",
      `${found.workloadKey}:attempt:${found.attempts + 1}`,
    );
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "retry",
      operationKey: retryKey,
      requestFingerprint: `retry:${found.workloadKey}:${found.attempts + 1}`,
      createdAt: iso(),
    });

    // A retry is a NEW PAID attempt: fresh budget admission BEFORE the
    // new allocation (a new reservation for the new attempt).
    const nextAttempt = found.attempts + 1;
    const budgetOperationId = budgetOperationIdFor(found.workloadKey, nextAttempt);
    await budgetAuthority.reserve(
      {
        actorId: actor.actorId,
        applicationId: found.applicationId,
        tenantId: found.tenantId,
        executionId: found.executionId,
        operationId: budgetOperationId,
        userId: "",
        amountMicroUsd: found.runtimeMetadata.resource.estimatedCostMicroUsd,
      },
      `training-reserve:${budgetOperationId}`,
    );

    // The guarded re-arm: attempts+1 (the retry ledger) + the budget
    // discriminator rebind to the NEW attempt's reservation, failed ->
    // allocating through the same stable identity.
    await store.bumpWorkloadAttempts({
      applicationId: found.applicationId,
      workloadKey: found.workloadKey,
      budgetOperationId,
    });
    await store.completeTrainingOperation({
      applicationId: found.applicationId,
      operationKey: retryKey,
      now: iso(),
    });
    const reArmed = await store.transitionWorkload({
      applicationId: found.applicationId,
      workloadKey: found.workloadKey,
      to: "allocating",
      now: iso(),
    });
    const record = reArmed.record;
    // Re-dispatch the new attempt (through the SAME dispatch boundary).
    return dispatchWorkload({ applicationId: record.applicationId, workloadId: record.id }, actor);
  };

  // =========================================================================
  // VERIFICATION BEFORE RELEASE (ACC-003 — compute completion is NOT release)
  // =========================================================================
  const verifyAndReleaseWorkload = async (
    input: {
      readonly applicationId: string;
      readonly workloadId: string;
      readonly criteria: readonly { readonly criterionId: string; readonly version: number }[];
      readonly evidenceRefs: readonly string[];
    },
    idempotencyKey: string,
    actor: TrainingActor,
  ): Promise<TrainingWorkloadRecord> => {
    const found = await store.findWorkload(input.applicationId, input.workloadId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload not found in this application",
        details: { workloadId: input.workloadId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "training workload belongs to a different tenant",
        details: { workloadId: found.id },
      });
    }
    if (typeof idempotencyKey !== "string" || !TRAINING_KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "release verification requires a non-empty printable idempotency key",
      });
    }
    if (found.status !== "completed") {
      // A failed (or otherwise non-completed) run is NEVER a release
      // candidate — the verification gate is unreachable for it.
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `only a COMPLETED workload can enter release verification (status: ${found.status}); compute failure is never a model release`,
        details: { workloadId: found.id, status: found.status },
      });
    }
    if (found.outputArtifactDigest === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "the completed workload adopted no output artifact; there is nothing to verify",
        details: { workloadId: found.id },
      });
    }
    if (found.verifiedReleaseAt !== null) {
      return found; // the release binding is write-once: replay it
    }

    const releaseKey = trainingOperationKey("release", found.workloadKey);
    await store.insertTrainingOperation({
      id: deps.generateId(),
      applicationId: found.applicationId,
      tenantId: found.tenantId,
      executionId: found.executionId,
      workloadId: found.id,
      operationKind: "release",
      operationKey: releaseKey,
      requestFingerprint: `release:${found.workloadKey}:${idempotencyKey}`,
      createdAt: iso(),
    });

    // THE verification authority gate (the ONLY writer of the release
    // dimension — compute completion alone NEVER releases).
    const verdict = await verification.verify(
      {
        applicationId: found.applicationId,
        tenantId: found.tenantId,
        executionId: found.executionId,
        workloadId: found.id,
        workloadKey: found.workloadKey,
        outputArtifactDigest: found.outputArtifactDigest,
        criteria: input.criteria,
        evidenceRefs: input.evidenceRefs,
        lineage: found.runtimeMetadata.lineage,
      },
      idempotencyKey,
    );
    if (!verdict.passed) {
      await store.completeTrainingOperation({
        applicationId: found.applicationId,
        operationKey: releaseKey,
        failureReason: `verification verdict: ${verdict.conclusion}`,
        now: iso(),
      });
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: `the verification authority did not pass the training output: ${verdict.conclusion}`,
        details: { workloadId: found.id, evaluationId: verdict.evaluationId },
      });
    }
    const released = await store.bindWorkloadRelease({
      applicationId: found.applicationId,
      workloadKey: found.workloadKey,
      verifiedReleaseAt: iso(),
      verificationEvaluationId: verdict.evaluationId,
    });
    await store.completeTrainingOperation({
      applicationId: found.applicationId,
      operationKey: releaseKey,
      now: iso(),
    });
    return released;
  };

  return {
    submitWorkload,
    dispatchWorkload,
    emitCheckpoint,
    cancelWorkload,
    resumeWorkload,
    retryWorkload,
    verifyAndReleaseWorkload,
    async getWorkload(applicationId, workloadId) {
      return store.findWorkload(applicationId, workloadId);
    },
    async getCheckpointByIdentity(applicationId, contentDigest) {
      return store.findTrainingCheckpointByIdentity(applicationId, contentDigest);
    },
    async listWorkloadsByExecution(applicationId, executionId) {
      return store.listWorkloadsByExecution(applicationId, executionId);
    },
  };
}
