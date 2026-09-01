/**
 * Public contract barrel of the runners integration (WORK-019, ENV-003).
 *
 * Integrations are adapters for external systems: `public.ts` is the only
 * supported import surface, `adapters/` owns external-facing channel
 * implementations, and `internal/` is never imported from outside.
 *
 * Customer-controlled runners adopt into the Zeck fleet through the
 * sandbox module's PUBLIC runner-fleet service — the ONE authority for
 * runner identity, authorization, assignment, lease and revocation. This
 * integration holds no registry, no authorization logic, no admission and
 * no execution surface: everything is delegated, nothing is duplicated.
 * The channel adapter implements the sandbox module's REQUIRED neutral
 * `RunnerChannel` port (the payment-rails/economics and
 * substrate-federation/capabilities precedent); vendor transports never
 * cross this barrel (none exist at v1 — the in-memory endpoint is the
 * composition/test fake).
 */

export const integrationId = "runners" as const;

export type RunnersIntegrationId = typeof integrationId;

export { CustomerRunnerChannel } from "./adapters/customer-runner-channel";
export { InMemoryCustomerRunnerEndpoint } from "./adapters/in-memory-endpoint";
export {
  type CustomerRunnerGateway,
  type CustomerRunnerGatewayDeps,
  createCustomerRunnerGateway,
  type RunnerGatewayActor,
} from "./application/customer-runner-gateway";
export type { ExternalRunnerRegistration } from "./domain/submission";
export { validateExternalRunnerRegistration } from "./domain/submission";
export type { CustomerRunnerEndpoint } from "./ports/customer-runner-endpoint";
