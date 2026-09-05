/**
 * Unit tests — the environment contract evaluation (WORK-042 AC3/AC4).
 *
 * Proves over the REAL manifest: required variables are enforced;
 * `ZECK_SECRET_*_REF` variables accept ONLY environment-scoped
 * reference URIs (plaintext is rejected fail closed); cross-
 * environment references are rejected (production material is not
 * addressable from non-production); and the evaluation output NEVER
 * contains environment values (structural secret safety).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluateEnvironmentContract } from "../../../src/platform/deployment/env-contract";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

describe("the environment contract over the real manifest (AC3/AC4)", () => {
  test("local evaluates satisfied with the environment identity and a valid local reference", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://local/database-url",
    });
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.problems).toEqual([]);
    expect(evaluation.materializedReferences).toEqual([
      {
        reference: "zeck-secret://local/database-url",
        variable: "ZECK_SECRET_DATABASE_URL_REF",
        classification: "provider-credential",
      },
    ]);
  });

  test("staging evaluates satisfied when every staging reference is materialized", () => {
    const env: Record<string, string> = { ZECK_ENVIRONMENT: "staging" };
    for (const reference of loadReal().secretReferences.staging) {
      env[reference.variable] = `zeck-secret://staging/${reference.name}`;
    }
    const evaluation = evaluateEnvironmentContract(loadReal(), "staging", env);
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.materializedReferences).toHaveLength(8);
  });

  test("a missing required variable is reported", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {});
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain("ZECK_ENVIRONMENT is required");
  });

  test("an environment identity mismatch is reported", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "production",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain("environment identity mismatch");
  });
});

describe("secret-reference checks fail closed (AC4)", () => {
  test("plaintext credential material in a reference variable is rejected", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_SECRET_DATABASE_URL_REF: "postgres://postgres:supersecret@127.0.0.1:5432/zeck_local",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain(
      "a non-reference value (plaintext credential material) is rejected fail closed",
    );
    expect(evaluation.materializedReferences).toEqual([]);
  });

  test("a production-scoped reference is rejected for a non-production environment (AC3 isolation)", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "staging", {
      ZECK_ENVIRONMENT: "staging",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://production/database-url",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain(
      "staging cannot materialize production credentials (environment isolation)",
    );
  });

  test("a reference to an undeclared name is rejected", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://local/rogue-reference",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain('the local inventory declares "database-url"');
  });

  test("the evaluation output never contains environment values (structural safety)", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_SECRET_DATABASE_URL_REF: "postgres://postgres:supersecret@127.0.0.1:5432/zeck_local",
      ZECK_PG_ADMIN_URL: "postgres://postgres:anothersecret@127.0.0.1:55432/postgres",
      ZECK_TOKEN: "a-very-secret-bearer-token-value",
    });
    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("anothersecret");
    expect(serialized).not.toContain("a-very-secret-bearer-token-value");
    // Only reference URIs (non-secret by construction) appear.
    expect(serialized).not.toContain("postgres://");
  });
});
