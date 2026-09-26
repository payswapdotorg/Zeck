/**
 * The in-process Zeck trace source — an adapter over the EXISTING
 * executions public service (ACR-006's "correlate through the existing
 * executions public surface, never reimplementing it").
 *
 * This adapter only MAPS: it calls the executions module's public
 * service reads (getExecution / listEvents / listVerificationResults)
 * and projects the results onto the port's neutral views. It holds no
 * execution logic, no state, no write path — the executions authority
 * (its public barrel, the only import surface) owns everything.
 *
 * The OPTIONAL route/cost/usage facts are a READ PROJECTION over the
 * canonical event ledger's own public payloads (the same
 * `planning.decision-recorded` / `execution.completed` event
 * vocabulary the API's result-package projection reads — src/api keeps
 * its own projection private, so this adapter performs the equivalent
 * neutral read projection here; it invents no facts and fabricates
 * nothing: absent ledger facts project to null).
 */

import type { EventEnvelope, ExecutionService } from "../../../modules/executions/public";
import type {
  TraceEventView,
  TraceRead,
  TraceRouteFacts,
  TraceUsageFacts,
  ZeckTraceSource,
} from "../ports/zeck-trace";

/** The executions public service's own terminal-status vocabulary. */
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

export interface ExecutionsTraceSourceOptions {
  /** The executions module's public service (the ONLY seam consumed). */
  readonly service: ExecutionService;
}

/** Create the in-process trace source over the executions public service. */
export function createExecutionsServiceTraceSource(
  options: ExecutionsTraceSourceOptions,
): ZeckTraceSource {
  const { service } = options;
  return {
    async readExecutionTrace(applicationId, executionId): Promise<TraceRead> {
      const record = await service.getExecution(applicationId, executionId);
      const events: readonly EventEnvelope[] = await service.listEvents(applicationId, executionId);
      const verification = await service.listVerificationResults(applicationId, executionId);
      const eventViews: readonly TraceEventView[] = events.map((event) => ({
        eventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
      }));
      return {
        execution:
          record === null
            ? null
            : {
                id: record.id,
                applicationId: record.applicationId,
                status: record.status,
                terminal: TERMINAL.has(record.status),
              },
        events: eventViews,
        verification: verification.map((result) => ({ id: result.id, status: result.status })),
        route: routeFactsOf(events),
        costMicroUsd: costMicroUsdOf(events),
        usage: usageOf(events),
      };
    },
  };
}

/** The latest planning decision's route facts (neutral strings, null-safe). */
function routeFactsOf(events: readonly EventEnvelope[]): TraceRouteFacts | null {
  const decision = [...events]
    .reverse()
    .find((event) => event.type === "planning.decision-recorded");
  if (decision === undefined) {
    return null;
  }
  const payload = decision.payload as
    | {
        readonly candidates?: readonly {
          readonly strategyId?: string;
          readonly plan?: {
            readonly steps?: readonly {
              readonly routeRef?: { readonly provider: string; readonly model: string };
            }[];
            readonly strategyClass?: string;
          };
        }[];
        readonly selectedStrategyId?: string;
      }
    | undefined;
  const selected = payload?.candidates?.find(
    (candidate) => candidate.strategyId === payload?.selectedStrategyId,
  );
  const plan = selected?.plan;
  if (plan === undefined) {
    return null;
  }
  const routeRef = plan.steps?.find((step) => step.routeRef !== undefined)?.routeRef;
  return {
    provider: routeRef?.provider ?? null,
    model: routeRef?.model ?? null,
    strategyClass: plan.strategyClass ?? null,
  };
}

/** The settled cost from the completion event (micro-USD string), when carried. */
function costMicroUsdOf(events: readonly EventEnvelope[]): string | null {
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const costMicroUsd = (settled?.payload as { readonly costMicroUsd?: unknown } | undefined)
    ?.costMicroUsd;
  if (typeof costMicroUsd !== "string" || !/^\d+$/.test(costMicroUsd)) {
    return null;
  }
  return costMicroUsd;
}

/** The settled usage from the completion event, when carried. */
function usageOf(events: readonly EventEnvelope[]): TraceUsageFacts | null {
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const usage = (settled?.payload as { readonly usage?: unknown } | undefined)?.usage;
  const inputTokens = (usage as { readonly inputTokens?: unknown } | undefined)?.inputTokens;
  const outputTokens = (usage as { readonly outputTokens?: unknown } | undefined)?.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return null;
  }
  return { inputTokens, outputTokens };
}
