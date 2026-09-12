/**
 * The failure-attribution application's deterministic fault-injection
 * fixtures (VAL-020, AC2).
 *
 * Fake transports that replay the REAL provider failure envelope
 * shapes the live rails actually produced in the documented prior
 * runs (exported verbatim from the platform module's
 * REAL_RAIL_FAILURE_ENVELOPES: dashscope AllocationQuota/AccessDenied/
 * InvalidParameter envelopes, OpenRouter credit-limit 402s and 429s,
 * the empty-content 200) — plus the healthy replay shapes and the
 * one-fail-then-recover transport for the recovery row. Every offline
 * corpus row is reproducible through these fixtures with zero network
 * dependence, while the URL constants the rail speaks remain the
 * PINNED REAL endpoint domains (asserted by the unit suite — the
 * fake-transport tests cannot catch DNS defects, so the fixtures
 * record and check exactly which REAL URL each attempt addressed).
 *
 * The controlled tool world exercises the tool-failure surface: a
 * deterministic lookup tool (a settled rejection for the tool-failure
 * row — never retried) and a deliberately hanging archiver (the
 * deadline race classifies it as tool-timeout — retried, bounded).
 */

import {
  type AttributionTool,
  DASHSCOPE_ACCESS_DENIED_ENVELOPE_403,
  DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403,
  DASHSCOPE_EMPTY_CONTENT_ENVELOPE_200,
  DASHSCOPE_INVALID_PARAMETER_ENVELOPE_400,
  type HttpTransport,
  OPENROUTER_CREDIT_LIMIT_ENVELOPE_402,
  OPENROUTER_RATE_LIMIT_ENVELOPE_429,
} from "../../platform/failure-attribution";

/** The healthy OpenRouter-shaped success replay body. */
const OPENROUTER_SUCCESS_ENVELOPE_200: Readonly<Record<string, unknown>> = {
  choices: [{ message: { content: "healthy" } }],
  usage: { prompt_tokens: 12, completion_tokens: 1, cost: 0.000012 },
};

/** The healthy dashscope-shaped multimodal success replay body. */
const DASHSCOPE_SUCCESS_ENVELOPE_200: Readonly<Record<string, unknown>> = {
  output: { choices: [{ message: { content: "healthy" } }] },
  usage: { input_tokens: 11, output_tokens: 1 },
};

/** The scenario ids the fault-injection transport understands. */
export type FaultScenario =
  | "transport-failure"
  | "quota-envelope"
  | "openrouter-credit-402"
  | "rate-limit"
  | "invalid-request"
  | "access-denied"
  | "empty-completion"
  | "healthy-no-retry"
  | "healthy-recovery-after-retry";

/**
 * Build the deterministic fault-injection transport for one scenario:
 * replays the scripted REAL envelope shapes in order and records every
 * URL each attempt addressed (the REAL-domain assertion surface).
 */
export function createFaultInjectedTransport(options: { readonly scenario: FaultScenario }): {
  readonly transport: HttpTransport;
  readonly calls: { count: number; urls: string[] };
} {
  const calls = { count: 0, urls: [] as string[] };
  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const transport: HttpTransport = async (url) => {
    calls.count += 1;
    calls.urls.push(url);
    switch (options.scenario) {
      case "transport-failure":
        throw new TypeError("fetch failed: ECONNREFUSED (injected transport fault)");
      case "quota-envelope":
        return respond(403, DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403);
      case "openrouter-credit-402":
        return respond(402, OPENROUTER_CREDIT_LIMIT_ENVELOPE_402);
      case "rate-limit":
        return respond(429, OPENROUTER_RATE_LIMIT_ENVELOPE_429);
      case "invalid-request":
        return respond(400, DASHSCOPE_INVALID_PARAMETER_ENVELOPE_400);
      case "access-denied":
        return respond(403, DASHSCOPE_ACCESS_DENIED_ENVELOPE_403);
      case "empty-completion":
        return respond(200, DASHSCOPE_EMPTY_CONTENT_ENVELOPE_200);
      case "healthy-no-retry":
        // The rail kind of the healthy rows is openrouter (the corpus
        // pins it); the replay body matches that shape.
        return respond(200, OPENROUTER_SUCCESS_ENVELOPE_200);
      case "healthy-recovery-after-retry": {
        if (calls.count === 1) {
          throw new TypeError("fetch failed: ETIMEDOUT (injected transient transport fault)");
        }
        return respond(200, OPENROUTER_SUCCESS_ENVELOPE_200);
      }
      default: {
        const exhaustive: never = options.scenario;
        throw new Error(`unhandled fault scenario ${String(exhaustive)}`);
      }
    }
  };
  return { transport, calls };
}

/** The healthy dashscope multimodal replay transport (kept for scenario symmetry). */
export function healthyDashscopeTransport(): HttpTransport {
  return async () =>
    new Response(JSON.stringify(DASHSCOPE_SUCCESS_ENVELOPE_200), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

// ---------------------------------------------------------------------------
// The controlled tool world (the tool-failure surface)
// ---------------------------------------------------------------------------

/** The deterministic inventory table the lookup tool reads. */
const INVENTORY_TABLE: Readonly<Record<string, string>> = {
  "SKU-77": "price 77, stock 41",
  "SKU-9": "price 12, stock 8",
};

export function createAttributionToolWorld(): {
  readonly tools: readonly AttributionTool[];
  readonly state: { lookups: number; archivedBytes: number };
} {
  const state = { lookups: 0, archivedBytes: 0 };
  const inventoryLookup: AttributionTool = {
    name: "inventory-lookup",
    async execute({ arguments: args }) {
      state.lookups += 1;
      const key = String(args.key ?? "");
      const found = INVENTORY_TABLE[key];
      if (found === undefined) {
        return {
          ok: false,
          value: `inventory-lookup rejected the invocation: unknown key ${key}`,
          result: null,
        };
      }
      return { ok: true, value: found, result: found };
    },
  };
  const slowArchiver: AttributionTool = {
    name: "slow-archiver",
    async execute() {
      // Deliberately NEVER settles: the deadline race classifies the
      // attempt as tool-timeout; the archiver's effect (archivedBytes)
      // never lands — the honest absence a timeout leaves behind.
      return new Promise<{ ok: boolean; value: string; result: unknown }>(() => {});
    },
  };
  return { tools: [inventoryLookup, slowArchiver], state };
}
