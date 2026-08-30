/**
 * Agent identity and lifecycle domain (agents module domain; WORK-011,
 * AGT-001/AGT-003/ACP-001).
 *
 * An AGENT is a governed execution PARTICIPANT — a strategy composed of
 * model capability, tools, workspace and policy — never a second
 * top-level abstraction, never a competing authority (`spec/
 * architecture.md` §2.1/§14, ADR-0013). This file owns the durable
 * IDENTITY of a registered agent: the stable catalog record an
 * organization can discover, audit and govern across every immutable
 * version it ever publishes (versions live in `agent-version.ts`).
 *
 * Lifecycle (subordinate to Execution — it is NOT an execution state
 * machine and never moves execution status):
 *
 *   registered → validated → available ⇄ suspended → retired
 *
 *   - `registered`  the identity exists (catalog row created);
 *   - `validated`   at least one VALIDATED version is published and the
 *                   agent has passed registration validation;
 *   - `available`   the agent may start governed sessions;
 *   - `suspended`   temporarily ineligible to start sessions (existing
 *                   sessions complete under their grants);
 *   - `retired`     terminal: no new sessions, identity preserved for
 *                   audit forever.
 *
 * The vocabulary is owned HERE for agent identity only; execution states
 * stay owned by `/executions` (the single state machine authority).
 */

/** Agent identity lifecycle (agent-axis only; never an execution state). */
export const AGENT_LIFECYCLE_STATUSES = [
  "registered",
  "validated",
  "available",
  "suspended",
  "retired",
] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

/** Legal agent-identity lifecycle transitions (small, explicit, agent-axis). */
export const AGENT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<AgentLifecycleStatus, readonly AgentLifecycleStatus[]>
> = {
  registered: ["validated", "retired"],
  validated: ["available", "retired"],
  available: ["suspended", "retired"],
  suspended: ["available", "retired"],
  retired: [],
};

export function isAgentLifecycleStatus(value: string): value is AgentLifecycleStatus {
  return (AGENT_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/** Terminal agent statuses (no transitions out; identity remains auditable). */
export const TERMINAL_AGENT_STATUSES: readonly AgentLifecycleStatus[] = ["retired"];

export function isTerminalAgentStatus(status: AgentLifecycleStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/** Whether an agent may START new governed sessions in this status. */
export function agentMayStartSessions(status: AgentLifecycleStatus): boolean {
  return status === "available";
}

/**
 * The stable governed agent identity / inventory-catalog record (AGT-003,
 * ACP-001): who owns it, where it is scoped, its discoverable name and its
 * lifecycle state. Deliberately carries NO executable configuration — that
 * is the immutable version artifact's job (separation of durable identity
 * from executable definition).
 */
export interface AgentRecord {
  /** Durable agent identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Caller-chosen stable slug unique within the application. */
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: AgentLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Registration input validated fail-closed before any durable write. */
export interface AgentRegistrationInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export type AgentCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const NAME = /^[\S].{0,199}$/s;

/** Pure, fail-closed validation of an agent registration input. */
export function validateAgentRegistration(input: unknown): AgentCheck {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, reason: "agent registration must be an object" };
  }
  const c = input as AgentRegistrationInput;
  if (typeof c.applicationId !== "string" || !UUID.test(c.applicationId)) {
    return { valid: false, reason: "applicationId must be a UUID" };
  }
  if (typeof c.tenantId !== "string" || !UUID.test(c.tenantId)) {
    return { valid: false, reason: "tenantId must be a UUID" };
  }
  if (typeof c.slug !== "string" || !SLUG.test(c.slug)) {
    return {
      valid: false,
      reason: "slug must be a lowercase hyphen-dashed identifier (max 100 chars)",
    };
  }
  if (typeof c.name !== "string" || !NAME.test(c.name)) {
    return { valid: false, reason: "name must be a non-empty string (max 200 chars)" };
  }
  if (c.description !== undefined) {
    if (typeof c.description !== "string" || c.description.length > 2000) {
      return { valid: false, reason: "description must be a string (max 2000 chars)" };
    }
  }
  return { valid: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
