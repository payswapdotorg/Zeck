/**
 * Module skeleton architecture test (WORK-001 acceptance criterion 2).
 *
 * Verifies that the executable module skeleton matches the frozen
 * architecture exactly: every module of `spec/architecture.md` §6 exists
 * with the public/internal boundary convention of `IMPLEMENTATION.md` §2 —
 * and nothing else exists.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ARCHITECTURE_MODULE_IDS } from "../../src/shared/module";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAYERS = ["domain", "application", "ports", "adapters", "internal"] as const;

describe("module directory skeleton", () => {
  test("src/modules contains exactly the architecture modules", () => {
    const present = readdirSync(resolve(REPO_ROOT, "src/modules"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(present).toEqual([...ARCHITECTURE_MODULE_IDS].sort());
  });

  for (const id of ARCHITECTURE_MODULE_IDS) {
    test(`module ${id} exposes the public/internal boundary skeleton`, () => {
      expect(existsSync(resolve(REPO_ROOT, `src/modules/${id}/public.ts`))).toBe(true);
      for (const layer of LAYERS) {
        expect(
          existsSync(resolve(REPO_ROOT, `src/modules/${id}/${layer}/index.ts`)),
          `missing ${id}/${layer}/index.ts`,
        ).toBe(true);
      }
    });
  }

  test("module identities match spec/architecture.md §6 exactly (order included)", async () => {
    const { readFileSync } = await import("node:fs");
    const architecture = readFileSync(resolve(REPO_ROOT, "spec/architecture.md"), "utf8");
    const tableModules = [...architecture.matchAll(/^\| `\/([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(tableModules).toEqual([...ARCHITECTURE_MODULE_IDS]);
  });

  test("every public barrel exports its canonical module identity", async () => {
    for (const id of ARCHITECTURE_MODULE_IDS) {
      const barrel = await import(`../../src/modules/${id}/public`);
      expect(barrel.moduleDescriptor.id).toBe(id);
    }
  });

  test("the workflowos integration exposes its public barrel", async () => {
    const barrel = await import("../../src/integrations/workflowos/public");
    expect(barrel.integrationId).toBe("workflowos");
    expect(existsSync(resolve(REPO_ROOT, "src/integrations/workflowos/adapters/index.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(REPO_ROOT, "src/integrations/workflowos/internal/index.ts"))).toBe(
      true,
    );
  });
});
