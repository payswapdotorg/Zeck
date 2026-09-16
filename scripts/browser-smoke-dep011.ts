/**
 * The DEP-011 browser-smoke stack runner: boots the REAL API server
 * (in-memory world) and the REAL dashboard route table with the REAL
 * credential transport on FIXED ports, and stays alive until killed —
 * the stack a real browser drives for the issue → reveal → list →
 * rotate → revoke smoke (agent-browser verification).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createDashboardRoutes } from "../apps/dashboard/pages";
import { createCredentialConsoleTransport } from "../apps/dashboard/credentials";
import {
  FormTooLargeError,
  matchRoute,
  parseCookies,
  readFormBody,
  sendResult,
} from "../apps/dashboard/http";
import { createZeckClient } from "../sdk";
import { seedApiWorld } from "../tests/unit/api/world";

const API_PORT = 3901;
const DASH_PORT = 3902;

const world = await seedApiWorld();
await world.server.app.listen({ port: API_PORT, host: "127.0.0.1" });
const apiBase = `http://127.0.0.1:${API_PORT}`;

const client = createZeckClient({
  baseUrl: apiBase,
  token: world.bearerToken,
  applicationId: world.applicationId,
});
const credentials = createCredentialConsoleTransport({
  baseUrl: apiBase,
  token: world.bearerToken,
  applicationId: world.applicationId,
});
const routes = createDashboardRoutes(client, {
  applicationId: world.applicationId,
  credentials,
});

const server = createServer((request, response) => {
  void dispatch(request, response).catch(() => {
    response.destroy();
  });
});

async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard.local");
  const method = request.method === "POST" ? "POST" : "GET";
  const match = matchRoute(routes, method, url.pathname);
  const cookies = parseCookies(request.headers.cookie);
  if (match === null) {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("not found");
    return;
  }
  let form: Record<string, string> = {};
  if (method === "POST") {
    try {
      form = await readFormBody(request);
    } catch (error) {
      if (error instanceof FormTooLargeError) {
        response.writeHead(413, { "content-type": "text/html; charset=utf-8" });
        response.end("too large");
        return;
      }
      throw error;
    }
  }
  const result = await match.route.handler({
    method,
    path: url.pathname,
    params: match.params,
    query: url.searchParams,
    cookies,
    form,
  });
  sendResult(response, result);
}

await new Promise<void>((resolve) => server.listen(DASH_PORT, "0.0.0.0", resolve));
console.log(`DEP-011 browser-smoke stack: dashboard http://127.0.0.1:${DASH_PORT} (api ${apiBase})`);
console.log("keys page: /console/applications/keys");

// Stay alive until killed.
setInterval(() => {}, 60_000);
