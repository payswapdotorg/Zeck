/**
 * Deployment identity (Deployment Roadmap D-01; D1.0 §15: "Production
 * deployment must be attributable to an exact Git commit").
 *
 * A deployment identity binds, deterministically and content-addressed:
 *
 * - the exact Git revision;
 * - the environment identity;
 * - the manifest digest (sha256 over the repository-resident manifest
 *   sources in canonical order);
 * - the computed resource set digest (sha256 over the deterministic
 *   resource names of that environment).
 *
 * The identity is PURE: no wall-clock, no random input. Two operators at
 * the same revision compute the identical identity id. The identity
 * document is the auditable deployment record consumed by CI, the smoke
 * tool and promotion evidence.
 */

import { createHash } from "node:crypto";
import type { DeploymentManifest } from "./manifest";
import type { EnvironmentId } from "./naming";
import { computeResourceNames } from "./naming";

export const DEPLOYMENT_IDENTITY_SCHEMA_VERSION = 1;

export interface DeploymentIdentityDocument {
  readonly schemaVersion: number;
  readonly identityId: string;
  readonly gitRevision: string;
  readonly environment: EnvironmentId;
  readonly manifestDigest: string;
  readonly resourceDigest: string;
  readonly resources: readonly {
    readonly id: string;
    readonly kind: string;
    readonly concern: string;
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
}

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** sha256 helper (hex). */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Digest over the manifest sources in canonical order. */
export function manifestDigest(manifest: DeploymentManifest): string {
  const canonical = Object.keys(manifest.sources)
    .sort()
    .map((file) => `${file}\n${manifest.sources[file as keyof typeof manifest.sources]}`)
    .join("\n---\n");
  return sha256(canonical);
}

/** Digest over an environment's computed resource set (deterministic order). */
export function resourceDigest(
  manifest: DeploymentManifest,
  environment: EnvironmentId,
  previewSlug?: string,
): string {
  const resources = computeResourceNames(
    namingConventionsOf(manifest),
    environment,
    manifest.resources[environment],
    previewSlug,
  );
  const lines = resources.map(
    (resource) => `${environment}\t${resource.kind}\t${resource.id ?? "-"}\t${resource.name}`,
  );
  return sha256(lines.join("\n"));
}

/** Extract the naming conventions from a loaded manifest. */
export function namingConventionsOf(manifest: DeploymentManifest): {
  prefix: string;
  previewBranchSlugMaxLength: number;
  kinds: Record<string, { suffix: string | null; maxLength: number; pattern: string }>;
} {
  const resources = JSON.parse(manifest.sources["resources.json"]) as {
    naming: {
      prefix: string;
      previewBranchSlugMaxLength?: number;
      kinds: Record<string, { suffix: string | null; maxLength: number; pattern: string }>;
    };
  };
  return {
    prefix: resources.naming.prefix,
    previewBranchSlugMaxLength: resources.naming.previewBranchSlugMaxLength ?? 24,
    kinds: resources.naming.kinds,
  };
}

/**
 * Compute the deterministic deployment identity document.
 *
 * @throws Error when the revision is not a 40-hex Git sha or the
 * environment is unknown (fail closed: identity is exact or absent).
 */
export function deploymentIdentity(
  manifest: DeploymentManifest,
  gitRevision: string,
  environment: EnvironmentId,
  previewSlug?: string,
): DeploymentIdentityDocument {
  if (!GIT_REVISION_PATTERN.test(gitRevision)) {
    throw new Error(
      `deployment identity requires an exact 40-hex Git revision (got: "${gitRevision}")`,
    );
  }
  const conventions = namingConventionsOf(manifest);
  const computed = computeResourceNames(
    conventions,
    environment,
    manifest.resources[environment],
    previewSlug,
  );
  const resources = manifest.resources[environment].map((resource, index) => {
    const name = computed[index]?.name ?? "";
    return {
      id: resource.id,
      kind: resource.kind,
      concern: resource.concern,
      name,
      labels: computed[index]?.labels ?? {},
    };
  });
  const digestOfManifest = manifestDigest(manifest);
  const digestOfResources = resourceDigest(manifest, environment, previewSlug);
  const identityId = sha256(
    [
      `zeck-deployment-identity-v${DEPLOYMENT_IDENTITY_SCHEMA_VERSION}`,
      gitRevision,
      environment,
      previewSlug ?? "-",
      digestOfManifest,
      digestOfResources,
    ].join("\n"),
  );
  return {
    schemaVersion: DEPLOYMENT_IDENTITY_SCHEMA_VERSION,
    identityId,
    gitRevision,
    environment,
    manifestDigest: digestOfManifest,
    resourceDigest: digestOfResources,
    resources,
  };
}

/**
 * Verify an identity document against the CURRENT manifest set and a
 * revision: recomputes and compares (exact-revision smoke verification).
 */
export function verifyDeploymentIdentity(
  manifest: DeploymentManifest,
  document: DeploymentIdentityDocument,
  expectedRevision: string,
  environment: EnvironmentId,
  previewSlug?: string,
): { readonly valid: boolean; readonly reason?: string } {
  if (document.gitRevision !== expectedRevision) {
    return {
      valid: false,
      reason: `identity revision ${document.gitRevision} does not match the expected revision ${expectedRevision}`,
    };
  }
  if (document.environment !== environment) {
    return {
      valid: false,
      reason: `identity environment ${document.environment} does not match ${environment}`,
    };
  }
  const recomputed = deploymentIdentity(manifest, expectedRevision, environment, previewSlug);
  if (recomputed.identityId !== document.identityId) {
    return {
      valid: false,
      reason: "identity id does not recompute at this revision/manifest state (drift or tampering)",
    };
  }
  return { valid: true };
}
