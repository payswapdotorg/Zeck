/**
 * api/experience.ts — the experience Serverless Function entry (PPR-007,
 * the Experience-Surface Deployment).
 *
 * THE DOCUMENTED HOSTING SHAPE (Vercel's `api` directory Serverless
 * Functions convention — https://vercel.com/docs/functions): a project
 * may carry ADDITIONAL Serverless Functions next to a framework build's
 * root entry — files under the `api/` directory are detected as
 * functions and served at their path (this file: /api/experience). The
 * ROOT server.ts (PPR-006's Fastify FRAMEWORK entry — the one root
 * entry the framework detection allows) is NOT touched: the API plane
 * serves every non-experience path exactly as before, and vercel.json's
 * `rewrites` (the platform's sanctioned same-application routing
 * layer — https://vercel.com/docs/routing/rewrites) dispatch
 * /console/*, /trust/*, /admin/*, the root / and the composition's own
 * static asset /assets/client.js to THIS function, carrying the
 * ORIGINAL experience path in the `path` query parameter (the
 * documented capture-to-query conversion).
 *
 * THE COMPOSITION (once per isolate — cold start builds, warm requests
 * reuse): deploy/experience.ts's getExperienceHandler() builds PPR-001's
 * console composition over the dashboard's additive request-listener
 * export and memoizes it at module scope. Environment contract
 * (deploy/PUBLIC-DEPLOYMENT.md §13.4): ZECK_EXPERIENCE_API_URL +
 * ZECK_EXPERIENCE_APPLICATION_ID are required (structural
 * misconfiguration fails the isolate closed at cold start);
 * ZECK_EXPERIENCE_TOKEN may be UNBOUND — the pages still serve and
 * render their designed honest unauthenticated/permission states (the
 * projection surface's degradation; nothing fabricates).
 *
 * THE LOCAL RAIL: on a local run (`bun api/experience.ts`) the listener
 * binds for real (PORT, default 3001) so the composed shape — the
 * experience entry against a locally-booted API plane — can be proven
 * before any deployment (the local-rail proof of the work order; on
 * the local rail requests arrive with their original paths and the
 * routing carry passes through unchanged).
 */

/// <reference types="node" />
// The Vercel build synthesizes its transpilation config in a temp
// directory, where the default @types auto-inclusion walk cannot see
// the repository's node_modules — this explicit reference anchors the
// node types for this function's whole import graph (the same anchor
// the server.ts graph receives transitively through @types/pg).

import { createServer } from "node:http";
import { getExperienceHandler } from "../deploy/experience";

const handler = getExperienceHandler();

/** The Vercel function's request listener (the Node request handler shape). */
export default handler;

// The local-rail affordance (mirrors root server.ts): boot the exact
// composed listener as a real listener when the module is run directly.
if (process.argv[1]?.endsWith("api/experience.ts") === true) {
  const port = Number(process.env.PORT ?? 3001);
  const server = createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`zeck experience surface listening on http://127.0.0.1:${port}`);
  });
}
