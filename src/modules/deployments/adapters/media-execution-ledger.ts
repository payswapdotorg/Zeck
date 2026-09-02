/**
 * Media execution-ledger adapter (deployments module; WORK-026).
 *
 * Implements the deployments module's REQUIRED `MediaExecutionLedger`
 * port against the REAL executions module public service — the
 * WORK-010/011/024/025 ledger-adapter discipline applied to media
 * generation jobs:
 *
 *   - media jobs are established through the executions public create
 *     seam (idempotent by key: a retried job submission converges on
 *     the SAME execution identity — a second authoritative execution
 *     is unrepresentable);
 *   - media provenance (job submission, paid dispatch, provider
 *     observations, verification outcomes, artifact adoptions,
 *     cancellations, retries, failures, completion) rides the
 *     canonical executions EventEnvelope ledger as STEP EVENTS
 *     through the executions-owned agent-session vocabulary
 *     ("agent-session-started" / "agent-action-recorded" /
 *     "agent-session-completed") — the semantic detail (evidence
 *     class, generation kind, artifact digests, provider refs) rides
 *     the payload/reference fields; the deployments module owns NONE
 *     of the event vocabulary;
 *   - the media job's execution lifecycle moves ONLY through the
 *     public transition-command surface: `verify` (RUNNING →
 *     VERIFYING) at the verification boundary, `pass`
 *     (VERIFYING → COMPLETED) on completion, `fail`
 *     (RUNNING/VERIFYING → FAILED) on failure or verification
 *     rejection, `cancel` on job cancellation — each idempotent
 *     under a stable per-edge key (concurrent/retried invocations
 *     converge; a replay skips ahead);
 *   - execution facts come from the tenant-guarded public read.
 *
 * The deployments module never writes the executions tables directly
 * (a second event authority is unrepresentable). Type + runtime
 * coupling is to the executions PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionService, StepEventCommand } from "../../executions/public";
import type {
  MediaEvidenceClass,
  MediaEvidenceInput,
  MediaEvidenceOutcome,
  MediaExecutionLedger,
  MediaExecutionOpenInput,
  MediaExecutionOpenOutcome,
} from "../ports/media-execution-ledger";

/** The executions-owned step-event vocabulary this producer rides. */
const CLASS_TO_COMMAND: Readonly<Record<MediaEvidenceClass, StepEventCommand>> = {
  "job-submitted": "agent-session-started",
  "job-dispatched": "agent-action-recorded",
  observation: "agent-action-recorded",
  verification: "agent-action-recorded",
  artifact: "agent-action-recorded",
  cancellation: "agent-action-recorded",
  failure: "agent-action-recorded",
  "significant-action": "agent-action-recorded",
  "job-completed": "agent-session-completed",
};

/**
 * The public transition chain a media job's execution walks to
 * RUNNING (a media job IS an actively running governed run: its paid
 * dispatch happens from the RUNNING state and its verification
 * boundary (`verify`) is legal only from RUNNING). Everything goes
 * through the executions PUBLIC transition-command surface — the
 * deployments module owns none of the lifecycle vocabulary, and each
 * edge is idempotent under a stable per-edge key.
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
  "media generation job mapped execution enters the running lifecycle (executions public transition surface)";

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
  // Bounded walk: each iteration applies at most one missing
  // pre-running edge (idempotent by `${idempotencyKey}:${command}`);
  // the loop re-reads the durable status, so concurrent walkers
  // converge instead of double-stepping.
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
      // RUNNING or beyond (verification, or terminal): the walk is
      // complete — the execution is live or already moved on.
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

export function createMediaExecutionLedgerAdapter(service: ExecutionService): MediaExecutionLedger {
  return {
    async openExecution(
      input: MediaExecutionOpenInput,
      idempotencyKey: string,
    ): Promise<MediaExecutionOpenOutcome> {
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
      // A media job IS a running governed run: walk the public
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
      input: MediaEvidenceInput,
      idempotencyKey: string,
    ): Promise<MediaEvidenceOutcome> {
      const command = CLASS_TO_COMMAND[input.evidenceClass];
      if (command === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `unknown media evidence class ${String(input.evidenceClass)}`,
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

    async enterVerification(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "verify",
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

    async completeExecution(input, idempotencyKey) {
      // The executions authority's PHYSICAL completion discipline: a
      // `pass` must carry at least one PASS verification result — the
      // media fabric's deterministic postprocessing PASS or the
      // verification authority's PASS verdict. No provider-success
      // shortcut exists at this seam (or beyond it).
      const outcome = await service.transition(
        {
          command: "pass",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
          verificationResults: input.verificationResults.map((result) => ({
            criterionId: result.criterionId,
            strategy: result.strategy,
            status: result.status,
            ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
            recordedBy: result.recordedBy,
          })),
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },

    async failExecution(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "fail",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
          ...(input.verificationResults === undefined
            ? {}
            : {
                verificationResults: input.verificationResults.map((result) => ({
                  criterionId: result.criterionId,
                  strategy: result.strategy,
                  status: result.status,
                  ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
                  recordedBy: result.recordedBy,
                })),
              }),
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },

    async cancelExecution(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "cancel",
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
