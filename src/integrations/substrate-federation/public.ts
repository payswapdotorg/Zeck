/**
 * Public contract barrel of the substrate-federation integration
 * (WORK-031, CSX-004).
 *
 * Integrations are adapters for external systems: `public.ts` is the
 * only supported import surface, `adapters/` owns external client
 * implementations, and `internal/` is never imported from outside.
 *
 * External compute systems (cloud runtimes, GPU fleets, edge fabrics,
 * embodied adapters — the WORK-027..030 territories) federate their
 * substrates through the capabilities module's PUBLIC substrate
 * registry — the ONE claim authority. This integration holds no
 * registry, no validation regime, no admission and no execution
 * surface: everything is consumed, nothing is duplicated. Vendor SDKs
 * never cross (none exist at v1); operator adapters are neutral and
 * replaceable.
 */

export const integrationId = "substrate-federation" as const;

export type SubstrateFederationIntegrationId = typeof integrationId;

export { InMemorySubstrateOperator } from "./adapters/in-memory-operator";
export {
  createSubstrateFederationService,
  type SubstrateFederationActor,
  type SubstrateFederationDeps,
  type SubstrateFederationService,
} from "./application/federation-service";
export type { ExternalSubstrateSubmission } from "./domain/submission";
export type { SubstrateOperatorAdapter } from "./ports/operator-adapter";
