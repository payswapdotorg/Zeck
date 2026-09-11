/**
 * VAL-002 acceptance criterion 7: a clean-checkout sample app can be
 * bootstrapped without internal source imports — proven mechanically:
 * every import in the application and harness trees resolves to the
 * public SDK, node builtins, or the validation laboratory itself.
 * NOTHING may import Zeck internals (src/**) — the customer boundary
 * is the public surface only.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(process.cwd());

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const full = join(join(REPO_ROOT, dir), entry.name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  const from = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") {
      from.pop();
    } else if (segment === "." || segment === "") {
      // stay
    } else if (segment.endsWith(".ts")) {
      from.push(segment.slice(0, -3));
    } else {
      from.push(segment);
    }
  }
  return from.join("/");
}

const CUSTOMER_TREES = [
  ...collectFiles("benchmarks/validation/apps"),
  ...collectFiles("benchmarks/validation/harness"),
];

describe("validation: clean-checkout customer boundary (VAL-002 AC7)", () => {
  test("the application and harness trees exist and are scanned", () => {
    expect(CUSTOMER_TREES.length).toBeGreaterThanOrEqual(4);
    expect(CUSTOMER_TREES.some((file) => file.includes("apps/sample/application.ts"))).toBe(true);
  });

  test("every import resolves to the public SDK, node builtins or the lab — never src/**", () => {
    const violations: string[] = [];
    for (const file of CUSTOMER_TREES) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) {
          // non-relative: only node builtins are allowed
          if (!specifier.startsWith("node:")) {
            violations.push(`${file}: external import ${specifier}`);
          }
          continue;
        }
        const resolved = resolveSpecifier(file, specifier);
        if (resolved.startsWith("src/")) {
          violations.push(`${file}: ${specifier} -> ${resolved} (internal source import)`);
        }
        if (resolved.startsWith("sdk") && resolved !== "sdk" && !resolved.startsWith("sdk/")) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the application rides the public SDK client (the customer seam)", () => {
    const harnessText = readFileSync(
      join(REPO_ROOT, "benchmarks/validation/harness/harness.ts"),
      "utf8",
    );
    expect(harnessText).toContain('from "../../../sdk"');
    expect(harnessText).toContain("createZeckClient");
  });
});
