/**
 * Integration — the DEP-040 end-to-end driver as a REAL subprocess
 * (DEP-040 acceptance criteria 1-7).
 *
 * Drives the FULL `bun deploy/e2e-validate.ts` driver against a real
 * local PostgreSQL server (the driver's OWN rails configuration —
 * battery-separated from ZECK_PG_TEST_URL, which the standard PG suites
 * use): every chain tool runs as a real subprocess inside the driver,
 * every plane is a real deploy/api.ts process over real HTTP, and the
 * driver's final report is asserted fact by fact:
 *
 *  - exit 0 + valid=true: every positive step passed, every hostile
 *    negative refused with its exact fail-closed reason;
 *  - the exact-revision preflight (the driver's revision equals the
 *    checkout HEAD);
 *  - the full public route-table counts (26 probed = 18 auth-boundary +
 *    7 capability-unbound + 1 public-artifact);
 *  - attestation stability: the identity document is byte-identical
 *    before and after the chain; the promoted plane attests the same
 *    runtime identity;
 *  - the dead-port drill facts (503 down + strict refused + explicit
 *    degraded pass);
 *  - both-direction promotion facts (refused on wrong-revision /
 *    unreachable / tampered planes; verified pass on the real one) and
 *    both-direction rollback re-attestation (pre-repoint refusal with
 *    the repoint instruction; post-repoint verification);
 *  - the tampered-identity drill (git archive + ONE well-formed
 *    variables.json row: well-formed manifest, REFUSED identity);
 *  - the guardrail facts (manifest limit resolutions, at-limit DENY
 *    with the declared degradation mode, the mutated-manifest fence);
 *  - the teardown facts (classification refusal, dead-PG drop refusal,
 *    the real teardown dropping zeck_local);
 *  - the honest NOT RUN registry (every live rail owned).
 *
 * PLANE-BOOT RACE PIN: the driver is run THREE times consecutively —
 * the race class where a /health probe wins against the plane's boot
 * document by a tick hides as a 2-of-3 flaky failure; three
 * consecutive valid runs pin it (the driver itself waits for the boot
 * document, never a bare health probe).
 *
 * Configuration (the driver's own, battery-separated):
 *   ZECK_E2E_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres
 *
 * The URL must be credential-less (the driver refuses URL-embedded
 * credentials). The driver's final teardown segment DROPS the computed
 * zeck_local database of that server — use a DEDICATED instance, not
 * the one the ZECK_PG_TEST_URL suites share. Tests skip cleanly
 * (explicit reason) when the variable is absent.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));
const E2E_PG_URL = process.env.ZECK_E2E_PG_ADMIN_URL ?? "";

function runDriver(env: Record<string, string | undefined>): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("bun", [join("deploy", "e2e-validate.ts")], {
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
  expect(start, "the driver printed its JSON report").toBeGreaterThanOrEqual(0);
  return JSON.parse(run.stdout.slice(start)) as Record<string, unknown>;
}

function currentRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function stepOf(report: Record<string, unknown>, id: string): Record<string, unknown> {
  const steps = report.steps as Record<string, unknown>[];
  const step = steps.find((entry) => entry.id === id);
  expect(step, `the driver report carries the step ${id}`).toBeDefined();
  return step as Record<string, unknown>;
}

describe.skipIf(E2E_PG_URL.length === 0 || !HAS_GIT)(
  "the DEP-040 end-to-end driver over the real local rails",
  () => {
    test("the full driver run: exit 0, every step recorded, every negative refused (run 1 of 3)", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: E2E_PG_URL });
      expect(run.stderr).not.toContain("FAIL");
      expect(run.code).toBe(0);
      const report = reportOf(run);

      // The whole chain validated — never a warning.
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
      const totals = report.totals as Record<string, number>;
      expect(totals.stepsPlanned).toBe(totals.stepsPassed);
      expect(totals.stepsFailed).toBe(0);
      expect(totals.positivesPlanned).toBe(totals.positivesPassed);
      expect(totals.negativesTotal).toBe(totals.negativesRefused);
      // The rollback prerepoint refusal is the 13th negative when the
      // drills run (manifest-stable revisions — the DEP-040 case); on
      // a manifest-refresh branch (PPR-002's ledger refresh is the
      // first) the driver's documented honest skip replaces it: 12
      // negatives plus the skipped-drills step pinned below.
      if (report.rollbackTargetRevision === undefined) {
        expect(totals.negativesTotal).toBeGreaterThanOrEqual(12);
      } else {
        expect(totals.negativesTotal).toBeGreaterThanOrEqual(13);
      }
      expect(totals.durationMs).toBeGreaterThan(0);

      // The exact-revision preflight.
      expect(report.revision).toBe(currentRevision());

      // The route table counts (the full public route table).
      const facts = report.facts as Record<string, unknown>;
      const coverage = facts.routeCoverage as Record<string, number>;
      expect(coverage.probed).toBe(26);
      expect(coverage.authBoundaryEnforced).toBe(18);
      expect(coverage.capabilityUnboundHonest).toBe(7);
      expect(coverage.publicArtifactBound).toBe(1);

      // The strict ready-authority smoke (200 — a fail-closed
      // authority would answer 503 down).
      const strict = stepOf(report, "public-smoke-strict");
      expect(strict.ok).toBe(true);
      const strictFacts = strict.facts as Record<string, unknown>;
      const attestation = strictFacts.attestation as Record<string, unknown>;
      expect(attestation.healthStatus).toBe(200);
      expect(attestation.identityVerified).toBe(true);

      // Attestation stability: byte-identical identity before/after.
      const stability = facts.identityStability as Record<string, unknown>;
      expect(stability.stableAcrossChain).toBe(true);
      const before = stepOf(report, "identity-before");
      const after = stepOf(report, "identity-after");
      expect(after.outputDigest).toBe(before.outputDigest);
      expect(after.facts).toEqual(before.facts);

      // The dead-port drill facts.
      const deadHealth = facts.deadAuthorityHealth as Record<string, unknown>;
      expect(deadHealth.status).toBe(503);
      expect((deadHealth.body as Record<string, unknown>).status).toBe("down");
      expect(stepOf(report, "public-smoke-dead-authority-strict-refused").ok).toBe(true);
      const degraded = stepOf(report, "public-smoke-dead-authority-degraded-allowed");
      expect(degraded.ok).toBe(true);
      expect(String((degraded.facts as Record<string, unknown>).healthCheck)).toContain(
        "down-allowed-degraded",
      );

      // The tampered-identity drill: the archive + ONE well-formed row.
      expect(stepOf(report, "tamper-tree-validate-passes").ok).toBe(true);
      const tamperRefusal = stepOf(report, "public-smoke-tampered-refused");
      expect(tamperRefusal.ok).toBe(true);
      expect(String(facts.tamperRefusalReason)).toContain("does not recompute");

      // The wrong-revision / unreachable smoke negatives.
      expect(stepOf(report, "public-smoke-wrong-revision-refused").ok).toBe(true);
      expect(stepOf(report, "public-smoke-unreachable-refused").ok).toBe(true);

      // The guardrail facts.
      const baseline = facts.baselineLimitResolutions as {
        guard: string;
        limit: number;
        source: string;
      }[];
      expect(baseline).toEqual([
        { guard: "queue-backlog", limit: 1000, source: "manifest" },
        { guard: "database-size", limit: 5_368_709_120, source: "manifest" },
      ]);
      const atLimit = facts.atLimitFence as Record<string, unknown>;
      expect(atLimit.decision).toBe("deny");
      expect(atLimit.denyReason).toBe("quota-exhausted");
      expect(atLimit.degradedMode).toBe("authority-unavailable");
      const mutated = facts.mutatedLimitFence as Record<string, unknown>;
      expect(mutated.decision).toBe("deny");
      expect(mutated.denyReason).toBe("quota-exhausted");
      expect(stepOf(report, "guardrails-malformed-override-aborts").ok).toBe(true);
      expect(stepOf(report, "guardrails-mutated-manifest-limit-moves-the-fence").ok).toBe(true);

      // Both-direction promotion: the refusals with their exact reasons.
      for (const id of [
        "release-promote-refused-wrong-revision",
        "release-promote-refused-unreachable",
        "release-promote-refused-tampered",
      ]) {
        const step = stepOf(report, id);
        expect(step.ok).toBe(true);
        expect(String(step.refusalReason)).toContain(
          "deployment identity verification failed before promotion",
        );
      }
      const promoted = stepOf(report, "release-promote-verified");
      expect(promoted.ok).toBe(true);
      const planeIdentity = facts.promotedPlaneIdentity as Record<string, unknown>;
      expect(planeIdentity.verified).toBe(true);
      expect(planeIdentity.attestedRevision).toBe(currentRevision());

      // Both-direction rollback re-attestation. On a manifest-stable
      // checkout the drills run in full (the DEP-040 case); on a
      // branch whose HEAD legitimately changes deploy/manifests (the
      // PPR-002 provider-ledger refresh is the first such case) the
      // driver records its documented honest skip instead — no
      // ancestor carries byte-identical manifests, and fabricating
      // one is unrepresentable. Both outcomes are pinned here; the
      // full-drill assertions are unchanged from DEP-040.
      const rollbackTarget = report.rollbackTargetRevision as string | undefined;
      if (rollbackTarget !== undefined && /^[0-9a-f]{40}$/.test(rollbackTarget)) {
        const prerepoint = stepOf(report, "release-rollback-prerepoint-refused");
        expect(prerepoint.ok).toBe(true);
        expect(String(prerepoint.refusalReason)).toContain("post-rollback re-attestation failed");
        expect(String(prerepoint.refusalReason)).toContain("repoint");
        const postpoint = stepOf(report, "release-rollback-postpoint-verified");
        expect(postpoint.ok).toBe(true);
        expect((postpoint.facts as Record<string, unknown>).skipped).toBeUndefined();
        const postAttestation = facts.postRepointAttestation as Record<string, unknown>;
        expect(postAttestation.verified).toBe(true);
        expect(String(report.rollbackTargetRevision)).toMatch(/^[0-9a-f]{40}$/);
      } else {
        // The honest-skip contract: the driver records the skipped
        // rollback drills as an ok step with the exact reason, and
        // omits rollbackTargetRevision (nothing is fabricated).
        expect(report.rollbackTargetRevision).toBeUndefined();
        const skipped = stepOf(report, "release-rollback-drills");
        expect(skipped.ok).toBe(true);
        expect(skipped.kind).toBe("positive");
        const skippedFacts = skipped.facts as Record<string, unknown>;
        expect(skippedFacts.skipped).toBe(true);
        expect(String(skippedFacts.reason)).toContain(
          "no ancestor revision with byte-identical deploy/manifests",
        );
        expect(String(skippedFacts.reason)).toContain("differ only by revision");
      }

      // The teardown facts.
      expect(stepOf(report, "teardown-classification-refused").ok).toBe(true);
      expect(stepOf(report, "teardown-pgdrop-refused").ok).toBe(true);
      expect(stepOf(report, "teardown-real").ok).toBe(true);
      expect(facts.zeckLocalDropped).toBe(true);

      // The tool's own honest live-provider not-run registry, collected.
      const liveSteps = facts.provisionLiveProviderSteps as {
        status: string;
        credentialsPresent: boolean;
        owner: string | null;
      }[];
      expect(liveSteps.length).toBeGreaterThanOrEqual(6);
      for (const step of liveSteps) {
        expect(step.status).toBe("not-run");
        expect(step.credentialsPresent).toBe(false);
        expect(step.owner).toContain("Lead");
      }

      // The driver's NOT RUN registry: complete, owned, honest.
      const notRun = report.notRun as { check: string; reason: string; owner: string }[];
      expect(notRun.length).toBeGreaterThanOrEqual(6);
      for (const boundary of notRun) {
        expect(boundary.reason.length).toBeGreaterThan(20);
        expect(boundary.owner.length).toBeGreaterThan(5);
      }
      expect(String(facts.liveCostConsumed)).toContain("zero");
    }, 360_000);

    test("the plane-boot race pin: run 2 of 3 consecutive full driver runs stays valid", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: E2E_PG_URL });
      expect(run.code).toBe(0);
      const report = reportOf(run);
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
    }, 360_000);

    test("the plane-boot race pin: run 3 of 3 consecutive full driver runs stays valid", () => {
      const run = runDriver({ ZECK_PG_ADMIN_URL: E2E_PG_URL });
      expect(run.code).toBe(0);
      const report = reportOf(run);
      expect(report.valid).toBe(true);
      expect(report.problems).toEqual([]);
    }, 360_000);
  },
);

describe.skipIf(!HAS_GIT)("the driver's own fail-closed preflight (no PostgreSQL required)", () => {
  test("without ZECK_PG_ADMIN_URL the driver refuses before any step (exit 2, the exact reason)", () => {
    const run = runDriver({ ZECK_PG_ADMIN_URL: "" });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("ZECK_PG_ADMIN_URL is required");
    expect(run.stdout).not.toContain('"valid": true');
  });

  test("a credential-carrying ZECK_PG_ADMIN_URL is refused (URL hygiene, fail closed)", () => {
    const run = runDriver({
      ZECK_PG_ADMIN_URL: "postgres://postgres:secret@127.0.0.1:54329/postgres",
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("URL-embedded credentials");
    expect(run.stderr).toContain("refusing");
  });
});
