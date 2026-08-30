/**
 * Lineage graph assembly (artifacts module domain; WORK-008 / CTX-002).
 *
 * Lineage edges are parent -> child digests carried ON the child artifact
 * record. The graph is a DAG by construction: a child's digest covers its
 * (sorted) parent digests, so a cycle would require a SHA-256 collision.
 * Assembly here validates parent existence/ownership and produces
 * deterministic (digest-sorted) descriptions.
 */

import type { ArtifactDigest, ArtifactRecord, LineageEdge } from "./artifact";

/** Extract the edge set from a child record (deterministic, already sorted). */
export function edgesOf(record: ArtifactRecord): LineageEdge[] {
  return record.parents.map((parent) => ({ parent, child: record.digest }));
}

/**
 * Validate that every parent of `record` is present and owned by the same
 * tenant in `owned` (digest -> record). Returns the offending parent digest
 * when validation fails; `undefined` when the lineage is sound.
 */
export function findUnsoundParent(
  record: ArtifactRecord,
  owned: ReadonlyMap<ArtifactDigest, ArtifactRecord>,
): ArtifactDigest | undefined {
  for (const parent of record.parents) {
    const existing = owned.get(parent);
    if (existing === undefined || existing.tenantId !== record.tenantId) {
      return parent;
    }
  }
  return undefined;
}

/** Deterministic ordering key for lineage listings (digest asc). */
export function byDigest(a: ArtifactRecord, b: ArtifactRecord): number {
  return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
}
