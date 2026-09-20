/**
 * Integration — the PPR-002 preflight CLI over the REAL checkout
 * (deploy/preflight.ts executed as the real tool subprocess).
 *
 * Proves end to end, zero credentials and zero network:
 *  - the preview preflight PASSES (exit 0) with the honest not-run
 *    credential rows (owner: Lead credentialed re-run), the refreshed
 *    tier ledger reconciled at its recorded asOf, the commercial
 *    boundary surfaced, and the PPR-002 provisioning order pinned;
 *  - the local preflight PASSES with the fully local/self-hosted
 *    resource set (no account-plane credentials);
 *  - the URL-hygiene hostile negative: a credential-carrying
 *    ZECK_PG_ADMIN_URL REFUSES (exit 1), naming the variable and
 *    never rendering the value.
 *
 * No PostgreSQL server is required: the preflight is the head of the
 * PPR-002 sequence precisely because it needs no rails. The suite
 * requires the checkout's .git directory (exact-revision identity)
 * and skips cleanly without it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The account-plane credential variables (the provision-shared list). */
const CREDENTIAL_VARIABLES = [
  "NEON_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "UPSTASH_API_KEY",
  "VERCEL_TOKEN",
] as const;

function runPreflight(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): ToolResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Deterministic credential-absence: strip the account-plane
  // variables so the not-run rows are asserted against a known state.
  for (const variable of CREDENTIAL_VARIABLES) {
    delete env[variable];
  }
  Object.assign(env, extraEnv);
  const result = spawnSync("bun", [join("deploy", "preflight.ts"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The JSON report the tool printed (first {...} block on stdout). */
function reportOf(result: ToolResult): Record<string, unknown> {
  const start = result.stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(start)) as Record<string, unknown>;
}

describe.skipIf(!HAS_GIT)("the PPR-002 preflight CLI (real subprocess)", () => {
  test("preview preflight passes with honest not-run credential rows and the reconciled ledger", () => {
    const result = runPreflight(["--environment", "preview"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = reportOf(result);

    expect(report.tool).toBe("deploy/preflight");
    expect(report.environment).toBe("preview");
    expect(report.environmentClass).toBe("disposable");
    expect(report.problems).toEqual([]);
    expect(report.passed).toBe(true);

    const credentials = report.credentialPreflight as {
      rows: { status: string; owner: string | null }[];
      notRun: number;
      localSelfHosted: number;
    };
    expect(credentials.notRun).toBe(6);
    expect(credentials.localSelfHosted).toBe(1);
    for (const row of credentials.rows) {
      if (row.status === "not-run") {
        expect(row.owner).toContain("Lead");
      }
    }

    const reconciliation = report.tierReconciliation as {
      ledgerAsOf: string;
      problems: string[];
      recordedNotLiveVerified: number;
      liveReverification: { status: string; owner: string };
    };
    expect(reconciliation.ledgerAsOf).toBe("2026-09-20");
    expect(reconciliation.problems).toEqual([]);
    expect(reconciliation.recordedNotLiveVerified).toBe(8);
    expect(reconciliation.liveReverification.status).toBe("not-run");
    expect(reconciliation.liveReverification.owner).toContain("Lead");

    const boundary = report.commercialBoundary as {
      providerMapCommercialUse: string | null;
      rule: string;
    };
    expect(boundary.providerMapCommercialUse).toContain("non-commercial");
    expect(boundary.rule).toContain("non-commercial preview rail");

    const order = report.provisioningOrder as {
      step: string;
      ownedByThisTool: boolean;
    }[];
    expect(order[0]?.step).toBe("account/credential preflight");
    expect(order[1]?.step).toBe("provider-tier fact reconciliation");
    expect(order[0]?.ownedByThisTool).toBe(true);
    expect(order[1]?.ownedByThisTool).toBe(true);
  });

  test("local preflight passes with the fully local/self-hosted resource set", () => {
    const result = runPreflight(["--environment", "local"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = reportOf(result);
    const credentials = report.credentialPreflight as {
      rows: { kind: string; status: string }[];
      notRun: number;
      localSelfHosted: number;
    };
    expect(credentials.rows.map((row) => row.kind).sort()).toEqual([
      "local-container-runner",
      "local-object-store",
      "local-redis",
      "pg-database",
    ]);
    expect(credentials.notRun).toBe(0);
    expect(credentials.localSelfHosted).toBe(4);
  });

  test("a credential-carrying admin URL refuses the preflight (URL hygiene, fail closed)", () => {
    const result = runPreflight(["--environment", "local"], {
      ZECK_PG_ADMIN_URL: "postgres://postgres:super-secret-value@127.0.0.1:54329/postgres",
    });
    expect(result.code).toBe(1);
    const report = reportOf(result);
    expect(report.passed).toBe(false);
    const problems = report.problems as string[];
    expect(problems.some((problem) => problem.includes("ZECK_PG_ADMIN_URL"))).toBe(true);
    // The credential value is NEVER rendered.
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
    expect(result.stdout).not.toContain("super-secret-value");
  });
});
