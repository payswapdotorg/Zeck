/**
 * Public contract barrel of the accelerators integration (WORK-030,
 * ACC-002).
 *
 * Integrations are adapters for external systems: `public.ts` is the
 * only supported import surface, `adapters/` owns external client
 * implementations, and `internal/` is never imported from outside.
 *
 * The accelerators integration is the SUBSTRATE side of the sandbox
 * module's public `AcceleratorSubstrateRuntime` seam (the
 * provider-neutral GPU/accelerator execution contract): it implements
 * that port over a neutral accelerator FLEET (the simulated in-process
 * fabric — external-substrate behavior UNVERIFIED, recorded in
 * docs/work-items/WORK-030.md), and exposes the substrate-federation
 * operator path so an accelerator fabric's NEUTRAL substrate claims
 * federate into the capabilities module's PUBLIC registry (the ONE
 * claim authority). No vendor SDK, network egress or SQL exists in
 * this tree; vendor specifics never cross the contract.
 */

export const integrationId = "accelerators" as const;

export type AcceleratorsIntegrationId = typeof integrationId;

export {
  type AcceleratorOperatorOptions,
  createAcceleratorOperator,
} from "./adapters/accelerator-operator";
export { createAcceleratorSubstrateRuntime } from "./adapters/accelerator-substrate-runtime";
export type { SimulatedAcceleratorFleetOptions } from "./adapters/simulated-accelerator-fleet";
export { SimulatedAcceleratorFleet } from "./adapters/simulated-accelerator-fleet";
export type {
  AcceleratorDeviceDescriptor,
  AcceleratorFabricDescriptor,
  FleetAllocationRecord,
  FleetAllocationRequest,
  FleetRunRecord,
} from "./domain/accelerator";
export type {
  AcceleratorFleet,
  FleetRunOutcome,
  FleetRunSpec,
} from "./ports/accelerator-fleet";
