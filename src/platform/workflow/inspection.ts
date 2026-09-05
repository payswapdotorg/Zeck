/**
 * Read-only workflow orchestration inspection (WORK-045 / D-04) —
 * the observational operator surface, mirroring the D-03 queue
 * inspection contract: counts by state, per-execution wait lineage,
 * notifications (digest-only), attempt evidence, provider-instance
 * state, compaction state and the stuck conditions an operator must
 * act on.
 *
 * STRICTLY READ-ONLY: one snapshot query set; nothing mutates. The
 * snapshot is orchestration/progress evidence — it never redefines
 * execution state and never claims execution outcomes.
 */
import type { DatabasePort } from "../db/port";

export interface WaitStateCounts {
  readonly state: string;
  readonly count: number;
}

export interface WaitNotificationView {
  readonly notificationKey: string;
  readonly kind: string;
  readonly decision: string | null;
  readonly approverId: string | null;
  readonly payloadDigest: string;
  readonly outcome: string;
  readonly providerDeliveredAt: string | null;
  readonly providerDeliveryAttempts: number;
  readonly createdAt: string;
}

export interface WaitAttemptView {
  readonly stage: string;
  readonly attemptNo: number;
  readonly outcome: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface WaitView {
  readonly waitKey: string;
  readonly executionId: string;
  readonly waitKind: string;
  readonly state: string;
  readonly deadline: string | null;
  readonly providerInstanceId: string | null;
  readonly providerObservedStatus: string | null;
  readonly providerTerminatedAt: string | null;
  readonly startAttempts: number;
  readonly signalDeliveryAttempts: number;
  readonly retainedNotifications: number;
  readonly foldedNotifications: number;
  readonly appliedAt: string | null;
  readonly createdAt: string;
}

export interface OrchestrationSnapshot {
  readonly waitsByState: readonly WaitStateCounts[];
  readonly notificationsByOutcome: readonly { readonly outcome: string; readonly count: number }[];
  readonly totalWaits: number;
  readonly totalAttempts: number;
  readonly foldedNotifications: number;
  readonly compactedInstances: number;
  /** Waits needing operator attention (deferred/abandoned, oldest first). */
  readonly attention: readonly {
    readonly waitKey: string;
    readonly state: string;
    readonly reason: string | null;
    readonly executionId: string;
    readonly waitKind: string;
  }[];
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : String(value);

/** Snapshot the orchestration state (read-only, never authority). */
export async function inspectWorkflowOrchestration(
  db: DatabasePort,
): Promise<OrchestrationSnapshot> {
  const states = await db.execute<{ state: string; count: string | number }>({
    sql: `SELECT state, count(*) AS count FROM workflow_orchestration.waits GROUP BY state ORDER BY state`,
  });
  const outcomes = await db.execute<{ outcome: string; count: string | number }>({
    sql: `SELECT outcome, count(*) AS count FROM workflow_orchestration.notifications GROUP BY outcome ORDER BY outcome`,
  });
  const totals = await db.execute<{
    waits: string | number;
    attempts: string | number;
    folded: string | number;
    compacted: string | number;
  }>({
    sql: `SELECT
  (SELECT count(*) FROM workflow_orchestration.waits) AS waits,
  (SELECT count(*) FROM workflow_orchestration.attempts) AS attempts,
  (SELECT coalesce(sum(folded_notifications), 0) FROM workflow_orchestration.waits) AS folded,
  (SELECT count(*) FROM workflow_orchestration.waits WHERE provider_terminated_at IS NOT NULL) AS compacted`,
  });
  const attention = await db.execute<{
    wait_key: string;
    state: string;
    execution_id: string;
    wait_kind: string;
    reason: string | null;
  }>({
    sql: `SELECT w.wait_key, w.state, w.execution_id, w.wait_kind, a.reason
FROM workflow_orchestration.waits w
LEFT JOIN workflow_orchestration.abandoned_waits a ON a.wait_id = w.id
WHERE w.state IN ('deferred', 'abandoned')
ORDER BY w.updated_at ASC
LIMIT 100`,
  });
  const row = totals.rows[0];
  return {
    waitsByState: states.rows.map((r) => ({ state: r.state, count: Number(r.count) })),
    notificationsByOutcome: outcomes.rows.map((r) => ({
      outcome: r.outcome,
      count: Number(r.count),
    })),
    totalWaits: Number(row?.waits ?? 0),
    totalAttempts: Number(row?.attempts ?? 0),
    foldedNotifications: Number(row?.folded ?? 0),
    compactedInstances: Number(row?.compacted ?? 0),
    attention: attention.rows.map((r) => ({
      waitKey: r.wait_key,
      state: r.state,
      reason: r.reason ?? null,
      executionId: r.execution_id,
      waitKind: r.wait_kind,
    })),
  };
}

/** The full durable lineage of one execution's waits (read-only). */
export async function listExecutionWaits(
  db: DatabasePort,
  executionId: string,
): Promise<readonly WaitView[]> {
  const result = await db.execute<{
    wait_key: string;
    execution_id: string;
    wait_kind: string;
    state: string;
    deadline: Date | string | null;
    provider_instance_id: string | null;
    provider_observed_status: string | null;
    provider_terminated_at: Date | string | null;
    start_attempts: number;
    signal_delivery_attempts: number;
    retained_notifications: number;
    folded_notifications: number;
    applied_at: Date | string | null;
    created_at: Date | string;
  }>({
    sql: `SELECT wait_key, execution_id, wait_kind, state, deadline, provider_instance_id,
  provider_observed_status, provider_terminated_at, start_attempts, signal_delivery_attempts,
  retained_notifications, folded_notifications, applied_at, created_at
FROM workflow_orchestration.waits WHERE execution_id = $1 ORDER BY wait_key ASC`,
    parameters: [executionId],
  });
  return result.rows.map((r) => ({
    waitKey: r.wait_key,
    executionId: r.execution_id,
    waitKind: r.wait_kind,
    state: r.state,
    deadline: iso(r.deadline),
    providerInstanceId: r.provider_instance_id,
    providerObservedStatus: r.provider_observed_status,
    providerTerminatedAt: iso(r.provider_terminated_at),
    startAttempts: r.start_attempts,
    signalDeliveryAttempts: r.signal_delivery_attempts,
    retainedNotifications: r.retained_notifications,
    foldedNotifications: r.folded_notifications,
    appliedAt: iso(r.applied_at),
    createdAt: iso(r.created_at) ?? "",
  }));
}

/** The durable notification evidence of one wait (digest-only, read-only). */
export async function listWaitNotifications(
  db: DatabasePort,
  executionId: string,
  waitKey: string,
): Promise<readonly WaitNotificationView[]> {
  const result = await db.execute<{
    notification_key: string;
    kind: string;
    decision: string | null;
    approver_id: string | null;
    payload_digest: string;
    outcome: string;
    provider_delivered_at: Date | string | null;
    provider_delivery_attempts: number;
    created_at: Date | string;
  }>({
    sql: `SELECT n.notification_key, n.kind, n.decision, n.approver_id, n.payload_digest,
  n.outcome, n.provider_delivered_at, n.provider_delivery_attempts, n.created_at
FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits w ON w.id = n.wait_id
WHERE w.execution_id = $1 AND w.wait_key = $2
ORDER BY n.id ASC`,
    parameters: [executionId, waitKey],
  });
  return result.rows.map((r) => ({
    notificationKey: r.notification_key,
    kind: r.kind,
    decision: r.decision,
    approverId: r.approver_id,
    payloadDigest: r.payload_digest,
    outcome: r.outcome,
    providerDeliveredAt: iso(r.provider_delivered_at),
    providerDeliveryAttempts: r.provider_delivery_attempts,
    createdAt: iso(r.created_at) ?? "",
  }));
}

/** The append-only attempt evidence of one execution's waits (read-only). */
export async function listExecutionAttempts(
  db: DatabasePort,
  executionId: string,
): Promise<readonly WaitAttemptView[]> {
  const result = await db.execute<{
    stage: string;
    attempt_no: number;
    outcome: string;
    detail: string | null;
    created_at: Date | string;
  }>({
    sql: `SELECT a.stage, a.attempt_no, a.outcome, a.detail, a.created_at
FROM workflow_orchestration.attempts a
JOIN workflow_orchestration.waits w ON w.id = a.wait_id
WHERE w.execution_id = $1
ORDER BY a.id ASC
LIMIT 500`,
    parameters: [executionId],
  });
  return result.rows.map((r) => ({
    stage: r.stage,
    attemptNo: r.attempt_no,
    outcome: r.outcome,
    detail: r.detail,
    createdAt: iso(r.created_at) ?? "",
  }));
}
