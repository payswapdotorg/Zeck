/**
 * Permissions domain (agents module domain; WORK-011, AGT-005/ACP-003).
 *
 * The frozen authority chain for agent permissions:
 *
 *   requested permissions (agent definition — an INPUT, never authority)
 *           ↓
 *   policy admission (the WORK-007 engine decides each requested fact)
 *           ↓
 *   EFFECTIVE permissions (the intersection: requested ∩ policy-approved)
 *           ↓
 *   credential mediation (scoped grants issued ONLY for effective refs)
 *           ↓
 *   agent runtime (receives ONLY the effective set + grant references)
 *
 * An agent definition can REQUEST anything; it can GRANT itself nothing.
 * The runtime contract carries the effective set exclusively, so
 * "agent self-grants permissions" (discrimination M9) is unrepresentable:
 * the intersection happens before any runtime-visible shape exists.
 */

import type { PolicyAdmissionEvidence } from "../../policies/public";

/** What the runtime may actually use (post-admission intersection). */
export interface EffectivePermissions {
  /** Policy-approved subset of requested tool capability ids. */
  readonly tools: readonly string[];
  /** Policy-approved subset of requested secret references. */
  readonly secretRefs: readonly string[];
  /** Policy-approved subset of requested model capability ids. */
  readonly models: readonly string[];
}

export const EMPTY_EFFECTIVE_PERMISSIONS: Readonly<EffectivePermissions> = {
  tools: [],
  secretRefs: [],
  models: [],
};

/**
 * Compute the effective permission set as the INTERSECTION of what the
 * agent requested with what the policy authority approved. Pure: the
 * caller supplies the approved subsets (the admission adapter derives
 * them from the policy engine's per-fact decisions).
 */
export function effectivePermissionsOf(
  requested: {
    readonly tools: readonly string[];
    readonly secretRefs: readonly string[];
    readonly models?: readonly string[];
  },
  approved: {
    readonly tools: readonly string[];
    readonly secretRefs: readonly string[];
    readonly models?: readonly string[];
  },
): EffectivePermissions {
  const requestedTools = new Set(requested.tools);
  const requestedRefs = new Set(requested.secretRefs);
  const requestedModels = new Set(requested.models ?? []);
  return {
    tools: approved.tools.filter((tool) => requestedTools.has(tool)),
    secretRefs: approved.secretRefs.filter((ref) => requestedRefs.has(ref)),
    models: (approved.models ?? []).filter((model) => requestedModels.has(model)),
  };
}

/**
 * Durable authorization context of a session admission: the policy
 * evidence (effective policy set identity + restriction-set digest — the
 * WORK-007 provenance shape) recorded with the session and replayed onto
 * the execution ledger as the "why" of the authorization.
 */
export interface SessionPolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

/** Narrow the authority's evidence onto the agents session shape. */
export function toSessionPolicyEvidence(evidence: PolicyAdmissionEvidence): SessionPolicyEvidence {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}
