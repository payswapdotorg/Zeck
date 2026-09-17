/**
 * Quota service (budgets module application; DEP-014).
 *
 * The quota/lifecycle authority surface: configure per-scope quota
 * limits, assess the current state, consume with FAIL-CLOSED enforcement
 * (an unenforceable dimension denies, never default-allows) and record
 * violation facts (facts only — dimension and decision, never payloads).
 *
 * The service follows the budget-service house pattern (application
 * service + neutral port + adapters). Spend quotas COMPOSE the existing
 * fail-closed reservation discipline rather than replacing it: the
 * spend-micro-usd dimension is the sandbox-visible projection of the
 * budget authority's per-period spend limit.
 */

import { PlatformError } from "../../../shared/errors";
import {
  type QuotaDimension,
  type QuotaRecord,
  type QuotaViolationFact,
  type QuotaWindow,
  quotaWouldExceed,
} from "../domain/quota";
import type { ConsumeQuotaInput, QuotaStore, UpsertQuotaInput } from "../ports/quota-store";

export interface QuotaCommandScope {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface ConfigureQuotaCommand extends QuotaCommandScope {
  readonly dimension: QuotaDimension;
  readonly limit: string;
  readonly window: QuotaWindow;
  readonly identityId?: string | null;
}

export interface ConsumeQuotaCommand extends QuotaCommandScope {
  readonly dimension: QuotaDimension;
  readonly amount: string;
  readonly identityId?: string | null;
}

export interface QuotaServiceDeps {
  readonly store: QuotaStore;
  /** Monotonic clock (injectable; tests freeze time). */
  readonly now: () => string;
  /** Identity generator (injectable; tests pin ids). */
  readonly newId: () => string;
}

export interface QuotaService {
  configure(command: ConfigureQuotaCommand): Promise<QuotaRecord>;
  assess(scope: QuotaCommandScope): Promise<readonly QuotaRecord[]>;
  /**
   * Consume `amount` of a dimension. FAIL-CLOSED: a missing quota row,
   * a malformed amount or an exceeded limit denies with
   * `QUOTA_EXCEEDED` (the platform code) and records a violation fact.
   */
  consume(command: ConsumeQuotaCommand): Promise<QuotaRecord>;
  /** Release a consumed amount (floors at zero; absent row is a no-op null). */
  release(command: ConsumeQuotaCommand): Promise<QuotaRecord | null>;
  /** The recorded violation facts (most recent first). */
  violations(scope: QuotaCommandScope): Promise<readonly QuotaViolationFact[]>;
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const violations: QuotaViolationFact[] = [];
  const deny = (scope: QuotaCommandScope, dimension: QuotaDimension): never => {
    violations.unshift({
      applicationId: scope.applicationId,
      tenantId: scope.tenantId,
      dimension,
      decision: "denied",
      occurredAt: deps.now(),
    });
    throw new PlatformError({
      code: "BUDGET_EXCEEDED",
      message: `sandbox quota ${dimension} exhausted or unenforceable for application ${scope.applicationId} — the admission was refused fail-closed`,
      retryable: false,
    });
  };
  return {
    async configure(command) {
      if (!/^\d+$/.test(command.limit) || BigInt(command.limit) < 0n) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "quota limit must be a non-negative integer string (refused fail-closed)",
          retryable: false,
        });
      }
      const input: UpsertQuotaInput = {
        id: deps.newId(),
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        dimension: command.dimension,
        limit: command.limit,
        window: command.window,
        identityId: command.identityId ?? null,
      };
      return deps.store.upsert(input);
    },
    async assess(scope) {
      return deps.store.list(scope.applicationId, scope.tenantId);
    },
    async consume(command) {
      if (!/^\d+$/.test(command.amount)) {
        deny(command, command.dimension);
      }
      const input: ConsumeQuotaInput = {
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        dimension: command.dimension,
        identityId: command.identityId ?? null,
        amount: command.amount,
      };
      const record = await deps.store.consume(input);
      if (record === null) {
        deny(command, command.dimension);
        throw new Error("unreachable — deny always throws");
      }
      return record;
    },
    async release(command) {
      return deps.store.release({
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        dimension: command.dimension,
        identityId: command.identityId ?? null,
        amount: command.amount,
      });
    },
    async violations(scope) {
      return violations.filter(
        (fact) => fact.applicationId === scope.applicationId && fact.tenantId === scope.tenantId,
      );
    },
  };
}

export { quotaWouldExceed };
