/**
 * Queue transport port (provider-neutral asynchronous dispatch transport;
 * WORK-044 / D-03, `docs/DEPLOYMENT-ARCHITECTURE.md` §10).
 *
 * D1.0's transport model, as one owned port:
 *
 *  - `publish` hands a message body to the transport. Publication is a
 *    TRANSPORT fact only — a published message is never execution
 *    success (`spec/work-orders/WORK-044.md` invariant: "A queued message
 *    is never equivalent to execution success").
 *  - `pull` leases a batch of delivered messages. Delivery is AT-LEAST-
 *    ONCE: the same logical message MAY be delivered more than once
 *    (duplicate delivery, consumer crash before settlement, lease
 *    expiry/ack loss). Consumers must be idempotent against the
 *    authoritative application state — that idempotency lives in the
 *    PostgreSQL correlation/consumption machinery, never in the
 *    provider.
 *  - `settle` explicitly acknowledges (ack) or re-queues (retry) the
 *    leased messages. Unsettled messages become visible again after
 *    the visibility timeout — that is the crash-recovery mechanism,
 *    not an error.
 *
 * The port is PROVIDER-NEUTRAL by construction: no vendor concept
 * appears here. Lease ids are opaque handles; body is
 * an opaque string (the application defines the payload contract);
 * `attempts` is the provider-observed delivery attempt count used for
 * bounded retry decisions. Provider SDKs/types stay behind the owning
 * adapter module (pinned by architecture tests).
 *
 * Queue/provider state is NEVER application authority (D1.0 §10):
 * this port transports progress evidence only. The durable authority
 * for every dispatch — the correlation record that must exist BEFORE
 * any external message is relied upon — lives in PostgreSQL
 * (`correlation.ts`), behind the platform `DatabasePort`.
 */

/** Failure classification the adapters must produce (fail closed). */
export type QueueFailureKind = "transient" | "permanent";

/** Provider-neutral transport error. Never carries secret material. */
export class QueueTransportError extends Error {
  readonly failureKind: QueueFailureKind;
  /** HTTP status when the provider answered (for evidence only). */
  readonly status: number | null;
  /** Provider-side error code when present (for evidence only). */
  readonly providerCode: string | null;

  constructor(
    message: string,
    failureKind: QueueFailureKind,
    options?: { readonly status?: number; readonly providerCode?: string | null },
  ) {
    super(message);
    this.name = "QueueTransportError";
    this.failureKind = failureKind;
    this.status = options?.status ?? null;
    this.providerCode = options?.providerCode ?? null;
  }
}

/** Invalid transport configuration (fail closed before any wire call). */
export class QueueConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConfigError";
  }
}

/** One outbound transport message. The body is opaque to the port. */
export interface QueueOutboundMessage {
  /**
   * The message body (a serialized payload string). Providers carry it
   * opaquely; the application defines the format and verifies it on
   * consumption against the authoritative PostgreSQL correlation record.
   */
  readonly body: string;
  /** Content type of the body, when the provider can honor it. */
  readonly contentType?: string;
  /**
   * Optional delivery delay in seconds the caller requests from the
   * transport (0 = deliver as soon as possible). Bounded by the adapter.
   */
  readonly delaySeconds?: number;
}

/** Result of an accepted publication. A transport fact, NOT success. */
export interface PublishReceipt {
  /** True when the provider accepted the message for delivery. */
  readonly accepted: boolean;
}

/** One leased (delivered) message, as handed to a consumer. */
export interface QueueDelivery {
  /** Opaque provider message handle (ephemeral; never authority). */
  readonly messageId: string;
  /** Opaque lease handle used to settle this delivery. */
  readonly leaseId: string;
  /** The delivered body (the application's serialized payload). */
  readonly body: string;
  /** Content type the provider reported for the body, when present. */
  readonly contentType: string | undefined;
  /** Provider-observed delivery attempt count for this message. */
  readonly attempts: number;
  /** Provider-reported publish time (epoch milliseconds), when present. */
  readonly publishedAt: string | null;
}

/** A pulled (leased) batch of deliveries. */
export interface PulledBatch {
  readonly messages: readonly QueueDelivery[];
  /**
   * Provider-reported backlog estimate (observational only — transport
   * progress evidence, never an authority claim about executions).
   */
  readonly backlogEstimate: number | null;
}

export interface PullOptions {
  /** Maximum number of messages to lease in this pull. */
  readonly batchSize?: number;
  /**
   * Visibility timeout in milliseconds: how long unsettled messages
   * stay invisible to other consumers before redelivery.
   */
  readonly visibilityTimeoutMs?: number;
}

/** Explicit settlement of leased deliveries. */
export interface Settlement {
  /** Leases to acknowledge: processing completed (or duplicates). */
  readonly ackLeaseIds: readonly string[];
  /** Leases to re-queue for another bounded delivery attempt. */
  readonly retryLeaseIds: readonly string[];
}

/**
 * The provider-neutral queue transport port (application boundary).
 * Implementations: the production REST adapter and test doubles
 * implementing the same contract.
 */
export interface QueueTransportPort {
  /** Publish one message. Fails closed with a typed error on failure. */
  publish(message: QueueOutboundMessage): Promise<PublishReceipt>;

  /** Lease a batch of delivered messages (possibly empty). */
  pull(options?: PullOptions): Promise<PulledBatch>;

  /**
   * Explicitly settle leased deliveries (ack and/or re-queue). Idempotent
   * per lease: settling an already-settled or expired lease is a no-op
   * from the application's perspective (redelivery is the recovery path,
   * and consumption is idempotent).
   */
  settle(settlement: Settlement): Promise<void>;
}

/**
 * Bounded retry policy for the dispatch/consume machinery — repository
 * configuration, never hidden defaults, never unbounded.
 *
 * All budgets are STRICT upper bounds: reaching them produces an
 * explicit dead-letter/backlog condition (`correlation.ts`), never an
 * infinite retry loop. The replay budget bounds how many times a
 * dead-lettered dispatch may re-enter the governed path.
 */
export interface QueueRetryPolicy {
  /**
   * Maximum publish attempts for one dispatch envelope before the
   * dispatch becomes backlogged (recoverable, explicit).
   */
  readonly maxPublishAttempts: number;
  /** Maximum delivery attempts for one message before dead-letter. */
  readonly maxDeliveryAttempts: number;
  /** Maximum replays issued from one root dispatch (bounded replay). */
  readonly maxReplays: number;
  /**
   * Fixed base backoff between attempts, in milliseconds. The machinery
   * applies `base * attempt` (deterministic, bounded linear backoff —
   * no jitter, so behavior is observable and replayable in evidence).
   */
  readonly retryBackoffMs: number;
}

/** Failing closed on unbounded/non-positive retry policy is a property. */
export const MIN_RETRY_BOUND = 1;
export const MAX_RETRY_BOUND = 100;
/** The backoff base bound (milliseconds; the schedule itself caps at 60s). */
export const MAX_RETRY_BACKOFF_MS = 60_000;

/** Validate a retry policy: bounded, positive, deterministic. */
export function validateRetryPolicy(policy: QueueRetryPolicy): QueueRetryPolicy {
  const problems: string[] = [];
  for (const [name, value] of [
    ["maxPublishAttempts", policy.maxPublishAttempts],
    ["maxDeliveryAttempts", policy.maxDeliveryAttempts],
    ["maxReplays", policy.maxReplays],
  ] as const) {
    if (!Number.isInteger(value) || value < MIN_RETRY_BOUND || value > MAX_RETRY_BOUND) {
      problems.push(`${name} must be an integer in [${MIN_RETRY_BOUND}, ${MAX_RETRY_BOUND}]`);
    }
  }
  if (
    !Number.isInteger(policy.retryBackoffMs) ||
    policy.retryBackoffMs < MIN_RETRY_BOUND ||
    policy.retryBackoffMs > MAX_RETRY_BACKOFF_MS
  ) {
    problems.push(
      `retryBackoffMs must be an integer in [${MIN_RETRY_BOUND}, ${MAX_RETRY_BACKOFF_MS}]`,
    );
  }
  if (problems.length > 0) {
    throw new QueueConfigError(`invalid queue retry policy: ${problems.join("; ")}`);
  }
  return policy;
}

/** Deterministic bounded backoff between attempts (milliseconds). */
export function backoffDelayMs(policy: QueueRetryPolicy, nextAttempt: number): number {
  const attempt = Math.max(1, nextAttempt);
  return Math.min(policy.retryBackoffMs * attempt, 60_000);
}

/**
 * The governed-effect seam: how a consumed delivery re-enters the
 * EXISTING governed execution path.
 *
 * The platform transport machinery never imports domain modules
 * (platform isolation). The composition root wires an implementation
 * of this seam (the executions module adapter
 * `src/modules/executions/adapters/transport-effect.ts`) that applies
 * the authoritative mutation through the single execution write path,
 * with ALL admission gates intact (policy, budget, capability, state
 * legality). The seam is the entire integration surface between the
 * transport and the execution authority.
 */
export interface GovernedDispatchDelivery {
  /** The authoritative correlation record for this delivery. */
  readonly envelope: DispatchEnvelope;
}

export type GovernedEffectOutcome =
  | { readonly outcome: "applied"; readonly detail?: string }
  | { readonly outcome: "already-applied"; readonly detail?: string }
  | {
      /** The governed path itself rejected the delivery (permanent). */
      readonly outcome: "rejected";
      readonly reason: string;
    };

export interface GovernedDispatchEffect {
  /**
   * Apply the authoritative effect for one resolved delivery. MUST be
   * idempotent: the transport delivers at-least-once, so the SAME
   * correlation may be handed over more than once (duplicate delivery,
   * crash-after-mutation-before-ack, ack loss). The implementation
   * converges through the existing PostgreSQL idempotency semantics —
   * a repeated handoff replays the durable outcome, never a second
   * authoritative effect.
   *
   * Transient failures (e.g. authoritative database unavailability)
   * propagate as exceptions; the transport machinery retries them
   * within the bounded delivery budget. A thrown error is NEVER
   * interpreted as success.
   */
  apply(delivery: GovernedDispatchDelivery, idempotencyKey: string): Promise<GovernedEffectOutcome>;
}

/**
 * The durable dispatch correlation record (read shape).
 *
 * One row exists in PostgreSQL for every durable dispatch BEFORE any
 * external message is relied upon. This is TRANSPORT PROGRESS state
 * only — it never defines execution status; the authoritative
 * execution lifecycle stays in the executions module's single write
 * path. The vocabulary below is deliberately disjoint from the
 * execution state vocabulary (no second state machine).
 */
export interface DispatchEnvelope {
  readonly id: string;
  /**
   * Stable authoritative correlation identity (deterministic, unique).
   * The transport message carries this key; consumption resolves the
   * envelope from PostgreSQL by it — provider state is never authority.
   */
  readonly correlationKey: string;
  /** Dispatch purpose (e.g. "execution-dispatch"). */
  readonly purpose: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /**
   * The secret-free transport payload (the message body). Correlation
   * pointer semantics: ids and provenance only, resolved against
   * PostgreSQL on consumption.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** sha256 of the canonical payload (provenance without trust). */
  readonly payloadDigest: string;
  /** Transport progress state (see DISPATCH_ENVELOPE_STATES). */
  readonly state: DispatchEnvelopeState;
  /** Authoritative-consume marker: the governed effect was applied. */
  readonly appliedAt: string | null;
  /** The durable operation key that applied the governed effect. */
  readonly appliedOperationKey: string | null;
  /** Publish attempts consumed so far (bounded by the retry policy). */
  readonly publishAttempts: number;
  /** Delivery attempts observed so far (bounded by the retry policy). */
  readonly deliveryAttempts: number;
  /** Provenance chain: the envelope this one replays, when a replay. */
  readonly replayOf: string | null;
  /** Replays issued from this envelope (bounded by policy). */
  readonly replayCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Transport progress states. NOT execution states: `consumed` here
 * means "the transport finished carrying this dispatch" — the
 * execution's own status is authoritative and separate. The consumer
 * never maps between the two vocabularies.
 */
export const DISPATCH_ENVELOPE_STATES = [
  /** Durable intent committed; publication not yet attempted/accepted. */
  "recorded",
  /** Provider accepted the message; delivery may happen. */
  "published",
  /** Publish attempts exhausted against an unavailable provider; recoverable. */
  "backlogged",
  /** Effect applied AND message settled — the transport's terminal success. */
  "consumed",
  /** Bounded failure: delivery/publish budget exhausted or governed rejection. */
  "dead-lettered",
] as const;

export type DispatchEnvelopeState = (typeof DISPATCH_ENVELOPE_STATES)[number];

export function isDispatchEnvelopeState(value: string): value is DispatchEnvelopeState {
  return (DISPATCH_ENVELOPE_STATES as readonly string[]).includes(value);
}

/**
 * The stable correlation identity for a dispatch. Deterministic so the
 * SAME logical dispatch (same execution, same purpose, same lineage
 * ordinal) always correlates to the SAME key — the duplicate-suppression
 * and idempotency anchor.
 */
export function executionDispatchCorrelationKey(
  executionId: string,
  options?: { readonly replayOrdinal?: number },
): string {
  const ordinal = options?.replayOrdinal ?? 0;
  return ordinal === 0
    ? `execution-dispatch:${executionId}`
    : `execution-dispatch:${executionId}:replay-${ordinal}`;
}

/** The deterministic consume idempotency key for one correlation. */
export function consumeIdempotencyKey(correlationKey: string): string {
  return `queue-consume:${correlationKey}`;
}

/**
 * Canonical payload digest: sha256 over the canonical JSON (sorted
 * keys) of the payload. Two payloads are the same logical message iff
 * their digests are byte-equal — mismatch on consumption is a
 * fail-closed integrity signal (the message does not match the
 * authoritative record).
 */
export function canonicalPayloadJson(payload: Readonly<Record<string, unknown>>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sorted);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]);
    }
    return value;
  };
  return JSON.stringify(sorted(payload));
}

/** The pointer payload the dispatcher builds (secret-free by construction). */
export type ExecutionDispatchPayload = {
  readonly v: 1;
  /** The authoritative correlation key — the consumption lookup handle. */
  readonly correlationKey: string;
  readonly purpose: "execution-dispatch";
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly dispatchedAt: string;
};
