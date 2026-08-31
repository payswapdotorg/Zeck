/**
 * `capabilities` ports layer — outbound/inbound interfaces owned by this module.

Ports are provider-neutral: no infrastructure clients, no provider SDKs.
Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */
export type {
  CapabilityCatalogStore,
  CapabilityFactPublisher,
  CapabilityRegistry,
  CapabilityRegistryOptions,
  FactValidator,
} from "./capability-registry";
export * from "./substrate-store";
