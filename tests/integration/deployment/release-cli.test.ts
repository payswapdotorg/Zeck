/**
 * Integration — the release-control operator CLI over the REAL local
 * environment (WORK-047 / D-06; IMPLEMENTATION-COMPLETENESS).
 *
 * Executes deploy/release.ts as the real tool subprocesses against
 * the real local PostgreSQL server (the drill database zeck_local,
 * converged by the shipped migrations):
 *
 *  - `record` binds the exact checkout revision + the deterministic
 *    deployment identity (idempotent);
 *  - `gate run validation` produces real tool-run evidence (exit 0);
 *  - `gate run identity-audit` verifies the binding at the exact
 *    revision;
 *  - `promote --to ci` without the CI gate set is REFUSED with the
 *    exact missing evidence (exit 1) and the refusal is journaled;
 *  - `gate attach` records external evidence (the attach-only
 *    vocabulary);
 *  - `inspect` returns the full ledger view;
 *  - `status` returns the promotion pre-flight;
 *  - `alerts` evaluates the quota/operational state.
 *
 * The full test suite gate is NOT executed here (the CI convention:
 * the heavyweight checkout gate runs in CI; the refusal proof only
 * needs its absence).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PG_ADMIN_URL = process.env.ZECK_PG_TEST_URL ?? "";

const DATA_ROOTS: string[] = [];

afterAll(() => {
  for (const root of DATA_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runRelease(args: readonly string[]): ToolResult {
  const dataRoot = mkdtempSync(join("/tmp", "zeck-release-cli-"));
  DATA_ROOTS.push(dataRoot);
  const result = spawnSync("bun", [join("deploy", "release.ts"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ZECK_ENVIRONMENT: "local",
      ZECK_PG_ADMIN_URL: PG_ADMIN_URL,
      ZECK_LOCAL_DATA_ROOT: dataRoot,
    },
    timeout: 120_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The JSON document the tool printed (last {...} block on stdout). */
function jsonOf(result: ToolResult): Record<string, unknown> {
  const start = result.stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(start)) as Record<string, unknown>;
}

describe.skipIf(PG_ADMIN_URL.length === 0 || !existsSync(join(REPO_ROOT, ".git")))(
  "the release-control CLI over the real local environment (WORK-047 D-06)",
  () => {
    test("the environment is convergeable (deploy:migrate idempotent)", async () => {
      // The drill database must exist + be converged for the ledger.
      const migrate = await promisified([join("deploy", "migrate.ts"), "--environment", "local"]);
      expect(migrate.code).toBe(0);
      const report = JSON.parse(migrate.stdout.slice(migrate.stdout.indexOf("{"))) as {
        migrations: { total: number };
      };
      expect(report.migrations.total).toBeGreaterThanOrEqual(28);
    }, 120_000);

    test("record: the exact checkout revision + identity, idempotent", () => {
      const first = runRelease(["record", "--environment", "local", "--actor", "cli-test"]);
      expect(first.code).toBe(0);
      const document = jsonOf(first);
      const identity = document.identity as { gitRevision: string; identityId: string };
      expect(identity.gitRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(identity.identityId).toMatch(/^[0-9a-f]{64}$/);
      const release = document.release as { releaseId: string };
      expect(release.releaseId).toMatch(/^[0-9a-f]{64}$/);
      // Idempotent: the same record returns.
      const second = runRelease(["record", "--environment", "local", "--actor", "cli-test"]);
      expect(second.code).toBe(0);
      const again = jsonOf(second).release as { releaseId: string };
      expect(again.releaseId).toBe(release.releaseId);
    }, 180_000);

    test("gate run validation: real tool-run evidence (exit 0)", () => {
      const result = runRelease([
        "gate",
        "run",
        "--kind",
        "validation",
        "--environment",
        "ci",
        "--actor",
        "cli-test",
      ]);
      expect(result.code).toBe(0);
      const gate = jsonOf(result).result as {
        status: string;
        source: string;
        evidenceDetail: string;
      };
      expect(gate.status).toBe("passed");
      expect(gate.source).toBe("tool-run");
      expect(gate.evidenceDetail).toContain("deploy:validate valid");
    }, 120_000);

    test("gate run identity-audit: the exact-revision binding verifies", () => {
      const result = runRelease([
        "gate",
        "run",
        "--kind",
        "identity-audit",
        "--environment",
        "local",
        "--actor",
        "cli-test",
      ]);
      expect(result.code).toBe(0);
      const gate = jsonOf(result).result as { status: string; evidenceDetail: string };
      expect(gate.status).toBe("passed");
      expect(gate.evidenceDetail).toContain("recomputes");
    }, 120_000);

    test("gate run validation at the local phase + promote --to local: the governed pointer activation", () => {
      // The local entry gate set is [validation] recorded AT the local
      // phase (self-sufficient: the shared drill database may have
      // been torn down by a sibling suite in the same run).
      const gate = runRelease([
        "gate",
        "run",
        "--kind",
        "validation",
        "--environment",
        "local",
        "--actor",
        "cli-test",
      ]);
      expect(gate.code).toBe(0);
      const promotion = runRelease(["promote", "--to", "local", "--actor", "cli-test"]);
      expect(promotion.code).toBe(0);
      const document = jsonOf(promotion);
      expect(document.promoted).toBe(true);
      expect(document.satisfiedGates).toEqual(["validation"]);
      const active = document.activeDeployment as { environment: string; releaseId: string };
      expect(active.environment).toBe("local");
      expect(active.releaseId).toMatch(/^[0-9a-f]{64}$/);
    }, 180_000);

    test("promote --to ci without the CI gates: REFUSED with the exact missing evidence (exit 1, journaled)", () => {
      const result = runRelease(["promote", "--to", "ci", "--actor", "cli-test"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("missing required gate evidence");
      for (const gate of ["governance-check", "typecheck", "lint", "full-test-suite"]) {
        expect(result.stderr).toContain(gate);
      }
      const document = jsonOf(result);
      expect(document.allowed).toBe(false);
      const missing = document.missingGates as string[];
      expect(missing).toContain("governance-check");
    }, 120_000);

    test("gate attach: external evidence records (the attach-only vocabulary)", () => {
      const result = runRelease([
        "gate",
        "attach",
        "--kind",
        "ci-gates",
        "--environment",
        "preview",
        "--actor",
        "cli-test",
        "--statement",
        "ci workflow concluded successfully at this exact revision (test attach)",
      ]);
      expect(result.code).toBe(0);
      const gate = jsonOf(result).result as {
        status: string;
        source: string;
        environment: string;
      };
      expect(gate.status).toBe("passed");
      expect(gate.source).toBe("external-attach");
      expect(gate.environment).toBe("preview");
    }, 120_000);

    test("inspect: the full ledger view (release, bindings, gates, journal, pointer)", () => {
      const result = runRelease(["inspect", "--environment", "local"]);
      expect(result.code).toBe(0);
      const inspection = (jsonOf(result).inspection ?? {}) as {
        release?: { releaseId: string; gitRevision: string };
        environmentDeployments?: { environment: string }[];
        effectiveGates?: { gateKind: string; status: string }[];
        promotions?: { decision: string }[];
        activeDeployments?: { environment: string; releaseId: string }[];
      };
      expect(inspection.release?.gitRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(inspection.environmentDeployments?.some((d) => d.environment === "local")).toBe(true);
      expect(inspection.effectiveGates?.some((g) => g.gateKind === "validation")).toBe(true);
      // The refusal journal carries the audit trail.
      expect(inspection.promotions?.some((p) => p.decision === "refused")).toBe(true);
      expect(inspection.activeDeployments?.some((d) => d.environment === "local")).toBe(true);
    }, 120_000);

    test("status: the promotion pre-flight with the ladder and alerts", () => {
      const result = runRelease(["status", "--environment", "local"]);
      expect(result.code).toBe(0);
      const document = jsonOf(result);
      expect(document.checkoutReleaseId).toMatch(/^[0-9a-f]{64}$/);
      const ladder = document.ladder as { phase: string; requiredGates: string[] }[];
      expect(ladder.map((entry) => entry.phase)).toEqual([
        "local",
        "ci",
        "preview",
        "staging",
        "production",
      ]);
      expect(Array.isArray(document.alerts)).toBe(true);
    }, 120_000);

    test("alerts: the quota/operational evaluation (exit 0 without criticals)", () => {
      const result = runRelease(["alerts", "--environment", "local"]);
      expect(result.code).toBe(0);
      const document = jsonOf(result);
      expect(document.critical).toBe(false);
    }, 120_000);

    test("the drill left the release ledger consistent (direct SQL)", async () => {
      // The CLI writes to the computed zeck_local database (the local
      // ledger), derived from the admin URL exactly as the tool does.
      const ledgerUrl = PG_ADMIN_URL.replace(/\/[^/]*$/, "/zeck_local");
      const client = new Client({ connectionString: ledgerUrl });
      await client.connect();
      try {
        const releases = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM release_control.releases",
        );
        expect(Number(releases.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
        const gates = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM release_control.gate_results",
        );
        expect(Number(gates.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(3);
      } finally {
        await client.end();
      }
    }, 30_000);
  },
);

function promisified(args: readonly string[]): Promise<ToolResult> {
  const dataRoot = mkdtempSync(join("/tmp", "zeck-release-cli-"));
  DATA_ROOTS.push(dataRoot);
  return new Promise((resolvePromise) => {
    const result = spawnSync("bun", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ZECK_ENVIRONMENT: "local",
        ZECK_PG_ADMIN_URL: PG_ADMIN_URL,
        ZECK_LOCAL_DATA_ROOT: dataRoot,
      },
      timeout: 120_000,
    });
    resolvePromise({
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  });
}
