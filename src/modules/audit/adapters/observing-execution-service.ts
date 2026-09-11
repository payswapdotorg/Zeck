/**
 * Executions seam observer (audit module adapter; WORK-059 / SEC-004).
 *
 * OBSERVATION THROUGH EXISTING SEAMS: this adapter wraps an
 * `ExecutionService` (the executions module's public contract — the
 * single execution write path) and records the governed actions that
 * flow through it (`execution.created`, `execution.transitioned`).
 * The wrapped service remains the AUTHORITY: every call delegates to
 * it unchanged, its outcome passes through verbatim, and the observer
 * only APPENDS evidence. There is no re-implementation of execution
 * semantics here — the executions module is imported through its
 * public barrel only (cross-module rule).
 *
 * FAIL-CLOSED OBSERVATION: if the audit append fails AFTER the
 * authority operation committed, the observer throws a typed
 * `AuditProjectionError` — the caller is never told "success" for an
 * unauditable governed action. The authority's request idempotency
 * makes the retry converge: the replayed call returns the SAME
 * durable outcome (deterministic detail), and the audit append
 * retries into the same content identity (bounded no-op or first
 * append). Convergence is proven by test.
 */

import type {
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionService,
  ExecutionTransitionCommand,
  TransitionOutcome,
} from "../../executions/public";
import type { AuditSubmission } from "../domain";
import { scrubAuditDetail } from "../domain";
import type { AuditRecordStore } from "../ports/audit-store";
import { AuditProjectionError } from "../ports/audit-store";

export interface ObservingExecutionServiceOptions {
  /** The authoritative executions service (delegated to, unchanged). */
  readonly inner: ExecutionService;
  /** The durable audit projection store (append-only evidence). */
  readonly store: AuditRecordStore;
  /** The environment label the records carry (deployment dimension). */
  readonly environment: string;
  /**
   * The actor kind the executions seam's actors map to (the seam
   * carries actorId only — an explicit, documented mapping, never a
   * guess).
   */
  readonly actorKind?: "human-principal" | "service-principal";
  readonly now: () => Date;
}

/**
 * The observation wrapper: an `ExecutionService` whose create and
 * transition calls append audit evidence after the authority commits.
 */
export function createObservingExecutionService(
  options: ObservingExecutionServiceOptions,
): ExecutionService {
  const { inner, store, environment, now } = options;
  const actorKind = options.actorKind ?? "service-principal";

  const append = async (submission: AuditSubmission): Promise<void> => {
    try {
      await store.appendRecord(submission);
    } catch (error) {
      throw new AuditProjectionError(
        "the audit projection failed to record a governed executions action (fail closed; retry converges through the authority's idempotency)",
        error,
      );
    }
  };

  const scrubbedDetail = (detail: Record<string, unknown>): Record<string, unknown> => {
    const result = scrubAuditDetail(detail);
    if (!result.admissible) {
      throw new AuditProjectionError(
        `the executions action detail failed the audit scrub gate: ${result.reason}`,
      );
    }
    return result.detail;
  };

  return {
    async createExecution(
      input: ExecutionCreateInput,
      idempotencyKey: string,
      actor: { actorId: string; tenantId: string },
    ): Promise<ExecutionReceipt> {
      const receipt = await inner.createExecution(input, idempotencyKey, actor);
      await append({
        applicationId: receipt.applicationId,
        tenantId: receipt.tenantId,
        environment,
        actor: { actorId: actor.actorId, actorKind },
        action: {
          kind: "execution.created",
          command: "create",
          operationKey: idempotencyKey,
        },
        target: { kind: "execution", id: receipt.executionId },
        provenance: { seam: "executions.create", sourceRecordId: receipt.executionId },
        rationale: { why: `execution created for task kind ${input.task.kind}` },
        occurredAt: now().toISOString(),
        actionDetail: scrubbedDetail({
          taskKind: input.task.kind,
          environmentId: input.environmentId ?? null,
        }),
      });
      return receipt;
    },

    async transition(
      command: ExecutionTransitionCommand,
      idempotencyKey: string,
    ): Promise<TransitionOutcome> {
      const outcome = await inner.transition(command, idempotencyKey);
      await append({
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        environment,
        actor: { actorId: command.actorId, actorKind },
        action: {
          kind: "execution.transitioned",
          command: command.command,
          operationKey: idempotencyKey,
        },
        target: { kind: "execution", id: command.executionId },
        provenance: { seam: "executions.transition", sourceRecordId: command.executionId },
        rationale: { why: `execution transition ${command.command} applied` },
        occurredAt: now().toISOString(),
        // DETERMINISTIC detail: the outcome is the STORED durable
        // outcome (identical on idempotent replay); the volatile
        // replay flag is deliberately excluded from the record.
        actionDetail: scrubbedDetail({
          from: outcome.applied.from,
          to: outcome.applied.to,
          sequence: outcome.applied.sequence,
        }),
      });
      return outcome;
    },

    recordPlanningDecision: (
      input: Parameters<ExecutionService["recordPlanningDecision"]>[0],
      idempotencyKey: string,
    ) => inner.recordPlanningDecision(input, idempotencyKey),

    recordStepEvent: (
      input: Parameters<ExecutionService["recordStepEvent"]>[0],
      idempotencyKey: string,
    ) => inner.recordStepEvent(input, idempotencyKey),

    getExecution: (applicationId: string, executionId: string) =>
      inner.getExecution(applicationId, executionId),

    listEvents: (applicationId: string, executionId: string) =>
      inner.listEvents(applicationId, executionId),

    listVerificationResults: (applicationId: string, executionId: string) =>
      inner.listVerificationResults(applicationId, executionId),
  };
}
