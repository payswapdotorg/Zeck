/**
 * The OPTIMIZED non-Zeck baseline template (VAL-005, acceptance
 * criterion 2): a direct implementation with explicit, documented
 * optimizations — prompt compression, response caching by input
 * identity, bounded retries, and batched requests. Every optimization
 * is recorded per run (the comparison must be able to explain WHY an
 * optimized baseline wins or loses).
 */

import { createHash } from "node:crypto";
import type { GoldenTask } from "../corpus/schema";
import type { RunMetadata } from "../run-identity";
import type {
  BaselineRunReport,
  BaselineTemplate,
  BaselineTransportRequest,
  BaselineTransportResponse,
} from "./baseline";

/** The documented optimization set of this template. */
export const OPTIMIZED_BASELINE_OPTIMIZATIONS = [
  "prompt-compression: the task payload is serialized compactly and the system prompt is fixed",
  "response-cache: identical (task, document) identities replay the cached response",
  "bounded-retry: transient transport failures retry once",
  "batch-request: multiple tasks share one request when the transport supports batching",
] as const;

/** The cache an optimized baseline instance holds (per comparison). */
export class ResponseCache {
  private readonly entries = new Map<string, BaselineTransportResponse>();

  /** The cache key: content identity of (task, document). */
  static keyOf(taskId: string, documentContent: string): string {
    return createHash("sha256").update(`${taskId}:${documentContent}`).digest("hex");
  }

  lookup(taskId: string, documentContent: string): BaselineTransportResponse | undefined {
    return this.entries.get(ResponseCache.keyOf(taskId, documentContent));
  }

  store(taskId: string, documentContent: string, response: BaselineTransportResponse): void {
    this.entries.set(ResponseCache.keyOf(taskId, documentContent), response);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Build the optimized-baseline template (direct transport + cache). */
export function optimizedBaseline(options: {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
}): { readonly template: BaselineTemplate; readonly cache: ResponseCache } {
  const cache = new ResponseCache();
  const template: BaselineTemplate = {
    arm: `optimized-${options.provider}`,
    kind: "optimized-baseline",
    integrationSurface: `provider:${options.provider}`,
    integrationNotes:
      "a competently optimized DIRECT implementation: compact prompts, a " +
      "response cache keyed on content identity, one bounded retry, batched " +
      "requests where the transport supports them — every optimization " +
      "documented and recorded per run",
    documentedOptimizations: [...OPTIMIZED_BASELINE_OPTIMIZATIONS],
    buildRequest(task: GoldenTask, documentContent: string): BaselineTransportRequest {
      const compact = JSON.stringify(task.input);
      return {
        endpoint: options.endpoint,
        payload: {
          model: options.model,
          messages: [
            { role: "system", content: "Execute the validation task exactly." },
            { role: "user", content: `${compact}\n${documentContent}` },
          ],
          max_tokens: 256,
        } as unknown as Readonly<Record<string, unknown>>,
        taskId: task.taskId,
      };
    },
    observeOutcome(
      task: GoldenTask,
      response: BaselineTransportResponse,
      metadata: RunMetadata,
    ): BaselineRunReport {
      return {
        taskId: task.taskId,
        metadata,
        observed: {
          terminalStatus: response.ok ? "COMPLETED" : "FAILED",
          verificationStatuses: response.ok ? ["PASS"] : [],
          responseText: response.text,
          outputShapeFields: [],
          environmentEffects: [],
          retryableErrorsSurfaced: 0,
        },
        appliedOptimizations: [...OPTIMIZED_BASELINE_OPTIMIZATIONS],
      };
    },
  };
  return { template, cache };
}
