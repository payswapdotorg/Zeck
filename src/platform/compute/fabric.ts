/**
 * The execution-worker fabric engine (platform compute plane;
 * WORK-046 / D-05) — the worker loop that carries executions from
 * asynchronous dispatch to durable completion.
 *
 * THE CLAIM-CARRIES-THE-WORK MODEL (the order IS the guarantee):
 *
 *   1. the transport pulls a dispatch delivery (bounded batch, bounded
 *      visibility window);
 *   2. the envelope resolves from PostgreSQL AUTHORITY FIRST (the
 *      message is a pointer, never a payload of record; binding +
 *      digest integrity is fail-closed dead-letter);
 *   3. the START effect re-enters the governed lifecycle (`start`:
 *      QUEUED -> RUNNING) with the D-03 deterministic key family —
 *      the request-plane consumer and this worker are ONE governed
 *      operation per correlation key;
 *   4. the WORK RESOLUTION decides what this fabric can execute (the
 *      sandbox executor's neutral contract; anything else is the
 *      honest not-executable refusal);
 *   5. the CLAIM GATE admits the runtime correlation row atomically
 *      (per-worker concurrency, per-environment quota, bounded
 *      re-selection attempts, ONE live claim per execution — all
 *      physically enforced in the compute_plane schema);
 *   6. the durable execution LEASE is acquired from the single lease
 *      system (the WORK-028 domain) and the correlation is recorded
 *      on the claim — set once, never rewritten;
 *   7. the delivery is SETTLED (consumed + acked): from here the
 *      durable claim + lease carry the work — the queue message is
 *      the wake-up, never the work anchor (a crash after this point
 *      is healed by the recovery scan, not by redelivery);
 *   8. the WORK EXECUTES through the owning module's full admission
 *      chain (policy -> capability -> budget) with a heartbeat
 *      sidecar (claim + lease renewals + cancellation observation);
 *   9. the COMPLETION EFFECT commits the outcome through the frozen
 *      transition service UNDER THE LEASE FENCE (success rides
 *      verify + pass with the mandatory verification binding;
 *      failure rides the governed fail);
 *  10. the claim finishes with its bounded, inspectable outcome.
 *
 * RECOVERY (`recover`): sweeps stale workers (registrations offline)
 * and stale claims (heartbeat age), abandons them with typed causes,
 * then RE-DRIVES recoverable executions directly from the executions
 * authority (RUNNING, no live lease) — fresh claim, fresh lease epoch
 * (the stale worker is fenced), the deterministic sandbox identity
 * replays the prior terminal outcome. No queue involvement: the
 * re-selection path is durable-state-driven.
 *
 * DRAIN/SHUTDOWN (`stop`): draining stops new acquisition (the store
 * refuses claims for draining workers), the in-flight item's
 * cooperative signal aborts, bounded waiting up to maxDrainMs, then
 * the straggler claim is abandoned (`worker-drained`) — recoverable
 * by fresh workers, never lost, never duplicated. The worker retires
 * offline (terminal; a restart registers a NEW identity).
 *
 * BOUNDED BY CONSTRUCTION: every number is a validated policy bound;
 * unbounded leases, heartbeats, concurrency, attempts, drain time,
 * payloads or retained state are unrepresentable. The fabric never
 * widens authority: it composes the four module seams and never
 * writes execution state itself.
 */

import type { TelemetrySink } from "../observability/port";
import { payloadDigestOf } from "../queue/correlation";
import type { DispatchEnvelope } from "../queue/port";
import type {
  ClaimAcquisitionInput,
  ClaimRefusalReason,
  ExecutionWorkerFabricDeps,
  WorkExecutionOutcome,
  WorkerAbandonCause,
  WorkerClaimOutcome,
  WorkerClaimRecord,
  WorkerExecutionFacts,
  WorkerFabricPolicy,
  WorkerRegistrationInput,
  WorkerRegistrationRecord,
} from "./port";

// ---------------------------------------------------------------------------
// Run reports (evidence; never authority)
// ---------------------------------------------------------------------------

export interface ConsumeReport {
  readonly pulled: number;
  readonly refusedUnbacked: number;
  readonly duplicates: number;
  readonly integrityDeadLettered: number;
  readonly started: number;
  readonly alreadyInFlight: number;
  readonly concluded: number;
  readonly startDeadLettered: number;
  readonly notExecutable: number;
  readonly claimRefusals: { readonly kind: string; readonly count: number }[];
  readonly claimed: number;
  readonly leaseConflicts: number;
  readonly leaseRefusals: number;
  readonly executed: number;
  readonly applied: number;
  readonly converged: number;
  readonly fenced: number;
  readonly workRefusals: number;
  readonly transientRetried: number;
  readonly deadLettered: number;
  readonly acked: number;
}

export interface RecoveryReport {
  readonly sweptWorkers: number;
  readonly abandonedClaims: number;
  readonly candidates: number;
  readonly skippedLiveClaim: number;
  readonly skippedNotExecutable: number;
  readonly claimed: number;
  readonly claimRefusals: { readonly kind: string; readonly count: number }[];
  readonly leaseConflicts: number;
  readonly executed: number;
  readonly applied: number;
  readonly converged: number;
  readonly fenced: number;
  readonly failedAbandoned: number;
}

interface MutableReport {
  pulled: number;
  refusedUnbacked: number;
  duplicates: number;
  integrityDeadLettered: number;
  started: number;
  alreadyInFlight: number;
  concluded: number;
  startDeadLettered: number;
  notExecutable: number;
  claimRefusals: Map<string, number>;
  claimed: number;
  leaseConflicts: number;
  leaseRefusals: number;
  executed: number;
  applied: number;
  converged: number;
  fenced: number;
  workRefusals: number;
  transientRetried: number;
  deadLettered: number;
  acked: number;
}

const emptyReport = (): MutableReport => ({
  pulled: 0,
  refusedUnbacked: 0,
  duplicates: 0,
  integrityDeadLettered: 0,
  started: 0,
  alreadyInFlight: 0,
  concluded: 0,
  startDeadLettered: 0,
  notExecutable: 0,
  claimRefusals: new Map(),
  claimed: 0,
  leaseConflicts: 0,
  leaseRefusals: 0,
  executed: 0,
  applied: 0,
  converged: 0,
  fenced: 0,
  workRefusals: 0,
  transientRetried: 0,
  deadLettered: 0,
  acked: 0,
});

const frozenReport = (report: MutableReport): ConsumeReport => ({
  ...report,
  claimRefusals: [...report.claimRefusals.entries()].map(([kind, count]) => ({ kind, count })),
});

/** The parse result of a delivered pointer payload. */
interface ParsedPointer {
  readonly correlationKey: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly purpose: string;
}

function parsePointer(body: string): ParsedPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.correlationKey !== "string" ||
    typeof record.executionId !== "string" ||
    typeof record.applicationId !== "string" ||
    typeof record.tenantId !== "string" ||
    typeof record.purpose !== "string"
  ) {
    return null;
  }
  return {
    correlationKey: record.correlationKey,
    executionId: record.executionId,
    applicationId: record.applicationId,
    tenantId: record.tenantId,
    purpose: record.purpose,
  };
}

// ---------------------------------------------------------------------------
// The fabric
// ---------------------------------------------------------------------------

export interface WorkerIdentity {
  readonly workerId: string;
  readonly applicationId: string;
  readonly kind: WorkerRegistrationInput["kind"];
  readonly runnerId?: string;
  readonly declaredConcurrency: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class ExecutionWorkerFabric {
  private readonly deps: ExecutionWorkerFabricDeps;
  private readonly policy: WorkerFabricPolicy;
  private readonly identity: WorkerIdentity;
  private readonly sleep: (ms: number) => Promise<void>;
  private registration: WorkerRegistrationRecord | null = null;
  private draining = false;
  private inFlight = 0;

  constructor(deps: ExecutionWorkerFabricDeps, identity: WorkerIdentity) {
    this.deps = deps;
    this.policy = deps.policy;
    this.identity = identity;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * The D-06 telemetry seam: bounded, non-throwing, observation-only.
   * Absent sink ⇒ zero emissions and zero behavioral change.
   */
  private async emitTelemetry(emit: (sink: TelemetrySink) => Promise<void>): Promise<void> {
    const sink = this.deps.telemetry;
    if (sink === undefined) {
      return;
    }
    try {
      await emit(sink);
    } catch {
      // Telemetry is observation, never authority: a sink failure is
      // swallowed (the sink itself counts its own drops/rejects).
    }
  }

  // -------------------------------------------------------------- registration

  /** Register the worker identity (idempotent; must precede consumption). */
  async register(now?: string): Promise<WorkerRegistrationRecord> {
    const input: WorkerRegistrationInput = {
      workerId: this.identity.workerId,
      applicationId: this.identity.applicationId,
      kind: this.identity.kind,
      ...(this.identity.runnerId === undefined ? {} : { runnerId: this.identity.runnerId }),
      declaredConcurrency: this.identity.declaredConcurrency,
      ...(this.identity.metadata === undefined ? {} : { metadata: this.identity.metadata }),
    };
    const record = await this.deps.store.registerWorker(
      input,
      now ?? this.deps.now().toISOString(),
    );
    this.registration = record;
    return record;
  }

  /** The current registration (or null before register()). */
  get worker(): WorkerRegistrationRecord | null {
    return this.registration;
  }

  // ------------------------------------------------------------- consumption

  /**
   * Pull ONE batch and converge it. The settle at the end is the only
   * transport mutation beyond the governed effects; a failure there
   * propagates (the lease expires and redelivery converges — never
   * data loss, never double effects).
   */
  async consumeBatch(): Promise<ConsumeReport> {
    const report = emptyReport();
    const remaining = Math.max(0, this.identity.declaredConcurrency - this.inFlight);
    if (remaining === 0 || this.draining) {
      return frozenReport(report);
    }
    const batch = await this.deps.transport.pull({
      batchSize: Math.min(this.policy.batchSize, remaining),
      visibilityTimeoutMs: this.policy.claimVisibilityMs,
    });
    report.pulled = batch.messages.length;
    const ackLeaseIds: string[] = [];
    const retryLeaseIds: string[] = [];
    for (const message of batch.messages) {
      if (this.draining) {
        // Drain racing new dispatch: stop consuming; the unsettled
        // lease expires and redelivery converges (never lost).
        retryLeaseIds.push(message.leaseId);
        continue;
      }
      await this.handleDelivery(message, ackLeaseIds, retryLeaseIds, report);
    }
    await this.deps.transport.settle({ ackLeaseIds, retryLeaseIds });
    report.acked = ackLeaseIds.length;
    return frozenReport(report);
  }

  private async handleDelivery(
    message: { readonly leaseId: string; readonly body: string },
    ackLeaseIds: string[],
    retryLeaseIds: string[],
    report: MutableReport,
  ): Promise<void> {
    const pointer = parsePointer(message.body);
    if (pointer === null || pointer.purpose !== "execution-dispatch") {
      // Unbacked noise: no authoritative record can exist. Refuse + ack.
      report.refusedUnbacked += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // AUTHORITY FIRST: resolve the durable correlation record.
    const envelope = await this.deps.correlation.findByCorrelationKey(pointer.correlationKey);
    if (envelope === null) {
      report.refusedUnbacked += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // Terminal transports: duplicates need no effects (this includes a
    // tampered duplicate of a terminal envelope — nothing authoritative
    // can be affected; the duplicate ack converges the delivery).
    if (envelope.state === "consumed" || envelope.state === "dead-lettered") {
      report.duplicates += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // Payload integrity: the delivered binding + digest must match the
    // authoritative record (fail-closed dead-letter).
    const bindingMismatch =
      pointer.executionId !== envelope.executionId ||
      pointer.applicationId !== envelope.applicationId ||
      pointer.tenantId !== envelope.tenantId;
    let digestMismatch = false;
    try {
      const parsed = JSON.parse(message.body) as Record<string, unknown>;
      if (payloadDigestOf(parsed) !== envelope.payloadDigest) {
        digestMismatch = true;
      }
    } catch {
      digestMismatch = true;
    }
    if (bindingMismatch || digestMismatch) {
      await this.deadLetter(
        envelope,
        "payload-mismatch",
        bindingMismatch
          ? "delivered binding disagrees with the authoritative record"
          : "payload digest mismatch",
        Math.max(1, envelope.deliveryAttempts),
      );
      report.integrityDeadLettered += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // A delivery of a recorded/backlogged envelope proves publication.
    let current = envelope;
    if (current.state === "recorded" || current.state === "backlogged") {
      current = await this.deps.correlation.markPublishAccepted(current.id, {
        stage: "publish",
        attemptNo: Math.max(1, current.publishAttempts),
        outcome: "accepted",
        detail: "publication proven by delivery",
      });
    }

    // ---- The START effect (the governed lifecycle re-entry). ----------
    const startOutcome = await this.deps.startEffect.apply(
      { envelope: current },
      {
        workerActorId: this.deps.workerActorId,
        idempotencyKey: `queue-consume:${current.correlationKey}`,
      },
    );
    if (startOutcome.outcome === "refused") {
      await this.deadLetter(
        current,
        "governed-rejection",
        startOutcome.reason.slice(0, 200),
        current.deliveryAttempts + 1,
      );
      report.startDeadLettered += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }
    if (startOutcome.outcome === "concluded") {
      await this.deps.correlation.markConsumed(
        current.id,
        `worker-claim:${current.correlationKey}`,
        {
          stage: "delivery",
          attemptNo: current.deliveryAttempts + 1,
          outcome: "accepted",
          detail: "converged-elsewhere (terminal execution)",
        },
      );
      report.concluded += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }
    if (startOutcome.outcome === "started") {
      report.started += 1;
    } else {
      report.alreadyInFlight += 1;
    }

    // ---- The work resolution (what can this fabric execute?). ---------
    const facts = startOutcome.facts;
    const resolution = this.deps.work.resolve({
      executionId: facts.executionId,
      applicationId: facts.applicationId,
      tenantId: facts.tenantId,
      environmentId: facts.environmentId,
      task: facts.task,
    });
    if (resolution.kind === "not-executable") {
      // Honest refusal: this worker cannot execute the declared work
      // (other participants own those kinds). The bounded dead letter
      // is the inspectable evidence — never a silent drop.
      await this.deadLetter(
        current,
        "governed-rejection",
        `work not executable by the worker fabric: ${resolution.reason.slice(0, 140)}`,
        current.deliveryAttempts + 1,
      );
      report.notExecutable += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // ---- The claim/lease/execute/completion pipeline. ------------------
    const outcome = await this.claimAndExecute(
      {
        executionId: facts.executionId,
        applicationId: facts.applicationId,
        tenantId: facts.tenantId,
        environmentId: facts.environmentId ?? "",
        task: facts.task,
      },
      resolution.computeEnvironmentId,
      report,
      { envelope: current },
    );
    // D-06: the delivery-disposition observation (the bounded
    // disposition vocabulary; reference-only correlation).
    await this.emitTelemetry(async (sink) => {
      const now = this.deps.now().toISOString();
      const correlation = {
        executionId: facts.executionId,
        correlationKey: current.correlationKey,
        tenantId: facts.tenantId,
        applicationId: facts.applicationId,
      };
      await sink.emitSpan({
        name: "zeck.worker.disposition",
        status: outcome === "dead-letter" ? "error" : "ok",
        startedAt: now,
        endedAt: now,
        correlation,
        attributes: { disposition: outcome },
      });
      await sink.emitMetric({
        name: "zeck.worker.dispositions",
        kind: "counter",
        value: 1,
        correlation,
        attributes: { disposition: outcome },
      });
    });
    if (outcome === "settled") {
      // The envelope was consumed at claim admission: the durable claim
      // + lease carried the work; the delivery ACKS whatever the work's
      // own outcome (the report counters carry it).
      ackLeaseIds.push(message.leaseId);
      return;
    }
    if (outcome === "concluded") {
      // The execution is terminal without a live claim: consume the
      // envelope (the transport's terminal success) and ack.
      await this.deps.correlation.markConsumed(
        current.id,
        `worker-claim:${current.correlationKey}`,
        {
          stage: "delivery",
          attemptNo: current.deliveryAttempts + 1,
          outcome: "accepted",
          detail: "converged-elsewhere (terminal execution)",
        },
      );
      ackLeaseIds.push(message.leaseId);
      return;
    }
    if (outcome === "retry-delivery") {
      // PRE-settlement refusal: the message is still the wake-up — a
      // bounded transient failure + re-delivery within the budget.
      const updated = await this.recordTransientFailure(
        current,
        current.deliveryAttempts + 1,
        "claim or lease refused; bounded re-delivery",
      );
      if (updated.state === "dead-lettered") {
        report.deadLettered += 1;
        ackLeaseIds.push(message.leaseId);
      } else {
        report.transientRetried += 1;
        retryLeaseIds.push(message.leaseId);
      }
      return;
    }
    // dead-letter: the pre-settlement governed refusal / bounded
    // exhaustion (the execution's fate was decided through the
    // authority — failAbandoned or the governed start refusal).
    await this.deadLetter(
      current,
      "governed-rejection",
      "the worker fabric refused the work (bounded exhaustion or governed refusal)",
      current.deliveryAttempts + 1,
    );
    report.deadLettered += 1;
    ackLeaseIds.push(message.leaseId);
  }

  // -------------------------------------------------------------- the pipeline

  /**
   * The shared claim -> lease -> settle -> execute -> complete
   * pipeline. Returns the delivery disposition:
   *  - "settled"        — the envelope was CONSUMED at claim admission:
   *                       the durable claim + lease carried the work;
   *                       the caller ACKS the delivery whatever the
   *                       work's own outcome (applied / converged /
   *                       fenced-recoverable — the report counters and
   *                       the recovery scan own the rest);
   *  - "concluded"      — the execution is ALREADY terminal (classified
   *                       at the claim gate): no claim exists, the
   *                       caller consumes + acks;
   *  - "retry-delivery" — a PRE-settlement refusal (quota saturation,
   *                       lease conflict, duplicate live claim): the
   *                       message is still the wake-up, so a bounded
   *                       transient failure + re-delivery is correct;
   *  - "dead-letter"    — a PRE-settlement governed refusal or the
   *                       bounded exhaustion of re-selection.
   */
  private async claimAndExecute(
    facts: WorkerExecutionFacts,
    computeEnvironmentId: string,
    report: MutableReport,
    options?: { readonly skipEnvelopeSettlement?: boolean; readonly envelope?: DispatchEnvelope },
  ): Promise<"settled" | "concluded" | "retry-delivery" | "dead-letter"> {
    // 1. The claim gate (atomic admission: concurrency, quota,
    //    attempts, one live claim).
    const claimInput: ClaimAcquisitionInput = {
      workerId: this.identity.workerId,
      executionId: facts.executionId,
      applicationId: facts.applicationId,
      tenantId: facts.tenantId,
      environmentId: facts.environmentId ?? "",
      computeEnvironmentId,
    };
    let acquisition: Awaited<ReturnType<typeof this.deps.store.acquireClaim>>;
    try {
      acquisition = await this.deps.store.acquireClaim(claimInput, this.deps.now().toISOString());
    } catch (error) {
      // The physical admission gate classified this claim: a TERMINAL
      // execution admits no claim (its fate is already decided through
      // the authority) — the delivery converges, nothing was claimed.
      if (error instanceof Error && error.message.includes("no worker claim may be admitted")) {
        report.converged += 1;
        return "concluded";
      }
      throw error;
    }
    if (acquisition.outcome === "refused") {
      this.bumpClaimRefusal(report, acquisition.reason);
      if (acquisition.reason.kind === "attempts-exhausted") {
        // The honest governed failure of bounded re-selection: the
        // execution fails through the authority — never dropped.
        const completion = await this.deps.completion.failAbandoned({
          executionId: facts.executionId,
          applicationId: facts.applicationId,
          tenantId: facts.tenantId,
          workerActorId: this.deps.workerActorId,
          reason: `claim attempts exhausted (${acquisition.reason.attempts}/${acquisition.reason.bound})`,
        });
        if (completion.outcome === "applied" || completion.outcome === "already-applied") {
          // The governed failure converged the execution; the transport
          // outcome is the honest dead-letter of the bounded budget.
          return "dead-letter";
        }
        return "dead-letter";
      }
      return "retry-delivery";
    }
    const claim = acquisition.claim;
    report.claimed += 1;
    this.inFlight += 1;
    // D-06: the claim-admission observation (reference-only facts).
    await this.emitTelemetry((sink) => {
      const now = this.deps.now().toISOString();
      return sink.emitSpan({
        name: "zeck.worker.claim",
        status: "ok",
        startedAt: now,
        endedAt: now,
        correlation: {
          executionId: facts.executionId,
          correlationKey: options?.envelope?.correlationKey,
          claimId: claim.id,
          tenantId: facts.tenantId,
          applicationId: facts.applicationId,
        },
        attributes: {
          claimEpoch: String(claim.claimEpoch),
          computeEnvironmentId,
          outcome: "admitted",
        },
      });
    });
    try {
      // 2. The durable execution lease (the single fencing system).
      const leaseOutcome = await this.deps.lease.acquire({
        applicationId: facts.applicationId,
        executionId: facts.executionId,
        tenantId: facts.tenantId,
        ownerId: this.identity.workerId,
        ttlMs: this.policy.leaseTtlMs,
        reason: `worker-claim:${claim.claimEpoch}`,
      });
      if (leaseOutcome.outcome === "conflict") {
        await this.abandon(claim, "lease-conflict", {
          liveOwner: leaseOutcome.liveOwner,
          liveEpoch: leaseOutcome.liveEpoch,
        });
        report.leaseConflicts += 1;
        return "retry-delivery";
      }
      if (leaseOutcome.outcome === "refused") {
        await this.abandon(claim, "work-refused", { reason: leaseOutcome.reason.slice(0, 200) });
        report.leaseRefusals += 1;
        return "dead-letter";
      }
      const leaseClaim = leaseOutcome.claim;
      const correlated = await this.deps.store.recordClaimLease(claim.id, {
        leaseOwner: leaseClaim.ownerId,
        leaseEpoch: leaseClaim.epoch,
      });
      if (correlated === null) {
        // The claim vanished (a concurrent finalization): release the
        // lease and converge as a retry.
        await this.releaseLease(facts, leaseClaim);
        return "retry-delivery";
      }

      // 3. SETTLE THE DELIVERY: the durable claim + lease carry the
      //    work from here (the message was the wake-up).
      if (options?.skipEnvelopeSettlement !== true && options?.envelope !== undefined) {
        await this.deps.correlation.markConsumed(
          options.envelope.id,
          `worker-claim:${options.envelope.correlationKey}`,
          {
            stage: "delivery",
            attemptNo: options.envelope.deliveryAttempts + 1,
            outcome: "accepted",
            detail: `claim admitted (epoch ${claim.claimEpoch})`,
          },
        );
      }

      // 4. Cancellation/termination BEFORE dispatch: a terminal
      //    execution never dispatches paid compute — the claim
      //    converges (the governed path already decided the outcome).
      const preWorkStatus = await this.deps.statusReader.getExecutionStatus(
        facts.applicationId,
        facts.executionId,
      );
      if (preWorkStatus?.terminal === true) {
        await this.finish(correlated, "converged-elsewhere", { status: preWorkStatus.status });
        await this.releaseLease(facts, leaseClaim);
        report.converged += 1;
        return "settled";
      }

      // 5. Execute with the heartbeat sidecar.
      const workOutcome = await this.executeWithSidecar(facts, correlated, leaseClaim);

      // 6. The completion effect (lease-guarded, verification-bound).
      return await this.completeWork(facts, correlated, leaseClaim, workOutcome, report);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Execute the work under the heartbeat sidecar (renew + observe). */
  private async executeWithSidecar(
    facts: WorkerExecutionFacts,
    claim: WorkerClaimRecord,
    leaseClaim: { readonly ownerId: string; readonly epoch: number },
  ): Promise<WorkExecutionOutcome> {
    const controller = new AbortController();
    let done = false;
    let doneSignal: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      doneSignal = resolve;
    });
    const sidecar = (async () => {
      while (!done) {
        // The sleep races the settled signal: the finally-side join
        // wakes the sidecar immediately (bounded shutdown time —
        // never a full heartbeat interval of straggling).
        await Promise.race([this.sleep(this.policy.heartbeatIntervalMs), settled]);
        if (done) {
          return;
        }
        // Heartbeat the claim (monotonic ledger) + renew the lease with
        // the renewal ordinal; observe cancellation.
        const heartbeat = await this.deps.store.heartbeatClaim(
          claim.id,
          this.deps.now().toISOString(),
        );
        if (heartbeat === null) {
          controller.abort();
          return;
        }
        const renewal = await this.deps.lease.renew({
          applicationId: facts.applicationId,
          executionId: facts.executionId,
          tenantId: facts.tenantId,
          claim: leaseClaim,
          ttlMs: this.policy.leaseTtlMs,
          renewalOrdinal: heartbeat.heartbeatCount,
        });
        if (renewal.outcome === "stale") {
          // Lease lost: cooperative interruption (the completion fence
          // converges the authoritative classification).
          controller.abort();
          return;
        }
        const status = await this.deps.statusReader.getExecutionStatus(
          facts.applicationId,
          facts.executionId,
        );
        if (status?.terminal === true) {
          // Cancelled/terminated through the governed path: stop work.
          controller.abort();
          return;
        }
      }
    })();
    try {
      return await this.deps.work.execute({
        executionId: facts.executionId,
        applicationId: facts.applicationId,
        tenantId: facts.tenantId,
        environmentId: facts.environmentId ?? "",
        task: facts.task,
        worker: { workerId: this.identity.workerId, actorId: this.deps.workerActorId },
        claim: leaseClaim,
        signal: controller.signal,
      });
    } finally {
      done = true;
      doneSignal();
      await sidecar.catch(() => undefined);
    }
  }

  /** The completion mapping (claim outcome + delivery disposition). */
  private async completeWork(
    facts: WorkerExecutionFacts,
    claim: WorkerClaimRecord,
    leaseClaim: { readonly ownerId: string; readonly epoch: number },
    workOutcome: Awaited<ReturnType<ExecutionWorkerFabric["executeWithSidecar"]>>,
    report: MutableReport,
  ): Promise<"settled" | "concluded" | "retry-delivery" | "dead-letter"> {
    if (workOutcome.outcome === "not-executable") {
      // Post-settlement (the envelope was consumed at claim time): the
      // claim records the honest refusal and the recovery scan decides
      // the execution's fate — the delivery is settled either way.
      await this.abandon(claim, "work-refused", {
        reason: workOutcome.reason.slice(0, 200),
      });
      report.workRefusals += 1;
      return "settled";
    }
    if (workOutcome.outcome === "refused") {
      // Post-settlement refusals: the claim records the typed cause;
      // the recovery scan re-drives (fenced/stale) or the governed
      // refusal stands (work-refused). The delivery is settled.
      if (workOutcome.kind === "fenced") {
        await this.abandon(claim, "stale-write", { reason: workOutcome.reason.slice(0, 200) });
        report.fenced += 1;
        return "settled";
      }
      if (workOutcome.kind === "interrupted") {
        await this.abandon(claim, "worker-drained", {
          reason: workOutcome.reason.slice(0, 200),
        });
        report.workRefusals += 1;
        return "settled";
      }
      await this.abandon(claim, "work-refused", {
        reason: workOutcome.reason.slice(0, 200),
      });
      report.workRefusals += 1;
      return "settled";
    }

    report.executed += 1;
    const observation = workOutcome.observation;

    // Cancellation raced the provider completion: converge to the
    // authoritative terminal state, never a worker-side decision.
    const status = await this.deps.statusReader.getExecutionStatus(
      facts.applicationId,
      facts.executionId,
    );
    if (status?.terminal === true) {
      await this.finish(claim, "converged-elsewhere", { status: status.status });
      await this.releaseLease(facts, leaseClaim);
      report.converged += 1;
      return "settled";
    }

    const completion = await this.deps.completion.complete({
      executionId: facts.executionId,
      applicationId: facts.applicationId,
      tenantId: facts.tenantId,
      claim: leaseClaim,
      workerActorId: this.deps.workerActorId,
      observation,
    });
    if (completion.outcome === "applied") {
      const claimOutcome: WorkerClaimOutcome =
        observation.outcomeClass === "work-success" ? "applied-success" : "applied-failure";
      await this.finish(claim, claimOutcome, {
        outputDigest: observation.outputDigest,
        ...(observation.usageMicroUsd === null ? {} : { usageMicroUsd: observation.usageMicroUsd }),
      });
      await this.releaseLease(facts, leaseClaim);
      report.applied += 1;
      return "settled";
    }
    if (completion.outcome === "already-applied") {
      await this.finish(claim, "converged-elsewhere", {});
      await this.releaseLease(facts, leaseClaim);
      report.converged += 1;
      return "settled";
    }
    if (completion.outcome === "fenced") {
      // THE STALE-WORKER FENCE: the late completion did NOT become
      // authoritative. The claim records the honest stale write; the
      // recovery scan re-drives the execution (the sandbox terminal
      // outcome replays — no duplicate governed effect). The delivery
      // is settled — the durable claim + lease carried the work from
      // claim admission; redelivery is not the recovery path here.
      await this.abandon(claim, "stale-write", {
        reason: completion.reason.slice(0, 200),
      });
      report.fenced += 1;
      return "settled";
    }
    // rejected: the governed path refused the completion. If the
    // execution moved on terminally, converge; otherwise the honest
    // non-executable completion (recoverable later).
    const nowStatus = await this.deps.statusReader.getExecutionStatus(
      facts.applicationId,
      facts.executionId,
    );
    if (nowStatus?.terminal === true) {
      await this.finish(claim, "converged-elsewhere", { status: nowStatus.status });
      await this.releaseLease(facts, leaseClaim);
      report.converged += 1;
      return "settled";
    }
    await this.finish(claim, "not-executable", { reason: completion.reason.slice(0, 200) });
    await this.releaseLease(facts, leaseClaim);
    report.workRefusals += 1;
    return "settled";
  }

  // ------------------------------------------------------------------ recovery

  /**
   * The recovery sweep: stale workers offline, stale claims abandoned,
   * recoverable executions re-driven from the authority (no queue).
   */
  async recover(): Promise<RecoveryReport> {
    const report: {
      sweptWorkers: number;
      abandonedClaims: number;
      candidates: number;
      skippedLiveClaim: number;
      skippedNotExecutable: number;
      claimed: number;
      claimRefusals: Map<string, number>;
      leaseConflicts: number;
      executed: number;
      applied: number;
      converged: number;
      fenced: number;
      failedAbandoned: number;
    } = {
      sweptWorkers: 0,
      abandonedClaims: 0,
      candidates: 0,
      skippedLiveClaim: 0,
      skippedNotExecutable: 0,
      claimed: 0,
      claimRefusals: new Map(),
      leaseConflicts: 0,
      executed: 0,
      applied: 0,
      converged: 0,
      fenced: 0,
      failedAbandoned: 0,
    };
    const now = this.deps.now().toISOString();

    // 1. Stale workers offline (heartbeat age exceeded).
    const swept = await this.deps.store.sweepStaleWorkers(this.policy.workerStaleAfterMs, now);
    report.sweptWorkers = swept.length;

    // 2. Stale claims abandoned (heartbeat age exceeded) — typed,
    //    inspectable, recoverable.
    const staleClaims = await this.deps.store.listStaleClaims(
      this.policy.workerStaleAfterMs,
      this.policy.batchSize,
    );
    for (const claim of staleClaims) {
      await this.abandon(claim, "heartbeat-lost", {
        lastHeartbeatAt: claim.lastHeartbeatAt,
      });
      report.abandonedClaims += 1;
    }

    // 3. Re-drive recoverable executions from the executions authority.
    const liveClaims = await this.deps.store.listLiveClaims();
    const liveByExecution = new Set(liveClaims.map((claim) => claim.executionId));
    const candidates = await this.deps.recoverySource.listRecoverable({
      limit: this.policy.batchSize,
      applicationId: this.identity.applicationId,
    });
    report.candidates = candidates.length;
    for (const facts of candidates) {
      if (this.draining) {
        break;
      }
      if (liveByExecution.has(facts.executionId)) {
        report.skippedLiveClaim += 1;
        continue;
      }
      const resolution = this.deps.work.resolve({
        executionId: facts.executionId,
        applicationId: facts.applicationId,
        tenantId: facts.tenantId,
        environmentId: facts.environmentId,
        task: facts.task,
      });
      if (resolution.kind === "not-executable") {
        report.skippedNotExecutable += 1;
        continue;
      }
      const mutable: MutableReport = emptyReport();
      let outcome: "settled" | "concluded" | "retry-delivery" | "dead-letter";
      try {
        outcome = await this.claimAndExecute(
          {
            executionId: facts.executionId,
            applicationId: facts.applicationId,
            tenantId: facts.tenantId,
            environmentId: facts.environmentId ?? "",
            task: facts.task,
          },
          resolution.computeEnvironmentId,
          mutable,
          { skipEnvelopeSettlement: true },
        );
      } catch (error) {
        // One candidate's failure never aborts the scan (the durable
        // state is the recovery path; the next scan retries). The
        // error is not silent: the claim gate's typed refusals are
        // recorded; unknown errors surface on the next iteration.
        if (process.env.ZECK_DEBUG_RECOVER === "1") {
          console.log("[recover] candidate error:", (error as Error).message.slice(0, 200));
        }
        void error;
        continue;
      }
      report.claimed += mutable.claimed;
      report.executed += mutable.executed;
      report.applied += mutable.applied;
      report.converged += mutable.converged;
      report.fenced += mutable.fenced;
      report.leaseConflicts += mutable.leaseConflicts;
      for (const [kind, count] of mutable.claimRefusals) {
        report.claimRefusals.set(kind, (report.claimRefusals.get(kind) ?? 0) + count);
      }
      if (outcome === "dead-letter") {
        report.failedAbandoned += 1;
      }
    }
    // D-06: the recovery-scan observation (bounded counters only).
    await this.emitTelemetry((sink) =>
      sink.emitMetric({
        name: "zeck.worker.recovered",
        kind: "counter",
        value: report.executed + report.converged,
        correlation: {},
        attributes: {
          candidates: String(report.candidates),
          abandonedClaims: String(report.abandonedClaims),
          sweptWorkers: String(report.sweptWorkers),
          failedAbandoned: String(report.failedAbandoned),
        },
      }),
    );
    return {
      ...report,
      claimRefusals: [...report.claimRefusals.entries()].map(([kind, count]) => ({
        kind,
        count,
      })),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** One heartbeat of the registration (loop cadence). */
  async heartbeat(): Promise<WorkerRegistrationRecord | null> {
    return this.deps.store.heartbeatWorker(this.identity.workerId, this.deps.now().toISOString());
  }

  /**
   * The long-running loop: consume -> recover -> heartbeat -> sleep.
   * Returns when draining completes (stop()) or the signal aborts.
   */
  async runForever(signal?: AbortSignal): Promise<void> {
    while (!this.draining) {
      if (signal?.aborted === true) {
        await this.stop("signal-aborted");
        return;
      }
      try {
        await this.consumeBatch();
        await this.recover();
        await this.heartbeat();
      } catch (error) {
        // Bounded degradation: the loop survives typed and unknown
        // errors (the durable state is the recovery path); the next
        // iteration retries. Never an authority claim.
        void error;
      }
      await this.sleep(this.policy.heartbeatIntervalMs);
    }
    await this.stop("drain-requested");
  }

  /**
   * Graceful drain/shutdown: stop acquisition, bound the in-flight
   * wait, abandon stragglers (recoverable), retire the identity.
   */
  async stop(reason?: string): Promise<void> {
    if (!this.draining) {
      await this.deps.store.beginDrain(this.identity.workerId, this.deps.now().toISOString());
    }
    this.draining = true;
    const deadline = Date.now() + this.policy.maxDrainMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await this.sleep(
        Math.min(this.policy.heartbeatIntervalMs, Math.max(1, deadline - Date.now())),
      );
    }
    // Stragglers: the claims of THIS worker still live — abandon them
    // (recoverable by fresh workers; never lost, never duplicated).
    const live = await this.deps.store.listLiveClaims(this.identity.workerId);
    for (const claim of live) {
      await this.abandon(claim, "worker-drained", { reason: reason ?? "drain" });
    }
    await this.deps.store.retireWorker(
      this.identity.workerId,
      (reason ?? "drain").slice(0, 200),
      this.deps.now().toISOString(),
    );
    this.registration = null;
  }

  // ------------------------------------------------------------------ helpers

  private bumpClaimRefusal(report: MutableReport, reason: ClaimRefusalReason): void {
    report.claimRefusals.set(reason.kind, (report.claimRefusals.get(reason.kind) ?? 0) + 1);
  }

  private async finish(
    claim: WorkerClaimRecord,
    outcome: WorkerClaimOutcome,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.store.completeClaim(
      { claimId: claim.id, outcome, outcomeDetail: detail },
      this.deps.now().toISOString(),
    );
  }

  private async abandon(
    claim: WorkerClaimRecord,
    cause: WorkerAbandonCause,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.store.abandonClaim(
      { claimId: claim.id, cause, detail },
      this.deps.now().toISOString(),
    );
  }

  private async releaseLease(
    facts: WorkerExecutionFacts,
    leaseClaim: { readonly ownerId: string; readonly epoch: number },
  ): Promise<void> {
    await this.deps.lease
      .release({
        applicationId: facts.applicationId,
        executionId: facts.executionId,
        tenantId: facts.tenantId,
        claim: leaseClaim,
      })
      .catch(() => undefined);
  }

  /** The governed dead-letter: the bounded, inspectable terminal failure. */
  private async deadLetter(
    envelope: DispatchEnvelope,
    reason: "payload-mismatch" | "governed-rejection",
    detail: string,
    attemptNo: number,
  ): Promise<void> {
    // D-06: the bounded dead-letter observation (actionable signal for
    // the error-monitoring alert thresholds).
    await this.emitTelemetry((sink) =>
      sink.emitLog({
        level: "warn",
        message: `dispatch envelope dead-lettered: ${detail.slice(0, 120)}`,
        correlation: {
          executionId: envelope.executionId,
          correlationKey: envelope.correlationKey,
          tenantId: envelope.tenantId,
          applicationId: envelope.applicationId,
        },
        attributes: { reason },
      }),
    );
    await this.deps.correlation.deadLetter(
      envelope.id,
      reason,
      Math.max(1, attemptNo),
      detail.slice(0, 200),
    );
  }

  /**
   * The bounded transient failure: re-delivery within the retry
   * policy's delivery budget (quota saturation, lease conflicts,
   * duplicate live claims — all wait-and-retry conditions, never
   * governed rejections).
   */
  private async recordTransientFailure(
    envelope: DispatchEnvelope,
    attemptNo: number,
    detail: string,
  ): Promise<DispatchEnvelope> {
    return this.deps.correlation.recordDeliveryFailure(
      envelope.id,
      { stage: "delivery", attemptNo, outcome: "transient-failure", detail: detail.slice(0, 200) },
      this.deps.retryPolicy,
    );
  }
}

/** Convenience factory matching the module conventions. */
export function createExecutionWorkerFabric(
  deps: ExecutionWorkerFabricDeps,
  identity: WorkerIdentity,
): ExecutionWorkerFabric {
  return new ExecutionWorkerFabric(deps, identity);
}
