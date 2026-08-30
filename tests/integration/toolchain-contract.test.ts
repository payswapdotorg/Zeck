/**
 * Integration test — deterministic toolchain contract (WORK-001 acceptance
 * criterion 1).
 *
 * The install/typecheck/lint/test commands are a repository contract: CI
 * (`/.github/workflows/governance.yml`) and every worker rely on them being
 * deterministic. This test pins the command set, the exact-pinned dev
 * dependency strategy, the strict compiler setup and the committed lockfile.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8")) as Record<string, unknown>;
}

describe("deterministic toolchain contract", () => {
  test("package.json defines the canonical command set", () => {
    const manifest = readJson("package.json") as {
      scripts: Record<string, string>;
      packageManager: string;
    };
    // WORK-002: the canonical commands must all be present and exact. The
    // manifest is a SUPERSET check by design — Work Orders add directly-
    // required commands (e.g. WORK-002's `test:pg` for its mandated real-
    // PostgreSQL verification) without weakening this contract.
    const canonicalCommands: Record<string, string> = {
      "governance:check": "python3 scripts/governance-check.py",
      typecheck: "tsc --noEmit",
      lint: "biome check .",
      "test:unit": "vitest run tests/unit",
      "test:integration": "vitest run tests/integration",
      "test:architecture": "vitest run tests/architecture tests/discrimination",
      test: "vitest run",
    };
    for (const [name, command] of Object.entries(canonicalCommands)) {
      expect(manifest.scripts[name], `script ${name}`).toBe(command);
    }
    expect(manifest.packageManager).toBe("bun@1.3.4");
  });

  test("all dev dependencies are exact-pinned (deterministic install)", () => {
    const manifest = readJson("package.json") as { devDependencies: Record<string, string> };
    const entries = Object.entries(manifest.devDependencies);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [name, version] of entries) {
      expect(version, `${name} must be exact-pinned`).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  test("a lockfile is committed for frozen installs", () => {
    const lockPath = resolve(REPO_ROOT, "bun.lock");
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).size).toBeGreaterThan(0);
  });

  test("the compiler runs in strict mode over src and tests", () => {
    const config = readJson("tsconfig.json") as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.compilerOptions.noEmit).toBe(true);
    expect(config.compilerOptions.verbatimModuleSyntax).toBe(true);
    expect(config.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(config.include).toContain("src/**/*");
    expect(config.include).toContain("tests/**/*");
  });

  test("lint and test configurations are committed", () => {
    expect(existsSync(resolve(REPO_ROOT, "biome.json"))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, "vitest.config.ts"))).toBe(true);
  });
});
