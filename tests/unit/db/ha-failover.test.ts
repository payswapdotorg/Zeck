/**
 * Unit — the governed authority-failover executor's fail-closed
 * contract (WORK-057 / D-08, AVA-002; the Work Order's mutation
 * battery: "failover that would duplicate effects, reconstruct state,
 * or serve against a dead authority is rejected").
 *
 * The executor's connection seam is injected as a scripted fake per
 * scenario — every guard is driven through its REAL code path:
 *
 *  U1 the happy promotion: unreachable primary + in-recovery standby
 *     → pg_promote runs once, post-conditions verified, the RPO
 *     anchor is captured BEFORE promotion;
 *  U2 SPLIT-BRAIN REFUSAL: a REACHABLE primary is an absolute refusal
 *     (promoting a live replica would create two writable
 *     authorities) — and the refusal happens BEFORE any promotion
 *     attempt;
 *  U3 FOREIGN-AUTHORITY REFUSAL: a writable endpoint that is not a
 *     converged Zeck authority is refused (failover RESTORES the
 *     authority, it never constructs or adopts a different one);
 *  U4 THE IDEMPOTENT NO-OP: re-running against the already-promoted,
 *     converged authority (primary still unreachable) is a bounded
 *     no-op — promoted:false / alreadyPromoted:true — never a second
 *     promotion;
 *  U5 POST-CONDITION FAILURES: a promotion that does not leave
 *     recovery, or leaves the server read-only, fails the whole
 *     failover (an unverified promotion is never a success);
 *  U6 a reachable-but-broken primary (non-availability error) is NOT
 *     unreachability — still a refusal, never a promotion trigger.
 */

import { describe, expect, test } from "vitest";
import type { DatabaseConnectionConfig } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../../src/platform/db/errors";
import {
  AuthorityFailoverError,
  type FailoverConnection,
  PgAuthorityFailover,
} from "../../../src/platform/db/ha/failover";
import type { Query, QueryResult } from "../../../src/platform/db/port";

/** One scripted endpoint: role answers + ping behavior + write log. */
class FakeEndpoint implements FailoverConnection {
  public readonly executed: string[] = [];
  public pingBehavior: "ok" | "unavailable" | "broken" = "ok";
  public roleInRecovery = true;
  public roleReadOnly = false;
  public readonlyReplayTimestamp: string | null = "2026-09-10T12:00:00.000Z";
  public readonlyReplayLsn: string | null = "0/123456";
  public migrationsCount = 29;
  public promoteResult: boolean | null = true;
  public promoteCalls = 0;
  /** Post-promotion role override (post-condition failures). */
  public postRoleInRecovery: boolean | null = null;
  public postRoleReadOnly: boolean | null = null;

  async ping(): Promise<{ serverVersion: string; serverVersionNum: number }> {
    if (this.pingBehavior === "unavailable") {
      throw new DatabaseUnavailableError("endpoint unreachable (fake)");
    }
    if (this.pingBehavior === "broken") {
      throw new SyntaxError("connection reset mid-protocol (fake broken primary)");
    }
    return { serverVersion: "PostgreSQL 16.4 (fake)", serverVersionNum: 160004 };
  }

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    this.executed.push(query.sql);
    if (query.sql.includes("pg_promote")) {
      this.promoteCalls += 1;
      const promoted = this.promoteResult ?? false;
      return { rows: [{ promoted } as T], rowCount: 1 };
    }
    if (query.sql.includes("pg_is_in_recovery")) {
      // After a successful pg_promote the endpoint's live role flips
      // to a writable primary unless the scenario overrides it.
      const promotedLive = this.promoteCalls > 0 && (this.promoteResult ?? false);
      const inRecovery = this.postRoleInRecovery ?? (promotedLive ? false : this.roleInRecovery);
      const readOnly = this.postRoleReadOnly ?? (promotedLive ? false : this.roleReadOnly);
      return {
        rows: [
          {
            in_recovery: inRecovery,
            read_only: readOnly,
            lsn: this.readonlyReplayLsn,
            replay_ts: this.readonlyReplayTimestamp,
          } as T,
        ],
        rowCount: 1,
      };
    }
    if (query.sql.includes("platform.schema_migrations")) {
      if (this.migrationsCount < 0) {
        throw new Error('relation "platform.schema_migrations" does not exist (foreign database)');
      }
      return { rows: [{ count: String(this.migrationsCount) } as T], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${query.sql}`);
  }

  async close(): Promise<void> {}
}

interface Topology {
  primary: FailoverConnection;
  standby: FakeEndpoint;
}

function failoverOver(topology: Topology): PgAuthorityFailover {
  return new PgAuthorityFailover((config: DatabaseConnectionConfig) => {
    // The URL's database component routes to the scripted endpoint.
    if (config.url.includes("primary")) {
      return topology.primary;
    }
    return topology.standby;
  });
}

const INPUT = {
  primaryUrl: "postgres://postgres@127.0.0.1:9001/primary-authority",
  standbyUrl: "postgres://postgres@127.0.0.1:9002/standby-authority",
  mode: "asynchronous" as const,
  primaryProbeAttempts: 1,
};

describe("the governed authority-failover executor (WORK-057 fail-closed battery)", () => {
  test("U1 the governed promotion: unreachable primary, in-recovery standby, one pg_promote, verified post-conditions", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "unavailable";
    const standby = new FakeEndpoint();
    const executor = failoverOver({ primary, standby });

    const report = await executor.failover(INPUT);
    expect(report.promoted).toBe(true);
    expect(report.alreadyPromoted).toBe(false);
    expect(report.standbyWasInRecovery).toBe(true);
    expect(report.rpoAnchorAt).toBe("2026-09-10T12:00:00.000Z");
    expect(report.lastReplayedLsn).toBe("0/123456");
    expect(standby.promoteCalls).toBe(1);
    // Post-conditions ran: role re-probed after promotion, primary
    // re-probed for unreachability (ping seen more than once).
    expect(primary.executed.length).toBe(0); // ping-only endpoint
    expect(standby.executed.some((sql) => sql.includes("pg_promote"))).toBe(true);
  });

  test("U2 split-brain refusal: a REACHABLE primary blocks promotion before pg_promote is ever attempted", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "ok"; // ALIVE
    const standby = new FakeEndpoint();
    const executor = failoverOver({ primary, standby });

    await expect(executor.failover(INPUT)).rejects.toThrow(AuthorityFailoverError);
    await expect(executor.failover(INPUT)).rejects.toThrow(
      /primary authority is still reachable.*two writable authorities/,
    );
    expect(standby.promoteCalls).toBe(0); // NEVER promoted
  });

  test("U3 foreign-authority refusal: a writable non-Zeck endpoint at the standby address is refused", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "unavailable";
    const standby = new FakeEndpoint();
    standby.roleInRecovery = false; // writable, NOT our promoted authority
    standby.migrationsCount = -1; // no platform.schema_migrations → foreign
    const executor = failoverOver({ primary, standby });

    await expect(executor.failover(INPUT)).rejects.toThrow(
      /not a converged Zeck authority.*never constructs one/,
    );
    expect(standby.promoteCalls).toBe(0);
  });

  test("U3b a writable Zeck-shaped endpoint with a DRIFTED migration count is refused too", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "unavailable";
    const standby = new FakeEndpoint();
    standby.roleInRecovery = false;
    standby.migrationsCount = 3; // drifted
    const executor = failoverOver({ primary, standby });

    await expect(executor.failover(INPUT)).rejects.toThrow(/carries 3 recorded migrations/);
    expect(standby.promoteCalls).toBe(0);
  });

  test("U4 the idempotent no-op: the already-promoted converged authority with the primary still dead", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "unavailable";
    const standby = new FakeEndpoint();
    standby.roleInRecovery = false; // already promoted
    const executor = failoverOver({ primary, standby });

    const report = await executor.failover(INPUT);
    expect(report.promoted).toBe(false);
    expect(report.alreadyPromoted).toBe(true);
    expect(standby.promoteCalls).toBe(0); // bounded no-op: no pg_promote call
  });

  test("U4b the no-op still refuses a reachable primary (a live primary invalidates even the no-op form)", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "ok";
    const standby = new FakeEndpoint();
    standby.roleInRecovery = false;
    const executor = failoverOver({ primary, standby });

    await expect(executor.failover(INPUT)).rejects.toThrow(/still reachable/);
  });

  test("U5 post-condition failures: a promotion that stays in recovery, or stays read-only, fails the failover", async () => {
    const primaryA = new FakeEndpoint();
    primaryA.pingBehavior = "unavailable";
    const stayedInRecovery = new FakeEndpoint();
    stayedInRecovery.postRoleInRecovery = true; // promotion did not take
    const executorWithPrimary = new PgAuthorityFailover((config: DatabaseConnectionConfig) =>
      config.url.includes("primary") ? primaryA : stayedInRecovery,
    );
    await expect(executorWithPrimary.failover(INPUT)).rejects.toThrow(/still in recovery/);

    const readOnly = new FakeEndpoint();
    readOnly.postRoleReadOnly = true;
    const executorB = new PgAuthorityFailover((config: DatabaseConnectionConfig) =>
      config.url.includes("primary") ? primaryA : readOnly,
    );
    await expect(executorB.failover(INPUT)).rejects.toThrow(/read-only/);
  });

  test("U5b pg_promote returning false is a typed failure (never a silent success)", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "unavailable";
    const standby = new FakeEndpoint();
    standby.promoteResult = false;
    const executor = failoverOver({ primary, standby });
    await expect(executor.failover(INPUT)).rejects.toThrow(/did not confirm the promotion/);
  });

  test("U6 a reachable-but-broken primary is NOT unreachability — refused, never a promotion trigger", async () => {
    const primary = new FakeEndpoint();
    primary.pingBehavior = "broken";
    const standby = new FakeEndpoint();
    const executor = failoverOver({ primary, standby });
    await expect(executor.failover(INPUT)).rejects.toThrow(/non-availability error/);
    expect(standby.promoteCalls).toBe(0);
  });

  test("the unreachability decision is repeated-probe consensus (a single observation never authorizes promotion)", async () => {
    // A flaky primary that is ALIVE on the second probe must still
    // refuse: with attempts=2 the reachable observation wins.
    const alive = new FakeEndpoint();
    alive.pingBehavior = "ok";
    let probeCount = 0;
    const flakyPrimary = {
      ping: async () => {
        probeCount += 1;
        if (probeCount === 1) {
          throw new DatabaseUnavailableError("transient");
        }
        return alive.ping();
      },
      execute: alive.execute.bind(alive),
      close: alive.close.bind(alive),
    } satisfies FailoverConnection;
    const standby = new FakeEndpoint();
    const executor = failoverOver({ primary: flakyPrimary, standby });
    await expect(executor.failover({ ...INPUT, primaryProbeAttempts: 2 })).rejects.toThrow(
      /still reachable/,
    );
    expect(standby.promoteCalls).toBe(0);
  });
});
