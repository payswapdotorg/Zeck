/**
 * Artifact application service (artifacts module; WORK-008 / CTX-002).
 *
 * Owns the write discipline on top of the content-addressed store:
 *  1. validate canonical content + shape (deterministic normalization);
 *  2. re-derive the digest from the CONTENT, never trust a caller-supplied
 *     digest (digest = identity is server-derived, like tenant scope);
 *  3. validate every parent reference against the CALLER's tenant namespace:
 *     present-and-owned -> lineage edge; owned by another tenant ->
 *     canonical `TENANT_SCOPE_VIOLATION` (adoption boundary); absent
 *     everywhere -> `POLICY_DENIED` dangling reference (zero writes);
 *  4. put-if-absent (the only mutation the substrate can perform).
 *
 * Reads are tenant-scoped; a digest that exists only under another tenant
 * raises `TENANT_SCOPE_VIOLATION` rather than an ambiguous miss.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  ArtifactDigest,
  ArtifactKind,
  ArtifactPutOutcome,
  ArtifactRecord,
  LineageDescription,
  SourceReference,
} from "../domain/artifact";
import { isArtifactDigest, normalizeParents, normalizeSourceRefs } from "../domain/artifact";
import { canonicalJson, isCanonicalizable } from "../domain/canonical";
import { byDigest, findUnsoundParent } from "../domain/lineage";
import type { ArtifactScope, ArtifactStore } from "../ports/artifact-store";
import type { DigestPort } from "../ports/digest";

/** The content an artifact covers — kind wrapper + canonical payload. */
export interface ArtifactContentInput {
  readonly kind: ArtifactKind;
  readonly payload: unknown;
  readonly sourceRefs: readonly SourceReference[];
  readonly parents?: readonly ArtifactDigest[];
}

export interface PutArtifactInput extends ArtifactScope, ArtifactContentInput {}

export interface ArtifactServiceDeps {
  readonly store: ArtifactStore;
  readonly digest: DigestPort;
  /**
   * Discrimination hook (WORK-005 precedent): serialization is injectable so
   * the reproducibility mutation record can prove digest stability lives in
   * CANONICAL serialization. Production default: `canonicalJson`.
   */
  readonly serialize?: (value: unknown) => string;
}

export interface ArtifactService {
  putArtifact(input: PutArtifactInput): Promise<ArtifactPutOutcome>;
  getArtifact(scope: ArtifactScope, digest: ArtifactDigest): Promise<ArtifactRecord>;
  describeLineage(scope: ArtifactScope, digest: ArtifactDigest): Promise<LineageDescription>;
}

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  const serialize = deps.serialize ?? canonicalJson;
  return {
    async putArtifact(input) {
      if (!isCanonicalizable(input.payload)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "artifact payload is not canonicalizable (closed JSON universe, integers only)",
          details: { kind: input.kind },
        });
      }
      const canonicalContent = serialize({ kind: input.kind, payload: input.payload });
      const digest = deps.digest.sha256Hex(canonicalContent);
      const parents = normalizeParents(input.parents ?? []);
      const sourceRefs = normalizeSourceRefs(input.sourceRefs);

      // Parent validation — the cross-tenant adoption boundary (CTX-002/004).
      for (const parent of parents) {
        const owned = await deps.store.get(input, parent);
        if (owned !== null) {
          continue; // present in the caller's namespace: legal lineage edge
        }
        const owners = await deps.store.ownerOf(parent);
        if (owners.length > 0) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: "parent artifact digest belongs to another tenant namespace",
            details: { digest: parent, ownerTenants: [...owners].sort() },
          });
        }
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "parent artifact digest does not exist (dangling lineage reference)",
          details: { digest: parent },
        });
      }

      return deps.store.put({
        tenantId: input.tenantId,
        kind: input.kind,
        canonicalContent,
        digest,
        sourceRefs,
        parents,
      });
    },

    async getArtifact(scope, digest) {
      const record = await deps.store.get(scope, digest);
      if (record !== null) {
        return record;
      }
      const owners = await deps.store.ownerOf(digest);
      if (owners.length > 0) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "artifact digest belongs to another tenant namespace",
          details: { digest, ownerTenants: [...owners].sort() },
        });
      }
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "artifact digest not found",
        details: { digest },
      });
    },

    async describeLineage(scope, digest) {
      const artifact = await this.getArtifact(scope, digest);
      const all = await deps.store.list(scope);
      const owned = new Map(all.map((record) => [record.digest, record]));
      const unsound = findUnsoundParent(artifact, owned);
      if (unsound !== undefined) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "lineage references a parent outside this tenant namespace",
          details: { digest: unsound },
        });
      }
      const parents = artifact.parents
        .map((parent) => owned.get(parent))
        .filter((record): record is ArtifactRecord => record !== undefined)
        .sort(byDigest);
      const children = all.filter((record) => record.parents.includes(digest)).sort(byDigest);
      return { artifact, parents, children };
    },
  };
}

/** Validate a caller-supplied digest string before any store interaction. */
export function requireArtifactDigest(value: string): ArtifactDigest {
  if (!isArtifactDigest(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "artifact digest must be 64 lowercase hex characters",
      details: { got: value },
    });
  }
  return value;
}
