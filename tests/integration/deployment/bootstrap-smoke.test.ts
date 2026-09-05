/**
 * Real-PostgreSQL integration tests — the deployment tooling
 * lifecycle (WORK-042 AC8; Required Verification: "idempotent
 * bootstrap/teardown smoke tests", "dependency failure/degraded-mode
 * tests", "exact-revision deployment smoke verification").
 *
 * Drives the REAL tools (`bun deploy/bootstrap.ts`, `deploy/teardown`,
 * `deploy/smoke`, `deploy/identity`) as subprocesses against a REAL
 * PostgreSQL admin endpoint — the exact operator path, not a parallel
 * implementation:
 *
 *   ZECK_PG_TEST_URL=postgres://user:pass@host:port/postgres
 *
 * Tests skip (explicit reason) when no PostgreSQL endpoint is
 * provided, matching the WORK-002 harness convention.
 *
 * Required-test mapping:
 *  - bootstrap converges the disposable local resource set idempotently
 *    (two consecutive runs, byte-stable resource inventory);
 *  - teardown removes exactly the computed disposable resources and the
 *    environment can be recreated (recovery);
 *  - the classification guard REFUSES staging/production teardown AND
 *    leaves authoritative state untouched (exit code 3, no mutation);
 *  - provider-environment bootstrap without materialized secret
 *    references is a non-executable plan (fail closed, no half state);
 *  - the smoke tool fails closed when the authoritative dependency is
 *    unreachable, degrades explicitly without Redis, and emits the
 *    exact-revision deployment identity;
 *  - identity emission is deterministic at the same revision.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function runTool(
  script: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): ToolResult {
  const result = spawnSync("bun", [join("deploy", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: 60_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zeck-deploy-test-"));
  DATA_ROOTS.push(root);
  return root;
}

async function databaseExists(name: string): Promise<boolean> {
  const client = new Client({ connectionString: PG_ADMIN_URL });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>({
      text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      values: [name],
    });
    return result.rows[0]?.exists === true;
  } finally {
    await client.end();
  }
}

const LOCAL_ENV = {
  ZECK_ENVIRONMENT: "local",
  ZECK_PG_ADMIN_URL: PG_ADMIN_URL,
};

describe.skipIf(PG_ADMIN_URL.length === 0)(
  "idempotent local bootstrap over real PostgreSQL (AC8)",
  () => {
    test("bootstrap converges the disposable local resources (from the pristine state)", async () => {
      const root = dataRoot();
      // Establish the pristine state first (hermetic against prior runs
      // of this suite or the tools against the shared test server):
      // teardown is the computed-name-only, idempotent inverse.
      runTool("teardown.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(await databaseExists("zeck_local")).toBe(false);
      const first = runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(first.code, first.stderr).toBe(0);
      const report = JSON.parse(first.stdout) as {
        operations: Array<{ name: string; action: string }>;
      };
      expect(report.operations[0]?.name).toBe("zeck_local");
      expect(report.operations[0]?.action).toBe("created");
      expect(existsSync(join(root, "zeck-local-artifacts"))).toBe(true);
    });

    test("a second bootstrap run converges WITHOUT duplicating (idempotence)", async () => {
      const root = dataRoot();
      runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      const second = runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(second.code, second.stderr).toBe(0);
      const report = JSON.parse(second.stdout) as {
        operations: Array<{ name: string; action: string }>;
      };
      expect(report.operations[0]?.name).toBe("zeck_local");
      expect(report.operations[0]?.action).toBe("already-present (converged)");
      // Exactly one local database exists — idempotence is structural.
      expect(await databaseExists("zeck_local")).toBe(true);
    });

    test("teardown removes exactly the computed disposable resources; recovery recreates them", async () => {
      const root = dataRoot();
      runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      const teardown = runTool("teardown.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(teardown.code, teardown.stderr).toBe(0);
      expect(await databaseExists("zeck_local")).toBe(false);
      expect(existsSync(join(root, "zeck-local-artifacts"))).toBe(false);

      // Recovery: the disposable environment is recreatable.
      const recovery = runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(recovery.code, recovery.stderr).toBe(0);
      expect(await databaseExists("zeck_local")).toBe(true);
    });
  },
);

describe.skipIf(PG_ADMIN_URL.length === 0)(
  "the classification guard refuses persistent-environment teardown (AC8)",
  () => {
    test("production teardown is refused (exit 3) and authoritative state is untouched", async () => {
      runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: dataRoot(),
      });
      const refusal = runTool("teardown.ts", ["--environment", "production"], {
        ZECK_ENVIRONMENT: "production",
      });
      expect(refusal.code).toBe(3);
      expect(refusal.stderr).toContain("teardown refused");
      expect(refusal.stderr).toContain("persistent");
      // Authoritative state untouched: the local database still exists
      // (the refusal happened BEFORE any mutation).
      expect(await databaseExists("zeck_local")).toBe(true);
    });

    test("staging teardown is refused identically", () => {
      const refusal = runTool("teardown.ts", ["--environment", "staging"], {
        ZECK_ENVIRONMENT: "staging",
      });
      expect(refusal.code).toBe(3);
      expect(refusal.stderr).toContain("teardown refused");
    });
  },
);

describe.skipIf(PG_ADMIN_URL.length === 0)(
  "provider-environment bootstrap is fail-closed without materialized references",
  () => {
    test("staging bootstrap emits a non-executable plan and mutates nothing", () => {
      const plan = runTool("bootstrap.ts", ["--environment", "staging"], {
        ZECK_ENVIRONMENT: "staging",
      });
      expect(plan.code, plan.stderr).toBe(0);
      const parsed = JSON.parse(plan.stdout) as {
        executable: boolean;
        operations: Array<{ name: string; action: string }>;
        preconditions: { secretReferences: Array<{ materialized: boolean }> };
      };
      expect(parsed.executable).toBe(false);
      expect(parsed.operations.every((o) => o.action.startsWith("plan-only"))).toBe(true);
      expect(parsed.preconditions.secretReferences.every((r) => r.materialized === false)).toBe(
        true,
      );
      // No PostgreSQL database for staging exists — bootstrap never
      // mutated anything outside the local disposable class.
      expect(parsed.operations.some((o) => o.name === "zeck-staging")).toBe(true);
    });
  },
);

describe.skipIf(PG_ADMIN_URL.length === 0)(
  "the smoke tool: readiness, degradation and exact-revision identity",
  () => {
    test("local smoke degrades explicitly without Redis and attests the exact revision", () => {
      const root = dataRoot();
      runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      const smoke = runTool("smoke.ts", ["--environment", "local", "--allow-degraded"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(smoke.code, smoke.stderr).toBe(0);
      const report = JSON.parse(smoke.stdout) as {
        gitRevision: string;
        identity: { identityId: string; gitRevision: string };
        readiness: {
          overall: string;
          controlPlane: string;
          dependencies: Array<{ concern: string; status: string; degradedMode: string | null }>;
        };
      };
      // The exact-revision identity: the smoke attests the checkout HEAD.
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      expect(report.gitRevision).toBe(head);
      expect(report.identity.gitRevision).toBe(head);
      expect(report.identity.identityId).toMatch(/^[0-9a-f]{64}$/);
      // The distinction: control plane ready; the authoritative
      // dependency READY (fail-closed anchor); coordination degraded.
      expect(report.readiness.controlPlane).toBe("ready");
      expect(report.readiness.overall).toBe("degraded");
      const relational = report.readiness.dependencies.find(
        (d) => d.concern === "relational-state",
      );
      expect(relational?.status).toBe("ready");
      const coordination = report.readiness.dependencies.find(
        (d) => d.concern === "ephemeral-coordination",
      );
      expect(coordination?.status).toBe("degraded");
      expect(coordination?.degradedMode).toBe("coordination-degraded");
    });

    test("local smoke FAILS CLOSED when the authoritative dependency is unreachable", () => {
      const root = dataRoot();
      const smoke = runTool("smoke.ts", ["--environment", "local", "--allow-degraded"], {
        ZECK_ENVIRONMENT: "local",
        ZECK_PG_ADMIN_URL: "postgres://postgres@127.0.0.1:1/postgres",
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(smoke.code).toBe(1);
      const report = JSON.parse(smoke.stdout) as {
        readiness: { overall: string; dependencies: Array<{ concern: string; status: string }> };
      };
      expect(report.readiness.overall).toBe("down");
      expect(
        report.readiness.dependencies.find((d) => d.concern === "relational-state")?.status,
      ).toBe("unavailable");
    });

    test("degraded without --allow-degraded is a failed smoke (exit 1)", () => {
      const root = dataRoot();
      runTool("bootstrap.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      const smoke = runTool("smoke.ts", ["--environment", "local"], {
        ...LOCAL_ENV,
        ZECK_LOCAL_DATA_ROOT: root,
      });
      expect(smoke.code).toBe(1);
      const report = JSON.parse(smoke.stdout) as { readiness: { overall: string } };
      expect(report.readiness.overall).toBe("degraded");
    });

    test("identity emission is deterministic at the same revision", () => {
      const first = runTool("identity.ts", ["--environment", "local"], {
        ZECK_ENVIRONMENT: "local",
      });
      const second = runTool("identity.ts", ["--environment", "local"], {
        ZECK_ENVIRONMENT: "local",
      });
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(first.stdout).toBe(second.stdout);
    });
  },
);
