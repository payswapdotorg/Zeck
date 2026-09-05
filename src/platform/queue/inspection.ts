/**
 * Queue transport inspection (WORK-044 / D-03) — the operational
 * backlog/failure observability.
 *
 * STRICTLY OBSERVATIONAL: every method here is a read. Inspection
 * never redefines execution state, never mutates transport progress,
 * and never treats provider/queue state as domain authority — it
 * reports the PostgreSQL transport records (the progress evidence
 * plane) correlated to the authoritative execution/dispatch records.
 *
 * What an operator can see:
 *  - dispatch counts by transport state (recorded / published /
 *    backlogged / consumed / dead-lettered);
 *  - the current backlog: envelopes whose durable intent exists but
 *    whose publication has not been accepted (crash window + provider
 *    outage exhaustion) — each correlated to its execution;
 *  - dead letters with reasons and bounded attempt counts;
 *  - recent transport attempt evidence (bounded window);
 *  - replay lineage per root (bounded by policy).
 */
import type { DatabasePort } from "../db/port";

export interface TransportStateCounts {
  readonly recorded: number;
  readonly published: number;
  readonly backlogged: number;
  readonly consumed: number;
  readonly deadLettered: number;
}

export interface BackloggedDispatchView {
  readonly correlationKey: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly state: string;
  readonly publishAttempts: number;
  readonly deliveryAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeadLetterView {
  readonly id: string;
  readonly correlationKey: string;
  readonly executionId: string;
  readonly reason: string;
  readonly attempts: number;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface AttemptEvidenceView {
  readonly correlationKey: string;
  readonly stage: string;
  readonly attemptNo: number;
  readonly outcome: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface ReplayLineageView {
  readonly rootCorrelationKey: string;
  readonly rootExecutionId: string;
  readonly replays: number;
  readonly replayKeys: readonly string[];
}

export interface TransportInspectionSnapshot {
  readonly counts: TransportStateCounts;
  readonly backlogged: readonly BackloggedDispatchView[];
  readonly deadLetters: readonly DeadLetterView[];
  readonly recentAttempts: readonly AttemptEvidenceView[];
  readonly replayLineages: readonly ReplayLineageView[];
}

interface CountRow {
  readonly state: string;
  readonly count: string | number;
}

interface BacklogRow {
  readonly correlation_key: string;
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly state: string;
  readonly publish_attempts: number;
  readonly delivery_attempts: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface DeadLetterRow {
  readonly id: string;
  readonly correlation_key: string;
  readonly execution_id: string;
  readonly reason: string;
  readonly attempts: number;
  readonly detail: string | null;
  readonly created_at: Date | string;
}

interface AttemptRow {
  readonly correlation_key: string;
  readonly stage: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly detail: string | null;
  readonly created_at: Date | string;
}

interface LineageRow {
  readonly root_correlation_key: string;
  readonly root_execution_id: string;
  readonly replay_keys: string[] | string | null;
  readonly replays: string | number;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : String(value);

const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * The read-only transport inspection over the authoritative
 * PostgreSQL correlation records. `limit` bounds every list query
 * (inspection is an operator surface, not a data export).
 */
export async function inspectQueueTransport(
  db: DatabasePort,
  options?: { readonly listLimit?: number; readonly recentAttemptLimit?: number },
): Promise<TransportInspectionSnapshot> {
  const listLimit = Math.max(1, Math.min(options?.listLimit ?? 50, 500));
  const attemptLimit = Math.max(1, Math.min(options?.recentAttemptLimit ?? 50, 500));

  const countsResult = await db.execute<CountRow>({
    sql: `SELECT state, count(*) AS count FROM queue_transport.dispatch_envelopes GROUP BY state`,
  });
  const tally: Record<string, number> = {
    recorded: 0,
    published: 0,
    backlogged: 0,
    consumed: 0,
    "dead-lettered": 0,
  };
  for (const row of countsResult.rows) {
    if (row.state in tally) {
      tally[row.state] = num(row.count);
    }
  }
  const counts: TransportStateCounts = {
    recorded: tally.recorded ?? 0,
    published: tally.published ?? 0,
    backlogged: tally.backlogged ?? 0,
    consumed: tally.consumed ?? 0,
    deadLettered: tally["dead-lettered"] ?? 0,
  };

  const backlogged = await db.execute<BacklogRow>({
    sql: `SELECT correlation_key, execution_id, application_id, tenant_id, state, publish_attempts, delivery_attempts, created_at, updated_at
FROM queue_transport.dispatch_envelopes
WHERE state IN ('recorded', 'backlogged')
ORDER BY created_at ASC
LIMIT $1`,
    parameters: [listLimit],
  });

  const deadLetters = await db.execute<DeadLetterRow>({
    sql: `SELECT d.id, e.correlation_key, e.execution_id, d.reason, d.attempts, d.detail, d.created_at
FROM queue_transport.dead_letters d
JOIN queue_transport.dispatch_envelopes e ON e.id = d.envelope_id
ORDER BY d.created_at DESC
LIMIT $1`,
    parameters: [listLimit],
  });

  const recentAttempts = await db.execute<AttemptRow>({
    sql: `SELECT e.correlation_key, a.stage, a.attempt_no, a.outcome, a.detail, a.created_at
FROM queue_transport.transport_attempts a
JOIN queue_transport.dispatch_envelopes e ON e.id = a.envelope_id
ORDER BY a.id DESC
LIMIT $1`,
    parameters: [attemptLimit],
  });

  const lineages = await db.execute<LineageRow>({
    sql: `SELECT root.correlation_key AS root_correlation_key, root.execution_id AS root_execution_id,
  count(child.id) AS replays,
  coalesce(array_agg(child.correlation_key ORDER BY child.correlation_key) FILTER (WHERE child.id IS NOT NULL), '{}') AS replay_keys
FROM queue_transport.dispatch_envelopes root
LEFT JOIN queue_transport.dispatch_envelopes child ON child.replay_of = root.id
WHERE root.replay_of IS NULL
GROUP BY root.id, root.correlation_key, root.execution_id
HAVING count(child.id) > 0
ORDER BY root.created_at ASC
LIMIT $1`,
    parameters: [listLimit],
  });

  return {
    counts,
    backlogged: backlogged.rows.map((row) => ({
      correlationKey: row.correlation_key,
      executionId: row.execution_id,
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      state: row.state,
      publishAttempts: row.publish_attempts,
      deliveryAttempts: row.delivery_attempts,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    deadLetters: deadLetters.rows.map((row) => ({
      id: row.id,
      correlationKey: row.correlation_key,
      executionId: row.execution_id,
      reason: row.reason,
      attempts: row.attempts,
      detail: row.detail,
      createdAt: iso(row.created_at),
    })),
    recentAttempts: recentAttempts.rows.map((row) => ({
      correlationKey: row.correlation_key,
      stage: row.stage,
      attemptNo: row.attempt_no,
      outcome: row.outcome,
      detail: row.detail,
      createdAt: iso(row.created_at),
    })),
    replayLineages: lineages.rows.map((row) => ({
      rootCorrelationKey: row.root_correlation_key,
      rootExecutionId: row.root_execution_id,
      replays: num(row.replays),
      replayKeys: Array.isArray(row.replay_keys) ? row.replay_keys : [],
    })),
  };
}
