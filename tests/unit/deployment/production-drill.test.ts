/**
 * Unit tests — the DEP-043 production drill driver's plan/boundary/
 * provider-exit CONTRACT (the driver itself is driven as a full
 * subprocess by tests/integration/deployment/production-drill.test.ts;
 * this suite pins the pure contract surfaces the driver exports):
 *
 *  - THE FOUR-DRILL PLAN: the driver composes the DEP-043 drills
 *    (promote→verify→rollback both directions; backup/restore
 *    round-trip with digest verification and the corrupt-artifact
 *    refusals; the provider-exit walk; the teardown classification
 *    guards) over the rail bring-up — the plan is pinned drill by
 *    drill, step by step, so a reordered or silently-dropped step
 *    fails here;
 *  - THE PROVIDER-EXIT COVERAGE: every provider class in the REAL
 *    provider-tiers.json manifest is covered with its documented exit
 *    path, a local execution statement and a live boundary — the
 *    manifest is the only authority (never tool-local constants);
 *  - THE NOT-RUN BOUNDARY REGISTRY: every live-provider half the
 *    drill cannot run is registered with a reason and an owner (the
 *    credential-honesty doctrine) — completeness and ownership are
 *    pinned, and no boundary may claim a result it did not produce;
 *  - THE BACKUP-ARTIFACT HELPERS: the digest comparison refuses on
 *    any drift; the tamper construction keeps the original checksums
 *    (data-only tamper, caught by the restore's own verification);
 *    the truncation/wrong-format constructions are genuinely
 *    unparseable/foreign;
 *  - THE REUSED DISCIPLINES: the driver reuses the DEP-040 driver's
 *    URL-hygiene preflight and boot-document detector (one authority,
 *    not a fork), and its own source carries no URL-embedded
 *    credentials;
 *  - THE DEFECT-C FIX: deploy/drill.ts anchors the durability
 *    scenarios (queue-recovery, artifact-exit, worker-evacuation) so
 *    they can exit 0 — never again the contradictory recovered:true +
 *    exit 1 gate (behavior pinned by the drill's queue-recovery step).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { bootDocumentOf, checkPgAdminUrl } from "../../../deploy/e2e-validate";
import { loadManifest } from "../../../deploy/lib";
import {
  compareTableDigests,
  DRILL_PLAN,
  NOT_RUN_BOUNDARIES,
  providerExitCoverage,
  tamperArtifactRow,
  truncateArtifactText,
  wrongFormatArtifact,
} from "../../../deploy/production-drill";
import type { LogicalBackup } from "../../../src/platform/db/backup";
import { parseProviderTiers } from "../../../src/platform/deployment/provider-tiers";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("the four-drill plan (DEP-043)", () => {
  test("the plan composes the rail bring-up plus the four DEP-043 drills, in order", () => {
    expect(DRILL_PLAN.map((entry) => entry.drill)).toEqual([
      "rails",
      "promote-verify-rollback",
      "backup-restore-roundtrip",
      "provider-exit",
      "teardown-guards",
    ]);
  });

  test("every drill declares a title and at least three steps", () => {
    for (const entry of DRILL_PLAN) {
      expect(entry.title.length).toBeGreaterThan(20);
      expect(entry.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("drill 1 pins the promote→verify→rollback cycle, both directions", () => {
    const drill = DRILL_PLAN.find((entry) => entry.drill === "promote-verify-rollback");
    expect(drill).toBeDefined();
    const steps = drill?.steps ?? [];
    // The refusals (wrong-revision, unreachable, tampered) + the verified pass.
    expect(steps).toContain("d1-promote-wrong-revision-refused");
    expect(steps).toContain("d1-promote-unreachable-refused");
    expect(steps).toContain("d1-promote-tampered-refused");
    expect(steps).toContain("d1-promote-verified");
    // The rollback re-attestation: pre-repoint refusal + post-repoint allow.
    expect(steps).toContain("d1-rollback-prerepoint-refused");
    expect(steps).toContain("d1-rollback-postpoint-verified");
    // The rollback target must itself be gate-passed before rollback.
    expect(steps.indexOf("d1-release-record-base")).toBeLessThan(
      steps.indexOf("d1-rollback-prerepoint-refused"),
    );
    expect(steps.indexOf("d1-rollback-prerepoint-refused")).toBeLessThan(
      steps.indexOf("d1-rollback-postpoint-verified"),
    );
  });

  test("drill 2 pins the round-trip, the digest discipline and the three corrupt-artifact refusals", () => {
    const drill = DRILL_PLAN.find((entry) => entry.drill === "backup-restore-roundtrip");
    expect(drill).toBeDefined();
    const steps = drill?.steps ?? [];
    expect(steps).toContain("d2-backup-initial");
    expect(steps).toContain("d2-restore-roundtrip");
    expect(steps).toContain("d2-backup-digest-stability");
    expect(steps).toContain("d2-digest-comparison");
    expect(steps).toContain("d2-restore-wrong-format-refused");
    expect(steps).toContain("d2-restore-truncated-refused");
    expect(steps).toContain("d2-restore-tampered-refused");
    expect(steps).toContain("d2-retained-target-cleanup");
  });

  test("drill 3 pins every provider-exit step including the authority-untouched proof", () => {
    const drill = DRILL_PLAN.find((entry) => entry.drill === "provider-exit");
    expect(drill).toBeDefined();
    const steps = drill?.steps ?? [];
    for (const expected of [
      "d3-queue-recovery",
      "d3-workflow-inspect",
      "d3-workflow-scan",
      "d3-workflow-recover",
      "d3-workflow-compact",
      "d3-artifact-exit-refused",
      "d3-delivery-repoint",
      "d3-exit-postures",
      "d3-authority-fingerprint-after",
      "d3-fingerprint-comparison",
    ]) {
      expect(steps).toContain(expected);
    }
    // The fingerprint AFTER must follow the exit steps it guards.
    expect(steps.indexOf("d3-exit-postures")).toBeLessThan(
      steps.indexOf("d3-authority-fingerprint-after"),
    );
  });

  test("drill 4 pins the classification guards: persistent, ambiguous, reclassified, dead authority, real", () => {
    const drill = DRILL_PLAN.find((entry) => entry.drill === "teardown-guards");
    expect(drill).toBeDefined();
    const steps = drill?.steps ?? [];
    for (const expected of [
      "d4-staging-refused",
      "d4-production-refused",
      "d4-ambiguous-classification-refused",
      "d4-reclassified-persistent-refused",
      "d4-dead-pg-refused",
      "d4-teardown-real",
      "d4-post-teardown-verify",
    ]) {
      expect(steps).toContain(expected);
    }
  });
});

describe("the provider-exit coverage (the manifest is the only authority)", () => {
  test("every provider class in the REAL provider-tiers ledger is covered, exactly once", () => {
    const manifestSource = JSON.parse(read("deploy/manifests/provider-tiers.json")) as {
      tiers: { concern: string; provider: string }[];
    };
    const coverage = providerExitCoverage();
    for (const tier of manifestSource.tiers) {
      const matches = coverage.filter((entry) => entry.concern === tier.concern);
      expect(matches, `concern ${tier.concern} must be covered exactly once`).toHaveLength(1);
      expect(matches[0]?.provider).toBe(tier.provider);
    }
    expect(coverage).toHaveLength(manifestSource.tiers.length);
  });

  test("every coverage entry carries the documented exit path, a local execution and a live boundary", () => {
    for (const entry of providerExitCoverage()) {
      expect(entry.exitPath.length).toBeGreaterThan(30);
      expect(entry.localExecution.length).toBeGreaterThan(30);
      expect(entry.liveBoundary.length).toBeGreaterThan(30);
      // The local execution statement must name a real mechanism, never
      // a fabricated pass.
      expect(entry.localExecution).not.toMatch(/assumed[- ]pass|fabricated/i);
    }
  });

  test("the manifest parses cleanly through the repository's own validator (cross-check)", () => {
    const ledger = parseProviderTiers(read("deploy/manifests/provider-tiers.json"), loadManifest());
    expect(ledger.tiers.length).toBeGreaterThanOrEqual(8);
    const coverageConcerns = providerExitCoverage().map((entry) => entry.concern);
    expect(coverageConcerns).toEqual(expect.arrayContaining(ledger.tiers.map((t) => t.concern)));
  });
});

describe("the NOT-RUN boundary registry (the credential-honesty doctrine)", () => {
  test("every live half the drill cannot run is registered with a reason and an owner", () => {
    expect(NOT_RUN_BOUNDARIES.length).toBeGreaterThanOrEqual(8);
    for (const boundary of NOT_RUN_BOUNDARIES) {
      expect(boundary.check.length).toBeGreaterThan(10);
      expect(boundary.reason.length).toBeGreaterThan(20);
      expect(boundary.owner.length).toBeGreaterThan(5);
    }
  });

  test("every provider-class live boundary is present (completeness)", () => {
    const checks = NOT_RUN_BOUNDARIES.map((boundary) => boundary.check).join("\n");
    expect(checks).toContain("Live-provider promotion/rollback rails");
    expect(checks).toContain("Live relational-state exit");
    expect(checks).toContain("Live artifact-bytes exit");
    expect(checks).toContain("Live async-transport exit");
    expect(checks).toContain("Live durable-orchestration exit");
    expect(checks).toContain("Live ephemeral-coordination exit");
    expect(checks).toContain("Live experience-delivery exit");
    expect(checks).toContain("Live execution-compute exit");
    expect(checks).toContain("Live observability-export exit");
    expect(checks).toContain("Live provider meters");
    expect(checks).toContain("CI execution");
  });

  test("the live halves are owned by the Lead credentialed re-run (never unowned, never assumed-pass)", () => {
    for (const boundary of NOT_RUN_BOUNDARIES) {
      if (boundary.check.includes("CI execution")) {
        expect(boundary.owner).toContain("Lead merge + CI");
        continue;
      }
      expect(boundary.owner).toContain("Lead credentialed re-run");
    }
    const reasons = NOT_RUN_BOUNDARIES.map((boundary) => boundary.reason).join("\n");
    expect(reasons).not.toMatch(/assumed[- ]pass|fabricated result|passed without running/i);
  });
});

describe("the backup-artifact helpers (the corrupt-backup negatives)", () => {
  const firstTable: LogicalBackup["tables"][number] = {
    schema: "release_control",
    table: "releases",
    columns: ["id", "recorded_at"],
    identityColumns: ["id"],
    storedGeneratedColumns: [],
    rowCount: 2,
    contentChecksum: "checksum-a",
    rows: [
      { id: "r1", recorded_at: "2026-09-20T01:00:00.000Z" },
      { id: "r2", recorded_at: "2026-09-20T02:00:00.000Z" },
    ],
  };
  const emptyTable: LogicalBackup["tables"][number] = {
    schema: "platform",
    table: "marker",
    columns: ["id"],
    identityColumns: ["id"],
    storedGeneratedColumns: [],
    rowCount: 0,
    contentChecksum: "checksum-b",
    rows: [],
  };
  const makeBackup = (tables: readonly LogicalBackup["tables"][number][]): LogicalBackup => ({
    format: "zeck-logical-backup",
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    migrationHistory: [{ version: 1, name: "v1", checksum: "aa" }],
    tables,
  });
  const backup = makeBackup([firstTable, emptyTable]);

  test("identical digests compare equal (never a spurious drift)", () => {
    const comparison = compareTableDigests(backup, makeBackup([firstTable, emptyTable]));
    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
  });

  test("a row-count drift, a checksum drift, a missing and an extra table each refuse", () => {
    const driftedCount = makeBackup([{ ...firstTable, rowCount: 3 }, emptyTable]);
    expect(compareTableDigests(backup, driftedCount).equal).toBe(false);

    const driftedChecksum = makeBackup([
      { ...firstTable, contentChecksum: "checksum-x" },
      emptyTable,
    ]);
    const checksumComparison = compareTableDigests(backup, driftedChecksum);
    expect(checksumComparison.equal).toBe(false);
    expect(checksumComparison.differences[0]).toContain("digest drift");

    const missingTable = makeBackup([emptyTable]);
    const missingComparison = compareTableDigests(backup, missingTable);
    expect(missingComparison.equal).toBe(false);
    expect(missingComparison.differences[0]).toContain("missing after");

    const extraTable = makeBackup([firstTable, emptyTable, { ...emptyTable, table: "appeared" }]);
    const extraComparison = compareTableDigests(backup, extraTable);
    expect(extraComparison.equal).toBe(false);
    expect(extraComparison.differences[0]).toContain("appeared after");
  });

  test("the tamper drops one row but KEEPS the original checksums (data-only — caught by verification)", () => {
    const tampered = tamperArtifactRow(backup);
    const [tamperedFirst] = tampered.tables;
    expect(tamperedFirst).toBeDefined();
    expect(tamperedFirst?.rows).toHaveLength(1);
    expect(tamperedFirst?.rowCount).toBe(firstTable.rowCount);
    expect(tamperedFirst?.contentChecksum).toBe(firstTable.contentChecksum);
    // The untampered tables pass through untouched.
    expect(tampered.tables[1]).toEqual(emptyTable);
  });

  test("the tamper refuses an empty backup (no non-empty table to tamper)", () => {
    expect(() => tamperArtifactRow(makeBackup([emptyTable]))).toThrow(
      /no non-empty table to tamper/,
    );
  });

  test("the truncated artifact is a strict prefix that no longer parses as JSON", () => {
    const text = JSON.stringify(backup, null, 2);
    const truncated = truncateArtifactText(text);
    expect(truncated.length).toBeLessThan(text.length);
    expect(truncated).toBe(text.slice(0, truncated.length));
    expect(() => JSON.parse(truncated)).toThrow();
  });

  test("the wrong-format artifact parses as JSON but is foreign to the backup format", () => {
    const parsed = JSON.parse(wrongFormatArtifact()) as { format: string; version: number };
    expect(parsed.format).not.toBe("zeck-logical-backup");
    expect(parsed.version).not.toBe(1);
  });
});

describe("the reused disciplines (one authority, not a fork)", () => {
  test("the driver reuses the DEP-040 driver's URL-hygiene preflight and boot-document detector", () => {
    const source = read("deploy/production-drill.ts");
    expect(source).toContain('from "./e2e-validate"');
    expect(source).toContain("checkPgAdminUrl");
    expect(source).toContain("bootDocumentOf");
    // The reused functions themselves behave (spot-check the refusals).
    expect(checkPgAdminUrl("postgres://postgres:secret@127.0.0.1:54333/postgres").ok).toBe(false);
    expect(bootDocumentOf("not a boot document")).toBeNull();
  });

  test("the driver's own source carries no URL-embedded credentials (self-consistency with the repo pin)", () => {
    const source = read("deploy/production-drill.ts");
    expect(
      /postgres(ql)?:\/\/[^\s"'@/:]+:[^\s"'@]+@/.test(source),
      "deploy/production-drill.ts must not construct credential-carrying URLs",
    ).toBe(false);
    expect(
      /postgres(ql)?:\/\/[^\s"'@/:]+:[^\s"'@]+@/.test(read("deploy/drill.ts")),
      "deploy/drill.ts must not construct credential-carrying URLs (the DEFECT-C fix touched it)",
    ).toBe(false);
  });
});

describe("the DEFECT-C fix (deploy/drill.ts durability anchors)", () => {
  test("the durability-anchored scenarios carry the startedAt anchor (exit 0 is reachable again)", () => {
    const source = read("deploy/drill.ts");
    expect(source).toContain("durabilityAnchored");
    for (const command of ["queue-recovery", "artifact-exit", "worker-evacuation"]) {
      expect(source).toContain(`"${command}"`);
    }
    expect(source).toMatch(/lastConsistentPointAt: durabilityAnchored\s*\?\s*startedAt/);
  });
});
