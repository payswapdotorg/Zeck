/**
 * Opportunity signals adapter (planning module adapter; WORK-022).
 *
 * Adapts the learning module's public `OpportunitySignalSource` (the
 * non-authoritative projection of the codebase-opportunity advisory
 * findings) to the planning-owned `OpportunitySignals` port.
 *
 * FAIL-CLOSED VALIDATION AT THE SEAM (M11/M12/M13/M27/M28): every
 * finding is validated with the planning-side
 * `validateConsultedOpportunitySignal` — the full version/provenance
 * basis (analysis id + version, repository + revision, target node
 * ids, evidence refs, confidence level + population, the impact
 * bases) must be present. An unversioned or unprovenanced finding
 * fails closed here and can NEVER reach a durable planning decision
 * record.
 *
 * This adapter only READS: the opportunity signal source exposes
 * exactly one consult method; there is nothing here that could mutate
 * learning state, planning state, a finding's advisory lifecycle or
 * any authority.
 */

import type { OpportunitySignal, OpportunitySignalSource } from "../../learning/public";
import type { ConsultedOpportunitySignal } from "../domain/opportunity-consultation";
import { validateConsultedOpportunitySignal } from "../domain/opportunity-consultation";
import type { OpportunitySignalQuery, OpportunitySignals } from "../ports/opportunity-signals";

function toConsultedSignal(signal: OpportunitySignal): ConsultedOpportunitySignal {
  const consulted: ConsultedOpportunitySignal = {
    signalClass: signal.signalClass,
    findingId: signal.findingId,
    analysisId: signal.analysisId,
    analysisVersion: signal.analysisVersion,
    class: signal.class,
    state: signal.state,
    confidenceLevel: signal.confidenceLevel,
    population: signal.population,
    repository: signal.repository,
    revision: signal.revision,
    targetNodeIds: [...signal.targetNodeIds],
    reasonCodes: [...signal.reasonCodes],
    evidenceRefs: [...signal.evidenceRefs],
    costImpactBasis: signal.costImpactBasis,
    latencyImpactBasis: signal.latencyImpactBasis,
    deterministicEquivalencePotential: signal.deterministicEquivalencePotential,
  };
  validateConsultedOpportunitySignal(consulted);
  return consulted;
}

export function createOpportunitySignalsAdapter(
  source: OpportunitySignalSource,
): OpportunitySignals {
  return {
    async consult(query: OpportunitySignalQuery): Promise<readonly ConsultedOpportunitySignal[]> {
      const signals = await source.consult({
        applicationId: query.applicationId,
        tenantId: query.tenantId,
        ...(query.repository === undefined ? {} : { repository: query.repository }),
        ...(query.class === undefined ? {} : { class: query.class }),
      });
      // Fail closed on any unversioned/malformed finding — the
      // validation throws before anything is returned to the planner.
      return signals.map(toConsultedSignal);
    },
  };
}
