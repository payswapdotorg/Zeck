/**
 * Executions authorize-seam adapter (policies module; WORK-007).
 *
 * Implements the executions module's REQUIRED `ExecutionAuthorizationPort`
 * (the inbound seam WORK-006 shipped for exactly this wiring — its header:
 * "the provider-neutral seam the future policies module implements") against
 * the REAL policy authority. The `authorize` transition (CREATED →
 * AUTHORIZED) consults this adapter; a denial is typed `POLICY_DENIED` by
 * the executions service, and every ALLOW carries the durable admission
 * evidence (set version + content hash + restriction-set digest) the
 * executions EventEnvelope ledger records.
 *
 * Type-only coupling to `executions/public` (zero runtime dependency): the
 * port is executions-owned; this adapter is the policy engine plugging in.
 */

import type { ExecutionAuthorizationPort } from "../../executions/public";
import type { PolicyAuthority } from "../ports/policy-authority";

export function createExecutionAuthorization(
  authority: PolicyAuthority,
): ExecutionAuthorizationPort {
  return {
    async evaluate(input) {
      const constraints = input.execution.constraints ?? undefined;
      const result = await authority.admit({
        context: {
          tenantId: input.execution.tenantId,
          applicationId: input.execution.applicationId,
          ...(input.execution.userId === "" ? {} : { userId: input.execution.userId }),
          ...(typeof input.execution.task.kind === "string"
            ? { taskKind: input.execution.task.kind }
            : {}),
          executionId: input.execution.id,
        },
        facts: {
          ...(constraints?.maxCostMicroUsd === undefined
            ? {}
            : { maxCostMicroUsd: constraints.maxCostMicroUsd }),
          ...(constraints?.maxLatencyMs === undefined
            ? {}
            : { maxLatencyMs: constraints.maxLatencyMs }),
          ...(constraints?.minQuality === undefined ? {} : { minQuality: constraints.minQuality }),
        },
      });
      return {
        allowed: result.allowed,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      };
    },
  };
}
