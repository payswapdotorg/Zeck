/**
 * Context retrieval port (context module; WORK-008 / CTX-001).
 *
 * The outbound seam for raw application-context retrieval. The contract:
 * given a tenant and source selectors, return candidate documents OWNED by
 * that tenant. Adapters MUST tenant-scope their queries at the source; the
 * retrieval STAGE re-asserts ownership candidate-by-candidate (defense in
 * depth — a mutated or careless adapter that leaks a foreign candidate is
 * rejected loudly with `TENANT_SCOPE_VIOLATION`, before any write).
 */

import type { ContextCandidate, ContextSourceSelector } from "../domain/source";

export interface RetrievalQuery {
  readonly tenantId: string;
  readonly sources: readonly ContextSourceSelector[];
}

export interface ContextRetrievalPort {
  retrieve(query: RetrievalQuery): Promise<readonly ContextCandidate[]>;
}
