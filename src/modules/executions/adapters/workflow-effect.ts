/**
 * Orchestration resolution effect adapter (executions module;
 * WORK-045 / D-04) — the single integration point between the
 * durable orchestration engine and the execution authority.
 *
 * Implements the platform's provider-neutral
 * `GovernedOrchestrationEffect` seam by re-entering the EXISTING
 * governed execution write path — `ExecutionService.transition` —
 * the one and only status mutation of the executions state machine.
 * Every admission gate runs again on this path exactly as it does
 * for every other transition: state legality (WAITING_* -> RUNNING
 * via `resume`; WAITING_* -> CANCELLED via `cancel`; any
 * non-terminal -> EXPIRED via `expire`), policy admission seams,
 * and the module's idempotency arbitration. The state machine
 * arbitrates everything — orchestration NEVER widens authority.
 *
 * The resolution cause decides the frozen command (domain knowledge;
 * the platform plane never sees execution commands):
 *
 *   callback          -> resume  (the notified wait resolves)
 *   approval approve  -> resume  (the human gate passes)
 *   approval reject   -> cancel  (the human gate refuses — governed
 *                        termination through the frozen `cancel`
 *                        command, never a bypass)
 *   deadline          -> expire  (the bounded wait elapses)
 *
 * IDEMPOTENCE (the duplicate/convergence contract): the engine hands
 * the DETERMINISTIC effect key (derived from the wait identity).
 * The executions idempotency arbitration makes a repeated handoff
 * with the same key + same command replay the SAME durable outcome —
 * duplicate notifications, crash-after-mutation, restart recovery
 * and provider retries all converge to exactly one authoritative
 * effect.
 *
 * This adapter never bypasses a gate and never widens authority:
 * rejections from the governed path are surfaced as explicit
 * outcomes (the engine records superseded/abandoned waits with the
 * reason — retrying a governed refusal cannot change the decision);
 * unexpected/transient errors propagate for the engine's bounded
 * effect budget. It imports platform types only (the
 * module-adapter-bridges-to-platform pattern).
 */
import type {
  GovernedOrchestrationEffect,
  GovernedResolutionOutcome,
  GovernedWaitResolution,
} from "../../../platform/workflow/port";
import { PlatformError } from "../../../shared/errors";
import type { ExecutionService } from "../application/execution-service";

/**
 * Governed-path decision codes surfaced as permanent rejections (the
 * path itself said NO — retrying cannot change the decision). Codes
 * outside this set propagate as transient (bounded retry).
 */
const GOVERNED_REJECTION_CODES: ReadonlySet<string> = new Set([
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "INVALID_STATE_TRANSITION",
  "AUTHORIZATION_DENIED",
  "TENANT_SCOPE_VIOLATION",
  "IDEMPOTENCY_KEY_REUSED",
  "EXPIRED",
]);

/**
 * The decision codes meaning "the execution already progressed by
 * another governed path" — the wait is stale, not failed (superseded
 * rather than abandoned). Domain-side classification: the platform
 * plane never interprets governed rejection codes.
 */
const MOVED_ON_CODES: ReadonlySet<string> = new Set(["INVALID_STATE_TRANSITION", "EXPIRED"]);

/** The resolution cause -> frozen execution command mapping. */
function commandForResolution(resolution: GovernedWaitResolution): "resume" | "cancel" | "expire" {
  switch (resolution.cause.kind) {
    case "callback":
      return "resume";
    case "approval":
      return resolution.cause.decision === "approve" ? "resume" : "cancel";
    case "deadline":
      return "expire";
  }
}

/** The provenance reason recorded on every governed transition. */
function reasonForResolution(resolution: GovernedWaitResolution): string {
  switch (resolution.cause.kind) {
    case "callback":
      return "workflow-orchestration-callback";
    case "approval":
      return `workflow-orchestration-approval-${resolution.cause.decision}`;
    case "deadline":
      return "workflow-orchestration-deadline";
  }
}

export interface WorkflowEffectDeps {
  /** The single governed execution write path (never bypassed). */
  readonly service: ExecutionService;
  /**
   * The orchestrator's actor identity (provenance): recorded on every
   * transition this adapter performs. Must be a UUID.
   */
  readonly orchestratorActorId: string;
}

export class WorkflowEffectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowEffectConfigError";
  }
}

/** Build the governed effect for resolved orchestration waits. */
export function createOrchestrationResolutionEffect(
  deps: WorkflowEffectDeps,
): GovernedOrchestrationEffect {
  const actorId = deps.orchestratorActorId;
  const actorIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!actorIdPattern.test(actorId)) {
    throw new WorkflowEffectConfigError("orchestratorActorId must be a UUID (provenance identity)");
  }
  return {
    async apply(
      resolution: GovernedWaitResolution,
      idempotencyKey: string,
    ): Promise<GovernedResolutionOutcome> {
      const wait = resolution.wait;
      try {
        const outcome = await deps.service.transition(
          {
            command: commandForResolution(resolution),
            actorId,
            applicationId: wait.applicationId,
            tenantId: wait.tenantId,
            executionId: wait.executionId,
            reason: reasonForResolution(resolution),
          },
          idempotencyKey,
        );
        return outcome.replayed
          ? {
              outcome: "already-applied",
              detail: `governed path replayed the durable outcome (${outcome.execution.status})`,
            }
          : { outcome: "applied", detail: `execution is ${outcome.execution.status}` };
      } catch (error) {
        if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
          // The governed path rejected the resolution: a permanent,
          // explicit condition — surfaced as the wait's terminal
          // reason, never retried into an unbounded loop, never
          // bypassed.
          return {
            outcome: "rejected",
            reason: `${error.code}: ${error.message}`,
            movedOn: MOVED_ON_CODES.has(error.code),
          };
        }
        // Transient/unknown failures propagate: the engine's bounded
        // effect budget decides retry vs abandonment.
        throw error;
      }
    },
  };
}
