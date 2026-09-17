/**
 * Quota store port (budgets module outbound; DEP-014).
 *
 * Implemented by SQL and in-memory adapters. Inner layers depend on this
 * interface only. The store owns the (application, dimension, identity)
 * row space; every consume/release runs through `consume` with the
 * fail-closed check applied by the SERVICE under the store's row
 * serialization (the same lock-before-decide discipline as the budget
 * store, scoped to one quota row).
 */

import type { QuotaDimension, QuotaRecord, QuotaWindow } from "../domain/quota";

export interface UpsertQuotaInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly dimension: QuotaDimension;
  readonly limit: string;
  readonly window: QuotaWindow;
  readonly identityId: string | null;
}

/**
 * A consumption attempt: applies when there is headroom; denies (returns
 * null) when the amount would exceed the limit — the store-level
 * check-and-increment that makes enforcement atomic per row.
 */
export interface ConsumeQuotaInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly dimension: QuotaDimension;
  readonly identityId: string | null;
  readonly amount: string;
}

export interface QuotaStore {
  upsert(input: UpsertQuotaInput): Promise<QuotaRecord>;
  list(applicationId: string, tenantId: string): Promise<readonly QuotaRecord[]>;
  /** Atomic check-and-consume: the post-consume record, or null when denied. */
  consume(input: ConsumeQuotaInput): Promise<QuotaRecord | null>;
  /** Release a previously consumed amount (idempotent floors at zero). */
  release(input: ConsumeQuotaInput): Promise<QuotaRecord | null>;
}
