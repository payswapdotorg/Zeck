/**
 * Agent-inventory adapter (deployments module adapter; WORK-023 — the
 * "agents public integration seam").
 *
 * Wraps the agents module's PUBLIC registry (`listVersions`/
 * `getAgent`) as the read-only `DeploymentAgentInventory` port: the
 * deployments module resolves agent-version facts through the agents
 * authority and never re-implements them. No mutation surface
 * crosses (the registry methods exposed here are reads only).
 */

import type { AgentRegistry } from "../../agents/public";
import type { AgentVersionFact, DeploymentAgentInventory } from "../ports/agent-inventory";

export function createAgentInventoryAdapter(registry: AgentRegistry): DeploymentAgentInventory {
  return {
    async findVersion(applicationId, agentId, version): Promise<AgentVersionFact | null> {
      const agent = await registry.getAgent(applicationId, agentId);
      if (agent === null) {
        return null;
      }
      const versions = await registry.listVersions(applicationId, agentId);
      const found = versions.find((record) => record.version === version);
      if (found === undefined) {
        return null;
      }
      return {
        agentId,
        version,
        validationState: found.validationState,
        agentStatus: agent.status,
      };
    },
  };
}
