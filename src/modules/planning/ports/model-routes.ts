/**
 * Model route explorer port (planning module outbound; WORK-009).
 *
 * THE DOWNSTREAM SEAM: this port is consulted ONLY AFTER capability
 * resolution and the deterministic-sufficiency decision have established
 * that generative inference is required (or that a bounded evaluation
 * needs a comparison route). The planner resolves WHAT is needed first;
 * WHICH provider/model satisfies it is answered here — provider choice
 * stays downstream of capability resolution and deterministic
 * sufficiency (mandatory behavior 11).
 *
 * Route candidates are provider-NEUTRAL strings exactly like the policy
 * restriction vocabulary — no SDK types, no adapter handles, no secrets.
 */

export interface ModelRouteCandidate {
  /** Neutral provider/rail identifier (opaque string). */
  readonly provider: string;
  /** Neutral model identifier (opaque string). */
  readonly model: string;
  /** Capability requirement ids this route satisfies (e.g. text-generation). */
  readonly satisfies: readonly string[];
  /** Integer micro-USD string per expected call (never a float). */
  readonly expectedCostMicroUsd: string;
  readonly expectedQuality: number;
  readonly expectedLatencyMs: number;
}

export interface ModelRouteExplorer {
  /**
   * Explore routes able to satisfy the given model-capability
   * requirements. Returns the neutral route table snapshot; policy
   * filtering happens at strategy admissibility (never here).
   */
  explore(requirementIds: readonly string[]): Promise<readonly ModelRouteCandidate[]>;
}
