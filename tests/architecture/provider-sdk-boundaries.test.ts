/**
 * Provider SDK boundary architecture test (WORK-001 acceptance criterion 4).
 *
 * The frozen architecture forbids provider SDK imports outside their owning
 * adapter module (`spec/architecture-lock.md` invariant 2,
 * `IMPLEMENTATION.md` §1). Today no SDK is a dependency at all, so `src/`
 * must contain zero SDK imports anywhere; once SDKs arrive with their owning
 * Work Orders, the boundary table in the rule engine decides where each SDK
 * may live. `tests/discrimination/` proves the table discriminates.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import {
  extractImportSpecifiers,
  PROVIDER_SDK_BOUNDARIES,
  packageNameOf,
  scanDependencyRules,
} from "./lib/dependency-rules";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("provider SDK boundaries", () => {
  const files = collectSourceFiles(REPO_ROOT);
  const allowedPackages = declaredRuntimePackages(REPO_ROOT);

  test("src/ contains zero provider SDK imports while none are declared", () => {
    const sdkImports = new Set<string>();
    for (const file of files) {
      for (const specifier of extractImportSpecifiers(file.content)) {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          specifier.startsWith("bun:")
        ) {
          continue;
        }
        sdkImports.add(packageNameOf(specifier));
      }
    }
    expect([...sdkImports].sort()).toEqual([]);
  });

  test("the SDK boundary table pins every known provider family to its owning adapter", () => {
    const owners = Object.fromEntries(
      PROVIDER_SDK_BOUNDARIES.map((boundary) => [
        boundary.packagePattern,
        boundary.allowedPathPrefix,
      ]),
    );
    expect(owners).toEqual({
      fastify: "src/api/",
      "@fastify/*": "src/api/",
      pg: "src/platform/db/",
      postgres: "src/platform/db/",
      "@neondatabase/*": "src/platform/db/",
      redis: "src/platform/redis/",
      ioredis: "src/platform/redis/",
      "@aws-sdk/*": "src/platform/object-store/",
      "@smithy/*": "src/platform/object-store/",
      minio: "src/platform/object-store/",
      openai: "src/modules/models/adapters/",
      "@anthropic-ai/*": "src/modules/models/adapters/",
      "@google/generative-ai": "src/modules/models/adapters/",
      "@google/genai": "src/modules/models/adapters/",
      "@mistralai/*": "src/modules/models/adapters/",
      "cohere-ai": "src/modules/models/adapters/",
      "groq-sdk": "src/modules/models/adapters/",
      "@azure/openai": "src/modules/models/adapters/",
      "@workflowos/*": "src/integrations/workflowos/adapters/",
    });
  });

  test("no provider-sdk-outside-adapter violations in the real tree", () => {
    const violations = scanDependencyRules(files, { allowedPackages }).filter(
      (v) => v.rule === "provider-sdk-outside-adapter",
    );
    expect(violations).toEqual([]);
  });

  test("governance check and this suite share one frozen module vocabulary", () => {
    // The Python governance gate validates spec↔IMPLEMENTATION.md sync; this
    // suite validates code↔spec sync. Both must read the same architecture.
    const lock = readFileSync(resolve(REPO_ROOT, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("No module depends directly on a provider SDK");
  });
});
