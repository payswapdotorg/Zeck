/**
 * Policy resume re-admission adapter (executions module; WORK-028,
 * LNG-003 / acceptance criterion 4).
 *
 * Implements the executions module's REQUIRED `ResumePolicyReAdmission`
 * port against the REAL policy authority — the WORK-007 engine — through
 * its PUBLIC barrel only (the seam-adapter discipline of
 * `policy-sandbox-admission` / `policy-tool-admission` / the deployments
 * policy adapters: the adapter maps facts, it holds no decision logic).
 *
 * Fact mapping (the authority's vocabulary, restated): a MATERIALLY
 * CHANGED resume re-enters the AUTHORIZE-seam admission — the same seam
 * the frozen `authorize` transition consults at CREATED → AUTHORIZED —
 * because the cost ceiling is the restriction dimension that seam owns.
 * The context carries the execution identity (tenant/application/user/task
 * kind), so the engine resolves the CURRENT effective set and evaluates
 * the NEW facts against it: a resume under a materially higher cost
 * ceiling is denied by exactly the authority that admitted the original
 * execution. The other restriction dimensions (provider/model/tool/
 * network/secrets/autonomy/isolation) belong to the DISPATCH seams and
 * are re-entered through the resource seam (the sandbox re-consultation)
 * — never duplicated here.
 *
 * A materially changed resume without a configured policy set is denied
 * (no-policy-set fail-closed) — exactly the frozen authorize-seam
 * behavior; there is deliberately no default-allow.
 */

import type { PolicyAuthority } from "../../policies/public";
import type {
  ResumeReAdmissionDecision,
  ResumeReAdmissionRequest,
} from "../ports/resume-admission";

export function createPolicyResumeAdmission(authority: PolicyAuthority) {
  return {
    async readmit(request: ResumeReAdmissionRequest): Promise<ResumeReAdmissionDecision> {
      const taskKind = request.execution.task.kind;
      const decision = await authority.admit({
        context: {
          tenantId: request.execution.tenantId,
          applicationId: request.execution.applicationId,
          executionId: request.execution.id,
          ...(request.execution.userId === "" ? {} : { userId: request.execution.userId }),
          ...(typeof taskKind === "string" && taskKind !== "" ? { taskKind } : {}),
        },
        facts: {
          ...(request.resumeFacts.maxCostMicroUsd === null
            ? {}
            : { maxCostMicroUsd: request.resumeFacts.maxCostMicroUsd }),
        },
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          reason:
            decision.reason ??
            decision.denial?.message ??
            "the current policy set denies the materially changed resume",
          denialCode: "POLICY_DENIED",
        };
      }
      return { allowed: true };
    },
  };
}
