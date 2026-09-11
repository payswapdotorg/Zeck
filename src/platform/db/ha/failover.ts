/**
 * The governed authority-failover executor (WORK-057 / D-08, AVA-002:
 * "RTO ≤ 15 minutes for authority failover"; AVA-004 replay rides the
 * EXISTING idempotency, never this module).
 *
 * THE CONTRACT (fail-closed at every step):
 *
 *   1. SPLIT-BRAIN GUARD — the primary must be UNREACHABLE before any
 *      promotion. Promoting a replica while the primary is alive
 *      creates TWO writable authorities; that is the one state the
 *      PostgreSQL-sole-authority invariant cannot tolerate, so the
 *      executor refuses it with a typed error. (Unreachability is
 *      probed repeatedly — a single flaky observation may never
 *      authorize a promotion.)
 *   2. REPLICA-ROLE GUARD — the standby must be IN RECOVERY (a live
 *      replica of the lost primary). A writable endpoint at the
 *      standby address is either (a) an already-promoted topology —
 *      then a RE-RUN is a bounded no-op, reported as such and
 *      re-verified (writable, schema-converged Zeck authority, old
 *      primary still unreachable) — or (b) a FOREIGN writable database
 *      (not the recovered authority). Failover RESTORES authority; it
 *      never constructs a different one, so (b) is refused with a
 *      typed error naming the drift.
 *   3. PROMOTION — `pg_promote(wait)` on the standby. The standby's
 *      own replicated state BECOMES the authority (recovery restores;
 *      nothing is reconstructed, nothing is copied in).
 *   4. POST-CONDITIONS — the promoted server is out of recovery and
 *      writable, and the old primary is STILL unreachable (re-probed
 *      after promotion). A post-condition failure fails the whole
 *      failover (typed error) — an unverified promotion is never a
 *      success.
 *
 * RPO evidence: the standby's last replayed transaction timestamp is
 * captured immediately BEFORE promotion (the failover instant's
 * data-loss window anchor on the asynchronous path; the drill reports
 * it honestly, even when it breaches the target).
 *
 * The executor writes exactly ONE server-state change (pg_promote). It
 * never writes rows, never reconstructs schema, and never consults
 * provider APIs — promotion is PostgreSQL wire protocol, identical
 * against self-managed and managed standby endpoints.
 */

import {
  type DatabaseConnectionConfig,
  parseConnectionConfig,
  redactConnectionString,
} from "../connection";
import { DatabaseUnavailableError } from "../errors";
import { createPgDatabasePort } from "../pg-database-port";
import type { Query, QueryResult } from "../port";
import { shippedMigrations } from "../startup";
import type { HaReplicationMode } from "./topology";

/** Fail-closed authority-failover error (every refusal below). */
export class AuthorityFailoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityFailoverError";
  }
}

/** The connection seam the executor needs (injectable for tests). */
export interface FailoverConnection {
  execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>>;
  ping(): Promise<unknown>;
  close(): Promise<void>;
}

export type FailoverConnectionFactory = (config: DatabaseConnectionConfig) => FailoverConnection;

const EXECUTOR_POOL = Object.freeze({ max: 2, connectionTimeoutMillis: 2_000 });

const productionConnectionFactory: FailoverConnectionFactory = (config) =>
  createPgDatabasePort(config);

/** The input of one governed failover execution. */
export interface AuthorityFailoverInput {
  /** The LOST primary's URL (must be unreachable — split-brain guard). */
  readonly primaryUrl: string;
  /** The standby's URL (must be in recovery, or already promoted). */
  readonly standbyUrl: string;
  /** The replication mode (evidence attribution only; never a bypass). */
  readonly mode: HaReplicationMode;
  /**
   * How many independent unreachability probes must agree before the
   * primary is declared dead (default 3 — a single observation may
   * never authorize a promotion).
   */
  readonly primaryProbeAttempts?: number;
  /** Upper bound for pg_promote's wait (seconds; default 60). */
  readonly promoteWaitSeconds?: number;
}

/** The bounded failover evidence record. */
export interface AuthorityFailoverReport {
  /** True iff pg_promote ran in THIS execution. */
  readonly promoted: boolean;
  /** True iff the bounded no-op path (already-promoted topology). */
  readonly alreadyPromoted: boolean;
  /** Standby was in recovery before this execution acted. */
  readonly standbyWasInRecovery: boolean;
  /** Last replayed transaction timestamp captured before promotion (the RPO anchor). */
  readonly rpoAnchorAt: string | null;
  /** Last replayed LSN captured before promotion. */
  readonly lastReplayedLsn: string | null;
  /** The measured replication mode (evidence attribution). */
  readonly mode: HaReplicationMode;
  /** Completion timestamp of the successful execution. */
  readonly finishedAt: string;
}

interface RoleRow {
  readonly in_recovery: boolean;
  readonly read_only: boolean;
  readonly lsn: string | null;
  readonly replay_ts: string | null;
}

/** The governed failover executor over the pg adapter. */
export class PgAuthorityFailover {
  private readonly connect: FailoverConnectionFactory;
  private readonly now: () => Date;

  constructor(connectionFactory?: FailoverConnectionFactory, now: () => Date = () => new Date()) {
    this.connect = connectionFactory ?? productionConnectionFactory;
    this.now = now;
  }

  private async withConnection<T>(
    url: string,
    work: (connection: FailoverConnection) => Promise<T>,
  ): Promise<T> {
    const config = parseConnectionConfig(url, EXECUTOR_POOL);
    const connection = this.connect(config);
    try {
      return await work(connection);
    } finally {
      await connection.close();
    }
  }

  /** Read the server's role: in-recovery, read-only, replay position. */
  private async roleOf(url: string): Promise<RoleRow> {
    return this.withConnection(url, async (connection) => {
      const result = await connection.execute<RoleRow>({
        sql: `SELECT pg_is_in_recovery() AS in_recovery,
                     current_setting('transaction_read_only') = 'on' AS read_only,
                     pg_last_wal_replay_lsn()::text AS lsn,
                     pg_last_xact_replay_timestamp()::text AS replay_ts`,
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new AuthorityFailoverError("the endpoint returned no role information");
      }
      return row;
    });
  }

  /**
   * Probe the primary: SUCCESS means the primary is ALIVE (refuse —
   * split-brain guard); `DatabaseUnavailableError` means unreachable.
   * Every non-unavailability failure is itself an error (never
   * misread as unreachability).
   */
  private async assertPrimaryUnreachable(
    input: AuthorityFailoverInput,
    phase: string,
  ): Promise<void> {
    const attempts = input.primaryProbeAttempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new AuthorityFailoverError("primaryProbeAttempts must be a positive integer");
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.withConnection(input.primaryUrl, async (connection) => {
          await connection.ping();
        });
        throw new AuthorityFailoverError(
          `the primary authority is still reachable (${phase}); promoting a standby against a live primary would create two writable authorities — refuse (fence the primary first)`,
        );
      } catch (error) {
        if (error instanceof AuthorityFailoverError) {
          throw error; // the refusal above — not unreachability
        }
        if (!(error instanceof DatabaseUnavailableError)) {
          // A reachable-but-broken primary is NOT unreachability; it
          // still blocks promotion (fail closed, honest diagnosis).
          throw new AuthorityFailoverError(
            `the primary probe failed with a non-availability error (${phase}): ${redactConnectionString((error as Error).message)}`,
          );
        }
      }
      // Short spacing between probes: a flaky network may not skip
      // observations (all attempts must observe unreachability).
      if (attempt < attempts) {
        await sleep(150);
      }
    }
  }

  /** The already-promoted no-op path: writable + converged Zeck authority. */
  private async assertAlreadyPromotedAuthority(input: AuthorityFailoverInput): Promise<void> {
    const role = await this.roleOf(input.standbyUrl);
    if (role.in_recovery) {
      // Contradiction with the caller's path selection.
      throw new AuthorityFailoverError(
        "internal ordering defect: the standby is still in recovery",
      );
    }
    if (role.read_only) {
      throw new AuthorityFailoverError(
        "the standby endpoint is not in recovery but is read-only (an intermediate state the failover never produced — refuse)",
      );
    }
    // It must be a CONVERGED ZECK AUTHORITY (the recovered state), not
    // a foreign writable database: every shipped migration recorded.
    await this.withConnection(input.standbyUrl, async (connection) => {
      let recorded = -1;
      try {
        const result = await connection.execute<{ readonly count: string }>({
          sql: "SELECT count(*) AS count FROM platform.schema_migrations",
        });
        recorded = Number(result.rows[0]?.count ?? -1);
      } catch (error) {
        throw new AuthorityFailoverError(
          `the standby endpoint is not a converged Zeck authority (failover restores authority, it never constructs one): ${redactConnectionString((error as Error).message)}`,
        );
      }
      if (recorded !== shippedMigrations().length) {
        throw new AuthorityFailoverError(
          `the standby endpoint carries ${recorded} recorded migrations, expected ${shippedMigrations().length} (a converged Zeck authority, not a foreign database, is the only no-op target)`,
        );
      }
    });
  }

  /**
   * Execute the governed failover. Throws `AuthorityFailoverError` on
   * every refusal; returns the bounded evidence record on success
   * (either a fresh promotion or the idempotent no-op).
   */
  async failover(input: AuthorityFailoverInput): Promise<AuthorityFailoverReport> {
    const standbyRole = await this.roleOf(input.standbyUrl);

    if (!standbyRole.in_recovery) {
      // Either the already-promoted no-op, or a foreign authority.
      await this.assertPrimaryUnreachable(input, "no-op verification");
      await this.assertAlreadyPromotedAuthority(input);
      return Object.freeze({
        promoted: false,
        alreadyPromoted: true,
        standbyWasInRecovery: false,
        rpoAnchorAt: standbyRole.replay_ts,
        lastReplayedLsn: standbyRole.lsn,
        mode: input.mode,
        finishedAt: this.now().toISOString(),
      });
    }

    // A live replica: the only promotion candidate. The split-brain
    // guard runs FIRST — a reachable primary is an absolute refusal.
    await this.assertPrimaryUnreachable(input, "promotion precondition");

    // RPO anchor: the standby's replicated position at the failover
    // decision instant (captured before the promotion changes state).
    const rpoAnchorAt = standbyRole.replay_ts;
    const lastReplayedLsn = standbyRole.lsn;

    const waitSeconds = input.promoteWaitSeconds ?? 60;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 300) {
      throw new AuthorityFailoverError("promoteWaitSeconds must be an integer in [1, 300]");
    }
    const promoted = await this.withConnection(input.standbyUrl, async (connection) => {
      const result = await connection.execute<{ readonly promoted: boolean }>({
        sql: "SELECT pg_promote(wait := true, wait_seconds := $1) AS promoted",
        parameters: [waitSeconds],
      });
      const row = result.rows[0];
      if (row === undefined || row.promoted !== true) {
        throw new AuthorityFailoverError("pg_promote did not confirm the promotion");
      }
      return true;
    });

    if (!promoted) {
      throw new AuthorityFailoverError("pg_promote did not promote (unreachable)");
    }

    // Post-conditions: out of recovery, writable, and the old primary
    // is STILL unreachable (no zombie primary reappeared mid-failover).
    const postRole = await this.roleOf(input.standbyUrl);
    if (postRole.in_recovery) {
      throw new AuthorityFailoverError(
        "post-condition failed: the promoted server is still in recovery",
      );
    }
    if (postRole.read_only) {
      throw new AuthorityFailoverError(
        "post-condition failed: the promoted server is read-only (the new authority must accept governed writes)",
      );
    }
    await this.assertPrimaryUnreachable(input, "post-condition");

    return Object.freeze({
      promoted: true,
      alreadyPromoted: false,
      standbyWasInRecovery: true,
      rpoAnchorAt,
      lastReplayedLsn,
      mode: input.mode,
      finishedAt: this.now().toISOString(),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Re-export for composition roots. */
export { createPgDatabasePort };
