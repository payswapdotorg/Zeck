/**
 * deploy/experience — the experience-surface hosting adapter (PPR-007,
 * the Experience-Surface Deployment).
 *
 * THE COMPOSITION: this adapter builds PPR-001's console composition
 * (apps/dashboard — a read/compose PROJECTION over the public API
 * through the Zeck SDK; it holds NO state and adds NO authority) through
 * the dashboard's ADDITIVE request-listener export
 * (`createDashboardHandler` — the exact listener `createDashboard`'s
 * `createServer` wraps), ONCE PER ISOLATE (the module-level singleton
 * below, mirroring deploy/vercel.ts's cold-start pattern: cold start
 * builds, warm requests reuse the built handler).
 *
 * THE HOSTING CONTRACT (verified against the current Vercel
 * documentation, 2026-09-22 — sources recorded in
 * deploy/evidence/ppr-007.json):
 *  - the experience surface is an ADDITIONAL Serverless Function in the
 *    `api` directory (api/experience.ts — the documented convention:
 *    functions are created from files under `api/`), served at
 *    /api/experience next to the ROOT server.ts Fastify FRAMEWORK
 *    entry (Vercel's framework detection allows ONE root entry per
 *    framework build; additional functions ride the `api` directory);
 *  - the dispatch between the two functions is vercel.json `rewrites`
 *    (the platform's sanctioned same-application routing layer): a
 *    rewrite to a Serverless Function CONVERTS the source path captures
 *    into QUERY PARAMETERS on the destination (the documented
 *    /resize/:width/:height → /api/sharp?width=800&height=600
 *    conversion) — so the routing table carries the ORIGINAL
 *    experience path in the `path` query parameter and
 *    `experienceRequestPath` reconstructs it before the dashboard
 *    dispatch (on a LOCAL rail, requests arrive with their original
 *    paths and pass through unchanged);
 *  - the routing split: /console/*, /trust/*, /admin/*, the root / and
 *    the composition's own static asset /assets/client.js route to the
 *    experience function (the asset is required by the served shell —
 *    the journey harness's resource-integrity dimension; the API plane
 *    serves NO /assets path, so no API route changes); EVERY other
 *    path routes to the existing API function (PPR-006's entry),
 *    unchanged in behavior.
 *
 * THE ENVIRONMENT INPUTS (names only — values never transit this
 * repository; see deploy/PUBLIC-DEPLOYMENT.md §13.4 for the deployment
 * contract):
 *  - ZECK_EXPERIENCE_API_URL — the API plane base URL the projection
 *    reads through (the same origin in the preview; REQUIRED — an
 *    experience surface with no API to project is a structural
 *    misconfiguration: the entry fails closed at cold start);
 *  - ZECK_EXPERIENCE_APPLICATION_ID — the application whose scope
 *    authorizes the dashboard's scoped reads (REQUIRED — a scopeless
 *    dashboard cannot exist by construction, WORK-034);
 *  - ZECK_EXPERIENCE_TOKEN — the materialized transport credential of
 *    the dashboard's reads (materialized from
 *    ZECK_SECRET_EXPERIENCE_TOKEN_REF). MAY BE UNBOUND: an unbound
 *    token STILL SERVES — the dashboard pages render their designed
 *    honest unauthenticated/permission states (the projection surface's
 *    degradation; its error states exist for exactly this). Nothing
 *    fabricates: no fabricated data, no synthetic credentials.
 *
 * The adapter owns NO deployment: every live-Vercel step is the Lead's
 * credentialed run (see the notRun registry of
 * deploy/evidence/ppr-007.json).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createDashboardHandler } from "../apps/dashboard/index";

/**
 * The query parameter vercel.json rewrites use to carry the ORIGINAL
 * experience path to the function (the documented capture-to-query
 * conversion of a same-application rewrite to a Serverless Function).
 */
export const EXPERIENCE_PATH_QUERY = "path";

/** The experience-surface hosting entry's inputs (the env contract). */
export interface ExperienceInputs {
  /** The API plane base URL the projection reads through. */
  readonly apiUrl: string;
  /** The transport credential; MAY be empty (the honest unbound mode). */
  readonly token: string;
  /** The application whose scope authorizes the scoped reads. */
  readonly applicationId: string;
}

/**
 * Read the hosting-entry inputs (fail closed on STRUCTURAL
 * misconfiguration only): a missing API URL or application id refuses
 * the isolate at cold start; an UNBOUND TOKEN is a legitimate honest
 * mode — the pages still serve and render their designed
 * unauthenticated/permission states, so the entry does NOT fail on it.
 */
export function readExperienceInputs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperienceInputs {
  const apiUrl = env.ZECK_EXPERIENCE_API_URL ?? "";
  if (apiUrl.trim().length === 0) {
    throw new Error(
      "ZECK_EXPERIENCE_API_URL is not set; the experience surface cannot compose without the API plane base URL it projects (set it in the deployment's environment variables — see deploy/PUBLIC-DEPLOYMENT.md §13.4)",
    );
  }
  const applicationId = env.ZECK_EXPERIENCE_APPLICATION_ID ?? "";
  if (applicationId.trim().length === 0) {
    throw new Error(
      "ZECK_EXPERIENCE_APPLICATION_ID is not set; a scopeless dashboard cannot exist by construction (set the application whose scope authorizes the console's scoped reads — see deploy/PUBLIC-DEPLOYMENT.md §13.4)",
    );
  }
  // The honest unbound mode: an absent/empty token still serves — the
  // dashboard's designed unauthenticated/permission states render, and
  // the API answers its honest 401 AUTHENTICATION_FAILED through them.
  const token = env.ZECK_EXPERIENCE_TOKEN ?? "";
  return { apiUrl, token, applicationId };
}

/**
 * Reconstruct the ORIGINAL experience path of a request as the platform
 * delivers it to the function:
 *  - PLATFORM RAIL (routed by vercel.json rewrites): the request's URL
 *    is the rewritten destination (/api/experience) with the original
 *    path carried in the `path` query parameter — reconstruct
 *    `<carried-path>` plus the request's remaining query (the platform
 *    merges the destination's parameters with the request's own);
 *  - LOCAL RAIL (direct boot): the URL IS the original path — it
 *    passes through unchanged (no `path` parameter is present).
 * A `path` value that is not an absolute path is not a routing carry
 * (a client may legitimately pass its own query parameter of that name
 * to /api/experience) and never rewrites the URL.
 */
export function experienceRequestPath(requestUrl: string | undefined): string {
  const url = new URL(requestUrl ?? "/", "http://experience.local");
  const carried = url.searchParams.get(EXPERIENCE_PATH_QUERY);
  if (carried === null || carried.length === 0 || !carried.startsWith("/")) {
    return `${url.pathname}${url.search}`;
  }
  url.searchParams.delete(EXPERIENCE_PATH_QUERY);
  return `${carried}${url.search}`;
}

/** The experience surface's request listener (a Node request handler). */
export type ExperienceHandler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Build the experience handler over the dashboard's additive listener
 * export: the SAME dispatch, route table and error surfaces the
 * direct-execution host serves — only the request's URL is normalized
 * to the original experience path first (the routing layer's carry),
 * so the composed surface is machine-identical to the direct host.
 */
export function buildExperienceHandler(inputs: ExperienceInputs): ExperienceHandler {
  const dashboard = createDashboardHandler({
    apiUrl: inputs.apiUrl,
    token: inputs.token,
    applicationId: inputs.applicationId,
  });
  return (request: IncomingMessage, response: ServerResponse): void => {
    const original = experienceRequestPath(request.url);
    if (original !== request.url) {
      // The routing carry: dispatch on the ORIGINAL experience path
      // (the rewrite is transparent to the browser — the platform's
      // own semantics; the dashboard router must see the user's URL).
      request.url = original;
    }
    dashboard(request, response);
  };
}

let handlerSingleton: ExperienceHandler | null = null;

/**
 * THE MODULE-LEVEL SINGLETON: the composition builds ONCE PER ISOLATE
 * (cold start builds; warm requests reuse the built handler). The entry
 * (api/experience.ts) calls this at module scope; Vercel's runtime
 * loads the module once per isolate and routes every request into the
 * captured listener.
 */
export function getExperienceHandler(): ExperienceHandler {
  if (handlerSingleton === null) {
    const inputs = readExperienceInputs();
    handlerSingleton = buildExperienceHandler(inputs);
    // The cold-start boot record (operational visibility — the runtime
    // logs carry it; tokenBound is a BOOLEAN, never the credential).
    console.log(
      JSON.stringify({
        tool: "deploy/experience",
        status: "booted",
        apiUrl: inputs.apiUrl,
        applicationId: inputs.applicationId,
        tokenBound: inputs.token.length > 0,
        mode: inputs.token.length > 0 ? "credential-bound" : "honest-unbound",
      }),
    );
  }
  return handlerSingleton;
}
