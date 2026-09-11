/**
 * Replication-readiness probing for the HA authoritative state
 * (WORK-057 / D-08, AVA-002: "replication-readiness probing and lag
 * measurement (RPO evidence) through a platform port").
 *
 * The probe is the RPO EVIDENCE instrument: it observes, it never
 * heals. All queries are read-only SQL over the provider-neutral
 * `DatabasePort` seam (the `pg` adapter stays pinned to
 * `src/platform/db/` by the provider-SDK boundary table) — identical
 * against a self-managed local primary/standby pair and a managed
 * provider topology: the standby-side functions (`pg_is_in_recovery`,
 * `pg_last_wal_replay_lsn`, `pg_last_xact_replay_timestamp`) and the
 * primary-side view (`pg_stat_replication`) are PostgreSQL wire
 * protocol, not provider vocabulary.
 *
 * MEASURED LAG SEMANTICS (kept honest, matching `rto-rpo.ts`):
 *  - `lagMs` is (probe clock − last replayed transaction commit
 *    timestamp), measured ON THE STANDBY. It is the upper bound of the
 *    data-loss window at the probe instant on the asynchronous path
 *    (the RPO evidence recorded at the failover instant); a quiescent
 *    caught-up topology reports ~0.
 *  - The catch-up gate polls the primary's `pg_stat_replication` LSN
 *    distance — the readiness bound the drill uses before declaring
 *    the topology promotable-with-zero-measured-lag.
 *  - A standby that cannot reach its primary still reports its last
 *    replayed position (the streaming status degrades) — evidence, not
 *    a failure to hide.
 */

import {
  type DatabaseConnectionConfig,
  parseConnectionConfig,
  redactConnectionString,
} from "../connection";
import { DatabaseUnavailableError } from "../errors";
import { createPgDatabasePort } from "../pg-database-port";
import type { DatabasePort, Query, QueryResult } from "../port";
import type { HaReplicationMode } from "./topology";

/** The standby's replication state (all fields measured, none guessed). */
export interface StandbyReplicationState {
  /** True while the server is in recovery (the replica role). */
  readonly inRecovery: boolean;
  /** True while the WAL receiver reports 'streaming'. */
  readonly streaming: boolean;
  /** Last replayed LSN (null before any replay). */
  readonly lastReplayedLsn: string | null;
  /** Commit timestamp of the last replayed transaction (the RPO anchor). */
  readonly lastReplayTimestamp: string | null;
}

/** One standby's row in the primary's `pg_stat_replication`. */
export interface PrimaryReplicationEntry {
  readonly applicationName: string;
  readonly state: string;
  /** 'async' or 'sync' as the primary sees the standby. */
  readonly syncState: string;
  /** Replay lag in milliseconds as reported by the primary (null when unknown). */
  readonly replayLagMs: number | null;
}

/** The primary's view of its attached standbys. */
export interface PrimaryReplicationState {
  readonly standbys: readonly PrimaryReplicationEntry[];
}

/** The recorded RPO evidence (bounded, typed — the drill's output shape). */
export interface ReplicationLagEvidence {
  readonly mode: HaReplicationMode;
  readonly lagMs: number | null;
  readonly lastReplayTimestamp: string | null;
  readonly lastReplayedLsn: string | null;
  readonly probedAt: string;
}

/** Fail-closed replication probing error. */
export class ReplicationProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicationProbeError";
  }
}

/** The connection seam the probe needs (injectable for tests). */
export interface ProbeConnection {
  execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

/** How to build a probe connection for one endpoint (production: the pg adapter). */
export type ProbeConnectionFactory = (config: DatabaseConnectionConfig) => ProbeConnection;

const PROBE_POOL = Object.freeze({ max: 2, connectionTimeoutMillis: 5_000 });

const productionConnectionFactory: ProbeConnectionFactory = (config) =>
  createPgDatabasePort(config);

interface StandbyProbeRow {
  readonly in_recovery: boolean;
  readonly lsn: string | null;
  readonly replay_ts: string | null;
  readonly receiver_status: string | null;
}

interface PrimaryProbeRow {
  readonly application_name: string;
  readonly state: string;
  readonly sync_state: string;
  readonly replay_lag_ms: string | null;
}

async function singleRow<T>(result: QueryResult<T>, what: string): Promise<T> {
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReplicationProbeError(`the replication probe returned no ${what} row`);
  }
  return row;
}

/** The replication-readiness probe (platform port; provider-neutral SQL). */
export class PgReplicationProbe {
  private readonly connect: ProbeConnectionFactory;
  private readonly now: () => Date;

  constructor(connectionFactory?: ProbeConnectionFactory, now: () => Date = () => new Date()) {
    this.connect = connectionFactory ?? productionConnectionFactory;
    this.now = now;
  }

  private async withConnection<T>(
    url: string,
    work: (connection: ProbeConnection) => Promise<T>,
  ): Promise<T> {
    const config = parseConnectionConfig(url, PROBE_POOL);
    const connection = this.connect(config);
    try {
      return await work(connection);
    } catch (error) {
      const message = redactConnectionString(
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseUnavailableError(`replication probing failed: ${message}`);
    } finally {
      await connection.close();
    }
  }

  /** Observe the standby's replication state (read-only; fails closed on unreachable). */
  async standbyState(standbyUrl: string): Promise<StandbyReplicationState> {
    return this.withConnection(standbyUrl, async (connection) => {
      const result = await connection.execute<StandbyProbeRow>({
        sql: `SELECT pg_is_in_recovery() AS in_recovery,
                     pg_last_wal_replay_lsn()::text AS lsn,
                     pg_last_xact_replay_timestamp()::text AS replay_ts,
                     (SELECT status::text FROM pg_stat_wal_receiver LIMIT 1) AS receiver_status`,
      });
      const row = await singleRow(result, "standby replication state");
      return Object.freeze({
        inRecovery: row.in_recovery,
        streaming: row.receiver_status === "streaming",
        lastReplayedLsn: row.lsn,
        lastReplayTimestamp: row.replay_ts,
      });
    });
  }

  /** Observe the primary's replication view (read-only; fails closed on unreachable). */
  async primaryState(primaryUrl: string): Promise<PrimaryReplicationState> {
    return this.withConnection(primaryUrl, async (connection) => {
      const result = await connection.execute<PrimaryProbeRow>({
        sql: `SELECT application_name, state, sync_state,
                     (CASE WHEN replay_lag IS NULL THEN NULL
                           ELSE (EXTRACT(EPOCH FROM replay_lag) * 1000)::bigint END)::text AS replay_lag_ms
              FROM pg_stat_replication`,
      });
      return Object.freeze({
        standbys: Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              applicationName: row.application_name,
              state: row.state,
              syncState: row.sync_state,
              replayLagMs: row.replay_lag_ms === null ? null : Number(row.replay_lag_ms),
            }),
          ),
        ),
      });
    });
  }

  /**
   * Record the RPO evidence at (≈) the failover instant: the standby's
   * last replayed transaction and the measured lag. The standby may
   * already have lost its primary — the probe still reports its last
   * replayed position (evidence over comfort).
   */
  async lagEvidence(standbyUrl: string, mode: HaReplicationMode): Promise<ReplicationLagEvidence> {
    const state = await this.standbyState(standbyUrl);
    const probedAt = this.now();
    return Object.freeze({
      mode,
      lagMs:
        state.lastReplayTimestamp === null
          ? null
          : Math.max(0, probedAt.getTime() - new Date(state.lastReplayTimestamp).getTime()),
      lastReplayTimestamp: state.lastReplayTimestamp,
      lastReplayedLsn: state.lastReplayedLsn,
      probedAt: probedAt.toISOString(),
    });
  }

  /**
   * Bounded catch-up wait: poll the primary until the named standby's
   * replay position reaches the primary's current WAL position (the
   * pre-loss readiness gate — the honest way to observe a ~0 lag on
   * the quiescent path). Fails closed on timeout or a standby that
   * never attaches.
   */
  async waitForStandbyCatchup(
    primaryUrl: string,
    applicationName: string,
    options: { readonly timeoutMs: number; readonly pollIntervalMs?: number },
  ): Promise<{ readonly bytesBehind: number; readonly waitedMs: number }> {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new ReplicationProbeError("timeoutMs must be a positive integer");
    }
    if (applicationName.length === 0 || applicationName.length > 100) {
      throw new ReplicationProbeError("applicationName must be bounded non-empty text");
    }
    const pollIntervalMs = options.pollIntervalMs ?? 200;
    const startedAt = this.now();
    const deadline = startedAt.getTime() + options.timeoutMs;
    let lastObservation = "unknown";
    for (;;) {
      try {
        const result = await this.withConnection(primaryUrl, async (connection) =>
          connection.execute<{ readonly bytes_behind: string | null }>({
            sql: `SELECT (CASE
                      WHEN (SELECT replay_lsn FROM pg_stat_replication WHERE application_name = $1) IS NULL THEN NULL
                      ELSE pg_wal_lsn_diff(pg_current_wal_lsn(),
                                 (SELECT replay_lsn FROM pg_stat_replication WHERE application_name = $1))::bigint END)::text AS bytes_behind`,
            parameters: [applicationName],
          }),
        );
        const row = await singleRow(result, "standby catch-up");
        if (row.bytes_behind === null) {
          lastObservation = `the standby "${applicationName}" is not attached to the primary yet`;
        } else {
          const bytesBehind = Number(row.bytes_behind);
          if (bytesBehind <= 0) {
            return { bytesBehind, waitedMs: this.now().getTime() - startedAt.getTime() };
          }
          lastObservation = `the standby is ${bytesBehind} bytes behind`;
        }
      } catch (error) {
        lastObservation = redactConnectionString(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (this.now().getTime() >= deadline) {
        throw new ReplicationProbeError(
          `the standby did not catch up within ${options.timeoutMs}ms (last observation: ${lastObservation})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type { DatabasePort };
/** Re-export for composition roots (the production pg-backed connection). */
export { createPgDatabasePort };
