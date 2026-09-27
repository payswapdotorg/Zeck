/**
 * The PPR-018 Zeck trace source — correlation over the PUBLIC SDK wire
 * reads (the framework's sanctioned out-of-process consumer path: "an
 * out-of-process consumer (a sibling integration driving Zeck through
 * the SDK over HTTP) can implement the same read over the public wire
 * shapes without importing Zeck internals").
 *
 * Every delegated edge's executions are read back through
 * GET /executions/:id (+ /events + /verification) with the canonical
 * X-Zeck-Application scope header — the same reads any external
 * auditor would perform — and projected onto the framework's
 * ZeckTraceFact shape via `zeckTraceFactOf`.
 */

import {
  createZeckClient,
  type ZeckClient,
} from "../../../sdk";
import type {
  TraceRead,
  ZeckTraceFact,
  ZeckTraceSource,
} from "../../../src/integrations/compatibility/public";
import { zeckTraceFactOf } from "../../../src/integrations/compatibility/public";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

export interface SdkTraceSourceOptions {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly applicationId: string;
}

/** Create the SDK-wire trace source (read-only, public shapes only). */
export function createSdkTraceSource(options: SdkTraceSourceOptions): ZeckTraceSource {
  const client: ZeckClient = createZeckClient({
    baseUrl: options.apiBaseUrl,
    token: options.token,
    applicationId: options.applicationId,
  });
  return {
    async readExecutionTrace(applicationId, executionId): Promise<TraceRead> {
      try {
        const execution = await client.getExecution(executionId);
        const events = await client.listEvents(executionId);
        const verification = await client.listVerification(executionId);
        const decision = [...events]
          .reverse()
          .find((event) => event.type === "planning.decision-recorded");
        const payload = decision?.payload as
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
        const routeRef = plan?.steps?.find((step) => step.routeRef !== undefined)?.routeRef;
        const settled = [...events]
          .reverse()
          .find((event) => event.type === "execution.completed");
        const costMicroUsd = (settled?.payload as { readonly costMicroUsd?: unknown } | undefined)
          ?.costMicroUsd;
        const usage = (settled?.payload as { readonly usage?: unknown } | undefined)?.usage;
        const inputTokens = (usage as { readonly inputTokens?: unknown } | undefined)?.inputTokens;
        const outputTokens = (usage as { readonly outputTokens?: unknown } | undefined)
          ?.outputTokens;
        return {
          execution: {
            id: execution.id,
            applicationId: execution.applicationId,
            status: execution.status,
            terminal: TERMINAL.has(execution.status),
          },
          events: events.map((event) => ({
            eventId: event.eventId,
            sequence: event.sequence,
            type: event.type,
          })),
          verification: verification.map((result) => ({
            id: result.id,
            status: result.status,
          })),
          route:
            plan === undefined
              ? null
              : {
                  provider: routeRef?.provider ?? null,
                  model: routeRef?.model ?? null,
                  strategyClass: plan.strategyClass ?? null,
                },
          costMicroUsd:
            typeof costMicroUsd === "string" && /^\d+$/.test(costMicroUsd) ? costMicroUsd : null,
          usage:
            typeof inputTokens === "number" && typeof outputTokens === "number"
              ? { inputTokens, outputTokens }
              : null,
        };
      } catch {
        // A read that cannot be performed is an honest "not found" —
        // never a fabricated trace.
        return {
          execution: null,
          events: [],
          verification: [],
          route: null,
          costMicroUsd: null,
          usage: null,
        };
      }
    },
  };
}

/** Correlate one (edgeId, executionId) pair into a recorded trace fact. */
export async function traceFactOf(
  source: ZeckTraceSource,
  applicationId: string,
  edgeId: string,
  executionId: string,
): Promise<ZeckTraceFact> {
  const read = await source.readExecutionTrace(applicationId, executionId);
  return zeckTraceFactOf(edgeId, applicationId, executionId, read);
}
