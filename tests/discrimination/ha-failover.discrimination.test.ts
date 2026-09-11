/**
 * Discrimination tests — the WORK-057 / D-08 HA failover protections
 * (CRITICAL assurance; the worker-runbook rule: "For HIGH_ASSURANCE
 * and CRITICAL, add an explicit discrimination test that proves a
 * weakened protection is rejected").
 *
 * The Work Order's mutation battery: "Failover duplicating effects,
 * reconstructing authority, or serving against a dead authority is
 * rejected." Every weakened form below is driven through the REAL
 * guards (the unit seam with scripted endpoints; the real-PG
 * integration drill proves the same gates over real primary+standby
 * PostgreSQL):
 *
 *  - D1 SPLIT-BRAIN (the duplicating-effects/authorities mutation):
 *    a failover request while the primary is REACHABLE is rejected
 *    before pg_promote — a weakened guard that "trusts the operator"
 *    and promotes anyway is unrepresentable (the refusal fires on
 *    every reachable observation, including mid-race);
 *  - D2 RECONSTRUCTED AUTHORITY: a writable FOREIGN endpoint at the
 *    standby address (no Zeck schema, or a drifted migration count)
 *    is refused even with the primary dead — failover RESTORES
 *    authority, it never constructs or adopts a different one;
 *  - D3 SERVING AGAINST A DEAD AUTHORITY: every probe/control-plane
 *    operation against the dead primary fails with the OWNING
 *    adapter's typed `DatabaseUnavailableError` (never a silent null,
 *    never a silent success — a degraded control plane refusing to
 *    serve is CORRECT behavior); the failover executor itself treats
 *    that class — and ONLY that class — as unreachability;
 *  - D4 ASPIRATIONAL TARGETS: unbounded/absent topology targets, an
 *    RTO beyond the repository target and an RPO beyond the
 *    replication-path target are breaches (never passes); the
 *    mode projection keeps the D-07 evaluator as the ONE authority;
 *  - D5 THE HONEST-NOT-A-SIMULATION boundary: missing local
 *    PostgreSQL binaries are a typed refusal naming the operator
 *    action — a simulated topology is unrepresentable;
 *  - D6 SOURCE-LEVEL structural probes: the HA plane carries no
 *    provider vocabulary and no credential-shaped literals; the
 *    drill surface keeps the honest NOT RUN vocabulary; the
 *    ZECK_HA_* variables are declared with the correct
 *    credentialShaped flags; the recovery-targets ha extension covers
 *    every environment class.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolvePostgresBinaries } from "../../deploy/ha";
import type { DatabaseConnectionConfig } from "../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../src/platform/db/errors";
import {
  AuthorityFailoverError,
  type FailoverConnection,
  PgAuthorityFailover,
} from "../../src/platform/db/ha/failover";
import {
  failoverTargetForMode,
  HaTopologyError,
  parseHaTopologyTargets,
} from "../../src/platform/db/ha/topology";
import type { Query, QueryResult } from "../../src/platform/db/port";
import { evaluateDrillAgainstTarget } from "../../src/platform/recovery/rto-rpo";
import { resolveHaBinaries } from "../integration/postgres/ha-world";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** One scripted endpoint (the unit-seam double of the D-07 convention). */
class ScriptedEndpoint implements FailoverConnection {
  public pingBehavior: "ok" | "unavailable" = "ok";
  public inRecovery = true;
  public readOnly = false;
  public replayTimestamp: string | null = "2026-09-10T12:00:00.000Z";
  public migrationsCount = 29;
  public migrationsError: string | null = null;
  public promoteCalls = 0;
  public postInRecovery = false;
  public postReadOnly = false;

  async ping(): Promise<{ serverVersion: string; serverVersionNum: number }> {
    if (this.pingBehavior === "unavailable") {
      throw new DatabaseUnavailableError("endpoint unreachable (scripted)");
    }
    return { serverVersion: "PostgreSQL 16.4 (scripted)", serverVersionNum: 160004 };
  }

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    if (query.sql.includes("pg_promote")) {
      this.promoteCalls += 1;
      return { rows: [{ promoted: true } as T], rowCount: 1 };
    }
    if (query.sql.includes("pg_is_in_recovery")) {
      const promoted = this.promoteCalls > 0;
      return {
        rows: [
          {
            in_recovery: promoted ? this.postInRecovery : this.inRecovery,
            read_only: promoted ? this.postReadOnly : this.readOnly,
            lsn: "0/123456",
            replay_ts: this.replayTimestamp,
          } as T,
        ],
        rowCount: 1,
      };
    }
    if (query.sql.includes("platform.schema_migrations")) {
      if (this.migrationsError !== null) {
        throw new Error(this.migrationsError);
      }
      return { rows: [{ count: String(this.migrationsCount) } as T], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${query.sql}`);
  }

  async close(): Promise<void> {}
}

function executorOver(
  primary: FailoverConnection,
  standby: FailoverConnection,
): PgAuthorityFailover {
  return new PgAuthorityFailover((config: DatabaseConnectionConfig) =>
    config.url.includes("primary") ? primary : standby,
  );
}

const INPUT = {
  primaryUrl: "postgres://postgres@127.0.0.1:9501/primary-authority",
  standbyUrl: "postgres://postgres@127.0.0.1:9502/standby-authority",
  mode: "asynchronous" as const,
  primaryProbeAttempts: 1,
};

describe("the WORK-057 HA failover discrimination battery (D-08)", () => {
  test("D1 a failover that would create two writable authorities is rejected before any promotion", async () => {
    // The weakened form: "the operator says the primary is dead —
    // trust them and promote". The REAL guard refuses on every
    // reachable observation; the promotion is never attempted.
    const primary = new ScriptedEndpoint();
    primary.pingBehavior = "ok"; // ALIVE
    const standby = new ScriptedEndpoint();
    const executor = executorOver(primary, standby);
    await expect(executor.failover(INPUT)).rejects.toThrow(AuthorityFailoverError);
    await expect(executor.failover(INPUT)).rejects.toThrow(/two writable authorities — refuse/);
    expect(standby.promoteCalls).toBe(0);

    // The mid-race weakening ("one unreachable observation is
    // enough"): a flaky primary that answers on the second probe is
    // STILL refused — repeated-probe consensus is mandatory.
    let probes = 0;
    const flaky: FailoverConnection = {
      ping: async () => {
        probes += 1;
        if (probes === 1) {
          throw new DatabaseUnavailableError("transient");
        }
        return { serverVersion: "PostgreSQL 16.4 (scripted)", serverVersionNum: 160004 };
      },
      execute: async <T>(query: Query) => primary.execute<T>(query),
      close: async () => undefined,
    };
    const raceStandby = new ScriptedEndpoint();
    const raceExecutor = executorOver(flaky, raceStandby);
    await expect(raceExecutor.failover({ ...INPUT, primaryProbeAttempts: 2 })).rejects.toThrow(
      /still reachable/,
    );
    expect(raceStandby.promoteCalls).toBe(0);
  });

  test("D2 a failover that would reconstruct or adopt a different authority is rejected", async () => {
    const primary = new ScriptedEndpoint();
    primary.pingBehavior = "unavailable";
    // The weakened form: "any writable endpoint at the standby
    // address is the recovered authority". A FOREIGN database (no
    // Zeck schema) is refused.
    const foreign = new ScriptedEndpoint();
    foreign.inRecovery = false;
    foreign.migrationsError = 'relation "platform.schema_migrations" does not exist';
    await expect(executorOver(primary, foreign).failover(INPUT)).rejects.toThrow(
      /not a converged Zeck authority/,
    );
    expect(foreign.promoteCalls).toBe(0);

    // A Zeck-shaped endpoint with a DRIFTED migration count is also
    // refused (a partial/foreign restore is not the authority).
    const drifted = new ScriptedEndpoint();
    drifted.inRecovery = false;
    drifted.migrationsCount = 3;
    await expect(executorOver(primary, drifted).failover(INPUT)).rejects.toThrow(
      /carries 3 recorded migrations/,
    );

    // The topology vocabulary is closed: an unknown topology shape
    // (the "any topology is declarable" weakening) is a typed error.
    expect(() =>
      parseHaTopologyTargets({
        rtoTargetMs: 1,
        rpoTargetMs: 0,
        scope: "s",
        measurement: "m",
        ha: {
          topology: "multi-master",
          replication: { asynchronous: { rpoTargetMs: 1 }, synchronous: { rpoTargetMs: 0 } },
          failover: { rtoTargetMs: 1, scope: "s", measurement: "m" },
        },
      }),
    ).toThrow(HaTopologyError);
  });

  test("D3 serving against a dead authority is rejected with the owning typed error class", async () => {
    // The weakened form: "the control plane keeps serving cached
    // state when the authority dies". Every operation against the
    // dead endpoint fails with DatabaseUnavailableError — including
    // the failover executor's own probes (which treat that class,
    // and ONLY that class, as unreachability).
    const dead = new ScriptedEndpoint();
    dead.pingBehavior = "unavailable";
    const standby = new ScriptedEndpoint();
    const executor = executorOver(dead, standby);

    const report = await executor.failover(INPUT);
    expect(report.promoted).toBe(true); // unreachability (the TYPED class) authorizes promotion

    // A reachable-but-broken primary is NOT unreachability: the
    // honest diagnosis is a refusal, never a promotion trigger.
    const broken: FailoverConnection = {
      ping: async () => {
        throw new SyntaxError("connection reset mid-protocol");
      },
      execute: async <T>(_query: Query) => ({ rows: [], rowCount: 0 }) as QueryResult<T>,
      close: async () => undefined,
    };
    const brokenStandby = new ScriptedEndpoint();
    await expect(executorOver(broken, brokenStandby).failover(INPUT)).rejects.toThrow(
      /non-availability error/,
    );
    expect(brokenStandby.promoteCalls).toBe(0);
  });

  test("D4 aspirational or unbounded targets are unrepresentable; out-of-target drills are breaches, never passes", () => {
    const valid = {
      rtoTargetMs: 900000,
      rpoTargetMs: 0,
      scope: "s",
      measurement: "m",
      ha: {
        topology: "primary-standby",
        replication: { asynchronous: { rpoTargetMs: 60000 }, synchronous: { rpoTargetMs: 0 } },
        failover: { rtoTargetMs: 900000, scope: "s", measurement: "m" },
      },
    };
    const ha = parseHaTopologyTargets(valid);
    // The weakened targets: absent, unbounded, negative, prose.
    for (const bad of [undefined, -1, 1.5, "60000", 999999999999]) {
      expect(() =>
        parseHaTopologyTargets({
          ...valid,
          ha: {
            ...valid.ha,
            failover: { ...valid.ha.failover, rtoTargetMs: bad },
          },
        }),
      ).toThrow(HaTopologyError);
    }
    // A drill beyond the targets is a BREACH (the honest measurement
    // discipline — never a silent pass): RTO 900001ms vs the 900000ms
    // target, RPO 60001ms vs the 60000ms async target.
    const lateDrill = {
      scenarioId: "authority-failover",
      environment: "production",
      revision: "r",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:15:00.001Z",
      phases: [],
      rtoMs: 900001,
      rpoMs: 60001,
      recovered: true,
    };
    const evaluation = evaluateDrillAgainstTarget(
      lateDrill,
      failoverTargetForMode(ha, "asynchronous"),
    );
    expect(evaluation.breaches.join(" ")).toContain("RTO 900001ms exceeds");
    expect(evaluation.breaches.join(" ")).toContain("RPO 60001ms exceeds");
    expect(evaluation.rtoWithinTarget).toBe(false);
    expect(evaluation.rpoWithinTarget).toBe(false);
    // An unverified drill NEVER declares objectives met.
    const unverified = { ...lateDrill, rtoMs: 1, rpoMs: 0, recovered: false };
    const unverifiedEvaluation = evaluateDrillAgainstTarget(
      unverified,
      failoverTargetForMode(ha, "synchronous"),
    );
    expect(unverifiedEvaluation.breaches.join(" ")).toContain("did not verify recovery");
  });

  test("D5 a missing real topology is an honest typed refusal — never a simulated drill", () => {
    // The weakened form: "no binaries? simulate the topology and
    // report PASS". The real resolution fails closed with the
    // operator action; the honest gating is what the integration
    // suite uses (binaries or skip).
    expect(() =>
      resolvePostgresBinaries({
        ZECK_HA_POSTGRES_BIN: "/nonexistent/postgres/bin",
      }),
    ).toThrow(/does not contain postgres\/initdb binaries/);
    expect(() =>
      resolvePostgresBinaries({
        PATH: "",
      }),
    ).toThrow(/no local PostgreSQL binaries are available/);
    // The integration world's gate is the same honesty: null means
    // "not runnable here", never a fake topology.
    const binaries = resolveHaBinaries();
    expect(binaries === null || (binaries.postgres.length > 0 && binaries.initdb.length > 0)).toBe(
      true,
    );
  });

  test("D6 the HA plane stays provider-neutral, secret-free, and honest (source-level probes)", () => {
    const haSources = [
      "src/platform/db/ha/topology.ts",
      "src/platform/db/ha/replication.ts",
      "src/platform/db/ha/failover.ts",
      "deploy/ha.ts",
    ];
    const vendorWords = [
      "cloudflare",
      "vercel",
      "neon",
      "aws-sdk",
      "@aws-sdk",
      "aws4",
      "docker",
      "e2b",
    ];
    for (const file of haSources) {
      const content = read(file);
      for (const word of vendorWords) {
        expect(content, `${file} must not carry "${word}"`).not.toContain(`"${word}`);
      }
      // No credential-shaped literals (the B6 discipline).
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content).not.toMatch(/(password|secretAccessKey|apiToken)\s*[:=]\s*"[^"${}]+"/);
    }
    // The drill surface keeps the honest NOT RUN vocabulary and the
    // authority-failover command (the B9 discipline extended).
    const drill = read("deploy/drill.ts");
    expect(drill).toContain('"authority-failover"');
    expect(drill).toContain("NOT RUN");
    // The ZECK_HA_* variables carry the correct credential flags (the
    // B10 discipline).
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: readonly { name: string; credentialShaped: boolean; required: boolean }[];
    };
    const find = (name: string) => variables.variables.find((v) => v.name === name);
    expect(find("ZECK_HA_PRIMARY_URL")?.credentialShaped).toBe(true);
    expect(find("ZECK_HA_STANDBY_URL")?.credentialShaped).toBe(true);
    expect(find("ZECK_HA_REPLICATION_MODE")?.credentialShaped).toBe(false);
    expect(find("ZECK_HA_POSTGRES_BIN")?.credentialShaped).toBe(false);
    // The recovery-targets ha extension covers every environment
    // class (the B8 discipline extended).
    const targets = JSON.parse(read("deploy/manifests/recovery-targets.json")) as {
      targets: Record<string, { ha?: unknown }>;
    };
    for (const environment of ["local", "ci", "preview", "staging", "production"]) {
      expect(
        targets.targets[environment]?.ha,
        `${environment} declares its HA topology`,
      ).toBeDefined();
    }
  });
});
