/**
 * The Fastify API server — the transport-only composition of the public
 * product surface (WORK-015 / API-001..005).
 *
 * TRANSPORT ONLY (IMPLEMENTATION.md §3 / the api-boundary architecture
 * rule): every route delegates to a module AUTHORITY through its public
 * contract. This server:
 *  - authenticates each request through the injected `authenticate`
 *    seam (credential transport → `Principal`, the auth module's
 *    contract — an already-authenticated actor reference);
 *  - derives the effective application/tenant scope SERVER-SIDE through
 *    the auth module's scope resolver (durable membership/ownership —
 *    never client assertions);
 *  - serializes every response through the secret-safety boundary
 *    (`serialization.ts` — allowlist construction + scrub guard);
 *  - maps every failure to the canonical public error taxonomy
 *    (`error-mapper.ts` — no SQL, no stack traces, no host paths);
 *  - carries the signed/versioned webhook delivery transport (API-004).
 *
 * DEPENDENCY-INJECTED BY DESIGN: the production wiring (SQL stores, the
 * pg DatabasePort adapter, the platform secret store) lives in the
 * composition root that CONSTRUCTS the module services — those arrive
 * here fully formed through their public interfaces. The API surface
 * imports module public barrels and src/shared only (the scanner-pinned
 * boundary).
 */

import Fastify, { type FastifyInstance } from "fastify";
import type { AgentRegistry } from "../modules/agents/public";
import type { ScopeResolver } from "../modules/auth/public";
import type { EconomicActionService } from "../modules/economics/public";
import type { ExecutionService } from "../modules/executions/public";
import type { OpportunityAnalyzer } from "../modules/learning/public";
import { PlatformError } from "../shared/errors";
import type { Authenticate } from "./request-identity";
import { registerAgentRoutes } from "./routes/agents";
import { registerCodebaseAnalysisRoutes } from "./routes/codebase-analysis";
import { registerEconomicActionRoutes } from "./routes/economic-actions";
import { registerExecutionRoutes } from "./routes/executions";
import type { DependencyReadinessWire } from "./routes/health";
import { registerHealthRoutes } from "./routes/health";

export interface ApiServerDeps {
  readonly executions: ExecutionService;
  readonly agents: AgentRegistry;
  /** The economics AUTHORITY (WORK-032 economic-action surface). */
  readonly economics: EconomicActionService;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
  /**
   * The agent inventory enumeration seam (the agents authority's listing
   * surface, wired by the composition — see routes/agents.ts).
   */
  readonly listAgentIdsOfApplication: (applicationId: string) => Promise<readonly string[]>;
  /**
   * The codebase-opportunity ADVISORY analyzer (the learning module's
   * public surface, WORK-022 — advisory evidence, never an authority).
   * The routes compose it WITH the executions authority ("Analysis is
   * an Execution": policy admission before codebase access).
   */
  readonly codebaseAnalyzer: OpportunityAnalyzer;
  /**
   * The deployment dependency readiness probe (WORK-042 AC6): the
   * composition-owned evaluation of infrastructure dependency
   * readiness behind the ports. Transport reports it; it never
   * computes it (see src/platform/deployment/readiness.ts).
   */
  readonly dependencyReadiness: () => Promise<readonly DependencyReadinessWire[]>;
}

export interface ApiServer {
  readonly app: FastifyInstance;
  /** The registered routes (method + url) — introspected via onRoute. */
  readonly routes: readonly { readonly method: string; readonly url: string }[];
}

/** Build the public API server over the injected module authorities. */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  const app = Fastify({ logger: false });

  // The route introspection table (the onRoute hook must be registered
  // BEFORE the routes to capture every one of them; Fastify's automatic
  // HEAD siblings are filtered — GET/POST are the surface verbs).
  const routeTable: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    const method = Array.isArray(route.method) ? route.method.join("|") : route.method;
    if (method === "HEAD") {
      return;
    }
    routeTable.push({ method, url: route.url });
  });

  registerExecutionRoutes(app, {
    executions: deps.executions,
    scopeResolver: deps.scopeResolver,
    authenticate: deps.authenticate,
  });
  registerAgentRoutes(app, {
    agents: deps.agents,
    scopeResolver: deps.scopeResolver,
    authenticate: deps.authenticate,
    listAgentIdsOfApplication: deps.listAgentIdsOfApplication,
  });
  registerEconomicActionRoutes(app, {
    economics: deps.economics,
    scopeResolver: deps.scopeResolver,
    authenticate: deps.authenticate,
  });
  registerCodebaseAnalysisRoutes(app, {
    executions: deps.executions,
    analyzer: deps.codebaseAnalyzer,
    scopeResolver: deps.scopeResolver,
    authenticate: deps.authenticate,
  });
  registerHealthRoutes(app, {
    dependencyReadiness: deps.dependencyReadiness,
  });

  return {
    app,
    get routes(): readonly { readonly method: string; readonly url: string }[] {
      return [...routeTable].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    },
  };
}

/** A bearer-token authenticator over an injected token→principal map. */
export function createBearerTokenAuthenticator(
  resolvePrincipal: (token: string) => Promise<{ readonly actorId: string } | null>,
): Authenticate {
  return async (request) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new PlatformError({
        code: "AUTHENTICATION_FAILED",
        message: "missing bearer credential (expected: Authorization: Bearer <token>)",
      });
    }
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) {
      throw new PlatformError({
        code: "AUTHENTICATION_FAILED",
        message: "empty bearer credential",
      });
    }
    const principal = await resolvePrincipal(token);
    if (principal === null) {
      throw new PlatformError({ code: "AUTHENTICATION_FAILED", message: "invalid credential" });
    }
    return {
      actorId: principal.actorId,
      authenticatedAt: new Date().toISOString(),
    };
  };
}
