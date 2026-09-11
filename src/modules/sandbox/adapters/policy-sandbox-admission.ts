/**
 * Policy sandbox-admission adapter (sandbox module; WORK-012).
 *
 * Implements the sandbox module's REQUIRED `SandboxAdmission` port against
 * the REAL policy authority (the WORK-007 engine) — the seam-adapter
 * discipline of `policy-tool-admission` (WORK-010) and
 * `policy-agent-admission` (WORK-011): the adapter maps the environment's
 * DECLARED admission facts onto `PolicyDispatchRequest` facts and
 * delegates; it holds no decision logic of its own.
 *
 * Fact mapping (the authority's vocabulary, restated):
 *
 *   - the environment KIND maps onto the frozen isolation ladder
 *     (`no-execution → none`, `process → process`, `container →
 *     container`, …). `no-execution` submits NO isolation fact: nothing
 *     runs, so there is no isolation to evaluate — a policy floor of
 *     `container` constrains executing kinds, never the no-execution
 *     choice (which is the safest, not the weakest, posture);
 *   - WORK-058 / SEC-002: the DECLARED isolation-profile class rides the
 *     SAME frozen isolation fact through its ladder anchor —
 *     `standard`/`strict` anchor at the kind's level (the strict shape is
 *     already the tightest posture on the network/secrets dimensions, so
 *     no dimension can be violated by it), and `dedicated-customer`
 *     anchors at `customer-runner` (the ladder's dedicated-runner class).
 *     A policy floor of `customer-runner` therefore REQUIRES the
 *     dedicated class — policy declares the required class; the sandbox
 *     authority admits/constructs it. There is no profile-specific
 *     policy engine here: the mapping is a pure vocabulary anchor and
 *     the AUTHORITY decides;
 *   - every DECLARED network host is an egress fact the effective policy
 *     must permit (undeclared hosts are never dispatched — the runtime
 *     receives only the admitted allowlist);
 *   - every DECLARED secret reference is a secret-access fact (references
 *     only — never values; materialization stays behind the connections
 *     vault seam).
 *
 * ALL facts must be allowed — one denial denies the admission. Every
 * decision carries the authority's durable admission evidence (effective
 * policy set identity + restriction-set digest) onto the sandbox record.
 *
 * The sandbox network contract is DELIBERATELY NARROWER than the policy
 * network dimension: a sandbox can only ever be `none` or an explicit
 * allowlist — an `open` egress policy never widens the sandbox's own
 * declaration (policies may tighten; declarations never widen).
 *
 * Type-only coupling depth: this adapter imports the policies module's
 * PUBLIC barrel (the authority surface). No policy semantics are
 * reimplemented here — there is no sandbox-specific policy engine.
 */

import type { IsolationLevel, PolicyAuthority } from "../../policies/public";
import type { SandboxEnvironmentKind } from "../domain/environment";
import { kindExecutes } from "../domain/environment";
import type { IsolationProfileClass } from "../domain/isolation";
import { isolationLadderAnchor } from "../domain/isolation";
import type { SandboxPolicyEvidence } from "../domain/sandbox";
import type {
  SandboxAdmission,
  SandboxAdmissionDecision,
  SandboxAdmissionRequest,
} from "../ports/sandbox-admission";

/** The sandbox kind → policy isolation-ladder mapping (1:1 vocabulary alignment). */
export const SANDBOX_KIND_TO_ISOLATION: Readonly<Record<SandboxEnvironmentKind, IsolationLevel>> = {
  "no-execution": "none",
  process: "process",
  container: "container",
  microvm: "microvm",
  vm: "vm",
  "customer-runner": "customer-runner",
};

/**
 * The isolation-profile class → policy isolation-ladder anchor
 * (WORK-058 / SEC-002 — the governed-selection fact mapping; a pure
 * vocabulary anchor, the authority decides):
 *
 *   - `standard`/`strict` anchor at the environment KIND's ladder level;
 *   - `dedicated-customer` anchors at `customer-runner` — the ladder's
 *     dedicated-runner class, so a policy floor of `customer-runner`
 *     requires the class and a dedicated environment satisfies every
 *     floor its class meets.
 */
export function isolationProfileLadderAnchor(
  kind: SandboxEnvironmentKind,
  profileClass: IsolationProfileClass,
): IsolationLevel {
  return isolationLadderAnchor({ kind, profileClass });
}

/** Narrow the authority's evidence onto the sandbox evidence shape (structural). */
function toEvidence(evidence: {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}): SandboxPolicyEvidence {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}

export function createPolicySandboxAdmission(authority: PolicyAuthority): SandboxAdmission {
  return {
    async admit(request: SandboxAdmissionRequest): Promise<SandboxAdmissionDecision> {
      const context = {
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        executionId: request.executionId,
      };

      // 1. The isolation fact: which environment KIND + isolation-PROFILE
      //    class would be admitted. (no-execution submits no isolation
      //    fact — see the header note; the profile anchors at the kind's
      //    ladder level for standard/strict and at the dedicated-runner
      //    class for dedicated-customer — the AUTHORITY decides on the
      //    frozen ladder.)
      if (kindExecutes(request.kind)) {
        const kindDecision = await authority.admitDispatch({
          context,
          facts: {
            isolation: isolationProfileLadderAnchor(request.kind, request.isolationProfile),
          },
        });
        if (!kindDecision.allowed) {
          return {
            allowed: false,
            reason:
              kindDecision.reason ??
              kindDecision.denial?.message ??
              `environment kind "${request.kind}" is not permitted by the effective policy`,
          };
        }
        if (kindDecision.evidence !== undefined) {
          return evaluateFacts(authority, request, context, toEvidence(kindDecision.evidence));
        }
        return evaluateFacts(authority, request, context, null);
      }
      // No-execution: hosts/secretRefs are structurally empty (validated at
      // the spec boundary); the admission carries no isolation fact.
      const bareDecision = await authority.admitDispatch({ context, facts: {} });
      if (!bareDecision.allowed) {
        return {
          allowed: false,
          reason:
            bareDecision.reason ??
            bareDecision.denial?.message ??
            "no-execution environment denied by the effective policy",
        };
      }
      return {
        allowed: true,
        ...(bareDecision.evidence === undefined
          ? {}
          : { evidence: toEvidence(bareDecision.evidence) }),
      };
    },
  };
}

/** Evaluate every declared host/secret fact; ALL must be allowed. */
async function evaluateFacts(
  authority: PolicyAuthority,
  request: SandboxAdmissionRequest,
  context: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly executionId: string;
  },
  evidence: SandboxPolicyEvidence | null,
): Promise<SandboxAdmissionDecision> {
  const carry: SandboxPolicyEvidence | null = evidence;
  for (const host of request.hosts) {
    const hostDecision = await authority.admitDispatch({ context, facts: { host } });
    if (!hostDecision.allowed) {
      return {
        allowed: false,
        reason:
          hostDecision.reason ??
          hostDecision.denial?.message ??
          `network host "${host}" is not permitted by the effective policy`,
      };
    }
  }
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
  return carry === null ? { allowed: true } : { allowed: true, evidence: carry };
}
