/**
 * Zeck developer dashboard — a read/compose projection surface over the
 * public API (WORK-015; acceptance criterion 4, M7/M24).
 *
 * A PROJECTION, NEVER A REGISTRY (M24): the dashboard holds NO state of
 * its own — every view is rendered from a LIVE read through the Zeck SDK
 * client (which talks to the API, which delegates to the authorities).
 * There is no frontend-owned cache that becomes truth: each request
 * re-reads through the governed path.
 *
 * THE VIEWS (§12 of the Work Order):
 *   GET /                      → index (execution lookup form + agent list)
 *   GET /executions/:id        → execution receipt, route, cost,
 *                                artifacts, verification evidence, events
 *   GET /agents                → governed agent inventory
 *   POST /executions/:id/cancel → the ONE explicitly governed command
 *                                (through the API's cancel route — the
 *                                lifecycle authority validates it)
 *
 * SECRET SAFETY (M7): the dashboard renders only the public wire shapes
 * (receipt/route/cost/artifacts/verification/agent inventory). Secret
 * material is unrepresentable in the rendered fields — and the HTML
 * rendering additionally escapes all interpolated values.
 */

import { createServer, type IncomingMessage } from "node:http";
import { createZeckClient, type ZeckClient } from "../../sdk";

export interface DashboardOptions {
  /** The Zeck API base URL the dashboard reads through. */
  readonly apiUrl: string;
  /** The Zeck transport credential (from env; never rendered). */
  readonly token: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
}

/** HTML-escape every interpolated value (no injection through data). */
function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); font-weight: normal; }
  th { opacity: 0.7; }
  .status-COMPLETED { color: #1a7f37; } .status-FAILED { color: #cf222e; }
  .status-CANCELLED, .status-EXPIRED { color: #9a6700; }
  .muted { opacity: 0.65; } form { display: flex; gap: 0.5rem; }
  input { font: inherit; padding: 0.25rem 0.5rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

/** Render the execution view (receipt, route, cost, artifacts, verification, events). */
async function renderExecution(client: ZeckClient, executionId: string): Promise<string> {
  const [execution, result, events] = await Promise.all([
    client.getExecution(executionId),
    client.getResult(executionId),
    client.listEvents(executionId),
  ]);
  const rows = (values: readonly (readonly [string, string])[]): string =>
    values.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");

  return page(
    `execution ${executionId}`,
    `<h1>Execution <span class="muted">${esc(executionId)}</span></h1>
     <table>${rows([
       ["status", execution.status],
       ["created", execution.createdAt],
       ["terminal", execution.terminalAt ?? "—"],
       ["application", execution.applicationId],
     ])}</table>
     <h2>Route</h2>
     <table>${rows(
       result.route === null
         ? [["route", "not planned on the ledger yet"]]
         : [
             ["provider", result.route.provider ?? "(deterministic)"],
             ["model", result.route.model ?? "—"],
             ["strategy", result.route.strategyClass ?? "—"],
             ["model calls", String(result.route.modelCalls)],
           ],
     )}</table>
     <h2>Cost</h2>
     <table>${rows(
       result.cost === null
         ? [["cost", "no settled cost facts yet"]]
         : [["total", `${result.cost.totalMicroUsd} micro-USD`]],
     )}</table>
     <h2>Verification evidence</h2>
     ${
       result.verification.length === 0
         ? '<p class="muted">no verification results recorded</p>'
         : `<table><tr><th>status</th><th>criterion</th><th>strategy</th><th>evaluator</th></tr>${result.verification
             .map(
               (v) =>
                 `<tr><td>${esc(v.status)}</td><td>${esc(v.criterionId)}</td><td>${esc(v.strategy)}</td><td>${esc(v.evaluator.kind)}:${esc(v.evaluator.id)}</td></tr>`,
             )
             .join("")}</table>`
}
     <h2>Output artifacts</h2>
     ${
       result.outputArtifacts.length === 0
         ? '<p class="muted">none</p>'
         : `<table><tr><th>id</th><th>digest</th></tr>${result.outputArtifacts
             .map((a) => `<tr><td>${esc(a.id)}</td><td>${esc(a.digest ?? "—")}</td></tr>`)
             .join("")}</table>`
}
     <h2>Events (${events.length})</h2>
     <table><tr><th>#</th><th>type</th><th>occurred</th></tr>${events
       .map(
         (event) =>
           `<tr><td>${esc(event.sequence)}</td><td>${esc(event.type)}</td><td>${esc(event.occurredAt)}</td></tr>`,
       )
       .join("")}</table>
     ${
       execution.status === "COMPLETED" || execution.terminalAt !== null
         ? ""
         : `<form method="post" action="/executions/${esc(executionId)}/cancel"><button type="submit">Cancel execution (governed command)</button></form>`
}`,
  );
}

/** Render the agent inventory view. */
async function renderAgents(client: ZeckClient): Promise<string> {
  const agents = await client.listAgents();
  return page(
    "agents",
    `<h1>Agent inventory</h1>
     <p class="muted">read-only governed projection over the agents authority</p>
     ${
       agents.length === 0
         ? '<p class="muted">no registered agents</p>'
         : `<table><tr><th>slug</th><th>status</th><th>active version</th><th>id</th></tr>${agents
             .map(
               (agent) =>
                 `<tr><td>${esc(agent.slug)}</td><td>${esc(agent.status)}</td><td>${esc(agent.activeVersion ?? "—")}</td><td>${esc(agent.id)}</td></tr>`,
             )
             .join("")}</table>`
}`,
  );
}

/** Render the index (execution lookup + agents link). */
function renderIndex(): string {
  return page(
    "zeck dashboard",
    `<h1>Zeck developer dashboard</h1>
     <form method="get" action="/executions">
       <input name="id" placeholder="execution id" required>
       <button type="submit">Inspect execution</button>
     </form>
     <p><a href="/agents">Agent inventory (read-only governed view)</a></p>`,
  );
}

/**
 * Create the dashboard HTTP server (a projection surface: every request
 * reads through the SDK — no local state, M24).
 */
export function createDashboard(options: DashboardOptions): {
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
} {
  const client = createZeckClient({
    baseUrl: options.apiUrl,
    token: options.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const port = options.port ?? 4545;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderIndex());
        return;
      }
      if (request.method === "GET" && url.pathname === "/agents") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await renderAgents(client));
        return;
      }
      const executionMatch = /^\/executions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && executionMatch !== null) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await renderExecution(client, decodeURIComponent(executionMatch[1] ?? "")));
        return;
      }
      // The ONE governed command: cancel through the API's cancel route.
      const cancelMatch = /^\/executions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch !== null) {
        await readBody(request);
        const receipt = await client.cancelExecution(decodeURIComponent(cancelMatch[1] ?? ""));
        response.writeHead(303, { location: `/executions/${receipt.executionId}` });
        response.end();
        return;
      }
      const lookupMatch = url.searchParams.get("id");
      if (request.method === "GET" && url.pathname === "/executions" && lookupMatch !== null) {
        response.writeHead(303, { location: `/executions/${encodeURIComponent(lookupMatch)}` });
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(page("not found", "<h1>not found</h1>"));
    } catch (error) {
      // The dashboard's own error surface: the public error shape only
      // (never stack traces — M25).
      response.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      const message = error instanceof Error ? error.message : "unknown failure";
      response.end(page("error", `<h1>upstream failure</h1><p>${esc(message)}</p>`));
    }
  });

  return { server, port };
}

/** Direct-execution entry (bun run apps/dashboard/index.ts). */
if (process.argv[1]?.endsWith("apps/dashboard/index.ts") === true) {
  const token = process.env.ZECK_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("error: ZECK_TOKEN is not set");
    process.exit(1);
  }
  const { server, port } = createDashboard({
    apiUrl: process.env.ZECK_API_URL ?? "http://127.0.0.1:3000",
    token,
    port: Number(process.env.DASHBOARD_PORT ?? 4545),
  });
  server.listen(port, () => {
    console.log(`zeck dashboard listening on http://127.0.0.1:${port}`);
  });
}
