/**
 * The provider-outage simulation harness (platform recovery plane;
 * WORK-048 / D-07 — "provider outage simulations and explicit
 * fail-closed behavior").
 *
 * Every wrapper here SIMULATES a provider outage for drills: while
 * the outage is active, every operation through the wrapped port
 * fails with the SAME typed error class the real adapter produces
 * for an unavailable provider. The wrappers prove the fail-closed
 * contract end-to-end WITHOUT any live provider:
 *
 *  - queue transport outages surface as `QueueTransportError` with
 *    failureKind "transient" (the provider will come back — the
 *    bounded retry/backlog machinery owns convergence);
 *  - object-store outages surface as the S3 adapter's typed
 *    `S3ObjectStoreError` (5xx-class transport failure — never a
 *    silent null, never a silent success);
 *  - database outages surface as `DatabaseUnavailableError` (the
 *    authority-unavailable class: every authority-bearing operation
 *    refuses, nothing is promoted).
 *
 * The harness is provider-neutral BY CONSTRUCTION: it wraps ports,
 * carries no vendor vocabulary of its own, and never fabricates
 * success. Recovery after an outage is ALWAYS driven by the
 * authoritative PostgreSQL state (the replay/re-drive machinery),
 * never by the harness remembering what "should" have happened.
 *
 * Drill determinism: outages are explicit `begin`/`end` operations
 * (or counted failures) — no timers, no ambient state.
 */

import { DatabaseUnavailableError } from "../db/errors";
import type { DatabasePort, Query, QueryResult, Transaction } from "../db/port";
import type { ObjectStorePort, PutOptions, StoredObject } from "../object-store/port";
import { S3ObjectStoreError } from "../object-store/s3-object-store";
import {
  type PublishReceipt,
  type PulledBatch,
  type PullOptions,
  type QueueOutboundMessage,
  QueueTransportError,
  type QueueTransportPort,
  type Settlement,
} from "../queue/port";

/** The simulated outage classes (provider categories, not vendors). */
export type SimulatedOutageClass = "queue-transport" | "object-store" | "database";

/** Bounded detail carried by simulated outages (never secrets). */
export interface OutageEvidence {
  readonly outageClass: SimulatedOutageClass;
  readonly reason: string;
}

const OUTAGE_REASON = "simulated provider outage (recovery drill)";

/** Count of failed operations observed during an outage (evidence). */
export interface OutageObservation {
  readonly outageClass: SimulatedOutageClass;
  readonly failedOperations: number;
}

/**
 * The queue-transport outage wrapper: while active, publish/pull/
 * settle fail with the typed transport error (transient — the
 * provider class recovers). Counts every refused operation.
 */
export class OutageSimulatedQueueTransport implements QueueTransportPort, OutageObservation {
  private active = false;
  private failed = 0;

  constructor(private readonly inner: QueueTransportPort) {}

  get outageClass(): SimulatedOutageClass {
    return "queue-transport";
  }

  get failedOperations(): number {
    return this.failed;
  }

  begin(): void {
    this.active = true;
  }

  end(): void {
    this.active = false;
  }

  async publish(message: QueueOutboundMessage): Promise<PublishReceipt> {
    if (this.active) {
      this.failed += 1;
      throw new QueueTransportError(OUTAGE_REASON, "transient", { status: undefined });
    }
    return this.inner.publish(message);
  }

  async pull(options?: PullOptions): Promise<PulledBatch> {
    if (this.active) {
      this.failed += 1;
      throw new QueueTransportError(OUTAGE_REASON, "transient", { status: undefined });
    }
    return this.inner.pull(options);
  }

  async settle(settlement: Settlement): Promise<void> {
    if (this.active) {
      this.failed += 1;
      throw new QueueTransportError(OUTAGE_REASON, "transient", { status: undefined });
    }
    return this.inner.settle(settlement);
  }
}

/**
 * The object-store outage wrapper: while active, put/get/delete fail
 * with the S3 adapter's typed 5xx-class error. Never returns null on
 * outage (null means "key absent" — an outage must NOT masquerade as
 * a missing object).
 */
export class OutageSimulatedObjectStore implements ObjectStorePort, OutageObservation {
  private active = false;
  private failed = 0;

  constructor(private readonly inner: ObjectStorePort) {}

  get outageClass(): SimulatedOutageClass {
    return "object-store";
  }

  get failedOperations(): number {
    return this.failed;
  }

  begin(): void {
    this.active = true;
  }

  end(): void {
    this.active = false;
  }

  async put(key: string, body: Uint8Array, options?: PutOptions): Promise<void> {
    if (this.active) {
      this.failed += 1;
      throw new S3ObjectStoreError(OUTAGE_REASON, 503, "outage-simulated");
    }
    return this.inner.put(key, body, options);
  }

  async get(key: string): Promise<StoredObject | null> {
    if (this.active) {
      this.failed += 1;
      throw new S3ObjectStoreError(OUTAGE_REASON, 503, "outage-simulated");
    }
    return this.inner.get(key);
  }

  async delete(key: string): Promise<void> {
    if (this.active) {
      this.failed += 1;
      throw new S3ObjectStoreError(OUTAGE_REASON, 503, "outage-simulated");
    }
    return this.inner.delete(key);
  }
}

/**
 * The database outage wrapper: while active, every port operation
 * fails with the authority-unavailable error — the same class the
 * production adapter produces for an unreachable endpoint. Nothing
 * is promoted, nothing silently succeeds.
 */
export class OutageSimulatedDatabase implements DatabasePort, OutageObservation {
  private active = false;
  private failed = 0;

  constructor(private readonly inner: DatabasePort) {}

  get outageClass(): SimulatedOutageClass {
    return "database";
  }

  get failedOperations(): number {
    return this.failed;
  }

  begin(): void {
    this.active = true;
  }

  end(): void {
    this.active = false;
  }

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    if (this.active) {
      this.failed += 1;
      throw new DatabaseUnavailableError(OUTAGE_REASON);
    }
    return this.inner.execute<T>(query);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.active) {
      this.failed += 1;
      throw new DatabaseUnavailableError(OUTAGE_REASON);
    }
    return this.inner.transaction(work);
  }
}

/**
 * The deterministic message-LOSS transport double for total
 * transport-provider loss drills: the provider loses EVERY message
 * (pull returns nothing, forever) while publish keeps "succeeding" —
 * the honest worst case (a provider that acknowledges and drops).
 * The durable envelopes in PostgreSQL are the ONLY recovery source.
 */
export class MessageLosingQueueTransport implements QueueTransportPort {
  private readonly published: string[] = [];
  private pullCount = 0;

  constructor(private readonly inner: QueueTransportPort) {}

  async publish(message: QueueOutboundMessage): Promise<PublishReceipt> {
    // The provider ACCEPTS the message and then loses it (bytes never
    // become deliverable). This is the transport-loss drill core.
    this.published.push(message.body);
    return this.inner.publish(message);
  }

  async pull(options?: PullOptions): Promise<PulledBatch> {
    this.pullCount += 1;
    // Deliver NOTHING: the message store was lost.
    void options;
    return { messages: [], backlogEstimate: null };
  }

  async settle(settlement: Settlement): Promise<void> {
    // Settling leases that never existed is a no-op for this double.
    void settlement;
  }

  /** How many publishes were accepted (and lost). */
  get acceptedAndLost(): number {
    return this.published.length;
  }

  /** How many pulls found nothing (the outage evidence). */
  get emptyPulls(): number {
    return this.pullCount;
  }
}
