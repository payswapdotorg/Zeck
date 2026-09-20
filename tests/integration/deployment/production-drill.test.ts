/**
 * Integration — the DEP-043 production drill driver as a REAL
 * subprocess (DEP-043 acceptance criteria 1-7).
 *
 * Drives the FULL `bun deploy/production-drill.ts` driver against a
 * real local PostgreSQL server (the drill's OWN rails configuration —
 * battery-separated from ZECK_PG_TEST_URL, which the standard PG
 * suites use, and from ZECK_E2E_PG_ADMIN_URL, which the DEP-040
 * driver's suite uses): every drill tool runs as a real subprocess
 * inside the driver, every plane is a real deploy/api.ts process over
 * real HTTP, and the driver's final report is asserted fact by fact:
 *
 *  - exit 0 + valid=true: every positive step passed, every hostile
 *    negative refused with its exact fail-closed reason;
 *  - DRILL 1 (promote→verify→rollback, both directions): the
 *    wrong-revision/unreachable/tampered promotion refusals with
 *    their exact reasons; the verified promotion with the journaled
 *    plane identity; the pre-repoint rollback refusal carrying the
 *    exact repoint instruction; the post-repoint re-attestation
 *    verifying the TARGET revision;
 *  - DRILL 2 (backup/restore round-trip): the artifact counts, the
 *    restore self-verification (all tables verified, sha256 method),
 *    the digest-stability comparison (before/after identical), and
 *    the three corrupt-artifact refusals (wrong-format exit 2,
 *    truncated exit 1 with NO recovery target created, data-tampered
 *    exit 1 naming the verification drift + the retained target
 *    disclosure);
 *  - DRILL 3 (provider-exit): the queue-recovery replay plan over the
 *    real authority (with the DEFECT-C regression pin: objectives
 *    measured, exit 0), the four workflow authority-side steps, the
 *    artifact-exit fail-closed configuration refusal, the delivery
 *    repoint (byte-identical identity documents, no hosting
 *    coordinates), the exit postures (coordination-degraded +
 *    execution-compute-unavailable + the ready authority), and the
 *    domain-authority-untouched fingerprint proof;
 *  - DRILL 4 (teardown guards): the persistent refusals (staging +
 *    production), the ambiguous-classification refusal at manifest
 *    load, the reclassified-persistent refusal at the guard, the
 *    dead-PG fail-closed drop, the real teardown dropping zeck_local
 *    (round-trip verified GONE);
 *  - the honest NOT RUN registry (every live rail owned).
 *
 * PLANE-BOOT RACE PIN: the driver is run THREE times consecutively —
 * the race class where a /health probe wins against the plane's boot
 * document by a tick hides as a 2-of-3 flaky failure; three
 * consecutive valid runs pin it (the driver itself waits for the boot
 * document, never a bare health probe).
 *
 * Configuration (the drill's own, battery-separated):
 *   ZECK_DRILL_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54333/postgres
 *
 * The URL must be credential-less (the drill refuses URL-embedded
 * credentials). The drill's final teardown segment DROPS the computed
 * zeck_local database of that server — use a DEDICATED instance, not
 * the ones the ZECK_PG_TEST_URL / ZECK_E2E_PG_ADMIN_URL suites share.
 * Tests skip cleanly (explicit reason) when the variable is absent.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));
const DRILL_PG_URL = process.env.ZECK_DRILL_PG_ADMIN_URL ?? "";

function runDriver(env: Record<string, string | undefined>): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("bun", [join("deploy", "production-drill.ts")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function reportOf(run: ReturnType<typeof runDriver>): Record<string, unknown> {
  const start = run.stdout.indexOf("{");
  expect(start, "the drill driver printed its JSON report").toBeGreaterThanOrEqual(0);
  return JSON.parse(run.stdout.slice(start)) as Record<string, unknown>;
}

function currentRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function stepOf(report: Record<string, unknown>, id: string): Record<string, unknown> {
  const steps = report.steps as Record<string, unknown>[];
  const step = steps.find((entry) => entry.id === id);
  expect(step, `the drill report carries the step ${id}`).toBeDefined();
  return step as Record<string, unknown>;
}

describe.skipIf(DRILL_PG_URL.length === 0 || !HAS_GIT)(
  "the DEP-043 production drill driver over the real local rails",
  () => {
    test("the full drill run: exit 0, all four drills proven, every negative refused (run 1 of 3)", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: DRILL_PG_URL });
      expect(run.stderr).not.toContain("FAIL");
      expect(run.code).toBe(0);
      const report = reportOf(run);

      // The whole drill validated — never a warning.
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
      const totals = report.totals as Record<string, number>;
      expect(totals.stepsPlanned).toBe(totals.stepsPassed);
      expect(totals.stepsFailed).toBe(0);
      expect(totals.positivesPlanned).toBe(totals.positivesPassed);
      expect(totals.negativesTotal).toBe(totals.negativesRefused);
      expect(totals.negativesTotal).toBeGreaterThanOrEqual(13);
      expect(totals.durationMs).toBeGreaterThan(0);

      // The exact-revision preflight.
      expect(report.revision).toBe(currentRevision());

      const facts = report.facts as Record<string, unknown>;

      // --- DRILL 1: promote→verify→rollback, both directions ---------
      const promoted = stepOf(report, "d1-promote-verified");
      expect(promoted.ok).toBe(true);
      const planeIdentity = facts.promotedPlaneIdentity as Record<string, unknown>;
      expect(planeIdentity.verified).toBe(true);
      expect(planeIdentity.attestedRevision).toBe(currentRevision());
      for (const id of [
        "d1-promote-wrong-revision-refused",
        "d1-promote-unreachable-refused",
        "d1-promote-tampered-refused",
      ]) {
        const step = stepOf(report, id);
        expect(step.ok).toBe(true);
        expect(String(step.refusalReason)).toContain(
          "deployment identity verification failed before promotion",
        );
      }
      expect(String(stepOf(report, "d1-promote-tampered-refused").refusalReason)).toContain(
        "does not recompute",
      );
      const prerepoint = stepOf(report, "d1-rollback-prerepoint-refused");
      expect(prerepoint.ok).toBe(true);
      expect(String(prerepoint.refusalReason)).toContain("post-rollback re-attestation failed");
      expect(String(prerepoint.refusalReason)).toContain("repoint");
      const postpoint = stepOf(report, "d1-rollback-postpoint-verified");
      expect(postpoint.ok).toBe(true);
      expect((postpoint.facts as Record<string, unknown>).skipped).toBeUndefined();
      const postAttestation = facts.postRepointAttestation as Record<string, unknown>;
      expect(postAttestation.verified).toBe(true);
      expect(postAttestation.attestedRevision).toBe(report.rollbackTargetRevision);
      expect(String(report.rollbackTargetRevision)).toMatch(/^[0-9a-f]{40}$/);

      // --- DRILL 2: the backup/restore round-trip + digests ----------
      const roundTrip = facts.roundTrip as Record<string, unknown>;
      expect(roundTrip.allTablesVerified).toBe(true);
      expect(roundTrip.tables as number).toBeGreaterThanOrEqual(1);
      expect(String(roundTrip.method)).toContain("sha256");
      const fingerprint = facts.authorityFingerprint as Record<string, unknown>;
      expect(fingerprint.digestsStable).toBe(true);
      // The corrupt-artifact refusals with their exact reasons.
      expect(String(stepOf(report, "d2-restore-wrong-format-refused").refusalReason)).toContain(
        "the artifact is not a zeck-logical-backup v1 manifest (refusing to restore)",
      );
      expect(String(stepOf(report, "d2-restore-truncated-refused").refusalReason)).toContain(
        "error:",
      );
      const tamperedRefusal = String(stepOf(report, "d2-restore-tampered-refused").refusalReason);
      expect(tamperedRefusal).toContain("restore verification failed for 1 table(s)");
      expect(tamperedRefusal).toContain("row counts or content checksums do not match the backup");
      expect(stepOf(report, "d2-retained-target-cleanup").ok).toBe(true);
      expect(stepOf(report, "d2-digest-comparison").ok).toBe(true);

      // --- DRILL 3: the provider-exit walk ---------------------------
      const queueRecovery = facts.queueRecovery as Record<string, unknown>;
      expect(queueRecovery.recovered).toBe(true);
      expect(queueRecovery.complete).toBe(true);
      expect(queueRecovery.rpoMs).toBe(0); // the DEFECT-C durability anchor
      for (const id of [
        "d3-workflow-inspect",
        "d3-workflow-scan",
        "d3-workflow-recover",
        "d3-workflow-compact",
      ]) {
        expect(stepOf(report, id).ok).toBe(true);
      }
      const artifactExit = stepOf(report, "d3-artifact-exit-refused");
      expect(artifactExit.ok).toBe(true);
      expect(String(artifactExit.refusalReason)).toContain(
        "artifact-exit requires the alternate object-store configuration",
      );
      expect(String(artifactExit.refusalReason)).toContain("NOT RUN without it");
      const repoint = facts.deliveryRepoint as Record<string, unknown>;
      expect(repoint.identityByteIdentical).toBe(true);
      expect(repoint.hostingCoordinatesInDocument).toBe(false);
      expect(repoint.runtimeIdentityId).toBe(planeIdentity.runtimeIdentityId);
      const postures = facts.exitPostures as {
        planeStatus: string;
        controlPlane: string;
        dependencies: { name: string; status: string; degradedMode?: string }[];
      };
      expect(postures.controlPlane).toBe("ready");
      expect(postures.planeStatus).not.toBe("down");
      const byName = new Map(postures.dependencies.map((entry) => [entry.name, entry]));
      expect(byName.get("ephemeral-coordination")).toMatchObject({
        status: "degraded",
        degradedMode: "coordination-degraded",
      });
      expect(byName.get("execution-compute")).toMatchObject({
        status: "degraded",
        degradedMode: "execution-compute-unavailable",
      });
      expect(byName.get("relational-state")).toMatchObject({ status: "ready" });
      // The domain authority was untouched by the exit mechanics.
      expect(facts.authorityUntouched).toBe(true);
      expect(stepOf(report, "d3-fingerprint-comparison").ok).toBe(true);
      // Every manifest provider class is covered in the report.
      const coverage = facts.providerExitCoverage as { concern: string }[];
      expect(coverage.map((entry) => entry.concern)).toEqual(
        expect.arrayContaining([
          "relational-state",
          "artifact-bytes",
          "async-transport",
          "durable-orchestration",
          "ephemeral-coordination",
          "experience-delivery",
          "execution-compute",
          "observability-export",
        ]),
      );
      expect(
        coverage.every(
          (entry) => (entry as unknown as Record<string, unknown>).liveOwner !== undefined,
        ),
      ).toBe(true);

      // --- DRILL 4: the teardown classification guards ----------------
      for (const id of ["d4-staging-refused", "d4-production-refused"]) {
        const step = stepOf(report, id);
        expect(step.ok).toBe(true);
        expect(String(step.refusalReason)).toContain("teardown refused");
        expect(String(step.refusalReason)).toContain("persistent");
      }
      const ambiguous = stepOf(report, "d4-ambiguous-classification-refused");
      expect(ambiguous.ok).toBe(true);
      expect(String(ambiguous.refusalReason)).toContain("invalid deployment manifest set");
      const reclassified = stepOf(report, "d4-reclassified-persistent-refused");
      expect(reclassified.ok).toBe(true);
      expect(String(reclassified.refusalReason)).toContain('class "persistent"');
      expect(stepOf(report, "d4-dead-pg-refused").ok).toBe(true);
      expect(stepOf(report, "d4-teardown-real").ok).toBe(true);
      expect(facts.zeckLocalDropped).toBe(true);
      expect(stepOf(report, "d4-post-teardown-verify").ok).toBe(true);

      // The NOT RUN registry: complete, owned, honest.
      const notRun = report.notRun as { check: string; reason: string; owner: string }[];
      expect(notRun.length).toBeGreaterThanOrEqual(8);
      for (const boundary of notRun) {
        expect(boundary.reason.length).toBeGreaterThan(20);
        expect(boundary.owner.length).toBeGreaterThan(5);
      }
      expect(String(facts.liveCostConsumed)).toContain("zero");
    }, 360_000);

    test("the plane-boot race pin: run 2 of 3 consecutive full drill runs stays valid", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: DRILL_PG_URL });
      expect(run.code).toBe(0);
      const report = reportOf(run);
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
    }, 360_000);

    test("the plane-boot race pin: run 3 of 3 consecutive full drill runs stays valid", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: DRILL_PG_URL });
      expect(run.code).toBe(0);
      const report = reportOf(run);
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
    }, 360_000);
  },
);

describe.skipIf(!HAS_GIT)(
  "the drill driver's own fail-closed preflight (no PostgreSQL required)",
  () => {
    test("without ZECK_PG_ADMIN_URL the drill driver refuses before any step (exit 2, the exact reason)", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: "" });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("ZECK_PG_ADMIN_URL is required");
      expect(run.stdout).not.toContain('"valid": true');
    });

    test("a credential-carrying ZECK_PG_ADMIN_URL is refused (URL hygiene, fail closed)", () => {
      const run = runDriver({
        ZECK_PG_ADMIN_URL: "postgres://postgres:secret@127.0.0.1:54333/postgres",
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("URL-embedded credentials");
      expect(run.stderr).toContain("refusing");
    });
  },
);
