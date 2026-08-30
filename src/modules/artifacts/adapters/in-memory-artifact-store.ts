/**
 * In-memory content-addressed artifact store (artifacts module adapter;
 * WORK-008 default).
 *
 * Keyed by `(tenantId, digest)`; `put` is put-if-absent over a synchronous
 * Map transition (atomic within the JS turn, so concurrent identical puts
 * converge to one record). No update/delete code exists in this file —
 * immutability by construction, statically gated.
 */

import type {
  ArtifactDigest,
  ArtifactPutInput,
  ArtifactPutOutcome,
  ArtifactRecord,
} from "../domain/artifact";
import { byDigest } from "../domain/lineage";
import type { ArtifactScope, ArtifactStore } from "../ports/artifact-store";

export function createInMemoryArtifactStore(): ArtifactStore & {
  /** Test/inspection helper: record count across all tenant namespaces. */
  readonly totalRecords: number;
} {
  const byKey = new Map<string, ArtifactRecord>();
  const key = (tenantId: string, digest: ArtifactDigest): string => `${tenantId}\u0000${digest}`;

  return {
    get totalRecords() {
      return byKey.size;
    },
    async put(input: ArtifactPutInput): Promise<ArtifactPutOutcome> {
      const k = key(input.tenantId, input.digest);
      const existing = byKey.get(k);
      if (existing !== undefined) {
        return { status: "converged", digest: existing.digest, record: existing };
      }
      const record: ArtifactRecord = {
        tenantId: input.tenantId,
        digest: input.digest,
        kind: input.kind,
        canonicalContent: input.canonicalContent,
        sourceRefs: input.sourceRefs,
        parents: input.parents,
        createdAt: new Date().toISOString(),
      };
      byKey.set(k, record);
      return { status: "stored", digest: record.digest, record };
    },
    async get(scope: ArtifactScope, digest: ArtifactDigest): Promise<ArtifactRecord | null> {
      return byKey.get(key(scope.tenantId, digest)) ?? null;
    },
    async list(scope: ArtifactScope): Promise<readonly ArtifactRecord[]> {
      return [...byKey.values()].filter((r) => r.tenantId === scope.tenantId).sort(byDigest);
    },
    async ownerOf(digest: ArtifactDigest): Promise<readonly string[]> {
      const tenants = new Set<string>();
      for (const record of byKey.values()) {
        if (record.digest === digest) {
          tenants.add(record.tenantId);
        }
      }
      return [...tenants].sort();
    },
  };
}
