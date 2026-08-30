/**
 * Context source domain (context module; WORK-008 / CTX-001).
 *
 * A compilation request names SOURCE CORPORA (opaque ids owned by the
 * caller's application); the retrieval port fetches raw candidates. Every
 * candidate carries the tenant that owns it — the retrieval stage asserts
 * tenant equality against the compiling tenant (the CTX cross-tenant
 * retrieval boundary) before any downstream stage sees data.
 */

/** A source corpus reference inside a compile request. */
export interface ContextSourceSelector {
  readonly sourceId: string;
}

/** A raw candidate document as returned by a retrieval adapter. */
export interface ContextCandidate {
  /** Owning tenant — MUST equal the compiling tenant (enforced by stage 1). */
  readonly tenantId: string;
  readonly sourceId: string;
  /** Stable locator inside the source (path, uri, key — opaque here). */
  readonly locator: string;
  readonly title: string;
  readonly content: string;
  /** Optional pre-extracted index terms; derived from content when absent. */
  readonly terms?: readonly string[];
}

/** Deterministic candidate ordering (retrieval-stage output order). */
export function byCandidate(a: ContextCandidate, b: ContextCandidate): number {
  const ka = `${a.sourceId}\u0000${a.locator}\u0000${a.title}\u0000${a.content}`;
  const kb = `${b.sourceId}\u0000${b.locator}\u0000${b.title}\u0000${b.content}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Lowercased term set used by the relevance stage (deterministic). */
export function candidateTerms(candidate: ContextCandidate): readonly string[] {
  if (candidate.terms !== undefined) {
    return candidate.terms.map((term) => term.toLowerCase());
  }
  return candidate.content
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase());
}
