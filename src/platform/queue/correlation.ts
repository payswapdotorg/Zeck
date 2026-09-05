/**
 * Durable dispatch correlation store (WORK-044 / D-03) over the
 * provider-neutral platform `DatabasePort`.
 *
 * THE AUTHORITY SIDE OF THE TRANSPORT: every dispatch envelope is a
 * PostgreSQL row committed BEFORE the external queue message is
 * published or relied upon. The transport message carries only a
 * correlation pointer (ids + provenance digest); consumption resolves
 * the authoritative record HERE — provider state is never authority
 * (`docs/DEPLOYMENT-ARCHITECTURE.md` §10, `spec/work-orders/WORK-044.md`
 * invariant 1/2/4).
 *
 * This is TRANSPORT PROGRESS state, not execution state: the
 * envelope vocabulary (recorded/published/backlogged/consumed/
 * dead-lettered) never maps to execution status and never feeds the
 * execution lifecycle — there is no second state machine. The
 * physical schema (migration 0026) pins the vocabulary, the legal
 * transitions, terminal immutability, append-only evidence and the
 * tenant/execution FK discipline.
 *
 * Idempotency anchors:
 *  - `recordIntent` is idempotent by the deterministic correlation
 *    key (unique): the same logical dispatch yields ONE envelope;
 *  - `markConsumed` is write-once by state (published → consumed)
 *    and records the deterministic consume operation key;
 *  - every failure/dead-letter path is bounded by the retry policy
 *    passed in — no unbounded counters exist in this module.
 *
 * No driver import: `pg` is owned by `src/platform/db/` (SDK
 * boundary table). Detail strings are scrubbed by the caller; this
 * store caps their length at the schema bound.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabasePort } from "../db/port";
import {
  type DispatchEnvelope,
  type DispatchEnvelopeState,
  QueueConfigError,
  type QueueRetryPolicy,
} from "./port";

/** sha256 hex digest of the canonical payload JSON. */
export function payloadDigestOf(payload: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(
    (function sorted(value: unknown): unknown {
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
    })(payload),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface DispatchIntentInput {
  readonly id: string;
  readonly correlationKey: string;
  readonly purpose: "execution-dispatch";
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /** Secret-free pointer payload (ids + provenance only). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  /** Root envelope id when this intent is a bounded replay. */
  readonly replayOf: string | null;
}

export interface RecordIntentResult {
  readonly envelope: DispatchEnvelope;
  /** False when a previous identical intent's durable record replayed. */
  readonly created: boolean;
}

export type DeadLetterReason =
  | "delivery-exhausted"
  | "publish-rejected"
  | "payload-mismatch"
  | "governed-rejection"
  | "unknown-envelope";

export interface AttemptEvidence {
  readonly stage: "publish" | "delivery" | "settle";
  readonly attemptNo: number;
  readonly outcome: "accepted" | "transient-failure" | "permanent-failure";
  readonly detail: string | null;
}

interface EnvelopeRow {
  readonly id: string;
  readonly correlation_key: string;
  readonly purpose: string;
  readonly tenant_id: string;
  readonly application_id: string;
  readonly execution_id: string;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly state: DispatchEnvelopeState;
  readonly applied_at: Date | string | null;
  readonly applied_operation_key: string | null;
  readonly publish_attempts: number;
  readonly delivery_attempts: number;
  readonly replay_of: string | null;
  readonly replay_count: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const iso = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
};

function toEnvelope(row: EnvelopeRow): DispatchEnvelope {
  return {
    id: row.id,
    correlationKey: row.correlation_key,
    purpose: row.purpose,
    tenantId: row.tenant_id,
    applicationId: row.application_id,
    executionId: row.execution_id,
    payload: row.payload,
    payloadDigest: row.payload_digest,
    state: row.state,
    appliedAt: iso(row.applied_at),
    appliedOperationKey: row.applied_operation_key,
    publishAttempts: row.publish_attempts,
    deliveryAttempts: row.delivery_attempts,
    replayOf: row.replay_of,
    replayCount: row.replay_count,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

const ENVELOPE_SELECT = `
SELECT e.*, (SELECT count(*) FROM queue_transport.dispatch_envelopes r WHERE r.replay_of = e.id) AS replay_count
FROM queue_transport.dispatch_envelopes e`;

/** Scrub/cap a detail string at the schema bound (defense in depth). */
function cappedDetail(detail: string | null): string | null {
  if (detail === null) {
    return null;
  }
  return detail.slice(0, 500);
}

export class QueueCorrelationStore {
  constructor(private readonly db: DatabasePort) {}

  /**
   * Durable dispatch intent — the BEFORE-publish record. Idempotent
   * by correlation key: a repeated identical intent replays the
   * existing durable record (created: false) instead of creating a
   * second envelope. The caller MUST commit this before publishing.
   */
  async recordIntent(input: DispatchIntentInput): Promise<RecordIntentResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO queue_transport.dispatch_envelopes
  (id, correlation_key, purpose, tenant_id, application_id, execution_id, payload, payload_digest, state, replay_of)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'recorded', $9)
ON CONFLICT (correlation_key) DO NOTHING`,
        parameters: [
          input.id,
          input.correlationKey,
          input.purpose,
          input.tenantId,
          input.applicationId,
          input.executionId,
          JSON.stringify(input.payload),
          input.payloadDigest,
          input.replayOf,
        ],
      });
      const found = await tx.execute<EnvelopeRow>({
        sql: `${ENVELOPE_SELECT} WHERE e.correlation_key = $1`,
        parameters: [input.correlationKey],
      });
      const row = found.rows[0];
      if (row === undefined) {
        throw new QueueConfigError(
          "dispatch envelope vanished after recordIntent (correlation key unique)",
        );
      }
      return { envelope: toEnvelope(row), created: row.id === input.id };
    });
  }

  async findByCorrelationKey(correlationKey: string): Promise<DispatchEnvelope | null> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `${ENVELOPE_SELECT} WHERE e.correlation_key = $1`,
      parameters: [correlationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEnvelope(row);
  }

  async findById(id: string): Promise<DispatchEnvelope | null> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `${ENVELOPE_SELECT} WHERE e.id = $1`,
      parameters: [id],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEnvelope(row);
  }

  /**
   * Publication accepted by the provider. Transport fact only — the
   * execution's status is untouched (a published message is not
   * success). Records the attempt evidence atomically.
   */
  async markPublishAccepted(id: string, evidence: AttemptEvidence): Promise<DispatchEnvelope> {
    return this.transitionAtomically(id, ["recorded", "backlogged"], async (tx) => {
      await tx.execute({
        sql: `UPDATE queue_transport.dispatch_envelopes
SET state = 'published', publish_attempts = $2, updated_at = now()
WHERE id = $1`,
        parameters: [id, evidence.attemptNo],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * Publication failed. Transient failures exhaust into `backlogged`
   * (provider unavailable — recoverable, explicit); a permanent
   * rejection dead-letters immediately (retrying an unauthorized
   * publication is unbounded waste, not recovery).
   */
  async recordPublishFailure(
    id: string,
    evidence: AttemptEvidence,
    policy: QueueRetryPolicy,
  ): Promise<DispatchEnvelope> {
    if (evidence.stage !== "publish") {
      throw new QueueConfigError("recordPublishFailure expects publish-stage evidence");
    }
    const exhausted = evidence.attemptNo >= policy.maxPublishAttempts;
    if (evidence.outcome === "permanent-failure") {
      return this.transitionAtomically(id, ["recorded", "backlogged"], async (tx) => {
        await tx.execute({
          sql: `UPDATE queue_transport.dispatch_envelopes
SET state = 'dead-lettered', publish_attempts = $2, dead_lettered_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id, evidence.attemptNo],
        });
        await insertAttempt(tx, id, evidence);
        await insertDeadLetter(tx, id, "publish-rejected", evidence.attemptNo, evidence.detail);
      });
    }
    return this.transitionAtomically(id, ["recorded", "backlogged"], async (tx) => {
      await tx.execute({
        sql: `UPDATE queue_transport.dispatch_envelopes
SET publish_attempts = $2${exhausted ? ", state = 'backlogged', updated_at = now()" : ", updated_at = now()"} WHERE id = $1`,
        parameters: [id, evidence.attemptNo],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * The governed effect was applied (or replayed as already-applied)
   * and the delivery is being settled: the transport's terminal
   * success. Write-once by state; records the deterministic consume
   * operation key for the idempotency evidence chain.
   */
  async markConsumed(
    id: string,
    operationKey: string,
    evidence: AttemptEvidence,
  ): Promise<DispatchEnvelope> {
    return this.transitionAtomically(id, ["published"], async (tx) => {
      await tx.execute({
        sql: `UPDATE queue_transport.dispatch_envelopes
SET state = 'consumed', applied_at = now(), applied_operation_key = $2, consumed_at = now(), delivery_attempts = $3, updated_at = now()
WHERE id = $1`,
        parameters: [id, operationKey, evidence.attemptNo],
      });
      await insertAttempt(tx, id, { ...evidence, outcome: "accepted" });
    });
  }

  /**
   * A delivery attempt failed. Transient failures keep the envelope
   * publishable/retriable while the bounded delivery budget lasts;
   * exhaustion (or a governed rejection) dead-letters explicitly —
   * never an infinite retry loop.
   */
  async recordDeliveryFailure(
    id: string,
    evidence: AttemptEvidence,
    policy: QueueRetryPolicy,
    options?: { readonly governedRejection?: string },
  ): Promise<DispatchEnvelope> {
    if (evidence.stage !== "delivery") {
      throw new QueueConfigError("recordDeliveryFailure expects delivery-stage evidence");
    }
    const deadLetter =
      options?.governedRejection !== undefined ||
      evidence.outcome === "permanent-failure" ||
      evidence.attemptNo >= policy.maxDeliveryAttempts;
    return this.transitionAtomically(id, ["published"], async (tx) => {
      if (deadLetter) {
        await tx.execute({
          sql: `UPDATE queue_transport.dispatch_envelopes
SET state = 'dead-lettered', delivery_attempts = $2, dead_lettered_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id, evidence.attemptNo],
        });
        await insertAttempt(tx, id, evidence);
        await insertDeadLetter(
          tx,
          id,
          options?.governedRejection !== undefined ? "governed-rejection" : "delivery-exhausted",
          evidence.attemptNo,
          options?.governedRejection ?? evidence.detail,
        );
      } else {
        await tx.execute({
          sql: `UPDATE queue_transport.dispatch_envelopes
SET delivery_attempts = $2, updated_at = now()
WHERE id = $1`,
          parameters: [id, evidence.attemptNo],
        });
        await insertAttempt(tx, id, evidence);
      }
    });
  }

  /**
   * Dead-letter with an explicit reason (payload integrity mismatch:
   * the delivered message does not match the authoritative record).
   */
  async deadLetter(
    id: string,
    reason: DeadLetterReason,
    attempts: number,
    detail: string | null,
  ): Promise<DispatchEnvelope> {
    return this.transitionAtomically(id, ["recorded", "published", "backlogged"], async (tx) => {
      await tx.execute({
        sql: `UPDATE queue_transport.dispatch_envelopes
SET state = 'dead-lettered', dead_lettered_at = now(), updated_at = now()
WHERE id = $1`,
        parameters: [id],
      });
      await insertDeadLetter(tx, id, reason, attempts, detail);
    });
  }

  /**
   * Dead-letter EVIDENCE for an already-terminal envelope (e.g. a
   * tampered duplicate arriving after completion): the immutable
   * failure record is appended WITHOUT touching the terminal state —
   * the evidence exists, history is never rewritten.
   */
  async recordDeadLetterEvidence(
    id: string,
    reason: DeadLetterReason,
    attempts: number,
    detail: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const guard = await tx.execute<{ state: DispatchEnvelopeState }>({
        sql: `SELECT state FROM queue_transport.dispatch_envelopes WHERE id = $1`,
        parameters: [id],
      });
      if (guard.rows[0] === undefined) {
        throw new QueueConfigError(`dispatch envelope ${id} does not exist`);
      }
      await insertDeadLetter(tx, id, reason, attempts, detail);
    });
  }

  /** Replays issued from the root envelope (bounded by policy). */
  async countReplays(rootId: string): Promise<number> {
    const result = await this.db.execute<{ count: string | number }>({
      sql: `SELECT count(*) AS count FROM queue_transport.dispatch_envelopes WHERE replay_of = $1`,
      parameters: [rootId],
    });
    const raw = result.rows[0]?.count;
    return raw === undefined ? 0 : Number(raw);
  }

  /** All replay envelopes of the root, in lineage-ordinal order. */
  async listReplays(rootId: string): Promise<readonly DispatchEnvelope[]> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `${ENVELOPE_SELECT} WHERE e.replay_of = $1 ORDER BY e.correlation_key ASC`,
      parameters: [rootId],
    });
    return result.rows.map(toEnvelope);
  }

  /**
   * Recovery scan: envelopes whose durable intent exists but whose
   * publication never succeeded (crash between intent and publish,
   * or provider outage exhaustion). Ordered oldest-first.
   */
  async republishable(limit: number): Promise<readonly DispatchEnvelope[]> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `${ENVELOPE_SELECT}
WHERE e.state IN ('recorded', 'backlogged')
ORDER BY e.created_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map(toEnvelope);
  }

  /** Run one atomic multi-statement transition guarded by expected states. */
  private async transitionAtomically(
    id: string,
    expectedStates: readonly DispatchEnvelopeState[],
    work: (tx: {
      execute<T = Record<string, unknown>>(query: {
        readonly sql: string;
        readonly parameters?: readonly unknown[];
      }): Promise<{ rows: readonly T[]; rowCount: number }>;
    }) => Promise<void>,
  ): Promise<DispatchEnvelope> {
    await this.db.transaction(async (tx) => {
      const guard = await tx.execute<{ state: DispatchEnvelopeState }>({
        sql: `SELECT state FROM queue_transport.dispatch_envelopes WHERE id = $1 FOR UPDATE`,
        parameters: [id],
      });
      const row = guard.rows[0];
      if (row === undefined) {
        throw new QueueConfigError(`dispatch envelope ${id} does not exist`);
      }
      if (!expectedStates.includes(row.state)) {
        throw new QueueConfigError(
          `dispatch envelope ${id} is ${row.state}; expected ${expectedStates.join(" or ")}`,
        );
      }
      await work(tx);
    });
    const after = await this.findById(id);
    if (after === null) {
      throw new QueueConfigError(`dispatch envelope ${id} vanished mid-transition`);
    }
    return after;
  }
}

type TxLike = Parameters<Parameters<QueueCorrelationStore["transitionAtomically"]>[2]>[0];

async function insertAttempt(
  tx: TxLike,
  envelopeId: string,
  evidence: AttemptEvidence,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO queue_transport.transport_attempts (envelope_id, stage, attempt_no, outcome, detail)
VALUES ($1, $2, $3, $4, $5)`,
    parameters: [
      envelopeId,
      evidence.stage,
      evidence.attemptNo,
      evidence.outcome,
      cappedDetail(evidence.detail),
    ],
  });
}

async function insertDeadLetter(
  tx: TxLike,
  envelopeId: string,
  reason: DeadLetterReason,
  attempts: number,
  detail: string | null,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO queue_transport.dead_letters (id, envelope_id, reason, attempts, detail)
VALUES ($1, $2, $3, $4, $5)`,
    parameters: [randomUUID(), envelopeId, reason, attempts, cappedDetail(detail)],
  });
}
