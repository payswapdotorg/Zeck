/**
 * server.ts — the Vercel function entry (PPR-006, the
 * Experience-Delivery Enabler).
 *
 * THE DOCUMENTED HOSTING SHAPE (Vercel's Fastify framework entrypoint
 * detection — https://vercel.com/docs/frameworks/backend/fastify): the
 * entry lives at the project root named server.{ts}, imports fastify,
 * and calls `fastify.listen()` in this file. Vercel's runtime loads
 * this module ONCE PER ISOLATE, captures the Fastify server the
 * listen call creates, and routes EVERY incoming request into
 * Fastify's router with the ORIGINAL path — so the deployed surface is
 * the repository's public route table at its root paths (GET /health,
 * GET /identity, POST /executions, ...), byte-for-byte the semantics
 * the CLI host (deploy/api.ts) serves.
 *
 * THE COMPOSITION (once per isolate — cold start builds, warm requests
 * reuse): getVercelPlane() builds the SAME bootstrap composition as
 * the CLI host through the shared builder (deploy/api.ts's
 * buildBootstrapApp — real transport, real deployment seams, honestly
 * unbound domain capabilities) and memoizes it at module scope. The
 * composition's deployment-time inputs are the environment variables
 * recorded in deploy/PUBLIC-DEPLOYMENT.md §13 (ZECK_ENVIRONMENT,
 * ZECK_DEPLOY_GIT_REVISION, the materialized dependency variables and
 * the VERCEL_GIT_COMMIT_REF system variable for the preview branch);
 * absent required inputs fail the isolate closed at cold start —
 * never a fabricated identity.
 *
 * THE LISTEN CALL: on Vercel the platform captures the server the call
 * creates (the port and host do not configure the public endpoint);
 * on a LOCAL run (`bun server.ts`) the listener binds for real — the
 * port comes from PORT (default 3000) — so the entry can be smoked
 * with the exact `deploy:public-smoke -- --url <base-url>` path the
 * credentialed deployment run executes against the live plane.
 *
 * vercel.json (project root) carries the functions configuration for
 * this entry: the deliberate maxDuration bound and the includeFiles
 * glob that ships deploy/manifests/*.json into the function bundle
 * (the composition reads the manifest set from disk at runtime).
 */

import type { FastifyInstance } from "fastify";
import { getVercelPlane, installVercelPlaneSignalDrain } from "./deploy/vercel";

const plane = getVercelPlane();
installVercelPlaneSignalDrain(plane);

const app: FastifyInstance = plane.app;
app
  .listen({ port: Number(process.env.PORT ?? 3000), host: "127.0.0.1" })
  .catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
