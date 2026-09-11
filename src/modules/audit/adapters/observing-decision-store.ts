/**
 * Optimization decision-record seam observer (audit module adapter;
 * WORK-059 / SEC-004).
 *
 * OBSERVATION THROUGH EXISTING SEAMS: wraps the E1.1 optimization
 * decision-record store's append seam (the append-only decision
 * evidence authority — the durable single write path for optimization
 * decision records). Every decision record appended through the seam
 * is observed as `decision.recorded` audit evidence: WHO (the
 * decision's application/tenant scope), WHAT (the selected
 * representation and the transformation basis), WHEN, WHY (the
 * transformation-basis detail — the semantics-preserving argument),
 * PROVENANCE (the decision's content identity — the record is
 * replayable against the authoritative decision store).
 *
 * STRUCTURAL TYPING (the seam discipline of the E1.1 boundary tests):
 * the observer depends on the seam's STRUCTURE, never on the
 * platform decision-record plane — no module file imports that
 * foundation here (the seam boundary stays exactly as WORK-049
 * pinned it). The composition root injects the real store.
 *
 * The wrapped store remains the AUTHORITY: calls delegate, outcomes
 * pass through verbatim (including the idempotent replay flag — the
 * audit record's detail deliberately EXCLUDES it: identity stays
 * deterministic across retries).
 */

import type { AuditSubmission } from "../domain";
import { scrubAuditDetail } from "../domain";
import type { AuditRecordStore } from "../ports/audit-store";
import { AuditProjectionError } from "../ports/audit-store";

/** The decision-record fields the observer's evidence carries. */
export interface ObservedDecisionRecord {
  readonly decisionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  readonly planId: string;
  readonly irId: string;
  readonly selectedCandidateId: string;
  readonly transformationBasis: { readonly code: string; readonly detail: string };
}

/** The append seam's structural contract (the decision store's public append). */
export interface DecisionStoreSeamLike {
  append(
    record: ObservedDecisionRecord,
  ): Promise<{ readonly decisionId: string; readonly replayed: boolean }>;
}

export interface ObservingDecisionStoreOptions {
  /** The authoritative decision-record store (delegated to, unchanged). */
  readonly inner: DecisionStoreSeamLike;
  readonly store: AuditRecordStore;
  readonly environment: string;
  readonly now: () => Date;
}

/** The observation wrapper around the decision-record append seam. */
export function createObservingDecisionStore(
  options: ObservingDecisionStoreOptions,
): DecisionStoreSeamLike {
  const { inner, store, environment, now } = options;

  return {
    async append(record: ObservedDecisionRecord) {
      const outcome = await inner.append(record);

      const submission: AuditSubmission = {
        applicationId: record.applicationId,
        tenantId: record.tenantId,
        environment,
        actor: { actorId: record.applicationId, actorKind: "service-principal" },
        action: {
          kind: "decision.recorded",
          command: "optimization-decision-append",
          operationKey: record.decisionId,
        },
        target: { kind: "decision", id: record.decisionId },
        provenance: { seam: "optimization-decisions", sourceRecordId: record.decisionId },
        rationale: { why: record.transformationBasis.detail },
        occurredAt: now().toISOString(),
        actionDetail: scrubbedDetail({
          planId: record.planId,
          irId: record.irId,
          selectedCandidateId: record.selectedCandidateId,
          transformationBasisCode: record.transformationBasis.code,
          ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
        }),
      };

      try {
        await store.appendRecord(submission);
      } catch (error) {
        throw new AuditProjectionError(
          "the audit projection failed to record an optimization decision (fail closed; retry converges through the decision store's identity idempotency)",
          error,
        );
      }
      return outcome;
    },
  };
}

function scrubbedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const result = scrubAuditDetail(detail);
  if (!result.admissible) {
    throw new AuditProjectionError(
      `the decision action detail failed the audit scrub gate: ${result.reason}`,
    );
  }
  return result.detail;
}
