/**
 * Substrate store port (capabilities module outbound; WORK-031).
 *
 * The durable-state seam for substrate records (migration 0013). The
 * arbitration contract (the WORK-011/023 discipline):
 *
 *   - publication converges on (application, substrateId, version)
 *     UNIQUE: an identical body (same digest) converges; a different
 *     body fails closed (substrate versions are immutable once
 *     published);
 *   - the lifecycle is guarded (available ↔ suspended, either →
 *     retired; retired terminal-immutable);
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped;
 *   - rows are never deleted.
 */

import type { ComputationalSubstrateRecord, SubstrateLifecycleStatus } from "../domain/substrate";

export interface SubstrateInsertInput {
  readonly record: Omit<ComputationalSubstrateRecord, "status" | "createdAt" | "digest">;
  readonly digest: string;
}

export type SubstrateInsertOutcome =
  | { readonly status: "published"; readonly record: ComputationalSubstrateRecord }
  | { readonly status: "converged"; readonly record: ComputationalSubstrateRecord };

export interface SubstrateStatusInput {
  readonly applicationId: string;
  readonly substrateId: string;
  readonly version: string;
  readonly from: SubstrateLifecycleStatus;
  readonly to: SubstrateLifecycleStatus;
}

export interface SubstrateStore {
  insert(input: SubstrateInsertInput): Promise<SubstrateInsertOutcome>;
  find(
    applicationId: string,
    substrateId: string,
    version: string,
  ): Promise<ComputationalSubstrateRecord | null>;
  list(applicationId: string): Promise<readonly ComputationalSubstrateRecord[]>;
  /** The selectable substrates for a workload class (available only). */
  listAvailableByWorkloadClass(
    applicationId: string,
    workloadClass: string,
  ): Promise<readonly ComputationalSubstrateRecord[]>;
  /** One guarded lifecycle transition (first writer wins). */
  updateStatus(input: SubstrateStatusInput): Promise<ComputationalSubstrateRecord>;
}
