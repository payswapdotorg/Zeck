/**
 * Unit tests — the DEP-040 end-to-end driver's plan/boundary/guardrail
 * CONTRACT (the driver itself is driven as a full subprocess by
 * tests/integration/deployment/e2e-driver.test.ts; this suite pins the
 * pure contract surfaces the driver exports):
 *
 *  - THE OPERATOR-ORDER CHAIN PLAN: the driver composes the delivered
 *    tools in PUBLIC-DEPLOYMENT.md's operator order (validate →
 *    bootstrap → provision → migrate → identity → public-smoke →
 *    guardrails → release → teardown) — the plan is pinned step by
 *    step, tool by tool, so a reordered or silently-dropped chain link
 *    fails here;
 *  - THE NOT-RUN BOUNDARY REGISTRY: every live-provider rail the driver
 *    cannot run without operator credentials is registered with a
 *    reason and an owner (the credential-honesty doctrine) — the
 *    registry's completeness is pinned (the live promotion rails, the
 *    public-internet smoke, the live-provider resource creation, the
 *    provider meters, the artifact-bytes measurement and CI), and no
 *    boundary may claim a result it did not produce;
 *  - URL HYGIENE: the driver's local-rails configuration is
 *    credential-less by construction — a ZECK_PG_ADMIN_URL carrying
 *    URL-embedded credentials (scheme://user:password@host, the exact
 *    pattern class the architecture secret-scan pins over deploy/**)
 *    is REFUSED with the exact reason, and the driver's own source
 *    carries no such URL;
 *  - THE PLANE-BOOT DOCUMENT DETECTOR: the driver proceeds on the
 *    plane's BOOT DOCUMENT (status "listening"), never a bare health
 *    probe — the detector rejects everything that is not the boot
 *    document (the race class where a /health 200 wins by a tick);
 *  - MANIFEST-CROSS-CHECKED LIMIT RESOLUTIONS: the driver's expected
 *    baseline guardrail limits derive from the REAL quota-guards
 *    manifest at runtime (never tool-local constants) — a mutated
 *    manifest row moves the expectation, and an operator override
 *    wins auditably.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  baselineGuardrailExpectations,
  bootDocumentOf,
  CHAIN_PLAN,
  checkPgAdminUrl,
  NOT_RUN_BOUNDARIES,
} from "../../../deploy/e2e-validate";
import { loadQuotaGuardsPolicy } from "../../../src/platform/observability/alerts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("the driver's operator-order chain plan (PUBLIC-DEPLOYMENT.md)", () => {
  test("the chain composes the delivered tools in the operator's order, link by link", () => {
    expect(CHAIN_PLAN.map((step) => step.id)).toEqual([
      "validate",
      "bootstrap",
      "provision",
      "migrate",
      "identity",
      "public-smoke",
      "guardrails",
      "release",
      "teardown",
    ]);
    expect(CHAIN_PLAN.map((step) => step.tool)).toEqual([
      "deploy/validate.ts",
      "deploy/bootstrap.ts",
      "deploy/provision.ts",
      "deploy/migrate.ts",
      "deploy/identity.ts",
      "deploy/public-smoke.ts",
      "deploy/release.ts (alerts)",
      "deploy/release.ts (record/gate/promote/rollback)",
      "deploy/teardown.ts",
    ]);
  });

  test("every chain link declares its purpose (the plan is the report's plan section)", () => {
    for (const step of CHAIN_PLAN) {
      expect(step.purpose.length).toBeGreaterThan(20);
    }
  });

  test("the configuration gate runs FIRST (the provision tool's own first step)", () => {
    expect(CHAIN_PLAN[0]?.id).toBe("validate");
    expect(CHAIN_PLAN[0]?.purpose).toContain("FIRST");
  });
});

describe("the NOT-RUN boundary registry (the credential-honesty doctrine)", () => {
  test("every live rail the driver cannot run is registered with a reason and an owner", () => {
    expect(NOT_RUN_BOUNDARIES.length).toBeGreaterThanOrEqual(6);
    for (const boundary of NOT_RUN_BOUNDARIES) {
      expect(boundary.check.length).toBeGreaterThan(10);
      expect(boundary.reason.length).toBeGreaterThan(20);
      expect(boundary.owner.length).toBeGreaterThan(5);
    }
  });

  test("the specific rails are all present (completeness)", () => {
    const checks = NOT_RUN_BOUNDARIES.map((boundary) => boundary.check).join("\n");
    expect(checks).toContain("Live-provider promotion rails");
    expect(checks).toContain("public smoke over the public internet");
    expect(checks).toContain("Live-provider resource creation");
    expect(checks).toContain("spend/quota meters");
    expect(checks).toContain("artifact-bytes guardrail utilization");
    expect(checks).toContain("CI execution");
  });

  test("the live rails are owned by the Lead credentialed re-run (never unowned, never assumed-pass)", () => {
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

describe("URL hygiene (the local rails are credential-less by construction)", () => {
  test("a credential-less local URL is accepted", () => {
    const check = checkPgAdminUrl("postgres://postgres@127.0.0.1:54329/postgres");
    expect(check.ok).toBe(true);
    expect(check.endpoint).toBe("127.0.0.1:54329");
  });

  test("a missing URL is refused with the exact configuration reason", () => {
    const check = checkPgAdminUrl(undefined);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("ZECK_PG_ADMIN_URL is required");
    expect(check.reason).toContain("credential-less");
  });

  test("a URL carrying URL-embedded credentials is REFUSED (the B5 pattern class)", () => {
    for (const hostile of [
      "postgres://postgres:secret@127.0.0.1:54329/postgres",
      "postgresql://user:pass@db.example.com:5432/zeck",
    ]) {
      const check = checkPgAdminUrl(hostile);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("URL-embedded credentials");
      expect(check.reason).toContain("refusing");
    }
  });

  test("a non-postgres URL is refused", () => {
    const check = checkPgAdminUrl("http://127.0.0.1:54329");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("postgres://");
  });

  test("the driver's own source carries no URL-embedded credentials (self-consistency with the repo pin)", () => {
    const source = read("deploy/e2e-validate.ts");
    expect(
      /postgres(ql)?:\/\/[^\s"'@/:]+:[^\s"'@]+@/.test(source),
      "deploy/e2e-validate.ts must not construct credential-carrying URLs",
    ).toBe(false);
  });
});

describe("the plane-boot document detector (the boot-race discipline)", () => {
  const boot = JSON.stringify(
    {
      tool: "deploy/api",
      status: "listening",
      environment: "local",
      environmentClass: "disposable",
      host: "127.0.0.1",
      port: 41234,
      deploymentIdentity: { gitRevision: "0".repeat(40) },
      composition: { transport: "real" },
      environmentContract: { satisfied: true, problems: [] },
      routes: 28,
    },
    null,
    2,
  );

  test("the boot document is detected (status listening, port, routes)", () => {
    const document = bootDocumentOf(boot);
    expect(document).not.toBeNull();
    expect(document?.tool).toBe("deploy/api");
    expect(document?.status).toBe("listening");
    expect(document?.port).toBe(41234);
    expect(document?.routes).toBe(28);
  });

  test("partial stdout (the race window: the plane is up but the document is not out yet) is NOT a boot document", () => {
    // A /health probe can succeed in this window — the detector must
    // still refuse: only the complete boot document is the barrier.
    expect(bootDocumentOf(boot.slice(0, Math.floor(boot.length / 2)))).toBeNull();
    expect(bootDocumentOf("")).toBeNull();
    expect(bootDocumentOf("listen: 41234\n")).toBeNull();
  });

  test("a non-boot JSON document on stdout is NOT a boot document", () => {
    expect(
      bootDocumentOf(JSON.stringify({ tool: "deploy/other", status: "listening" })),
    ).toBeNull();
    expect(
      bootDocumentOf(JSON.stringify({ tool: "deploy/api", status: "shutting-down" })),
    ).toBeNull();
  });

  test("trailing output after the boot document does not break the detection", () => {
    const withTrailing = `${boot}\n{"tool":"deploy/api","status":"shutting-down","signal":"SIGTERM"}\n`;
    expect(bootDocumentOf(withTrailing)?.status).toBe("listening");
  });

  test("strings inside the document (braces in descriptions) do not break the parse", () => {
    const tricky = JSON.stringify(
      {
        tool: "deploy/api",
        status: "listening",
        port: 41,
        note: 'a "quoted { brace" and \\ escape',
      },
      null,
      2,
    );
    expect(bootDocumentOf(tricky)?.port).toBe(41);
  });
});

describe("manifest-cross-checked guardrail limit resolutions", () => {
  function policy(source = read("deploy/manifests/quota-guards.json")) {
    return loadQuotaGuardsPolicy(source);
  }

  test("the baseline expectations derive from the REAL manifest rows (never tool-local constants)", () => {
    const expectations = baselineGuardrailExpectations(policy());
    expect(expectations).toEqual([
      { guard: "queue-backlog", limit: 1000, source: "manifest" },
      { guard: "database-size", limit: 5_368_709_120, source: "manifest" },
    ]);
  });

  test("a mutated manifest limit row moves the expectation (the fence moves with the manifest)", () => {
    const mutated = read("deploy/manifests/quota-guards.json").replace(
      '"defaultLimitBytes": 5368709120',
      '"defaultLimitBytes": 1',
    );
    expect(mutated).not.toBe(read("deploy/manifests/quota-guards.json"));
    const expectations = baselineGuardrailExpectations(policy(mutated));
    const databaseSize = expectations.find((entry) => entry.guard === "database-size");
    expect(databaseSize).toEqual({ guard: "database-size", limit: 1, source: "manifest" });
  });

  test("a well-formed operator override wins over the manifest row (auditable)", () => {
    const expectations = baselineGuardrailExpectations(policy(), {
      ZECK_DB_SIZE_LIMIT_BYTES: "1048576",
    });
    expect(expectations.find((entry) => entry.guard === "database-size")).toEqual({
      guard: "database-size",
      limit: 1_048_576,
      source: "operator-override",
    });
  });

  test("a malformed operator override aborts (the expectation is never silently substituted)", () => {
    expect(() =>
      baselineGuardrailExpectations(policy(), { ZECK_DB_SIZE_LIMIT_BYTES: "12abc" }),
    ).toThrow(/malformed limit/);
  });
});
