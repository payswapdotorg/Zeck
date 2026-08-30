/**
 * In-memory capability catalog store (capabilities module adapter).
 *
 * The WORK-005 durability decision (see `docs/work-items/WORK-005.md`):
 * INT-002 introduces no durable authority state — the arbitrated catalog is
 * a versioned, code-resident dataset (seed + adapter facts) rebuilt at
 * composition, and task-profile resolution is a pure arbitration over it.
 * This adapter is therefore the whole storage surface: a plain map,
 * snapshot-copied on reads. A durable adapter would implement the identical
 * `CapabilityCatalogStore` port against a migration-owned table.
 */

import type { CapabilityClaimRecord } from "../domain/capability";
import type { CapabilityCatalogStore } from "../ports/capability-registry";

export function createInMemoryCatalogStore(): CapabilityCatalogStore & {
  readonly size: number;
} {
  const records: CapabilityClaimRecord[] = [];
  return {
    get size() {
      return records.length;
    },
    async list() {
      return [...records];
    },
    async findById(id) {
      return records.filter((record) => record.claim.id === id);
    },
    async insert(record) {
      records.push(record);
    },
  };
}
