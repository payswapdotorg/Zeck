/**
 * Policy authority ports (policies module outbound; WORK-007).
 *
 * The AUTHORITY is the policy engine: resolution + admission evaluation
 * happen HERE (never in callers); dispatch and authorize seams are inputs,
 * never authorities. Mirrors the WORK-005 registry-port discipline.
 */

import type { DispatchFacts, ExecutionAdmissionFacts } from "../domain/admission";
import type {
  PolicyRequestContext,
  PolicySet,
  PolicySetIdentity,
  RestrictionSet,
} from "../domain/policy";

/** Content-addressed storage boundary for policy sets. */
export interface PolicySetRecord {
  readonly set: PolicySet;
  readonly contentHash: string;
  readonly publishedAt: string;
}

export type { PolicySetIdentity };

/**
 * Storage seam for policy DEFINITIONS (WORK-005 store-port precedent).
 * The in-memory adapter ships this round: definitions are configuration-
 * resident versioned data; durable ADMISSION DECISIONS are recorded by the
 * executions EventEnvelope ledger (see docs/work-items/WORK-007.md — no
 * migration is required). A durable adapter implements the identical
 * contract without touching the authority.
 */
export interface PolicyStore {
  /** The current effective set (null when nothing is configured). */
  load(): Promise<PolicySetRecord | null>;
  /** Store a PRE-ARBITRATED record (authority calls only, under its queue). */
  save(record: PolicySetRecord): Promise<void>;
}

/** Content-hash primitive (sha256 over text). Injected; adapters own crypto. */
export interface PolicyHasher {
  sha256Hex(text: string): string;
}

/**
 * Durable admission provenance carried on every decision (WORK-007
 * acceptance criterion 5): the effective policy set identity + the digest
 * of the exact resolved restriction set that produced the decision.
 */
export interface PolicyAdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

/** The request the executions `authorize` seam submits (post scope resolution). */
export interface PolicyAdmissionRequest {
  readonly context: PolicyRequestContext;
  readonly facts?: ExecutionAdmissionFacts;
}

/** The request a dispatch seam (provider/tool/agent/sandbox/secret) submits. */
export interface PolicyDispatchRequest {
  readonly context: PolicyRequestContext;
  readonly facts: DispatchFacts;
}

/** Machine-readable denial detail (canonical `POLICY_DENIED` upstream). */
export interface PolicyDenialDetail {
  readonly kind: "prohibited" | "weakening" | "no-policy-set" | "restriction";
  readonly dimension?: string;
  readonly message: string;
}

export interface PolicyAdmissionResult {
  readonly allowed: boolean;
  readonly reason?: string;
  /** ALWAYS present when a configured set was evaluated (allow AND deny). */
  readonly evidence?: PolicyAdmissionEvidence;
  /** The effective restriction set (dispatch seams re-evaluate facts against it). */
  readonly effective?: RestrictionSet;
  readonly denial?: PolicyDenialDetail;
}

export type PolicyPublishOutcome =
  | { readonly status: "published"; readonly identity: PolicySetIdentity }
  | { readonly status: "converged"; readonly identity: PolicySetIdentity };

/** The policy engine — the single policy authority of the platform. */
export interface PolicyAuthority {
  /**
   * Publish a policy set INTO the authority. Validation and arbitration
   * happen HERE: malformed sets, ambiguous subjects and version rollbacks
   * are rejected; an identical republish converges. Publishing is an
   * input, never an authority.
   */
  publish(set: PolicySet): Promise<PolicyPublishOutcome>;
  /** The authorize-seam admission evaluation (POLICY-BEFORE-DISPATCH). */
  admit(request: PolicyAdmissionRequest): Promise<PolicyAdmissionResult>;
  /** The dispatch-seam admission evaluation (provider/tool/agent/sandbox/secret). */
  admitDispatch(request: PolicyDispatchRequest): Promise<PolicyAdmissionResult>;
  /** The current effective set (inspection/evidence surface). */
  current(): Promise<PolicySetRecord | null>;
}
