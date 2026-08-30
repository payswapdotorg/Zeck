/**
 * Stage 1 — Retrieval (context module; WORK-008 / CTX-001).
 *
 * Explicit, testable unit: typed input (raw candidates from the retrieval
 * port) -> typed output (tenant-asserted, deterministically ordered
 * candidates + recorded foreign-tenant violations). The compiler turns any
 * recorded violation into a canonical `TENANT_SCOPE_VIOLATION` BEFORE a
 * single byte is written: cross-tenant source retrieval is the named
 * discrimination boundary of this Work Order.
 */

import { byCandidate, type ContextCandidate } from "../source";

export interface RetrievalStageInput {
  /** The tenant the compilation runs for. */
  readonly tenantId: string;
  /** Raw candidates as returned by the retrieval adapter (any order). */
  readonly candidates: readonly ContextCandidate[];
}

export interface ForeignCandidate {
  readonly candidate: ContextCandidate;
  readonly reason: "tenant-mismatch";
}

export interface RetrievalStageOutput {
  readonly accepted: readonly ContextCandidate[];
  readonly foreign: readonly ForeignCandidate[];
}

export function applyRetrievalStage(input: RetrievalStageInput): RetrievalStageOutput {
  const accepted: ContextCandidate[] = [];
  const foreign: ForeignCandidate[] = [];
  for (const candidate of input.candidates) {
    if (candidate.tenantId === input.tenantId) {
      accepted.push(candidate);
    } else {
      foreign.push({ candidate, reason: "tenant-mismatch" });
    }
  }
  accepted.sort(byCandidate);
  foreign.sort((a, b) => byCandidate(a.candidate, b.candidate));
  return { accepted, foreign };
}
