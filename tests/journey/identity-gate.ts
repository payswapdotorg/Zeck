/**
 * PPR-003 — the fail-closed identity preflight (the whole-run gate).
 *
 * BEFORE any journey asserts anything, the harness attests the target
 * plane's deployed identity at the EXPECTED EXACT REVISION and
 * verifies it against the repository's own recomputation — the same
 * authority the deploy/ chain uses (deploy/plane-identity.ts
 * attestDeployedPlane + verifyRuntimeDeploymentIdentity). Drift, a
 * wrong revision, an unreachable plane or a tampered manifest REFUSES
 * THE WHOLE RUN (fail-closed, never a warning): every journey step is
 * recorded not-run with the refusal as the reason.
 *
 * NO new authority: the manifest set, the tier ledger and the
 * verification decision all come from the repository's existing
 * modules. The harness is run from a checkout of the EXPECTED revision
 * (the same contract as deploy/public-smoke.ts --url: the expected
 * revision defaults to this checkout's exact HEAD).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitRevision, loadManifest, REPOSITORY_ROOT } from "../../deploy/lib";
import { attestDeployedPlane } from "../../deploy/plane-identity";
import type { EnvironmentId } from "../../src/platform/deployment/naming";
import { parseProviderTiers } from "../../src/platform/deployment/provider-tiers";
import type { IdentityGateOutcome } from "./types";

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Resolve the expected exact revision: an explicit override (the
 * work-order contract: the Lead points the harness at the deployed
 * URL + the EXACT revision) or this checkout's HEAD (the public-smoke
 * contract). A malformed override is a hard preflight refusal.
 */
export function expectedRevisionOf(override: string | undefined): {
  readonly revision: string;
  readonly error?: string;
} {
  const trimmed = override?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    if (!GIT_REVISION_PATTERN.test(trimmed)) {
      return {
        revision: "",
        error: `the expected revision must be an exact 40-hex Git sha (got: "${trimmed}")`,
      };
    }
    return { revision: trimmed };
  }
  return { revision: gitRevision() };
}

/**
 * THE IDENTITY GATE: attest the deployed plane at the exact revision.
 * Fail-closed semantics identical to the deploy chain: any transport
 * failure, schema drift, revision mismatch or recomputation failure
 * refuses the run.
 */
export async function identityGate(
  targetUrl: string,
  expectedRevision: string,
  environment: EnvironmentId,
): Promise<IdentityGateOutcome> {
  const manifest = loadManifest();
  const ledger = parseProviderTiers(
    readFileSync(resolve(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
    manifest,
  );
  const attestation = await attestDeployedPlane(targetUrl, {
    revision: expectedRevision,
    environment,
    manifest,
    ledger,
  });
  if (!attestation.verified) {
    return {
      verified: false,
      reason: attestation.reason ?? "identity verification failed",
      planeUrl: targetUrl,
      expectedRevision,
    };
  }
  return {
    verified: true,
    planeUrl: targetUrl,
    expectedRevision,
    attested: attestation.attested,
  };
}

/** The repository root (repo-side matrix facts resolve against it). */
export function harnessRepositoryRoot(): string {
  return REPOSITORY_ROOT;
}
