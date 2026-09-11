/**
 * The DIRECT single-provider baseline template (VAL-005, acceptance
 * criterion 1): corpus tasks executed through the provider's own chat
 * endpoint with identical inputs and evaluation — no routing, no
 * retries beyond the provider default, direct cost accounting.
 */

import type { GoldenTask } from "../corpus/schema";
import type { RunMetadata } from "../run-identity";
import type {
  BaselineRunReport,
  BaselineTemplate,
  BaselineTransport,
  BaselineTransportRequest,
  BaselineTransportResponse,
} from "./baseline";

/** The provider-neutral chat completion request shape (OpenAI-compatible). */
export interface DirectProviderChatRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly max_tokens?: number;
}

/** Build the direct-provider baseline template for one provider. */
export function directProviderBaseline(options: {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
}): BaselineTemplate {
  return {
    arm: `direct-${options.provider}`,
    kind: "direct-provider",
    integrationSurface: `provider:${options.provider}`,
    integrationNotes:
      "the task payload is sent directly to the provider chat endpoint " +
      "(OpenAI-compatible request shape); no routing layer, no retry policy " +
      "beyond the transport default, no shared cache; cost is the provider's " +
      "own accounting",
    documentedOptimizations: [],
    buildRequest(task: GoldenTask, documentContent: string): BaselineTransportRequest {
      const request: DirectProviderChatRequest = {
        model: options.model,
        messages: [
          {
            role: "system",
            content: "You are executing a validation task. Follow the task instruction exactly.",
          },
          {
            role: "user",
            content: `${JSON.stringify(task.input)}\n\nDocument:\n${documentContent}`,
          },
        ],
        max_tokens: 256,
      };
      return {
        endpoint: options.endpoint,
        payload: request as unknown as Readonly<Record<string, unknown>>,
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
          retryableErrorsSurfaced: response.ok ? 0 : 1,
        },
        appliedOptimizations: [],
      };
    },
  };
}

/** Execute one task through the template and its injected transport. */
export async function runDirectTask(input: {
  readonly template: BaselineTemplate;
  readonly task: GoldenTask;
  readonly documentContent: string;
  readonly transport: BaselineTransport;
  readonly metadata: RunMetadata;
}): Promise<BaselineRunReport> {
  const request = input.template.buildRequest(input.task, input.documentContent);
  const response = await input.transport(request);
  return input.template.observeOutcome(input.task, response, input.metadata);
}
