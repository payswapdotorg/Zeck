/**
 * The PPR-018 adapter — a local OpenAI-compatible chat-completions
 * endpoint whose ONLY backend is the Zeck public API.
 *
 * Aider's unmodified LiteLLM `openai/` provider points here
 * (`--openai-api-base http://127.0.0.1:<port>/v1`). Every request:
 *
 *  1. is attributed to a declared execution-graph edge (edges.ts);
 *  2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *     (idempotent create — the key is content-addressed with a fresh
 *     salt only after a FAILED outcome, so identical requests that
 *     succeeded replay the durable outcome (the measured reuse axis)
 *     while a retry after a provider-axis failure is a NEW logical
 *     request);
 *  3. is executed by the Zeck-side rail worker (compose.ts) through the
 *     executions authority's own commands;
 *  4. returns the completion content read back from the execution's
 *     PUBLIC event ledger (the tool-result step event) — never a
 *     side-channel.
 *
 * The adapter holds the Zeck transport credential (a Zeck bearer token —
 * never a provider key). It ignores the inbound Authorization header
 * entirely (the Aider runtime's LiteLLM client sends a client-side
 * placeholder; see the evidence record's credential facts).
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attributeEdge, type AiderEdgeId } from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";

/** The ambient task context the corpus runner stamps per Aider run. */
export interface AdapterRunContext {
  readonly corpusTask: string;
  readonly runLabel: string;
}

export interface AdapterServerOptions {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly applicationId: string;
  readonly hostname?: string;
  readonly port?: number;
}

export interface AdapterServer {
  readonly port: number;
  readonly url: string;
  /** Every request served (the battery's per-edge execution log). */
  readonly requests: () => readonly AdapterRequestLog[];
  /** Stamp the ambient corpus-task context (the corpus runner's seam). */
  setRunContext(context: AdapterRunContext | null): void;
  close(): void;
}

/** One served request's durable log entry (edge + execution outcome). */
export interface AdapterRequestLog {
  readonly at: string;
  readonly edgeId: AiderEdgeId;
  readonly model: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly terminal: string;
  readonly contentChars: number;
  readonly corpusTask: string | null;
}

interface OpenAiMessage {
  readonly role: string;
  readonly content: string;
}

interface OpenAiRequestBody {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
  readonly temperature?: unknown;
  readonly max_tokens?: unknown;
}

/** The model completion fact read back from the execution's ledger. */
interface ModelCompletionFact {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Extract the model-completion fact from the public event ledger. */
export function completionFactOf(events: readonly ExecutionEvent[]): ModelCompletionFact | null {
  const results = events.filter(
    (event) =>
      event.type === "execution.tool-result" &&
      (event.payload as { readonly kind?: unknown } | undefined)?.kind === "model-completion",
  );
  const last = results[results.length - 1];
  if (last === undefined) {
    return null;
  }
  const payload = last.payload as {
    readonly content?: unknown;
    readonly usage?: { readonly input?: unknown; readonly output?: unknown };
  };
  if (typeof payload.content !== "string") {
    return null;
  }
  return {
    content: payload.content,
    inputTokens: typeof payload.usage?.input === "number" ? payload.usage.input : 0,
    outputTokens: typeof payload.usage?.output === "number" ? payload.usage.output : 0,
  };
}

/** Create the adapter server (node:http on a loopback port). */
export async function createAdapterServer(options: AdapterServerOptions): Promise<AdapterServer> {
  const client: ZeckClient = createZeckClient({
    baseUrl: options.apiBaseUrl,
    token: options.token,
    applicationId: options.applicationId,
  });
  const logs: AdapterRequestLog[] = [];
  let runContext: AdapterRunContext | null = null;
  const keyState = new Map<string, { key: string; failed: boolean; attempts: number }>();
  const nextAttempt = (digest: string): string => {
    const state = keyState.get(digest);
    const attempts = (state?.attempts ?? 0) + 1;
    const key = `ppr-018-aider-${digest.slice(0, 32)}-${attempts}`;
    keyState.set(digest, { key, failed: false, attempts });
    return key;
  };

  const handle = async (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload);
    };
    const url = request.url ?? "";
    if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
      send(404, { error: { message: "the adapter serves only POST /v1/chat/completions" } });
      return;
    }
    let body: OpenAiRequestBody;
    try {
      body = JSON.parse(await readBody(request)) as OpenAiRequestBody;
    } catch {
      send(400, { error: { message: "unparseable request body" } });
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: OpenAiMessage[] = [];
    for (const message of rawMessages) {
      if (
        typeof message === "object" &&
        message !== null &&
        typeof (message as OpenAiMessage).role === "string" &&
        typeof (message as OpenAiMessage).content === "string"
      ) {
        messages.push(message as OpenAiMessage);
      }
    }
    if (model.length === 0 || messages.length === 0) {
      send(400, { error: { message: "model and messages are required" } });
      return;
    }
    const stream = body.stream === true;
    const attribution = attributeEdge({ model, messages });

    const params: Record<string, unknown> = {};
    if (typeof body.temperature === "number") {
      params.temperature = body.temperature;
    }
    if (typeof body.max_tokens === "number") {
      params.maxTokens = body.max_tokens;
    }

    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ model, messages, params }))
      .digest("hex");
    const known = keyState.get(requestDigest);
    const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;

    let receipt;
    try {
      const created = await client.createExecution(
        {
          applicationId: options.applicationId,
          task: {
            kind: "coding-assistant.completion",
            role: attribution.role,
            messages,
            params,
          },
          constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 150_000 },
          metadata: {
            origin: "ppr-018-aider-adapter",
            edge: attribution.edgeId,
            aiderModel: model,
            ...(runContext === null
              ? {}
              : { corpusTask: runContext.corpusTask, runLabel: runContext.runLabel }),
          },
        },
        idempotencyKey,
      );
      receipt = created.receipt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(502, { error: { message: `Zeck execution create failed: ${message}` } });
      return;
    }

    let execution;
    try {
      execution = await awaitTerminal(client, receipt.executionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(504, { error: { message: `Zeck execution did not reach a terminal state: ${message}` } });
      return;
    }
    if (execution.status !== "COMPLETED") {
      const state = keyState.get(requestDigest);
      if (state !== undefined) {
        keyState.set(requestDigest, { ...state, failed: true });
      }
      logs.push({
        at: new Date().toISOString(),
        edgeId: attribution.edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: 0,
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(500, {
        error: { message: `Zeck execution ${receipt.executionId} ended ${execution.status}` },
      });
      return;
    }

    const events = await client.listEvents(receipt.executionId);
    const fact = completionFactOf(events);
    if (fact === null) {
      send(502, { error: { message: "completed execution carried no model-completion fact" } });
      return;
    }

    logs.push({
      at: new Date().toISOString(),
      edgeId: attribution.edgeId,
      model,
      executionId: receipt.executionId,
      replayed: receipt.replayed,
      terminal: execution.status,
      contentChars: fact.content.length,
      corpusTask: runContext?.corpusTask ?? null,
    });

    const completionId = `zeck-${receipt.executionId}`;
    if (stream) {
      const sse = [
        `data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          model,
          choices: [
            { index: 0, finish_reason: null, delta: { role: "assistant", content: fact.content } },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, finish_reason: "stop", delta: {} }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse);
      return;
    }
    send(200, {
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: fact.content },
        },
      ],
      usage: {
        prompt_tokens: fact.inputTokens,
        completion_tokens: fact.outputTokens,
        total_tokens: fact.inputTokens + fact.outputTokens,
      },
    });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: `adapter crash: ${message}` } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => resolve());
  });
  const port = () => (server.address() as AddressInfo).port;

  return {
    get port() {
      return port();
    },
    get url() {
      return `http://127.0.0.1:${port()}/v1`;
    },
    requests: () => [...logs],
    setRunContext(context) {
      runContext = context;
    },
    close() {
      server.close();
    },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

async function awaitTerminal(
  client: ZeckClient,
  executionId: string,
  timeoutMs = 170_000,
): Promise<{ readonly status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const execution = await client.getExecution(executionId);
    if (TERMINAL_STATUSES.includes(execution.status as never)) {
      return { status: execution.status };
    }
    if (Date.now() > deadline) {
      throw new Error(`polling timed out after ${timeoutMs}ms (last status ${execution.status})`);
    }
    await sleep(150);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
