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

/**
 * The public transition chain a realtime session's execution walks to
 * RUNNING (a realtime session IS an actively running governed run: its
 * turns dispatch from the RUNNING state and its human-escalation wait
 * (`wait-human`) is legal only from RUNNING). Everything goes through
 * the executions PUBLIC transition-command surface — the deployments
 * module owns none of the lifecycle vocabulary, and each edge is
 * idempotent under a stable per-edge key (concurrent/retried session
 * starts converge on the same durable walk; a replay skips ahead).
 */
const PRE_RUNNING_WALK: ReadonlyArray<{
  readonly from: string;
  readonly command: "authorize" | "plan" | "queue" | "start";
}> = [
  { from: "CREATED", command: "authorize" },
  { from: "AUTHORIZED", command: "plan" },
  { from: "PLANNING", command: "queue" },
  { from: "QUEUED", command: "start" },
];

const WALK_REASON =
  "realtime session mapped execution enters the running lifecycle (executions public transition surface)";

async function ensureRunningExecution(
  service: ExecutionService,
  scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly executionId: string;
  },
  idempotencyKey: string,
): Promise<string> {
  // Bounded walk: each iteration applies at most one missing pre-running
  // edge (idempotent by `${idempotencyKey}:${command}`); the loop
  // re-reads the durable status, so concurrent walkers converge instead
  // of double-stepping.
  for (let step = 0; step <= PRE_RUNNING_WALK.length * 2; step += 1) {
    const record = await service.getExecution(scope.applicationId, scope.executionId);
    if (record === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "execution row disappeared after create (rows are never deleted)",
      });
    }
    if (record.tenantId !== scope.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId: scope.executionId },
      });
    }
    const edge = PRE_RUNNING_WALK.find((candidate) => candidate.from === record.status);
    if (edge === undefined) {
      // RUNNING or beyond (a human-escalation wait, or terminal): the
      // walk is complete — the execution is live.
      return record.status;
    }
    await service.transition(
      {
        command: edge.command,
        actorId: scope.actorId,
        applicationId: scope.applicationId,
        tenantId: scope.tenantId,
        executionId: scope.executionId,
        reason: WALK_REASON,
      },
      `${idempotencyKey}:${edge.command}`,
    );
  }
  throw new PlatformError({
    code: "PROVIDER_ERROR",
    message: "the mapped execution did not converge on the running lifecycle",
    details: { executionId: scope.executionId },
  });
}

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
      // A realtime session IS a running governed run: walk the public
      // lifecycle to RUNNING (idempotent; converges on replays).
      const status = await ensureRunningExecution(
        service,
        {
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          executionId: receipt.executionId,
        },
        idempotencyKey,
      );
      return {
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        status,
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
