/**
 * The deterministicization lifecycle service (learning module
 * application; WORK-021 / DTR-001..004; ADR-0008,
 * `spec/deterministicization-contract.md`).
 *
 * THE LIFECYCLE SERVICE:
 *
 * ```text
 *   discoverCandidates:
 *     store.listTelemetry — the immutable population (scope-bound)
 *       → discoverDeterminizationCandidates (pure DTR-001 mining)
 *     advisory discovery output (nothing durable)
 *
 *   proposeCandidate (DTR-002 "synthesize/propose"):
 *     validated proposal (explicit contract + program + incumbent
 *       binding + MANDATORY provenance) — fail closed on missing
 *       provenance
 *       → content-derived candidateId → durable operation
 *         "candidate-registration" → store.insertCandidate (converges)
 *     immutable candidate row (status 'proposed')
 *
 *   recordStageEvidence (offline replay / differential evaluation /
 *   property+metamorphic tests / mutation evidence):
 *     caller-supplied RUN OBSERVATIONS (real sandbox-executor results,
 *       supplied by the composition — learning never dispatches)
 *       → stage-aware honest status + metrics (DTR-002)
 *       → durable operation "stage-evidence" → store.insertStageEvidence
 *         (write-once per stage; converges)
 *     candidate proposed → validating (→ validated when all four
 *       stages settled passing)
 *
 *   beginShadowRollout / concludeShadowRollout / beginCanaryPhase /
 *   concludeCanaryPhase (DTR-003):
 *     the progressive rollout phases with MEASURABLE deltas; canary
 *       admission requires a CONCLUDED shadow phase with an adequate
 *       population (fail closed)
 *
 *   applyPromotion (DTR-002/DTR-003):
 *     THE GATE: evaluatePromotionGate over ALL recorded evidence
 *       against the CONFIGURABLE thresholds — unknown or insufficient
 *       evidence FAILS CLOSED (never promotes)
 *       → durable operation "promotion" → decision record 'promoted'
 *         (rationale recorded, DTR-004)
 *
 *   rejectCandidate / deferCandidate / rollbackCandidate:
 *     decisions WITH rationale (DTR-004); rollback appends the
 *       incumbent restoration (the prior implementation description —
 *       execution identity is never touched)
 *
 *   consultDeterministicizationSignals:
 *     the READ seam planning consumes (advisory evidence, never
 *       authority — the frozen §10 invariant)
 * ```
 *
 * LEARNING-NONAUTHORITY (preserved): deps are store + digest + id
 * generator + clock ONLY — the non-authoritative quartet. There is no
 * policy seam, no capability seam, no budget seam, no sandbox seam, no
 * execution seam and no dispatch surface here or anywhere in this
 * module. The replacement program's EXECUTION happens through the
 * tools module's sandbox-executor seam at the composition root; this
 * service records, evaluates and journals — it never runs anything.
 *
 * CRASH SAFETY (the WORK-024 discipline, the architect's review bar):
 * every governed lifecycle operation owns ONE durable operation row
 * with a STABLE content-derived key and the PENDING → COMPLETED|FAILED
 * machine. A crash between claim and completion leaves the row
 * PENDING; a retry re-begins the SAME key (attempts bumped), re-does
 * the idempotent durable work (content-derived row identities
 * converge) and completes the row — exactly-once durable side effects
 * per stable key. A COMPLETED row replays its recorded outcome with no
 * new side effect; a FAILED row replays its typed failure.
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type {
  CandidateProvenance,
  CandidateRecurrence,
  CandidateSubgraphAnchor,
  DeterministicizationCandidate,
  DeterministicizationCandidateClass,
  DeterministicizationCandidateStatus,
  DifferentialPair,
  IncumbentBinding,
  PromotionDecisionRecord,
  ReplacementContract,
  ReplacementProgram,
  RolloutRecord,
  StageEvidenceRecord,
  StageEvidenceStatus,
  ValidationRunObservation,
} from "../domain/deterministicization";
import {
  candidateIdentityBasis,
  DETERMINISTICIZATION_SCHEMA_VERSION,
  stageEvidenceIdentityBasis,
  validateDeterministicizationCandidate,
  validatePromotionDecisionRecord,
  validateRolloutRecord,
  validateStageEvidenceRecord,
  VALIDATION_STAGE_KINDS,
} from "../domain/deterministicization";
import type { DiscoveredSubgraph } from "../domain/deterministicization-discovery";
import { discoverDeterminizationCandidates } from "../domain/deterministicization-discovery";
import type { PromotionGateConfig } from "../domain/deterministicization-gate";
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  evaluatePromotionGate,
  promotionGateConfigBasis,
  validatePromotionGateConfig,
} from "../domain/deterministicization-gate";
import type { DigestPort } from "../ports/digest";
import type {
  DeterministicizationOperationKind,
  DeterministicizationOperationRecord,
  DeterministicizationStore,
} from "../ports/deterministicization-store";
import { deterministicizationOperationKey } from "../ports/deterministicization-store";

export interface DeterministicizationServiceDeps {
  readonly store: DeterministicizationStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface DiscoverCandidatesRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict discovery to one task class (optional). */
  readonly taskClass?: string;
  /** Override the recurrence floor (optional). */
  readonly minimumRecurrence?: number;
}

export interface ProposeCandidateRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateClass: DeterministicizationCandidateClass;
  readonly subgraph: CandidateSubgraphAnchor;
  /** MANDATORY provenance to source executions + evaluation corpus. */
  readonly provenance: CandidateProvenance;
  readonly recurrence: CandidateRecurrence;
  /** The incumbent AI implementation being replaced (differential baseline). */
  readonly incumbent: IncumbentBinding;
  readonly contract: ReplacementContract;
  readonly program: ReplacementProgram | null;
  readonly proposedBy: string;
}

export interface RecordStageEvidenceRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly stageKind: (typeof VALIDATION_STAGE_KINDS)[number];
  /**
   * The observed runs — REAL sandbox-executor observations supplied by
   * the composition. For the mutation stage each run IS the execution
   * of one mutated replacement: outcome 'failure' = the mutant was
   * REJECTED by the checks (caught); outcome 'success' = the mutated
   * output was accepted (mutant MISSED — the checks failed to
   * discriminate).
   */
  readonly runs: readonly ValidationRunObservation[];
  /** Differential pairs (required for the differential stage). */
  readonly pairs?: readonly DifferentialPair[];
  /** Incumbent-side aggregate cost (differential stage, optional). */
  readonly incumbentCostMicroUsd?: string | null;
  readonly recordedBy: string;
}

export interface BeginRolloutRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly requestedBy: string;
  /** Override the canary-admission thresholds (optional). */
  readonly gateConfig?: PromotionGateConfig;
}

export interface ConcludeRolloutRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly mode: "shadow" | "canary";
  /** The observed population of the phase (≥ 1). */
  readonly population: number;
  readonly matchedCount: number;
  readonly costDeltaMicroUsd: string;
  readonly qualityDelta: number;
  readonly latencyDeltaMs: number;
  readonly evidenceRefs: readonly string[];
  readonly requestedBy: string;
}

export interface ApplyPromotionRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly decidedBy: string;
  /** Override the promotion thresholds (optional; defaults are conservative). */
  readonly gateConfig?: PromotionGateConfig;
  /** Extra rationale recorded with the decision (optional). */
  readonly note?: string;
}

export interface DecisionRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  /** MANDATORY rationale (DTR-004: every decision records why). */
  readonly rationale: string;
  readonly decidedBy: string;
  readonly gateConfig?: PromotionGateConfig;
}

export interface ConsultDeterministicizationRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly taskClass?: string;
}

/** The rollout-phase delta projection carried on a signal. */
export interface RolloutDeltaProjection {
  readonly population: number;
  readonly matchedCount: number;
  readonly costDeltaMicroUsd: string;
  readonly qualityDelta: number;
  readonly latencyDeltaMs: number;
}

/**
 * The READ-seam projection: a candidate as a validated non-authoritative
 * signal carrying its full provenance/contract/decision anchors (the
 * consumer-side boundary twin is planning's
 * `ConsultedDeterministicizationSignal`).
 */
export interface DeterministicizationSignal {
  readonly signalClass: "non-authoritative-deterministicization-candidate";
  readonly candidateId: string;
  readonly candidateClass: DeterministicizationCandidateClass;
  readonly status: DeterministicizationCandidateStatus;
  readonly taskClass: string;
  readonly subgraphId: string;
  readonly stepPath: readonly string[];
  readonly computationType: string;
  readonly population: number;
  readonly corpusDigest: string;
  readonly sourceExecutionIds: readonly string[];
  readonly contractDigest: string;
  readonly incumbentStrategyClass: string;
  readonly incumbentDescriptionDigest: string;
  readonly rollbackTarget: string;
  readonly shadow: RolloutDeltaProjection | null;
  readonly canary: RolloutDeltaProjection | null;
  readonly promotionDecisionId: string | null;
  readonly promotedBy: string | null;
  readonly promotedAt: string | null;
  readonly rollbackDecisionId: string | null;
  readonly restoredIncumbent: string | null;
}

export interface DeterministicizationService {
  discoverCandidates(
    request: DiscoverCandidatesRequest,
  ): Promise<{ readonly discovered: readonly DiscoveredSubgraph[]; readonly population: number }>;
  proposeCandidate(request: ProposeCandidateRequest): Promise<{
    readonly candidate: DeterministicizationCandidate;
    readonly replayed: boolean;
  }>;
  getCandidate(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly candidateId: string;
  }): Promise<{
    readonly candidate: DeterministicizationCandidate;
    readonly evidence: readonly StageEvidenceRecord[];
    readonly rollouts: readonly RolloutRecord[];
    readonly decisions: readonly PromotionDecisionRecord[];
  }>;
  recordStageEvidence(request: RecordStageEvidenceRequest): Promise<{
    readonly evidence: StageEvidenceRecord;
    readonly replayed: boolean;
  }>;
  beginShadowRollout(request: BeginRolloutRequest): Promise<{
    readonly rollout: RolloutRecord;
    readonly replayed: boolean;
  }>;
  concludeShadowRollout(
    request: ConcludeRolloutRequest,
  ): Promise<{ readonly rollout: RolloutRecord }>;
  beginCanaryPhase(request: BeginRolloutRequest): Promise<{
    readonly rollout: RolloutRecord;
    readonly replayed: boolean;
  }>;
  concludeCanaryPhase(
    request: ConcludeRolloutRequest,
  ): Promise<{ readonly rollout: RolloutRecord }>;
  applyPromotion(request: ApplyPromotionRequest): Promise<{
    readonly decision: PromotionDecisionRecord;
    readonly replayed: boolean;
  }>;
  rejectCandidate(request: DecisionRequest): Promise<{
    readonly decision: PromotionDecisionRecord;
    readonly replayed: boolean;
  }>;
  deferCandidate(request: DecisionRequest): Promise<{
    readonly decision: PromotionDecisionRecord;
    readonly replayed: boolean;
  }>;
  rollbackCandidate(request: DecisionRequest): Promise<{
    readonly decision: PromotionDecisionRecord;
    readonly replayed: boolean;
  }>;
  consultDeterministicizationSignals(
    request: ConsultDeterministicizationRequest,
  ): Promise<readonly DeterministicizationSignal[]>;
}

export function createDeterministicizationService(
  deps: DeterministicizationServiceDeps,
): DeterministicizationService {
  const digestOf = (value: unknown): string => deps.digest.sha256Hex(canonicalJson(value));
  const iso = (): string => deps.now().toISOString();

  const requireScope = (request: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): void => {
    if (
      typeof request.applicationId !== "string" ||
      request.applicationId.length === 0 ||
      typeof request.tenantId !== "string" ||
      request.tenantId.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "applicationId and tenantId are required (tenant scope is never dropped)",
      });
    }
  };

  const resolveGateConfig = (config?: PromotionGateConfig): PromotionGateConfig => {
    const resolved = config ?? DEFAULT_PROMOTION_GATE_CONFIG;
    validatePromotionGateConfig(resolved);
    return resolved;
  };

  const loadCandidate = async (
    scope: { readonly applicationId: string; readonly tenantId: string },
    candidateId: string,
  ): Promise<DeterministicizationCandidate> => {
    const candidate = await deps.store.getCandidate(scope, candidateId);
    if (candidate === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization candidate not found within the application scope",
        details: { candidateId },
      });
    }
    return candidate;
  };

  /**
   * The durable-operation wrapper (the crash-safety discipline): claim
   * the stable key, honor a COMPLETED row by replaying `replay()`,
   * honor a FAILED row by failing closed, otherwise run the work
   * (idempotent by content identity) and complete the row.
   */
  const runOperation = async <T>(input: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly candidateId: string | null;
    readonly kind: DeterministicizationOperationKind;
    readonly keyDiscriminator: string;
    readonly work: (record: DeterministicizationOperationRecord) => Promise<T>;
    readonly replay: (record: DeterministicizationOperationRecord) => Promise<T>;
  }): Promise<T> => {
    const operationKey = deterministicizationOperationKey(input.kind, input.keyDiscriminator);
    const begin = await deps.store.beginOperation({
      operationId: deps.generateId(),
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      candidateId: input.candidateId,
      operationKind: input.kind,
      operationKey,
      createdAt: iso(),
    });
    const record = begin.record;
    if (record.status === "completed") {
      return input.replay(record);
    }
    if (record.status === "failed") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `the ${input.kind} operation previously failed durably: ${record.failureReason ?? "no reason recorded"}`,
        details: { operationKey },
      });
    }
    const result = await input.work(record);
    await deps.store.completeOperation(input.applicationId, operationKey, iso());
    return result;
  };

  /** The honest stage-aware status + metrics of recorded runs/pairs. */
  const computeStageOutcome = (
    stageKind: RecordStageEvidenceRequest["stageKind"],
    runs: readonly ValidationRunObservation[],
    pairs: readonly DifferentialPair[],
    incumbentCostMicroUsd: string | null,
  ): { status: StageEvidenceStatus; metrics: StageEvidenceRecord["metrics"] } => {
    if (runs.length === 0) {
      return {
        status: "insufficient",
        metrics: {
          population: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          acceptanceRate: 0,
          incumbentCostMicroUsd: null,
          replacementCostMicroUsd: null,
          costDeltaMicroUsd: null,
          replacementLatencyMeanMs: null,
          propertyPassCount: stageKind === "property-tests" ? 0 : null,
          propertyFailCount: stageKind === "property-tests" ? 0 : null,
          mutationCaughtCount: stageKind === "mutation-tests" ? 0 : null,
          mutationMissedCount: stageKind === "mutation-tests" ? 0 : null,
        },
      };
    }
    const population = stageKind === "differential-evaluation" ? pairs.length : runs.length;
    const acceptedCount =
      stageKind === "differential-evaluation"
        ? pairs.filter((pair) => pair.accepted).length
        : stageKind === "mutation-tests"
          ? runs.filter((run) => run.outcome === "failure").length
          : runs.filter((run) => run.outcome === "success").length;
    const rejectedCount = population - acceptedCount;
    const acceptanceRate = population === 0 ? 0 : acceptedCount / population;
    let replacementCost = 0n;
    let observedCostCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const run of runs) {
      if (run.costMicroUsd !== null && run.costMicroUsd !== undefined) {
        replacementCost += BigInt(run.costMicroUsd);
        observedCostCount += 1;
      }
      if (run.latencyMs !== null && run.latencyMs !== undefined) {
        latencySum += run.latencyMs;
        latencyCount += 1;
      }
    }
    // Stage-aware honest status: every accepted ⇒ passed; any rejected
    // ⇒ failed. For the mutation stage "accepted" means every mutant
    // was CAUGHT (a surviving mutant fails the stage).
    const status: StageEvidenceStatus = rejectedCount === 0 ? "passed" : "failed";
    const incumbentCost =
      stageKind === "differential-evaluation" && incumbentCostMicroUsd !== undefined
        ? (incumbentCostMicroUsd ?? null)
        : null;
    const replacementCostOut = observedCostCount > 0 ? replacementCost.toString() : null;
    const metrics: StageEvidenceRecord["metrics"] = {
      population,
      acceptedCount,
      rejectedCount,
      acceptanceRate,
      incumbentCostMicroUsd: incumbentCost,
      replacementCostMicroUsd: replacementCostOut,
      costDeltaMicroUsd:
        incumbentCost !== null && replacementCostOut !== null
          ? (BigInt(incumbentCost) - replacementCost).toString()
          : null,
      replacementLatencyMeanMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
      propertyPassCount:
        stageKind === "property-tests"
          ? runs.filter((run) => run.outcome === "success").length
          : null,
      propertyFailCount:
        stageKind === "property-tests"
          ? runs.filter((run) => run.outcome === "failure").length
          : null,
      mutationCaughtCount:
        stageKind === "mutation-tests"
          ? runs.filter((run) => run.outcome === "failure").length
          : null,
      mutationMissedCount:
        stageKind === "mutation-tests"
          ? runs.filter((run) => run.outcome === "success").length
          : null,
    };
    return { status, metrics };
  };

  /** Record a decision into the journal (content-idempotent). */
  const appendDecision = async (
    decision: PromotionDecisionRecord,
  ): Promise<{ readonly decision: PromotionDecisionRecord; readonly replayed: boolean }> => {
    validatePromotionDecisionRecord(decision);
    const outcome = await deps.store.appendDecision(decision);
    return { decision, replayed: outcome.replayed };
  };

  /** Build the gate-evaluation capture for a decision record. */
  const evaluateGateFor = async (
    scope: { readonly applicationId: string; readonly tenantId: string },
    candidate: DeterministicizationCandidate,
    config: PromotionGateConfig,
  ) => {
    const [evidence, rollouts] = await Promise.all([
      deps.store.listStageEvidence(scope, candidate.candidateId),
      deps.store.listRollouts(scope, candidate.candidateId),
    ]);
    const evaluation = evaluatePromotionGate({
      candidate,
      stageEvidence: evidence,
      rollouts,
      config,
    });
    return {
      evaluation,
      gate: {
        gateConfigDigest: digestOf(promotionGateConfigBasis(config)),
        verdict: evaluation.verdict,
        reasons: [...evaluation.reasons],
        stageEvidenceIds: [...evaluation.stageEvidenceIds],
        rolloutIds: [...evaluation.rolloutIds],
        evaluatedAt: iso(),
      },
    };
  };

  /** Build a decision record from a DecisionRequest (shared shape). */
  const buildDecision = (
    candidate: DeterministicizationCandidate,
    request: DecisionRequest,
    kind: PromotionDecisionRecord["kind"],
    decisionId: string,
    gate: PromotionDecisionRecord["gate"],
    incumbentRestoredTo: string | null,
  ): PromotionDecisionRecord => {
    if (request.rationale.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "a deterministicization decision requires a non-empty rationale (DTR-004: record why)",
      });
    }
    if (request.decidedBy.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "a deterministicization decision requires a non-empty decidedBy actor",
      });
    }
    const decision: PromotionDecisionRecord = {
      decisionId,
      candidateId: candidate.candidateId,
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      kind,
      rationale: request.rationale,
      gate,
      incumbentRestoredTo,
      decidedBy: request.decidedBy,
      decidedAt: iso(),
      schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
    };
    validatePromotionDecisionRecord(decision);
    return decision;
  };

  /** The shared rollout-conclusion flow (shadow + canary phases). */
  const concludeRolloutPhase = async (
    request: ConcludeRolloutRequest,
    mode: "shadow" | "canary",
  ): Promise<{ readonly rollout: RolloutRecord }> => {
    if (request.mode !== mode) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `the ${mode} conclusion request carries mode '${request.mode}'`,
      });
    }
    const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
    const candidate = await loadCandidate(scope, request.candidateId);
    const rollouts = await deps.store.listRollouts(scope, request.candidateId);
    const rollout = rollouts.find((record) => record.mode === mode);
    if (rollout === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `no ${mode} rollout exists for this candidate`,
        details: { candidateId: request.candidateId },
      });
    }
    if (request.requestedBy.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "a rollout conclusion requires a non-empty requestedBy actor",
      });
    }
    return runOperation({
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      candidateId: candidate.candidateId,
      kind: mode === "shadow" ? "shadow-rollout" : "canary-rollout",
      keyDiscriminator: `${rollout.rolloutId}:conclude`,
      work: async () => {
        const concluded = await deps.store.concludeRollout({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          rolloutId: rollout.rolloutId,
          population: request.population,
          matchedCount: request.matchedCount,
          costDeltaMicroUsd: request.costDeltaMicroUsd,
          qualityDelta: request.qualityDelta,
          latencyDeltaMs: request.latencyDeltaMs,
          evidenceRefs: [...request.evidenceRefs],
          concludedAt: iso(),
        });
        validateRolloutRecord(concluded);
        return { rollout: concluded };
      },
      replay: async () => {
        const existing = await deps.store.getRollout(scope, rollout.rolloutId);
        if (existing === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "rollout conclusion replay could not re-read the durable record",
            details: { rolloutId: rollout.rolloutId },
          });
        }
        return { rollout: existing };
      },
    });
  };

  return {
    async discoverCandidates(request) {
      requireScope(request);
      const population = await deps.store.listTelemetry({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        recordedFrom: null,
        recordedTo: iso(),
      });
      const discovered = discoverDeterminizationCandidates(population, {
        minimumRecurrence: request.minimumRecurrence ?? 5,
        ...(request.taskClass === undefined ? {} : { taskClass: request.taskClass }),
      });
      return { discovered, population: population.length };
    },

    async proposeCandidate(request) {
      requireScope(request);
      if (request.proposedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "candidate proposal requires a non-empty proposedBy actor",
        });
      }
      // The content-derived candidate identity: the FULL basis (anchor
      // + provenance + class + contract + program + incumbent).
      const candidateId = digestOf(
        candidateIdentityBasis({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          candidateClass: request.candidateClass,
          subgraph: request.subgraph,
          provenance: request.provenance,
          recurrence: request.recurrence,
          incumbent: request.incumbent,
          contract: request.contract,
          program: request.program,
        }),
      );
      const candidate: DeterministicizationCandidate = {
        candidateId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateClass: request.candidateClass,
        status: "proposed",
        subgraph: { ...request.subgraph, stepPath: [...request.subgraph.stepPath] },
        provenance: {
          ...request.provenance,
          sourceExecutionIds: [...request.provenance.sourceExecutionIds],
          evidenceRefs: [...request.provenance.evidenceRefs],
        },
        recurrence: { ...request.recurrence },
        incumbent: {
          ...request.incumbent,
          routes: request.incumbent.routes.map((route) => ({ ...route })),
        },
        contract: request.contract,
        program:
          request.program === null
            ? null
            : {
                language: request.program.language,
                source: request.program.source,
                sourceDigest: request.program.sourceDigest,
              },
        proposedBy: request.proposedBy,
        proposedAt: iso(),
        schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
      };
      // Fail-closed validation BEFORE anything durable: provenance is
      // identity (a provenance-less candidate is unrepresentable).
      validateDeterministicizationCandidate(candidate);

      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId,
        kind: "candidate-registration",
        keyDiscriminator: candidateId,
        work: async () => {
          const outcome = await deps.store.insertCandidate(candidate);
          return { candidate, replayed: outcome.replayed };
        },
        replay: async () => {
          const existing = await loadCandidate(
            { applicationId: request.applicationId, tenantId: request.tenantId },
            candidateId,
          );
          return { candidate: existing, replayed: true };
        },
      });
    },

    async getCandidate(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      const [evidence, rollouts, decisions] = await Promise.all([
        deps.store.listStageEvidence(scope, request.candidateId),
        deps.store.listRollouts(scope, request.candidateId),
        deps.store.listDecisions(scope, request.candidateId),
      ]);
      return { candidate, evidence, rollouts, decisions };
    },

    async recordStageEvidence(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (
        candidate.status === "rejected" ||
        candidate.status === "promoted" ||
        candidate.status === "rolled-back"
      ) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `a candidate in status '${candidate.status}' no longer accepts validation evidence`,
          details: { candidateId: candidate.candidateId },
        });
      }
      if (request.recordedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "stage evidence requires a non-empty recordedBy actor",
        });
      }
      const runs = [...request.runs];
      const pairs = request.pairs === undefined ? [] : [...request.pairs];
      const { status, metrics } = computeStageOutcome(
        request.stageKind,
        runs,
        pairs,
        request.incumbentCostMicroUsd ?? null,
      );
      const evidenceId = digestOf(
        stageEvidenceIdentityBasis({
          candidateId: candidate.candidateId,
          stageKind: request.stageKind,
          corpusDigest: candidate.provenance.corpusDigest,
          runs,
          pairs,
        }),
      );
      const evidence: StageEvidenceRecord = {
        evidenceId,
        candidateId: candidate.candidateId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        stageKind: request.stageKind,
        status,
        basis: {
          corpusDigest: candidate.provenance.corpusDigest,
          sourceExecutionIds: [...candidate.provenance.sourceExecutionIds],
          population: candidate.provenance.population,
        },
        runs: runs.map((run) => ({ ...run })),
        pairs: pairs.map((pair) => ({ ...pair })),
        metrics,
        criterionDigest: digestOf(candidate.contract.acceptanceCriterion),
        evidenceRefs: [...candidate.provenance.evidenceRefs],
        recordedAt: iso(),
        recordedBy: request.recordedBy,
        schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
      };
      validateStageEvidenceRecord(evidence);

      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId: candidate.candidateId,
        kind: "stage-evidence",
        keyDiscriminator: evidenceId,
        work: async (operation) => {
          const outcome = await deps.store.insertStageEvidence(evidence);
          if (!outcome.replayed) {
            // The candidate moves proposed/deferred → validating (the
            // first settled stage evidence); when ALL FOUR offline
            // stages are settled passing, validating → validated.
            if (candidate.status === "proposed" || candidate.status === "deferred") {
              await deps.store.transitionCandidateStatus({
                applicationId: request.applicationId,
                tenantId: request.tenantId,
                candidateId: candidate.candidateId,
                expectedStatus: candidate.status,
                toStatus: "validating",
                updatedAt: iso(),
              });
            }
            const settled = await deps.store.listStageEvidence(scope, candidate.candidateId);
            const allSettledPassing = VALIDATION_STAGE_KINDS.every((stage) =>
              settled.some((record) => record.stageKind === stage && record.status === "passed"),
            );
            if (allSettledPassing) {
              await deps.store.transitionCandidateStatus({
                applicationId: request.applicationId,
                tenantId: request.tenantId,
                candidateId: candidate.candidateId,
                expectedStatus: null,
                toStatus: "validated",
                updatedAt: iso(),
              });
            }
            await deps.store.recordOperationCheckpoint(
              request.applicationId,
              operation.operationKey,
              { stageKind: request.stageKind, evidenceId },
              iso(),
            );
          }
          return { evidence, replayed: outcome.replayed };
        },
        replay: async () => {
          const rows = await deps.store.listStageEvidence(scope, candidate.candidateId);
          const existing = rows.find((row) => row.evidenceId === evidenceId);
          if (existing === undefined) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "stage-evidence replay could not re-read the durable record",
              details: { evidenceId },
            });
          }
          return { evidence: existing, replayed: true };
        },
      });
    },

    async beginShadowRollout(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (candidate.status !== "validated" && candidate.status !== "rolled-back") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `the shadow phase requires a validated candidate (status '${candidate.status}')`,
          details: { candidateId: candidate.candidateId },
        });
      }
      if (request.requestedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "a rollout phase requires a non-empty requestedBy actor",
        });
      }
      const rolloutId = digestOf({
        rolloutSchema: 1,
        candidateId: candidate.candidateId,
        mode: "shadow",
        corpusDigest: candidate.provenance.corpusDigest,
      });
      const rollout: RolloutRecord = {
        rolloutId,
        candidateId: candidate.candidateId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        mode: "shadow",
        status: "observing",
        population: 0,
        matchedCount: 0,
        costDeltaMicroUsd: "0",
        qualityDelta: 0,
        latencyDeltaMs: 0,
        evidenceRefs: [],
        beganAt: iso(),
        concludedAt: null,
        schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
      };
      validateRolloutRecord(rollout);
      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId: candidate.candidateId,
        kind: "shadow-rollout",
        keyDiscriminator: rolloutId,
        work: async () => {
          const outcome = await deps.store.insertRollout(rollout);
          if (!outcome.replayed && candidate.status !== "shadow") {
            await deps.store.transitionCandidateStatus({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
              candidateId: candidate.candidateId,
              expectedStatus: candidate.status,
              toStatus: "shadow",
              updatedAt: iso(),
            });
          }
          return { rollout, replayed: outcome.replayed };
        },
        replay: async () => {
          const existing = await deps.store.getRollout(scope, rolloutId);
          if (existing === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "shadow-rollout replay could not re-read the durable record",
              details: { rolloutId },
            });
          }
          return { rollout: existing, replayed: true };
        },
      });
    },

    async concludeShadowRollout(request) {
      return concludeRolloutPhase(request, "shadow");
    },

    async beginCanaryPhase(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (candidate.status !== "shadow") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `the canary phase requires a candidate in the shadow phase (status '${candidate.status}')`,
          details: { candidateId: candidate.candidateId },
        });
      }
      // Canary admission: the shadow phase must be CONCLUDED with an
      // adequate population (fail closed — progressive rollout).
      const config = resolveGateConfig(request.gateConfig);
      const rollouts = await deps.store.listRollouts(scope, request.candidateId);
      const shadow = rollouts.find((rollout) => rollout.mode === "shadow");
      if (shadow === undefined || shadow.status !== "concluded") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the canary phase requires a CONCLUDED shadow rollout (shadow runs before canary — fail closed)",
          details: { candidateId: candidate.candidateId },
        });
      }
      if (shadow.population < config.minimumShadowPopulation) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `the shadow rollout population ${shadow.population} is below the configured canary-admission floor ${config.minimumShadowPopulation} (fail closed)`,
          details: { candidateId: candidate.candidateId },
        });
      }
      if (request.requestedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "a rollout phase requires a non-empty requestedBy actor",
        });
      }
      const rolloutId = digestOf({
        rolloutSchema: 1,
        candidateId: candidate.candidateId,
        mode: "canary",
        corpusDigest: candidate.provenance.corpusDigest,
      });
      const rollout: RolloutRecord = {
        rolloutId,
        candidateId: candidate.candidateId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        mode: "canary",
        status: "observing",
        population: 0,
        matchedCount: 0,
        costDeltaMicroUsd: "0",
        qualityDelta: 0,
        latencyDeltaMs: 0,
        evidenceRefs: [],
        beganAt: iso(),
        concludedAt: null,
        schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
      };
      validateRolloutRecord(rollout);
      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId: candidate.candidateId,
        kind: "canary-rollout",
        keyDiscriminator: rolloutId,
        work: async () => {
          const outcome = await deps.store.insertRollout(rollout);
          if (!outcome.replayed && candidate.status !== "canary") {
            await deps.store.transitionCandidateStatus({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
              candidateId: candidate.candidateId,
              expectedStatus: candidate.status,
              toStatus: "canary",
              updatedAt: iso(),
            });
          }
          return { rollout, replayed: outcome.replayed };
        },
        replay: async () => {
          const existing = await deps.store.getRollout(scope, rolloutId);
          if (existing === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "canary-rollout replay could not re-read the durable record",
              details: { rolloutId },
            });
          }
          return { rollout: existing, replayed: true };
        },
      });
    },

    async concludeCanaryPhase(request) {
      return concludeRolloutPhase(request, "canary");
    },

    async applyPromotion(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (request.decidedBy.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "promotion requires a non-empty decidedBy actor",
        });
      }
      const config = resolveGateConfig(request.gateConfig);
      const { evaluation, gate } = await evaluateGateFor(scope, candidate, config);
      if (evaluation.verdict !== "promote") {
        // THE FAIL-CLOSED PROMOTION GATE: unknown or insufficient
        // evidence NEVER promotes (AC6's protection — the runtime red
        // record of the discrimination suite).
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the promotion gate failed closed (unknown or insufficient evidence never promotes)",
          details: { candidateId: candidate.candidateId, reasons: [...evaluation.reasons] },
        });
      }
      const decisionId = digestOf({
        decisionSchema: 1,
        candidateId: candidate.candidateId,
        kind: "promoted",
        gateConfigDigest: gate.gateConfigDigest,
        decidedBy: request.decidedBy,
      });
      const rationale =
        request.note === undefined || request.note.length === 0
          ? `promotion gate passed: every required validation stage carries passing evidence at or above the configured thresholds and the shadow/canary phases concluded with acceptable deltas (${evaluation.stageEvidenceIds.length} stage records, ${evaluation.rolloutIds.length} rollout records consulted)`
          : `${request.note} | gate: every required validation stage carries passing evidence at or above the configured thresholds; ${evaluation.stageEvidenceIds.length} stage records and ${evaluation.rolloutIds.length} rollout records consulted`;
      const decision: PromotionDecisionRecord = {
        decisionId,
        candidateId: candidate.candidateId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        kind: "promoted",
        rationale,
        gate,
        incumbentRestoredTo: null,
        decidedBy: request.decidedBy,
        decidedAt: iso(),
        schemaVersion: DETERMINISTICIZATION_SCHEMA_VERSION,
      };
      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId: candidate.candidateId,
        kind: "promotion",
        keyDiscriminator: decisionId,
        work: async () => {
          const appended = await appendDecision(decision);
          if (!appended.replayed && candidate.status !== "promoted") {
            await deps.store.transitionCandidateStatus({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
              candidateId: candidate.candidateId,
              expectedStatus: candidate.status,
              toStatus: "promoted",
              updatedAt: decision.decidedAt,
            });
          }
          return { decision, replayed: appended.replayed };
        },
        replay: async () => {
          const rows = await deps.store.listDecisions(scope, candidate.candidateId);
          const existing = rows.find((row) => row.decisionId === decisionId);
          if (existing === undefined) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "promotion replay could not re-read the durable decision",
              details: { decisionId },
            });
          }
          return { decision: existing, replayed: true };
        },
      });
    },

    async rejectCandidate(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (candidate.status === "promoted") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: "a promoted candidate is rolled back, not rejected",
          details: { candidateId: candidate.candidateId },
        });
      }
      if (candidate.status === "rejected") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: "the candidate is already rejected (terminal)",
          details: { candidateId: candidate.candidateId },
        });
      }
      const config = resolveGateConfig(request.gateConfig);
      const { evaluation, gate } = await evaluateGateFor(scope, candidate, config);
      if (evaluation.verdict === "promote") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "a candidate whose evidence passes the promotion gate is not rejectable as 'rejected' (defer it instead — rejection records a fail-closed gate)",
          details: { candidateId: candidate.candidateId },
        });
      }
      const decisionId = digestOf({
        decisionSchema: 1,
        candidateId: candidate.candidateId,
        kind: "rejected",
        gateConfigDigest: gate.gateConfigDigest,
        decidedBy: request.decidedBy,
      });
      const decision = buildDecision(candidate, request, "rejected", decisionId, gate, null);
      const appended = await appendDecision(decision);
      if (!appended.replayed) {
        await deps.store.transitionCandidateStatus({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          candidateId: candidate.candidateId,
          expectedStatus: candidate.status,
          toStatus: "rejected",
          updatedAt: decision.decidedAt,
        });
      }
      return appended;
    },

    async deferCandidate(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (candidate.status === "promoted" || candidate.status === "rejected") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `a candidate in status '${candidate.status}' can no longer be deferred`,
          details: { candidateId: candidate.candidateId },
        });
      }
      const config = resolveGateConfig(request.gateConfig);
      const { gate } = await evaluateGateFor(scope, candidate, config);
      const decisionId = digestOf({
        decisionSchema: 1,
        candidateId: candidate.candidateId,
        kind: "deferred",
        gateConfigDigest: gate.gateConfigDigest,
        decidedBy: request.decidedBy,
      });
      const decision = buildDecision(candidate, request, "deferred", decisionId, gate, null);
      const appended = await appendDecision(decision);
      if (!appended.replayed && candidate.status !== "deferred") {
        await deps.store.transitionCandidateStatus({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          candidateId: candidate.candidateId,
          expectedStatus: candidate.status,
          toStatus: "deferred",
          updatedAt: decision.decidedAt,
        });
      }
      return appended;
    },

    async rollbackCandidate(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidate = await loadCandidate(scope, request.candidateId);
      if (candidate.status !== "promoted") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `rollback requires a promoted candidate (status '${candidate.status}')`,
          details: { candidateId: candidate.candidateId },
        });
      }
      const config = resolveGateConfig(request.gateConfig);
      const { gate } = await evaluateGateFor(scope, candidate, config);
      const decisionId = digestOf({
        decisionSchema: 1,
        candidateId: candidate.candidateId,
        kind: "rolled-back",
        gateConfigDigest: gate.gateConfigDigest,
        decidedBy: request.decidedBy,
      });
      // The incumbent restoration target (DTR-003: promotion is
      // reversible to the previous implementation — a DESCRIPTION,
      // never an execution-state write).
      const decision = buildDecision(
        candidate,
        request,
        "rolled-back",
        decisionId,
        gate,
        candidate.incumbent.rollbackTarget,
      );
      return runOperation({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        candidateId: candidate.candidateId,
        kind: "rollback",
        keyDiscriminator: decisionId,
        work: async () => {
          const appended = await appendDecision(decision);
          if (!appended.replayed && candidate.status !== "rolled-back") {
            await deps.store.transitionCandidateStatus({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
              candidateId: candidate.candidateId,
              expectedStatus: candidate.status,
              toStatus: "rolled-back",
              updatedAt: decision.decidedAt,
            });
          }
          return appended;
        },
        replay: async () => {
          const rows = await deps.store.listDecisions(scope, candidate.candidateId);
          const existing = rows.find((row) => row.decisionId === decisionId);
          if (existing === undefined) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "rollback replay could not re-read the durable decision",
              details: { decisionId },
            });
          }
          return { decision: existing, replayed: true };
        },
      });
    },

    async consultDeterministicizationSignals(request) {
      requireScope(request);
      const scope = { applicationId: request.applicationId, tenantId: request.tenantId };
      const candidates = await deps.store.listCandidates(scope);
      const signals: DeterministicizationSignal[] = [];
      for (const candidate of candidates) {
        if (request.taskClass !== undefined && candidate.subgraph.taskClass !== request.taskClass) {
          continue;
        }
        // The rollout-relevant lifecycle states only: proposed/
        // rejected candidates carry no planning-relevant rollout state.
        if (candidate.status === "proposed" || candidate.status === "rejected") {
          continue;
        }
        const [rollouts, decisions] = await Promise.all([
          deps.store.listRollouts(scope, candidate.candidateId),
          deps.store.listDecisions(scope, candidate.candidateId),
        ]);
        const shadow = rollouts.find((rollout) => rollout.mode === "shadow") ?? null;
        const canary = rollouts.find((rollout) => rollout.mode === "canary") ?? null;
        const promotion =
          [...decisions].reverse().find((decision) => decision.kind === "promoted") ?? null;
        const rollback =
          [...decisions].reverse().find((decision) => decision.kind === "rolled-back") ?? null;
        validateDeterministicizationCandidate(candidate);
        signals.push({
          signalClass: "non-authoritative-deterministicization-candidate",
          candidateId: candidate.candidateId,
          candidateClass: candidate.candidateClass,
          status: candidate.status,
          taskClass: candidate.subgraph.taskClass,
          subgraphId: candidate.subgraph.subgraphId,
          stepPath: [...candidate.subgraph.stepPath],
          computationType: candidate.subgraph.computationType,
          population: candidate.provenance.population,
          corpusDigest: candidate.provenance.corpusDigest,
          sourceExecutionIds: [...candidate.provenance.sourceExecutionIds],
          contractDigest: digestOf(candidate.contract),
          incumbentStrategyClass: candidate.incumbent.strategyClass,
          incumbentDescriptionDigest: candidate.incumbent.descriptionDigest,
          rollbackTarget: candidate.incumbent.rollbackTarget,
          shadow:
            shadow === null
              ? null
              : {
                  population: shadow.population,
                  matchedCount: shadow.matchedCount,
                  costDeltaMicroUsd: shadow.costDeltaMicroUsd,
                  qualityDelta: shadow.qualityDelta,
                  latencyDeltaMs: shadow.latencyDeltaMs,
                },
          canary:
            canary === null
              ? null
              : {
                  population: canary.population,
                  matchedCount: canary.matchedCount,
                  costDeltaMicroUsd: canary.costDeltaMicroUsd,
                  qualityDelta: canary.qualityDelta,
                  latencyDeltaMs: canary.latencyDeltaMs,
                },
          promotionDecisionId: promotion?.decisionId ?? null,
          promotedBy: promotion?.decidedBy ?? null,
          promotedAt: promotion?.decidedAt ?? null,
          rollbackDecisionId: rollback?.decisionId ?? null,
          restoredIncumbent: rollback?.incumbentRestoredTo ?? null,
        });
      }
      return signals;
    },
  };
}
