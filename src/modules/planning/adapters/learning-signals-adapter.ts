/**
 * Learning signals adapter (planning module adapter; WORK-014 / INT-006).
 *
 * Adapts the learning module's public `LearningSignalSource` (the
 * non-authoritative projection of the LATEST scorecard version) to the
 * planning-owned `LearningSignals` port.
 *
 * FAIL-CLOSED VALIDATION AT THE SEAM (M13): every learning signal is
 * validated with the planning-side `validateConsultedSignal` — the full
 * versioning basis (scorecard id + version, aggregation definition id +
 * version, telemetry schema version, population window) must be
 * present. An unversioned or malformed signal fails closed here and can
 * NEVER reach a durable planning decision record.
 *
 * This adapter only READS: the learning signal source exposes exactly
 * one consult method; there is nothing here that could mutate learning
 * state, planning state or any authority.
 */

import type { LearningSignal, LearningSignalSource } from "../../learning/public";
import type { ConsultedLearningSignal } from "../domain/learning-consultation";
import { validateConsultedSignal } from "../domain/learning-consultation";
import type { LearningSignalQuery, LearningSignals } from "../ports/learning-signals";

export interface LearningSignalsAdapterOptions {
  /**
   * The aggregation definition consulted (the route outcome definition
   * by default — the consultation target of candidate route subjects).
   */
  readonly definitionId?: string;
}

const DEFAULT_DEFINITION_ID = "route-outcome-by-task-class";

function toConsultedSignal(signal: LearningSignal): ConsultedLearningSignal {
  const consulted: ConsultedLearningSignal = {
    signalClass: signal.signalClass,
    subjectKind: signal.subjectKind,
    subjectKey: signal.subjectKey,
    taskClass: signal.taskClass,
    population: signal.population,
    successCount: signal.successCount,
    successRate: signal.successRate,
    meanCostMicroUsd: signal.meanCostMicroUsd,
    meanLatencyMs: signal.meanLatencyMs,
    uncertaintyLevel: signal.uncertaintyLevel,
    scorecardId: signal.scorecardId,
    scorecardVersion: signal.scorecardVersion,
    definitionId: signal.definitionId,
    definitionVersion: signal.definitionVersion,
    telemetrySchemaVersion: signal.telemetrySchemaVersion,
    populationWindowFrom: signal.populationWindowFrom,
    populationWindowTo: signal.populationWindowTo,
    evidenceRefs: [...signal.evidenceRefs],
  };
  validateConsultedSignal(consulted);
  return consulted;
}

export function createLearningSignalsAdapter(
  source: LearningSignalSource,
  options: LearningSignalsAdapterOptions = {},
): LearningSignals {
  const definitionId = options.definitionId ?? DEFAULT_DEFINITION_ID;
  return {
    async consult(query: LearningSignalQuery): Promise<readonly ConsultedLearningSignal[]> {
      const signals = await source.consult({
        applicationId: query.applicationId,
        tenantId: query.tenantId,
        definitionId,
        taskClass: query.taskClass,
        subjectKeys: query.subjectKeys,
      });
      // Fail closed on any unversioned/malformed signal (M13) — the
      // validation throws before anything is returned to the planner.
      return signals.map(toConsultedSignal);
    },
  };
}
