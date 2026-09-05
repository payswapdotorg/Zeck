/**
 * Unit tests — the deployment manifest contract (WORK-042).
 *
 * Proves over the REAL repository manifests: the four-environment
 * matrix with correct classes/teardown/promotion, the six-concern
 * provider map with fail-closed authority and explicit degradation,
 * the resource inventory with environment ownership, and the
 * secret-reference/variable cross-contract.
 *
 * Proves over SYNTHETIC mutations: the loader fails closed on a
 * missing manifest, an unknown schema version, a persistent
 * environment that allows teardown, a missing environment, an
 * undeclared resource kind, an unknown concern, and a variable/
 * secret-reference mismatch.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type DeploymentManifest,
  filesystemManifestReader,
  loadDeploymentManifest,
  MANIFEST_FILES,
  type ManifestFileName,
  type ManifestFileReader,
} from "../../../src/platform/deployment/manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function realReader(): ManifestFileReader {
  return (file) => readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8");
}

function readRepoManifest(file: ManifestFileName): string {
  return readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8");
}

/** Synthetic manifest set factory: the real sources, mutably cloned. */
function syntheticReader(): { reader: ManifestFileReader; sources: Map<ManifestFileName, string> } {
  const sources = new Map<ManifestFileName, string>();
  for (const file of MANIFEST_FILES) {
    sources.set(file, readRepoManifest(file));
  }
  return {
    reader: (file) => sources.get(file) ?? "{}",
    sources,
  };
}

describe("the real repository manifest set (WORK-042 D-01)", () => {
  test("loads and validates fail-closed", () => {
    expect(() => loadDeploymentManifest(realReader())).not.toThrow();
  });

  test("declares exactly the four D1.0 environment classes with correct policy", () => {
    const manifest = loadDeploymentManifest(realReader());
    expect(manifest.environments.map((e) => e.id)).toEqual([
      "local",
      "preview",
      "staging",
      "production",
    ]);
    const classes = Object.fromEntries(
      manifest.environments.map((e) => [e.id, e.environmentClass]),
    );
    expect(classes).toEqual({
      local: "disposable",
      preview: "disposable",
      staging: "persistent",
      production: "persistent",
    });
    const teardown = Object.fromEntries(
      manifest.environments.map((e) => [e.id, e.teardownAllowed]),
    );
    expect(teardown).toEqual({ local: true, preview: true, staging: false, production: false });
    expect(manifest.promotionOrder).toEqual(["local", "ci", "preview", "staging", "production"]);
  });

  test("maps every concern to a provider with an owning port and substitution target", () => {
    const manifest = loadDeploymentManifest(realReader());
    expect(manifest.providers).toHaveLength(6);
    for (const provider of manifest.providers) {
      expect(provider.substitutionTarget.length).toBeGreaterThan(0);
      expect(provider.degradation.mode.length).toBeGreaterThan(0);
      expect(provider.degradation.effect.length).toBeGreaterThan(0);
      if (provider.portStatus === "established") {
        expect(provider.portContract).not.toBeNull();
      } else {
        expect(provider.plannedPhase).not.toBeNull();
      }
    }
    const neon = manifest.providers.find((p) => p.id === "neon");
    expect(neon?.degradation.authority).toBe("authoritative");
    expect(neon?.degradation.onFailure).toBe("fail-closed");
    const planned = manifest.providers.filter((p) => p.portStatus === "planned");
    expect(planned.map((p) => p.plannedPhase).sort()).toEqual(["D-03", "D-04"]);
  });

  test("owns resources per environment with preview per-branch isolation", () => {
    const manifest = loadDeploymentManifest(realReader());
    expect(manifest.resources.local.map((r) => r.kind).sort()).toEqual([
      "local-object-store",
      "local-redis",
      "pg-database",
    ]);
    // Preview carries SIX per-branch resources (the Neon BRANCH is the
    // database resource; preview branches descend from the staging
    // project — resources.json previewBranching).
    expect(manifest.resources.preview.map((r) => r.concern).sort()).toEqual([
      "artifact-bytes",
      "async-transport",
      "durable-orchestration",
      "ephemeral-coordination",
      "experience-delivery",
      "relational-state",
    ]);
    for (const environment of ["staging", "production"] as const) {
      const concerns = manifest.resources[environment].map((r) => r.concern).sort();
      // Staging/production carry SEVEN resources: the Neon project and
      // its main branch are separate declared resources for the
      // relational concern (the branch is the environment mechanism).
      expect(concerns).toEqual([
        "artifact-bytes",
        "async-transport",
        "durable-orchestration",
        "ephemeral-coordination",
        "experience-delivery",
        "relational-state",
        "relational-state",
      ]);
    }
    for (const resource of manifest.resources.preview) {
      expect(resource.perBranch, `${resource.id} must be per-branch in preview`).toBe(true);
    }
    for (const environment of ["staging", "production"] as const) {
      for (const resource of manifest.resources[environment]) {
        expect(resource.perBranch).toBe(false);
      }
    }
  });

  test("scopes secret references per environment with one local reference", () => {
    const manifest = loadDeploymentManifest(realReader());
    expect(manifest.secretReferences.local.map((r) => r.name)).toEqual(["database-url"]);
    for (const environment of ["preview", "staging", "production"] as const) {
      expect(manifest.secretReferences[environment]).toHaveLength(8);
    }
    // Reference namespaces are environment-scoped by construction: the
    // same logical name exists per environment, but the URI namespace
    // differs (enforced at evaluation time — env-contract tests).
    const productionNames = manifest.secretReferences.production.map((r) => r.name).sort();
    const stagingNames = manifest.secretReferences.staging.map((r) => r.name).sort();
    expect(productionNames).toEqual(stagingNames);
  });

  test("cross-checks the variable contract against the secret-reference inventory", () => {
    const manifest = loadDeploymentManifest(realReader());
    const referenceVariables = new Set<string>();
    for (const list of Object.values(manifest.secretReferences)) {
      for (const reference of list) {
        referenceVariables.add(reference.variable);
      }
    }
    const declared = manifest.variables.filter((v) => v.name.startsWith("ZECK_SECRET_"));
    expect(declared.length).toBe(referenceVariables.size);
    for (const variable of declared) {
      expect(referenceVariables.has(variable.name)).toBe(true);
      expect(variable.credentialShaped).toBe(false);
    }
    expect(manifest.variables.find((v) => v.name === "ZECK_ENVIRONMENT")?.required).toBe(true);
  });
});

describe("the loader fails closed on synthetic mutations", () => {
  test("a missing manifest file is rejected", () => {
    expect(() =>
      loadDeploymentManifest(() => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/ENOENT/);
  });

  test("an unknown schema version is rejected", () => {
    const { reader, sources } = syntheticReader();
    sources.set(
      "environments.json",
      JSON.stringify({ ...JSON.parse(sources.get("environments.json") ?? "{}"), schemaVersion: 2 }),
    );
    expect(() => loadDeploymentManifest(reader)).toThrow(/schemaVersion/);
  });

  test("a persistent environment that allows teardown is rejected", () => {
    const { reader, sources } = syntheticReader();
    const environments = JSON.parse(sources.get("environments.json") ?? "{}") as {
      environments: Record<string, { teardownAllowed: boolean } | undefined>;
    };
    const staging = environments.environments.staging;
    if (staging === undefined) {
      throw new Error("synthetic mutation failed: staging environment missing");
    }
    staging.teardownAllowed = true;
    sources.set("environments.json", JSON.stringify(environments));
    expect(() => loadDeploymentManifest(reader)).toThrow(
      /persistent environment "staging".*teardown/,
    );
  });

  test("a missing environment class is rejected", () => {
    const { reader, sources } = syntheticReader();
    const environments = JSON.parse(sources.get("environments.json") ?? "{}") as {
      environments: Record<string, unknown>;
    };
    delete environments.environments.production;
    sources.set("environments.json", JSON.stringify(environments));
    expect(() => loadDeploymentManifest(reader)).toThrow(/missing environment "production"/);
  });

  test("an undeclared resource kind is rejected", () => {
    const { reader, sources } = syntheticReader();
    const resources = JSON.parse(sources.get("resources.json") ?? "{}") as {
      resources: { local: Array<Record<string, unknown>> };
    };
    resources.resources.local.push({
      id: "rogue",
      concern: "relational-state",
      kind: "mystery-kind",
    });
    sources.set("resources.json", JSON.stringify(resources));
    expect(() => loadDeploymentManifest(reader)).toThrow(/undeclared kind "mystery-kind"/);
  });

  test("a resource concern without an owning provider is rejected", () => {
    const { reader, sources } = syntheticReader();
    const resources = JSON.parse(sources.get("resources.json") ?? "{}") as {
      resources: { local: Array<{ id: string; concern: string; kind: string }> };
    };
    resources.resources.local.push({
      id: "rogue",
      concern: "quantum-teleport",
      kind: "pg-database",
    });
    sources.set("resources.json", JSON.stringify(resources));
    expect(() => loadDeploymentManifest(reader)).toThrow(/no owning provider/);
  });

  test("a per-branch resource outside preview is rejected", () => {
    const { reader, sources } = syntheticReader();
    const resources = JSON.parse(sources.get("resources.json") ?? "{}") as {
      resources: { staging: Array<Record<string, unknown>> };
    };
    const first = resources.resources.staging[0];
    if (first === undefined) {
      throw new Error("synthetic mutation failed: staging resources missing");
    }
    first.perBranch = true;
    sources.set("resources.json", JSON.stringify(resources));
    expect(() => loadDeploymentManifest(reader)).toThrow(
      /per-branch resources are only valid in preview/,
    );
  });

  test("an authoritative provider that does not fail closed is rejected", () => {
    const { reader, sources } = syntheticReader();
    const providers = JSON.parse(sources.get("providers.json") ?? "{}") as {
      providers: Array<{ id: string; degradation: { onFailure: string } }>;
    };
    const neon = providers.providers.find((p) => p.id === "neon");
    if (neon === undefined) {
      throw new Error("synthetic mutation failed: neon provider missing");
    }
    neon.degradation.onFailure = "degraded";
    sources.set("providers.json", JSON.stringify(providers));
    expect(() => loadDeploymentManifest(reader)).toThrow(/authoritative concern.*fail closed/);
  });

  test("a secret-reference variable absent from the variable contract is rejected", () => {
    const { reader, sources } = syntheticReader();
    const secrets = JSON.parse(sources.get("secret-references.json") ?? "{}") as {
      references: {
        local: Array<{
          name: string;
          classification: string;
          variable: string;
          description: string;
        }>;
      };
    };
    secrets.references.local.push({
      name: "rogue",
      classification: "provider-credential",
      variable: "ZECK_SECRET_ROGUE_REF",
      description: "rogue",
    });
    sources.set("secret-references.json", JSON.stringify(secrets));
    expect(() => loadDeploymentManifest(reader)).toThrow(
      /ZECK_SECRET_ROGUE_REF.*missing from the variable contract/,
    );
  });

  test("a secret-reference variable holding a non-REF name is rejected", () => {
    const { reader, sources } = syntheticReader();
    const variables = JSON.parse(sources.get("variables.json") ?? "{}") as {
      variables: Array<Record<string, unknown>>;
    };
    variables.variables.push({
      name: "ZECK_SECRET_PLAINTEXT",
      type: "string",
      required: false,
      credentialShaped: false,
      description: "weakened: a secret-family variable without _REF",
    });
    sources.set("variables.json", JSON.stringify(variables));
    expect(() => loadDeploymentManifest(reader)).toThrow(/must end with _REF/);
  });

  test("the filesystem reader loads the real tree and fails closed on absent roots", () => {
    const manifest: DeploymentManifest = loadDeploymentManifest(
      filesystemManifestReader(REPO_ROOT),
    );
    expect(manifest.environments).toHaveLength(4);
    const empty = mkdtempSync(join(tmpdir(), "zeck-manifest-"));
    expect(() => loadDeploymentManifest(filesystemManifestReader(empty))).toThrow();
    writeFileSync(join(empty, "environments.json"), "{}");
    expect(() => loadDeploymentManifest(filesystemManifestReader(empty))).toThrow();
  });
});
