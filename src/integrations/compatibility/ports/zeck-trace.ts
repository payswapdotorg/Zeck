/**
 * The Zeck trace correlation port (ACR-006 §4 rule 4's read path).
 *
 * The compatibility layer correlates every delegated edge to Zeck
 * execution identifiers and evidence THROUGH THE EXISTING executions
 * public surface — it never reimplements execution reads, never touches
 * execution stores and never becomes a second executions authority.
 *
 * The port is deliberately MINIMAL and provider-neutral: ONE read per
 * (applicationId, executionId) returning the correlation facts (the
 * execution view, its ledger events, its verification results, and the
 * OPTIONAL route/cost/usage facts an implementing adapter can project
 * from its reads), so that:
 *  - the in-process adapter (adapters/executions-trace-source.ts) maps
 *    the executions module's public service onto it (deriving the
 *    optional facts from the canonical event ledger, the same public
 *    event vocabulary the API's result projection reads); and
 *  - an out-of-process consumer (a sibling integration driving Zeck
 *    through the SDK over HTTP) can implement the same read over the
 *    public wire shapes without importing Zeck internals — the boundary
 *    ACR-006 §2 demands.
 */

import type { ZeckTraceFact } from "../domain/evidence";

/** The neutral execution view the correlation reads (wire-vocabulary terms). */
export interface TraceExecutionView {
  readonly id: string;
  readonly applicationId: string;
  /** The execution lifecycle status (the public wire vocabulary). */
  readonly status: string;
  /** True when the status is terminal (COMPLETED/FAILED/CANCELLED/EXPIRED). */
  readonly terminal: boolean;
}

/** The neutral ledger-event view (identity + sequence + type only — payloads stay with the authority). */
export interface TraceEventView {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
}

/** The neutral verification-result view (status + identity only). */
export interface TraceVerificationView {
  readonly id: string;
  readonly status: string;
}

/** The route facts an adapter may project from its reads (absent ⇒ null, never fabricated). */
export interface TraceRouteFacts {
  readonly provider: string | null;
  readonly model: string | null;
  readonly strategyClass: string | null;
}

/** The usage facts an adapter may project from its reads (absent ⇒ null). */
export interface TraceUsageFacts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One correlated execution's full read (everything the record's trace fact carries). */
export interface TraceRead {
  readonly execution: TraceExecutionView | null;
  readonly events: readonly TraceEventView[];
  readonly verification: readonly TraceVerificationView[];
  /** Route facts when the adapter can project them; null otherwise (honest). */
  readonly route: TraceRouteFacts | null;
  /** Settled cost (integer micro-USD string) when projectable; null otherwise. */
  readonly costMicroUsd: string | null;
  /** Usage facts when projectable; null otherwise. */
  readonly usage: TraceUsageFacts | null;
}

/**
 * The read seam over the existing executions public surface. Every
 * operation is a READ; there is no write operation on this port by
 * construction (correlation observes, never mutates).
 */
export interface ZeckTraceSource {
  readExecutionTrace(applicationId: string, executionId: string): Promise<TraceRead>;
}

/**
 * The correlated fact for ONE (edgeId, executionId) pair — the durable
 * Zeck evidence axis of the record. `correlated` requires the execution
 * to be found AND to carry durable evidence (ledger events plus at
 * least one verification result recorded on the execution).
 */
export function zeckTraceFactOf(
  edgeId: string,
  applicationId: string,
  executionId: string,
  read: TraceRead,
): ZeckTraceFact {
  const execution = read.execution;
  const verificationCount = read.verification.length;
  const passingVerificationCount = read.verification.filter(
    (result) => result.status === "PASS",
  ).length;
  const found = execution !== null;
  const correlated = found && read.events.length > 0 && verificationCount > 0;
  return {
    edgeId,
    executionId,
    applicationId,
    found,
    status: execution?.status ?? null,
    terminal: execution?.terminal ?? false,
    eventCount: read.events.length,
    verificationCount,
    passingVerificationCount,
    correlated,
    route: read.route,
    costMicroUsd: read.costMicroUsd,
    usage: read.usage,
  };
}

/**
 * Did one recorded trace fact RESOLVE through Zeck with verified
 * evidence? (Terminal COMPLETED with at least one PASS verification —
 * the executions authority's own completion binding: every COMPLETED
 * transition is produced by verification and bound to a durable PASS.)
 * An admission-level rule-4 delegation needs every declared execution
 * correlated AND at least one resolved execution per edge.
 */
export function traceFactResolved(trace: ZeckTraceFact): boolean {
  return (
    trace.found &&
    trace.terminal &&
    trace.status === "COMPLETED" &&
    trace.passingVerificationCount > 0
  );
}
