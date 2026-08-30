/**
 * Tool adapter port (tools module outbound; WORK-010).
 *
 * The EXECUTION seam of the governed tool runtime: the only surface through
 * which a registered tool implementation receives work and returns an
 * observation. Provider/tool-implementation specifics live entirely behind
 * this port (adapters), exactly as provider rails live behind
 * `ModelProvider` (models module).
 *
 * Authority properties of this port's SHAPE (acceptance criterion 4):
 *   - an adapter receives ONLY the dispatch (identity, contract, validated
 *     input) and its execution context (tenant/application/execution
 *     binding, deadline) — it is never handed stores, services, execution
 *     mutation surfaces or any platform authority handle, so a tool cannot
 *     mutate customer-domain workflow state or platform authority state
 *     because it cannot even express such a mutation;
 *   - an adapter RETURNS an observation (`ToolObservation`), never a state
 *     transition — tool outcomes are observations (§13), recorded as
 *     evidence by the runtime, never applied as authority;
 *   - the runtime invokes adapters ONLY after the full admission chain
 *     (policy → budget → capability → tenant/scope) has allowed the
 *     dispatch; there is no adapter path that skips admission.
 */

import type { ToolFailure } from "../domain/invocation";
import type { ToolContract } from "../domain/tool";

/** What the runtime hands a bound adapter at the execution boundary. */
export interface ToolDispatch {
  /** Durable invocation identity (evidence linkage; UUIDv7). */
  readonly invocationId: string;
  /** The admitted, registered contract (the exact identity + schema). */
  readonly contract: ToolContract;
  /** Input already validated against `contract.inputSchema`. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** Server-derived execution context (tenant binding + deadline). */
export interface ToolDispatchContext {
  readonly tenantId: string;
  readonly applicationId: string;
  /** Parent execution the invocation is provenance-bound to. */
  readonly executionId: string;
  readonly timeoutMs: number;
}

/**
 * The normalized observation a tool adapter returns. Success carries the
 * output object (validated against `contract.outputSchema` by the RUNTIME
 * — an adapter whose output violates its own declared contract is a typed
 * `output-contract` failure, not a success) plus optional artifact
 * references and actual usage. Failure carries the typed tool failure.
 */
export type ToolObservation =
  | {
      readonly kind: "tool-success";
      readonly output: Readonly<Record<string, unknown>>;
      /** Artifact references produced by the observation (TOL-002). */
      readonly artifacts?: readonly string[];
      /** Actual billable usage, integer micro-USD string (default "0"). */
      readonly usageMicroUsd?: string;
    }
  | {
      readonly kind: "tool-failure";
      readonly failure: ToolFailure;
    };

export interface ToolAdapter {
  /**
   * Execute the dispatched work and return the observation. Implementations
   * SHOULD return typed failures rather than throwing; a thrown error is
   * normalized by the runtime into an `adapter-error` tool failure (typed
   * `TOOL_ERROR`) — it never crosses the boundary as control flow.
   */
  execute(dispatch: ToolDispatch, context: ToolDispatchContext): Promise<ToolObservation>;
}
