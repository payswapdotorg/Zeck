/**
 * Integration — THE HA AUTHORITY-FAILOVER DRILL over REAL PostgreSQL
 * primary + standby (WORK-057 / D-08, AVA-002 + AVA-004).
 *
 * WHAT THIS PROVES (the Work Order's acceptance criteria):
 *
 *   H1 THE EXECUTED FAILOVER DRILL: real governed work (the REAL
 *      worker-fabric world over the REAL module services) is seeded on
 *      a real primary with a real streaming standby; the primary is
 *      SIGKILLed; the standby is promoted through the governed
 *      failover executor; the promoted authority's durable state is
 *      EXACTLY the pre-loss state (recovery RESTORED the authority);
 *      the D-07 invariant-gate restore proof (12 checks) passes
 *      IDENTICALLY; the in-flight governed work converges through the
 *      EXISTING dispatch/execution idempotency with ZERO duplicated
 *      side effects; measured RTO/RPO stay within the repository
 *      targets.
 *
 *      The zero-duplication proof is two-phase and durable-ledger
 *      based: (A) immediately after promotion, every pre-loss durable
 *      row (executions, event ledgers, dispatch envelopes, wallets) is
 *      EXACTLY equal to the primary's pre-loss snapshot (RPO 0 by data
 *      equality, not by clock luck); (B) after convergence, the
 *      pre-loss ledgers are a strict prefix of the post-failover
 *      ledgers, every in-flight execution carries EXACTLY ONE
 *      completion event, and the sandbox provider saw EXACTLY ONE
 *      dispatch per execution across both eras; the durable replay
 *      plan classifies the in-flight envelopes as re-drive (the
 *      truthful transport-loss record) and a SECOND re-drive is
 *      proven a zero-effect no-op — the existing idempotency is the
 *      duplication guard.
 *
 *   H2 THE SYNCHRONOUS PATH (AVA-002: RPO 0 where configured): with
 *      synchronous_standby_names configured, a commit the primary
 *      acknowledged is GUARANTEED present on the promoted authority —
 *      zero lost writes proven by data survival across the SIGKILL.
 *
 *   H3 DISCRIMINATION — SPLIT-BRAIN REFUSAL: failover with a LIVE
 *      primary is refused (two writable authorities is the one state
 *      the PostgreSQL-sole-authority invariant cannot tolerate); the
 *      standby is NOT promoted and still a replica; the real failover
 *      still completes after the primary actually dies.
 *
 *   H4 CONCURRENCY-CRASH-SAFETY: a concurrent failover-executor race
 *      resolves with exactly one promotion, and two post-failover
 *      control-plane fabrics recover the SAME in-flight executions
 *      concurrently — no claim is stranded or double-applied.
 *
 *   H5 THE CLI OPERATOR PATH: `deploy:drill authority-failover
 *      --environment local` as a real subprocess (the exact operator
 *      command) exits 0 with recovered:true, the invariant gate green,
 *      the fail-closed and idempotence proofs, and measured RTO/RPO
 *      within the local HA targets.
 *
 *   H6 FAIL-CLOSED DEGRADATION: the control plane REFUSES to serve
 *      against the dead primary (typed DatabaseUnavailableError) —
 *      correct behavior, measured as such; the promoted authority
 *      accepts fresh governed writes through the real services.
 *
 * Binaries gate: the suite needs local PostgreSQL server binaries
 * (ZECK_HA_POSTGRES_BIN or PATH) — without them it skips with an
 * explicit reason (a simulated topology is never an option).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { type LocalHaServer, startLocalPostgresServer } from "../../../deploy/ha";
import { createBudgetRecoveryInvariants } from "../../../src/modules/budgets/adapters/recovery-invariants";
import { createArtifactLedgerRecoveryInvariants } from "../../../src/modules/deployments/adapters/recovery-inventory";
import { createExecutionRecoveryInvariants } from "../../../src/modules/executions/adapters/recovery-invariants";
import { EXECUTION_STATES } from "../../../src/modules/executions/public";
import { parseConnectionConfig } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../../src/platform/db/errors";
import { PgAuthorityFailover } from "../../../src/platform/db/ha/failover";
import { PgReplicationProbe } from "../../../src/platform/db/ha/replication";
import {
  failoverTargetForMode,
  parseHaTopologyDocument,
} from "../../../src/platform/db/ha/topology";
import { PgDatabasePort } from "../../../src/platform/db/pg-database-port";
import type { DatabasePort } from "../../../src/platform/db/port";
import { shippedMigrations, startAuthoritativeDatabase } from "../../../src/platform/db/startup";
import { verifyRecoveredAuthority } from "../../../src/platform/recovery/authority-verification";
import { runRecoveryDrill } from "../../../src/platform/recovery/drill";
import {
  evaluateDrillAgainstTarget,
  parseRecoveryTargets,
} from "../../../src/platform/recovery/rto-rpo";
import { planTransportRecovery } from "../../../src/platform/recovery/transport-recovery";
import {
  generateId,
  type HaTopology,
  type HaWorld,
  interruptWorkerMidFlight,
  pickFreePorts,
  resolveHaBinaries,
  seedHaWorld,
  startHaTopology,
} from "./ha-world";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARIES = resolveHaBinaries();

const RECOVERY_TARGETS_SOURCE = readFileSync(
  resolve(REPO_ROOT, "deploy", "manifests", "recovery-targets.json"),
  "utf8",
);
const LOCAL_HA = parseHaTopologyDocument(JSON.parse(RECOVERY_TARGETS_SOURCE)).local;
const LOCAL_BASE_TARGET = parseRecoveryTargets(RECOVERY_TARGETS_SOURCE).targets.local;
const LOCAL_HA_TARGETS = LOCAL_HA as NonNullable<typeof LOCAL_HA>;
const LOCAL_BASE = LOCAL_BASE_TARGET as NonNullable<typeof LOCAL_BASE_TARGET>;

type Row = readonly string[];
interface AuthoritySnapshot {
  readonly executions: readonly Row[];
  readonly events: readonly Row[];
  readonly envelopes: readonly Row[];
  readonly wallets: readonly Row[];
}

async function snapshotAuthority(db: DatabasePort): Promise<AuthoritySnapshot> {
  const query = async (table: string, columns: string): Promise<readonly Row[]> => {
    const result = await db.execute<Record<string, string>>({
      sql: `SELECT ${columns} FROM ${table} ORDER BY 1, 2`,
    });
    return result.rows.map((row) => Object.values(row).map((value) => String(value ?? "null")));
  };
  const [executions, events, envelopes, wallets] = await Promise.all([
    query("executions.executions", "id, status, created_at, updated_at"),
    query("executions.execution_events", "execution_id, sequence, type, occurred_at"),
    query("queue_transport.dispatch_envelopes", "id, state, publish_attempts, applied_at"),
    query("budgets.wallets", "id, balance_micro_usd, updated_at"),
  ]);
  return { executions, events, envelopes, wallets };
}

async function invariantGateOf(url: string) {
  const handle = await startAuthoritativeDatabase(url, { poolOverrides: { max: 4 } });
  try {
    return await verifyRecoveredAuthority(handle.port, {
      expectedMigrationCount: shippedMigrations().length,
      moduleInvariants: [
        createExecutionRecoveryInvariants(handle.port, EXECUTION_STATES),
        createBudgetRecoveryInvariants(handle.port),
        createArtifactLedgerRecoveryInvariants(handle.port),
      ],
    });
  } finally {
    await handle.close();
  }
}

describe("the HA authority-failover drill over real PostgreSQL (WORK-057 D-08)", () => {
  const liveServers: LocalHaServer[] = [];
  const topologies: HaTopology[] = [];

  afterAll(async () => {
    for (const topology of topologies) {
      await topology.terminate().catch(() => undefined);
    }
    for (const server of liveServers) {
      await server.terminate("stop").catch(() => undefined);
      server.dispose();
    }
  });

  test.skipIf(BINARIES === null)(
    "H1 the executed failover: restored-authority equality → identical D-07 gate → convergence with zero duplicated effects → measured RTO/RPO within targets",
    { timeout: 240_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries);
      topologies.push(topology);
      const identity = { tenantId: generateId(), applicationId: generateId() };
      const applicationId = identity.applicationId;

      // === SEED REAL GOVERNED WORK ON THE PRIMARY ===
      const primaryHandle = await startAuthoritativeDatabase(topology.primaryAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      let completed = "";
      let inFlight: string[] = [];
      let preLoss: AuthoritySnapshot | null = null;
      const preLossEvents = new Map<string, readonly { readonly kind: string }[]>();
      try {
        const world: HaWorld = await seedHaWorld(primaryHandle.port, identity);
        // One execution COMPLETED pre-loss (a settled ledger that must
        // stay exactly as it is across the failover).
        completed = await world.createDispatchedExecution("h1-settled");
        const settleFabric = await world.createFabric();
        for (let i = 0; i < 5; i += 1) {
          await settleFabric.consumeBatch();
        }
        expect((await world.service.getExecution(applicationId, completed))?.status).toBe(
          "COMPLETED",
        );
        await settleFabric.stop("settled");

        // Two executions IN FLIGHT (interrupted workers whose region
        // dies with the primary).
        inFlight = [
          await world.createDispatchedExecution("h1-inflight-one"),
          await world.createDispatchedExecution("h1-inflight-two"),
        ];
        for (const executionId of inFlight) {
          await interruptWorkerMidFlight(world, executionId);
        }

        // The pre-loss durable snapshot (the equality baseline).
        preLoss = await snapshotAuthority(primaryHandle.port);
        for (const executionId of [completed, ...inFlight]) {
          preLossEvents.set(executionId, await world.eventsOf(executionId));
        }
        // Only the settled execution dispatched pre-loss.
        expect(world.provider.dispatchCount()).toBe(1);

        // Replication catch-up gate (LSN equality before the loss).
        const probe = new PgReplicationProbe();
        const catchup = await probe.waitForStandbyCatchup(
          topology.primary.adminUrl,
          "zeck_ha_standby",
          { timeoutMs: 30_000 },
        );
        expect(catchup.bytesBehind).toBeLessThanOrEqual(0);
      } finally {
        await primaryHandle.close();
      }

      // === LOSS → THE DRILL (RTO clock from the kill instant) ===
      const lossAt = await topology.losePrimary();
      const standbyUrl = topology.standbyAuthorityUrl;
      const baseline = preLoss as AuthoritySnapshot;
      const baselineEvents = preLossEvents;

      const drill = await runRecoveryDrill(
        {
          scenarioId: "authority-failover",
          environment: "local",
          revision: "work057-integration",
          lossAt,
          // Caught-up + quiescent anchor: the recovery point IS the
          // loss instant (LSN equality proven above; the drill wrote
          // nothing between catch-up and the kill).
          lastConsistentPointAt: lossAt,
          phases: [
            {
              name: "standby-promotion",
              description: "fail-closed preconditions then pg_promote on the real standby",
              action: async () => {
                const executor = new PgAuthorityFailover();
                const report = await executor.failover({
                  primaryUrl: topology.primaryAuthorityUrl,
                  standbyUrl,
                  mode: "asynchronous",
                });
                expect(report.promoted).toBe(true);
                expect(report.alreadyPromoted).toBe(false);
              },
            },
            {
              name: "restored-authority-equality",
              description:
                "the promoted authority's durable rows are EXACTLY the pre-loss snapshot (recovery RESTORES authority — RPO 0 by data equality)",
              action: async () => {
                const handle = await startAuthoritativeDatabase(standbyUrl, {
                  poolOverrides: { max: 4 },
                });
                try {
                  const restored = await snapshotAuthority(handle.port);
                  expect(restored).toEqual(baseline);
                } finally {
                  await handle.close();
                }
              },
            },
            {
              name: "authority-invariants",
              description: "the D-07 recovered-authority invariant gate on the promoted authority",
              action: async () => {
                const report = await invariantGateOf(standbyUrl);
                expect(report.verified).toBe(true);
                expect(report.checks.length).toBe(12);
                expect(report.violations).toEqual([]);
              },
            },
            {
              name: "replay-convergence",
              description:
                "the repointed control plane converges the in-flight work through the EXISTING idempotency (authority re-drive), and re-driving stays a no-op",
              action: async () => {
                const postHandle = await startAuthoritativeDatabase(standbyUrl, {
                  poolOverrides: { max: 4 },
                });
                try {
                  const postWorld = await seedHaWorld(postHandle.port, identity);
                  const fabric = await postWorld.createFabric();
                  // HALF 1 — the authority re-drive (queue-independent:
                  // the executions state machine converges the work —
                  // the R1 discipline: the fresh control plane over the
                  // promoted authority, zero queue involvement).
                  const recovery = await fabric.recover();
                  expect(recovery.abandonedClaims).toBe(2);
                  expect(recovery.applied + recovery.converged).toBe(2);
                  for (let i = 0; i < 5; i += 1) {
                    await fabric.consumeBatch();
                  }
                  await fabric.stop("converged");

                  // HALF 2 — THE RE-DRIVE NO-OP PROOF: the durable plan
                  // classifies the in-flight envelopes as re-drive (the
                  // truthful record: the transport lost the message;
                  // the authority converged the effect). Re-driving a
                  // second time must produce ZERO new effects — the
                  // existing idempotency is the duplication guard.
                  const plan = await planTransportRecovery(postHandle.port);
                  expect(plan.planned).toBe(true);
                  const settledItem = plan.items.find((entry) => entry.executionId === completed);
                  expect(settledItem?.recoveryClass).toBe("converged"); // consumed ⇒ applied pre-loss
                  for (const executionId of inFlight) {
                    const item = plan.items.find((entry) => entry.executionId === executionId);
                    expect(item?.state).toBe("published");
                    expect(item?.recoveryClass).toBe("re-drive");
                  }
                  const dispatchesBefore = postWorld.provider.dispatchCount();
                  const secondRecovery = await (await postWorld.createFabric()).recover();
                  expect(secondRecovery.abandonedClaims).toBe(0); // no stale claims remain
                  expect(secondRecovery.applied).toBe(0); // nothing re-applied
                  expect(postWorld.provider.dispatchCount()).toBe(dispatchesBefore);
                  // The converging control plane dispatched EXACTLY the
                  // in-flight executions — never the settled one again.
                  expect(dispatchesBefore).toBe(inFlight.length);
                } finally {
                  await postHandle.close();
                }
              },
            },
          ],
        },
        { now: () => new Date() },
      );

      expect(drill.recovered, JSON.stringify(drill.phases, null, 2)).toBe(true);
      expect(drill.rtoMs).not.toBeNull();
      const evaluation = evaluateDrillAgainstTarget(
        drill,
        failoverTargetForMode(LOCAL_HA_TARGETS, "asynchronous"),
      );
      expect(evaluation.breaches).toEqual([]);
      expect(evaluation.rtoWithinTarget).toBe(true);
      expect(evaluation.rpoWithinTarget).toBe(true);
      expect(drill.rtoMs as number).toBeLessThanOrEqual(LOCAL_BASE.rtoTargetMs);

      // === PHASE B: the zero-duplication ledger proof ===
      const postHandle = await startAuthoritativeDatabase(standbyUrl, {
        poolOverrides: { max: 4 },
      });
      try {
        const postWorld = await seedHaWorld(postHandle.port, identity);
        // Every pre-loss event ledger is a strict PREFIX of the
        // post-failover ledger (append-only; nothing rewritten).
        for (const executionId of [completed, ...inFlight]) {
          const before = baselineEvents.get(executionId) ?? [];
          const after = await postWorld.eventsOf(executionId);
          expect(after.slice(0, before.length)).toEqual(before);
        }
        // EXACTLY ONE completion per in-flight execution; the settled
        // ledger unchanged.
        for (const executionId of inFlight) {
          expect((await postWorld.service.getExecution(applicationId, executionId))?.status).toBe(
            "COMPLETED",
          );
          const completions = (await postWorld.eventsOf(executionId)).filter(
            (event) => event.kind === "execution.pass",
          );
          expect(completions).toHaveLength(1);
        }
        const settledCompletions = (await postWorld.eventsOf(completed)).filter(
          (event) => event.kind === "execution.pass",
        );
        expect(settledCompletions).toHaveLength(1);

        // The invariant gate is green AFTER convergence too.
        const finalGate = await invariantGateOf(standbyUrl);
        expect(finalGate.verified).toBe(true);
        expect(finalGate.checks.length).toBe(12);
      } finally {
        await postHandle.close();
      }
      // /dev/shm is a bounded resource: each drill's topology ends with
      // the test (the afterAll sweep stays as the failure safety net).
      await topology.terminate().catch(() => undefined);
    },
  );

  test.skipIf(BINARIES === null)(
    "H2 the synchronous path: a primary-acknowledged commit survives the failover (RPO 0 by data survival)",
    { timeout: 120_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries, { synchronousReplication: true });
      topologies.push(topology);
      const identity = { tenantId: generateId(), applicationId: generateId() };
      const handle = await startAuthoritativeDatabase(topology.primaryAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      let executionId = "";
      try {
        const world = await seedHaWorld(handle.port, identity);
        // The commit was acknowledged by the primary ⇒ the standby
        // FLUSHED it (synchronous_standby_names) ⇒ it must survive.
        executionId = await world.createDispatchedExecution("h2-sync-commit");
      } finally {
        await handle.close();
      }
      await topology.losePrimary();
      const executor = new PgAuthorityFailover();
      const report = await executor.failover({
        primaryUrl: topology.primaryAuthorityUrl,
        standbyUrl: topology.standbyAuthorityUrl,
        mode: "synchronous",
      });
      expect(report.promoted).toBe(true);

      const postHandle = await startAuthoritativeDatabase(topology.standbyAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      try {
        const rows = await postHandle.port.execute<{ count: string }>({
          sql: "SELECT count(*) AS count FROM executions.executions WHERE id = $1",
          parameters: [executionId],
        });
        expect(Number(rows.rows[0]?.count ?? 0)).toBe(1);
        const events = await postHandle.port.execute<{ kind: string }>({
          sql: "SELECT type AS kind FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence",
          parameters: [executionId],
        });
        expect(events.rows.length).toBeGreaterThan(0);
      } finally {
        await postHandle.close();
      }
      await topology.terminate().catch(() => undefined);
    },
  );

  test.skipIf(BINARIES === null)(
    "H3 discrimination: failover against a LIVE primary is refused — no promotion, standby still a replica; the real failover completes after the primary dies",
    { timeout: 120_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries);
      topologies.push(topology);
      const executor = new PgAuthorityFailover();
      // The primary is ALIVE: promotion must be refused (split-brain
      // guard) — never a silent partial state.
      await expect(
        executor.failover({
          primaryUrl: topology.primaryAuthorityUrl,
          standbyUrl: topology.standbyAuthorityUrl,
          mode: "asynchronous",
        }),
      ).rejects.toThrow(/primary authority is still reachable/);

      // NO promotion happened: the standby is still in recovery.
      const probe = new PgReplicationProbe();
      const role = await probe.standbyState(topology.standby.urlFor("postgres"));
      expect(role.inRecovery).toBe(true);

      // The refusal did not wedge the topology: after the primary
      // REALLY dies, the governed failover completes and the gate is
      // green on the promoted authority.
      await topology.losePrimary();
      const report = await executor.failover({
        primaryUrl: topology.primaryAuthorityUrl,
        standbyUrl: topology.standbyAuthorityUrl,
        mode: "asynchronous",
      });
      expect(report.promoted).toBe(true);
      const gate = await invariantGateOf(topology.standbyAuthorityUrl);
      expect(gate.verified).toBe(true);
      await topology.terminate().catch(() => undefined);
    },
  );

  test.skipIf(BINARIES === null)(
    "H4 concurrency: a failover race resolves with one promotion; concurrent recovery fabrics converge with zero duplicated effects",
    { timeout: 240_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries);
      topologies.push(topology);
      const identity = { tenantId: generateId(), applicationId: generateId() };
      const handle = await startAuthoritativeDatabase(topology.primaryAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      const inFlight: string[] = [];
      try {
        const world = await seedHaWorld(handle.port, identity);
        for (const suffix of ["h4-a", "h4-b", "h4-c"]) {
          const executionId = await world.createDispatchedExecution(suffix);
          await interruptWorkerMidFlight(world, executionId);
          inFlight.push(executionId);
        }
        const probe = new PgReplicationProbe();
        await probe.waitForStandbyCatchup(topology.primary.adminUrl, "zeck_ha_standby", {
          timeoutMs: 30_000,
        });
      } finally {
        await handle.close();
      }

      await topology.losePrimary();

      // CONCURRENT FAILOVER RACE: PostgreSQL's promotion is a ONE-TIME
      // cluster transition — concurrent pg_promote(wait) calls coalesce
      // into the same promotion (both callers observe success) or the
      // later caller fails closed with the honest typed error. Either
      // way there is exactly ONE promoted, writable authority (proven
      // below by the role probe + the invariant gate) — never a split
      // brain, never a double effect.
      const results = await Promise.allSettled([
        new PgAuthorityFailover().failover({
          primaryUrl: topology.primaryAuthorityUrl,
          standbyUrl: topology.standbyAuthorityUrl,
          mode: "asynchronous",
        }),
        new PgAuthorityFailover().failover({
          primaryUrl: topology.primaryAuthorityUrl,
          standbyUrl: topology.standbyAuthorityUrl,
          mode: "asynchronous",
        }),
      ]);
      let successes = 0;
      for (const result of results) {
        if (result.status === "fulfilled") {
          successes += 1;
          // Every success is either the promotion or the no-op form —
          // never a third state.
          expect(result.value.promoted !== result.value.alreadyPromoted).toBe(true);
        } else {
          expect(result.reason).toBeInstanceOf(Error);
        }
      }
      expect(successes).toBeGreaterThanOrEqual(1);
      // The topology ended in exactly ONE writable authority.
      const probe = new PgReplicationProbe();
      const role = await probe.standbyState(topology.standby.urlFor("postgres"));
      expect(role.inRecovery).toBe(false);

      // CONCURRENT RECOVERY: two fabrics over the promoted authority
      // recover the SAME executions; the existing idempotency (single
      // live claim + lease epochs) keeps every effect exactly-once.
      const postHandle = await startAuthoritativeDatabase(topology.standbyAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      try {
        const postWorld = await seedHaWorld(postHandle.port, identity);
        const fabricOne = await postWorld.createFabric();
        const fabricTwo = await postWorld.createFabric();
        const [recoveryOne, recoveryTwo] = await Promise.all([
          fabricOne.recover(),
          fabricTwo.recover(),
        ]);
        // Every execution was recovered (a concurrent fabric may
        // additionally observe converged-elsewhere terminal states —
        // the counter is the observation, the LEDGER below is the
        // exactly-once proof).
        const totalRecovered =
          recoveryOne.applied + recoveryOne.converged + recoveryTwo.applied + recoveryTwo.converged;
        expect(totalRecovered).toBeGreaterThanOrEqual(inFlight.length);
        for (let i = 0; i < 6; i += 1) {
          await fabricOne.consumeBatch();
          await fabricTwo.consumeBatch();
        }
        for (const executionId of inFlight) {
          expect(
            (await postWorld.service.getExecution(identity.applicationId, executionId))?.status,
          ).toBe("COMPLETED");
          const completions = (await postWorld.eventsOf(executionId)).filter(
            (event) => event.kind === "execution.pass",
          );
          expect(completions).toHaveLength(1);
        }
        expect(postWorld.provider.dispatchCount()).toBe(inFlight.length);
        await fabricOne.stop("done");
        await fabricTwo.stop("done");
        const gate = await invariantGateOf(topology.standbyAuthorityUrl);
        expect(gate.verified).toBe(true);
      } finally {
        await postHandle.close();
      }
      await topology.terminate().catch(() => undefined);
    },
  );

  test.skipIf(BINARIES === null)(
    "H6 fail-closed degradation: the control plane refuses the dead primary and serves fresh governed writes on the promoted authority",
    { timeout: 120_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries);
      topologies.push(topology);
      const identity = { tenantId: generateId(), applicationId: generateId() };
      const handle = await startAuthoritativeDatabase(topology.primaryAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      await handle.close();
      await topology.losePrimary();
      await new PgAuthorityFailover().failover({
        primaryUrl: topology.primaryAuthorityUrl,
        standbyUrl: topology.standbyAuthorityUrl,
        mode: "asynchronous",
      });

      // The repointed control plane REFUSES the dead primary (the
      // typed unavailability class — refusing to serve against a dead
      // authority is CORRECT behavior, measured as such).
      const deadPort = new PgDatabasePort(
        parseConnectionConfig(topology.primaryAuthorityUrl, { max: 1 }),
      );
      await expect(deadPort.execute({ sql: "SELECT 1" })).rejects.toThrow(DatabaseUnavailableError);
      await deadPort.close();

      // The promoted authority SERVES fresh governed writes through
      // the real services (the new authority is not a museum).
      const postHandle = await startAuthoritativeDatabase(topology.standbyAuthorityUrl, {
        poolOverrides: { max: 4 },
      });
      try {
        const postWorld = await seedHaWorld(postHandle.port, identity);
        const fresh = await postWorld.createDispatchedExecution("h6-post-failover-write");
        const fabric = await postWorld.createFabric();
        for (let i = 0; i < 5; i += 1) {
          await fabric.consumeBatch();
        }
        expect((await postWorld.service.getExecution(identity.applicationId, fresh))?.status).toBe(
          "COMPLETED",
        );
        await fabric.stop("done");
      } finally {
        await postHandle.close();
      }
      await topology.terminate().catch(() => undefined);
    },
  );

  test.skipIf(BINARIES === null)(
    "H5 the CLI operator path: deploy:drill authority-failover --environment local exits 0 with the full drill evidence",
    { timeout: 300_000 },
    async () => {
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      // A test-owned LIVE local authority (migrated zeck_local on a
      // real server): the drill READS it through the D-07 backup
      // engine and never touches it; it must stay up during the drill.
      const [livePort] = await pickFreePorts(1);
      const liveRoot = `/tmp/zeck-ha-cli-live-${generateId().slice(0, 8)}`;
      const live = await startLocalPostgresServer({
        dataDir: `${liveRoot}/data`,
        port: livePort as number,
        binaries,
        label: "cli-live-authority",
      });
      liveServers.push(live);
      const adminClient = new Client({ connectionString: live.adminUrl });
      await adminClient.connect();
      try {
        await adminClient.query("CREATE DATABASE zeck_local");
      } finally {
        await adminClient.end();
      }
      const liveHandle = await startAuthoritativeDatabase(live.urlFor("zeck_local"), {
        poolOverrides: { max: 4 },
      });
      await liveHandle.close();

      const [drillPrimaryPort, drillStandbyPort] = await pickFreePorts(2);
      const env: Record<string, string> = {
        ...process.env,
        ZECK_ENVIRONMENT: "local",
        ZECK_PG_ADMIN_URL: live.adminUrl,
        ZECK_LOCAL_DATA_ROOT: `/tmp/zeck-ha-cli-${generateId().slice(0, 8)}`,
      } as Record<string, string>;
      // Absolute binary paths only (a PATH-resolved "postgres" is not
      // a directory the drill can declare).
      if (BINARIES?.postgres.includes("/")) {
        env.ZECK_HA_POSTGRES_BIN = resolve(BINARIES.postgres, "..");
      }
      let output = "";
      try {
        output = execFileSync(
          "bun",
          [
            "run",
            "deploy:drill",
            "--",
            "authority-failover",
            "--environment",
            "local",
            "--primary-port",
            String(drillPrimaryPort),
            "--standby-port",
            String(drillStandbyPort),
          ],
          { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 240_000 },
        );
      } catch (error) {
        const failure = error as { stderr?: string; message?: string };
        throw new Error(
          `the CLI drill failed: ${failure.message ?? "unknown"}\nstderr:\n${failure.stderr ?? "none"}`,
        );
      }
      const document = JSON.parse(output.slice(output.indexOf("{"))) as {
        drill: { recovered: boolean; rtoMs: number | null; rpoMs: number | null };
        objectives: { evaluation: { breaches: string[] } };
        authorityInvariants: { verified: boolean; checks: string[] };
        failClosed: { deadPrimaryRefused: boolean };
        failoverRerun: { alreadyPromoted: boolean; promoted: boolean };
      };
      expect(document.drill.recovered).toBe(true);
      expect(document.objectives.evaluation.breaches).toEqual([]);
      expect(document.authorityInvariants.verified).toBe(true);
      expect(document.authorityInvariants.checks.length).toBe(12);
      expect(document.failClosed.deadPrimaryRefused).toBe(true);
      expect(document.failoverRerun.alreadyPromoted).toBe(true);
      expect(document.failoverRerun.promoted).toBe(false);
      expect(document.drill.rtoMs).not.toBeNull();
      expect(document.drill.rpoMs).toBe(0);
      await live.terminate("stop").catch(() => undefined);
      live.dispose();
    },
  );
});
