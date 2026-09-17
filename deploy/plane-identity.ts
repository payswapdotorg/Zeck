/**
 * deploy/plane-identity — the deployed-plane identity attestation core
 * (DEP-003 AC4: "The promote path verifies deployment identity before
 * promotion and re-attests on rollback").
 *
 * The exact-revision runtime attestation (DEP-001: Git SHA + manifest
 * digest + provider topology, GET /identity) becomes an INPUT of the
 * promotion chain here: the operator surfaces fetch the DEPLOYED
 * plane's identity document over real HTTP and verify it against the
 * candidate revision's recomputed identity — drift, tampering, wrong
 * revision or an unreachable plane REFUSE the promotion (fail closed,
 * never a warning).
 *
 * Consumers:
 *  - deploy/public-smoke.ts --url <baseUrl> (the production smoke of a
 *    deployed plane; AC1's wrong-revision/unreachable negatives);
 *  - deploy/release.ts promote --plane-url (verify BEFORE promotion);
 *  - deploy/release.ts rollback --plane-url (re-attest the target
 *    revision after the governed pointer flip — the re-attestation
 *    never touches domain authority: the identity document is
 *    hosting-independent and the provider topology is manifest-declared);
 *  - deploy/release.ts gate run identity-audit --plane-url (the live
 *    plane verification joins the recorded-binding verification as
 *    gate evidence).
 *
 * Every fetch is a REAL HTTP round trip against a real plane process;
 * there is no mocked transport on this path.
 */

import type { RuntimeIdentityWire } from "../src/api/routes/identity";
import type { DeploymentManifest } from "../src/platform/deployment/manifest";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import type { ProviderTiersLedger } from "../src/platform/deployment/provider-tiers";
import {
  providerTopologyOf,
  type RuntimeDeploymentIdentity,
  verifyRuntimeDeploymentIdentity,
} from "../src/platform/deployment/runtime-identity";

/** The identity-attestation outcome for one deployed plane. */
export interface PlaneAttestation {
  /** True only when the plane answered AND its identity recomputes at the expected revision. */
  readonly verified: boolean;
  /** Fail-closed reason (present when verified is false). */
  readonly reason?: string;
  readonly planeUrl?: string;
  readonly expectedRevision?: string;
  /** The plane's attested document facts (present when the plane answered 200). */
  readonly attested?: {
    readonly runtimeIdentityId: string;
    readonly gitRevision: string;
    readonly manifestDigest: string;
    readonly topologyDigest: string;
    readonly environment: string;
  };
}

/** The wire document (transport view) as the platform verification document. */
export function wireToRuntimeDocument(wire: RuntimeIdentityWire): RuntimeDeploymentIdentity {
  return {
    schemaVersion: wire.schemaVersion,
    runtimeIdentityId: wire.runtimeIdentityId,
    identity: {
      schemaVersion: wire.identity.schemaVersion,
      identityId: wire.identity.identityId,
      gitRevision: wire.identity.gitRevision,
      // The wire carries the environment as a string; verification
      // checks it against the expected environment immediately.
      environment: wire.identity.environment as EnvironmentId,
      manifestDigest: wire.identity.manifestDigest,
      resourceDigest: wire.identity.resourceDigest,
      // verify recomputes resources from the manifest; the wire
      // projection omits them (transport view).
      resources: [],
    },
    topologyDigest: wire.topologyDigest,
    providerTopology: wire.providerTopology,
  };
}

/** Fetch the deployed plane's identity document over real HTTP (fail closed). */
export async function fetchPlaneIdentityDocument(
  baseUrl: string,
  options?: { readonly timeoutMs?: number },
): Promise<RuntimeIdentityWire> {
  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL("/identity", baseUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `the deployed plane at ${baseUrl} is unreachable (fail closed): ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) {
    const body = (await response.text()).slice(0, 160);
    throw new Error(
      `GET /identity of the plane at ${baseUrl} answered ${response.status} (expected 200 bound): ${body}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    throw new Error(
      `GET /identity of the plane at ${baseUrl} did not return a JSON document: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`GET /identity of the plane at ${baseUrl} did not return a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const identity = record.identity;
  if (
    typeof record.runtimeIdentityId !== "string" ||
    typeof record.topologyDigest !== "string" ||
    !Array.isArray(record.providerTopology) ||
    typeof identity !== "object" ||
    identity === null
  ) {
    throw new Error(
      `GET /identity of the plane at ${baseUrl} did not return a runtime identity document (schema drift)`,
    );
  }
  return record as unknown as RuntimeIdentityWire;
}

export interface PlaneAttestationOptions {
  /** The exact revision the plane must attest (the candidate revision). */
  readonly revision: string;
  readonly environment: EnvironmentId;
  readonly previewSlug?: string;
  readonly manifest: DeploymentManifest;
  readonly ledger: ProviderTiersLedger;
  readonly timeoutMs?: number;
}

/**
 * Attest a deployed plane at an exact revision: fetch its identity
 * document over real HTTP, then verify the document against the
 * CURRENT manifest set + tier ledger (the recomputation catches drift
 * and tampering; the revision equality catches a wrong-revision plane).
 *
 * Fail closed: any transport failure, schema drift, revision mismatch
 * or recomputation failure returns { verified: false, reason } — never
 * a warning, never a partial pass.
 */
export async function attestDeployedPlane(
  baseUrl: string,
  options: PlaneAttestationOptions,
): Promise<PlaneAttestation> {
  let wire: RuntimeIdentityWire;
  try {
    wire = await fetchPlaneIdentityDocument(baseUrl, { timeoutMs: options.timeoutMs });
  } catch (error) {
    return {
      verified: false,
      reason: (error as Error).message,
      planeUrl: baseUrl,
      expectedRevision: options.revision,
    };
  }
  const document = wireToRuntimeDocument(wire);
  const verification = verifyRuntimeDeploymentIdentity(
    options.manifest,
    options.ledger,
    document,
    options.revision,
    options.environment,
    options.previewSlug,
  );
  if (!verification.valid) {
    return {
      verified: false,
      reason: verification.reason ?? "identity verification failed",
      planeUrl: baseUrl,
      expectedRevision: options.revision,
      attested: {
        runtimeIdentityId: wire.runtimeIdentityId,
        gitRevision: wire.identity.gitRevision,
        manifestDigest: wire.identity.manifestDigest,
        topologyDigest: wire.topologyDigest,
        environment: wire.identity.environment,
      },
    };
  }
  // The topology cross-check: every manifest-declared concern must
  // appear in the plane's projection with the same provider, authority
  // role and tier class (a plane claiming a different domain-authority
  // mapping than the manifest declares is a tampered plane).
  const topology = providerTopologyOf(options.manifest, options.ledger);
  for (const expectedEntry of topology) {
    const wireEntry = wire.providerTopology.find(
      (entry) => entry.concern === expectedEntry.concern,
    );
    if (
      wireEntry === undefined ||
      wireEntry.provider !== expectedEntry.provider ||
      wireEntry.authorityRole !== expectedEntry.authorityRole ||
      wireEntry.tierClass !== expectedEntry.tierClass
    ) {
      return {
        verified: false,
        reason: `the plane's provider topology entry for "${expectedEntry.concern}" disagrees with the manifest/tier ledger`,
        planeUrl: baseUrl,
        expectedRevision: options.revision,
      };
    }
  }
  return {
    verified: true,
    planeUrl: baseUrl,
    expectedRevision: options.revision,
    attested: {
      runtimeIdentityId: wire.runtimeIdentityId,
      gitRevision: wire.identity.gitRevision,
      manifestDigest: wire.identity.manifestDigest,
      topologyDigest: wire.topologyDigest,
      environment: wire.identity.environment,
    },
  };
}

// ---------------------------------------------------------------------------
// The promotion/rollback identity guards (pure decisions)
// ---------------------------------------------------------------------------

export interface IdentityGuardDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** The verification summary recorded in the promotion journal. */
  readonly evidence?: string;
}

/**
 * The PROMOTE-path identity guard (DEP-003 AC4): a configured plane
 * must be VERIFIED at the candidate revision before promotion. A null
 * attestation means no plane URL was configured — the recorded
 * identity-audit gate evidence (the ledger binding) remains the
 * identity authority for that path, so the guard notes the absence
 * honestly instead of fabricating a verification.
 */
export function promotionIdentityGuard(
  attestation: PlaneAttestation | null,
  candidateRevision: string,
): IdentityGuardDecision {
  if (attestation === null) {
    return {
      allowed: true,
      reason:
        "no plane URL configured: the deployment-identity-audit gate evidence (the recorded ledger binding) is the identity authority for this promotion",
    };
  }
  if (!attestation.verified) {
    return {
      allowed: false,
      reason: `deployment identity verification failed before promotion: ${attestation.reason ?? "unverified plane"}`,
    };
  }
  if (attestation.attested?.gitRevision !== candidateRevision) {
    return {
      allowed: false,
      reason: `the deployed plane attests revision ${attestation.attested?.gitRevision ?? "?"} but the candidate revision is ${candidateRevision}`,
    };
  }
  return {
    allowed: true,
    evidence: `plane ${attestation.planeUrl} attested revision ${attestation.attested?.gitRevision.slice(0, 12)} (runtime identity ${attestation.attested?.runtimeIdentityId.slice(0, 16)}, manifest digest ${attestation.attested?.manifestDigest.slice(0, 12)}, topology digest ${attestation.attested?.topologyDigest.slice(0, 12)})`,
  };
}

/**
 * The ROLLBACK-path re-attestation decision (DEP-003 AC4): after the
 * governed pointer flip, the plane must attest the TARGET release's
 * revision (the operator repoints the plane, then re-attests — the
 * re-attestation proves the repoint landed and never touches domain
 * authority: the identity document is hosting-independent and the
 * provider topology is manifest-declared, invariant under repoint).
 */
export function rollbackReattestation(
  attestation: PlaneAttestation,
  targetRevision: string,
): IdentityGuardDecision {
  if (!attestation.verified) {
    return {
      allowed: false,
      reason: `post-rollback re-attestation failed: ${attestation.reason ?? "unverified plane"} (repoint the plane at the target release and re-run)`,
    };
  }
  if (attestation.attested?.gitRevision !== targetRevision) {
    return {
      allowed: false,
      reason: `the plane attests revision ${attestation.attested?.gitRevision ?? "?"} but the rollback target is ${targetRevision} (the plane is not yet repointed at the target release; repoint it and re-run the rollback re-attestation)`,
    };
  }
  return {
    allowed: true,
    evidence: `plane ${attestation.planeUrl} re-attested the rollback target revision ${targetRevision.slice(0, 12)} (runtime identity ${attestation.attested?.runtimeIdentityId.slice(0, 16)})`,
  };
}
