/**
 * Policy training-admission adapter (sandbox module; WORK-030).
 *
 * Implements the sandbox module's REQUIRED `TrainingAdmission` port
 * against the REAL policy authority (the WORK-007 engine) — the
 * seam-adapter discipline of `policy-sandbox-admission` (WORK-012)
 * applied to the training/accelerator axis: the adapter maps the
 * workload's DECLARED admission facts onto `PolicyDispatchRequest`
 * facts and delegates; it holds no decision logic of its own.
 *
 * Fact mapping (the authority's vocabulary, restated):
 *
 *   - the ISOLATION fact: the compute class the workload runs on (the
 *     substrate's declared isolation class when the catalog selection
 *     carried it; the container floor otherwise) — a policy isolation
 *     floor constrains training compute exactly like any dispatch;
 *   - the SECRET-ACCESS facts: every DECLARED secret reference (one
 *     fact per reference — references only, never values;
 *     materialization stays behind the connections vault seam);
 *   - the bare decision: even a training workload with no secret refs
 *     and an allowed isolation class still passes the bare policy gate
 *     (the deny-by-default engine must have a configured set).
 *
 * ALL facts must be allowed — one denial denies the admission. Every
 * decision carries the authority's durable admission evidence onto the
 * workload record.
 */

import type { IsolationLevel, PolicyAuthority } from "../../policies/public";
import type {
  TrainingAdmission,
  TrainingAdmissionDecision,
  TrainingAdmissionRequest,
} from "../ports/training-admission";
import { SANDBOX_KIND_TO_ISOLATION } from "./policy-sandbox-admission";

/** Narrow the authority's evidence onto the workload evidence shape. */
function toEvidence(evidence: {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}): {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
} {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}

export function createPolicyTrainingAdmission(
  authority: PolicyAuthority,
  options: {
    /** The substrate's declared isolation class (the selection evidence). */
    readonly substrateIsolation?: string;
    /** The environment kind fallback for isolation facts. */
    readonly environmentKind?: keyof typeof SANDBOX_KIND_TO_ISOLATION;
  } = {},
): TrainingAdmission {
  const isolationOf = (): IsolationLevel => {
    if (options.substrateIsolation !== undefined) {
      const level = options.substrateIsolation as IsolationLevel;
      if (Object.values(SANDBOX_KIND_TO_ISOLATION).includes(level)) {
        return level;
      }
    }
    const kind = options.environmentKind ?? "container";
    return SANDBOX_KIND_TO_ISOLATION[kind];
  };
  return {
    async admit(request: TrainingAdmissionRequest): Promise<TrainingAdmissionDecision> {
      const context = {
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        executionId: request.executionId,
      };

      // 1. The isolation fact: the class of compute the workload runs on.
      const isolationDecision = await authority.admitDispatch({
        context,
        facts: { isolation: isolationOf() },
      });
      if (!isolationDecision.allowed) {
        return {
          allowed: false,
          reason:
            isolationDecision.reason ??
            isolationDecision.denial?.message ??
            "the training workload's isolation class is not permitted by the effective policy",
        };
      }
      const carry =
        isolationDecision.evidence === undefined ? null : toEvidence(isolationDecision.evidence);

      // 2. The secret-access facts (one fact per declared reference).
      for (const secretRef of request.secretRefs) {
        const secretDecision = await authority.admitDispatch({ context, facts: { secretRef } });
        if (!secretDecision.allowed) {
          return {
            allowed: false,
            reason:
              secretDecision.reason ??
              secretDecision.denial?.message ??
              `secret reference "${secretRef}" is not permitted by the effective policy`,
          };
        }
      }

      // 3. The bare decision (deny-by-default engine must allow the
      //    context at all — the no-fact baseline).
      const bareDecision = await authority.admitDispatch({ context, facts: {} });
      if (!bareDecision.allowed) {
        return {
          allowed: false,
          reason:
            bareDecision.reason ??
            bareDecision.denial?.message ??
            "training workload denied by the effective policy",
        };
      }
      const evidence =
        carry ?? (bareDecision.evidence === undefined ? null : toEvidence(bareDecision.evidence));
      return evidence === null ? { allowed: true } : { allowed: true, evidence };
    },
  };
}
