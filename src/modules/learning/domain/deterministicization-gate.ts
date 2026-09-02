/**
 * The deterministicization promotion gate (learning module domain;
 * WORK-021 / DTR-002, DTR-004; `spec/deterministicization-contract.md`
 * "Evidence required for promotion").
 *
 * THE GATE IS A PURE, FAIL-CLOSED FUNCTION over recorded evidence:
 *
 *   candidate + stage evidence + rollouts + CONFIGURABLE thresholds
 *     → { verdict: promote | not-promoted, reasons[] }
 *
 * Fail-closed rules (the work order's implementation requirements):
 *  - promotion requires a PASSING evidence record for EVERY offline
 *    validation stage (offline replay, differential evaluation,
 *    property/metamorphic tests, mutation evidence) — a missing stage
 *    is UNKNOWN evidence and unknown evidence never promotes;
 *  - every consulted population must meet the configured minimums
 *    (insufficient evidence never promotes — the evidence is never
 *    "amplified" into confidence);
 *  - the differential acceptance rate must meet the configured
 *    minimum; the canary quality delta must not degrade beyond the
 *    configured maximum;
 *  - the candidate must have COMPLETED the shadow and canary rollout
 *    phases (shadow before canary, canary before promotion — the
 *    contract's pipeline order is structural);
 *  - an 'insufficient' stage evidence record is recorded evidence OF
 *    INSUFFICIENCY: it fails closed exactly like a missing record,
 *    never silently passes.
 *
 * THIS FILE NEVER PROMOTES ANYTHING: it evaluates and explains. The
 * application service refuses to apply a promotion unless the verdict
 * is 'promote'; a mutant that removes a check here is caught by the
 * discrimination suite (the AC6 probe: silently replacing uncertain AI
 * work without validation cannot pass the gate).
 *
 * Pure domain: no side effects, imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  DeterministicizationCandidate,
  RolloutRecord,
  StageEvidenceRecord,
  ValidationStageKind,
} from "./deterministicization";
import { VALIDATION_STAGE_KINDS } from "./deterministicization";

/**
 * The configurable statistical/evaluation thresholds of the promotion
 * gate (the work order: "promotion must require configurable
 * statistical/evaluation thresholds").
 */
export interface PromotionGateConfig {
  /** Minimum replay-corpus population of the offline-replay evidence. */
  readonly minimumReplayPopulation: number;
  /** Minimum pair population of the differential evaluation evidence. */
  readonly minimumDifferentialPopulation: number;
  /** Minimum differential acceptance rate in [0,1]. */
  readonly minimumAcceptanceRate: number;
  /** Minimum property/metamorphic pass fraction in [0,1]. */
  readonly minimumPropertyPassRate: number;
  /** Whether mutation discrimination evidence is required. */
  readonly requireMutationEvidence: boolean;
  /** Minimum observed population of the shadow rollout phase. */
  readonly minimumShadowPopulation: number;
  /** Minimum observed population of the canary rollout phase. */
  readonly minimumCanaryPopulation: number;
  /** Minimum matched fraction of the canary rollout in [0,1]. */
  readonly minimumCanaryMatchRate: number;
  /** Maximum allowed quality degradation in [0,1] (0 = none). */
  readonly maximumQualityDegradation: number;
}

/** The shipped defaults (conservative; every threshold configurable). */
export const DEFAULT_PROMOTION_GATE_CONFIG: PromotionGateConfig = {
  minimumReplayPopulation: 20,
  minimumDifferentialPopulation: 20,
  minimumAcceptanceRate: 0.95,
  minimumPropertyPassRate: 1,
  requireMutationEvidence: true,
  minimumShadowPopulation: 10,
  minimumCanaryPopulation: 10,
  minimumCanaryMatchRate: 0.99,
  maximumQualityDegradation: 0,
};

/** Validate a gate configuration (fail closed on nonsense thresholds). */
export function validatePromotionGateConfig(value: PromotionGateConfig): void {
  const ratio = (name: string, input: number, minimum: number, maximum: number): void => {
    if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `promotion gate config ${name} must be a number in [${minimum}, ${maximum}]`,
        details: { field: name, got: input },
      });
    }
  };
  const positive = (name: string, input: number): void => {
    if (typeof input !== "number" || !Number.isInteger(input) || input < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `promotion gate config ${name} must be a positive integer`,
        details: { field: name, got: input },
      });
    }
  };
  positive("minimumReplayPopulation", value.minimumReplayPopulation);
  positive("minimumDifferentialPopulation", value.minimumDifferentialPopulation);
  ratio("minimumAcceptanceRate", value.minimumAcceptanceRate, 0, 1);
  ratio("minimumPropertyPassRate", value.minimumPropertyPassRate, 0, 1);
  if (typeof value.requireMutationEvidence !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "promotion gate config requireMutationEvidence must be a boolean",
    });
  }
  positive("minimumShadowPopulation", value.minimumShadowPopulation);
  positive("minimumCanaryPopulation", value.minimumCanaryPopulation);
  ratio("minimumCanaryMatchRate", value.minimumCanaryMatchRate, 0, 1);
  ratio("maximumQualityDegradation", value.maximumQualityDegradation, 0, 1);
}

/** The gate's evaluation output. */
export interface PromotionGateEvaluation {
  readonly verdict: "promote" | "not-promoted";
  readonly reasons: readonly string[];
  readonly stageEvidenceIds: readonly string[];
  readonly rolloutIds: readonly string[];
}

/** The stage-specific population floor of a config (pure lookup). */
function populationFloor(config: PromotionGateConfig, stage: ValidationStageKind): number {
  switch (stage) {
    case "offline-replay":
      return config.minimumReplayPopulation;
    case "differential-evaluation":
      return config.minimumDifferentialPopulation;
    default:
      return 1;
  }
}

/**
 * Evaluate the promotion gate over recorded evidence (pure, fail
 * closed). EVERY consulted record is revision-bound: the evidence ids
 * and rollout ids are returned so the decision record can cite them.
 */
export function evaluatePromotionGate(input: {
  readonly candidate: DeterministicizationCandidate;
  readonly stageEvidence: readonly StageEvidenceRecord[];
  readonly rollouts: readonly RolloutRecord[];
  readonly config: PromotionGateConfig;
}): PromotionGateEvaluation {
  const reasons: string[] = [];
  const { candidate, stageEvidence, rollouts, config } = input;

  // 1. The candidate must be in the canary phase (shadow → canary →
  //    promotion — the contract's pipeline order is structural).
  if (candidate.status !== "canary") {
    reasons.push(
      `candidate status is '${candidate.status}' — promotion requires the completed shadow and canary phases (shadow/canary before promotion)`,
    );
  }

  // 2. EVERY offline validation stage must carry PASSING evidence with
  //    an adequate population. Missing OR insufficient evidence fails
  //    closed — unknown evidence never promotes.
  const evidenceIds: string[] = [];
  for (const stage of VALIDATION_STAGE_KINDS) {
    if (stage === "mutation-tests" && !config.requireMutationEvidence) {
      continue;
    }
    const records = stageEvidence.filter((record) => record.stageKind === stage);
    if (records.length === 0) {
      reasons.push(
        `insufficient-evidence: no ${stage} evidence record exists (unknown evidence fails closed)`,
      );
      continue;
    }
    // One settled record per stage is the lifecycle discipline; the
    // honest read is: the latest settled record of the stage.
    const record = records[records.length - 1] as StageEvidenceRecord;
    if (record.candidateId !== candidate.candidateId) {
      reasons.push(`evidence-record mismatch: ${stage} record is bound to another candidate`);
      continue;
    }
    evidenceIds.push(record.evidenceId);
    if (record.status === "insufficient") {
      reasons.push(
        `insufficient-evidence: the ${stage} record honestly records insufficiency (never amplified into confidence)`,
      );
      continue;
    }
    if (record.status === "failed") {
      reasons.push(`failed-evidence: the ${stage} record observed rejected runs`);
      continue;
    }
    const floor = populationFloor(config, stage);
    if (record.metrics.population < floor) {
      reasons.push(
        `insufficient-evidence: ${stage} population ${record.metrics.population} is below the configured floor ${floor}`,
      );
    }
    if (stage === "differential-evaluation" && record.metrics.acceptanceRate < config.minimumAcceptanceRate) {
      reasons.push(
        `differential-acceptance: rate ${record.metrics.acceptanceRate.toFixed(3)} is below the configured minimum ${config.minimumAcceptanceRate}`,
      );
    }
    if (stage === "property-tests") {
      const pass = record.metrics.propertyPassCount ?? 0;
      const fail = record.metrics.propertyFailCount ?? 0;
      const total = pass + fail;
      const passRate = total === 0 ? 0 : pass / total;
      if (passRate < config.minimumPropertyPassRate) {
        reasons.push(
          `property-pass-rate: ${passRate.toFixed(3)} is below the configured minimum ${config.minimumPropertyPassRate}`,
        );
      }
    }
    if (stage === "mutation-tests") {
      const missed = record.metrics.mutationMissedCount ?? 0;
      if (missed > 0) {
        reasons.push(
          `mutation-discrimination: ${missed} mutant(s) survived (unc discriminated mutations block promotion)`,
        );
      }
    }
  }

  // 3. The rollout phases must be CONCLUDED with adequate populations
  //    and honest deltas (shadow before canary; canary before promotion).
  const rolloutIds: string[] = [];
  for (const mode of ["shadow", "canary"] as const) {
    const records = rollouts.filter((rollout) => rollout.mode === mode);
    if (records.length === 0) {
      reasons.push(`insufficient-evidence: no ${mode} rollout record exists`);
      continue;
    }
    const rollout = records[records.length - 1] as RolloutRecord;
    rolloutIds.push(rollout.rolloutId);
    if (rollout.status !== "concluded") {
      reasons.push(`${mode} rollout is still observing (a live rollout never promotes)`);
      continue;
    }
    const floor =
      mode === "shadow" ? config.minimumShadowPopulation : config.minimumCanaryPopulation;
    if (rollout.population < floor) {
      reasons.push(
        `insufficient-evidence: ${mode} rollout population ${rollout.population} is below the configured floor ${floor}`,
      );
    }
    if (mode === "canary") {
      if (rollout.qualityDelta < config.minimumCanaryMatchRate) {
        reasons.push(
          `canary-match-rate: ${rollout.qualityDelta.toFixed(3)} is below the configured minimum ${config.minimumCanaryMatchRate}`,
        );
      }
      // The quality delta bound: matched fraction of the population.
      if (rollout.population > 0 && 1 - rollout.qualityDelta > config.maximumQualityDegradation) {
        reasons.push(
          `quality-degradation: ${(1 - rollout.qualityDelta).toFixed(3)} exceeds the configured maximum ${config.maximumQualityDegradation}`,
        );
      }
    }
  }

  return {
    verdict: reasons.length === 0 ? "promote" : "not-promoted",
    reasons,
    stageEvidenceIds: evidenceIds,
    rolloutIds,
  };
}

/** The canonical basis of a gate config's digest (revision-bound). */
export function promotionGateConfigBasis(config: PromotionGateConfig): Record<string, unknown> {
  return { gateConfigSchema: 1, ...config };
}
