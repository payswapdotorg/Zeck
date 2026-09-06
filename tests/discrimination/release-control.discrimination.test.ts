/**
 * Discrimination — the D-06 release-control/observability defect
 * detectors (WORK-047; the required discrimination/mutation list).
 *
 * Each test INJECTS the defect (the mutation the gate must detect)
 * and proves the detector fires:
 *
 *  1. a deployment not tied to an exact commit is rejected (the
 *     identity gate, over the real store);
 *  2. bypassing the migration/health/smoke gates fails (the
 *     store-level enforcement — no CLI path can skip the required
 *     evidence);
 *  3. telemetry containing secret material is rejected before the
 *     wire (the admission gate: the collector never sees it);
 *  4. provider/dashboard state cannot declare domain success (the
 *     observability plane is write-blind: exporter acceptance and
 *     lying telemetry claims change NO authoritative state);
 *  5. rollback cannot mutate durable execution/business authority
 *     (the domain-isolation proof over the real database);
 *  6. unbounded telemetry volume or weakened quota thresholds are
 *     detected (the policy loaders refuse the weakening mutations);
 *  7. preview credentials do not satisfy staging/production bindings
 *     (the environment contract fails closed on cross-environment
 *     references through the release tool's own resolution path).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateEnvironmentContract } from "../../src/platform/deployment/env-contract";
import { loadDeploymentManifest } from "../../src/platform/deployment/manifest";
import { loadQuotaGuardsPolicy } from "../../src/platform/observability/alerts";
import { TELEMETRY_BOUNDS } from "../../src/platform/observability/port";
import {
  BoundedTelemetrySink,
  createInMemoryExporter,
} from "../../src/platform/observability/telemetry";
import {
  evidenceDigestOf,
  type ReleaseControlError,
  SqlReleaseControlStore,
} from "../../src/platform/release";
import { loadReleasePolicy } from "../../src/platform/release/policy";
import { definePgSuite } from "../integration/postgres/harness";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** The real manifest set for the contract/ladder evaluations. */
const MANIFEST = loadDeploymentManifest((file) =>
  readFileSync(resolve(REPO_ROOT, "deploy/manifests", file), "utf8"),
);
const POLICY_SOURCE = readFileSync(
  resolve(REPO_ROOT, "deploy/manifests/release-policy.json"),
  "utf8",
);
const POLICY = loadReleasePolicy(POLICY_SOURCE, MANIFEST);

const MANIFEST_DIGEST = "a".repeat(64);
const ACTOR = "discrimination-operator";

/** A unique exact 40-hex revision. */
function uniqueRevision(): string {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** Every table row count of every NON-release_control schema (the isolation snapshot). */
async function domainSnapshot(db: {
  execute: <T>(query: { sql: string }) => Promise<{ rows: readonly T[] }>;
}): Promise<readonly string[]> {
  const result = await db.execute<{ table_schema: string; table_name: string }>({
    sql: `SELECT table_schema, table_name FROM information_schema.tables
WHERE table_schema NOT IN ('release_control', 'information_schema', 'pg_catalog')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name`,
  });
  const lines: string[] = [];
  for (const row of result.rows) {
    const count = await db.execute<{ readonly count: string }>({
      sql: `SELECT count(*) AS count FROM "${row.table_schema}"."${row.table_name}"`,
    });
    lines.push(`${row.table_schema}.${row.table_name}:${count.rows[0]?.count ?? "?"}`);
  }
  return lines;
}

describe("discrimination: D-06 release control and observability (WORK-047)", () => {
  test("3. telemetry containing secret material is rejected before the wire", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    // The mutation: a secret-shaped attribute key + a credential value.
    await sink.emitLog({
      level: "info",
      message: "postgres://root:hunter2@db/zeck connected",
      correlation: { environment: "local" },
      attributes: { secret: "hunter2", detail: "postgres://root:hunter2@db/zeck" },
    });
    await sink.flush();
    const wire = JSON.stringify(collector.batches);
    expect(wire).not.toContain("hunter2");
    // The record with the secret-shaped KEY is rejected outright.
    expect(sink.stats().recordsRejected).toBe(1);
    // Nothing crossed the wire at all (the only record was rejected).
    expect(collector.batches).toHaveLength(0);
  });

  test("4. provider/dashboard state cannot declare domain success (observability is write-blind)", async () => {
    // The mutation: an exporter that reports "accepted" for everything
    // and telemetry records CLAIMING domain outcomes. The runtime
    // proof: the acceptance and the claims change no release ledger
    // and no execution row (the write-blind store check runs in the
    // PG suite below; the pure proof here is the void-returning sink
    // API — there is no channel through which an exporter response
    // could write, and the plane has no database dependency at all —
    // pinned by the architecture suite B3).
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitSpan({
      name: "zeck.release.promoted",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      correlation: { environment: "production", releaseId: "f".repeat(64) },
      attributes: { outcome: "promoted", declaredBy: "a-dashboard" },
    });
    await sink.emitMetric({
      name: "zeck.execution.completed",
      kind: "counter",
      value: 1,
      correlation: { environment: "production", executionId: "e".repeat(36) },
      attributes: { declaredBy: "a-dashboard" },
    });
    const outcomes = await sink.flush();
    // The exporter "accepted" — and the acceptance is a COUNTED
    // outcome only (void to the caller; no state channel exists).
    expect(outcomes.every((outcome) => outcome.kind === "accepted")).toBe(true);
    expect(await sink.flush()).toHaveLength(0);
  });

  test("6. unbounded telemetry volume and weakened thresholds are detected", () => {
    // The mutation (a): drop the quota thresholds entirely — the
    // loader refuses the unbounded policy.
    const unbounded = JSON.stringify({
      guards: { "compute-claims": { description: "x" } },
      operationalThresholds: [],
    });
    expect(() => loadQuotaGuardsPolicy(unbounded)).toThrow(
      /warnAtPct and criticalAtPct must be ordered percentages/,
    );
    // The mutation (b): the release policy drops an environments.json
    // ladder requirement (preview-smoke is required for entering
    // staging) — the cross-check refuses the weakening.
    const weakened = JSON.parse(POLICY_SOURCE) as {
      entryGates: Record<string, string[]>;
    };
    const stagingGates = weakened.entryGates.staging ?? [];
    weakened.entryGates.staging = stagingGates.filter((gate) => gate !== "preview-smoke");
    expect(() => loadReleasePolicy(JSON.stringify(weakened), MANIFEST)).toThrow(
      /entryGates.staging must cover the environments.json requirement "preview-smoke"/,
    );
    // (c): the telemetry volume bounds are structural and finite —
    // an unbounded buffer is unrepresentable in the port constants.
    for (const [key, value] of Object.entries(TELEMETRY_BOUNDS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  test("7. preview credentials do not satisfy staging/production bindings (fail closed)", () => {
    // The mutation: a preview-scoped secret reference offered to a
    // STAGING invocation — the environment contract rejects it, and
    // the release tool's own database resolution path (the
    // environment-scoped secret store behind resolveDatabaseUrl)
    // fails closed the same way.
    const contract = evaluateEnvironmentContract(MANIFEST, "staging", {
      ZECK_ENVIRONMENT: "staging",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://preview/database-url",
    });
    expect(contract.satisfied).toBe(false);
    expect(
      contract.problems.some(
        (problem) =>
          problem.includes("cross-environment") || problem.includes("zeck-secret://preview"),
      ),
    ).toBe(true);
    // The same for production.
    const productionContract = evaluateEnvironmentContract(MANIFEST, "production", {
      ZECK_ENVIRONMENT: "production",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://preview/database-url",
    });
    expect(productionContract.satisfied).toBe(false);
  });
});

// The store-level discriminations run over the REAL PostgreSQL ledger.
definePgSuite("discrimination: the release-control store gates (WORK-047)", (ctx) => {
  const store = () =>
    new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: () => randomUUID(),
    });

  test("1. a deployment not tied to an exact commit is rejected (the real store)", async () => {
    const s = store();
    // The mutation: a short/dirty/branch-name "revision".
    for (const bad of ["abc123", "HEAD", "feature-x", "v1.2.3", "5d26365"]) {
      await expect(
        s.recordRelease({ gitRevision: bad, manifestDigest: MANIFEST_DIGEST, actor: ACTOR }),
      ).rejects.toThrow(/exact 40-hex Git commit/);
    }
    // The detector works: the exact revision passes.
    const good = await s.recordRelease({
      gitRevision: uniqueRevision(),
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    expect(good.releaseId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("2. bypassing the migration/health/smoke gates fails (the store-level enforcement)", async () => {
    const s = store();
    const release = await s.recordRelease({
      gitRevision: uniqueRevision(),
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "staging",
      deploymentIdentityId: "b".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    await s.recordPromotionDecision({
      releaseId: release.releaseId,
      fromPhase: "ci",
      toPhase: "staging",
      decision: "promoted",
      reason: "operator promoted",
      actor: ACTOR,
    });
    // The mutation: ALL staging gates recorded EXCEPT migration/health
    // (the bypass attempt) — the activation must refuse with exactly
    // the missing evidence.
    for (const gateKind of POLICY.entryGates.staging.filter(
      (gate) => gate !== "migration" && gate !== "health",
    )) {
      await s.recordGateResult({
        releaseId: release.releaseId,
        environment: "staging",
        gateKind,
        status: "passed",
        evidenceDigest: evidenceDigestOf(gateKind),
        evidenceDetail: `${gateKind} passed`,
        source: "tool-run",
        actor: ACTOR,
      });
    }
    let refusal: ReleaseControlError | null = null;
    try {
      await s.activate({
        environment: "staging",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.staging,
        actor: ACTOR,
      });
    } catch (error) {
      refusal = error as ReleaseControlError;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.refusal.kind).toBe("gates-missing");
    if (refusal?.refusal.kind === "gates-missing") {
      expect(refusal.refusal.missing).toEqual(expect.arrayContaining(["migration", "health"]));
    }
    // Supplying the missing gates through the SAME append-only path
    // (re-run) is the only way forward: the bypass does not exist.
    for (const gateKind of ["migration", "health"]) {
      await s.recordGateResult({
        releaseId: release.releaseId,
        environment: "staging",
        gateKind,
        status: "passed",
        evidenceDigest: evidenceDigestOf(gateKind),
        evidenceDetail: `${gateKind} passed`,
        source: "tool-run",
        actor: ACTOR,
      });
    }
    const active = await s.activate({
      environment: "staging",
      releaseId: release.releaseId,
      requiredGates: POLICY.entryGates.staging,
      actor: ACTOR,
    });
    expect(active.releaseId).toBe(release.releaseId);
  });

  test("4r. observability acceptance changes no authoritative state (the write-blind proof)", async () => {
    const s = store();
    const before = await domainSnapshot(ctx.port);
    // A telemetry batch claiming a production promotion + execution
    // completion, accepted by an in-memory exporter.
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitSpan({
      name: "zeck.release.promoted",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      correlation: { environment: "production", releaseId: "f".repeat(64) },
      attributes: { outcome: "promoted", declaredBy: "a-dashboard" },
    });
    await sink.flush();
    // The authoritative state: no active production deployment exists
    // (the claim promoted nothing), and NO table changed.
    expect(await s.activeDeployment("production")).toBeNull();
    expect(await domainSnapshot(ctx.port)).toEqual(before);
  });

  test("5r. rollback mutates ONLY release_control (the domain tables are untouched)", async () => {
    const s = store();
    // Seed a durable domain row (the snapshot covers every schema).
    await ctx.port.execute({
      sql: `INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)`,
      parameters: [randomUUID(), "discrimination-tenant", "discrimination tenant"],
    });
    const snapshot = await domainSnapshot(ctx.port);

    const releaseIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const release = await s.recordRelease({
        gitRevision: uniqueRevision(),
        manifestDigest: MANIFEST_DIGEST,
        actor: ACTOR,
      });
      releaseIds.push(release.releaseId);
      await s.recordEnvironmentDeployment({
        releaseId: release.releaseId,
        environment: "local",
        deploymentIdentityId: "b".repeat(64),
        resourceDigest: "c".repeat(64),
        actor: ACTOR,
      });
      for (const gateKind of POLICY.entryGates.local) {
        await s.recordGateResult({
          releaseId: release.releaseId,
          environment: "local",
          gateKind,
          status: "passed",
          evidenceDigest: evidenceDigestOf(gateKind),
          evidenceDetail: `${gateKind} passed`,
          source: "tool-run",
          actor: ACTOR,
        });
      }
      await s.recordPromotionDecision({
        releaseId: release.releaseId,
        fromPhase: "none",
        toPhase: "local",
        decision: "promoted",
        reason: "discrimination promote",
        actor: ACTOR,
      });
      await s.activate({
        environment: "local",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.local,
        actor: ACTOR,
      });
    }
    const rolled = await s.rollback({
      environment: "local",
      toReleaseId: releaseIds[0] as string,
      requiredGates: POLICY.entryGates.local,
      reason: "discrimination rollback",
      actor: ACTOR,
    });
    expect(rolled.releaseId).toBe(releaseIds[0]);
    // THE PROOF: every domain row is unchanged.
    expect(await domainSnapshot(ctx.port)).toEqual(snapshot);
  });
});
