/**
 * Agent inventory port (deployments module outbound; WORK-023 — the
 * "agents only for directly-required public integration seams"
 * surface).
 *
 * The deployments module resolves agent-version references through
 * this READ seam, implemented by an adapter wrapping the agents
 * module's PUBLIC registry (`listVersions`/`getAgent`). It is a
 * lookup only: no registration, no promotion, no session and no
 * mutation surface crosses — the agents module remains the sole
 * agent authority (MOD-004: deployment adapters cannot create a
 * duplicate agent authority, by shape).
 */

export interface AgentVersionFact {
  readonly agentId: string;
  readonly version: string;
  /** The agents module's validation state for this version. */
  readonly validationState: "pending" | "valid" | "invalid";
  /** The agents module's lifecycle status of the owning agent. */
  readonly agentStatus: "registered" | "validated" | "available" | "suspended" | "retired";
}

export interface DeploymentAgentInventory {
  /** Resolve one agent version fact, or null when unknown. */
  findVersion(
    applicationId: string,
    agentId: string,
    version: string,
  ): Promise<AgentVersionFact | null>;
}
