/**
 * Policy admission seam observer (audit module adapter; WORK-059 / SEC-004).
 *
 * OBSERVATION THROUGH EXISTING SEAMS: wraps the executions module's
 * `ExecutionAuthorizationPort` (the policy-admission seam the
 * executions authority consults BEFORE any authorize state write —
 * implemented by the policies module's public contract at
 * composition). Every admission decision that flows through the seam
 * is recorded as `policy.decision` evidence: WHO requested, WHAT was
 * requested (the transition being admitted), WHEN, WHY (the denial
 * reason or the effective-policy provenance) with the exact policy
 * set identity/version/content hash.
 *
 * THE DECISION IS NEVER CHANGED: the wrapper returns the wrapped
 * authority's verdict VERBATIM — allow, deny, evidence, reason all
 * pass through untouched (proven by discrimination test: a denying
 * authority stays denying, an allowing one stays allowing, regardless
 * of the projection's state). The observer records; it never
 * authorizes, filters or rewrites.
 *
 * FAIL-CLOSED OBSERVATION: an audit append failure after a decision
 * was made throws the typed projection error — the caller retries,
 * the authority re-evaluates deterministically (same policy set, same
 * facts) and the audit append converges through content identity.
 */

import type { AuditSubmission } from "../domain";
import { scrubAuditDetail } from "../domain";
import type { AuditRecordStore } from "../ports/audit-store";
import { AuditProjectionError } from "../ports/audit-store";

/**
 * The admission seam's structural contract (the executions module's
 * `ExecutionAuthorizationPort` shape — the seam the policy authority
 * implements; typed structurally here so the observer observes the
 * SEAM, not a specific module's internals).
 */
export interface AdmissionSeamLike {
  evaluate(input: {
    readonly execution: {
      readonly id: string;
      readonly applicationId: string;
      readonly tenantId: string;
      readonly status: string;
      /** The executions authority's execution record shape (task/user). */
      readonly userId?: string;
      readonly task?: Readonly<Record<string, unknown>>;
      readonly constraints?: unknown;
    };
    readonly actorId: string;
  }): Promise<{
    readonly allowed: boolean;
    readonly reason?: string;
    readonly evidence?: {
      readonly policySetId: string;
      readonly policySetVersion: number;
      readonly policyContentHash: string;
      readonly restrictionSetDigest?: string;
    };
  }>;
}

export interface ObservingAdmissionOptions {
  /** The authoritative admission seam (delegated to, unchanged). */
  readonly inner: AdmissionSeamLike;
  readonly store: AuditRecordStore;
  readonly environment: string;
  /**
   * The governed command the admission is requested for (the seam
   * itself is called during the authorize transition; the observer is
   * composed per transition command by the composition root).
   */
  readonly command: string;
  readonly actorKind?: "human-principal" | "service-principal";
  readonly now: () => Date;
}

/** The observation wrapper around the policy-admission seam. */
export function createObservingAdmission(options: ObservingAdmissionOptions): AdmissionSeamLike {
  const { inner, store, environment, now } = options;
  const actorKind = options.actorKind ?? "service-principal";

  return {
    async evaluate(input: Parameters<AdmissionSeamLike["evaluate"]>[0]) {
      const decision = await inner.evaluate(input);

      const submission: AuditSubmission = {
        applicationId: input.execution.applicationId,
        tenantId: input.execution.tenantId,
        environment,
        actor: { actorId: input.actorId, actorKind },
        action: {
          kind: "policy.decision",
          command: options.command,
          operationKey: `admission:${input.execution.id}:${options.command}`,
        },
        target: { kind: "execution", id: input.execution.id },
        provenance: {
          seam: "policies.admission",
          sourceRecordId: input.execution.id,
        },
        rationale: {
          why: decision.allowed
            ? "policy admission allowed the governed transition"
            : `policy admission denied the governed transition: ${decision.reason ?? "unspecified"}`,
          ...(decision.evidence === undefined
            ? {}
            : {
                policyContext: {
                  policySetId: decision.evidence.policySetId,
                  policySetVersion: decision.evidence.policySetVersion,
                  policyContentHash: decision.evidence.policyContentHash,
                  ...(decision.evidence.restrictionSetDigest === undefined
                    ? {}
                    : { restrictionSetDigest: decision.evidence.restrictionSetDigest }),
                },
              }),
        },
        occurredAt: now().toISOString(),
        actionDetail: scrubbedDetail({
          allowed: decision.allowed,
          executionStatus: input.execution.status,
          ...(decision.reason === undefined ? {} : { denialReason: decision.reason }),
        }),
      };

      try {
        await store.appendRecord(submission);
      } catch (error) {
        throw new AuditProjectionError(
          "the audit projection failed to record a policy decision (fail closed; retry converges through deterministic re-evaluation)",
          error,
        );
      }
      return decision;
    },
  };
}

function scrubbedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const result = scrubAuditDetail(detail);
  if (!result.admissible) {
    throw new AuditProjectionError(
      `the policy-decision detail failed the audit scrub gate: ${result.reason}`,
    );
  }
  return result.detail;
}
