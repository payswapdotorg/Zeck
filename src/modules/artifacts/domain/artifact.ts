/**
 * Artifact domain: content-addressed artifacts and their lineage
 * (artifacts module domain; WORK-008 / CTX-002; identity model corrected
 * by the issue #13 lineage-identity remediation).
 *
 * Identity model: an artifact's identifier IS the SHA-256 digest of its
 * canonical IDENTITY FORM — `{kind, payload, parents, sourceRefs}` with the
 * lineage fields in their deterministic normalized stored shape
 * (`digest = identity`). Lineage is IDENTITY-BEARING: identical payloads
 * with different provenance are DISTINCT artifacts, so convergence can
 * never silently lose parents or sourceRefs. Artifacts are immutable BY
 * CONSTRUCTION — the store surface offers put-if-absent only; there is no
 * update or delete path anywhere in the module (statically gated).
 *
 * Namespacing: content addressing is scoped per tenant — the store key is
 * `(tenantId, digest)`. Two tenants putting identical full inputs each
 * own their record; referencing a digest that exists only in ANOTHER
 * tenant's namespace is adoption and is rejected with the canonical
 * `TENANT_SCOPE_VIOLATION` (never silently copied, never silently 404).
 */

/** SHA-256 content digest, lowercase hex, 64 characters. */
export type ArtifactDigest = string & { readonly __artifactDigest: unique symbol };

/** Artifact content kinds this substrate stores (frozen vocabulary). */
export const ARTIFACT_KINDS = ["compiled-context", "source-document", "task-output"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Provenance vocabulary for source references (frozen). */
export const SOURCE_REF_KINDS = ["source", "request", "artifact"] as const;

export type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];

/**
 * A durable reference to where a piece of content came from. Every compiled
 * item carries at least one; artifacts preserve them for provenance (CTX-002).
 */
export interface SourceReference {
  readonly kind: SourceRefKind;
  /** Owning source/corpus identifier (or artifact digest for `artifact` refs). */
  readonly id: string;
  /** Stable locator inside the source (path, uri, offset — opaque to the store). */
  readonly locator: string;
}

/**
 * The canonical, digest-stable IDENTITY FORM of a stored artifact: the
 * digest is sha256 over the canonical serialization of exactly these
 * fields (lineage in its normalized stored shape — issue #13 remediation:
 * provenance is identity-bearing).
 */
export interface ArtifactContent {
  readonly kind: ArtifactKind;
  /** Canonical JSON value; MUST serialize byte-identically via `canonicalJson`. */
  readonly payload: Readonly<JsonCanonicalValue>;
  /** Normalized (sorted, deduped) parent digests — identity-bearing lineage. */
  readonly parents: readonly ArtifactDigest[];
  /** Normalized (sorted by canonical key, deduped) sources — identity-bearing provenance. */
  readonly sourceRefs: readonly SourceReference[];
}

/** The artifact record as persisted (store metadata aside, content is immutable). */
export interface ArtifactRecord {
  readonly tenantId: string;
  readonly digest: ArtifactDigest;
  readonly kind: ArtifactKind;
  /**
   * Canonical serialization of the IDENTITY FORM
   * `{kind, payload, parents, sourceRefs}` (exact bytes the digest covers).
   */
  readonly canonicalContent: string;
  readonly sourceRefs: readonly SourceReference[];
  /** Parent digests (lineage edges parent -> child). Sorted, unique, tenant-owned. */
  readonly parents: readonly ArtifactDigest[];
  readonly createdAt: string;
}

/** Input to `ArtifactStore.put` — put-if-absent only; no update path exists. */
export interface ArtifactPutInput {
  readonly tenantId: string;
  readonly kind: ArtifactKind;
  readonly canonicalContent: string;
  readonly digest: ArtifactDigest;
  readonly sourceRefs: readonly SourceReference[];
  readonly parents: readonly ArtifactDigest[];
}

/** Outcome of a put-if-absent: exactly one durable record ever exists per key. */
export type ArtifactPutOutcome =
  | { readonly status: "stored"; readonly digest: ArtifactDigest; readonly record: ArtifactRecord }
  | {
      readonly status: "converged";
      readonly digest: ArtifactDigest;
      readonly record: ArtifactRecord;
    };

/** Directed lineage edge parent -> child (both digests, tenant-scoped). */
export interface LineageEdge {
  readonly parent: ArtifactDigest;
  readonly child: ArtifactDigest;
}

/** Deterministic lineage description for one artifact. */
export interface LineageDescription {
  readonly artifact: ArtifactRecord;
  readonly parents: readonly ArtifactRecord[];
  readonly children: readonly ArtifactRecord[];
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** Structural check for a 64-hex sha256 digest. */
export function isArtifactDigest(value: string): value is ArtifactDigest {
  return HEX_64.test(value);
}

/** Deterministic (sorted, de-duplicated) parent list — the stored shape. */
export function normalizeParents(parents: readonly ArtifactDigest[]): ArtifactDigest[] {
  return [...new Set(parents)].sort();
}

/** Deterministic (sorted by canonical key, de-duplicated) source list. */
export function normalizeSourceRefs(refs: readonly SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  const out: SourceReference[] = [];
  for (const ref of [...refs].sort(bySourceRef)) {
    const key = `${ref.kind}\u0000${ref.id}\u0000${ref.locator}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

function bySourceRef(a: SourceReference, b: SourceReference): number {
  const ka = `${a.kind}\u0000${a.id}\u0000${a.locator}`;
  const kb = `${b.kind}\u0000${b.id}\u0000${b.locator}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/*
 * Canonical JSON value union (see domain/canonical.ts). Declared here so the
 * artifact content type is self-contained.
 */
export type JsonCanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonCanonicalValue[]
  | { readonly [key: string]: JsonCanonicalValue };
