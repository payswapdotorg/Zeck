/**
 * Transport delivery effect adapter (executions module; WORK-044 /
 * D-03) — the single integration point between the queue transport
 * and the execution authority.
 *
 * Implements the platform's provider-neutral `GovernedDispatchEffect`
 * seam by re-entering the EXISTING governed execution write path:
 * `ExecutionService.transition({ command: "start", ... })` — the one
 * and only status mutation of the executions state machine. Every
 * admission gate runs again on this path exactly as it does for every
 * other transition: state legality (QUEUED → RUNNING here; anything
 * else is `INVALID_STATE_TRANSITION`), policy admission seams, budget
 * reservation when dispatch facts are present, and the module's
 * idempotency arbitration.
 *
 * IDEMPOTENCE (the at-least-once convergence): the consumer hands the
 * DETERMINISTIC consume key (derived from the correlation identity).
 * The executions idempotency arbitration makes a repeated handoff
 * with the same key + same command replay the SAME durable outcome —
 * duplicate delivery, consumer restart, crash-after-mutation-before-
 * ack and ack loss all converge to exactly one authoritative effect.
 *
 * This adapter never bypasses a gate and never widens authority:
 * rejections from the governed path are surfaced as explicit
 * dead-letter reasons; unexpected/transient errors propagate for the
 * transport's bounded retry budget. It imports platform types only
 * (the module-adapter-bridges-to-platform pattern).
 */
import type {
  DispatchEnvelope,
  GovernedDispatchDelivery,
  GovernedDispatchEffect,
  GovernedEffectOutcome,
} from "../../../platform/queue/port";
import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
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

/** Budget reservation facts for the `start` dispatch boundary, when composition supplies them. */
export interface TransportDispatchFacts {
  readonly operationId: string;
  readonly amountMicroUsd: string;
  readonly userId?: string;
}

export interface TransportEffectDeps {
  /** The single governed execution write path (never bypassed). */
  readonly service: ExecutionService;
  /**
   * The consumer's actor identity (provenance): recorded on every
   * transition this adapter performs. Must be a UUID.
   */
  readonly consumerActorId: string;
  /**
   * Optional dispatch-facts provider (composition-wired): derives the
   * budget reservation facts for the `start` boundary from the
   * authoritative envelope record. Absent ⇒ no reservation is
   * attempted (the transition contract's optional dispatch facts) —
   * the same conditional behavior as every other `start` caller.
   */
  readonly dispatchFacts?: (envelope: DispatchEnvelope) => TransportDispatchFacts | undefined;
}

export class TransportEffectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportEffectConfigError";
  }
}

/** Build the governed effect for execution dispatch deliveries. */
export function createExecutionDispatchEffect(deps: TransportEffectDeps): GovernedDispatchEffect {
  if (!isUuid(deps.consumerActorId)) {
    throw new TransportEffectConfigError("consumerActorId must be a UUID (provenance identity)");
  }
  return {
    async apply(
      delivery: GovernedDispatchDelivery,
      idempotencyKey: string,
    ): Promise<GovernedEffectOutcome> {
      const envelope = delivery.envelope;
      const facts = deps.dispatchFacts?.(envelope);
      try {
        const outcome = await deps.service.transition(
          {
            command: "start",
            actorId: deps.consumerActorId,
            applicationId: envelope.applicationId,
            tenantId: envelope.tenantId,
            executionId: envelope.executionId,
            reason: "queue-transport-delivery",
            ...(facts === undefined ? {} : { dispatch: facts }),
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
          // The governed path rejected the delivery: a permanent,
          // explicit condition — surfaced as a dead-letter reason,
          // never retried into an unbounded loop, never bypassed.
          return {
            outcome: "rejected",
            reason: `${error.code}: ${error.message}`,
          };
        }
        // Transient/unknown failures propagate: the transport's
        // bounded delivery budget decides retry vs dead-letter.
        throw error;
      }
    },
  };
}
