/**
 * Artifacts media-authority adapter (deployments module; WORK-026,
 * MOD-012 — the canonical artifact authority seam usage).
 *
 * Implements the deployments module's REQUIRED `MediaArtifactAuthority`
 * port against the REAL artifacts module public service (WORK-008 /
 * CTX-002: content-addressed, tenant-namespaced, immutable-by-
 * construction artifacts with identity-bearing lineage). The media
 * fabric's generated outputs and derived variants are adopted through
 * the authority's `putArtifact` seam:
 *
 *   - kind `task-output` (the frozen artifact vocabulary's generated-
 *     output kind — the deployments module owns no artifact kinds);
 *   - payload = the DETERMINISTIC NORMALIZED DESCRIPTOR (bounded
 *     canonical JSON: contentDigest + neutral metadata) — the media
 *     BYTES live in the content plane behind the digest reference;
 *     this adapter records and references, never transports bulk
 *     media (the "artifact references for large media" requirement);
 *   - parents = the lineage parent digests (source-input artifact →
 *     generated output → derived variant): lineage is IDENTITY-
 *     BEARING in the authority (a variant that dropped its lineage
 *     link is a DIFFERENT digest — the silent-lineage-loss mutant is
 *     unrepresentable, MOD-012's core);
 *   - sourceRefs = the execution + deployment provenance (identity-
 *     bearing: the artifact's digest covers the job's execution and
 *     deployment coordinates — "derived variants remain linked to
 *     source artifacts and deployment version");
 *   - put-if-absent: identical full inputs converge (true idempotency —
 *     the crash-resume adoption converges); a parent owned by another
 *     tenant raises the authority's TENANT_SCOPE_VIOLATION; a
 *     dangling parent raises POLICY_DENIED (zero writes).
 *
 * Type + runtime coupling is to the artifacts PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { ArtifactDigest, ArtifactService } from "../../artifacts/public";
import type {
  MediaArtifactAdoptionInput,
  MediaArtifactAdoptionOutcome,
  MediaArtifactAuthority,
} from "../ports/media-artifact-authority";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function requireArtifactDigest(value: string): ArtifactDigest {
  if (!DIGEST_PATTERN.test(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "artifact digest must be 64 lowercase hex characters",
      details: { got: value },
    });
  }
  return value as ArtifactDigest;
}

export function createMediaArtifactAuthorityAdapter(
  service: ArtifactService,
): MediaArtifactAuthority {
  return {
    async adoptArtifact(input: MediaArtifactAdoptionInput): Promise<MediaArtifactAdoptionOutcome> {
      const outcome = await service.putArtifact({
        tenantId: input.tenantId,
        kind: "task-output",
        payload: input.descriptor,
        parents: input.parents.map((parent) => requireArtifactDigest(parent)),
        sourceRefs: input.sourceRefs.map((ref) => ({
          kind: ref.kind,
          id: ref.id,
          locator: ref.locator,
        })),
      });
      return {
        digest: outcome.digest,
        converged: outcome.status === "converged",
      };
    },

    async artifactExists(scope: { readonly tenantId: string }, digest: string) {
      const artifactDigest = requireArtifactDigest(digest);
      try {
        await service.getArtifact({ tenantId: scope.tenantId }, artifactDigest);
        return true;
      } catch (error) {
        if (error instanceof PlatformError && error.code === "POLICY_DENIED") {
          // Absent from the caller's namespace AND from every other:
          // a plain miss (a foreign-tenant digest surfaces the
          // authority's TENANT_SCOPE_VIOLATION instead — the honest
          // tenant-isolation signal).
          return false;
        }
        throw error;
      }
    },
  };
}
