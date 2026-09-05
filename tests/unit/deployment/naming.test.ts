/**
 * Unit tests — deterministic resource naming (WORK-042 AC2).
 *
 * Proves over the REAL manifest conventions: every environment's
 * resource set computes deterministic, constraint-valid names; the
 * preview branch identity sanitizes into the slug charset; local
 * PostgreSQL names are SQL-friendly; and naming drift (constraint
 * violations, non-preview branch identity) fails closed.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { namingConventionsOf } from "../../../src/platform/deployment/identity";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import {
  computeResourceName,
  computeResourceNames,
  previewBranchSlug,
  requiresPreviewSlug,
} from "../../../src/platform/deployment/naming";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

describe("deterministic naming over the real manifest (AC2)", () => {
  test("local resources compute SQL-friendly and filesystem-friendly names", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const names = computeResourceNames(conventions, "local", manifest.resources.local);
    expect(names.map((n) => `${n.kind}=${n.name}`).sort()).toEqual([
      "local-object-store=zeck-local-artifacts",
      "local-redis=zeck-local-redis",
      "pg-database=zeck_local",
    ]);
  });

  test("staging and production compute the full deterministic provider set", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const staging = computeResourceNames(conventions, "staging", manifest.resources.staging);
    expect(staging.map((n) => `${n.kind}=${n.name}`).sort()).toEqual([
      "cf-queue=zeck-staging-executions",
      "cf-workflow=zeck-staging-orchestration",
      "neon-branch=zeck-staging",
      "neon-project=zeck-staging",
      "r2-bucket=zeck-staging-artifacts",
      "upstash-redis=zeck-staging-redis",
      "vercel-project=zeck-staging",
    ]);
    const production = computeResourceNames(
      conventions,
      "production",
      manifest.resources.production,
    );
    expect(production.every((n) => n.name.startsWith("zeck-production"))).toBe(true);
  });

  test("preview names carry the sanitized branch slug deterministically", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const slug = previewBranchSlug(
      "work/WORK-042-deployment-infrastructure-foundation",
      conventions.previewBranchSlugMaxLength,
    );
    expect(slug).toBe("work-work-042-deployment");
    const names = computeResourceNames(conventions, "preview", manifest.resources.preview, slug);
    expect(names.map((n) => `${n.kind}=${n.name}`).sort()).toEqual([
      "cf-queue=zeck-preview-work-work-042-deployment-executions",
      "cf-workflow=zeck-preview-work-work-042-deployment-orchestration",
      "neon-branch=zeck-preview-work-work-042-deployment",
      "r2-bucket=zeck-preview-work-work-042-deployment-artifacts",
      "upstash-redis=zeck-preview-work-work-042-deployment-redis",
      "vercel-project=zeck-preview-work-work-042-deployment",
    ]);
  });

  test("branch slug sanitation collapses illegal characters deterministically", () => {
    expect(previewBranchSlug("Feature/BRANCH_NAME.42.x", 24)).toBe("feature-branch-name-42-x");
    expect(previewBranchSlug("---weird----branch---", 24)).toBe("weird-branch");
    expect(previewBranchSlug("UPPER", 24)).toBe("upper");
    expect(previewBranchSlug("a".repeat(60), 24)).toBe("a".repeat(24));
  });

  test("naming is pure: identical inputs produce identical outputs", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const first = computeResourceNames(conventions, "staging", manifest.resources.staging);
    const second = computeResourceNames(conventions, "staging", manifest.resources.staging);
    expect(first).toEqual(second);
  });

  test("environment ownership labels are deterministic", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const names = computeResourceNames(conventions, "production", manifest.resources.production);
    for (const name of names) {
      expect(name.labels["zeck.io/environment"]).toBe("production");
      expect(name.labels["zeck.io/managed-by"]).toBe("zeck-deploy");
    }
  });

  test("requiresPreviewSlug reflects the per-branch resource set", () => {
    const manifest = loadReal();
    expect(requiresPreviewSlug(manifest.resources.preview)).toBe(true);
    expect(requiresPreviewSlug(manifest.resources.staging)).toBe(false);
    expect(requiresPreviewSlug(manifest.resources.local)).toBe(false);
  });
});

describe("naming fails closed on drift", () => {
  test("an unknown kind is rejected", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    expect(() => computeResourceName(conventions, "staging", "mystery-kind")).toThrow(
      /unknown resource kind/,
    );
  });

  test("preview branch identity outside preview is rejected", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    expect(() => computeResourceName(conventions, "staging", "r2-bucket", "some-slug")).toThrow(
      /only valid for the preview environment/,
    );
  });

  test("a constraint-violating computed name is rejected (synthetic conventions)", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    const bucketRule = conventions.kinds["r2-bucket"];
    expect(bucketRule).toBeDefined();
    if (bucketRule === undefined) {
      return;
    }
    const weakened = {
      ...conventions,
      kinds: {
        ...conventions.kinds,
        "r2-bucket": {
          suffix: "artifacts",
          maxLength: 5,
          pattern: bucketRule.pattern,
        },
      },
    };
    expect(() => computeResourceName(weakened, "staging", "r2-bucket")).toThrow(
      /exceeds the provider constraint/,
    );
    const badCharset = {
      ...conventions,
      kinds: {
        ...conventions.kinds,
        "r2-bucket": { suffix: "artifacts", maxLength: 63, pattern: "^[0-9]+$" },
      },
    };
    expect(() => computeResourceName(badCharset, "staging", "r2-bucket")).toThrow(
      /charset constraint/,
    );
  });
});
