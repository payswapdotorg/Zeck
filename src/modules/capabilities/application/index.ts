/**
 * `capabilities` application layer — use cases and orchestration local to this module.

Application code reaches outward only through this module's ports; it never
imports adapters or `src/platform/**` directly (`IMPLEMENTATION.md` §3).
 */
export { createCapabilityRegistry } from "./capability-registry";
export {
  createSubstrateRegistry,
  type SubstrateActor,
  type SubstrateRegistry,
  type SubstrateRegistryDeps,
} from "./substrate-registry";
