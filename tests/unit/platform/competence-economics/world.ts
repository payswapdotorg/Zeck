/**
 * The shared competence-economics unit-test world (WORK-056): the
 * governed Execution IR fixtures (through the REAL planning seam and
 * the REAL foundation derivation — the plane only ever runs on
 * governed IRs), the representative governing constraint sets, the
 * environment-fingerprint fixtures (through the failure-recovery
 * plane's OWN function), the successful-trajectory corpus, and the
 * explicit-basis claim builders.
 */

import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import type {
  DeterministicReplacementCandidate,
  EquivalenceEvidenceSuite,
} from "../../../../src/platform/competence-economics/equivalence";
import { admitDeterministicReplacement } from "../../../../src/platform/competence-economics/equivalence";
import type { SuccessfulTrajectory } from "../../../../src/platform/competence-economics/mining";
import { mineCompetenceCandidate } from "../../../../src/platform/competence-economics/mining";
import { advanceStage, decidePromotion } from "../../../../src/platform/competence-economics/promotion";
import type { CompetenceQuery } from "../../../../src/platform/competence-economics/retrieval";
import type { CompetenceRecord } from "../../../../src/platform/competence-economics/record";
import { buildCompetenceRecord } from "../../../../src/platform/competence-economics/record";
import type { TenantCacheScope } from "../../../../src/platform/context-economics/keys";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../../../src/platform/execution-ir/cost-model";
import {
  deriveExecutionIr,
  type ExecutionIr,
  type IrDigestPort,
} from "../../../../src/platform/execution-ir/ir";
import type { EnvironmentFingerprint } from "../../../../src/platform/failure-recovery/fingerprint";
import { fingerprintOf } from "../../../../src/platform/failure-recovery/fingerprint";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
export const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
export const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000dd";
export const RECORDED_AT = "2026-09-23T09:00:00.000Z";
export const OBSERVED_AT = "2026-09-23T08:59:00.000Z";

/** The shared digest port (injected, never ambient). */
export const digest: IrDigestPort = nodeDigest;

/** The tenant scope (the context-economics plane's own shape). */
export const scope: TenantCacheScope = {
  tenantId: TENANT_ID,
  applicationId: APPLICATION_ID,
};

/** A governed IR with a generative step carrying an incumbent route. */
export function governedIr(): ExecutionIr {
  const plan = buildPlan(
    {
      revision: 7,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "generate",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: [
        { from: "fetch", to: "generate" },
        { from: "generate", to: "verify" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

/** The governing constraint set (hard quality floor + budget ceiling). */
export function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "planning" },
      payload: { minQuality: 0.8 },
    },
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
    },
    {
      constraintId: "budget-ceiling",
      kind: "budget",
      enforcement: "hard",
      source: { authority: "budget", budgetId: "budget-1", scopeKind: "per-execution" },
      payload: { maxCostMicroUsd: "1000000" },
    },
  ];
}

// ---------------------------------------------------------------------------
// The environment-fingerprint fixtures (the failure-recovery plane's own)
// ---------------------------------------------------------------------------

/** The representative execution environment (the observed corpus's). */
export function environment(): EnvironmentFingerprint {
  return fingerprintOf(
    [
      { kind: "model-route", provider: "rail-a", model: "model-x" },
      { kind: "substrate", substrateId: "mid-container", version: "1.4.0" },
      {
        kind: "configuration",
        name: "schema-strict",
        digest: digestValue({ cfg: "schema-strict" }),
      },
    ],
    digest,
  );
}

/** A DRIFTED environment (out of the record's applicability bounds). */
export function driftedEnvironment(): EnvironmentFingerprint {
  return fingerprintOf(
    [
      { kind: "model-route", provider: "rail-b", model: "model-y" },
      { kind: "substrate", substrateId: "mid-container", version: "1.4.0" },
      {
        kind: "configuration",
        name: "schema-strict",
        digest: digestValue({ cfg: "schema-strict" }),
      },
    ],
    digest,
  );
}

// ---------------------------------------------------------------------------
// The successful-trajectory corpus (what the existing seams report)
// ---------------------------------------------------------------------------

/** One representative successful trajectory observation. */
export function trajectory(executionNumber: number, quality: number): SuccessfulTrajectory {
  const raw = `trajectory:${executionNumber}:success`;
  const form = {
    executionId: `00000000-0000-7000-8000-00000000${String(executionNumber).padStart(4, "0")}`,
    decisionRecordId: digestValue({ decision: executionNumber, kind: "governed-selection" }),
    outcome: "success",
    observedQuality: quality,
    verificationId: `verif-${executionNumber}`,
    verificationStrategy: "schema-check",
    observedCostMicroUsd: "400",
    observedLatencyMs: 2000,
    executorIdentity: "agent-worker-01",
    environment: environment(),
    observedAt: OBSERVED_AT,
    trajectoryDigest: digest.sha256Hex(raw),
  };
  return { trajectoryId: digestValue(form), ...form };
}

/** A successful trajectory executed by a SECOND executor identity. */
export function secondExecutorTrajectory(executionNumber: number): SuccessfulTrajectory {
  const base = trajectory(executionNumber, 0.92);
  const { trajectoryId: _stale, ...form } = base;
  const mutated = { ...form, executorIdentity: "agent-worker-02" };
  return { ...mutated, trajectoryId: digestValue(mutated) };
}

/**
 * A VALID successful trajectory observed in the DRIFTED environment
 * (identity coherent — used to prove the corpus-level environment
 * coherence guard, distinct from trajectory-shape failures).
 */
export function driftedTrajectory(executionNumber: number): SuccessfulTrajectory {
  const raw = `trajectory:${executionNumber}:drifted-env`;
  const form = {
    executionId: `00000000-0000-7000-8000-00000000${String(executionNumber).padStart(4, "0")}`,
    decisionRecordId: digestValue({ decision: executionNumber, kind: "governed-selection" }),
    outcome: "success",
    observedQuality: 0.9,
    verificationId: `verif-${executionNumber}`,
    verificationStrategy: "schema-check",
    observedCostMicroUsd: "400",
    observedLatencyMs: 2000,
    executorIdentity: "agent-worker-01",
    environment: driftedEnvironment(),
    observedAt: OBSERVED_AT,
    trajectoryDigest: digest.sha256Hex(raw),
  };
  return { trajectoryId: digestValue(form), ...form };
}

/** The representative mining corpus (the repetition evidence). */
export function miningCorpus() {
  return {
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    trajectories: [trajectory(1, 0.92), trajectory(2, 0.94)],
    totalExecutions: 4,
    miningAuthority: "mining-job-07",
    basis: "decision-record-store+execution-ledger",
  };
}

/** A mined candidate competence record (through the plane's own mining). */
export function minedRecord(): CompetenceRecord {
  return mineCompetenceCandidate(miningCorpus(), digest);
}

// ---------------------------------------------------------------------------
// The deterministic-replacement fixtures (the full evidence suite)
// ---------------------------------------------------------------------------

/** The explicit-basis claim builder. */
export function claim(
  expectedCostMicroUsd: string,
  expectedLatencyMs: number,
  expectedQuality: number,
  expectedReliability: number,
  source: string,
): CostClaim {
  return {
    expectedCostMicroUsd,
    expectedLatencyMs,
    expectedQuality,
    expectedReliability,
    basis: { basis: "estimated", source },
  };
}

/** The representative full equivalence-evidence suite (passing). */
export function fullSuite(): EquivalenceEvidenceSuite {
  return {
    differential: {
      kind: "differential",
      casesCount: 1000,
      matchedCount: 1000,
      requiredMatchRate: 1,
      boundsDigest: digestValue({ inputSpace: "classify+structured-output", version: 1 }),
      basis: "differential-harness:sampled-1000",
    },
    property: {
      kind: "property",
      propertiesCount: 12,
      checksCount: 5000,
      failuresCount: 0,
      boundsDigest: digestValue({ properties: "shape+idempotence+ordering", version: 1 }),
      basis: "property-harness:12-properties-5000-checks",
    },
    replay: {
      kind: "replay",
      trajectoriesReplayed: 2,
      deviationsCount: 0,
      boundsDigest: digestValue({ trajectories: [1, 2], version: 1 }),
      basis: "replay-harness:mined-corpus-replayed",
    },
  };
}

/** The representative deterministic replacement candidate (admitted). */
export function replacementCandidate(): DeterministicReplacementCandidate {
  return admitDeterministicReplacement({
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    incumbent: {
      representationClass: "sufficient-model",
      claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
    },
    binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
    claim: claim("40", 300, 0.93, 0.99, "equivalence-suite:measured-deterministic-path"),
    suite: fullSuite(),
    digest,
  });
}

// ---------------------------------------------------------------------------
// The promotion-gate fixtures (the gated path; AC 5)
// ---------------------------------------------------------------------------

/** The independent promotion-executing authority (never an executor/miner). */
export const PROMOTER_AUTHORITY = "promotion-authority-01";
/** The independent rollback-executing authority (never an executor/miner). */
export const ROLLBACK_AUTHORITY = "rollback-authority-01";

/** The governing quality facts (the assurance floor — inviolable input). */
export function qualityFacts(): { requiredQuality: number } {
  return { requiredQuality: 0.85 };
}

/** The bounded promotion configuration (explicit policy inputs). */
export function promotionConfiguration() {
  return {
    shadowObservationBound: 100,
    canaryExposureBound: 50,
    canaryRequiredSuccessRate: 0.98,
    equivalence: { minimumMatchRate: 0.99 },
  };
}

/** The completed SHADOW evidence (observation bound met, zero deviations). */
export function shadowEvidence(observationsCount = 100, deviationCount = 0) {
  return {
    observationsCount,
    deviationCount,
    basis: "shadow-harness:evaluation-alongside-probabilistic-path",
  };
}

/** The completed CANARY evidence (bounded exposure, required success rate). */
export function canaryEvidence(exposureCount = 50, successCount = 50, deviationCount = 0) {
  return {
    exposureCount,
    successCount,
    deviationCount,
    basis: "canary-harness:bounded-exposure-under-policy-budget",
  };
}

/** A record advanced to the requested stage (one gate at a time, honestly). */
export function atStage(stage: "shadow" | "canary" | "deterministic"): CompetenceRecord {
  let record = minedRecord();
  const ladder = ["shadow", "canary", "deterministic"] as const;
  for (const step of ladder.slice(0, ladder.indexOf(stage) + 1)) {
    record = advanceStage(record, step, digest);
  }
  return record;
}

/** A record variant (ranking/bounds fixtures with the same environment). */
export function recordVariant(options: {
  quality?: number;
  reliability?: number;
  cost?: string;
  latency?: number;
  observations?: number;
  environment?: EnvironmentFingerprint;
  capabilityId?: string;
  tags?: readonly string[];
  tenantId?: string;
  trajectoryDigest?: string;
}): CompetenceRecord {
  const quality = options.quality ?? 0.92;
  const reliability = options.reliability ?? 0.5;
  return buildCompetenceRecord({
    scope:
      options.tenantId === undefined
        ? scope
        : { tenantId: options.tenantId, applicationId: scope.applicationId },
    capabilityId: options.capabilityId ?? "text-generation",
    tags: options.tags ?? ["classify", "structured-output"],
    environment: options.environment ?? environment(),
    trajectoryDigest:
      options.trajectoryDigest ?? digest.sha256Hex(`trajectory-evidence:${JSON.stringify(options)}`),
    trajectoryExecutors: ["agent-worker-01", "agent-worker-02"],
    minedBy: "mining-job-07",
    expectedOutcome: {
      observationCount: options.observations ?? 2,
      expectedQuality: quality,
      expectedReliability: reliability,
      verificationBinding: { strategy: "schema-check", verificationId: "verif-1" },
      basis: "decision-record-store+execution-ledger",
    },
    claim: claim(
      options.cost ?? "400",
      options.latency ?? 2000,
      quality,
      reliability,
      "competence-economics:mining",
    ),
    stage: "candidate",
    digest,
  });
}

/** The representative competence query (the work being planned). */
export function query(): CompetenceQuery {
  return {
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    environment: environment(),
  };
}

/** The bounded retrieval configuration. */
export function retrievalConfiguration() {
  return { maxResults: 16, qualityFloor: 0.85 };
}

/** The promoted-verdict-bearing replacement claim BELOW the hard floor. */
export function belowFloorReplacement(): DeterministicReplacementCandidate {
  return admitDeterministicReplacement({
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    incumbent: {
      representationClass: "sufficient-model",
      claim: claim("400", 2000, 0.92, 0.95, "model-economics:incumbent-route"),
    },
    binding: { toolRepresentation: "competence", ref: "competence-binding-classify-01" },
    // Quality 0.75 < the hard quality floor 0.8: the shared economics
    // machinery must reject the promotion (the typed reason code).
    claim: claim("40", 300, 0.75, 0.99, "equivalence-suite:measured-deterministic-path"),
    suite: fullSuite(),
    digest,
  });
}

/** A suite admissible at its OWN declared rate but below the policy floor. */
export function weakSuite(): EquivalenceEvidenceSuite {
  return {
    differential: {
      kind: "differential",
      casesCount: 1000,
      matchedCount: 960,
      requiredMatchRate: 0.95,
      boundsDigest: digestValue({ inputSpace: "classify+structured-output", version: 1 }),
      basis: "differential-harness:sampled-1000",
    },
    property: {
      kind: "property",
      propertiesCount: 12,
      checksCount: 5000,
      failuresCount: 0,
      boundsDigest: digestValue({ properties: "shape+idempotence+ordering", version: 1 }),
      basis: "property-harness:12-properties-5000-checks",
    },
    replay: {
      kind: "replay",
      trajectoriesReplayed: 2,
      deviationsCount: 0,
      boundsDigest: digestValue({ trajectories: [1, 2], version: 1 }),
      basis: "replay-harness:mined-corpus-replayed",
    },
  };
}

/** The promotion-decision input at a given stage with given gate evidence. */
export function promotionInput(
  record: CompetenceRecord,
  gateEvidence: {
    shadow: ReturnType<typeof shadowEvidence> | null;
    canary: ReturnType<typeof canaryEvidence> | null;
  },
  requestedBy: string = PROMOTER_AUTHORITY,
  replacement: DeterministicReplacementCandidate = replacementCandidate(),
  configuration = promotionConfiguration(),
) {
  return {
    record,
    replacement,
    gateEvidence,
    requestedBy,
    qualityFacts: qualityFacts(),
    constraints: constraints(),
    configuration,
    digest,
  };
}

// ---------------------------------------------------------------------------
// The rollback fixtures (bounded typed rollback; AC 7)
// ---------------------------------------------------------------------------

/** The representative degradation evidence (equivalence-degraded). */
export function equivalenceDegradation() {
  return [
    {
      kind: "equivalence" as const,
      component: "differential" as const,
      detail: "new differential sampling observed mismatches within the declared bounds",
    },
  ];
}

/** The bounded rollback input over the shadow-stage record. */
export function rollbackInput(
  promotedRecord: CompetenceRecord = atStage("shadow"),
  reason: "equivalence-degraded" | "quality-degraded" | "economics-degraded" | "policy-revoked" = "equivalence-degraded",
  degradedEvidence = equivalenceDegradation(),
  requestedBy: string = ROLLBACK_AUTHORITY,
) {
  return {
    promotedRecord,
    reason,
    degradedEvidence,
    requestedBy,
    recordedAt: RECORDED_AT,
    digest,
  };
}

// ---------------------------------------------------------------------------
// The decision-record fixtures (the WORK-049 ride; AC 5/6)
// ---------------------------------------------------------------------------

/** The decision-record scope (explicit recorded-at, never ambient). */
export function decisionScope() {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    recordedAt: RECORDED_AT,
  };
}

/** The completed promotion input that yields a `promoted` verdict. */
export function promotingInput(): ReturnType<typeof promotionInput> {
  return promotionInput(minedRecord(), { shadow: null, canary: null });
}

/** A `promoted` verdict (candidate → shadow), honestly derived. */
export function promotedVerdict() {
  return decidePromotion(promotingInput());
}
