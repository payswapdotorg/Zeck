/**
 * Integration — the provider-redundancy machinery over REAL PostgreSQL
 * (WORK-060 / D-08, AVA-003; checkpoints IDENTITY-IDEMPOTENCY,
 * EXECUTION-PROVENANCE, SELF-HOSTING-BOUNDARY evidence).
 *
 * WHAT THIS PROVES:
 *
 *   R1 THE EXECUTED RELATIONAL-STATE FAILOVER (the compact drill form):
 *      a REAL disposable primary (initdb + the production startup path
 *      with the full shipped migration set) with a REAL streaming
 *      standby; a governed durable write before the loss; the primary
 *      SIGKILLed; the governed promotion through the REAL
 *      PgAuthorityFailover executor; the pre-loss durable write
 *      SURVIVES on the promoted authority (RPO 0 by data survival);
 *      the promoted authority is schema-converged; measured RTO within
 *      the local HA failover target.
 *
 *   R2 THE TYPED SELECTION over the real manifest: every durable
 *      concern's declared alternate is selected with deterministic
 *      content-addressed provenance; the selection is IDEMPOTENT over
 *      the same revision window; AMBIENT SUBSTITUTION (a hostile
 *      requested provider) is refused with the typed refusal.
 *
 *   R3 EXECUTION-PROVENANCE: the selection provenance replay is
 *      byte-identical (the canonical decision form + digest
 *      re-derive).
 *
 * Binaries gate: the failover half needs local PostgreSQL server
 * binaries (ZECK_HA_POSTGRES_BIN or PATH) — without them it skips
 * honestly (the typed-selection half still runs: it needs no
 * infrastructure); a CI runner whose PostgreSQL runs in a service
 * container cannot provide filesystem access for the standby
 * bootstrap, so the honest skip is the convention (never a simulated
 * PASS).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { PgAuthorityFailover } from "../../../src/platform/db/ha/failover";
import {
  failoverTargetForMode,
  parseHaTopologyDocument,
} from "../../../src/platform/db/ha/topology";
import { startAuthoritativeDatabase } from "../../../src/platform/db/startup";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import {
  providerFailoverProfiles,
  selectFailoverProvider,
} from "../../../src/platform/deployment/provider-failover";
import type { HaTopology } from "./ha-world";
import { resolveHaBinaries, startHaTopology } from "./ha-world";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARIES = resolveHaBinaries();

const MANIFEST = loadDeploymentManifest((file) =>
  readFileSync(resolve(REPO_ROOT, "deploy", "manifests", file), "utf8"),
);
const LOCAL_HA = parseHaTopologyDocument(
  JSON.parse(
    readFileSync(resolve(REPO_ROOT, "deploy", "manifests", "recovery-targets.json"), "utf8"),
  ),
).local;

describe("the typed failover selection over the real manifest (AVA-003)", () => {
  test("R2 every durable concern selects its declared alternate, idempotently, refusing ambient substitution", () => {
    const profiles = providerFailoverProfiles(MANIFEST);
    expect(profiles).toHaveLength(4);
    const window = { revision: "a".repeat(40), windowId: "integration-window" };
    for (const profile of profiles) {
      const observation = {
        concern: profile.concern,
        providerId: profile.primaryId,
        failureKind: "unavailable" as const,
        evidence: "integration-observed primary unavailability",
      };
      const selection = selectFailoverProvider(MANIFEST, observation, window);
      expect(selection.kind).toBe("alternate");
      if (selection.kind !== "alternate") {
        continue;
      }
      expect(selection.providerId).toBe(profile.alternate.id);

      // IDENTITY-IDEMPOTENCY over the revision window.
      const reselection = selectFailoverProvider(MANIFEST, observation, window);
      expect(reselection.kind).toBe("alternate");
      if (reselection.kind === "alternate") {
        expect(reselection.provenance.selectionId).toBe(selection.provenance.selectionId);
      }

      // AMBIENT SUBSTITUTION refused with the typed refusal.
      const ambient = selectFailoverProvider(MANIFEST, observation, window, "rogue-provider");
      expect(ambient.kind).toBe("refused");
      if (ambient.kind !== "refused") {
        continue;
      }
      expect(ambient.refusal.kind).toBe("ambient-substitution");
      if (ambient.refusal.kind === "ambient-substitution") {
        expect(ambient.refusal.requestedProviderId).toBe("rogue-provider");
      }
    }
  });

  test("R3 EXECUTION-PROVENANCE: the selection provenance replays byte-identically", () => {
    const observation = {
      concern: "relational-state",
      providerId: "neon",
      failureKind: "unavailable" as const,
      evidence: "integration-observed primary unavailability",
    };
    const window = { revision: "b".repeat(40), windowId: "provenance-replay" };
    const first = selectFailoverProvider(MANIFEST, observation, window);
    const replay = selectFailoverProvider(MANIFEST, observation, window);
    expect(first.kind).toBe("alternate");
    expect(replay.kind).toBe("alternate");
    if (first.kind === "alternate" && replay.kind === "alternate") {
      expect(replay.provenance.canonicalForm).toBe(first.provenance.canonicalForm);
      expect(replay.provenance.selectionId).toBe(first.provenance.selectionId);
      // The provenance carries the governed procedure (replayable).
      expect(first.provenance.procedure).toContain("authority-failover");
      expect(first.provenance.failoverMode).toBe("governed-procedure");
    }
  });
});

describe("the executed relational-state failover over real PostgreSQL (AVA-003)", () => {
  const topologies: HaTopology[] = [];

  afterAll(async () => {
    for (const topology of topologies) {
      await topology.terminate().catch(() => undefined);
    }
  });

  test.skipIf(BINARIES === null)(
    "R1 the compact drill: real primary+standby, governed promotion, data survival, measured RTO (binaries gate)",
    { timeout: 240_000 },
    async () => {
      expect(BINARIES).not.toBeNull();
      const binaries = BINARIES as NonNullable<typeof BINARIES>;
      const topology = await startHaTopology(binaries, {});
      topologies.push(topology);
      try {
        // A governed durable write on the real primary (the production
        // startup path already applied the full shipped migration set).
        const markerId = randomUUID();
        const primaryHandle = await startAuthoritativeDatabase(topology.primaryAuthorityUrl, {
          poolOverrides: { max: 4 },
        });
        try {
          await primaryHandle.port.execute({ sql: "CREATE SCHEMA IF NOT EXISTS zeck_drill" });
          await primaryHandle.port.execute({
            sql: "CREATE TABLE IF NOT EXISTS zeck_drill.redundancy_marker (id text PRIMARY KEY, written_at timestamptz NOT NULL)",
          });
          await primaryHandle.port.execute({
            sql: "INSERT INTO zeck_drill.redundancy_marker (id, written_at) VALUES ($1, now())",
            parameters: [markerId],
          });
        } finally {
          await primaryHandle.close();
        }

        // [LOSS] the primary dies (SIGKILL) — the RTO clock anchors here.
        const lossStart = new Date();
        await topology.losePrimary();

        // The governed promotion through the REAL executor.
        const executor = new PgAuthorityFailover();
        const report = await executor.failover({
          primaryUrl: topology.primaryAuthorityUrl,
          standbyUrl: topology.standbyAuthorityUrl,
          mode: "asynchronous",
        });
        expect(report.promoted).toBe(true);

        // The promoted authority serves the pre-loss durable write
        // (RPO 0 by data survival) and is schema-converged.
        const promotedHandle = await startAuthoritativeDatabase(topology.standbyAuthorityUrl, {
          poolOverrides: { max: 4 },
        });
        try {
          const marker = await promotedHandle.port.execute<{ written_at: string }>({
            sql: "SELECT written_at FROM zeck_drill.redundancy_marker WHERE id = $1",
            parameters: [markerId],
          });
          expect(marker.rows).toHaveLength(1);
          const migrations = await promotedHandle.port.execute<{ count: string }>({
            sql: "SELECT count(*) AS count FROM platform.schema_migrations",
          });
          expect(Number(migrations.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(31);

          // Measured RTO within the local HA failover target.
          const rtoMs = Date.now() - lossStart.getTime();
          const target = failoverTargetForMode(
            LOCAL_HA as NonNullable<typeof LOCAL_HA>,
            "asynchronous",
          );
          expect(rtoMs).toBeLessThanOrEqual(target.rtoTargetMs);
          expect(rtoMs).toBeGreaterThan(0);
        } finally {
          await promotedHandle.close();
        }
      } finally {
        await topology.terminate().catch(() => undefined);
      }
    },
  );

  test.skipIf(BINARIES !== null)(
    "R1-binaries-gate the failover half skips honestly when no server binaries exist (never a simulated PASS)",
    () => {
      // This branch runs ONLY when BINARIES === null: the honest skip.
      expect(BINARIES).toBeNull();
    },
  );
});
