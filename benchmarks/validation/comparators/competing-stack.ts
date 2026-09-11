/**
 * The COMPETING-STACK baseline template (VAL-005, acceptance criterion
 * 3): an external gateway/router/agent-stack integration contract.
 * Executable when the stack's access exists; an absent stack access is
 * a declared NOT RUN boundary recorded with the exact access
 * requirement — never a fabricated result.
 */

import type { GoldenTask } from "../corpus/schema";
import type { RunMetadata } from "../run-identity";
import type { BaselineRunReport, BaselineTemplate, BaselineTransportRequest } from "./baseline";

/** The access requirement surfaced for an unexecuted competing stack. */
export interface CompetingStackAccessRequirement {
  readonly stack: string;
  readonly requiredAccess: string;
  readonly status: "not-run";
}

/** Build the competing-stack baseline template for one stack. */
export function competingStackBaseline(options: {
  readonly stack: string;
  readonly endpoint: string;
  readonly taskMapping: (task: GoldenTask) => Record<string, unknown>;
}): BaselineTemplate {
  return {
    arm: `stack-${options.stack}`,
    kind: "competing-stack",
    integrationSurface: `stack:${options.stack}`,
    integrationNotes:
      `tasks are mapped to the ${options.stack} integration format and ` +
      "submitted through its API; execution requires the stack's own " +
      "credential and reachable endpoint (recorded NOT RUN when absent)",
    documentedOptimizations: [],
    buildRequest(task: GoldenTask, documentContent: string): BaselineTransportRequest {
      return {
        endpoint: options.endpoint,
        payload: {
          ...options.taskMapping(task),
          document: documentContent,
        },
        taskId: task.taskId,
      };
    },
    observeOutcome(
      task: GoldenTask,
      response: { ok: boolean; status: number; text: string | null; latencyMs: number },
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
        appliedOptimizations: [],
      };
    },
  };
}

/** Declare a competing stack as NOT RUN with its exact access requirement. */
export function declareCompetingStackNotRun(
  stack: string,
  requiredAccess: string,
): CompetingStackAccessRequirement {
  return { stack, requiredAccess, status: "not-run" };
}
