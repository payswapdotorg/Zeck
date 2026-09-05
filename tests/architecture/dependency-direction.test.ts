/**
 * Dependency-direction architecture test (WORK-001 acceptance criterion 4).
 *
 * Runs the rule engine over the real `src/` tree and requires zero
 * violations. The discriminating power of each rule is proven separately in
 * `tests/discrimination/`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("dependency direction over the real src/ tree", () => {
  const files = collectSourceFiles(REPO_ROOT);
  const allowedPackages = declaredRuntimePackages(REPO_ROOT);

  test("the source tree is non-empty and scanned", () => {
    expect(files.length).toBeGreaterThan(100);
    // WORK-015 adds the sanctioned runtime dependency fastify
    // (IMPLEMENTATION.md §1 "HTTP/API: Fastify", confined to src/api/ by
    // the SDK-boundary table). WORK-043 (D-02) adds pg as the runtime
    // database driver, confined to src/platform/db/ by the same table.
    // Everything else still fails closed.
    expect(allowedPackages).toEqual(["fastify", "pg"]);
  });

  test("no rule violations anywhere in src/", () => {
    const violations = scanDependencyRules(files, { allowedPackages });
    expect(violations.map((v) => `${v.rule} @ ${v.path} -> ${v.importSpecifier}`)).toEqual([]);
  });

  test("cross-module internal imports are absent (criterion 4, explicit)", () => {
    const violations = scanDependencyRules(files, { allowedPackages }).filter(
      (v) => v.rule === "internal-never-cross-module",
    );
    expect(violations).toEqual([]);
  });

  test("provider SDK imports outside owning adapters are absent (criterion 4, explicit)", () => {
    const violations = scanDependencyRules(files, { allowedPackages }).filter(
      (v) => v.rule === "provider-sdk-outside-adapter",
    );
    expect(violations).toEqual([]);
  });
});
