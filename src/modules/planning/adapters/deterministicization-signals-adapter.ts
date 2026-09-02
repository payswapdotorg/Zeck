/**
 * Deterministicization signals adapter (planning module adapter;
 * WORK-021).
 *
 * Adapts the learning module's public `DeterministicizationSignalSource`
 * (the non-authoritative projection of the deterministicization
 * lifecycle candidates) to the planning-owned
 * `DeterministicizationSignals` port.
 *
 * FAIL-CLOSED VALIDATION AT THE SEAM (the consumer-side provenance
 * boundary): every candidate is validated with the planning-side
 * `validateConsultedDeterministicizationSignal` — the signal class,
 * the closed class/status vocabularies, the non-empty
 * source-execution provenance, the corpus/contract/incumbent digest
 * anchors and the honest rollout anchors must be present. An
 * unprovenanced candidate fails closed here and can NEVER reach a
 * durable planning decision record.
 *
 * This adapter only READS: the signal source exposes exactly one
 * consult method; there is nothing here that could mutate learning
 * state, planning state, a candidate's lifecycle or any authority.
 */

import type {
  DeterministicizationSignal,
  DeterministicizationSignalSource,
} from "../../learning/public";
import type { ConsultedDeterministicizationSignal } from "../domain/deterministicization-consultation";
import { validateConsultedDeterministicizationSignal } from "../domain/deterministicization-consultation";
import type {
  DeterministicizationSignalQuery,
  DeterministicizationSignals,
} from "../ports/deterministicization-signals";

function toConsultedSignal(
  signal: DeterministicizationSignal,
): ConsultedDeterministicizationSignal {
  const consulted: ConsultedDeterministicizationSignal = {
    signalClass: signal.signalClass,
    candidateId: signal.candidateId,
    candidateClass: signal.candidateClass,
    // The learning service filters to the rollout-relevant states; the
    // consumer-side validation below fail-closes on anything else
    // (proposed/rejected candidates carry no planning-relevant state).
    status: signal.status as ConsultedDeterministicizationSignal["status"],
    taskClass: signal.taskClass,
    subgraphId: signal.subgraphId,
    computationType: signal.computationType,
    population: signal.population,
    corpusDigest: signal.corpusDigest,
    sourceExecutionIds: [...signal.sourceExecutionIds],
    contractDigest: signal.contractDigest,
    incumbentStrategyClass: signal.incumbentStrategyClass,
    incumbentDescriptionDigest: signal.incumbentDescriptionDigest,
    rollbackTarget: signal.rollbackTarget,
    shadow: signal.shadow,
    canary: signal.canary,
    promotionDecisionId: signal.promotionDecisionId,
    promotedBy: signal.promotedBy,
    promotedAt: signal.promotedAt,
    rollbackDecisionId: signal.rollbackDecisionId,
    restoredIncumbent: signal.restoredIncumbent,
  };
  validateConsultedDeterministicizationSignal(consulted);
  return consulted;
}

export function createDeterministicizationSignalsAdapter(
  source: DeterministicizationSignalSource,
): DeterministicizationSignals {
  return {
    async consult(
      query: DeterministicizationSignalQuery,
    ): Promise<readonly ConsultedDeterministicizationSignal[]> {
      const signals = await source.consult({
        applicationId: query.applicationId,
        tenantId: query.tenantId,
        ...(query.taskClass === undefined ? {} : { taskClass: query.taskClass }),
      });
      // Fail closed on any unprovenanced/malformed candidate — the
      // validation throws before anything is returned to the planner.
      return signals.map(toConsultedSignal);
    },
  };
}
