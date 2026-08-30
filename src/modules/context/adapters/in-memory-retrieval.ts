/**
 * In-memory retrieval adapter (context module adapter; WORK-008).
 *
 * The development/test source corpus: registered candidates served per
 * `(tenantId, sourceId)`. Real retrieval surfaces (vector stores, document
 * corpora) are future Work Orders; this adapter honors the port contract —
 * the query's tenant scopes the response at the source, and the retrieval
 * stage still re-asserts every candidate.
 */

import type { ContextCandidate } from "../domain/source";
import type { ContextRetrievalPort, RetrievalQuery } from "../ports/context-retrieval";

export function createInMemoryRetrieval(
  corpus: readonly ContextCandidate[] = [],
): ContextRetrievalPort & {
  readonly size: number;
  register(candidate: ContextCandidate): void;
} {
  const byKey = new Map<string, ContextCandidate>();
  const key = (tenantId: string, sourceId: string, locator: string): string =>
    `${tenantId}\u0000${sourceId}\u0000${locator}`;

  for (const candidate of corpus) {
    byKey.set(key(candidate.tenantId, candidate.sourceId, candidate.locator), candidate);
  }

  return {
    get size() {
      return byKey.size;
    },
    register(candidate: ContextCandidate): void {
      byKey.set(key(candidate.tenantId, candidate.sourceId, candidate.locator), candidate);
    },
    async retrieve(query: RetrievalQuery): Promise<readonly ContextCandidate[]> {
      const sourceIds = new Set(query.sources.map((selector) => selector.sourceId));
      const out: ContextCandidate[] = [];
      for (const candidate of byKey.values()) {
        if (candidate.tenantId === query.tenantId && sourceIds.has(candidate.sourceId)) {
          out.push(candidate);
        }
      }
      return out;
    },
  };
}
