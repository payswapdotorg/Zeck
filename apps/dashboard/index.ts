/**
 * Zeck developer dashboard — a read/compose projection surface over the
 * public API (WORK-015/WORK-033; acceptance criterion 4, M7/M24).
 *
 * A PROJECTION, NEVER A REGISTRY (M24): the dashboard holds NO state of
 * its own — every view is rendered from a LIVE read through the Zeck SDK
 * client (which talks to the API, which delegates to the authorities).
 * The only cookies are the disclosed navigation-only recents list and
 * the appearance preference — both presentation state, never facts.
 *
 * APPLICATION SCOPING (WORK-034 reconciliation): the SDK client is
 * CONSTRUCTED with this deployment's application scope — every scoped
 * read (execution detail/results/events/verification, agent inventory)
 * and every governed command (cancel) sends the canonical
 * X-Zeck-Application header the real API requires and derives its
 * effective tenant/application scope from. Creation keeps its
 * per-request `applicationId` in the request body (the wire contract's
 * split selector). A scopeless dashboard cannot exist by construction:
 * the option is required and validated at startup (fail fast at the
 * deployment boundary, never a broken view).
 *
 * THE ROUTES: the UX §3 experience shell (Home/Build/Runs/Assets/
 * Improve/Admin), the execution work surface (Result | Evidence |
 * Activity + How Zeck did it), the two-step create flow, the governed
 * cancel flow, the command/search surface — plus every legacy path
 * (POST /executions/:id/cancel, GET /executions/:id, GET /executions?id=).
 * The ONLY mutations are createExecution and cancelExecution, always
 * through the SDK client.
 *
 * SECRET SAFETY (M7): the dashboard renders only the public wire shapes
 * (receipt/route/cost/artifacts/verification/agent inventory), escapes
 * all interpolated values, and redacts secret-shaped fields defensively.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createZeckClient, ZeckApiError, type ZeckClient } from "../../sdk";
import { esc } from "./components";
import {
  FormTooLargeError,
  type HandlerResult,
  type HttpContext,
  matchRoute,
  parseCookies,
  type RouteDefinition,
  readFormBody,
  sendResult,
} from "./http";
import { modeOf } from "./modes";
import { createDashboardRoutes } from "./pages";
import { appShell, pageHead } from "./shell";
import { errorState, permissionDeniedState } from "./states";

export interface DashboardOptions {
  /** The Zeck API base URL the dashboard reads through. */
  readonly apiUrl: string;
  /** The Zeck transport credential (from env; never rendered). */
  readonly token: string;
  /**
   * The application whose scope authorizes every scoped read and
   * governed command (WORK-034): bound into the SDK client at
   * construction and sent as the canonical X-Zeck-Application header
   * the API requires — the effective scope is still derived
   * server-side. Required: a dashboard without an application scope
   * could create but never render, so it fails fast here instead.
   */
  readonly applicationId: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The dashboard's own error surfaces: the public error shape only (M25).
 *
 * WORK-041 (context restoration): every error surface passes ctx.path as
 * the no-script preference fallback's returnTo — the same foundation rule
 * every content page follows (WORK-035: "Current path for the no-script
 * appearance/mode fallback redirect"). Applying a mode or appearance
 * change on an error page returns to the SAME view (re-rendered in the
 * new presentation), never a bounce to Home that loses the user's place.
 */
function apiErrorResponse(error: ZeckApiError, ctx: HttpContext): HandlerResult {
  const { code, message, retryable } = error.body;
  if (error.status === 401 || error.status === 403) {
    return {
      status: 403,
      html: appShell({
        title: "Zeck — Not authorized",
        activePath: ctx.path,
        mode: modeOf(ctx.cookies),
        mainContent: `${pageHead({ title: "Not authorized", path: ctx.path })}\n${permissionDeniedState(
          "The governed API denied this view",
          message,
          `${code}${retryable ? " — retryable" : ""}`,
        )}`,
        returnTo: ctx.path,
      }),
    };
  }
  if (error.status === 404) {
    return {
      status: 404,
      html: appShell({
        title: "Zeck — Not found",
        activePath: ctx.path,
        mode: modeOf(ctx.cookies),
        mainContent: `${pageHead({ title: "Not found", path: ctx.path })}\n${errorState(
          "Not found through the governed API",
          message,
          `${code}${retryable ? " — retryable" : ""}`,
        )}`,
        returnTo: ctx.path,
      }),
    };
  }
  return {
    status: 502,
    html: appShell({
      title: "Zeck — Upstream failure",
      activePath: ctx.path,
      mode: modeOf(ctx.cookies),
      mainContent: `${pageHead({ title: "Upstream failure", path: ctx.path })}\n${errorState(
        "The Zeck API could not complete this view",
        message,
        `${code}${retryable ? " — retryable" : ""}`,
      )}`,
      returnTo: ctx.path,
    }),
  };
}

function transportErrorResponse(ctx: HttpContext): HandlerResult {
  return {
    status: 502,
    html: appShell({
      title: "Zeck — Upstream failure",
      activePath: ctx.path,
      mode: modeOf(ctx.cookies),
      mainContent: `${pageHead({ title: "Upstream failure", path: ctx.path })}\n${errorState(
        "The dashboard could not reach the Zeck API",
        "The live read through the governed API failed; no further detail is exposed. Retry, or check the API availability.",
        "Every dashboard view is a live read — there is no cached fallback.",
      )}`,
      returnTo: ctx.path,
    }),
  };
}

function notFoundResponse(ctx: HttpContext): HandlerResult {
  return {
    status: 404,
    html: appShell({
      title: "Zeck — Not found",
      activePath: ctx.path,
      mode: modeOf(ctx.cookies),
      mainContent: `${pageHead({ title: "Not found", path: ctx.path })}\n${errorState(
        "This page does not exist",
        `No route matches "${ctx.path}". Use the navigation or the command bar.`,
      )}`,
      returnTo: ctx.path,
    }),
  };
}

function tooLargeResponse(ctx: HttpContext): HandlerResult {
  return {
    status: 413,
    html: appShell({
      title: "Zeck — Form too large",
      activePath: ctx.path,
      mode: modeOf(ctx.cookies),
      mainContent: `${pageHead({ title: "Form too large", path: ctx.path })}\n${errorState(
        "The submitted form was too large",
        "The dashboard caps form bodies at 64 KiB; submit a smaller request.",
      )}`,
      returnTo: ctx.path,
    }),
  };
}

async function dispatch(
  routes: readonly RouteDefinition[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard.local");
  const method = request.method === "POST" ? "POST" : "GET";
  const match = matchRoute(routes, method, url.pathname);
  const cookies = parseCookies(request.headers.cookie);
  if (match === null) {
    const ctx: HttpContext = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      cookies,
      form: {},
    };
    sendResult(response, notFoundResponse(ctx));
    return;
  }
  let form: Record<string, string> = {};
  if (method === "POST") {
    try {
      form = await readFormBody(request);
    } catch (error) {
      // The size cap fires BEFORE the handler runs (413, never a raw
      // transport failure page).
      const ctx: HttpContext = {
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        cookies,
        form: {},
      };
      if (error instanceof FormTooLargeError) {
        sendResult(response, tooLargeResponse(ctx));
        return;
      }
      throw error;
    }
  }
  const ctx: HttpContext = {
    method,
    path: url.pathname,
    params: match.params,
    query: url.searchParams,
    cookies,
    form,
  };
  try {
    const result = await match.route.handler(ctx);
    sendResult(response, result);
  } catch (error) {
    if (error instanceof ZeckApiError) {
      sendResult(response, apiErrorResponse(error, ctx));
      return;
    }
    sendResult(response, transportErrorResponse(ctx));
  }
}

/**
 * Create the dashboard HTTP server (a projection surface: every request
 * reads through the SDK — no local state, M24). The SDK client is bound
 * to the deployment's application scope (WORK-034) at construction.
 */
export function createDashboard(options: DashboardOptions): {
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
  readonly routes: readonly RouteDefinition[];
} {
  if (typeof options.applicationId !== "string" || options.applicationId.trim().length === 0) {
    throw new Error(
      "DashboardOptions.applicationId must be a non-empty string: the application whose scope authorizes the dashboard's scoped reads and governed commands (set ZECK_APPLICATION_ID for direct execution)",
    );
  }
  const client: ZeckClient = createZeckClient({
    baseUrl: options.apiUrl,
    token: options.token,
    applicationId: options.applicationId,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const port = options.port ?? 4545;
  const routes = createDashboardRoutes(client);
  const server = createServer((request, response) => {
    void dispatch(routes, request, response).catch(() => {
      try {
        if (response.headersSent !== true) {
          response.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        }
        response.end(
          `<html lang="en"><head><meta charset="utf-8"><title>Zeck — Upstream failure</title></head><body><h1>Upstream failure</h1><p>${esc(
            "The dashboard could not complete this request; no further detail is exposed.",
          )}</p></body></html>`,
        );
      } catch {
        // Headers/body already crossed the wire: nothing left to send.
        response.destroy();
      }
    });
  });
  return { server, port, routes };
}

/** Direct-execution entry (bun run apps/dashboard/index.ts). */
if (process.argv[1]?.endsWith("apps/dashboard/index.ts") === true) {
  const token = process.env.ZECK_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("error: ZECK_TOKEN is not set");
    process.exit(1);
  }
  const applicationId = process.env.ZECK_APPLICATION_ID;
  if (applicationId === undefined || applicationId.length === 0) {
    console.error("error: ZECK_APPLICATION_ID is not set");
    process.exit(1);
  }
  const { server, port } = createDashboard({
    apiUrl: process.env.ZECK_API_URL ?? "http://127.0.0.1:3000",
    token,
    applicationId,
    port: Number(process.env.DASHBOARD_PORT ?? 4545),
  });
  server.listen(port, () => {
    console.log(`zeck dashboard listening on http://127.0.0.1:${port}`);
  });
}
