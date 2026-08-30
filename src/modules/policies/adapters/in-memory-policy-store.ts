/**
 * In-memory `PolicyStore` adapter (policies module; WORK-007).
 *
 * Holds the current effective policy set record. This round's durability
 * decision (WORK-005 store-port precedent): policy DEFINITIONS are
 * configuration-resident versioned data (no durable definition storage, no
 * migration); durable ADMISSION DECISIONS are recorded by the executions
 * EventEnvelope ledger on the authorize seam, bound to the set identity +
 * restriction digest this store's records carry. A durable adapter would
 * implement the identical contract (see docs/work-items/WORK-007.md).
 */

import type { PolicySetRecord, PolicyStore } from "../ports/policy-authority";

export class InMemoryPolicyStore implements PolicyStore {
  private record: PolicySetRecord | null = null;

  async load(): Promise<PolicySetRecord | null> {
    return this.record;
  }

  async save(record: PolicySetRecord): Promise<void> {
    this.record = record;
  }
}
