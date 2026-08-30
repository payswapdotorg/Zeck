/**
 * Public contract barrel of the WorkflowOS integration.
 *
 * Integrations are adapters for external systems: `public.ts` is the only
 * supported import surface, `adapters/` owns the external client (the only
 * place a WorkflowOS SDK may be imported), and `internal/` is never
 * imported from outside. Full structure arrives with WORK-016.
 */
export const integrationId = "workflowos" as const;

export type WorkflowOsIntegrationId = typeof integrationId;
