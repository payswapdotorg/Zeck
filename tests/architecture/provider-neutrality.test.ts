/**
 * Architecture: provider neutrality of the connection/model contracts
 * (WORK-003, CON-001; architecture-lock invariants 2 and 9).
 *
 * The scanner is SHARED with the discrimination proofs
 * (`tests/discrimination/lib/provider-neutrality.ts`): one definition of the
 * protection, two uses — the gate over the real `src/` tree, the proofs over
 * synthetic mutations.
 *
 * Additionally enforces that domain/application/ports layers of both new
 * modules import no packages at all (infrastructure lives in adapters).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { providerNeutralityViolations } from "../discrimination/lib/provider-neutrality";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function collectFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

const toRelative = (path: string): string => path.slice(REPO_ROOT.length + 1);

const MODULES_ROOT = join(REPO_ROOT, "src/modules");
const tsFiles = collectFiles(MODULES_ROOT, (p) => p.endsWith(".ts")).map((absolute) => ({
  path: toRelative(absolute),
  content: readFileSync(absolute, "utf8"),
}));

describe("provider neutrality across the connections/models modules", () => {
  test("provider identifiers appear only inside owning adapter files", () => {
    expect(providerNeutralityViolations(tsFiles).identifierViolations).toEqual([]);
  });

  test("rail slugs are confined to the vocabulary, adapters and migration", () => {
    expect(providerNeutralityViolations(tsFiles).railLiteralViolations).toEqual([]);
  });

  test("runtime HTTP egress exists only in the fetch transport adapter", () => {
    expect(providerNeutralityViolations(tsFiles).fetchViolations).toEqual([]);
  });

  test("domain/application/ports layers import packages nowhere (adapters own infrastructure)", () => {
    const violations: string[] = [];
    for (const file of tsFiles) {
      if (!/(domain|application|ports)\/[^/]+\.ts$/.test(file.path)) continue;
      const bareImports = [
        ...file.content.matchAll(/from\s+["']([^."'][^"']*)["']/g),
        ...file.content.matchAll(/import\s+["']([^."'][^"']*)["']/g),
      ].map((m) => m[1] ?? "");
      for (const specifier of bareImports) {
        if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
        violations.push(`${file.path} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
