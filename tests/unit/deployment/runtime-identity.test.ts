/**
 * Unit tests — the runtime deployment identity (DEP-001 AC2: "Exact
 * deployment revision is discoverable and smoke-tested").
 *
 * Proves over the REAL manifest set + ledger:
 *  - the runtime document is DETERMINISTIC (same inputs ⇒ identical
 *    ids) and content-addressed (different revision/manifest/topology
 *    ⇒ different id);
 *  - the provider topology projection equals the providers.json
 *    concern map with the tier-ledger classes;
 *  - verification passes at the exact revision and fails on revision
 *    drift, environment drift and tampering (a mutated document does
 *    not recompute);
 *  - an invalid revision (not 40-hex) is rejected fail closed.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { parseProviderTiers } from "../../../src/platform/deployment/provider-tiers";
import {
  providerTopologyOf,
  runtimeDeploymentIdentity,
  topologyDigest,
  verifyRuntimeDeploymentIdentity,
} from "../../../src/platform/deployment/runtime-identity";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

const manifest = loadReal();
const ledger = parseProviderTiers(
  readFileSync(join(REPO_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
  manifest,
);

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);

describe("the runtime deployment identity document (DEP-001 AC2)", () => {
  test("is deterministic: identical inputs recompute the identical document", () => {
    const first = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const second = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    expect(first).toEqual(second);
  });

  test("is content-addressed: a different revision changes the id", () => {
    const first = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const second = runtimeDeploymentIdentity(manifest, ledger, OTHER_REVISION, "staging");
    expect(first.runtimeIdentityId).not.toBe(second.runtimeIdentityId);
    expect(first.identity.gitRevision).toBe(REVISION);
  });

  test("is content-addressed: a different environment changes the id", () => {
    const staging = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const production = runtimeDeploymentIdentity(manifest, ledger, REVISION, "production");
    expect(staging.runtimeIdentityId).not.toBe(production.runtimeIdentityId);
  });

  test("carries the deployment identity plus the provider topology projection", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    expect(document.identity.gitRevision).toBe(REVISION);
    expect(document.identity.manifestDigest).toHaveLength(64);
    expect(document.identity.resourceDigest).toHaveLength(64);
    expect(document.topologyDigest).toHaveLength(64);
    const concerns = document.providerTopology.map((entry) => entry.concern);
    expect(concerns).toEqual(manifest.providers.map((provider) => provider.concern));
  });

  test("the topology projection carries the tier classes from the ledger", () => {
    const topology = providerTopologyOf(manifest, ledger);
    const neon = topology.find((entry) => entry.provider === "neon");
    expect(neon?.tierClass).toBe("provider-free-tier");
    expect(neon?.tierName).toBe("Neon Free");
    const queues = topology.find((entry) => entry.provider === "cloudflare-queues");
    expect(queues?.tierClass).toBe("usage-based-no-minimum");
    expect(queues?.authorityRole).toBe("non-authoritative");
  });

  test("the topology digest is order- and content-sensitive", () => {
    const topology = providerTopologyOf(manifest, ledger);
    expect(topologyDigest(topology)).not.toBe(topologyDigest([...topology].reverse()));
    const mutated = topology.map((entry) =>
      entry.provider === "neon" ? { ...entry, tierClass: "paid-where-required" } : entry,
    );
    expect(topologyDigest(mutated)).not.toBe(topologyDigest(topology));
  });

  test("a preview slug changes the runtime id (per-branch identity)", () => {
    const plain = runtimeDeploymentIdentity(manifest, ledger, REVISION, "preview");
    const branched = runtimeDeploymentIdentity(manifest, ledger, REVISION, "preview", "dep-001-x");
    expect(plain.runtimeIdentityId).not.toBe(branched.runtimeIdentityId);
  });
});

describe("runtime identity verification (the smoke attest)", () => {
  test("passes at the exact revision and fails on revision drift", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    expect(
      verifyRuntimeDeploymentIdentity(manifest, ledger, document, REVISION, "staging").valid,
    ).toBe(true);
    const drifted = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      document,
      OTHER_REVISION,
      "staging",
    );
    expect(drifted.valid).toBe(false);
    expect(drifted.reason).toContain("does not match the expected revision");
  });

  test("fails on environment drift", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const drifted = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      document,
      REVISION,
      "production",
    );
    expect(drifted.valid).toBe(false);
    expect(drifted.reason).toContain("does not match production");
  });

  test("fails on tampering (a mutated topology does not recompute)", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const tampered = {
      ...document,
      providerTopology: document.providerTopology.map((entry) =>
        entry.provider === "neon" ? { ...entry, tierClass: "paid-where-required" } : entry,
      ),
    };
    const verification = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      tampered,
      REVISION,
      "staging",
    );
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("topology digest does not match");
  });

  test("fails on schema-version drift", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const verification = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      { ...document, schemaVersion: document.schemaVersion + 1 },
      REVISION,
      "staging",
    );
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("schema version");
  });

  test("a non-40-hex revision is rejected fail closed", () => {
    expect(() => runtimeDeploymentIdentity(manifest, ledger, "not-a-sha", "staging")).toThrow(
      "exact 40-hex Git revision",
    );
  });
});
