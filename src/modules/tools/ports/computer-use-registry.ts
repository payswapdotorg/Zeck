/**
 * Computer-use capability registry port (tools module outbound; WORK-027,
 * CUI-001/AC-5).
 *
 * The registry is the tools module's LOCAL admission surface for
 * computer-use capability DECLARATIONS (the provider-neutral contracts) —
 * it is NOT a second platform capability authority: the platform
 * capability authority (WORK-005) is consulted separately, through the
 * `ComputerUseCapabilityGate` seam, for the capability ATOM each
 * declaration requires.
 *
 * Unregistered or fabricated capability ids have no declaration, no
 * contract, no envelope and no adapter: `resolve` returns null and the
 * service fails closed `CAPABILITY_UNAVAILABLE` BEFORE any environment
 * interaction. There is no default-allow path and no way to dispatch a
 * capability that was never admitted here.
 */

import type {
  ComputerUseCapabilityDeclaration,
  ComputerUseCheck,
} from "../domain/computer-use";

export interface ComputerUseCapabilityRegistry {
  /**
   * Register one VALIDATED declaration (fail-closed: a declaration that
   * fails `validateComputerUseCapability` is rejected; an identical
   * re-registration converges; a DIFFERENT declaration under a live id
   * fails closed).
   */
  register(declaration: ComputerUseCapabilityDeclaration): Promise<ComputerUseCheck>;
  /** Resolve one declaration by capability id (null = unregistered). */
  resolve(capabilityId: string): Promise<ComputerUseCapabilityDeclaration | null>;
  /** List every registered declaration (the route-evaluation candidate universe). */
  list(): Promise<readonly ComputerUseCapabilityDeclaration[]>;
}

export interface RegisterOutcome {
  readonly registered: boolean;
  readonly reason?: string;
}
