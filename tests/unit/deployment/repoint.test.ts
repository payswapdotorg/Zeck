/**
 * Unit tests — the repoint/rollback authority-invariance drill
 * (DEP-001 AC6: "Deployment can be rolled back/repointed without
 * changing domain authority").
 *
 * The drill proves, at the deployment-bootstrap seam:
 *  - the runtime identity document is HOSTING-INDEPENDENT: it carries
 *    no host/port/URL, so repointing delivery (or rolling a
 *    deployment back) cannot change it — two hosts at the same
 *    revision attest the identical identity;
 *  - the DOMAIN AUTHORITY mapping (concern → authority role →
 *    degradation posture) is manifest-declared and invariant under
 *    repoint: the delivery concern is delivery-only in both
 *    postures, and the authoritative relational concern is unchanged;
 *  - a ROLLBACK to a prior revision is an identity revision change,
 *    never an authority change: the provider topology and authority
 *    roles at the rolled-back revision are the same manifest truth;
 *  - repoint never promotes a secondary datastore (the outage
 *    posture preserves authority roles by construction).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { parseProviderTiers } from "../../../src/platform/deployment/provider-tiers";
import { providerOutagePosture } from "../../../src/platform/deployment/quota-fence";
import {
  providerTopologyOf,
  runtimeDeploymentIdentity,
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

const REVISION = "c".repeat(40);
const PRIOR_REVISION = "d".repeat(40);

describe("the identity document is hosting-independent (AC6)", () => {
  test("the runtime identity carries no hosting fields (no host/port/url keys anywhere)", () => {
    const document = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const forbiddenKeys = /host|^port$|url|endpoint|address/i;
    const collectKeys = (value: unknown, prefix: string, keys: string[]): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          collectKeys(entry, prefix, keys);
        }
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          keys.push(`${prefix}${key}`);
          collectKeys(inner, `${prefix}${key}.`, keys);
        }
      }
    };
    const keys: string[] = [];
    collectKeys(document, "", keys);
    const violations = keys.filter((key) => forbiddenKeys.test(key));
    expect(violations).toEqual([]);
  });

  test("two hosts at the same revision attest the identical identity (the repoint proof)", () => {
    const hostA = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const hostB = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    expect(hostA.runtimeIdentityId).toBe(hostB.runtimeIdentityId);
    expect(hostA.topologyDigest).toBe(hostB.topologyDigest);
  });
});

describe("repoint does not change domain authority (AC6)", () => {
  test("the delivery concern is delivery-only and never authoritative", () => {
    const topology = providerTopologyOf(manifest, ledger);
    const delivery = topology.find((entry) => entry.concern === "experience-delivery");
    expect(delivery?.provider).toBe("vercel");
    expect(delivery?.authorityRole).toBe("delivery-only");
  });

  test("the authority topology is identical across repointed hosts", () => {
    const hostA = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const hostB = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const authorityOf = (document: typeof hostA) =>
      document.providerTopology
        .filter((entry) => entry.authorityRole === "authoritative")
        .map((entry) => `${entry.concern}=${entry.authorityRole}`)
        .sort();
    expect(authorityOf(hostA)).toEqual(authorityOf(hostB));
    // PostgreSQL is the ONLY durable authority.
    expect(authorityOf(hostA)).toEqual(["relational-state=authoritative"]);
  });

  test("the delivery provider's outage posture never touches authority concerns", () => {
    const delivery = providerOutagePosture(manifest, "experience-delivery");
    const relational = providerOutagePosture(manifest, "relational-state");
    expect(delivery.onFailure).toBe("degraded");
    expect(delivery.authorityRole).toBe("non-authoritative");
    expect(relational.authorityRole).toBe("authoritative");
    expect(relational.onFailure).toBe("fail-closed");
  });
});

describe("rollback is a revision change, never an authority change (AC6)", () => {
  test("rolling back to a prior revision changes the identity id but not the authority mapping", () => {
    const current = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const rolledBack = runtimeDeploymentIdentity(manifest, ledger, PRIOR_REVISION, "staging");
    expect(current.runtimeIdentityId).not.toBe(rolledBack.runtimeIdentityId);
    expect(current.identity.gitRevision).toBe(REVISION);
    expect(rolledBack.identity.gitRevision).toBe(PRIOR_REVISION);
    // The authority mapping is the same manifest truth at both revisions.
    expect(
      rolledBack.providerTopology.map((entry) => `${entry.concern}=${entry.authorityRole}`),
    ).toEqual(current.providerTopology.map((entry) => `${entry.concern}=${entry.authorityRole}`));
    expect(rolledBack.topologyDigest).toBe(current.topologyDigest);
  });

  test("the rollback target's manifest digest equals the current manifest digest (same manifest truth)", () => {
    const current = runtimeDeploymentIdentity(manifest, ledger, REVISION, "staging");
    const rolledBack = runtimeDeploymentIdentity(manifest, ledger, PRIOR_REVISION, "staging");
    expect(rolledBack.identity.manifestDigest).toBe(current.identity.manifestDigest);
  });

  test("repoint never promotes a secondary datastore (authority roles are preserved by construction)", () => {
    for (const provider of manifest.providers) {
      const before = providerOutagePosture(manifest, provider.concern);
      // The typed literal makes promotion unrepresentable; the drill
      // pins that every concern keeps its manifest-declared role.
      expect(before.authorityPreserved).toBe(true);
      expect(before.authorityRole).toBe(provider.degradation.authority);
    }
  });
});
