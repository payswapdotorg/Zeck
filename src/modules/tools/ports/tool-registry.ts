/**
 * Tool registry port (tools module outbound; WORK-010).
 *
 * The TOOL ADMISSION surface of the runtime: tool identity → (contract,
 * adapter). The registry is NOT a capability registry — capability
 * identity/claims/versioning belong to the capabilities module (WORK-005),
 * which this runtime consults separately for capability admission. This
 * registry answers exactly one question: which VALIDATED contract and
 * bound adapter serves a requested toolId?
 *
 * Registration validates every contract (`validateToolContract`,
 * fail-closed) and binds it to its adapter; composition roots own what is
 * registered. The runtime NEVER constructs adapters and never invokes one
 * that is not resolved through this seam — an unregistered tool cannot be
 * invoked by construction.
 */

import type { ToolContract } from "../domain/tool";
import type { ToolAdapter } from "./tool-adapter";

export type RegisterToolOutcome =
  | { readonly status: "registered"; readonly toolId: string; readonly version: string }
  /** Identical (contract, adapter binding already present) re-registration. */
  | { readonly status: "converged"; readonly toolId: string; readonly version: string }
  | { readonly status: "rejected"; readonly reason: string };

/** A registered tool: its validated contract plus its bound adapter. */
export interface RegisteredTool {
  readonly contract: ToolContract;
  readonly adapter: ToolAdapter;
}

export interface ToolRegistry {
  /**
   * Register (or converge on) a validated contract + adapter binding.
   * Validation and arbitration happen HERE: an invalid contract is
   * rejected; an identical re-registration converges; a different contract
   * for the same (toolId, version) is rejected (contracts are immutable
   * once registered).
   */
  register(contract: ToolContract, adapter: ToolAdapter): Promise<RegisterToolOutcome>;
  /** Resolve a toolId to its registered (contract, adapter) — or null. */
  resolve(toolId: string): Promise<RegisteredTool | null>;
  /** All registered contracts (inspection/evidence surface). */
  listContracts(): Promise<readonly ToolContract[]>;
}
