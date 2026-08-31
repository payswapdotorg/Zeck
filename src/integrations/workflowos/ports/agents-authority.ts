/**
 * The agents authority seam consumed by the BYOA interop surface
 * (WORK-016; WORK-011's registry is THE agent identity/version
 * authority — this integration CONSUMES it and never duplicates it).
 *
 * The BYOA registration path injects the real `AgentRegistry` here;
 * there is NO second registry, NO agent table, NO version store behind
 * this seam (discrimination M19: "BYOA creates second agent registry"
 * is unrepresentable — `registerByoaAgent` can only call the authority).
 */

import type { AgentRegistry } from "../../../modules/agents/public";

/** The agents registry authority subset the BYOA registration path uses. */
export type ByoaAgentsAuthority = Pick<
  AgentRegistry,
  "registerAgent" | "publishVersion" | "promote" | "getAgentBySlug"
>;
