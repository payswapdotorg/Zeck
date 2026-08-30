/**
 * Unit tests — canonical module registry (`src/shared/module.ts`).
 *
 * The typed module vocabulary in code must mirror `spec/architecture.md` §6
 * exactly. This is the code-side twin of the Python governance gate, which
 * validates the same table against `IMPLEMENTATION.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ARCHITECTURE_MODULE_IDS } from "../../src/shared/module";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("architecture module registry", () => {
  test("contains 18 unique frozen module identities", () => {
    expect(ARCHITECTURE_MODULE_IDS).toHaveLength(18);
    expect(new Set(ARCHITECTURE_MODULE_IDS).size).toBe(18);
  });

  test("mirrors the spec/architecture.md §6 module table exactly", () => {
    const architecture = readFileSync(resolve(REPO_ROOT, "spec/architecture.md"), "utf8");
    const tableModules = [...architecture.matchAll(/^\| `\/([a-z0-9-]+)` \|/gm)].map(
      (match) => match[1],
    );
    expect([...ARCHITECTURE_MODULE_IDS]).toEqual(tableModules);
  });

  test("mirrors the IMPLEMENTATION.md layout exactly", () => {
    const implementation = readFileSync(resolve(REPO_ROOT, "IMPLEMENTATION.md"), "utf8");
    for (const id of ARCHITECTURE_MODULE_IDS) {
      expect(implementation).toContain(`    ${id}/`);
    }
  });
});
