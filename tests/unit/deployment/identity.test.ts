/**
 * Unit tests — the deterministic deployment identity (WORK-042 AC7,
 * D1.0 §15).
 *
 * Proves: identity is pure (same revision ⇒ identical document, twice
 * and across reloads); identity is revision-, environment-, preview-
 * slug- and manifest-content-sensitive; invalid revisions fail
 * closed; and verification detects revision drift, environment drift
 * and identity tampering (exact-revision smoke verification).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  deploymentIdentity,
  manifestDigest,
  verifyDeploymentIdentity,
} from "../../../src/platform/deployment/identity";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

const REVISION_A = "0123456789abcdef0123456789abcdef01234567";
const REVISION_B = "fedcba9876543210fedcba9876543210fedcba98";

describe("the deployment identity is deterministic (AC7)", () => {
  test("the same inputs produce the identical document twice", () => {
    const manifest = loadReal();
    const first = deploymentIdentity(manifest, REVISION_A, "staging");
    const second = deploymentIdentity(manifest, REVISION_A, "staging");
    expect(first).toEqual(second);
    expect(first.identityId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("identity is stable across independent manifest loads", () => {
    const first = deploymentIdentity(loadReal(), REVISION_A, "local");
    const second = deploymentIdentity(loadReal(), REVISION_A, "local");
    expect(first.identityId).toBe(second.identityId);
    expect(first.resources).toEqual(second.resources);
  });

  test("identity carries the exact revision, digests and computed resource set", () => {
    const manifest = loadReal();
    const identity = deploymentIdentity(manifest, REVISION_A, "staging");
    expect(identity.gitRevision).toBe(REVISION_A);
    expect(identity.manifestDigest).toBe(manifestDigest(manifest));
    expect(identity.resourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.resources.every((r) => r.name.startsWith("zeck-staging"))).toBe(true);
  });
});

describe("identity sensitivity (a weakened identity would hide drift)", () => {
  test("revision changes change the identity", () => {
    const manifest = loadReal();
    const a = deploymentIdentity(manifest, REVISION_A, "staging");
    const b = deploymentIdentity(manifest, REVISION_B, "staging");
    expect(a.identityId).not.toBe(b.identityId);
    expect(a.resources).toEqual(b.resources); // same manifest ⇒ same resources
  });

  test("environment changes change the identity", () => {
    const manifest = loadReal();
    const staging = deploymentIdentity(manifest, REVISION_A, "staging");
    const production = deploymentIdentity(manifest, REVISION_A, "production");
    expect(staging.identityId).not.toBe(production.identityId);
  });

  test("preview branch identity changes change the identity", () => {
    const manifest = loadReal();
    const slugA = deploymentIdentity(manifest, REVISION_A, "preview", "branch-a");
    const slugB = deploymentIdentity(manifest, REVISION_A, "preview", "branch-b");
    expect(slugA.identityId).not.toBe(slugB.identityId);
  });

  test("manifest content changes change the identity", () => {
    const manifest = loadReal();
    const mutatedSources = { ...manifest.sources };
    const variables = JSON.parse(mutatedSources["variables.json"]) as {
      variables: Array<{ description: string }>;
    };
    const firstVariable = variables.variables[0];
    if (firstVariable === undefined) {
      throw new Error("synthetic mutation failed: variables manifest empty");
    }
    firstVariable.description = "mutated";
    mutatedSources["variables.json"] = JSON.stringify(variables);
    const mutated = { ...manifest, sources: mutatedSources };
    const original = deploymentIdentity(manifest, REVISION_A, "staging");
    const mutatedIdentity = deploymentIdentity(mutated, REVISION_A, "staging");
    expect(original.identityId).not.toBe(mutatedIdentity.identityId);
    expect(original.manifestDigest).not.toBe(mutatedIdentity.manifestDigest);
  });

  test("an invalid revision fails closed", () => {
    const manifest = loadReal();
    expect(() => deploymentIdentity(manifest, "short", "staging")).toThrow(/40-hex Git revision/);
    expect(() => deploymentIdentity(manifest, REVISION_A.slice(0, 39), "staging")).toThrow(
      /40-hex/,
    );
  });
});

describe("exact-revision identity verification (smoke verification contract)", () => {
  test("a genuine identity verifies against the same manifest and revision", () => {
    const manifest = loadReal();
    const identity = deploymentIdentity(manifest, REVISION_A, "staging");
    const result = verifyDeploymentIdentity(manifest, identity, REVISION_A, "staging");
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("a revision mismatch is detected with a reason", () => {
    const manifest = loadReal();
    const identity = deploymentIdentity(manifest, REVISION_A, "staging");
    const result = verifyDeploymentIdentity(manifest, identity, REVISION_B, "staging");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match the expected revision/);
  });

  test("an environment mismatch is detected with a reason", () => {
    const manifest = loadReal();
    const identity = deploymentIdentity(manifest, REVISION_A, "staging");
    const result = verifyDeploymentIdentity(manifest, identity, REVISION_A, "production");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  test("a tampered identity id does not recompute (drift/tampering detection)", () => {
    const manifest = loadReal();
    const identity = deploymentIdentity(manifest, REVISION_A, "staging");
    const tampered = {
      ...identity,
      identityId:
        identity.identityId.slice(0, 63) + (identity.identityId.endsWith("0") ? "1" : "0"),
    };
    const result = verifyDeploymentIdentity(manifest, tampered, REVISION_A, "staging");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not recompute/);
  });
});
