/**
 * Runtime deployment identity (DEP-001 AC2).
 *
 * "Exact deployment revision is discoverable and smoke-tested" — the
 * roadmap requires "an exact revision discoverable at runtime (a
 * /identity or equivalent smoke-verifiable surface: git SHA + provider
 * topology + manifest digest), so any deployed instance proves what
 * it is."
 *
 * The runtime document extends the pure deployment identity document
 * (src/platform/deployment/identity.ts — git revision + environment +
 * manifest digest + resource digest, content-addressed) with the
 * PROVIDER TOPOLOGY projection: every declared concern with its
 * provider, authority role, substitution target and the tier class
 * selected under the free-tier-first doctrine (provider-tiers.json).
 *
 * The topology is a pure projection of the manifest set: it is
 * authenticated by the manifest digest (providers.json and
 * provider-tiers.json are both digest inputs of the runtime id), so a
 * runtime document cannot claim a topology its manifests do not
 * declare. The runtime identity id is content-addressed over the
 * deployment identity id + the topology digest.
 *
 * HOSTING-INDEPENDENT BY CONSTRUCTION: the document carries no host,
 * port or URL — repointing delivery at another host (or rolling a
 * deployment back) cannot change it. The domain-authority mapping
 * (concern → authority role) is manifest-declared and invariant under
 * repoint (DEP-001 AC6).
 */

import { createHash } from "node:crypto";
import { type DeploymentIdentityDocument, deploymentIdentity, manifestDigest } from "./identity";
import type { DeploymentManifest } from "./manifest";
import type { EnvironmentId } from "./naming";
import type { ProviderTiersLedger } from "./provider-tiers";
import { tierOfProvider } from "./provider-tiers";

export const RUNTIME_IDENTITY_SCHEMA_VERSION = 1;

/** One concern's projection in the runtime identity document. */
export interface ProviderTopologyEntry {
  readonly concern: string;
  readonly provider: string;
  readonly authorityRole: string;
  readonly substitutionTarget: string;
  /** The tier class selected under the free-tier-first doctrine (DEP-001 AC4). */
  readonly tierClass: string;
  /** The selected tier's human name (e.g. "Neon Free"). */
  readonly tierName: string;
}

export interface RuntimeDeploymentIdentity {
  readonly schemaVersion: number;
  /** The runtime identity id (content-addressed: deployment id + topology digest). */
  readonly runtimeIdentityId: string;
  /** The pure deployment identity (unchanged semantics; see identity.ts). */
  readonly identity: DeploymentIdentityDocument;
  /** sha256 over the canonical provider-topology projection. */
  readonly topologyDigest: string;
  readonly providerTopology: readonly ProviderTopologyEntry[];
}

/** sha256 helper (hex). */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The canonical provider-topology projection of a manifest set + tier ledger. */
export function providerTopologyOf(
  manifest: DeploymentManifest,
  ledger: ProviderTiersLedger,
): readonly ProviderTopologyEntry[] {
  return manifest.providers.map((provider) => {
    const tier = tierOfProvider(ledger, provider.id);
    return {
      concern: provider.concern,
      provider: provider.id,
      authorityRole: provider.authorityRole,
      substitutionTarget: provider.substitutionTarget,
      tierClass: tier?.selectedTier.tierClass ?? "undeclared",
      tierName: tier?.selectedTier.tierName ?? "undeclared",
    };
  });
}

/** Digest over the canonical provider-topology lines (deterministic order). */
export function topologyDigest(topology: readonly ProviderTopologyEntry[]): string {
  const lines = topology.map(
    (entry) =>
      `${entry.concern}\t${entry.provider}\t${entry.authorityRole}\t${entry.substitutionTarget}\t${entry.tierClass}\t${entry.tierName}`,
  );
  return sha256(lines.join("\n"));
}

/**
 * Compute the runtime deployment identity document.
 *
 * @throws Error when the underlying deployment identity is invalid
 * (exact 40-hex revision or known environment — fail closed).
 */
export function runtimeDeploymentIdentity(
  manifest: DeploymentManifest,
  ledger: ProviderTiersLedger,
  gitRevision: string,
  environment: EnvironmentId,
  previewSlug?: string,
): RuntimeDeploymentIdentity {
  const identity = deploymentIdentity(manifest, gitRevision, environment, previewSlug);
  const topology = providerTopologyOf(manifest, ledger);
  const digestOfTopology = topologyDigest(topology);
  const runtimeIdentityId = sha256(
    [
      `zeck-runtime-identity-v${RUNTIME_IDENTITY_SCHEMA_VERSION}`,
      identity.identityId,
      digestOfTopology,
    ].join("\n"),
  );
  return {
    schemaVersion: RUNTIME_IDENTITY_SCHEMA_VERSION,
    runtimeIdentityId,
    identity,
    topologyDigest: digestOfTopology,
    providerTopology: topology,
  };
}

export interface RuntimeIdentityVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Verify a runtime identity document against the CURRENT manifest set
 * and tier ledger at an expected revision (exact-revision smoke
 * verification — the /identity attest).
 */
export function verifyRuntimeDeploymentIdentity(
  manifest: DeploymentManifest,
  ledger: ProviderTiersLedger,
  document: RuntimeDeploymentIdentity,
  expectedRevision: string,
  environment: EnvironmentId,
  previewSlug?: string,
): RuntimeIdentityVerification {
  if (document.schemaVersion !== RUNTIME_IDENTITY_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `runtime identity schema version ${document.schemaVersion} is not ${RUNTIME_IDENTITY_SCHEMA_VERSION}`,
    };
  }
  if (document.identity.gitRevision !== expectedRevision) {
    return {
      valid: false,
      reason: `identity revision ${document.identity.gitRevision} does not match the expected revision ${expectedRevision}`,
    };
  }
  if (document.identity.environment !== environment) {
    return {
      valid: false,
      reason: `identity environment ${document.identity.environment} does not match ${environment}`,
    };
  }
  // Content integrity: the document's own topology must recompute its
  // declared digest (a mutated topology with an inherited digest is
  // tampering, caught here).
  if (topologyDigest(document.providerTopology) !== document.topologyDigest) {
    return {
      valid: false,
      reason: "the declared topology digest does not match the document's provider topology",
    };
  }
  const recomputed = runtimeDeploymentIdentity(
    manifest,
    ledger,
    expectedRevision,
    environment,
    previewSlug,
  );
  if (recomputed.runtimeIdentityId !== document.runtimeIdentityId) {
    return {
      valid: false,
      reason:
        "runtime identity id does not recompute at this revision/manifest/tier state (drift or tampering)",
    };
  }
  if (recomputed.topologyDigest !== document.topologyDigest) {
    return {
      valid: false,
      reason:
        "the provider topology does not recompute against the current manifest/tier ledger (drift or tampering)",
    };
  }
  if (recomputed.identity.manifestDigest !== manifestDigest(manifest)) {
    return {
      valid: false,
      reason: "the manifest digest moved after the document was computed",
    };
  }
  return { valid: true };
}
