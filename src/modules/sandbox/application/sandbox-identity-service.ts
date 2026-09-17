/**
 * Sandbox identity service (sandbox module application; DEP-014).
 *
 * The disposable sandbox lifecycle: establish (a fresh identity with a
 * TTL under the synthetic-data policy), inspect (post-expiry reads
 * render the honest EXPIRED state — records never silently disappear),
 * expireOverdue (the explicit TTL transition, recorded as a lifecycle
 * event through the EXISTING executions EventEnvelope ledger seam — no
 * new ledger), and reset (an idempotent, confirmable operation that
 * NEVER carries state forward: the predecessor transitions to `reset`,
 * a fresh successor is established under fresh budgets, and the lineage
 * is auditable both directions).
 *
 * The service is NOT a second environment authority: the environment
 * catalog owns persistent environments; this service owns the
 * disposable identity dimension of the SAME module, admitted under the
 * same policy-first chain.
 */

import { PlatformError } from "../../../shared/errors";
import {
  identityIsPastTtl,
  SANDBOX_IDENTITY_DEFAULT_TTL_MS,
  type SandboxIdentityRecord,
} from "../domain/sandbox-identity";
import {
  SYNTHETIC_DATA_POLICY,
  type SyntheticDataViolationFact,
  syntheticDataClassesAdmitted,
} from "../domain/synthetic-data-policy";
import type {
  InsertSandboxIdentityInput,
  SandboxIdentityStore,
} from "../ports/sandbox-identity-store";
import type { SandboxExecutionLedger } from "../ports/sandbox-ledger";

export interface EstablishSandboxIdentityCommand {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * The execution the identity is established under (the ledger binding —
   * present when the establishment rides a run; absent for console-driven
   * establishments, which record their audit trail in the store lineage
   * and answer `ledgerRecorded: false` honestly).
   */
  readonly executionId?: string;
  readonly environmentId?: string | null;
  /** Declared data classes — must sit inside the synthetic-data policy. */
  readonly declaredDataClasses?: readonly string[];
  /** The TTL in ms (defaults to the platform default). */
  readonly ttlMs?: number;
  readonly idempotencyKey: string;
}

export interface ResetSandboxIdentityCommand {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly identityId: string;
  /** The execution context performing the reset (optional ledger binding). */
  readonly executionId?: string;
  readonly declaredDataClasses?: readonly string[];
  readonly idempotencyKey: string;
}

export interface SandboxIdentityServiceDeps {
  readonly store: SandboxIdentityStore;
  readonly ledger: SandboxExecutionLedger;
  readonly now: () => string;
  readonly newId: () => string;
}

export interface SandboxIdentityService {
  establish(command: EstablishSandboxIdentityCommand): Promise<SandboxIdentityRecord>;
  /** Scope-checked read; post-expiry reads return the honest expired view. */
  get(applicationId: string, identityId: string): Promise<SandboxIdentityRecord | null>;
  list(applicationId: string): Promise<readonly SandboxIdentityRecord[]>;
  /**
   * The TTL sweep: transitions overdue active identities to `expired`
   * and records the lifecycle event on the ledger. Idempotent — an
   * already-expired identity is a no-op.
   */
  expireOverdue(applicationId: string): Promise<readonly SandboxIdentityRecord[]>;
  /**
   * The reset: predecessor → `reset`, fresh successor established, NO
   * state carried forward. IDEMPOTENT per identity: re-confirming a
   * reset returns the existing successor as a no-op success (a probe
   * AC4 demands).
   */
  reset(command: ResetSandboxIdentityCommand): Promise<SandboxIdentityRecord>;
  /** The recorded synthetic-data violations (facts only). */
  policyViolations(applicationId: string): Promise<readonly SyntheticDataViolationFact[]>;
}

export function createSandboxIdentityService(
  deps: SandboxIdentityServiceDeps,
): SandboxIdentityService {
  const violations: SyntheticDataViolationFact[] = [];
  const checkDataClasses = (
    applicationId: string,
    declared: readonly string[] | undefined,
  ): void => {
    const classes = declared ?? [];
    const decision = syntheticDataClassesAdmitted(classes);
    if (!decision.admitted) {
      violations.unshift({
        applicationId,
        prohibitedClass: decision.prohibited,
        decision: "denied",
        occurredAt: deps.now(),
      });
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `the synthetic-data policy refuses data class "${decision.prohibited}" — sandbox admission is fail-closed (policy ${SYNTHETIC_DATA_POLICY.version}, ${SYNTHETIC_DATA_POLICY.digest})`,
        retryable: false,
      });
    }
  };
  const ttlDeadline = (ttlMs: number | undefined): string =>
    new Date(Date.parse(deps.now()) + (ttlMs ?? SANDBOX_IDENTITY_DEFAULT_TTL_MS)).toISOString();
  return {
    async establish(command) {
      checkDataClasses(command.applicationId, command.declaredDataClasses);
      const input: InsertSandboxIdentityInput = {
        id: deps.newId(),
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        environmentId: command.environmentId ?? null,
        expiresAt: ttlDeadline(command.ttlMs),
        supersedes: null,
      };
      const record = await deps.store.insert(input);
      if (command.executionId !== undefined) {
        await deps.ledger.recordStepEvent(
          {
            applicationId: command.applicationId,
            executionId: command.executionId,
            actor: { actorId: command.actorId, tenantId: command.tenantId },
            command: "sandbox-admitted",
            cause: "sandbox-identity-established",
            reference: { identityId: record.id, expiresAt: record.expiresAt },
            payload: {
              identityId: record.id,
              ttlMs: command.ttlMs ?? SANDBOX_IDENTITY_DEFAULT_TTL_MS,
              dataClasses: command.declaredDataClasses ?? [],
            },
          },
          command.idempotencyKey,
        );
      }
      return record;
    },
    async get(applicationId, identityId) {
      const record = await deps.store.find(applicationId, identityId);
      if (record === null) {
        return null;
      }
      // The honest post-expiry read: the SAME record, its expired state
      // rendered — never a silent disappearance (DEP-014 AC3).
      return identityIsPastTtl(record, deps.now())
        ? { ...record, status: record.status === "active" ? "expired" : record.status }
        : record;
    },
    async list(applicationId) {
      const records = await deps.store.list(applicationId);
      const now = deps.now();
      return records.map((record) =>
        record.status === "active" && identityIsPastTtl(record, now)
          ? { ...record, status: "expired" as const }
          : record,
      );
    },
    async expireOverdue(applicationId) {
      const now = deps.now();
      const overdue: SandboxIdentityRecord[] = [];
      for (const record of await deps.store.list(applicationId)) {
        if (record.status === "active" && identityIsPastTtl(record, now)) {
          const transitioned = await deps.store.transitionStatus(
            applicationId,
            record.id,
            "expired",
          );
          if (transitioned !== null) {
            overdue.push(transitioned);
          }
        }
      }
      return overdue;
    },
    async reset(command) {
      const predecessor = await deps.store.find(command.applicationId, command.identityId);
      if (predecessor === null) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "the sandbox identity is not visible to this scope (scope-checked read)",
          retryable: false,
        });
      }
      // IDEMPOTENT: an already-reset predecessor returns its existing
      // successor as a no-op success (AC4) — nothing further happens.
      if (predecessor.status === "reset" && predecessor.supersededBy !== null) {
        const successor = await deps.store.find(command.applicationId, predecessor.supersededBy);
        if (successor !== null) {
          return successor;
        }
      }
      checkDataClasses(command.applicationId, command.declaredDataClasses);
      // The fresh successor: NO state carries forward — fresh identity,
      // fresh TTL, fresh budgets. Only the lineage is recorded.
      const input: InsertSandboxIdentityInput = {
        id: deps.newId(),
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        environmentId: predecessor.environmentId,
        expiresAt: ttlDeadline(undefined),
        supersedes: predecessor.id,
      };
      const successor = await deps.store.insert(input);
      await deps.store.transitionStatus(
        command.applicationId,
        predecessor.id,
        "reset",
        successor.id,
      );
      if (command.executionId !== undefined) {
        await deps.ledger.recordStepEvent(
          {
            applicationId: command.applicationId,
            executionId: command.executionId,
            actor: { actorId: command.actorId, tenantId: command.tenantId },
            command: "sandbox-admitted",
            cause: "sandbox-identity-reset",
            reference: { identityId: successor.id, supersedes: predecessor.id },
            payload: {
              identityId: successor.id,
              resetOf: predecessor.id,
              stateCarriedForward: false,
              dataClasses: command.declaredDataClasses ?? [],
            },
          },
          command.idempotencyKey,
        );
      }
      return successor;
    },
    async policyViolations(applicationId) {
      return violations.filter((fact) => fact.applicationId === applicationId);
    },
  };
}
