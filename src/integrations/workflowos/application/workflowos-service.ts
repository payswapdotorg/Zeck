/**
 * WorkflowOS integration application service (WORK-016 / WOS-001,
 * WOS-003, WOS-004).
 *
 * THE submission/receipt facade over the executions AUTHORITY:
 *
 * ```text
 * WorkflowOS request (neutral submission)
 *      ↓ validate (fail-closed, closed vocabulary)
 *      ↓ concept-map (external refs → provenance metadata; scope from actor)
 * executions.createExecution(input, idempotencyKey, actor)   ← THE ONLY WRITE PATH
 *      ↓ receipt projection (public shapes only)
 * WorkflowOS-facing submission receipt
 * ```
 *
 * AUTHORITY DELEGATION (nothing is duplicated):
 *  - policy admission: the executions service's REQUIRED authorization
 *    seam decides (this service has no admission logic of its own —
 *    discrimination M4: a bypass is unrepresentable);
 *  - idempotency: DELEGATED to the executions authority's
 *    (application, operation, key, fingerprint) arbitration — the same
 *    key + the same fingerprint replays the durable outcome, the same
 *    key + a different fingerprint fails IDEMPOTENCY_KEY_REUSED, and
 *    concurrent duplicates converge on one durable identity (M15-class
 *    proofs run against the REAL authority). There is NO second
 *    idempotency ledger in this integration;
 *  - tenant/application scope: ALWAYS the server-derived
 *    `IntegrationActor` — a request carrying tenantId/applicationId is
 *    rejected fail-closed before any authority call (M8-class);
 *  - receipts: pure projections over the authority's public reads —
 *    no internal database structures, no WorkflowOS-state mutation of
 *    any kind (WOS-002/WOS-003: the receipt is DATA; WorkflowOS decides
 *    what it means for workflow state).
 */

import { PlatformError } from "../../../shared/errors";
import {
  buildEvidenceReceipt,
  buildSubmissionReceipt,
  type IntegrationActor,
  isValidIntegrationIdempotencyKey,
  submissionToExecutionInput,
  validateSubmissionRequest,
  type WorkflowOsEvidenceReceipt,
  type WorkflowOsSubmissionReceipt,
} from "../domain";
import type { WorkflowOsExecutionsAuthority } from "../ports/executions-authority";

export interface WorkflowOsIntegrationService {
  /**
   * Submit one WorkflowOS work item as a governed Zeck execution
   * (WOS-001). Idempotent by the caller-supplied key through the
   * EXECUTIONS AUTHORITY's arbitration.
   */
  submitWork(
    request: unknown,
    idempotencyKey: string,
    actor: IntegrationActor,
  ): Promise<WorkflowOsSubmissionReceipt>;

  /**
   * Read the WorkflowOS-facing evidence receipt for one execution
   * (WOS-003): identity, status, verification evidence, artifact
   * references, durable event references, warnings — public shapes
   * only, scope-checked through the authority.
   */
  executionReceipt(
    actor: IntegrationActor,
    executionId: string,
  ): Promise<WorkflowOsEvidenceReceipt>;
}

export interface WorkflowOsIntegrationDeps {
  /** THE executions authority (injected; never reimplemented here). */
  readonly executions: WorkflowOsExecutionsAuthority;
}

/** Fail-closed validation errors map to the canonical taxonomy. */
const invalid = (reason: string): PlatformError =>
  new PlatformError({ code: "POLICY_DENIED", message: `invalid WorkflowOS submission: ${reason}` });

export function createWorkflowOsIntegrationService(
  deps: WorkflowOsIntegrationDeps,
): WorkflowOsIntegrationService {
  const { executions } = deps;

  return {
    async submitWork(
      request: unknown,
      idempotencyKey: string,
      actor: IntegrationActor,
    ): Promise<WorkflowOsSubmissionReceipt> {
      if (typeof idempotencyKey !== "string" || !isValidIntegrationIdempotencyKey(idempotencyKey)) {
        throw invalid("idempotencyKey is required (printable ASCII, 1..200 chars)");
      }
      const check = validateSubmissionRequest(request);
      if (!check.valid) {
        throw invalid(check.reason);
      }
      // THE concept mapping: scope from the server-derived actor, external
      // refs preserved as provenance metadata (never scope, never state).
      const input = submissionToExecutionInput(check.value, actor);
      // THE single write path — policy admission, idempotency arbitration
      // and durable identity are the executions authority's invariants.
      const receipt = await executions.createExecution(input, idempotencyKey, {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
      });
      return buildSubmissionReceipt(receipt, check.value.workRef);
    },

    async executionReceipt(
      actor: IntegrationActor,
      executionId: string,
    ): Promise<WorkflowOsEvidenceReceipt> {
      // Scope-checked read through the authority (cross-tenant rows are
      // invisible: the authority's application-scoped getter returns null).
      const execution = await executions.getExecution(actor.applicationId, executionId);
      if (execution === null) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "execution not found within the integration's application scope",
          details: { executionId },
        });
      }
      if (execution.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "execution belongs to another tenant",
          details: { executionId },
        });
      }
      const [events, verification] = await Promise.all([
        executions.listEvents(actor.applicationId, executionId),
        executions.listVerificationResults(actor.applicationId, executionId),
      ]);
      // The echoed workRef (inside buildEvidenceReceipt) is present only
      // when this execution came from a WorkflowOS submission (the
      // provenance metadata block) — never fabricated.
      return buildEvidenceReceipt(execution, events, verification);
    },
  };
}
