/**
 * Model route explorer adapter (planning module adapter; WORK-009).
 *
 * Composition-fed route table: the assembly root supplies the neutral
 * route snapshot (provider/model identifiers as opaque strings, exactly
 * like the policy restriction vocabulary — no SDK types, no credentials,
 * no adapter handles). The explorer is the DOWNSTREAM seam: the planner
 * consults it only after capability resolution and deterministic
 * sufficiency have established that generative inference is required.
 *
 * Route data is provider metadata only. Policy filtering happens at
 * strategy admissibility — NEVER here (the explorer must not become a
 * policy authority).
 */

import type { ModelRouteCandidate, ModelRouteExplorer } from "../ports/model-routes";

export function createRouteTableExplorer(
  routes: readonly ModelRouteCandidate[],
): ModelRouteExplorer {
  const snapshot = Object.freeze([...routes]);
  return {
    async explore(requirementIds: readonly string[]): Promise<readonly ModelRouteCandidate[]> {
      if (requirementIds.length === 0) {
        return [];
      }
      return snapshot.filter((route) =>
        requirementIds.every((requirementId) => route.satisfies.includes(requirementId)),
      );
    },
  };
}
