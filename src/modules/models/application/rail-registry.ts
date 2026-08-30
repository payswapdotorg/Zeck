/**
 * Rail registry (models module application).
 *
 * Composition-owned mapping from rail slug to adapter instance. The registry
 * is deliberately dumb: no routing intelligence (capability/quality/cost/
 * latency routing is `/planning`'s authority, WORK-009); it only makes the
 * configured adapter set addressable by the connection's durable rail slug.
 */

import type { ModelProvider, RailRegistry } from "../ports/model-provider";

export function createRailRegistry(providers: readonly ModelProvider[]): RailRegistry {
  const byRail = new Map<string, ModelProvider>();
  for (const provider of providers) {
    if (byRail.has(provider.rail)) {
      throw new Error(`duplicate adapter registered for rail ${provider.rail}`);
    }
    byRail.set(provider.rail, provider);
  }
  return {
    rails: [...byRail.keys()],
    providerFor(rail: string): ModelProvider | null {
      return byRail.get(rail) ?? null;
    },
  };
}
