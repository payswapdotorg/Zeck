/**
 * Durable orchestration coordinator (WORK-045 / D-04) — the engine
 * that drives provider-neutral durable waits end to end.
 *
 * THE RESOLUTION SEQUENCE (the order IS the guarantee):
 *
 *   1. the authoritative PostgreSQL wait record commits FIRST
 *      (correlation-before-reliance: no provider instance is ever
 *      created or relied upon without its durable anchor);
 *   2. the provider instance starts (bounded) — the wait is ARMED
 *      and survives process and provider-worker restarts;
 *   3. a resolution notification (callback / approval / deadline)
 *      is recorded durably FIRST (dedup by its deterministic key,
 *      first resolution wins — physically one accepted notification
 *      per wait), the wait moves to `signaled`;
 *   4. the GOVERNED EFFECT re-enters the existing execution write
 *      path through the `GovernedOrchestrationEffect` seam (every
 *      admission gate intact; idempotent by the deterministic
 *      effect key) — only then does the wait become terminal
 *      (`settled` / `elapsed`);
 *   5. the provider instance is signaled LAST (a transport fact —
 *      the authoritative effect already happened; a crash here is
 *      healed by the recovery scan, never by an authority claim).
 *
 * Crash safety: a crash at any boundary leaves the honest durable
 * state (`recorded`, `deferred`, `armed`, `signaled`) and the
 * recovery scans (`recoverPending`, `applyDueDeadlines`,
 * `reconcileStaleWaits`) converge from PostgreSQL authority only —
 * provider state is never consulted for what SHOULD exist.
 *
 * Provider outage degrades orchestration without fabricating
 * progress: instance starts exhaust into `deferred` (the declared
 * orchestration-paused mode); signal deliveries retry within their
 * bounded budget and stop; provider-reported instance failures
 * abandon the WAIT (bounded replacement available) while the
 * authoritative execution state is untouched.
 *
 * Bounded by construction: start/signal/effect budgets are
 * per-invocation with monotonic durable counters; replacements are
 * lineage-budgeted; retained notifications fold into the durable
 * counter. No unbounded orchestration loop exists anywhere.
 */
import { payloadDigestOf, type WorkflowCorrelationStore } from "./correlation";
import {
  backoffDelayMs,
  canonicalPayloadJson,
  type GovernedOrchestrationEffect,
  type GovernedResolutionOutcome,
  type GovernedWaitResolution,
  type OrchestrationCandidate,
  type OrchestrationPointerPayload,
  type OrchestrationWait,
  orchestrationWaitKey,
  SIGNAL_EVENT_TYPES,
  type WaitingExecutionSource,
  WorkflowConfigError,
  type WorkflowOrchestrationPort,
  type WorkflowRetryPolicy,
  type WorkflowStateBounds,
  WorkflowTransportError,
  waitEffectIdempotencyKey,
} from "./port";

export interface OrchestrationCoordinatorDeps {
  readonly store: WorkflowCorrelationStore;
  readonly workflow: WorkflowOrchestrationPort;
  /** The governed re-entry into the single execution write path. */
  readonly effect: GovernedOrchestrationEffect;
  /** The authoritative waiting-execution scan (executions module adapter). */
  readonly source: WaitingExecutionSource;
  readonly policy: WorkflowRetryPolicy;
  readonly bounds: WorkflowStateBounds;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** Sleep seam (tests substitute a no-op; deterministic backoff). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A typed intake refusal — the notification never touched authority. */
export class UnbackedNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbackedNotificationError";
  }
}

/** The claimed tenant/application scope does not match the wait. */
export class NotificationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationScopeError";
  }
}

/** The wait already resolved (or was superseded/abandoned). */
export class StaleNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleNotificationError";
  }
}

/** A conflicting approval decision after the first was recorded. */
export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalConflictError";
  }
}

/** The intake payload exceeds the reference-only byte bound. */
export class OversizedNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OversizedNotificationError";
  }
}

/** A bounded replacement was refused (budget exhausted / bad target). */
export class ReplacementRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplacementRejectedError";
  }
}

export interface NotifyCallbackInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The stable logical identity of this callback (dedup key). */
  readonly notificationKey: string;
  /** The callback payload (only its sha256 digest is ever stored). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RecordApprovalInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The human approver identity (recorded on the durable notification). */
  readonly approverId: string;
  readonly decision: "approve" | "reject";
  /** The stable logical identity of this approval decision (dedup key). */
  readonly notificationKey: string;
}

export interface IntakeOutcome {
  readonly waitKey: string;
  readonly state: OrchestrationWait["state"];
  /** True when a prior identical delivery's durable outcome replayed. */
  readonly replayed: boolean;
  /** The governed effect's terminal outcome, when reached. */
  readonly effect: "applied" | "already-applied" | "rejected" | null;
  /** Whether the provider instance was signaled in this invocation. */
  readonly providerSignaled: boolean;
}

export interface ArmOutcome {
  readonly wait: OrchestrationWait;
  /** False when a prior identical arm's durable record replayed. */
  readonly created: boolean;
  /** True when this invocation started the provider instance. */
  readonly started: boolean;
}

export interface RecoveryReport {
  readonly startsDriven: number;
  readonly effectsApplied: number;
  readonly signalsDelivered: number;
  readonly staleSuperseded: number;
}

export interface CompactionReport {
  readonly instancesTerminated: number;
  readonly foldedNotifications: number;
  readonly skipped: number;
}

/** The pseudo notification key used for engine-generated deadline signals. */
const DEADLINE_SIGNAL_KEY = "deadline";

export class OrchestrationCoordinator {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: OrchestrationCoordinatorDeps) {
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * The arm scan: reconcile authoritative waiting executions against
   * the durable wait records and arm every un-orchestrated wait
   * (correlation-before-reliance). Idempotent; bounded replacement
   * budget honored; executions whose wait lineage exhausted its
   * budget are skipped (surfaced by inspection — never an unbounded
   * re-arm loop).
   */
  async armWaitingExecutions(limit: number): Promise<readonly ArmOutcome[]> {
    const candidates = await this.deps.source.listOrchestrationCandidates(limit);
    const outcomes: ArmOutcome[] = [];
    for (const candidate of candidates) {
      const live = await this.deps.store.findLiveWait(candidate.executionId, candidate.waitKind);
      if (live !== null) {
        // Already orchestrated. A recorded/deferred wait is re-driven
        // by recovery, not re-armed here (no hidden loops).
        continue;
      }
      const outcome = await this.armCandidate(candidate);
      if (outcome !== null) {
        outcomes.push(outcome);
      }
    }
    return outcomes;
  }

  /** Arm one candidate (private: computes the lineage ordinal). */
  private async armCandidate(candidate: OrchestrationCandidate): Promise<ArmOutcome | null> {
    const prior = await this.deps.store.listWaitsByExecution(candidate.executionId);
    const mine = prior.filter((wait) => wait.waitKind === candidate.waitKind);
    if (mine.length === 0) {
      return this.armNewWait(candidate, 0, null);
    }
    // Only terminal waits can be replaced (a live wait would have been
    // found above; defense in depth against mid-scan races).
    const anyLive = mine.some((wait) => !isTerminalWaitState(wait));
    if (anyLive) {
      return null;
    }
    const root = mine.find((wait) => wait.waitOrdinal === 0) ?? mine[0];
    if (root === undefined) {
      return null;
    }
    const replacements = mine.filter((wait) => wait.waitOrdinal > 0).length;
    if (replacements >= this.deps.policy.maxReplacements) {
      // Bounded lineage: the budget is exhausted; inspection surfaces
      // the stuck condition. Never an unbounded re-arm loop.
      return null;
    }
    return this.armNewWait(candidate, replacements + 1, root.id);
  }

  private async armNewWait(
    candidate: OrchestrationCandidate,
    ordinal: number,
    replacementOf: string | null,
  ): Promise<ArmOutcome> {
    const waitKey = orchestrationWaitKey(candidate.executionId, candidate.waitKind, ordinal);
    const pointer = this.pointerPayloadOf(candidate, waitKey);
    this.enforcePayloadBound(canonicalPayloadJson(pointer), "pointer payload");
    const intent = await this.deps.store.recordWaitIntent({
      id: this.deps.generateId(),
      waitKey,
      tenantId: candidate.tenantId,
      applicationId: candidate.applicationId,
      executionId: candidate.executionId,
      waitKind: candidate.waitKind,
      waitOrdinal: ordinal,
      replacementOf,
      pointerPayload: pointer,
      payloadDigest: payloadDigestOf(pointer),
      deadline: candidate.deadline,
    });
    // Start the instance only from a startable state (never terminal).
    if (intent.wait.state === "recorded" || intent.wait.state === "deferred") {
      const started = await this.startInstanceWithinBudget(intent.wait);
      return { wait: started.wait, created: intent.created, started: started.started };
    }
    return { wait: intent.wait, created: intent.created, started: false };
  }

  /**
   * External callback intake. Resolves the authoritative wait from
   * PostgreSQL FIRST (unbacked claims are refused fail-closed with
   * zero effects), records the notification durably, applies the
   * governed effect, then signals the provider instance. A duplicate
   * delivery (same notification key) converges through the same
   * idempotent path — exactly one authoritative effect ever applies.
   */
  async notifyCallback(input: NotifyCallbackInput): Promise<IntakeOutcome> {
    this.enforceIntakePayloadBound(canonicalPayloadJson(input.payload));
    const wait = await this.resolveLiveWait(input, "callback");
    await this.deps.store.recordNotification(
      {
        waitId: wait.id,
        notificationKey: input.notificationKey,
        kind: "callback",
        decision: null,
        approverId: null,
        payloadDigest: payloadDigestOf(input.payload),
        outcome: "accepted",
        detail: null,
      },
      this.deps.bounds,
    );
    return this.resolveWait(wait, {
      kind: "callback",
      notificationKey: input.notificationKey,
    });
  }

  /**
   * Human approval intake. The decision is durable, tenant-scoped and
   * attributable (the approver identity is recorded on the durable
   * notification); a conflicting later decision is refused — the
   * first decision is authoritative. Approve resumes the execution
   * through the governed path; reject cancels it through the same
   * single write path.
   */
  async recordApproval(input: RecordApprovalInput): Promise<IntakeOutcome> {
    if (input.approverId.trim().length === 0) {
      throw new WorkflowConfigError("approverId is required (approval attribution)");
    }
    // Resolve the wait in ANY state: scope and conflict arbitration
    // precede the live-state stale refusal (a conflicting decision is
    // refused even after the wait settled — the first durable
    // decision can never be displaced).
    const waits = await this.deps.store.listWaitsByExecution(input.executionId);
    const wait = [...waits].reverse().find((w) => w.waitKind === "approval");
    if (wait === undefined) {
      throw new UnbackedNotificationError(
        `no live approval wait exists for execution ${input.executionId} (unbacked notification — refused with zero effects)`,
      );
    }
    if (wait.tenantId !== input.tenantId || wait.applicationId !== input.applicationId) {
      if (!isTerminalWaitState(wait)) {
        await this.deps.store.recordNotification(
          {
            waitId: wait.id,
            notificationKey: `scope-violation:${this.deps.generateId()}`,
            kind: "approval",
            decision: null,
            approverId: null,
            payloadDigest: payloadDigestOf({ refused: "scope" }),
            outcome: "refused-scope",
            detail: "claimed tenant/application does not match the authoritative wait",
          },
          this.deps.bounds,
        );
      }
      throw new NotificationScopeError(
        "notification scope does not match the authoritative wait (tenant isolation)",
      );
    }
    // Conflict arbitration: the first accepted decision is durable
    // and cannot be displaced (evidence only while the wait is live).
    const accepted = await this.deps.store.findAcceptedNotification(wait.id);
    if (accepted !== null && accepted.decision !== null && accepted.decision !== input.decision) {
      let folded = false;
      if (!isTerminalWaitState(wait)) {
        const recorded = await this.deps.store.recordNotification(
          {
            waitId: wait.id,
            notificationKey: input.notificationKey,
            kind: "approval",
            decision: input.decision,
            approverId: input.approverId,
            payloadDigest: payloadDigestOf({ decision: input.decision }),
            outcome: "refused-conflict",
            detail: `conflicts with the first durable decision (${accepted.decision})`,
          },
          this.deps.bounds,
        );
        folded = recorded.folded;
      }
      throw new ApprovalConflictError(
        folded
          ? `approval decision conflicts with the first durable decision (${accepted.decision}); the conflict was folded into the bounded counter`
          : `approval decision conflicts with the first durable decision (${accepted.decision})`,
      );
    }
    if (wait.state !== "armed") {
      throw new StaleNotificationError(
        `wait ${wait.waitKey} is ${wait.state} (already resolved or superseded — the notification is late)`,
      );
    }
    await this.deps.store.recordNotification(
      {
        waitId: wait.id,
        notificationKey: input.notificationKey,
        kind: "approval",
        decision: input.decision,
        approverId: input.approverId,
        payloadDigest: payloadDigestOf({ decision: input.decision }),
        outcome: "accepted",
        detail: null,
      },
      this.deps.bounds,
    );
    return this.resolveWait(wait, {
      kind: "approval",
      decision: input.decision,
      approverId: input.approverId,
      notificationKey: input.notificationKey,
    });
  }

  /**
   * Deadline application: armed waits whose authoritative PostgreSQL
   * deadline is due. The governed expiration re-enters the single
   * execution write path; the provider's own clock is NEVER the
   * authority for expiry.
   */
  async applyDueDeadlines(limit: number): Promise<readonly IntakeOutcome[]> {
    const nowIso = this.deps.now().toISOString();
    const due = await this.deps.store.dueDeadlineWaits(nowIso, limit);
    const outcomes: IntakeOutcome[] = [];
    for (const wait of due) {
      const result = await this.applyResolution(wait, { kind: "deadline" });
      if (result !== null) {
        outcomes.push(result);
      }
    }
    return outcomes;
  }

  /**
   * Restart/recovery scan — reads PostgreSQL authority only:
   *   * `recorded`/`deferred` waits: re-drive the bounded instance
   *     start (crash between intent and start; provider outage);
   *   * `signaled` waits: re-apply the pending governed effect
   *     (idempotent convergence through the executions arbitration);
   *   * resolved waits with undelivered provider signals: re-deliver
   *     within the remaining budget;
   *   * waits whose execution is no longer in a governed wait state:
   *     supersede them (stale, never fire).
   */
  async recoverPending(limit: number): Promise<RecoveryReport> {
    let startsDriven = 0;
    let effectsApplied = 0;
    let signalsDelivered = 0;

    for (const wait of await this.deps.store.recoverableStarts(limit)) {
      const outcome = await this.startInstanceWithinBudget(wait);
      if (outcome.started) {
        startsDriven += 1;
      }
    }
    for (const pending of await this.deps.store.signaledPendingEffect(limit)) {
      const outcome = await this.applyResolution(pending.wait, pending.cause);
      if (outcome?.effect === "applied" || outcome?.effect === "already-applied") {
        effectsApplied += 1;
      }
    }
    for (const pending of await this.deps.store.pendingSignalDeliveries(this.deps.policy, limit)) {
      const delivered = await this.deliverResolutionSignal(
        pending.wait,
        pending.cause.kind === "approval"
          ? SIGNAL_EVENT_TYPES.approval
          : SIGNAL_EVENT_TYPES.callback,
        pending.cause,
        pending.cause.notificationKey,
      );
      if (delivered) {
        signalsDelivered += 1;
      }
    }
    const staleSuperseded = await this.reconcileStaleWaits(limit);
    return { startsDriven, effectsApplied, signalsDelivered, staleSuperseded };
  }

  /**
   * Supersede reconciliation: waits (armed/signaled) whose execution
   * is no longer in a governed wait state. Only a POSITIVE
   * not-waiting answer supersedes (the candidate scan is the
   * authoritative read) — a missing entry due to scan limits never
   * supersedes anything.
   */
  async reconcileStaleWaits(limit: number): Promise<number> {
    const candidates = await this.deps.source.listOrchestrationCandidates(limit);
    const waiting = new Set(
      candidates.map((candidate) => `${candidate.executionId}:${candidate.waitKind}`),
    );
    let superseded = 0;
    for (const wait of await this.deps.store.listNonTerminalWaits(limit)) {
      if (wait.state === "recorded" || wait.state === "deferred") {
        // Never supersedable before arming — the intent is honest
        // recovery work, not staleness.
        continue;
      }
      if (waiting.has(`${wait.executionId}:${wait.waitKind}`)) {
        continue;
      }
      await this.deps.store.markSuperseded(wait.id, null);
      superseded += 1;
    }
    return superseded;
  }

  /**
   * Observe provider instances (evidence only). A provider report
   * that the instance errored or was terminated abandons the WAIT —
   * the authoritative execution state is untouched, and the bounded
   * replacement path can re-arm it.
   */
  async observeProviderInstances(
    limit: number,
  ): Promise<readonly { wait: OrchestrationWait; observed: string }[]> {
    const observed: { wait: OrchestrationWait; observed: string }[] = [];
    for (const wait of await this.deps.store.listObservables(limit)) {
      if (wait.providerInstanceId === null) {
        continue;
      }
      let observation: Awaited<ReturnType<typeof this.deps.workflow.describeInstance>>;
      try {
        observation = await this.deps.workflow.describeInstance(wait.providerInstanceId);
      } catch (error) {
        if (error instanceof WorkflowTransportError && error.failureKind === "permanent") {
          // The instance is gone provider-side (404-class): record the
          // honest observation evidence, never an authority claim.
          await this.deps.store.recordObservation(wait.id, "unknown", {
            stage: "observe",
            attemptNo: wait.startAttempts + 1,
            outcome: "permanent-failure",
            detail: error.message.slice(0, 200),
          });
          continue;
        }
        throw error;
      }
      const after = await this.deps.store.recordObservation(wait.id, observation.status, {
        stage: "observe",
        attemptNo: wait.startAttempts + 1,
        outcome: "accepted",
        detail: observation.detail,
      });
      observed.push({ wait: after, observed: observation.status });
      if (observation.status === "errored" || observation.status === "terminated") {
        await this.deps.store.markAbandoned(wait.id, `provider-reported-${observation.status}`, {
          stage: "observe",
          attemptNo: wait.startAttempts + 1,
          outcome: "accepted",
          detail: `provider observed the instance ${observation.status}; the wait is bounded-replaceable, the execution authority is untouched`,
        });
      }
    }
    return observed;
  }

  /**
   * Bounded provider-state compaction: terminate the instances of
   * terminal waits (their orchestration outcome is already durable
   * in PostgreSQL; a lingering instance is unbounded provider state).
   * An instance the provider already removed (404-class) counts as
   * compacted. Reports the folded-notification counters (inspectable).
   */
  async compact(limit: number): Promise<CompactionReport> {
    const compactible = await this.deps.store.compactibleWaits(limit);
    let instancesTerminated = 0;
    let skipped = 0;
    for (const wait of compactible) {
      if (wait.providerInstanceId === null) {
        skipped += 1;
        continue;
      }
      try {
        await this.deps.workflow.terminateInstance({
          instanceId: wait.providerInstanceId,
          reason: "zeck-orchestration-compaction",
        });
        await this.deps.store.markProviderTerminated(wait.id, {
          stage: "terminate",
          attemptNo: 1,
          outcome: "accepted",
          detail: null,
        });
        instancesTerminated += 1;
      } catch (error) {
        if (error instanceof WorkflowTransportError && error.failureKind === "permanent") {
          // The instance is already gone (404-class): compacted.
          await this.deps.store.markProviderTerminated(wait.id, {
            stage: "terminate",
            attemptNo: 1,
            outcome: "permanent-failure",
            detail: error.message.slice(0, 200),
          });
          instancesTerminated += 1;
          continue;
        }
        // Transient provider failure: skip — the next compaction run
        // retries (bounded; never a loop inside one invocation).
        skipped += 1;
      }
    }
    const foldedNotifications = compactible.reduce(
      (total, wait) => total + wait.foldedNotifications,
      0,
    );
    return { instancesTerminated, foldedNotifications, skipped };
  }

  /**
   * Explicit bounded replacement of one abandoned wait: a NEW wait
   * on the same lineage (root reference + ordinal in the key), armed
   * from scratch — the governed path decides everything again. The
   * budget is enforced against the ROOT lineage; a double-invoked
   * tool replays the outstanding durable wait instead of advancing.
   */
  async replaceWait(waitId: string): Promise<ArmOutcome> {
    const target = await this.deps.store.findWaitById(waitId);
    if (target === null) {
      throw new ReplacementRejectedError(`orchestration wait ${waitId} does not exist`);
    }
    const rootId = target.replacementOf === null ? target.id : target.replacementOf;
    const root =
      target.replacementOf === null ? target : await this.deps.store.findWaitById(rootId);
    if (root === null) {
      throw new ReplacementRejectedError(`root wait of ${waitId} does not exist`);
    }
    const live = await this.deps.store.findLiveWait(root.executionId, root.waitKind);
    if (live !== null) {
      return { wait: live, created: false, started: false };
    }
    const replacements = await this.deps.store.listReplacements(root.id);
    if (replacements.length >= this.deps.policy.maxReplacements) {
      throw new ReplacementRejectedError(
        `replacement budget exhausted for root ${root.id} (${replacements.length}/${this.deps.policy.maxReplacements})`,
      );
    }
    return this.armNewWait(
      {
        executionId: root.executionId,
        applicationId: root.applicationId,
        tenantId: root.tenantId,
        waitKind: root.waitKind,
        deadline: root.deadline,
        enteredWaitAt: root.createdAt,
      },
      replacements.length + 1,
      root.id,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Resolve the live, in-scope, still-armed wait for an intake claim. */
  private async resolveLiveWait(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly executionId: string;
    },
    kind: "callback" | "approval",
  ): Promise<OrchestrationWait> {
    const wait = await this.deps.store.findLiveWait(input.executionId, kind);
    if (wait === null) {
      // Distinguish a late delivery (the wait resolved already) from a
      // genuinely unbacked claim (no wait ever existed).
      const anyWait = (await this.deps.store.listWaitsByExecution(input.executionId)).find(
        (w) => w.waitKind === kind,
      );
      if (anyWait !== undefined) {
        throw new StaleNotificationError(
          `wait ${anyWait.waitKey} is ${anyWait.state} (already resolved or superseded — the notification is late)`,
        );
      }
      throw new UnbackedNotificationError(
        `no live ${kind} wait exists for execution ${input.executionId} (unbacked notification — refused with zero effects)`,
      );
    }
    if (wait.tenantId !== input.tenantId || wait.applicationId !== input.applicationId) {
      // Forged scope: record the bounded refusal evidence against the
      // real wait, then fail closed.
      await this.deps.store.recordNotification(
        {
          waitId: wait.id,
          notificationKey: `scope-violation:${this.deps.generateId()}`,
          kind,
          decision: null,
          approverId: null,
          payloadDigest: payloadDigestOf({ refused: "scope" }),
          outcome: "refused-scope",
          detail: "claimed tenant/application does not match the authoritative wait",
        },
        this.deps.bounds,
      );
      throw new NotificationScopeError(
        "notification scope does not match the authoritative wait (tenant isolation)",
      );
    }
    if (wait.state !== "armed") {
      // The wait is mid-resolution (signaled) or terminal: record the
      // bounded stale-refusal evidence, then fail closed.
      await this.deps.store.recordNotification(
        {
          waitId: wait.id,
          notificationKey: `stale:${this.deps.generateId()}`,
          kind,
          decision: null,
          approverId: null,
          payloadDigest: payloadDigestOf({ refused: "stale" }),
          outcome: "refused-stale",
          detail: `wait is ${wait.state} (already resolved or superseded)`,
        },
        this.deps.bounds,
      );
      throw new StaleNotificationError(
        `wait ${wait.waitKey} is ${wait.state} (already resolved or superseded — the notification is stale)`,
      );
    }
    return wait;
  }

  /** Apply one recorded resolution end to end (effect → terminal → provider signal). */
  private async resolveWait(
    wait: OrchestrationWait,
    cause: GovernedWaitResolution["cause"],
  ): Promise<IntakeOutcome> {
    const signaled = await this.deps.store.markSignaled(wait.id, {
      stage: "effect",
      attemptNo: 1,
      outcome: "accepted",
      detail: `resolution recorded: ${cause.kind}`,
    });
    return (
      (await this.applyResolution(signaled, cause)) ?? {
        waitKey: wait.waitKey,
        state: signaled.state,
        replayed: false,
        effect: null,
        providerSignaled: false,
      }
    );
  }

  /**
   * Apply the governed effect within the bounded budget and settle
   * the wait (or supersede/abandon it when the governed path says so).
   */
  private async applyResolution(
    wait: OrchestrationWait,
    cause: GovernedWaitResolution["cause"],
  ): Promise<IntakeOutcome | null> {
    const resolution: GovernedWaitResolution = { wait, cause };
    const idempotencyKey = waitEffectIdempotencyKey(wait.waitKey);
    let outcome: GovernedResolutionOutcome | null = null;
    let lastError: unknown = null;
    for (let i = 0; i < this.deps.policy.maxEffectAttempts; i++) {
      try {
        outcome = await this.deps.effect.apply(resolution, idempotencyKey);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (i + 1 < this.deps.policy.maxEffectAttempts) {
          await this.sleep(backoffDelayMs(this.deps.policy, i + 2));
        }
      }
    }
    if (outcome === null) {
      // Transient exhaustion (or an unexpected error the bounded
      // budget could not clear): explicit abandonment, never a
      // silent success, never an infinite loop. Recovery of an
      // abandoned wait is the bounded replacement path.
      await this.deps.store.markAbandoned(wait.id, "effect-exhausted", {
        stage: "effect",
        attemptNo: this.deps.policy.maxEffectAttempts,
        outcome: "transient-failure",
        detail:
          lastError instanceof Error
            ? lastError.message.slice(0, 200)
            : "unknown transient failure",
      });
      return {
        waitKey: wait.waitKey,
        state: "abandoned",
        replayed: false,
        effect: null,
        providerSignaled: false,
      };
    }
    if (outcome.outcome === "rejected") {
      if (outcome.movedOn === true) {
        // The execution moved on by another governed path: this wait
        // is stale, not failed — it never fires.
        await this.deps.store.markSuperseded(wait.id, outcome.reason.slice(0, 200));
        return {
          waitKey: wait.waitKey,
          state: "superseded",
          replayed: false,
          effect: "rejected",
          providerSignaled: false,
        };
      }
      await this.deps.store.markAbandoned(wait.id, "governed-rejection", {
        stage: "effect",
        attemptNo: 1,
        outcome: "permanent-failure",
        detail: outcome.reason.slice(0, 200),
      });
      return {
        waitKey: wait.waitKey,
        state: "abandoned",
        replayed: false,
        effect: "rejected",
        providerSignaled: false,
      };
    }
    // Applied (or replayed as already-applied): the terminal success.
    const alreadyApplied = outcome.outcome === "already-applied";
    const isDeadline = cause.kind === "deadline";
    const after = isDeadline
      ? await this.deps.store.markElapsed(wait.id, idempotencyKey, {
          stage: "effect",
          attemptNo: 1,
          outcome: "accepted",
          detail: outcome.detail ?? null,
        })
      : await this.deps.store.markSettled(wait.id, idempotencyKey, {
          stage: "effect",
          attemptNo: 1,
          outcome: "accepted",
          detail: outcome.detail ?? null,
        });
    // LAST: the provider signal (a transport fact — the authority
    // already moved; a failure here never un-settles the wait).
    const eventType =
      cause.kind === "deadline"
        ? SIGNAL_EVENT_TYPES.deadline
        : cause.kind === "approval"
          ? SIGNAL_EVENT_TYPES.approval
          : SIGNAL_EVENT_TYPES.callback;
    const providerSignaled = await this.deliverResolutionSignal(
      after,
      eventType,
      cause,
      cause.kind === "deadline" ? DEADLINE_SIGNAL_KEY : cause.notificationKey,
    );
    return {
      waitKey: wait.waitKey,
      state: after.state,
      replayed: alreadyApplied,
      effect: alreadyApplied ? "already-applied" : "applied",
      providerSignaled,
    };
  }

  /** Start the provider instance within the bounded budget. */
  private async startInstanceWithinBudget(
    wait: OrchestrationWait,
  ): Promise<{ started: boolean; wait: OrchestrationWait }> {
    let current = wait;
    const startAttempt = Math.max(1, current.startAttempts + 1);
    for (let i = 0; i < this.deps.policy.maxStartAttempts; i++) {
      const attempt = startAttempt + i;
      try {
        const receipt = await this.deps.workflow.startInstance({
          instanceHint: this.instanceHintOf(current),
          params: current.pointerPayload as Record<string, unknown>,
        });
        current = await this.deps.store.markArmed(current.id, receipt.instanceId, {
          stage: "start",
          attemptNo: attempt,
          outcome: "accepted",
          detail: null,
        });
        return { started: true, wait: current };
      } catch (error) {
        if (!(error instanceof WorkflowTransportError)) {
          // Unexpected errors are never swallowed: they propagate
          // fail-closed (the wait stays recorded — recoverable).
          throw error;
        }
        const outcome =
          error.failureKind === "transient" ? "transient-failure" : "permanent-failure";
        current = await this.deps.store.recordStartFailure(
          current.id,
          {
            stage: "start",
            attemptNo: attempt,
            outcome,
            detail: error.message.slice(0, 200),
          },
          this.deps.policy,
        );
        if (current.state === "abandoned") {
          return { started: false, wait: current };
        }
        if (i + 1 < this.deps.policy.maxStartAttempts) {
          await this.sleep(backoffDelayMs(this.deps.policy, i + 2));
        }
      }
    }
    return { started: false, wait: current };
  }

  /**
   * Deliver the resolution signal to the provider instance within
   * the bounded budget. A transport fact only: failures retry within
   * the budget and then stop (the recovery scan re-drives; the
   * compaction run terminates the instance — bounded state either
   * way); the authoritative effect already happened.
   */
  private async deliverResolutionSignal(
    wait: OrchestrationWait,
    eventType: string,
    cause: GovernedWaitResolution["cause"],
    notificationKey: string,
  ): Promise<boolean> {
    if (wait.providerInstanceId === null) {
      return false;
    }
    const body: Record<string, unknown> = {
      v: 1,
      waitKey: wait.waitKey,
      resolution: cause.kind,
      ...(cause.kind === "approval" ? { decision: cause.decision } : {}),
      notificationKey,
    };
    this.enforcePayloadBound(canonicalPayloadJson(body), "signal body");
    const attemptBase = Math.max(1, wait.signalDeliveryAttempts);
    for (let i = 0; i < this.deps.policy.maxSignalAttempts; i++) {
      const attempt = attemptBase + i;
      try {
        await this.deps.workflow.signalInstance({
          instanceId: wait.providerInstanceId,
          eventType,
          body,
        });
        await this.deps.store.markSignalDelivered(wait.id, notificationKey, {
          stage: "signal",
          attemptNo: attempt,
          outcome: "accepted",
          detail: null,
        });
        return true;
      } catch (error) {
        if (!(error instanceof WorkflowTransportError)) {
          throw error;
        }
        await this.deps.store.recordSignalDeliveryFailure(wait.id, notificationKey, {
          stage: "signal",
          attemptNo: attempt,
          outcome: error.failureKind === "transient" ? "transient-failure" : "permanent-failure",
          detail: error.message.slice(0, 200),
        });
        if (error.failureKind === "permanent") {
          return false;
        }
        if (i + 1 < this.deps.policy.maxSignalAttempts) {
          await this.sleep(backoffDelayMs(this.deps.policy, i + 2));
        }
      }
    }
    return false;
  }

  /** The deterministic instance hint (traceable, provider-safe). */
  private instanceHintOf(wait: OrchestrationWait): string {
    const digest = wait.payloadDigest.slice(0, 24);
    return `zeck-w-${digest}-a${Math.max(1, wait.startAttempts + 1)}`;
  }

  /** The reference-only pointer payload for one armed wait. */
  private pointerPayloadOf(
    candidate: OrchestrationCandidate,
    waitKey: string,
  ): OrchestrationPointerPayload {
    return {
      v: 1,
      waitKey,
      waitKind: candidate.waitKind,
      executionId: candidate.executionId,
      applicationId: candidate.applicationId,
      tenantId: candidate.tenantId,
      deadline: candidate.deadline,
      armedAt: this.deps.now().toISOString(),
    };
  }

  /** Fail closed on intake payload byte violations (bytes never enter workflow state). */
  private enforceIntakePayloadBound(canonical: string): void {
    const bytes = canonical.length;
    if (bytes > this.deps.bounds.maxPayloadBytes) {
      throw new OversizedNotificationError(
        `notification payload is ${bytes} bytes; the reference-only bound is ${this.deps.bounds.maxPayloadBytes} (large bytes never enter workflow state — only the digest would be retained)`,
      );
    }
  }

  /** Fail closed on reference-payload byte violations (programming error). */
  private enforcePayloadBound(canonical: string, what: string): void {
    const bytes = canonical.length;
    if (bytes > this.deps.bounds.maxPayloadBytes) {
      throw new WorkflowConfigError(
        `${what} is ${bytes} bytes; the reference-only bound is ${this.deps.bounds.maxPayloadBytes} (large bytes never enter workflow state)`,
      );
    }
  }
}

/** True iff the wait record's state is terminal. */
function isTerminalWaitState(wait: OrchestrationWait): boolean {
  return ["settled", "elapsed", "superseded", "abandoned"].includes(wait.state);
}

/** Convenience factory matching the module conventions. */
export function createOrchestrationCoordinator(
  deps: OrchestrationCoordinatorDeps,
): OrchestrationCoordinator {
  return new OrchestrationCoordinator(deps);
}
