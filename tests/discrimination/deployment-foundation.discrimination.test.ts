/**
 * Discrimination tests — the deployment foundation protections
 * (WORK-042, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every protection introduced by WORK-042 is mutation-proven: the
 * synthetic WEAKENED form of the repository/deployment state is
 * rejected fail-closed by the gate that owns it:
 *
 *  - secret plaintext ANYWHERE in the repository-resident manifests
 *    (the secret-scan) — a manifest carrying credential-shaped content
 *    is flagged;
 *  - the secret-reference model at evaluation time — plaintext in a
 *    reference variable and cross-environment references are rejected;
 *  - fail-closed authority — the authoritative dependency not ready
 *    makes the whole plane DOWN (a "healthy" report is unrepresentable);
 *  - the classification guard — a weakened persistent-environment
 *    teardown policy is rejected at manifest load (and the real tools
 *    refuse at runtime — the integration suite);
 *  - provider neutrality — infrastructure provider identifiers in
 *    DOMAIN module code are detected (the AC5 boundary: deployment
 *    configuration consumes provider-neutral ports; provider names
 *    live in the deployment seams only);
 *  - naming determinism — constraint violations are rejected;
 *  - identity integrity — a tampered identity does not recompute.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { scanManifestsForSecretPlaintext } from "../../deploy/lib";
import { evaluateEnvironmentContract } from "../../src/platform/deployment/env-contract";
import {
  deploymentIdentity,
  verifyDeploymentIdentity,
} from "../../src/platform/deployment/identity";
import {
  loadDeploymentManifest,
  MANIFEST_FILES,
  type ManifestFileReader,
} from "../../src/platform/deployment/manifest";
import { computeResourceName, previewBranchSlug } from "../../src/platform/deployment/naming";
import { evaluateReadiness } from "../../src/platform/deployment/readiness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

/** The provider-identifier boundary for infrastructure providers. */
const INFRASTRUCTURE_PROVIDER_IDENTIFIER = /\b(vercel|neon|upstash|cloudflare|r2)\b/i;

function collectModuleSources(): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(join(REPO_ROOT, "src", "modules"));
  return out;
}

describe("discrimination: secret plaintext in the manifests is unrepresentable", () => {
  test("the real manifest set scans clean", () => {
    expect(scanManifestsForSecretPlaintext(loadReal().sources)).toEqual([]);
  });

  test("a URL-with-password manifest content is flagged", () => {
    const violations = scanManifestsForSecretPlaintext({
      "environments.json": '{ "note": "connect via postgres://postgres:p4ss@db:5432/zeck" }',
    });
    expect(violations).toEqual([
      "environments.json: URL-embedded credentials (scheme://user:password@host)",
    ]);
  });

  test("a token literal in manifest content is flagged", () => {
    const violations = scanManifestsForSecretPlaintext({
      "providers.json": '{ "note": "use key sk-abcdefghijklmnop123456 for testing" }',
    });
    expect(violations).toEqual(["providers.json: OpenAI-style key literal"]);
  });

  test("a credential assignment in manifest content is flagged", () => {
    const violations = scanManifestsForSecretPlaintext({
      "secret-references.json": '{ "token": "supersecretvalue123" }',
    });
    expect(violations).toEqual([
      "secret-references.json: credential assignment (token/secret/password = value)",
    ]);
  });

  test("a GitHub token literal in manifest content is flagged", () => {
    const violations = scanManifestsForSecretPlaintext({
      "variables.json": '{ "note": "ghp_0123456789abcdefghijklmnopqrstuv was leaked once" }',
    });
    expect(violations).toEqual(["variables.json: GitHub token literal"]);
  });
});

describe("discrimination: the secret-reference model (runtime half)", () => {
  test("plaintext credential material in a reference variable is rejected (weakened: accepted)", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_SECRET_DATABASE_URL_REF: "postgres://postgres:secret@127.0.0.1:5432/zeck_local",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.materializedReferences).toEqual([]);
  });

  test("a production reference in a staging evaluation is rejected (environment isolation)", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "staging", {
      ZECK_ENVIRONMENT: "staging",
      ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://production/database-url",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join(" ")).toContain("environment isolation");
  });
});

describe("discrimination: fail-closed authority (a healthy report is unrepresentable)", () => {
  test("the authoritative dependency unavailable ⇒ DOWN, 503 — not ready, not degraded", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: [{ concern: "relational-state", status: "unavailable" }],
    });
    expect(report.overall).toBe("down");
    expect(report.overall).not.toBe("ready");
    expect(report.overall).not.toBe("degraded");
  });

  test("the weakened form (non-authoritative downgrade of the relational concern) is rejected at load", () => {
    const sources = new Map(MANIFEST_FILES.map((file) => [file, readRealSource(file)]));
    const providers = JSON.parse(sources.get("providers.json") ?? "{}") as {
      providers: Array<{
        id: string;
        authorityRole: string;
        degradation: { authority: string; onFailure: string };
      }>;
    };
    const neon = providers.providers.find((p) => p.id === "neon");
    if (neon === undefined) {
      throw new Error("synthetic mutation failed: neon provider missing");
    }
    neon.authorityRole = "bytes-only"; // weakened: PostgreSQL demoted
    neon.degradation.authority = "non-authoritative";
    neon.degradation.onFailure = "degraded";
    sources.set("providers.json", JSON.stringify(providers));
    const reader: ManifestFileReader = (file) => sources.get(file) ?? "{}";
    expect(() => loadDeploymentManifest(reader)).toThrow(
      /exactly one authoritative provider must exist|authoritative provider must own the relational-state concern/,
    );
  });
});

describe("discrimination: the classification guard (teardown policy)", () => {
  test("a weakened manifest (persistent environment allows teardown) is rejected at load", () => {
    const sources = new Map(MANIFEST_FILES.map((file) => [file, readRealSource(file)]));
    const environments = JSON.parse(sources.get("environments.json") ?? "{}") as {
      environments: Record<string, { teardownAllowed: boolean } | undefined>;
    };
    const production = environments.environments.production;
    if (production === undefined) {
      throw new Error("synthetic mutation failed: production environment missing");
    }
    production.teardownAllowed = true; // weakened
    sources.set("environments.json", JSON.stringify(environments));
    const reader: ManifestFileReader = (file) => sources.get(file) ?? "{}";
    expect(() => loadDeploymentManifest(reader)).toThrow(
      /persistent environment "production" must not allow teardown/,
    );
  });
});

describe("discrimination: provider neutrality of the domain tree (AC5)", () => {
  test("the real src/modules tree contains no infrastructure provider identifier", () => {
    const violations: string[] = [];
    for (const file of collectModuleSources()) {
      const text = readFileSync(file, "utf8");
      if (INFRASTRUCTURE_PROVIDER_IDENTIFIER.test(text)) {
        violations.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(violations).toEqual([]);
  });

  test("the scanner discriminates (a synthetic provider-named module file is detected)", () => {
    const synthetic = `
export function connectToNeon(connection: string): void {
  void connection; // a provider identifier ("neon") leaking into domain code
}
`;
    expect(INFRASTRUCTURE_PROVIDER_IDENTIFIER.test(synthetic)).toBe(true);
    expect(INFRASTRUCTURE_PROVIDER_IDENTIFIER.test("export const url = 'postgres://…'")).toBe(
      false,
    );
    expect(INFRASTRUCTURE_PROVIDER_IDENTIFIER.test("const provider = 'neon';")).toBe(true);
    expect(INFRASTRUCTURE_PROVIDER_IDENTIFIER.test("const bucket = 'r2';")).toBe(true);
  });

  test("the deployment seams ARE allowed to name providers (the boundary is one-directional)", () => {
    // Provider names live in the deployment CONFIGURATION DATA
    // (deploy/manifests) — and nowhere in domain code. The naming code
    // itself stays provider-neutral (kinds and constraints only).
    const providerManifest = readRealSource("providers.json");
    expect(/neon/i.test(providerManifest)).toBe(true);
    const resourcesManifest = readRealSource("resources.json");
    expect(/vercel|neon|upstash/i.test(resourcesManifest)).toBe(true);
    const namingCode = readFileSync(
      join(REPO_ROOT, "src", "platform", "deployment", "naming.ts"),
      "utf8",
    );
    expect(/vercel|neon|upstash|cloudflare/i.test(namingCode)).toBe(false);
  });
});

describe("discrimination: naming determinism (drift rejected)", () => {
  test("a constraint-violating computed name throws (a drifted name cannot pass silently)", () => {
    const manifest = loadReal();
    const resources = JSON.parse(manifest.sources["resources.json"]) as {
      naming: {
        prefix: string;
        previewBranchSlugMaxLength: number;
        kinds: Record<string, { suffix: string | null; maxLength: number; pattern: string }>;
      };
    };
    const conventions = resources.naming;
    const bucketRule = conventions.kinds["r2-bucket"];
    if (bucketRule === undefined) {
      throw new Error("synthetic mutation failed: r2-bucket kind missing");
    }
    const weakened = {
      ...conventions,
      kinds: {
        ...conventions.kinds,
        "r2-bucket": {
          suffix: `artifacts-${"x".repeat(50)}`,
          maxLength: bucketRule.maxLength,
          pattern: bucketRule.pattern,
        },
      },
    };
    expect(() => computeResourceName(weakened, "staging", "r2-bucket")).toThrow(
      /exceeds the provider constraint/,
    );
  });

  test("preview slug sanitation is deterministic (same branch ⇒ same slug, always)", () => {
    expect(previewBranchSlug("work/WORK-042-x", 24)).toBe(previewBranchSlug("work/WORK-042-x", 24));
    expect(previewBranchSlug("UPPER_CASE.Branch", 24)).toBe("upper-case-branch");
  });
});

describe("discrimination: identity integrity (tampering detected)", () => {
  test("a tampered identity id fails exact-revision verification", () => {
    const manifest = loadReal();
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const identity = deploymentIdentity(manifest, revision, "staging");
    const tampered = { ...identity, identityId: `0${identity.identityId.slice(1)}` };
    const result = verifyDeploymentIdentity(manifest, tampered, revision, "staging");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not recompute/);
  });
});

function readRealSource(file: string): string {
  return readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8");
}
