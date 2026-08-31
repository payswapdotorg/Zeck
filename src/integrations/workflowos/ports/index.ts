/**
 * WorkflowOS integration ports barrel (WORK-016).
 *
 * Both ports are CONSUMED AUTHORITY seams (the agents/executions modules
 * own the authorities; the composition root injects them). The
 * integration owns no store, no ledger, no registry behind any seam.
 */

export type { ByoaAgentsAuthority } from "./agents-authority";
export type { WorkflowOsExecutionsAuthority } from "./executions-authority";
