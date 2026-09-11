/**
 * The retention service (audit module application layer; WORK-059 /
 * SEC-004).
 *
 * GOVERNED EXPIRY, HONEST SEMANTICS:
 *
 *  - `adoptPolicy` delegates to the store (the adoption is audited in
 *    the same transaction — governed procedure);
 *  - `executePurge` REQUIRES an active adopted policy (a scope without
 *    a bounded policy never purges — fail closed, reported honestly
 *    as an explicit boundary, never silently treated as an infinite
 *    horizon), computes the cutoff from the policy horizon and the
 *    procedure time, and executes the store's governed purge (the
 *    ONLY deletion path: expired + hold-free records, evidence record
 *    + head update in the same transaction; a purge that finds
 *    nothing does nothing and records nothing);
 *  - the purge outcome reports exactly what happened (counts +
 *    evidence) — no simulated PASS.
 */

import type { AdoptPolicyInput, RetentionPolicyRecord } from "../domain";
import { computePurgeCutoff } from "../domain";
import type {
  AuditRecordStore,
  GovernedPurgeOutcome,
  RetentionPolicyStore,
} from "../ports/audit-store";
import { AuditStoreError } from "../ports/audit-store";

export interface RetentionServiceOptions {
  readonly policies: RetentionPolicyStore;
  readonly records: AuditRecordStore;
  readonly now: () => Date;
}

export interface RetentionService {
  /** Adopt (or idempotently replay) a bounded retention policy version. */
  adoptPolicy(input: AdoptPolicyInput): Promise<RetentionPolicyRecord>;
  /** The active policy for a scope (null when none was adopted). */
  latestPolicy(applicationId: string): Promise<RetentionPolicyRecord | null>;
  /**
   * Execute the governed retention purge under the ACTIVE policy.
   * Fail-closed preconditions: a bounded policy must be active; the
   * purge runs through the store's governed procedure only.
   */
  executePurge(input: {
    readonly applicationId: string;
    readonly environment: string;
    readonly procedureActorId: string;
  }): Promise<
    GovernedPurgeOutcome & { readonly cutoff: string; readonly policy: RetentionPolicyRecord }
  >;
}

export function createRetentionService(options: RetentionServiceOptions): RetentionService {
  const { policies, records, now } = options;

  return {
    async adoptPolicy(input: AdoptPolicyInput) {
      return policies.adoptPolicy(input);
    },

    async latestPolicy(applicationId: string) {
      return policies.latestPolicy(applicationId);
    },

    async executePurge(input) {
      const policy = await policies.latestPolicy(input.applicationId);
      if (policy === null) {
        throw new AuditStoreError(
          "AUDIT_PROJECTION_UNAVAILABLE",
          "no retention policy is active for this application (retention is not yet bounded; adopt a policy before purging — records are retained until then, an explicit disclosed boundary)",
          { applicationId: input.applicationId },
        );
      }
      const asOf = now();
      const cutoff = computePurgeCutoff(policy, asOf);
      const outcome = await records.purgeExpiredRecords({
        applicationId: input.applicationId,
        cutoff,
        policyVersion: policy.version,
        procedureActorId: input.procedureActorId,
        reason: `governed retention purge under policy v${policy.version} (${policy.retentionDays}d horizon)`,
        environment: input.environment,
        asOf: asOf.toISOString(),
      });
      return { ...outcome, cutoff, policy };
    },
  };
}
