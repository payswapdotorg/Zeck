/**
 * Agent inventory routes (WORK-015; acceptance criterion 7/8, M14–M23).
 *
 * READ-ONLY GOVERNED PROJECTIONS over the agents authority (§14 of the
 * Work Order): every route delegates to the `AgentRegistry` public
 * surface — the API NEVER writes agent tables and NEVER mutates agent
 * identity/version/credentials/policy/execution state (there is NO
 * agent mutation route here at all; those changes go through their
 * owning authorities):
 *
 *   GET /agents               → inventory projection (registry getters)
 *   GET /agents/:id           → registry.getAgent + currentSelection
 *   GET /agents/:id/versions  → registry.listVersions
 *   GET /agents/:id/status    → the full status view (agent + active
 *                               version + latest selection + versions)
 *
 * The application scope is derived server-side per request (the
 * X-Zeck-Application header names the application whose MEMBERSHIP
 * authorizes the read — the membership/tenant are resolved from durable
 * rows, never from client assertions). Cross-tenant agents are
 * unreachable: every registry getter is application-scoped (M22).
 *
 * The inventory ENUMERATION seam (`listAgentIdsOfApplication`) is
 * injected: the agents module's public surface exposes per-id/slug
 * getters (ACP-001's discoverable catalog record) and its bulk-listing
 * surface is owned by the agents authority — the composition wires this
 * seam to it. The projection itself is fully exercised in the tests
 * (M22: the projected inventory EQUALS the authority's rows).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRegistry } from "../../modules/agents/public";
import type { ScopeResolver } from "../../modules/auth/public";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import type { Authenticate, RequestIdentity } from "../request-identity";
import {
  applicationScopeOf,
  requireStringField,
  resolveRequestIdentity,
} from "../request-identity";
import { toWireAgentStatus, toWireAgentSummary, toWireAgentVersion } from "../serialization";

export interface AgentRoutesDeps {
  /** The agents AUTHORITY (read-only surface used here — M22). */
  readonly agents: AgentRegistry;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
  /**
   * The inventory enumeration seam: the agent ids of an application (the
   * agents authority's listing surface; injected by the composition).
   */
  readonly listAgentIdsOfApplication: (applicationId: string) => Promise<readonly string[]>;
}

async function resolveIdentity(
  deps: AgentRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  applicationId: string,
): Promise<RequestIdentity> {
  return resolveRequestIdentity(
    request,
    reply,
    deps.authenticate,
    deps.scopeResolver,
    applicationId,
  );
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  app.get("/agents", async (request, reply) => {
    try {
      const applicationId = applicationScopeOf(request, "agent inventory reads");
      const identity = await resolveIdentity(deps, request, reply, applicationId);
      void identity;
      const agentIds = await deps.listAgentIdsOfApplication(applicationId);
      const summaries = [];
      for (const agentId of agentIds) {
        const record = await deps.agents.getAgent(applicationId, agentId);
        if (record === null) {
          continue;
        }
        const [versions, selection] = await Promise.all([
          deps.agents.listVersions(applicationId, agentId),
          deps.agents.currentSelection(applicationId, agentId),
        ]);
        summaries.push(toWireAgentSummary(record, selection, versions));
      }
      return reply.send(summaries);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/agents/:id", async (request, reply) => {
    try {
      const applicationId = applicationScopeOf(request, "agent inventory reads");
      const identity = await resolveIdentity(deps, request, reply, applicationId);
      void identity;
      const agentId = requireStringField(request.params as Record<string, unknown>, "id");
      const record = await deps.agents.getAgent(applicationId, agentId);
      if (record === null) {
        throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "agent not found", 404);
      }
      const [versions, selection] = await Promise.all([
        deps.agents.listVersions(applicationId, agentId),
        deps.agents.currentSelection(applicationId, agentId),
      ]);
      return reply.send(toWireAgentSummary(record, selection, versions));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/agents/:id/versions", async (request, reply) => {
    try {
      const applicationId = applicationScopeOf(request, "agent inventory reads");
      const identity = await resolveIdentity(deps, request, reply, applicationId);
      void identity;
      const agentId = requireStringField(request.params as Record<string, unknown>, "id");
      const record = await deps.agents.getAgent(applicationId, agentId);
      if (record === null) {
        throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "agent not found", 404);
      }
      const versions = await deps.agents.listVersions(applicationId, agentId);
      return reply.send(versions.map(toWireAgentVersion));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/agents/:id/status", async (request, reply) => {
    try {
      const applicationId = applicationScopeOf(request, "agent inventory reads");
      const identity = await resolveIdentity(deps, request, reply, applicationId);
      void identity;
      const agentId = requireStringField(request.params as Record<string, unknown>, "id");
      const record = await deps.agents.getAgent(applicationId, agentId);
      if (record === null) {
        throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "agent not found", 404);
      }
      const [versions, selection] = await Promise.all([
        deps.agents.listVersions(applicationId, agentId),
        deps.agents.currentSelection(applicationId, agentId),
      ]);
      return reply.send(toWireAgentStatus(record, versions, selection));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });
}
