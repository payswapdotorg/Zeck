/**
 * Integration test — fresh-clone governance validation (WORK-001 acceptance
 * criterion 5).
 *
 * A fresh clone of this repository must be able to run governance validation
 * with nothing but Python available: no `bun install`, no node_modules, no
 * application source required. The copy here contains exactly the tracked
 * files a clone would materialize.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COPIES: string[] = [];

afterAll(() => {
  for (const dir of COPIES) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance validation runs on clone-equivalent content without any toolchain install", () => {
  const cloneDir = mkdtempSync(join(tmpdir(), "zeck-fresh-clone-"));
  COPIES.push(cloneDir);

  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
  expect(tracked.length).toBeGreaterThan(50);

  for (const rel of tracked) {
    const target = join(cloneDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO_ROOT, rel), target);
  }

  // No node_modules exists in the clone — validation must not need it.
  expect(tracked.some((rel) => rel.startsWith("node_modules/"))).toBe(false);

  const output = execFileSync("python3", ["scripts/governance-check.py"], {
    cwd: cloneDir,
    encoding: "utf8",
  });
  expect(output).toContain("Governance OK");
});
