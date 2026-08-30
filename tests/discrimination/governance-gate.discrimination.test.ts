/**
 * Discrimination test for the repository governance gate itself
 * (SELF-HOSTING-BOUNDARY, WORK-001 assurance profile CRITICAL).
 *
 * The governance gate (`scripts/governance-check.py`) is the repository's own
 * protection. This suite proves it discriminates: a pristine copy of the
 * tracked tree passes, while targeted mutations of governance state are
 * rejected with a non-zero exit. If the gate ever stopped discriminating,
 * repository-resident governance would be vacuous.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRACKED_COPY_DIRS = new Set<string>();

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
}

/** Fresh copy of the tracked tree (clone-equivalent content: no node_modules, no untracked files). */
function freshCopy(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `zeck-governance-${label}-`));
  for (const rel of trackedFiles()) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO_ROOT, rel), target);
  }
  TRACKED_COPY_DIRS.add(dir);
  return dir;
}

function runGovernanceCheck(cwd: string): { code: number; stderr: string } {
  try {
    execFileSync("python3", ["scripts/governance-check.py"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { code: failure.status ?? 1, stderr: failure.stderr ?? "" };
  }
}

afterAll(() => {
  for (const dir of TRACKED_COPY_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control: a pristine tracked copy passes governance validation", () => {
  const copy = freshCopy("pristine");
  const result = runGovernanceCheck(copy);
  expect(result.code).toBe(0);
});

test("a hand-edited frontier (not derived) is rejected", () => {
  const copy = freshCopy("frontier");
  const frontierPath = join(copy, "spec/development-state/frontier-state.json");
  const frontier = JSON.parse(readFileSync(frontierPath, "utf8")) as { eligible: string[] };
  frontier.eligible = ["WORK-002"];
  writeFileSync(frontierPath, `${JSON.stringify(frontier, null, 2)}\n`);
  const result = runGovernanceCheck(copy);
  expect(result.code).not.toBe(0);
});

test("a deleted frozen authority artifact is rejected", () => {
  const copy = freshCopy("lock");
  rmSync(join(copy, "spec/architecture-lock.md"));
  const result = runGovernanceCheck(copy);
  expect(result.code).not.toBe(0);
});

test("a dependency declaration that disagrees with program state is rejected", () => {
  const copy = freshCopy("deps");
  const programPath = join(copy, "spec/development-state/program-state.json");
  const program = JSON.parse(readFileSync(programPath, "utf8")) as {
    workOrders: Array<{ id: string; dependencies: string[] }>;
  };
  const work002 = program.workOrders.find((order) => order.id === "WORK-002");
  if (work002 === undefined) {
    throw new Error("fixture error: WORK-002 missing from program state");
  }
  work002.dependencies = [];
  writeFileSync(programPath, `${JSON.stringify(program, null, 2)}\n`);
  const result = runGovernanceCheck(copy);
  expect(result.code).not.toBe(0);
});

test("merge evidence on an incomplete Work Order is rejected", () => {
  const copy = freshCopy("merge-evidence");
  const programPath = join(copy, "spec/development-state/program-state.json");
  const program = JSON.parse(readFileSync(programPath, "utf8")) as {
    workOrders: Array<{ id: string; status: string; mergedAs?: unknown }>;
  };
  const work001 = program.workOrders.find((order) => order.id === "WORK-001");
  if (work001 === undefined) {
    throw new Error("fixture error: WORK-001 missing from program state");
  }
  work001.mergedAs = { pr: 999, commit: "0".repeat(40) };
  writeFileSync(programPath, `${JSON.stringify(program, null, 2)}\n`);
  const result = runGovernanceCheck(copy);
  expect(result.code).not.toBe(0);
});
