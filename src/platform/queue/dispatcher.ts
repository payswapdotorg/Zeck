/**
 * Durable dispatcher (WORK-044 / D-03) — the dispatch handoff
 * implementation.
 *
 * THE HANDOFF SEQUENCE (the order IS the guarantee):
 *
 *   1. `recordIntent` — the authoritative PostgreSQL correlation record
 *      commits FIRST (durable intent before any external effect);
 *   2. `publish` — only then is the message handed to the transport,
 *      within the bounded publish budget;
 *   3. the observed outcome is recorded (`markPublishAccepted` /
 *      `recordPublishFailure`) — transport progress evidence.
 *
 * A crash between 1 and 2 leaves the envelope at `recorded` — honest
 * evidence of an unknown external outcome; `republishPending` recovers
 * it deterministically from PostgreSQL authority (never from provider
 * state). A crash between 2 and 3 is healed by delivery itself: the
 * consumer adopts a genuine delivery as publication proof.
 *
 * Provider outages never create a second authority and never report
 * success: publish failures are typed, bounded and land in `backlogged`
 * (recoverable) or `dead-lettered` (permanent rejection) — the
 * authoritative execution state is untouched either way.
 *
 * Replay (`replayDispatch`) is the BOUNDED re-entry: it creates a NEW
 * envelope on the same root lineage (original provenance retained by
 * reference; correlation identity preserved in the key), re-publishes,
 * and lets consumption re-enter the EXISTING governed execution path
 * — every admission gate (policy, budget, capability, state legality,
 * verification) runs again because the effect goes through the same
 * single write path. A replay request is never an authorization grant:
 * the governed path can still reject it (and that rejection dead-letters
 * explicitly).
 */
import { payloadDigestOf, type QueueCorrelationStore } from "./correlation";
import {
  backoffDelayMs,
  type DispatchEnvelope,
  type ExecutionDispatchPayload,
  executionDispatchCorrelationKey,
  type QueueRetryPolicy,
  QueueTransportError,
  type QueueTransportPort,
} from "./port";

export interface DurableDispatcherDeps {
  readonly store: QueueCorrelationStore;
  readonly transport: QueueTransportPort;
  readonly policy: QueueRetryPolicy;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** Sleep seam (tests substitute a no-op; deterministic backoff). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ExecutionDispatchRequest {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface DispatchOutcome {
  readonly envelope: DispatchEnvelope;
  /** True when a previous identical dispatch's durable record replayed. */
  readonly replayedIntent: boolean;
  /** True when this call's publication was accepted by the provider. */
  readonly published: boolean;
  readonly publishAttempts: number;
}

/** Refused replay (bounded budget exhausted or invalid target). */
export class ReplayRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRejectedError";
  }
}

const CONTENT_TYPE = "application/json";

export class DurableDispatcher {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: DurableDispatcherDeps) {
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Durable dispatch of one execution onto the transport. Idempotent
   * by the deterministic correlation key: a repeated request replays
   * the existing durable record and republishes only when the envelope
   * is still in a publishable state (recorded/backlogged).
   */
  async dispatchExecution(request: ExecutionDispatchRequest): Promise<DispatchOutcome> {
    const correlationKey = executionDispatchCorrelationKey(request.executionId);
    const payload: ExecutionDispatchPayload = {
      v: 1,
      correlationKey,
      purpose: "execution-dispatch",
      executionId: request.executionId,
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      dispatchedAt: this.deps.now().toISOString(),
    };
    // 1. The authoritative correlation record FIRST.
    const intent = await this.deps.store.recordIntent({
      id: this.deps.generateId(),
      correlationKey,
      purpose: "execution-dispatch",
      tenantId: request.tenantId,
      applicationId: request.applicationId,
      executionId: request.executionId,
      payload,
      payloadDigest: payloadDigestOf(payload),
      replayOf: null,
    });
    // 2. Publish only from a publishable state (never a terminal one).
    if (intent.envelope.state === "recorded" || intent.envelope.state === "backlogged") {
      const published = await this.publishWithinBudget(intent.envelope);
      return {
        envelope: published.envelope,
        replayedIntent: !intent.created,
        published: published.accepted,
        publishAttempts: published.envelope.publishAttempts,
      };
    }
    return {
      envelope: intent.envelope,
      replayedIntent: !intent.created,
      published: false,
      publishAttempts: intent.envelope.publishAttempts,
    };
  }

  /**
   * Crash/outage recovery: republish every envelope whose durable
   * intent exists but whose publication never succeeded. Recovery
   * reads PostgreSQL authority only — the provider's state is never
   * consulted for what SHOULD exist.
   */
  async republishPending(limit: number): Promise<readonly DispatchOutcome[]> {
    const pending = await this.deps.store.republishable(limit);
    const outcomes: DispatchOutcome[] = [];
    for (const envelope of pending) {
      const published = await this.publishWithinBudget(envelope);
      outcomes.push({
        envelope: published.envelope,
        replayedIntent: true,
        published: published.accepted,
        publishAttempts: published.envelope.publishAttempts,
      });
    }
    return outcomes;
  }

  /**
   * Bounded replay of a dead-lettered (or failed) dispatch: creates a
   * NEW envelope on the same root lineage — original provenance and
   * correlation identity are preserved (root reference + ordinal in
   * the key), the budget is enforced against the ROOT lineage, and
   * consumption re-enters the governed execution path with every
   * admission gate intact. Repeated invocation is idempotent: at
   * most ONE outstanding (non-terminal) replay exists per root — while
   * a replay is still recorded/published/backlogged, a repeated
   * request replays THAT durable record instead of advancing the
   * lineage (a double-invoked tool cannot burn the replay budget).
   */
  async replayDispatch(rootEnvelopeId: string): Promise<DispatchOutcome> {
    const rootEnvelope = await this.deps.store.findById(rootEnvelopeId);
    if (rootEnvelope === null) {
      throw new ReplayRejectedError(`envelope ${rootEnvelopeId} does not exist`);
    }
    // The lineage root: replays always reference the ROOT, so one hop
    // at most (chains are unrepresentable by the physical schema).
    const rootId = rootEnvelope.replayOf ?? rootEnvelope.id;
    const root =
      rootEnvelope.replayOf === null ? rootEnvelope : await this.deps.store.findById(rootId);
    if (root === null) {
      throw new ReplayRejectedError(`root envelope ${rootId} does not exist`);
    }
    if (root.state === "recorded" || root.state === "published" || root.state === "backlogged") {
      throw new ReplayRejectedError(
        `replay targets a non-terminal transport state (${root.state}); replay re-enters dead-lettered dispatches only`,
      );
    }
    const replays = await this.deps.store.listReplays(rootId);
    const outstanding = replays.find(
      (envelope) =>
        envelope.state === "recorded" ||
        envelope.state === "published" ||
        envelope.state === "backlogged",
    );
    if (outstanding !== undefined) {
      // Idempotent re-invocation: the outstanding replay IS the
      // answer; publish it only from a publishable state.
      if (outstanding.state === "recorded" || outstanding.state === "backlogged") {
        const published = await this.publishWithinBudget(outstanding);
        return {
          envelope: published.envelope,
          replayedIntent: true,
          published: published.accepted,
          publishAttempts: published.envelope.publishAttempts,
        };
      }
      return {
        envelope: outstanding,
        replayedIntent: true,
        published: false,
        publishAttempts: outstanding.publishAttempts,
      };
    }
    if (replays.length >= this.deps.policy.maxReplays) {
      throw new ReplayRejectedError(
        `replay budget exhausted for root ${rootId} (${replays.length}/${this.deps.policy.maxReplays})`,
      );
    }
    const ordinal = replays.length + 1;
    const correlationKey = executionDispatchCorrelationKey(root.executionId, {
      replayOrdinal: ordinal,
    });
    // The replay payload preserves the original provenance (same
    // execution/application/tenant binding); the lineage reference and
    // the ordinal in the correlation key retain correlation identity.
    const payload: ExecutionDispatchPayload = {
      v: 1,
      correlationKey,
      purpose: "execution-dispatch",
      executionId: root.executionId,
      applicationId: root.applicationId,
      tenantId: root.tenantId,
      dispatchedAt: this.deps.now().toISOString(),
    };
    const intent = await this.deps.store.recordIntent({
      id: this.deps.generateId(),
      correlationKey,
      purpose: "execution-dispatch",
      tenantId: root.tenantId,
      applicationId: root.applicationId,
      executionId: root.executionId,
      payload,
      payloadDigest: payloadDigestOf(payload),
      replayOf: rootId,
    });
    if (intent.envelope.state === "recorded" || intent.envelope.state === "backlogged") {
      const published = await this.publishWithinBudget(intent.envelope);
      return {
        envelope: published.envelope,
        replayedIntent: !intent.created,
        published: published.accepted,
        publishAttempts: published.envelope.publishAttempts,
      };
    }
    return {
      envelope: intent.envelope,
      replayedIntent: !intent.created,
      published: false,
      publishAttempts: intent.envelope.publishAttempts,
    };
  }

  /**
   * Publish within the bounded budget. Every attempt and outcome is
   * durable evidence; exhaustion lands in `backlogged` (transient) or
   * `dead-lettered` (permanent) — never a silent success, never an
   * unbounded loop.
   *
   * The budget is PER INVOCATION (this dispatch call / this recovery
   * call): the loop below runs at most `maxPublishAttempts` wire
   * attempts, then stops — recovery happens only through an EXPLICIT
   * operator/tool invocation (`republishPending`), never through a
   * hidden automatic loop. Attempt numbers are monotonic across
   * cycles (the envelope counter is the durable total).
   */
  private async publishWithinBudget(
    envelope: DispatchEnvelope,
  ): Promise<{ accepted: boolean; envelope: DispatchEnvelope }> {
    let current = envelope;
    const startAttempt = Math.max(1, current.publishAttempts + 1);
    for (let i = 0; i < this.deps.policy.maxPublishAttempts; i++) {
      const attempt = startAttempt + i;
      try {
        await this.deps.transport.publish({
          body: JSON.stringify(current.payload),
          contentType: CONTENT_TYPE,
        });
        current = await this.deps.store.markPublishAccepted(current.id, {
          stage: "publish",
          attemptNo: attempt,
          outcome: "accepted",
          detail: null,
        });
        return { accepted: true, envelope: current };
      } catch (error) {
        if (!(error instanceof QueueTransportError)) {
          // Unexpected errors are never swallowed: they propagate
          // fail-closed (the envelope stays recorded — recoverable).
          throw error;
        }
        const outcome =
          error.failureKind === "transient" ? "transient-failure" : "permanent-failure";
        current = await this.deps.store.recordPublishFailure(
          current.id,
          {
            stage: "publish",
            attemptNo: attempt,
            outcome,
            detail: error.message.slice(0, 200),
          },
          this.deps.policy,
        );
        if (current.state === "dead-lettered") {
          return { accepted: false, envelope: current };
        }
        if (i + 1 < this.deps.policy.maxPublishAttempts) {
          await this.sleep(backoffDelayMs(this.deps.policy, i + 2));
        }
      }
    }
    return { accepted: false, envelope: current };
  }
}

/** Convenience factory matching the module conventions. */
export function createDurableDispatcher(deps: DurableDispatcherDeps): DurableDispatcher {
  return new DurableDispatcher(deps);
}
