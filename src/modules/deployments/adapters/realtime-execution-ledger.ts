/**
 * Realtime execution-ledger adapter (deployments module; WORK-024).
 *
 * Implements the deployments module's REQUIRED `RealtimeExecutionLedger`
 * port against the REAL executions module public service — the
 * WORK-010/011 ledger-adapter discipline applied to realtime sessions:
 *
 *   - session-mapped Executions are established through the executions
 *     public create seam (idempotent by key: a retried or reconnected
 *     session start converges on the SAME execution identity — a
 *     second authoritative execution is unrepresentable);
 *   - realtime provenance (session start, turns, interruptions,
 *     transfers, failures, significant actions, completion) rides the
 *     canonical executions EventEnvelope ledger as STEP EVENTS through
 *     the executions-owned agent-session vocabulary
 *     ("agent-session-started" / "agent-action-recorded" /
 *     "agent-session-completed") — the semantic detail (evidence
 *     class, route class, channel coordinates, artifact references)
 *     rides the payload/reference fields; the deployments module owns
 *     NONE of the event vocabulary;
 *   - human escalation moves execution status ONLY through the public
 *     transition-command surface (`wait-human` / `resume`) — auditable
 *     on the same ledger;
 *   - execution facts come from the tenant-guarded public read.
 *
 * The deployments module never writes the executions tables directly
 * (a second event authority is unrepresentable). Type + runtime
 * coupling is to the executions PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionService, StepEventCommand } from "../../executions/public";
import type {
  RealtimeEvidenceClass,
  RealtimeEvidenceInput,
  RealtimeEvidenceOutcome,
  RealtimeExecutionLedger,
  RealtimeExecutionOpenInput,
  RealtimeExecutionOpenOutcome,
} from "../ports/realtime-execution-ledger";

/** The executions-owned step-event vocabulary this producer rides. */
const CLASS_TO_COMMAND: Readonly<Record<RealtimeEvidenceClass, StepEventCommand>> = {
  "session-started": "agent-session-started",
  turn: "agent-action-recorded",
  interruption: "agent-action-recorded",
  transfer: "agent-action-recorded",
  failure: "agent-action-recorded",
  "significant-action": "agent-action-recorded",
  "session-completed": "agent-session-completed",
};

export function createRealtimeExecutionLedgerAdapter(
  service: ExecutionService,
): RealtimeExecutionLedger {
  return {
    async openExecution(
      input: RealtimeExecutionOpenInput,
      idempotencyKey: string,
    ): Promise<RealtimeExecutionOpenOutcome> {
      const receipt = await service.createExecution(
        {
          applicationId: input.applicationId,
          environmentId: input.environmentId,
          task: input.task,
          ...(input.inputArtifactRefs === undefined
            ? {}
            : { inputArtifactRefs: input.inputArtifactRefs }),
          ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
          ...(input.userId === undefined ? {} : { userId: input.userId }),
        },
        idempotencyKey,
        { actorId: input.actorId, tenantId: input.tenantId },
      );
      return {
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        status: receipt.status,
      };
    },

    async recordEvidence(
      input: RealtimeEvidenceInput,
      idempotencyKey: string,
    ): Promise<RealtimeEvidenceOutcome> {
      const command = CLASS_TO_COMMAND[input.evidenceClass];
      if (command === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `unknown realtime evidence class ${String(input.evidenceClass)}`,
        });
      }
      const outcome = await service.recordStepEvent(
        {
          executionId: input.executionId,
          applicationId: input.applicationId,
          actor: { actorId: input.actorId, tenantId: input.tenantId },
          command,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          payload: input.payload,
        },
        idempotencyKey,
      );
      return { sequence: outcome.sequence, type: outcome.type, replayed: outcome.replayed };
    },

    async readExecution(applicationId: string, executionId: string) {
      const record = await service.getExecution(applicationId, executionId);
      if (record === null) {
        return null;
      }
      return { id: record.id, tenantId: record.tenantId, status: record.status };
    },

    async awaitHuman(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "wait-human",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },

    async continueAfterHuman(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "resume",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },
  };
}
