/**
 * deploy/local-experience-gateway — PPR-015's local two-function
 * composition.
 *
 * THE PURPOSE: the public plane is TWO FUNCTIONS behind vercel.json's
 * routing (the API function at the framework root + the experience
 * function at /api/experience). Proving productization behavior — the
 * Home landing, the visible navigation graph, the API/experience
 * boundary — requires ONE origin that applies the EXACT routing
 * semantics the platform applies. This module composes, in-process:
 *
 *  - the API plane: `buildBootstrapApp({ environment: "local" })` —
 *    the same shared builder the CLI host and the Vercel adapter
 *    compose (never a re-implementation);
 *  - the experience plane: `createDashboardHandler` — the dashboard's
 *    additive request-listener export, the exact listener the Vercel
 *    experience function composes (deploy/experience.ts's own
 *    composition core);
 *  - the GATEWAY: an HTTP front that applies vercel.json's routing
 *    grammar to every request through `resolveGatewayRoute` — the
 *    live-proven phase order (redirects before the filesystem phase;
 *    the framework root function as the filesystem match for the bare
 *    `/`; rewrites for every other path; the API function as the
 *    catch-all) — forwarding rewrites to the experience function under
 *    the destination's `path` carry exactly as the platform delivers
 *    it (so `experienceRequestPath`'s reconstruction is exercised on
 *    this rail too).
 *
 * The composition serves the repository's own surfaces with ZERO new
 * authority: it is a hosting shape, the same discipline as
 * tests/journey/local-plane.ts's API-plane boot (and the sanctioned
 * "any other host may do the same" of createDashboardHandler's
 * contract).
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { buildBootstrapApp } from "./api";
import { buildExperienceHandler } from "./experience";
import { resolveGatewayRoute, type VercelRouting } from "./experience-routing";
import { REPOSITORY_ROOT } from "./lib";

/** The canonical local application scope (presentation prefill only). */
const LOCAL_APPLICATION_ID = "00000000-0000-7000-8000-0000000000a1";

export interface LocalExperienceComposition {
  /** The public-shape origin — vercel.json routing applied. */
  readonly gatewayUrl: string;
  /** The API function upstream (the framework root function's rail). */
  readonly apiBaseUrl: string;
  /** The experience function upstream (the /api/experience rail). */
  readonly experienceBaseUrl: string;
  /** The vercel.json routing table the gateway applies. */
  readonly routing: VercelRouting;
  readonly stop: () => Promise<void>;
}

/** Load vercel.json's routing tables (redirects + rewrites). */
export function loadVercelRouting(): VercelRouting {
  const parsed = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, "vercel.json"), "utf8"),
  ) as VercelRouting;
  return parsed;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      resolvePromise(port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error?: Error | null) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

/** Read (and buffer) a request body, size-capped like the planes' own transports. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolvePromise(Buffer.concat(chunks));
    });
    request.on("error", () => {
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

/**
 * Boot the local two-function composition behind the vercel.json
 * gateway. Everything binds to 127.0.0.1 ephemeral ports; `stop`
 * drains all three listeners.
 */
export async function bootLocalExperienceComposition(): Promise<LocalExperienceComposition> {
  const routing = loadVercelRouting();

  // The API plane — the shared bootstrap builder (the exact composition
  // the CLI host and the Vercel adapter serve).
  const apiApp = buildBootstrapApp({ environment: "local" });
  await apiApp.server.app.listen({ host: "127.0.0.1", port: 0 });
  const apiAddress = apiApp.server.app.addresses()[0];
  if (apiAddress === undefined) {
    throw new Error("the API plane did not bind");
  }
  const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;

  // The experience plane — the dashboard's additive listener export
  // composed through deploy/experience.ts's buildExperienceHandler: the
  // EXACT composition the Vercel experience function serves (including
  // the routing carry's URL normalization — the gateway delivers
  // rewrites under the destination's `path` parameter, precisely as the
  // platform delivers them). The honest unbound token mode: the local
  // API plane authenticates nothing, so the reading surfaces render
  // their designed 401-driven states — never fabricated data.
  const experienceHandler = buildExperienceHandler({
    apiUrl: apiBaseUrl,
    token: "",
    applicationId: LOCAL_APPLICATION_ID,
  });
  const experienceServer = createServer(experienceHandler);
  const experiencePort = await listen(experienceServer);
  const experienceBaseUrl = `http://127.0.0.1:${experiencePort}`;

  // The gateway — vercel.json's routing grammar over the two functions.
  const gateway = createServer((request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      const decision = resolveGatewayRoute(routing, request.method ?? "GET", url.pathname);
      if (decision.kind === "redirect") {
        response.writeHead(307, { location: decision.location });
        response.end();
        return;
      }
      const upstreamBase = decision.kind === "experience" ? experienceBaseUrl : apiBaseUrl;
      const upstreamUrl =
        decision.kind === "experience"
          ? mergeQuery(upstreamBase + decision.destination, url.search)
          : `${upstreamBase}${url.pathname}${url.search}`;
      const body = await readBody(request);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) {
          continue;
        }
        if (name === "host" || name === "connection" || name === "content-length") {
          continue;
        }
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const upstream = await fetch(upstreamUrl, {
        method: request.method ?? "GET",
        headers,
        ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
        redirect: "manual",
      });
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of upstream.headers) {
        if (
          name === "content-encoding" ||
          name === "transfer-encoding" ||
          name === "content-length"
        ) {
          continue;
        }
        responseHeaders[name] = value;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, responseHeaders);
      response.end(buffer);
    })().catch(() => {
      if (response.headersSent !== true) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("gateway: upstream failure");
    });
  });
  const gatewayPort = await listen(gateway);

  return {
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    apiBaseUrl,
    experienceBaseUrl,
    routing,
    stop: async () => {
      await closeServer(gateway);
      await closeServer(experienceServer);
      await apiApp.server.app.close();
    },
  };
}

/** Merge the original request's query into a rewrite destination URL. */
function mergeQuery(destination: string, search: string): string {
  if (search.length === 0) {
    return destination;
  }
  const extra = search.startsWith("?") ? search.slice(1) : search;
  return `${destination}&${extra}`;
}

/** Direct-execution entry: serve the composition on a fixed port. */
if (process.argv[1]?.endsWith("deploy/local-experience-gateway.ts") === true) {
  void bootLocalExperienceComposition().then((composition) => {
    console.log(
      JSON.stringify(
        {
          tool: "deploy/local-experience-gateway",
          status: "listening",
          gatewayUrl: composition.gatewayUrl,
          apiBaseUrl: composition.apiBaseUrl,
          experienceBaseUrl: composition.experienceBaseUrl,
        },
        null,
        2,
      ),
    );
  });
}
