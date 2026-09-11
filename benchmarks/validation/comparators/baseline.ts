/**
 * The baseline application contract (VAL-005, acceptance criteria
 * 1-3).
 *
 * A baseline executes corpus tasks through ITS OWN integration path
 * (the provider SDK directly, an optimized implementation, or a
 * competing stack) and reports the SAME observed-outcome shape the
 * evaluation engine consumes for Zeck runs — identical inputs,
 * identical assertions, shared evaluation. The transport is INJECTED
 * (the network-free discipline of the benchmark tree): executors live
 * in the test/integration layer with real credentials.
 */

import type { GoldenTask } from "../corpus/schema";
import type { ObservedOutcome } from "../evaluation/deterministic";
import type { RunMetadata } from "../run-identity";

/** A baseline run's report: the observed outcome + identity metadata. */
export interface BaselineRunReport {
  readonly taskId: string;
  readonly metadata: RunMetadata;
  readonly observed: ObservedOutcome;
  /** The optimization choices applied (documented per template). */
  readonly appliedOptimizations: readonly string[];
}

/** The injected transport a baseline template uses (never network here). */
export type BaselineTransport = (
  request: BaselineTransportRequest,
) => Promise<BaselineTransportResponse>;

export interface BaselineTransportRequest {
  readonly endpoint: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The task the payload was built from (for provenance). */
  readonly taskId: string;
}

export interface BaselineTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  /** The response text, when the transport produced one. */
  readonly text: string | null;
  readonly latencyMs: number;
}

/** A baseline application template (executable, transport-injected). */
export interface BaselineTemplate {
  readonly arm: string;
  readonly kind: "direct-provider" | "optimized-baseline" | "competing-stack";
  readonly integrationSurface: string;
  /** The documented integration path (what a customer would replicate). */
  readonly integrationNotes: string;
  /** The optimization choices this template documents (empty for direct). */
  readonly documentedOptimizations: readonly string[];
  /** Build the transport request for one corpus task. */
  buildRequest(task: GoldenTask, documentContent: string): BaselineTransportRequest;
  /** Fold a transport response into the observed-outcome shape. */
  observeOutcome(
    task: GoldenTask,
    response: BaselineTransportResponse,
    metadata: RunMetadata,
  ): BaselineRunReport;
}
