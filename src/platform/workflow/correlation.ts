/**
 * Durable orchestration correlation store (WORK-045 / D-04) over the
 * provider-neutral platform `DatabasePort`.
 *
 * THE AUTHORITY SIDE OF THE ORCHESTRATION: every orchestration wait
 * is a PostgreSQL row committed BEFORE any provider workflow instance
 * is created or relied upon. The provider instance receives only a
 * correlation pointer (ids + provenance digest); every continuation
 * path (callback, approval, deadline, restart recovery) resolves the
 * authoritative record HERE — provider state is never authority
 * (`docs/DEPLOYMENT-ARCHITECTURE.md` §10, `spec/work-orders/WORK-045.md`
 * invariants).
 *
 * This is ORCHESTRATION PROGRESS state, not execution state: the
 * wait vocabulary (recorded/deferred/armed/signaled/settled/elapsed/
 * superseded/abandoned) never maps to execution status and never
 * feeds the execution lifecycle — there is no second state machine.
 * The physical schema (migration 0027) pins the vocabulary, the legal
 * transitions, terminal immutability, append-only evidence and the
 * tenant/execution FK discipline.
 *
 * Idempotency anchors:
 *  - `recordWaitIntent` is idempotent by the deterministic wait key
 *    (unique): the same logical wait yields ONE row;
 *  - `recordNotification` is idempotent by (wait, notification key):
 *    duplicate delivery converges to the SAME durable row (outcome
 *    `duplicate`), never a second authoritative effect;
 *  - terminal wait rows are immutable — bounded replacement creates
 *    NEW wait rows (flat lineage, `replacement_of` = root), never
 *    edits history;
 *  - retained notifications are bounded per wait by the state
 *    bounds: beyond the bound, refused notifications only increment
 *    the durable `folded_notifications` counter (bounded state by
 *    construction, inspectable compaction).
 *
 * No driver import: `pg` is owned by `src/platform/db/` (SDK
 * boundary table). Detail strings are scrubbed by the caller; this
 * store caps their length at the schema bound. Notification payload
 * BYTES are never stored — only the sha256 digest (reference-only
 * payloads; large bytes never enter orchestration state).
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabasePort } from "../db/port";
import {
  type NotificationOutcome,
  type OrchestrationWait,
  type OrchestrationWaitKind,
  type OrchestrationWaitState,
  WorkflowConfigError,
  type WorkflowRetryPolicy,
  type WorkflowStateBounds,
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

export interface RecordWaitIntentInput {
  readonly id: string;
  readonly waitKey: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly waitKind: OrchestrationWaitKind;
  readonly waitOrdinal: number;
  /** Root wait id when this intent is a bounded replacement. */
  readonly replacementOf: string | null;
  /** REFERENCE-ONLY pointer payload (ids + provenance only). */
  readonly pointerPayload: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly deadline: string | null;
}

export interface RecordWaitIntentResult {
  readonly wait: OrchestrationWait;
  /** False when a previous identical intent's durable record replayed. */
  readonly created: boolean;
}

export interface RecordNotificationInput {
  readonly waitId: string;
  /** The stable logical identity of this notification (dedup key). */
  readonly notificationKey: string;
  readonly kind: "callback" | "approval";
  readonly decision: "approve" | "reject" | null;
  readonly approverId: string | null;
  /** sha256 of the notification payload (bytes never stored). */
  readonly payloadDigest: string;
  /** The outcome the engine already decided for this delivery. */
  readonly outcome: NotificationOutcome;
  readonly detail: string | null;
}

export interface AttemptEvidence {
  readonly stage: "start" | "signal" | "observe" | "terminate" | "effect";
  readonly attemptNo: number;
  readonly outcome: "accepted" | "transient-failure" | "permanent-failure";
  readonly detail: string | null;
}

/** Bounded-failure reasons surfaced on abandoned waits (explicit). */
export const ABANDON_REASONS = [
  "start-rejected",
  "effect-exhausted",
  "governed-rejection",
  "provider-reported-errored",
  "provider-reported-terminated",
  "replaced",
] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

interface WaitRow {
  readonly id: string;
  readonly wait_key: string;
  readonly tenant_id: string;
  readonly application_id: string;
  readonly execution_id: string;
  readonly wait_kind: string;
  readonly wait_ordinal: number;
  readonly replacement_of: string | null;
  readonly pointer_payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly deadline: Date | string | null;
  readonly state: OrchestrationWaitState;
  readonly provider_instance_id: string | null;
  readonly provider_observed_status: string | null;
  readonly provider_observed_at: Date | string | null;
  readonly provider_terminated_at: Date | string | null;
  readonly start_attempts: number;
  readonly signal_delivery_attempts: number;
  readonly retained_notifications: number;
  readonly folded_notifications: number;
  readonly applied_operation_key: string | null;
  readonly applied_at: Date | string | null;
  readonly settled_at: Date | string | null;
  readonly elapsed_at: Date | string | null;
  readonly superseded_at: Date | string | null;
  readonly abandoned_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : String(value);

function toWait(row: WaitRow): OrchestrationWait {
  return {
    id: row.id,
    waitKey: row.wait_key,
    tenantId: row.tenant_id,
    applicationId: row.application_id,
    executionId: row.execution_id,
    waitKind: row.wait_kind as OrchestrationWaitKind,
    waitOrdinal: row.wait_ordinal,
    replacementOf: row.replacement_of,
    pointerPayload: row.pointer_payload,
    payloadDigest: row.payload_digest,
    deadline: iso(row.deadline),
    state: row.state,
    providerInstanceId: row.provider_instance_id,
    providerObservedStatus: row.provider_observed_status,
    providerObservedAt: iso(row.provider_observed_at),
    providerTerminatedAt: iso(row.provider_terminated_at),
    startAttempts: row.start_attempts,
    signalDeliveryAttempts: row.signal_delivery_attempts,
    retainedNotifications: row.retained_notifications,
    foldedNotifications: row.folded_notifications,
    appliedOperationKey: row.applied_operation_key,
    appliedAt: iso(row.applied_at),
    settledAt: iso(row.settled_at),
    elapsedAt: iso(row.elapsed_at),
    supersededAt: iso(row.superseded_at),
    abandonedAt: iso(row.abandoned_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

const WAIT_SELECT = `
SELECT w.*, (SELECT count(*) FROM workflow_orchestration.waits r WHERE r.replacement_of = w.id) AS replacement_count
FROM workflow_orchestration.waits w`;

/**
 * The notification-joined wait select: wait columns PLUS the joined
 * accepted-notification columns (the recovery scans reconstruct the
 * resolution cause from durable state).
 */
const WAIT_SELECT_WITH_NOTIFICATION = `
SELECT w.*, n.notification_key, n.kind AS notification_kind, n.decision AS notification_decision, n.approver_id AS notification_approver, (SELECT count(*) FROM workflow_orchestration.waits r WHERE r.replacement_of = w.id) AS replacement_count
FROM workflow_orchestration.waits w`;

/** Scrub/cap a detail string at the schema bound (defense in depth). */
function cappedDetail(detail: string | null): string | null {
  return detail === null ? null : detail.slice(0, 500);
}

type TxLike = {
  execute<T = Record<string, unknown>>(query: {
    readonly sql: string;
    readonly parameters?: readonly unknown[];
  }): Promise<{ rows: readonly T[]; rowCount: number }>;
};

export class WorkflowCorrelationStore {
  constructor(private readonly db: DatabasePort) {}

  /**
   * Durable wait intent — the BEFORE-instance record. Idempotent by
   * the deterministic wait key: a repeated identical intent replays
   * the existing durable record (created: false) instead of creating
   * a second wait. The caller MUST commit this before starting any
   * provider instance.
   */
  async recordWaitIntent(input: RecordWaitIntentInput): Promise<RecordWaitIntentResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO workflow_orchestration.waits
  (id, wait_key, tenant_id, application_id, execution_id, wait_kind, wait_ordinal, replacement_of, pointer_payload, payload_digest, deadline, state)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'recorded')
ON CONFLICT (wait_key) DO NOTHING`,
        parameters: [
          input.id,
          input.waitKey,
          input.tenantId,
          input.applicationId,
          input.executionId,
          input.waitKind,
          input.waitOrdinal,
          input.replacementOf,
          JSON.stringify(input.pointerPayload),
          input.payloadDigest,
          input.deadline,
        ],
      });
      const found = await tx.execute<WaitRow>({
        sql: `${WAIT_SELECT} WHERE w.wait_key = $1`,
        parameters: [input.waitKey],
      });
      const row = found.rows[0];
      if (row === undefined) {
        throw new WorkflowConfigError(
          "orchestration wait vanished after recordWaitIntent (wait key unique)",
        );
      }
      return { wait: toWait(row), created: row.id === input.id };
    });
  }

  async findWaitByKey(waitKey: string): Promise<OrchestrationWait | null> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT} WHERE w.wait_key = $1`,
      parameters: [waitKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toWait(row);
  }

  async findWaitById(id: string): Promise<OrchestrationWait | null> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT} WHERE w.id = $1`,
      parameters: [id],
    });
    const row = result.rows[0];
    return row === undefined ? null : toWait(row);
  }

  /** The live (non-terminal) wait of one execution + kind, if any. */
  async findLiveWait(
    executionId: string,
    waitKind: OrchestrationWaitKind,
  ): Promise<OrchestrationWait | null> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.execution_id = $1 AND w.wait_kind = $2 AND w.state NOT IN ('settled', 'elapsed', 'superseded', 'abandoned')
ORDER BY w.wait_ordinal DESC LIMIT 1`,
      parameters: [executionId, waitKind],
    });
    const row = result.rows[0];
    return row === undefined ? null : toWait(row);
  }

  async listWaitsByExecution(executionId: string): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT} WHERE w.execution_id = $1 ORDER BY w.wait_key ASC`,
      parameters: [executionId],
    });
    return result.rows.map(toWait);
  }

  /**
   * The instance started and the wait armed. Transport fact only —
   * the execution's status is untouched (an armed instance is not
   * progress). Records the attempt evidence atomically.
   */
  async markArmed(
    id: string,
    providerInstanceId: string,
    evidence: AttemptEvidence,
  ): Promise<OrchestrationWait> {
    return this.transitionAtomically(id, ["recorded", "deferred"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET state = 'armed', provider_instance_id = $2, start_attempts = $3, updated_at = now()
WHERE id = $1`,
        parameters: [id, providerInstanceId, evidence.attemptNo],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * Instance start failed. Transient failures exhaust into `deferred`
   * (provider unavailable — recoverable, the declared
   * orchestration-paused degradation); a permanent rejection
   * abandons immediately (retrying an unauthorized start is
   * unbounded waste, not recovery).
   */
  async recordStartFailure(
    id: string,
    evidence: AttemptEvidence,
    policy: WorkflowRetryPolicy,
  ): Promise<OrchestrationWait> {
    if (evidence.stage !== "start") {
      throw new WorkflowConfigError("recordStartFailure expects start-stage evidence");
    }
    const exhausted = evidence.attemptNo >= policy.maxStartAttempts;
    if (evidence.outcome === "permanent-failure") {
      return this.transitionAtomically(id, ["recorded", "deferred"], async (tx) => {
        await tx.execute({
          sql: `UPDATE workflow_orchestration.waits
SET state = 'abandoned', start_attempts = $2, abandoned_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id, evidence.attemptNo],
        });
        await insertAttempt(tx, id, evidence);
        await insertAbandonDetail(tx, id, "start-rejected");
      });
    }
    return this.transitionAtomically(id, ["recorded", "deferred"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET start_attempts = $2${exhausted ? ", state = 'deferred', updated_at = now()" : ", updated_at = now()"} WHERE id = $1`,
        parameters: [id, evidence.attemptNo],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * Record a provider-observed instance status (evidence only —
   * never a state transition, never an authority claim). Provider
   * reports that the instance errored/terminated are surfaced
   * separately by the engine as explicit abandon conditions.
   */
  async recordObservation(
    id: string,
    observedStatus: string,
    evidence: AttemptEvidence,
  ): Promise<OrchestrationWait> {
    return this.transitionAtomically(
      id,
      ["recorded", "deferred", "armed", "signaled"],
      async (tx) => {
        await tx.execute({
          sql: `UPDATE workflow_orchestration.waits
SET provider_observed_status = $2, provider_observed_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id, observedStatus],
        });
        await insertAttempt(tx, id, evidence);
      },
    );
  }

  /**
   * Record one intake notification (callback / approval decision)
   * against the authoritative wait. Idempotent by the (wait,
   * notification key): a duplicate delivery replays the SAME durable
   * row with outcome `duplicate` — never a second resolution.
   *
   * Bounded retention: when the wait already holds
   * `maxRetainedNotifications` rows, a REFUSED notification does not
   * materialize a row at all — the durable folded counter increments
   * instead (compaction by construction). ACCEPTED and DUPLICATE
   * outcomes are never folded (they are the resolution itself).
   */
  async recordNotification(
    input: RecordNotificationInput,
    bounds: WorkflowStateBounds,
  ): Promise<{ readonly outcome: NotificationOutcome; readonly folded: boolean }> {
    return this.db.transaction(async (tx) => {
      const guard = await tx.execute<WaitRow>({
        sql: `SELECT * FROM workflow_orchestration.waits WHERE id = $1 FOR UPDATE`,
        parameters: [input.waitId],
      });
      const wait = guard.rows[0];
      if (wait === undefined) {
        throw new WorkflowConfigError(`orchestration wait ${input.waitId} does not exist`);
      }
      const existing = await tx.execute<{
        notification_key: string;
        outcome: string;
        decision: string | null;
      }>({
        sql: `SELECT notification_key, outcome, decision FROM workflow_orchestration.notifications
WHERE wait_id = $1 AND notification_key = $2`,
        parameters: [input.waitId, input.notificationKey],
      });
      const prior = existing.rows[0];
      if (prior !== undefined) {
        // Deterministic duplicate convergence: the SAME logical
        // notification replays its durable outcome, no new row.
        return { outcome: "duplicate", folded: false };
      }
      try {
        return await this.insertNotification(tx, wait, input, bounds);
      } catch (error) {
        if (error instanceof Error && (error as { readonly code?: string }).code === "23505") {
          // The one-accepted-notification-per-wait physical guard
          // raced: the first resolution already won (converge).
          return { outcome: "duplicate", folded: false };
        }
        throw error;
      }
    });
  }

  private async insertNotification(
    tx: TxLike,
    wait: WaitRow,
    input: RecordNotificationInput,
    bounds: WorkflowStateBounds,
  ): Promise<{ readonly outcome: NotificationOutcome; readonly folded: boolean }> {
    if (
      Number(wait.retained_notifications) >= bounds.maxRetainedNotifications &&
      input.outcome !== "accepted"
    ) {
      // Bounded retention: refused notifications fold into the
      // durable counter instead of materializing rows.
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET folded_notifications = folded_notifications + 1, updated_at = now()
WHERE id = $1`,
        parameters: [input.waitId],
      });
      return { outcome: input.outcome, folded: true };
    }
    await tx.execute({
      sql: `INSERT INTO workflow_orchestration.notifications
  (wait_id, notification_key, kind, decision, approver_id, payload_digest, outcome, detail)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      parameters: [
        input.waitId,
        input.notificationKey,
        input.kind,
        input.decision,
        input.approverId,
        input.payloadDigest,
        input.outcome,
        cappedDetail(input.detail),
      ],
    });
    await tx.execute({
      sql: `UPDATE workflow_orchestration.waits
SET retained_notifications = retained_notifications + 1, updated_at = now()
WHERE id = $1`,
      parameters: [input.waitId],
    });
    return { outcome: input.outcome, folded: false };
  }

  /**
   * The resolving notification is durably recorded: the wait moves to
   * `signaled` (the governed effect is pending). First resolution
   * wins — a recorded resolution is never displaced. Idempotent: a
   * wait already signaled stays signaled (duplicate convergence).
   */
  async markSignaled(id: string, evidence: AttemptEvidence): Promise<OrchestrationWait> {
    return this.transitionAtomically(id, ["armed", "signaled"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits SET state = 'signaled', updated_at = now() WHERE id = $1`,
        parameters: [id],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /** The governed effect was applied and the wait settled (terminal). */
  async markSettled(
    id: string,
    operationKey: string,
    evidence: AttemptEvidence,
  ): Promise<OrchestrationWait> {
    return this.transitionAtomically(id, ["signaled"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET state = 'settled', applied_operation_key = $2, applied_at = now(), settled_at = now(), updated_at = now()
WHERE id = $1`,
        parameters: [id, operationKey],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * The deadline passed and the governed expiration was applied
   * through the single execution write path (terminal).
   */
  async markElapsed(
    id: string,
    operationKey: string,
    evidence: AttemptEvidence,
  ): Promise<OrchestrationWait> {
    return this.transitionAtomically(id, ["armed"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET state = 'elapsed', applied_operation_key = $2, applied_at = now(), elapsed_at = now(), updated_at = now()
WHERE id = $1`,
        parameters: [id, operationKey],
      });
      await insertAttempt(tx, id, evidence);
    });
  }

  /**
   * The wait is stale: the execution moved on by another governed
   * path. Terminal, no effect ever fires for this wait.
   */
  async markSuperseded(id: string, reason: string | null): Promise<OrchestrationWait> {
    return this.transitionAtomically(id, ["armed", "signaled"], async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET state = 'superseded', superseded_at = now(), updated_at = now()
WHERE id = $1`,
        parameters: [id],
      });
      await insertAttempt(tx, id, {
        stage: "effect",
        attemptNo: 1,
        outcome: "accepted",
        detail: cappedDetail(
          `superseded: ${reason ?? "execution moved on by another governed path"}`,
        ),
      });
    });
  }

  /** Terminal bounded failure / governed refusal (explicit reason). */
  async markAbandoned(
    id: string,
    reason: string,
    evidence: AttemptEvidence,
  ): Promise<OrchestrationWait> {
    return this.transitionAtomically(
      id,
      ["recorded", "deferred", "armed", "signaled"],
      async (tx) => {
        await tx.execute({
          sql: `UPDATE workflow_orchestration.waits
SET state = 'abandoned', abandoned_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id],
        });
        await insertAttempt(tx, id, evidence);
        await insertAbandonDetail(tx, id, reason);
      },
    );
  }

  /**
   * The provider-signal delivery for the resolving notification
   * succeeded (transport fact; the authoritative effect already
   * happened — this only lets the provider instance progress).
   */
  async markSignalDelivered(
    waitId: string,
    notificationKey: string,
    evidence: AttemptEvidence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.notifications
SET provider_delivered_at = now(), provider_delivery_attempts = $3
WHERE wait_id = $1 AND notification_key = $2`,
        parameters: [waitId, notificationKey, evidence.attemptNo],
      });
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET signal_delivery_attempts = $2, updated_at = now()
WHERE id = $1`,
        parameters: [waitId, evidence.attemptNo],
      });
      await insertAttempt(tx, waitId, evidence);
    });
  }

  /** A provider-signal delivery attempt failed (bounded by policy). */
  async recordSignalDeliveryFailure(
    waitId: string,
    notificationKey: string,
    evidence: AttemptEvidence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `UPDATE workflow_orchestration.notifications
SET provider_delivery_attempts = $3
WHERE wait_id = $1 AND notification_key = $2`,
        parameters: [waitId, notificationKey, evidence.attemptNo],
      });
      await tx.execute({
        sql: `UPDATE workflow_orchestration.waits
SET signal_delivery_attempts = $2, updated_at = now()
WHERE id = $1`,
        parameters: [waitId, evidence.attemptNo],
      });
      await insertAttempt(tx, waitId, evidence);
    });
  }

  /** The provider instance was terminated by compaction (bounded state). */
  async markProviderTerminated(id: string, evidence: AttemptEvidence): Promise<OrchestrationWait> {
    return this.transitionAtomically(
      id,
      [
        "settled",
        "elapsed",
        "superseded",
        "abandoned",
        "armed",
        "signaled",
        "recorded",
        "deferred",
      ],
      async (tx) => {
        await tx.execute({
          sql: `UPDATE workflow_orchestration.waits
SET provider_terminated_at = now(), updated_at = now()
WHERE id = $1`,
          parameters: [id],
        });
        await insertAttempt(tx, id, evidence);
      },
    );
  }

  /**
   * Recovery scan: waits whose durable intent exists but whose
   * instance start never succeeded (crash between intent and start,
   * or provider outage exhaustion). Ordered oldest-first.
   */
  async recoverableStarts(limit: number): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.state IN ('recorded', 'deferred')
ORDER BY w.created_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map(toWait);
  }

  /** The accepted notification of one wait, when a resolution was recorded. */
  async findAcceptedNotification(waitId: string): Promise<{
    readonly notificationKey: string;
    readonly decision: string | null;
    readonly kind: string;
  } | null> {
    const result = await this.db.execute<{
      notification_key: string;
      decision: string | null;
      kind: string;
    }>({
      sql: `SELECT notification_key, decision, kind FROM workflow_orchestration.notifications
WHERE wait_id = $1 AND outcome = 'accepted' LIMIT 1`,
      parameters: [waitId],
    });
    const row = result.rows[0];
    return row === undefined
      ? null
      : { notificationKey: row.notification_key, decision: row.decision, kind: row.kind };
  }

  /** All non-terminal waits (the staleness-reconciliation scan set). */
  async listNonTerminalWaits(limit: number): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.state IN ('recorded', 'deferred', 'armed', 'signaled')
ORDER BY w.created_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map(toWait);
  }

  /** Armed/signaled waits holding a provider instance (the observation set). */
  async listObservables(limit: number): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.state IN ('armed', 'signaled') AND w.provider_instance_id IS NOT NULL
ORDER BY w.created_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map(toWait);
  }

  /**
   * Recovery scan: signaled waits whose governed effect is pending,
   * WITH the accepted notification that recorded the resolution (the
   * cause is reconstructed from durable state, never from the
   * provider).
   */
  async signaledPendingEffect(limit: number): Promise<
    readonly {
      readonly wait: OrchestrationWait;
      readonly cause:
        | { readonly kind: "callback"; readonly notificationKey: string }
        | {
            readonly kind: "approval";
            readonly decision: "approve" | "reject";
            readonly approverId: string;
            readonly notificationKey: string;
          };
    }[]
  > {
    const result = await this.db.execute<
      WaitRow & {
        notification_key: string;
        notification_kind: string;
        notification_decision: string | null;
        notification_approver: string | null;
      }
    >({
      sql: `${WAIT_SELECT_WITH_NOTIFICATION}
JOIN workflow_orchestration.notifications n ON n.wait_id = w.id AND n.outcome = 'accepted'
WHERE w.state = 'signaled'
ORDER BY w.created_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map((row) => ({
      wait: toWait(row),
      cause:
        row.notification_kind === "approval"
          ? {
              kind: "approval",
              decision: (row.notification_decision ?? "approve") as "approve" | "reject",
              approverId: row.notification_approver ?? "",
              notificationKey: row.notification_key,
            }
          : { kind: "callback", notificationKey: row.notification_key },
    }));
  }

  /** Deadline scan: armed waits whose timer is due (authority = the PG deadline). */
  async dueDeadlineWaits(deadlineAt: string, limit: number): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.state = 'armed' AND w.deadline IS NOT NULL AND w.deadline <= $1
ORDER BY w.deadline ASC
LIMIT $2`,
      parameters: [deadlineAt, limit],
    });
    return result.rows.map(toWait);
  }

  /**
   * Recovery scan: resolved waits whose accepted notification was
   * never delivered to the provider instance (crash between the
   * authoritative effect and the transport signal), within budget.
   */
  async pendingSignalDeliveries(
    policy: WorkflowRetryPolicy,
    limit: number,
  ): Promise<
    readonly {
      readonly wait: OrchestrationWait;
      readonly cause:
        | { readonly kind: "callback"; readonly notificationKey: string }
        | {
            readonly kind: "approval";
            readonly decision: "approve" | "reject";
            readonly approverId: string;
            readonly notificationKey: string;
          };
    }[]
  > {
    const result = await this.db.execute<
      WaitRow & {
        notification_key: string;
        notification_kind: string;
        notification_decision: string | null;
        notification_approver: string | null;
      }
    >({
      sql: `${WAIT_SELECT_WITH_NOTIFICATION}
JOIN workflow_orchestration.notifications n ON n.wait_id = w.id AND n.outcome = 'accepted'
WHERE w.state IN ('settled', 'elapsed')
  AND n.provider_delivered_at IS NULL
  AND n.provider_delivery_attempts < $1
ORDER BY w.created_at ASC
LIMIT $2`,
      parameters: [policy.maxSignalAttempts, limit],
    });
    return result.rows.map((row) => ({
      wait: toWait(row),
      cause:
        row.notification_kind === "approval"
          ? {
              kind: "approval",
              decision: (row.notification_decision ?? "approve") as "approve" | "reject",
              approverId: row.notification_approver ?? "",
              notificationKey: row.notification_key,
            }
          : { kind: "callback", notificationKey: row.notification_key },
    }));
  }

  /**
   * Compaction scan: terminal waits whose provider instance may still
   * hold state (not terminated by us, not observed terminated by the
   * provider). Terminating them bounds provider state.
   */
  async compactibleWaits(limit: number): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT}
WHERE w.state IN ('settled', 'elapsed', 'superseded', 'abandoned')
  AND w.provider_instance_id IS NOT NULL
  AND w.provider_terminated_at IS NULL
  AND w.provider_observed_status IS DISTINCT FROM 'terminated'
ORDER BY w.updated_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.map(toWait);
  }

  /** Replacements issued from the root wait (bounded by policy). */
  async countReplacements(rootId: string): Promise<number> {
    const result = await this.db.execute<{ count: string | number }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.waits WHERE replacement_of = $1`,
      parameters: [rootId],
    });
    const raw = result.rows[0]?.count;
    return raw === undefined ? 0 : Number(raw);
  }

  /** All replacement waits of the root, in lineage-ordinal order. */
  async listReplacements(rootId: string): Promise<readonly OrchestrationWait[]> {
    const result = await this.db.execute<WaitRow>({
      sql: `${WAIT_SELECT} WHERE w.replacement_of = $1 ORDER BY w.wait_key ASC`,
      parameters: [rootId],
    });
    return result.rows.map(toWait);
  }

  /** Run one atomic multi-statement transition guarded by expected states. */
  private async transitionAtomically(
    id: string,
    expectedStates: readonly OrchestrationWaitState[],
    work: (tx: TxLike) => Promise<void>,
  ): Promise<OrchestrationWait> {
    await this.db.transaction(async (tx) => {
      const guard = await tx.execute<{ state: OrchestrationWaitState }>({
        sql: `SELECT state FROM workflow_orchestration.waits WHERE id = $1 FOR UPDATE`,
        parameters: [id],
      });
      const row = guard.rows[0];
      if (row === undefined) {
        throw new WorkflowConfigError(`orchestration wait ${id} does not exist`);
      }
      if (!expectedStates.includes(row.state)) {
        throw new WorkflowConfigError(
          `orchestration wait ${id} is ${row.state}; expected ${expectedStates.join(" or ")}`,
        );
      }
      await work(tx);
    });
    const after = await this.findWaitById(id);
    if (after === null) {
      throw new WorkflowConfigError(`orchestration wait ${id} vanished mid-transition`);
    }
    return after;
  }
}

async function insertAttempt(tx: TxLike, waitId: string, evidence: AttemptEvidence): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO workflow_orchestration.attempts (wait_id, stage, attempt_no, outcome, detail)
VALUES ($1, $2, $3, $4, $5)`,
    parameters: [
      waitId,
      evidence.stage,
      evidence.attemptNo,
      evidence.outcome,
      cappedDetail(evidence.detail),
    ],
  });
}

async function insertAbandonDetail(tx: TxLike, waitId: string, reason: string): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO workflow_orchestration.abandoned_waits (id, wait_id, reason)
VALUES ($1, $2, $3)`,
    parameters: [randomUUID(), waitId, cappedDetail(reason)],
  });
}
