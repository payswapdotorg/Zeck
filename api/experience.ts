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
 * layer — https://vercel.com/docs/routing/rewrites) dispatch every
 * user-visible EXPERIENCE route (PPR-015's corrected public shape:
 * /home — the canonical Home — plus /console/*, /trust/*, /admin/*,
 * /runs/*, /build/*, /deployments/*, /assets/*, /improve/*, /command,
 * /attention, /mode and /appearance) to THIS function, carrying the
 * ORIGINAL experience path in the `path` query parameter (the
 * documented capture-to-query conversion); the ROOT / lands on the
 * Home experience through the `redirects` entry (→ /home — the
 * framework's root function is a filesystem match for "/" and shadows
 * any root rewrite; the live plane's finding, correction #8; PPR-015
 * retargeted the bridge from /console to /home — the Home-masquerade
 * defect). The architecture-pinned machine routes (/agents,
 * /executions, /credentials, /sandbox/*, /health, /identity, ...) stay
 * on the API function — the rewrites never shadow the frozen public
 * API contract (the dashboard's agents UI lives at /build/agents; the
 * derived projection is deploy/experience-routing.ts).
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
 * routing carry passes through unchanged). The guard fires on BOTH
 * rails: the source rail (`api/experience.ts`) AND the BUILT ARTIFACT
 * rail — the Vercel output's transpiled `api/experience.js`, the exact
 * entrypoint §13.6's local artifact proof documents (`node
 * api/experience.js` from inside `api/experience.func`); the
 * transpiled file carries this guard verbatim, and there argv[1]
 * ends with `.js`. On the platform the launcher imports the module
 * for its default export (the guard stays dormant) or runs it as the
 * main module (the bind is the serving path either way — the same
 * "the platform captures the listen" shape the root server.ts entry
 * proves unconditionally in production).
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
// composed listener as a real listener when the module is run directly —
// on either rail: the source (`api/experience.ts`) or the Vercel
// output's transpiled artifact (`api/experience.js`, §13.6's documented
// artifact-proof entrypoint).
const directRunEntry = process.argv[1] ?? "";
const isDirectRun =
  directRunEntry.endsWith("api/experience.ts") === true ||
  directRunEntry.endsWith("api/experience.js") === true;
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 3001);
  const server = createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`zeck experience surface listening on http://127.0.0.1:${port}`);
  });
}
